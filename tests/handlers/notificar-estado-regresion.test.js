// tests/handlers/notificar-estado-regresion.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo #8. `notificarEstado` (aviso WhatsApp de
// "pedido despachado") no tenía ningún test de regresión pese a cubrir 4
// ramas distintas de logging en `notif_log` vía `_logNotif`: sin teléfono,
// éxito, falla HTTP (resp.ok=false) y excepción del fetch. Mismo criterio
// que `cierre-notif-vencimiento.test.js` (hallazgo #11) para el caso
// gemelo de `procesarNotifVencimiento`.
//
// Se exportó `notificarEstado` (antes interna) para poder testearla
// directo, mismo criterio que `whatsappHandler` (hallazgo #14) y
// `confirmarPedidoSugeridoHandler` (hallazgo #9).

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const repoState = vi.hoisted(() => ({
  cliente: { id: 'cliente-1', telefono: '+5493405111111', razon_social: 'Cliente Uno' },
  notifLogLlamadas: [], // payloads pasados a insertarNotifLog
}));

vi.mock('../../lib/repos/pedidos.js', async () => {
  const real = await vi.importActual('../../lib/repos/pedidos.js');
  return {
    ...real,
    obtenerClienteTelefonoRazonSocial: vi.fn(() => Promise.resolve(repoState.cliente)),
    insertarNotifLog: vi.fn((payload) => {
      repoState.notifLogLlamadas.push(payload);
      return Promise.resolve({ error: null });
    }),
  };
});

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
vi.mock('../../lib/error-response.js', () => ({ errorSeguro: vi.fn((res) => res.status(500).json({ error: 'err' })) }));
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
vi.mock('../../lib/repos/audit.js', () => ({ registrarAuditoria: vi.fn(), registrarAuditoriaSilenciosa: vi.fn() }));
vi.mock('../../lib/utils/storage-urls.js', () => ({
  firmarCampoUrl: vi.fn((v) => v), firmarCampoUrlEnLista: vi.fn((v) => v),
}));
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: vi.fn() }));

const { notificarEstado } = await import('../../lib/handlers/pedidos.js');

const PEDIDO = { id: 'pedido-0000-abcdef12', cliente_id: 'cliente-1', total: 5500 };

let consoleErrorSpy;
let consoleLogSpy;

beforeEach(() => {
  repoState.cliente = { id: 'cliente-1', telefono: '+5493405111111', razon_social: 'Cliente Uno' };
  repoState.notifLogLlamadas = [];
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('notificarEstado — regresión hallazgo #8 (aviso WhatsApp pedido_despachado)', () => {
  it('sin teléfono: loguea entregada=false motivo=sin_telefono y NO llama a fetch', async () => {
    repoState.cliente = { id: 'cliente-1', telefono: null, razon_social: 'Cliente Uno' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await notificarEstado(PEDIDO, 'empresa-1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(repoState.notifLogLlamadas).toHaveLength(1);
    expect(repoState.notifLogLlamadas[0]).toMatchObject({
      tipo: 'pedido_despachado',
      canal: 'whatsapp',
      entregada: false,
      motivo: 'sin_telefono',
    });
  });

  it('éxito: llama a fetch con el teléfono del cliente y loguea entregada=true con message_id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message_id: 'wamid-123' }),
    }));

    await notificarEstado(PEDIDO, 'empresa-1');

    expect(repoState.notifLogLlamadas).toHaveLength(1);
    expect(repoState.notifLogLlamadas[0]).toMatchObject({
      tipo: 'pedido_despachado',
      canal: 'whatsapp',
      telefono: '+5493405111111',
      message_id: 'wamid-123',
      entregada: true,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('falla HTTP (resp.ok=false): loguea entregada=false motivo=error_envio y hace console.error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'token vencido' }),
    }));

    await notificarEstado(PEDIDO, 'empresa-1');

    expect(repoState.notifLogLlamadas).toHaveLength(1);
    expect(repoState.notifLogLlamadas[0]).toMatchObject({
      tipo: 'pedido_despachado',
      canal: 'whatsapp',
      entregada: false,
      motivo: 'error_envio',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('excepción en el fetch: loguea entregada=false motivo=excepcion y hace console.error — NO propaga', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    await expect(notificarEstado(PEDIDO, 'empresa-1')).resolves.not.toThrow();

    expect(repoState.notifLogLlamadas).toHaveLength(1);
    expect(repoState.notifLogLlamadas[0]).toMatchObject({
      tipo: 'pedido_despachado',
      canal: 'whatsapp',
      entregada: false,
      motivo: 'excepcion',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
