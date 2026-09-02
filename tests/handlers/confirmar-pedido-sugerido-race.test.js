// tests/handlers/confirmar-pedido-sugerido-race.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo #9. `confirmarPedidoSugeridoHandler`
// (link público de confirmación por WhatsApp, sin login) hacía un SELECT
// ...WHERE estado='sugerido' y un UPDATE aparte sin el mismo WHERE — dos
// requests concurrentes (doble tap del cliente o reintento de red del
// bot) podían pasar ambas el chequeo y ejecutar el UPDATE.
//
// Fix real: migración 537 reescribe `confirmar_pedido_sugerido` como un
// único UPDATE atómico con `WHERE ... AND estado = 'sugerido' RETURNING
// numero_pedido` — el UPDATE mismo es el lock optimista, mismo criterio
// que `bloquearPresupuestoAceptado()` para el caso gemelo en
// Presupuestos. Estos tests no pueden ejercitar la atomicidad real de
// Postgres (no hay DB en el test), así que mockean `confirmarPedidoSugeridoRpc`
// replicando exactamente el contrato de la migración: la RPC ya resuelve
// la carrera y el handler solo tiene que reaccionar bien a `data.ok`
// true/false — es la responsabilidad que le queda al código de
// aplicación después del fix.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const repoState = vi.hoisted(() => ({
  pedido: {
    id: 'pedido-aaaa-1111',
    empresa_id: 'empresa-1',
    cliente_id: 'cliente-1',
    estado: 'sugerido',
  },
  rpcLlamadas: [], // payloads pasados a confirmarPedidoSugeridoRpc
  rpcRespuestas: [], // cola de { data, error } a devolver, una por llamada
}));

vi.mock('../../lib/repos/pedidos.js', async () => {
  const real = await vi.importActual('../../lib/repos/pedidos.js');
  return {
    ...real,
    obtenerPedidoParaConfirmarSugerido: vi.fn(() =>
      Promise.resolve({ data: repoState.pedido, error: null })
    ),
    confirmarPedidoSugeridoRpc: vi.fn((payload) => {
      repoState.rpcLlamadas.push(payload);
      const siguiente = repoState.rpcRespuestas.shift();
      return Promise.resolve(siguiente ?? { data: { ok: true, numero_pedido: 1 }, error: null });
    }),
  };
});

const auditMock = vi.hoisted(() => ({
  registrarAuditoriaSilenciosa: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/repos/audit.js', () => ({
  registrarAuditoria: vi.fn(),
  registrarAuditoriaSilenciosa: auditMock.registrarAuditoriaSilenciosa,
}));

vi.mock('../../lib/supabase-lazy.js', () => ({ crearClienteSupabaseLazy: () => ({}) }));
vi.mock('../../lib/security-headers.js', () => ({ applySecurityHeaders: vi.fn(), applyCorsHeaders: vi.fn() }));
vi.mock('../../lib/facturas.js', () => ({ emitirFactura: vi.fn() }));
vi.mock('../../lib/eventos.js', () => ({ emitirEvento: vi.fn(), usaDespachadorEventos: vi.fn(() => false) }));
vi.mock('../../lib/email.js', () => ({ enviarEmailConfirmacionPedido: vi.fn(), enviarEmailDespacho: vi.fn() }));
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => vi.fn().mockResolvedValue(false) }));
vi.mock('../../lib/plan-limits.js', () => ({ exigirLimitePlan: vi.fn(), LimitePlanError: class extends Error {} }));
vi.mock('../../lib/handlers/_push.js', () => ({
  notificarPedidoEnCamino: vi.fn(), notificarPuntosGanados: vi.fn(), enviarPush: vi.fn(),
}));
vi.mock('../../lib/handlers/_auto-push.js', () => ({ notifAuto: vi.fn().mockResolvedValue(null) }));
vi.mock('../../lib/error-response.js', () => ({ errorSeguro: vi.fn((res, _err, status, msg, extra) => res.status(status).json({ error: msg, ...extra })) }));
vi.mock('../../lib/repos/pagos.js', () => ({
  existeIntegracionMPActiva: vi.fn(), esPedidoPilotoWhatsApp: vi.fn(),
}));
vi.mock('../../lib/repos/combos.js', () => ({ obtenerCombosParaValidarPedido: vi.fn() }));
vi.mock('../../lib/repos/productos.js', () => ({
  obtenerNombreProducto: vi.fn(),
  obtenerProductosParaValidarPedido: vi.fn(),
  obtenerProductosParaCotizarConCosto: vi.fn(),
  buscarProductosParaRemito: vi.fn(),
  obtenerProveedorDefaultPorProductos: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../lib/permisos-service.js', () => ({ puede: vi.fn(() => true), rolesDe: vi.fn(() => []) }));
vi.mock('../../lib/utils/storage-urls.js', () => ({
  firmarCampoUrl: vi.fn((v) => v), firmarCampoUrlEnLista: vi.fn((v) => v),
}));
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: vi.fn() }));

const { confirmarPedidoSugeridoHandler } = await import('../../lib/handlers/pedidos.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function mockReq(body) {
  return { body };
}

beforeEach(() => {
  vi.clearAllMocks();
  repoState.pedido = {
    id: 'pedido-aaaa-1111',
    empresa_id: 'empresa-1',
    cliente_id: 'cliente-1',
    estado: 'sugerido',
  };
  repoState.rpcLlamadas = [];
  repoState.rpcRespuestas = [];
});

describe('confirmarPedidoSugeridoHandler — regresión hallazgo #9 (condición de carrera)', () => {
  it('sin pedido_id: 400 y no llega a llamar la RPC', async () => {
    const res = mockRes();

    await confirmarPedidoSugeridoHandler(mockReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(repoState.rpcLlamadas).toHaveLength(0);
  });

  it('pedido inexistente: 404 y no llama la RPC', async () => {
    repoState.pedido = null;
    const res = mockRes();

    await confirmarPedidoSugeridoHandler(mockReq({ pedido_id: 'no-existe' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(repoState.rpcLlamadas).toHaveLength(0);
  });

  it('pedido ya no está en estado "sugerido" (chequeo previo a la RPC): 409, no llama la RPC ni audita', async () => {
    repoState.pedido = { ...repoState.pedido, estado: 'pendiente' };
    const res = mockRes();

    await confirmarPedidoSugeridoHandler(mockReq({ pedido_id: 'pedido-aaaa-1111' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(repoState.rpcLlamadas).toHaveLength(0);
    expect(auditMock.registrarAuditoriaSilenciosa).not.toHaveBeenCalled();
  });

  it('carrera resuelta por la RPC (migración 537): 2 requests "concurrentes" — la 1ra gana (ok:true) y audita, la 2da pierde (ok:false, 409) y NO audita', async () => {
    // Replica el contrato exacto de la migración 537: solo la ejecución
    // que efectivamente hace el UPDATE devuelve ok:true + numero_pedido;
    // la que llega después de que la fila ya no matchea el WHERE
    // (estado ya no es 'sugerido') devuelve ok:false sin haber tocado nada.
    repoState.rpcRespuestas = [
      { data: { ok: true, numero_pedido: 4821 }, error: null },
      { data: { ok: false, error: 'Pedido no encontrado o ya procesado' }, error: null },
    ];

    const res1 = mockRes();
    const res2 = mockRes();

    // Ambos requests pasan el chequeo previo (mismo `repoState.pedido`
    // con estado:'sugerido' — así se comportaba el código ANTES del fix:
    // el SELECT de chequeo no bloquea nada, así que dos requests
    // concurrentes lo pasan igual). Lo que cambió es que ahora solo una
    // de las dos llamadas a la RPC puede tener éxito.
    await Promise.all([
      confirmarPedidoSugeridoHandler(mockReq({ pedido_id: 'pedido-aaaa-1111' }), res1),
      confirmarPedidoSugeridoHandler(mockReq({ pedido_id: 'pedido-aaaa-1111' }), res2),
    ]);

    expect(repoState.rpcLlamadas).toHaveLength(2);

    // Una respuesta ganó (200, ok:true) y la otra perdió (409, ok:false)
    // — no importa el orden real de resolución de las promesas, lo que
    // importa es que exactamente una de las dos ganó.
    const respuestas = [res1, res2];
    const ganadora = respuestas.find((r) => r.json.mock.calls.some((c) => c[0]?.ok === true));
    const perdedora = respuestas.find((r) => r !== ganadora);

    expect(ganadora).toBeDefined();
    expect(perdedora).toBeDefined();
    expect(ganadora.status).not.toHaveBeenCalledWith(409);
    expect(ganadora.json).toHaveBeenCalledWith({ ok: true, numero_pedido: 4821 });

    expect(perdedora.status).toHaveBeenCalledWith(409);
    expect(perdedora.json).toHaveBeenCalledWith({ ok: false, error: 'Pedido no encontrado o ya procesado' });

    // Solo se audita la transición que efectivamente ocurrió — la
    // segunda ejecución (ok:false) no genera una fila de auditoría
    // fantasma con antes/después idénticos.
    expect(auditMock.registrarAuditoriaSilenciosa).toHaveBeenCalledTimes(1);
    expect(auditMock.registrarAuditoriaSilenciosa).toHaveBeenCalledWith(
      'empresa-1', null, 'pedidos', 'UPDATE', 'pedido-aaaa-1111',
      { estado: 'sugerido' }, { ok: true, numero_pedido: 4821 }
    );
  });
});
