// tests/frontend-offline/cobros-offline.test.js
//
// Cubre frontend/admin/js/cobros-offline.js (v3 — el módulo que llegó a
// v651 todavía en v2, sin tratamiento de conflicto). Foco:
//   - RPC registrar_cobro_completo con ok:false ⇒ conflicto (no reintenta
//     a ciegas), con error real de sb.rpc ⇒ error transitorio normal.
//   - Alerta post-sync "saldo a favor" (best-effort, no debe tirar el
//     cobro ya sincronizado si calcular_deuda_cliente falla).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarModuloOffline } from '../helpers/cargar-modulo-offline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA = path.resolve(__dirname, '../../frontend/admin/js/cobros-offline.js');

function cargar(opciones) {
  return cargarModuloOffline(RUTA, opciones);
}

function sbConRpc(impl) {
  return { rpc: vi.fn(impl) };
}

describe('cobros-offline.js — configuración del outbox', () => {
  it('valida únicamente el tipo registrar_cobro_completo', () => {
    const { outboxOpts } = cargar();
    expect(outboxOpts.validarTipo('registrar_cobro_completo')).toBe(true);
    expect(outboxOpts.validarTipo('ajustar_stock')).toBe(false);
  });

  it('getEmpresaId lee window.authCtx.perfil.empresa_id', () => {
    const { outboxOpts } = cargar({
      windowExtra: { authCtx: { perfil: { empresa_id: 'empresa-9' } } },
    });
    expect(outboxOpts.getEmpresaId()).toBe('empresa-9');
  });
});

describe('cobros-offline.js — procesarAccion', () => {
  const payload = { p_cliente_id: 5, p_monto: 1000 };

  it('ok:false marca conflicto con el mensaje de la RPC', async () => {
    const sb = sbConRpc(async (nombre) => {
      if (nombre === 'registrar_cobro_completo') {
        return { data: { ok: false, error: 'La factura ya está saldada' }, error: null };
      }
      throw new Error('no debería llamar otra RPC si el cobro fue rechazado');
    });
    const { outboxOpts } = cargar();

    await expect(
      outboxOpts.procesarAccion({ payload, offline_local_id: 'loc-1' }, sb)
    ).rejects.toMatchObject({
      conflicto: true,
      tipoConflicto: 'rechazado_servidor',
      datosConflicto: { error: 'La factura ya está saldada' },
    });
  });

  it('un error real de sb.rpc (red/timeout) NO marca conflicto', async () => {
    const errorDeRed = new Error('timeout de red');
    const sb = sbConRpc(async () => ({ data: null, error: errorDeRed }));
    const { outboxOpts } = cargar();

    let capturado;
    try {
      await outboxOpts.procesarAccion({ payload, offline_local_id: 'loc-1' }, sb);
    } catch (e) {
      capturado = e;
    }
    expect(capturado).toBe(errorDeRed);
    expect(capturado.conflicto).toBeUndefined();
  });

  it('éxito sin saldo a favor: no llama a mostrarToast', async () => {
    const sb = sbConRpc(async (nombre) => {
      if (nombre === 'registrar_cobro_completo') return { data: { ok: true, nro: 'C-001' }, error: null };
      if (nombre === 'calcular_deuda_cliente') return { data: 250, error: null };
      throw new Error('RPC inesperada: ' + nombre);
    });
    const mostrarToast = vi.fn();
    const { outboxOpts } = cargar({ windowExtra: { mostrarToast } });

    const data = await outboxOpts.procesarAccion({ payload, offline_local_id: 'loc-1' }, sb);
    expect(data).toEqual({ ok: true, nro: 'C-001' });
    expect(mostrarToast).not.toHaveBeenCalled();
  });

  it('éxito con saldo a favor (deuda negativa): avisa por mostrarToast', async () => {
    const sb = sbConRpc(async (nombre) => {
      if (nombre === 'registrar_cobro_completo') return { data: { ok: true, nro: 'C-002' }, error: null };
      if (nombre === 'calcular_deuda_cliente') return { data: -300, error: null };
      throw new Error('RPC inesperada: ' + nombre);
    });
    const mostrarToast = vi.fn();
    const { outboxOpts } = cargar({ windowExtra: { mostrarToast } });

    await outboxOpts.procesarAccion({ payload, offline_local_id: 'loc-1' }, sb);
    expect(mostrarToast).toHaveBeenCalledWith(
      expect.stringMatching(/C-002.*saldo a favor de \$300\.00/s),
      'warning',
      8000
    );
  });

  it('si calcular_deuda_cliente falla, el cobro ya sincronizado no se pierde (best-effort)', async () => {
    const sb = sbConRpc(async (nombre) => {
      if (nombre === 'registrar_cobro_completo') return { data: { ok: true, nro: 'C-003' }, error: null };
      if (nombre === 'calcular_deuda_cliente') throw new Error('la vista falló');
      throw new Error('RPC inesperada: ' + nombre);
    });
    const { outboxOpts } = cargar();

    await expect(
      outboxOpts.procesarAccion({ payload, offline_local_id: 'loc-1' }, sb)
    ).resolves.toEqual({ ok: true, nro: 'C-003' });
  });
});

describe('cobros-offline.js — badge.formatoConflicto', () => {
  it('usa el error de la RPC en el detalle', () => {
    const { outboxOpts } = cargar();
    const { titulo, detalle } = outboxOpts.badge.formatoConflicto({
      conflicto_datos: { error: 'Cliente inexistente' },
    });
    expect(titulo).toBe('Cobro rechazado por el servidor');
    expect(detalle).toContain('Cliente inexistente');
  });
});

describe('cobros-offline.js — hooks', () => {
  it('onConflicto refresca cta-cte si está disponible', () => {
    const cargarCtaCte = vi.fn().mockResolvedValue();
    const { outboxOpts } = cargar({ windowExtra: { cargarCtaCte } });
    outboxOpts.onConflicto();
    expect(cargarCtaCte).toHaveBeenCalledTimes(1);
  });

  it('onSincronizado refresca cta-cte, invalida cobranza priorizada y refresca KPIs', () => {
    const cargarCtaCte = vi.fn().mockResolvedValue();
    const invalidarCobranzaPriorizada = vi.fn();
    const refrescarKPIsCobranzas = vi.fn();
    const { outboxOpts } = cargar({
      windowExtra: { cargarCtaCte, invalidarCobranzaPriorizada, refrescarKPIsCobranzas },
    });
    outboxOpts.onSincronizado(2);
    expect(cargarCtaCte).toHaveBeenCalledTimes(1);
    expect(invalidarCobranzaPriorizada).toHaveBeenCalledTimes(1);
    expect(refrescarKPIsCobranzas).toHaveBeenCalledTimes(1);
  });

  it('los hooks no rompen si ninguna de esas funciones está definida', () => {
    const { outboxOpts } = cargar();
    expect(() => outboxOpts.onConflicto()).not.toThrow();
    expect(() => outboxOpts.onSincronizado(1)).not.toThrow();
  });
});
