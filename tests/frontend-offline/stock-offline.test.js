// tests/frontend-offline/stock-offline.test.js
//
// Cubre frontend/admin/js/stock-offline.js (v3). Foco:
//   - Los 3 tipos válidos (ajustar_stock, registrar_conteo_stock,
//     transferir_stock) resuelven a su RPC correspondiente.
//   - ok:false ⇒ conflicto; caso especial conflicto_stock_cambio (con
//     `data.tipo`) vs rechazado_servidor genérico.
//   - armarPayloadReintento pisa p_stock_sistema_esperado con el valor
//     actual SOLO para conflicto_stock_cambio.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarModuloOffline } from '../helpers/cargar-modulo-offline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA = path.resolve(__dirname, '../../frontend/admin/js/stock-offline.js');

function cargar(opciones) {
  return cargarModuloOffline(RUTA, opciones);
}

function sbConRpc(impl) {
  return { rpc: vi.fn(impl) };
}

describe('stock-offline.js — configuración', () => {
  it('valida los 3 tipos soportados y rechaza cualquier otro', () => {
    const { outboxOpts } = cargar();
    expect(outboxOpts.validarTipo('ajustar_stock')).toBe(true);
    expect(outboxOpts.validarTipo('registrar_conteo_stock')).toBe(true);
    expect(outboxOpts.validarTipo('transferir_stock')).toBe(true);
    expect(outboxOpts.validarTipo('producir_con_insumos')).toBe(false);
    expect(outboxOpts.validarTipo('venta')).toBe(false);
  });
});

describe('stock-offline.js — procesarAccion', () => {
  it.each([
    ['ajustar_stock', 'ajustar_stock'],
    ['registrar_conteo_stock', 'registrar_conteo_stock'],
    ['transferir_stock', 'transferir_stock'],
  ])('tipo %s llama la RPC %s con p_offline_local_id', async (tipo, nombreRpc) => {
    const sb = sbConRpc(async () => ({ data: { ok: true }, error: null }));
    const { outboxOpts } = cargar();

    await outboxOpts.procesarAccion(
      { tipo, payload: { p_deposito_id: 1 }, offline_local_id: 'loc-9' },
      sb
    );

    expect(sb.rpc).toHaveBeenCalledWith(nombreRpc, {
      p_deposito_id: 1,
      p_offline_local_id: 'loc-9',
    });
  });

  it('error real de sb.rpc no marca conflicto', async () => {
    const errorDeRed = new Error('sin conexión con supabase');
    const sb = sbConRpc(async () => ({ data: null, error: errorDeRed }));
    const { outboxOpts } = cargar();

    let capturado;
    try {
      await outboxOpts.procesarAccion({ tipo: 'ajustar_stock', payload: {}, offline_local_id: 'l' }, sb);
    } catch (e) {
      capturado = e;
    }
    expect(capturado).toBe(errorDeRed);
    expect(capturado.conflicto).toBeUndefined();
  });

  it('ok:false con tipo conflicto_stock_cambio marca ese tipo y guarda esperado/actual', async () => {
    const sb = sbConRpc(async () => ({
      data: {
        ok: false,
        tipo: 'conflicto_stock_cambio',
        error: 'El stock cambió',
        stock_sistema_esperado: 10,
        stock_sistema_actual: 7,
      },
      error: null,
    }));
    const { outboxOpts } = cargar();

    await expect(
      outboxOpts.procesarAccion({ tipo: 'registrar_conteo_stock', payload: {}, offline_local_id: 'l' }, sb)
    ).rejects.toMatchObject({
      conflicto: true,
      tipoConflicto: 'conflicto_stock_cambio',
      datosConflicto: {
        error: 'El stock cambió',
        stock_sistema_esperado: 10,
        stock_sistema_actual: 7,
      },
    });
  });

  it('ok:false sin ese tipo especial cae en rechazado_servidor', async () => {
    const sb = sbConRpc(async () => ({
      data: { ok: false, error: 'Depósito no existe' },
      error: null,
    }));
    const { outboxOpts } = cargar();

    await expect(
      outboxOpts.procesarAccion({ tipo: 'ajustar_stock', payload: {}, offline_local_id: 'l' }, sb)
    ).rejects.toMatchObject({ conflicto: true, tipoConflicto: 'rechazado_servidor' });
  });
});

describe('stock-offline.js — badge.formatoConflicto', () => {
  const { outboxOpts } = cargar();

  it('mensaje especial de esperado/actual para conflicto_stock_cambio', () => {
    const { titulo, detalle } = outboxOpts.badge.formatoConflicto({
      tipo: 'registrar_conteo_stock',
      conflicto_tipo: 'conflicto_stock_cambio',
      conflicto_datos: { stock_sistema_esperado: 10, stock_sistema_actual: 7 },
    });
    expect(titulo).toContain('Conteo físico');
    expect(titulo).toContain('el stock cambió');
    expect(detalle).toContain('esperaba 10');
    expect(detalle).toContain('ahora tiene 7');
  });

  it('mensaje genérico de rechazo para otros tipos, usando el nombre por tipo de movimiento', () => {
    const { titulo, detalle } = outboxOpts.badge.formatoConflicto({
      tipo: 'transferir_stock',
      conflicto_tipo: 'rechazado_servidor',
      conflicto_datos: { error: 'Depósito destino inactivo' },
    });
    expect(titulo).toBe('Transferencia entre depósitos: el servidor lo rechazó');
    expect(detalle).toContain('Depósito destino inactivo');
  });
});

describe('stock-offline.js — armarPayloadReintento', () => {
  const { outboxOpts } = cargar();

  it('pisa p_stock_sistema_esperado con el actual en conflicto_stock_cambio', () => {
    const payload = outboxOpts.badge.armarPayloadReintento({
      conflicto_tipo: 'conflicto_stock_cambio',
      conflicto_datos: { stock_sistema_actual: 7 },
    });
    expect(payload).toEqual({ p_stock_sistema_esperado: 7 });
  });

  it('no pisa nada para otros tipos de conflicto', () => {
    const payload = outboxOpts.badge.armarPayloadReintento({
      conflicto_tipo: 'rechazado_servidor',
      conflicto_datos: { error: 'x' },
    });
    expect(payload).toEqual({});
  });
});

describe('stock-offline.js — hooks', () => {
  it('onConflicto y onSincronizado refrescan la tabla de stock si está disponible', () => {
    const cargarStock = vi.fn().mockResolvedValue();
    const { outboxOpts } = cargar({ windowExtra: { cargarStock } });
    outboxOpts.onConflicto();
    outboxOpts.onSincronizado(2);
    expect(cargarStock).toHaveBeenCalledTimes(2);
  });

  it('no rompen si cargarStock no está definido', () => {
    const { outboxOpts } = cargar();
    expect(() => outboxOpts.onConflicto()).not.toThrow();
    expect(() => outboxOpts.onSincronizado(1)).not.toThrow();
  });
});
