// tests/handlers/registrar-venta-pos-race.test.js
//
// Etapa 3 del plan de auditoría — gap: `registrar_venta_pos` solo estaba
// verificado bajo concurrencia por la corrida de carga real puntual de la
// Etapa 6 (scripts/load-test-etapa4.js, 2026-09-12: 10 cajas vendiendo el
// mismo producto en simultáneo, stock nunca negativo). No existía un
// `.test.js` que quedara corriendo en `npm test`/CI para este RPC —
// mismo patrón que ya existe para el caso puntual de MP
// (tests/handlers/pagos-webhook-polling-concurrencia.test.js) y para el
// caso de pedido sugerido (tests/handlers/confirmar-pedido-sugerido-race.test.js).
//
// Contrato real replicado acá (migración 618,
// fix_row_locking_limite_credito_venta_pos.sql — el SELECT de stock ya
// tenía FOR UPDATE desde antes de esa migración, que solo agregó el lock
// de `clientes` para el chequeo de límite de crédito):
//
//   SELECT cantidad FROM stock WHERE producto_id=... AND deposito_id=...
//     FOR UPDATE;
//   IF NOT FOUND OR v_disponible < v_cantidad THEN
//     RAISE EXCEPTION 'stock_insuficiente:<producto_id> disponible:<n>';
//   END IF;
//   UPDATE stock SET cantidad = cantidad - v_cantidad ...
//
// El propio RPC atrapa esa excepción y la devuelve como
// { ok:false, tipo:'stock_insuficiente', error:'stock_insuficiente:ID disponible:N' }
// — exactamente el contrato que ya parsea registrarVentaHandler
// (lib/handlers/pos.js) con una regexp para armar el mensaje al usuario.
//
// Como en los otros dos tests de carrera, no hay Postgres real acá (eso lo
// cubre scripts/test-integration.js / la corrida de carga real de la
// Etapa 6) — se mockea `registrarVentaPosRpc` con un estado de stock en
// memoria que replica el mismo contrato de FOR UPDATE (chequeo y
// descuento sin ningún `await` en el medio, la misma garantía de
// atomicidad que da el lock de Postgres), y se dispara el handler HTTP
// real (`lib/handlers/pos.js`, export default) dos veces en paralelo con
// `Promise.all` para que los `await` intercalen de verdad.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const CAJA_ID    = 'caja-1';
const TURNO_ID   = 'turno-1';
const DEPOSITO_ID = 'deposito-1';
const PRODUCTO_ID = 'producto-1';

// Estado de stock en memoria — equivalente a la fila de `stock` que el RPC
// real bloquea con FOR UPDATE.
const estado = vi.hoisted(() => ({
  stock: new Map(), // `${producto_id}:${deposito_id}` -> cantidad
  ventasCreadas: [], // ventas "insertadas" (para armar venta_id distintos)
  llamadasRpc: 0,
}));

function resetEstado(stockInicial) {
  estado.stock = new Map([[`${PRODUCTO_ID}:${DEPOSITO_ID}`, stockInicial]]);
  estado.ventasCreadas = [];
  estado.llamadasRpc = 0;
}

vi.mock('../../lib/supabase-lazy.js', () => ({ crearClienteSupabaseLazy: () => ({}) }));
vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(() =>
    Promise.resolve({ id: 'vendedor-1', empresa_id: 'empresa-1', rol: 'vendedor' })
  ),
}));
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => vi.fn().mockResolvedValue(false) }));
vi.mock('../../lib/facturas.js', () => ({ emitirFactura: vi.fn() }));
vi.mock('../../lib/error-response.js', () => ({
  errorSeguro: vi.fn((res, _err, status, msg, extra) => res.status(status).json({ error: msg, ...extra })),
}));
vi.mock('../../lib/permisos-service.js', () => ({ puede: vi.fn(() => true) }));

const auditMock = vi.hoisted(() => ({
  registrarAuditoriaFinancieraDurable: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/repos/audit.js', () => ({
  registrarAuditoriaFinancieraDurable: auditMock.registrarAuditoriaFinancieraDurable,
  registrarAuditoriaSilenciosa: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/repos/productos.js', async () => {
  const real = await vi.importActual('../../lib/repos/productos.js');
  return {
    ...real,
    obtenerProductosParaVentaPos: vi.fn(() =>
      Promise.resolve([{ id: PRODUCTO_ID, activo: true, precio_base: 100, iva: 21 }])
    ),
  };
});

vi.mock('../../lib/repos/pos.js', async () => {
  const real = await vi.importActual('../../lib/repos/pos.js');
  return {
    ...real,
    obtenerCajaParaVenta: vi.fn(() =>
      Promise.resolve({ id: CAJA_ID, activa: true, deposito_id: DEPOSITO_ID })
    ),
    obtenerClienteActivoParaVenta: vi.fn(),
    resolverPreciosClienteRpc: vi.fn(),

    // Réplica del RPC real: FOR UPDATE + chequeo + descuento, sin ningún
    // `await` entre medio — misma garantía de atomicidad que Postgres da
    // con el lock real, porque JS es single-threaded.
    registrarVentaPosRpc: vi.fn((payload) => {
      estado.llamadasRpc += 1;

      // Idempotencia por offline_local_id, igual que el RPC real (no
      // ejercitada por este test de carrera, pero mantiene el contrato
      // completo por si algún caso la dispara).
      if (payload.p_offline_local_id) {
        const previa = estado.ventasCreadas.find(v => v.offline_local_id === payload.p_offline_local_id);
        if (previa) {
          return Promise.resolve({ data: { ok: true, venta_id: previa.id, numero: previa.numero, ya_existia: true }, error: null });
        }
      }

      for (const item of payload.p_items) {
        const key = `${item.producto_id}:${payload.p_deposito_id}`;
        const disponible = estado.stock.get(key) ?? 0;

        if (disponible < item.cantidad) {
          return Promise.resolve({
            data: {
              ok: false,
              tipo: 'stock_insuficiente',
              error: `stock_insuficiente:${item.producto_id} disponible:${disponible}`,
            },
            error: null,
          });
        }
        estado.stock.set(key, disponible - item.cantidad);
      }

      const venta = { id: `venta-${estado.ventasCreadas.length + 1}`, numero: `POS-${estado.ventasCreadas.length + 1}`, offline_local_id: payload.p_offline_local_id || null };
      estado.ventasCreadas.push(venta);

      return Promise.resolve({ data: { ok: true, venta_id: venta.id, numero: venta.numero, total: payload.p_total }, error: null });
    }),
  };
});

const { default: posHandler } = await import('../../lib/handlers/pos.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

function mockReqVenta(overrides = {}) {
  return {
    method: 'POST',
    query: {}, // sin `accion` -> registrarVentaHandler
    body: {
      caja_id: CAJA_ID,
      turno_id: TURNO_ID,
      items: [{ producto_id: PRODUCTO_ID, cantidad: 1 }],
      pagos: [{ medio: 'efectivo', monto: 121 }],
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEstado(1); // solo 1 unidad de stock disponible
});

describe('registrarVentaHandler — condición de carrera sobre registrar_venta_pos (Etapa 3)', () => {
  it('2 ventas POS concurrentes por la única unidad de stock disponible: una gana (201), la otra pierde (409 stock_insuficiente) — el stock nunca queda negativo', async () => {
    const res1 = mockRes();
    const res2 = mockRes();

    await Promise.all([
      posHandler(mockReqVenta(), res1),
      posHandler(mockReqVenta(), res2),
    ]);

    expect(estado.llamadasRpc).toBe(2);

    const respuestas = [res1, res2];
    const ganadora = respuestas.find(r => r.status.mock.calls.some(c => c[0] === 201));
    const perdedora = respuestas.find(r => r !== ganadora);

    expect(ganadora).toBeDefined();
    expect(perdedora).toBeDefined();

    expect(ganadora.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, venta_id: expect.any(String) })
    );

    expect(perdedora.status).toHaveBeenCalledWith(409);
    expect(perdedora.json).toHaveBeenCalledWith(
      expect.objectContaining({
        tipo: 'stock_insuficiente',
        error: expect.stringContaining('No hay stock suficiente'),
      })
    );

    // El stock nunca queda negativo — se descontó exactamente 1 vez.
    expect(estado.stock.get(`${PRODUCTO_ID}:${DEPOSITO_ID}`)).toBe(0);

    // Solo la venta que efectivamente se registró generó auditoría
    // financiera — la que perdió la carrera nunca llega a ese punto del
    // handler (corta antes, en el `if (!rpcResult?.ok)`).
    expect(auditMock.registrarAuditoriaFinancieraDurable).toHaveBeenCalledTimes(1);
  });

  it('con 2 unidades de stock para 2 ventas concurrentes de 1 unidad cada una: las dos ganan y el stock queda en 0, no en negativo', async () => {
    resetEstado(2);
    const res1 = mockRes();
    const res2 = mockRes();

    await Promise.all([
      posHandler(mockReqVenta(), res1),
      posHandler(mockReqVenta(), res2),
    ]);

    expect(res1.status).toHaveBeenCalledWith(201);
    expect(res2.status).toHaveBeenCalledWith(201);
    expect(estado.stock.get(`${PRODUCTO_ID}:${DEPOSITO_ID}`)).toBe(0);
    expect(auditMock.registrarAuditoriaFinancieraDurable).toHaveBeenCalledTimes(2);
  });

  it('5 ventas concurrentes de 1 unidad contra un stock de 3: exactamente 3 ganan, 2 pierden por stock_insuficiente, nunca queda negativo', async () => {
    resetEstado(3);
    const respuestas = Array.from({ length: 5 }, () => mockRes());

    await Promise.all(respuestas.map(res => posHandler(mockReqVenta(), res)));

    const ganadoras = respuestas.filter(r => r.status.mock.calls.some(c => c[0] === 201));
    const perdedoras = respuestas.filter(r => r.status.mock.calls.some(c => c[0] === 409));

    expect(ganadoras).toHaveLength(3);
    expect(perdedoras).toHaveLength(2);
    expect(estado.stock.get(`${PRODUCTO_ID}:${DEPOSITO_ID}`)).toBe(0);
  });
});
