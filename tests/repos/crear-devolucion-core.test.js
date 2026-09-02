// tests/repos/crear-devolucion-core.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🔴 Crítico #0. `crearDevolucionCore`
// (lib/handlers/pedidos/devoluciones.js) es el único punto de alta de
// devoluciones compartido por la app del chofer, el alta manual del admin
// y (desde v955) la tool de voz `registrar_devolucion_pedido` — y hasta
// ahora no tenía ningún test, a pesar de ser exactamente la función que
// causó el incidente real de producción documentado en
// CHANGELOG_v805_auditoria_devoluciones_validacion_cantidad_precio.md:
// el 17/08/2026 se aprobó una devolución de 4.555 u. de un producto que el
// cliente había comprado 42 u. en total, vinculada a un pedido que ni
// siquiera lo incluía — generó stock fantasma y una nota de crédito
// pendiente por ~$9.865.288,69.
//
// REESCRITO tras la migración 570 (Etapa 7, Bloque 1, fix de condición de
// carrera — v1047): la validación de "cantidad disponible" (control 1),
// el chequeo de "producto pertenece al pedido" (control 2) y la
// resolución server-side del precio (control 3) — los 3 controles que
// este archivo fijaba desde v805 — ya NO viven en JS. Se movieron
// enteros a `rpc_crear_devolucion_validada`
// (supabase/migrations/..._570_..._fix_race_condition.sql), una única
// transacción de Postgres serializada por cliente con un advisory lock.
//
// Esto significa que un test unitario de `crearDevolucionCore` mockeando
// `lib/repos/pedidos.js` YA NO PUEDE verificar la aritmética de esos 3
// controles — son opacos desde acá, viven adentro de la RPC. Lo que este
// archivo sí puede (y debe) seguir fijando como contrato:
//   - que `crearDevolucionCore` arma el payload correcto para la RPC
//     (incluyendo que el precio jamás viaja en `items`, solo
//     producto_id + cantidad — el body no puede inyectar un precio)
//   - que interpreta correctamente ok/error/offline_replay de la RPC
//   - que el resto del flujo post-RPC (nota de débito automática, con el
//     precio real leído de `listarItemsDevolucionConProducto` — nunca del
//     body — y el recálculo de score) sigue funcionando igual que antes
//
// ⚠️ GAP DE COBERTURA: la aritmética real de los 3 controles (v805) y la
// resolución de precio ahora solo existen en SQL, dentro de la RPC, y no
// tienen ningún test propio (ni acá ni en ningún otro archivo del repo al
// momento de este cambio). Si se vuelve a romper esa lógica, ningún test
// lo va a detectar. Pendiente: un test de integración contra Postgres
// real (pgTAP o un test de Vitest con un cliente de Supabase de prueba)
// que ejecute `rpc_crear_devolucion_validada` de punta a punta.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const repoMock = vi.hoisted(() => ({
  devolucionCreada: { id: 'devolucion-uuid-1', cliente_id: 'cliente-1' },
  itemsConProducto: [],
  rpcLlamadas: [],
  rpcOk: true,
  rpcError: null,
  rpcErrorMsg: null,
  rpcOfflineReplay: false,
}));

vi.mock('../../lib/repos/pedidos.js', async () => {
  const real = await vi.importActual('../../lib/repos/pedidos.js');
  return {
    ...real,
    crearDevolucionValidadaRpc: vi.fn((payload) => {
      repoMock.rpcLlamadas.push(payload);
      if (repoMock.rpcError) return Promise.resolve({ data: null, error: repoMock.rpcError });
      if (!repoMock.rpcOk) return Promise.resolve({ data: { ok: false, error: repoMock.rpcErrorMsg }, error: null });
      if (repoMock.rpcOfflineReplay) {
        return Promise.resolve({ data: { ok: true, offline_replay: true, devolucion: repoMock.devolucionCreada }, error: null });
      }
      return Promise.resolve({ data: { ok: true, devolucion: repoMock.devolucionCreada }, error: null });
    }),
    listarItemsDevolucionConProducto: vi.fn(() => Promise.resolve(repoMock.itemsConProducto)),
    crearNotaDebitoProveedor: vi.fn().mockResolvedValue(null),
    calcularScoreClienteRpc: vi.fn().mockResolvedValue(null),
  };
});

// Stubs mínimos del resto de dependencias — ninguna interviene en la
// lógica bajo test, solo hace falta que el import del archivo no reviente.
vi.mock('../../lib/supabase-lazy.js', () => ({ crearClienteSupabaseLazy: () => ({}) }));
vi.mock('../../lib/security-headers.js', () => ({ applySecurityHeaders: vi.fn(), applyCorsHeaders: vi.fn() }));
vi.mock('../../lib/auth-helpers.js', () => ({ getUserSeguro: vi.fn() }));
vi.mock('../../lib/permisos-service.js', () => ({ puede: vi.fn(() => true) }));
vi.mock('../../lib/facturas.js', () => ({ emitirFactura: vi.fn() }));
vi.mock('../../lib/eventos.js', () => ({ emitirEvento: vi.fn(), usaDespachadorEventos: vi.fn(() => false) }));
vi.mock('../../lib/email.js', () => ({ enviarEmailConfirmacionPedido: vi.fn(), enviarEmailDespacho: vi.fn() }));
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => vi.fn().mockResolvedValue(false) }));
vi.mock('../../lib/plan-limits.js', () => ({ exigirLimitePlan: vi.fn(), LimitePlanError: class extends Error {} }));
vi.mock('../../lib/handlers/_push.js', () => ({
  notificarPedidoEnCamino: vi.fn(), notificarPuntosGanados: vi.fn(), enviarPush: vi.fn(),
}));
const notifAutoMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('../../lib/handlers/_auto-push.js', () => ({ notifAuto: notifAutoMock }));
vi.mock('../../lib/error-response.js', () => ({ errorSeguro: vi.fn() }));
vi.mock('../../lib/repos/pagos.js', () => ({
  existeIntegracionMPActiva: vi.fn(), esPedidoPilotoWhatsApp: vi.fn(),
}));
vi.mock('../../lib/repos/combos.js', () => ({ obtenerCombosParaValidarPedido: vi.fn() }));
const obtenerProveedorDefaultMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../../lib/repos/productos.js', () => ({
  obtenerNombreProducto: vi.fn(),
  obtenerProductosParaValidarPedido: vi.fn(),
  obtenerProductosParaCotizarConCosto: vi.fn(),
  buscarProductosParaRemito: vi.fn(),
  obtenerProveedorDefaultPorProductos: (...args) => obtenerProveedorDefaultMock(...args),
}));
vi.mock('../../lib/repos/audit.js', () => ({ registrarAuditoria: vi.fn() }));
vi.mock('../../lib/utils/storage-urls.js', () => ({
  firmarCampoUrl: vi.fn((v) => v), firmarCampoUrlEnLista: vi.fn((v) => v),
}));
vi.mock('../../lib/handlers/pedidos/_helpers.js', () => ({ validarImagenReal: vi.fn(() => true) }));

const { crearDevolucionCore } = await import('../../lib/handlers/pedidos/devoluciones.js');
const { crearDevolucionValidadaRpc, listarItemsDevolucionConProducto, crearNotaDebitoProveedor } =
  await import('../../lib/repos/pedidos.js');

const EMPRESA = 'empresa-1';
const CHOFER = 'chofer-1';

beforeEach(() => {
  notifAutoMock.mockClear();
  obtenerProveedorDefaultMock.mockClear();
  obtenerProveedorDefaultMock.mockResolvedValue([]);
  crearDevolucionValidadaRpc.mockClear();
  listarItemsDevolucionConProducto.mockClear();
  crearNotaDebitoProveedor.mockClear();
  repoMock.devolucionCreada = { id: 'devolucion-uuid-1', cliente_id: 'cliente-1' };
  repoMock.itemsConProducto = [];
  repoMock.rpcLlamadas = [];
  repoMock.rpcOk = true;
  repoMock.rpcError = null;
  repoMock.rpcErrorMsg = null;
  repoMock.rpcOfflineReplay = false;
});

describe('crearDevolucionCore — validaciones básicas (antes de llegar a la RPC)', () => {
  it('rechaza motivo inválido sin llamar a la RPC', async () => {
    const resultado = await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: { cliente_id: 'cliente-1', motivo: 'motivo_inventado', items: [{ producto_id: 'prod-1', cantidad: 1 }] },
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.status).toBe(400);
    expect(crearDevolucionValidadaRpc).not.toHaveBeenCalled();
  });

  it('rechaza items vacíos sin llamar a la RPC', async () => {
    const resultado = await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: { cliente_id: 'cliente-1', motivo: 'otro', items: [] },
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.status).toBe(400);
    expect(crearDevolucionValidadaRpc).not.toHaveBeenCalled();
  });
});

describe('crearDevolucionCore — arma el payload correcto para rpc_crear_devolucion_validada', () => {
  it('nunca manda precio_unitario en los items (el precio se resuelve server-side en la RPC)', async () => {
    await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: {
        cliente_id: 'cliente-1', motivo: 'otro',
        items: [{ producto_id: 'prod-1', cantidad: 2, precio_unitario: 1 }], // precio manipulado en el body
      },
    });

    expect(repoMock.rpcLlamadas).toHaveLength(1);
    const itemEnviado = repoMock.rpcLlamadas[0].p_items[0];
    expect(itemEnviado).toEqual({ producto_id: 'prod-1', cantidad: 2 }); // sin precio_unitario
  });

  it('canal chofer: manda pedido_id con cliente_id null cuando el body no lo trae (resolución queda del lado de la RPC)', async () => {
    // Este es el payload real que manda frontend/chofer/chofer-offline.js:
    // pedido_id, motivo, notas, foto_url, items — nunca cliente_id.
    await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: {
        pedido_id: 'pedido-1', motivo: 'otro',
        items: [{ producto_id: 'prod-1', cantidad: 1 }],
      },
    });

    expect(repoMock.rpcLlamadas[0]).toMatchObject({
      p_empresa_id: EMPRESA, p_pedido_id: 'pedido-1', p_cliente_id: null, p_chofer_id: CHOFER,
    });
  });

  it('pasa empresa_id, chofer_id, motivo, notas, foto_url y offline_local_id sin modificar', async () => {
    await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: {
        cliente_id: 'cliente-1', pedido_id: 'pedido-1', motivo: 'vencido',
        notas: 'se venció en tránsito', foto_url: 'ruta/foto.jpg',
        offline_local_id: 'local-123',
        items: [{ producto_id: 'prod-1', cantidad: 1 }],
      },
    });

    expect(repoMock.rpcLlamadas[0]).toMatchObject({
      p_empresa_id: EMPRESA, p_cliente_id: 'cliente-1', p_pedido_id: 'pedido-1', p_chofer_id: CHOFER,
      p_motivo: 'vencido', p_notas: 'se venció en tránsito', p_foto_url: 'ruta/foto.jpg',
      p_offline_local_id: 'local-123',
    });
  });
});

describe('crearDevolucionCore — interpretación de la respuesta de la RPC', () => {
  it('si la RPC devuelve ok:false, relaya el error tal cual con status 400', async () => {
    repoMock.rpcOk = false;
    repoMock.rpcErrorMsg = 'Cantidad a devolver (4555) supera lo disponible para devolver de ese producto (42 — sobre 42 comprados en total).';

    const resultado = await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: { cliente_id: 'cliente-1', motivo: 'otro', items: [{ producto_id: 'prod-1', cantidad: 4555 }] },
    });

    expect(resultado.ok).toBe(false);
    expect(resultado.status).toBe(400);
    expect(resultado.error).toBe(repoMock.rpcErrorMsg);
  });

  it('si la RPC falla a nivel de transporte (error de Postgrest/red), devuelve 500 genérico sin filtrar el error interno', async () => {
    repoMock.rpcError = { message: 'connection reset' };

    const resultado = await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: { cliente_id: 'cliente-1', motivo: 'otro', items: [{ producto_id: 'prod-1', cantidad: 1 }] },
    });

    expect(resultado.ok).toBe(false);
    expect(resultado.status).toBe(500);
  });

  it('offline_replay: devuelve la devolución ya existente sin volver a notificar ni recalcular score', async () => {
    repoMock.rpcOfflineReplay = true;

    const resultado = await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: {
        cliente_id: 'cliente-1', motivo: 'otro', offline_local_id: 'local-123',
        items: [{ producto_id: 'prod-1', cantidad: 1 }],
      },
    });

    expect(resultado.ok).toBe(true);
    expect(resultado.payload.offline_replay).toBe(true);
    expect(notifAutoMock).not.toHaveBeenCalled();
  });

  it('camino feliz: crea la devolución y notifica al admin', async () => {
    const resultado = await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: { cliente_id: 'cliente-1', motivo: 'cliente_arrepentido', items: [{ producto_id: 'prod-1', cantidad: 2 }] },
    });

    expect(resultado.ok).toBe(true);
    expect(resultado.payload.devolucion).toEqual(repoMock.devolucionCreada);
    expect(notifAutoMock).toHaveBeenCalled();
  });
});

describe('crearDevolucionCore — nota de débito automática (producto_defectuoso)', () => {
  it('usa el precio_unitario real insertado por la RPC (listarItemsDevolucionConProducto), nunca el del body', async () => {
    repoMock.itemsConProducto = [
      { producto_id: 'prod-1', cantidad: 2, precio_unitario: 300, productos: { nombre: 'Producto X' } },
    ];
    obtenerProveedorDefaultMock.mockResolvedValueOnce([
      { id: 'prod-1', nombre: 'Producto X', proveedor_id_default: 'proveedor-1' },
    ]);

    await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: {
        cliente_id: 'cliente-1', motivo: 'producto_defectuoso',
        items: [{ producto_id: 'prod-1', cantidad: 2, precio_unitario: 1 }], // precio manipulado en el body
      },
    });

    expect(crearNotaDebitoProveedor).toHaveBeenCalledWith(
      expect.objectContaining({ monto: 600 }) // 2 × 300 (precio real de la RPC), no 2 × 1
    );
  });

  it('ítem sin proveedor por defecto: no genera nota de débito y lo reporta en items_sin_proveedor_default, avisando aparte', async () => {
    repoMock.itemsConProducto = [
      { producto_id: 'prod-2', cantidad: 1, precio_unitario: 100, productos: { nombre: 'Producto Y' } },
    ];
    obtenerProveedorDefaultMock.mockResolvedValueOnce([
      { id: 'prod-2', nombre: 'Producto Y', proveedor_id_default: null },
    ]);

    const resultado = await crearDevolucionCore({
      empresa_id: EMPRESA, chofer_id: CHOFER,
      body: { cliente_id: 'cliente-1', motivo: 'producto_defectuoso', items: [{ producto_id: 'prod-2', cantidad: 1 }] },
    });

    expect(crearNotaDebitoProveedor).not.toHaveBeenCalled();
    expect(resultado.payload.items_sin_proveedor_default).toHaveLength(1);
    expect(notifAutoMock).toHaveBeenCalledTimes(2); // aviso de devolución + aviso de "NC no generada"
  });
});
