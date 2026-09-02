// tests/handlers/captura-competencia-margen.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, 1.6: "Test de que el margen mínimo nunca
// se pisa, ni por error de cálculo ni por edición manual del vendedor."
// Es un control obligatorio (ver plan, "Riesgos transversales" —
// "Presión sobre el margen en el momento de cierre... no es opcional").
//
// Cobertura: accionCerrar (lib/handlers/captura-competencia.js), que es
// el único lugar donde se valida el piso — corre SIEMPRE sobre el valor
// VIGENTE de `precio_unitario_propio` en captura_competencia_items al
// momento de cerrar, sin importar si ese valor viene del matching
// automático o de una edición manual del vendedor vía accion=confirmar_item
// (confirmarItemCaptura escribe a la misma tabla que después lee
// obtenerCapturaDetalle) — por eso no hace falta ejercitar
// confirmar_item acá: alcanza con simular, vía el mock de
// obtenerCapturaDetalle, el estado que ESA acción dejaría en la fila.
//
// No duplica tests/handlers/captura-competencia-flag.test.js (gate del
// flag) ni la suite completa de permisos por acción — foco acotado al
// piso de margen en sí.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(async () => ({ id: 'u1', empresa_id: 'e1', rol: 'vendedor' })),
}));

vi.mock('../../lib/security-headers.js', () => ({ aplicarHeaders: vi.fn() }));
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => async () => false }));
vi.mock('../../lib/error-response.js', () => ({
  errorSeguro: (res, err) => res.status(500).json({ error: err.message }),
}));
vi.mock('../../lib/permisos-service.js', () => ({ puede: vi.fn(() => true) }));
vi.mock('../../lib/utils/image-sniff.js', () => ({ validarImagenPorContenido: vi.fn() }));
vi.mock('../../lib/repos/clientes.js', () => ({ crearCliente: vi.fn() }));
vi.mock('../../lib/utils/storage-urls.js', () => ({ firmarCampoUrl: vi.fn() }));
vi.mock('../../lib/handlers/captura-competencia/_extraccion.js', () => ({ extraerRenglonesDeFactura: vi.fn() }));
vi.mock('../../lib/handlers/pedidos/crear-pedido.js', () => ({ crearPedidoParaCliente: vi.fn() }));

const obtenerCapturaDetalleMock = vi.fn();
const actualizarTotalesCapturaMock = vi.fn(async () => ({ error: null }));
vi.mock('../../lib/repos/captura-competencia.js', () => ({
  subirFotoCapturaStorage: vi.fn(),
  crearCaptura: vi.fn(),
  insertarItemsCaptura: vi.fn(),
  obtenerCapturaDetalle: (...args) => obtenerCapturaDetalleMock(...args),
  listarCapturasPendientes: vi.fn(async () => ({ data: [], error: null })),
  obtenerMetricasCaptura: vi.fn(async () => ({ data: [], error: null })),
  actualizarTotalesCaptura: (...args) => actualizarTotalesCapturaMock(...args),
  marcarCapturaConvertida: vi.fn(),
  confirmarItemCaptura: vi.fn(),
  matchearProducto: vi.fn(),
  listarAhorroAcumuladoEmpresa: vi.fn(async () => ({ data: [], error: null })),
}));

const { default: handler } = await import('../../lib/handlers/captura-competencia.js');

function mockReqRes({ body = {} } = {}) {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      if (this.statusCode === null) this.statusCode = 200;
      this.body = payload;
      return this;
    },
    end() { return this; },
  };
  const req = { method: 'POST', query: { accion: 'cerrar' }, body, headers: {} };
  return { req, res };
}

/** db.from() con comportamiento distinto según la tabla — 'empresas' para
 * el gate del flag + piso de margen configurado, 'productos' para el
 * costo usado en accionCerrar. */
function mockDbFrom({ config = { captura_competencia_habilitada: true }, productos = [] } = {}) {
  dbMock.from.mockImplementation((tabla) => {
    if (tabla === 'empresas') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { config }, error: null }) }) }) };
    }
    if (tabla === 'productos') {
      const query = { select: () => query, in: () => query };
      query.then = (resolve) => resolve({ data: productos, error: null });
      return query;
    }
    throw new Error(`db.from('${tabla}') no mockeado en este test`);
  });
}

/** Arma una captura con un único item, con costo/precio ya seteados como
 * quedarían en la tabla — sea por matching automático o por edición
 * manual del vendedor vía accion=confirmar_item (mismo campo, misma
 * columna: no hay forma de que accionCerrar distinga el origen, y no
 * debe: el control tiene que aplicar igual en los dos casos).
 *
 * precioCompetencia default 120: tiene que quedar en el mismo orden de
 * magnitud que los precioPropio usados en este archivo (90-100) para no
 * disparar el chequeo de RATIO_PRECIO_SOSPECHOSO (>4x) de accionCerrar,
 * que corre ANTES que el piso de margen y lo taparía — un valor como
 * 1000 simula un "producto mal matcheado", no el caso sano que estos
 * tests de piso de margen quieren ejercitar. */
function capturaConItem({ precioPropio, precioCompetencia = 120, cantidad = 1, productoId = 'p1' }) {
  return {
    id: 'captura-1',
    estado: 'pendiente_revision',
    captura_competencia_items: [
      { id: 'item-1', producto_id: productoId, cantidad, precio_unitario_propio: precioPropio, precio_unitario_competencia: precioCompetencia, descartado: false },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  actualizarTotalesCapturaMock.mockResolvedValue({ error: null });
});

describe('piso de margen — por cálculo (matching automático)', () => {
  it('rechaza con 409 cuando el margen calculado queda por debajo del piso default (8%)', async () => {
    // costo 95, precio propio 100 → margen (100-95)/100 = 5% < 8%
    mockDbFrom({ productos: [{ id: 'p1', costo: 95 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({ data: capturaConItem({ precioPropio: 100 }), error: null });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.violaciones_margen).toEqual([{ item_id: 'item-1', margen_actual_pct: 5 }]);
    expect(actualizarTotalesCapturaMock).not.toHaveBeenCalled();
  });

  it('rechaza contra el piso CONFIGURADO por empresa, no el default, cuando la empresa definió uno propio', async () => {
    // margen real 10% — pasa el default (8%) pero no el piso de esta empresa (12%)
    mockDbFrom({
      config: { captura_competencia_habilitada: true, captura_competencia_margen_minimo_pct: 12 },
      productos: [{ id: 'p1', costo: 90 }],
    });
    obtenerCapturaDetalleMock.mockResolvedValue({ data: capturaConItem({ precioPropio: 100 }), error: null });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('12%');
  });

  it('permite cerrar cuando el margen calculado está justo en el piso (boundary, no estrictamente menor)', async () => {
    // costo 92, precio 100 → margen exactamente 8% — el código exige < margenMinimo, así que 8% no viola
    mockDbFrom({ productos: [{ id: 'p1', costo: 92 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({ data: capturaConItem({ precioPropio: 100 }), error: null });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('reporta TODOS los renglones violatorios, no solo el primero', async () => {
    mockDbFrom({ productos: [{ id: 'p1', costo: 95 }, { id: 'p2', costo: 96 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({
      data: {
        id: 'captura-1',
        estado: 'pendiente_revision',
        captura_competencia_items: [
          { id: 'item-1', producto_id: 'p1', cantidad: 1, precio_unitario_propio: 100, precio_unitario_competencia: 120, descartado: false },
          { id: 'item-2', producto_id: 'p2', cantidad: 1, precio_unitario_propio: 100, precio_unitario_competencia: 130, descartado: false },
        ],
      },
      error: null,
    });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.violaciones_margen.map((v) => v.item_id)).toEqual(['item-1', 'item-2']);
  });
});

describe('piso de margen — por edición manual del vendedor (accion=confirmar_item)', () => {
  it('un precio propio bajado a mano por debajo del costo se rechaza igual al cerrar (mismo control, no hay bypass)', async () => {
    // El vendedor "regala" margen desde la pantalla de revisión bajando el
    // precio a 90 con costo 95 — margen negativo. accionCerrar lee el
    // valor YA EDITADO (misma columna que toca confirmarItemCaptura) y
    // tiene que rechazarlo igual que si hubiera venido mal del matching.
    mockDbFrom({ productos: [{ id: 'p1', costo: 95 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({ data: capturaConItem({ precioPropio: 90 }), error: null });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.violaciones_margen[0].margen_actual_pct).toBeLessThan(0);
  });

  it('no hay forma de forzar el cierre pasando un margen o total ya calculado en el body — accionCerrar ignora cualquier campo que no sea `id`', async () => {
    mockDbFrom({ productos: [{ id: 'p1', costo: 95 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({ data: capturaConItem({ precioPropio: 100 }), error: null });
    const { req, res } = mockReqRes({
      body: { id: 'captura-1', ahorro_absoluto: 999999, ahorro_porcentual: 99, violaciones_margen: [], forzar: true },
    });

    await handler(req, res);

    // Sigue rechazando por el mismo 5% real — el body extra no tiene efecto.
    expect(res.statusCode).toBe(409);
  });
});

describe('piso de margen — casos borde que no deben confundirse con una violación', () => {
  it('costo en 0 (no cargado) no dispara el control — se degrada a "no verificable", no a violación falsa', async () => {
    mockDbFrom({ productos: [{ id: 'p1', costo: 0 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({ data: capturaConItem({ precioPropio: 100 }), error: null });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('precio propio en 0 (sin definir) tampoco dispara el control por sí solo', async () => {
    mockDbFrom({ productos: [{ id: 'p1', costo: 50 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({ data: capturaConItem({ precioPropio: 0 }), error: null });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('items descartados no entran al cálculo de margen ni de totales', async () => {
    mockDbFrom({ productos: [{ id: 'p1', costo: 10 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({
      data: {
        id: 'captura-1',
        estado: 'pendiente_revision',
        captura_competencia_items: [
          { id: 'item-1', producto_id: 'p1', cantidad: 1, precio_unitario_propio: 100, precio_unitario_competencia: 120, descartado: false },
          // Este violaría el piso (margen 0%) pero está descartado — no debe contarse.
          { id: 'item-2', producto_id: 'p2', cantidad: 1, precio_unitario_propio: 10, precio_unitario_competencia: 10, descartado: true },
        ],
      },
      error: null,
    });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total_propio_cotizado).toBe(100);
  });
});

describe('piso de margen — cierre exitoso escribe totales correctos', () => {
  it('con margen sano, calcula ahorro absoluto/porcentual y persiste estado revisado', async () => {
    mockDbFrom({ productos: [{ id: 'p1', costo: 60 }] });
    obtenerCapturaDetalleMock.mockResolvedValue({
      data: capturaConItem({ precioPropio: 100, precioCompetencia: 150, cantidad: 2 }),
      error: null,
    });
    const { req, res } = mockReqRes({ body: { id: 'captura-1' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total_competencia).toBe(300);
    expect(res.body.total_propio_cotizado).toBe(200);
    expect(res.body.ahorro_absoluto).toBe(100);
    expect(actualizarTotalesCapturaMock).toHaveBeenCalledWith('captura-1', expect.objectContaining({ estado: 'revisado' }));
  });
});
