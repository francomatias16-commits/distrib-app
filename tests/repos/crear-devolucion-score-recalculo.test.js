// tests/repos/crear-devolucion-score-recalculo.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🟡 #13, resuelto en v958.
// `crearDevolucionCore` (lib/handlers/pedidos/devoluciones.js) recalcula
// el score del cliente tras registrar la devolución con
// `calcularScoreClienteRpc(...).then(() => {}).catch(() => {})` — a
// propósito fire-and-forget (no debe bloquear la respuesta de la
// devolución), pero sin ningún `console.error`: si el RPC fallaba de
// verdad, el score quedaba desactualizado sin ningún rastro para
// detectarlo. v958 agregó `console.error` al `.catch()` existente, mismo
// criterio que `ofrecerPlanDePago` en `score.js`.
//
// REESCRITO tras la migración 570 (Etapa 7, Bloque 1, fix de condición de
// carrera — v1047): la validación de cantidad/precio se movió a
// `rpc_crear_devolucion_validada` (ver crear-devolucion-core.test.js para
// el detalle). Este archivo no se ve afectado en su objetivo — sigue
// fijando que el recálculo de score post-alta queda logueado si falla —
// pero el mock de `crearDevolucionValidadaRpc` reemplaza a los mocks
// viejos de 2 pasos.
//
// REGRESIÓN ENCONTRADA Y CORREGIDA en esta misma sesión: el fix v1047
// dejó `p_cliente_id: cliente_id` en la llamada de recálculo de score
// (lib/handlers/pedidos/devoluciones.js) referenciando una variable
// `cliente_id` que nunca se declaró en el scope de la función — tiraba
// `ReferenceError` de forma síncrona en TODA devolución exitosa, sin
// try/catch que lo contuviera (la devolución ya había quedado grabada
// por la RPC, pero la request entera reventaba antes de responder).
// Corregido a `body.cliente_id`. El test de abajo ("...con 'cliente-1'")
// es justamente el que hubiera detectado esto si se hubiera corrido tras
// aplicar el fix original.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const repoMock = vi.hoisted(() => ({
  devolucionCreada: { id: 'devolucion-uuid-1', cliente_id: 'cliente-1' },
}));

const scoreRpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/repos/pedidos.js', async () => {
  const real = await vi.importActual('../../lib/repos/pedidos.js');
  return {
    ...real,
    crearDevolucionValidadaRpc: vi.fn(() =>
      Promise.resolve({ data: { ok: true, devolucion: repoMock.devolucionCreada }, error: null })
    ),
    listarItemsDevolucionConProducto: vi.fn().mockResolvedValue([]),
    crearNotaDebitoProveedor: vi.fn().mockResolvedValue(null),
    calcularScoreClienteRpc: (...args) => scoreRpcMock(...args),
  };
});

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
vi.mock('../../lib/repos/productos.js', () => ({
  obtenerNombreProducto: vi.fn(),
  obtenerProductosParaValidarPedido: vi.fn(),
  obtenerProductosParaCotizarConCosto: vi.fn(),
  buscarProductosParaRemito: vi.fn(),
  obtenerProveedorDefaultPorProductos: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../lib/repos/audit.js', () => ({ registrarAuditoria: vi.fn() }));
vi.mock('../../lib/utils/storage-urls.js', () => ({
  firmarCampoUrl: vi.fn((v) => v), firmarCampoUrlEnLista: vi.fn((v) => v),
}));
vi.mock('../../lib/handlers/pedidos/_helpers.js', () => ({ validarImagenReal: vi.fn(() => true) }));

const { crearDevolucionCore } = await import('../../lib/handlers/pedidos/devoluciones.js');

const EMPRESA = 'empresa-1';
const CHOFER = 'chofer-1';

let consoleErrorSpy;

beforeEach(() => {
  notifAutoMock.mockClear();
  scoreRpcMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

function bodyDevolucionValida() {
  return {
    empresa_id: EMPRESA, chofer_id: CHOFER,
    body: {
      cliente_id: 'cliente-1', motivo: 'otro',
      items: [{ producto_id: 'prod-1', cantidad: 1 }],
    },
  };
}

describe('crearDevolucionCore — regresión hallazgo #13 (recálculo de score no debe fallar en silencio)', () => {
  it('si calcularScoreClienteRpc rechaza, queda logueado con console.error y la devolución igual se crea OK', async () => {
    scoreRpcMock.mockReturnValue(Promise.reject(new Error('DB hiccup recalculando score')));

    const resultado = await crearDevolucionCore(bodyDevolucionValida());

    // La devolución no depende del recálculo de score (fire-and-forget) —
    // ya se dio por creada antes de que la promesa del RPC se resuelva.
    expect(resultado.ok).toBe(true);

    // Dejar que el microtask del .then().catch() corra.
    await new Promise(r => setImmediate(r));

    expect(consoleErrorSpy).toHaveBeenCalled();
    const mensajes = consoleErrorSpy.mock.calls.map(c => c.join(' '));
    expect(mensajes.some(m => m.includes('Error recalculando score cliente') && m.includes('cliente-1'))).toBe(true);
  });

  it('camino feliz: si calcularScoreClienteRpc resuelve OK, no hay console.error', async () => {
    scoreRpcMock.mockReturnValue(Promise.resolve({ ok: true }));

    const resultado = await crearDevolucionCore(bodyDevolucionValida());
    expect(resultado.ok).toBe(true);

    await new Promise(r => setImmediate(r));

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
