// tests/handlers/cierre-notif-vencimiento.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🟡 #11, resuelto en v957.
// `procesarNotifVencimiento` (lib/handlers/cierre.js — recordatorio de
// deuda por WhatsApp) tenía un `.catch(() => {})` que tragaba cualquier
// error del fetch a `/api/notif/whatsapp` sin dejar ningún rastro, a
// diferencia de prácticamente cualquier otro disparo de WhatsApp del repo
// (que como mínimo hacen `console.error`, y varios además loguean en
// `notif_log`).
//
// v957 agregó: chequeo de `resp.ok`, log de éxito/falla vía
// `NotifRepo.registrarLog` (tipo `recordatorio_vencimiento`, canal
// `whatsapp`) y `console.error` en caso de falla o excepción. Este test
// fija ese contrato para las 3 ramas: éxito, falla HTTP (resp.ok=false) y
// excepción (fetch rechaza).

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const repoState = vi.hoisted(() => ({
  cliente: { telefono: '+5491111111111', email: 'cliente@test.com', razon_social: 'Cliente Uno SA' },
  deuda: 1000,
  notifLogLlamadas: [],
}));

vi.mock('../../lib/repos/cierre.js', () => ({
  obtenerTareasColaFinanciera: vi.fn(),
  marcarTareaProcesando: vi.fn().mockResolvedValue(null),
  marcarTareaCompletada: vi.fn().mockResolvedValue(null),
  marcarTareaConError: vi.fn().mockResolvedValue(null),
  obtenerClienteParaNotifVencimiento: vi.fn(() => Promise.resolve(repoState.cliente)),
  obtenerFacturasVencidasSinNotificar: vi.fn().mockResolvedValue([]),
  encolarTareaBloqueo: vi.fn(),
  marcarFacturaNotif15dEnviada: vi.fn(),
  bloquearCliente: vi.fn(),
  upsertBloqueoCliente: vi.fn(),
  obtenerFacturaPorPedido: vi.fn(),
  obtenerPedidoParaFacturacion: vi.fn(),
  obtenerFacturacionConfigActiva: vi.fn(),
  actualizarFechaVencimientoFactura: vi.fn(),
}));

vi.mock('../../lib/repos/cta-cte.js', () => ({
  obtenerUltimoSaldo: vi.fn(() => Promise.resolve(repoState.deuda)),
  insertarMovimiento: vi.fn(),
  listarMovimientosPorCliente: vi.fn(),
}));

vi.mock('../../lib/repos/notif.js', () => ({
  registrarLog: vi.fn((payload) => {
    repoState.notifLogLlamadas.push(payload);
    return Promise.resolve(null);
  }),
}));

vi.mock('../../lib/repos/pagos.js', () => ({ registrarCobroCompletoRpc: vi.fn() }));
vi.mock('../../lib/facturas.js', () => ({ emitirFactura: vi.fn() }));
vi.mock('../../lib/supabase-lazy.js', () => ({ crearClienteSupabaseLazy: () => ({}) }));
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: vi.fn() }));
vi.mock('../../lib/security-headers.js', () => ({ aplicarHeaders: vi.fn() }));
vi.mock('../../lib/handlers/_auto-push.js', () => ({ notifAuto: vi.fn().mockResolvedValue(null) }));
vi.mock('../../lib/email.js', () => ({ enviarEmail: vi.fn().mockResolvedValue(null) }));
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => vi.fn().mockResolvedValue(false) }));

const { procesarColaFinancieraEmpresa } = await import('../../lib/handlers/cierre.js');
const { obtenerTareasColaFinanciera } = await import('../../lib/repos/cierre.js');

function tareaNotifVencimiento() {
  return {
    id: 'tarea-1',
    empresa_id: 'empresa-1',
    tipo: 'notif_vencimiento',
    referencia_id: 'cliente-1',
    intentos: 0,
    payload: { dias_vencimiento: 15 },
  };
}

let consoleErrorSpy;

beforeEach(() => {
  repoState.notifLogLlamadas = [];
  repoState.deuda = 1000;
  obtenerTareasColaFinanciera.mockResolvedValue([tareaNotifVencimiento()]);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('procesarNotifVencimiento — regresión hallazgo #11 (silencio total en fallo de WhatsApp)', () => {
  it('éxito: registra en notif_log con entregada=true, sin console.error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    }));

    await procesarColaFinancieraEmpresa('empresa-1');

    expect(repoState.notifLogLlamadas).toHaveLength(1);
    expect(repoState.notifLogLlamadas[0]).toMatchObject({
      tipo: 'recordatorio_vencimiento',
      canal: 'whatsapp',
      entregada: true,
      motivo: null,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('falla HTTP (resp.ok=false): loguea en notif_log con entregada=false y hace console.error — NO se traga el error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'token vencido' }),
    }));

    await procesarColaFinancieraEmpresa('empresa-1');

    expect(repoState.notifLogLlamadas).toHaveLength(1);
    expect(repoState.notifLogLlamadas[0]).toMatchObject({
      tipo: 'recordatorio_vencimiento',
      canal: 'whatsapp',
      entregada: false,
      motivo: 'error_envio',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('excepción en el fetch: loguea en notif_log con entregada=false, motivo=excepcion y hace console.error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    await procesarColaFinancieraEmpresa('empresa-1');

    expect(repoState.notifLogLlamadas).toHaveLength(1);
    expect(repoState.notifLogLlamadas[0]).toMatchObject({
      tipo: 'recordatorio_vencimiento',
      canal: 'whatsapp',
      entregada: false,
      motivo: 'excepcion',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
