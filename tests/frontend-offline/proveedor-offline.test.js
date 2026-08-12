// tests/frontend-offline/proveedor-offline.test.js
//
// Cubre frontend/proveedor/proveedor-offline.js. Foco:
//   - Los dos tipos (confirmar_entrega, subir_factura) pegan al endpoint
//     correcto con el token vigente y (en subir_factura) el
//     offline_local_id — confirmar_entrega NO lo necesita, es idempotente
//     al reintentar (UPDATE, migración 448 solo cubre facturas_proveedor).
//   - Cualquier rechazo del servidor (!r.ok) es conflicto — nunca reintento
//     ciego (mismo criterio que chofer-offline.js/stock-offline.js).
//   - getEmpresaId() usa el token como clave de scoping (el portal nunca
//     recibe proveedor_id/empresa_id del backend — ver nota en el módulo).
//   - setToken es mutable vía init({ token }).
//   - badge.formatoConflicto: título específico según el mensaje del error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarModuloOffline } from '../helpers/cargar-modulo-offline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA = path.resolve(__dirname, '../../frontend/proveedor/proveedor-offline.js');

function cargar(opciones) {
  return cargarModuloOffline(RUTA, opciones);
}

function fetchMockeado(status, data) {
  return vi.fn(async (url) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    _url: url,
  }));
}

describe('proveedor-offline.js — configuración', () => {
  it('valida los 2 tipos soportados', () => {
    const { outboxOpts } = cargar();
    expect(outboxOpts.validarTipo('confirmar_entrega')).toBe(true);
    expect(outboxOpts.validarTipo('subir_factura')).toBe(true);
    expect(outboxOpts.validarTipo('confirmar-entrega')).toBe(false);
    expect(outboxOpts.validarTipo('otra_cosa')).toBe(false);
  });

  it('getContexto/getEmpresaId son null hasta que init({ token }) los setea', async () => {
    const { outboxOpts, window } = cargar();
    expect(await outboxOpts.getContexto()).toBeNull();
    expect(outboxOpts.getEmpresaId()).toBeNull();

    await window.ProveedorOffline.init({ token: 'tok-abc123' });
    expect(await outboxOpts.getContexto()).toBe('tok-abc123');
    // El token hace las veces de empresa_id — es la única identidad que
    // el portal tiene disponible del lado del cliente (ver nota del módulo).
    expect(outboxOpts.getEmpresaId()).toBe('tok-abc123');
  });

  it('setToken() sola (sin pasar por init) también actualiza el scoping', () => {
    const { outboxOpts, window } = cargar();
    window.ProveedorOffline.setToken('tok-nuevo');
    expect(outboxOpts.getEmpresaId()).toBe('tok-nuevo');
  });
});

describe('proveedor-offline.js — procesarAccion: confirmar_entrega', () => {
  const payload = { orden_id: 'oc-1', fecha_esperada: '2026-08-20' };

  it('pega a confirmar-entrega con el token y el body correcto (sin offline_local_id)', async () => {
    const fetchMock = fetchMockeado(200, { ok: true, orden: { id: 'oc-1' } });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    const resultado = await outboxOpts.procesarAccion(
      { tipo: 'confirmar_entrega', payload, offline_local_id: 'loc-1' },
      'tok-9'
    );

    expect(resultado).toEqual({ ok: true, orden: { id: 'oc-1' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('accion=confirmar-entrega');
    expect(url).toContain('t=tok-9');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ orden_id: 'oc-1', fecha_esperada: '2026-08-20' });
    expect(body.offline_local_id).toBeUndefined();
  });

  it('un rechazo del servidor (OC ya recibida) es conflicto, no error transitorio', async () => {
    const fetchMock = fetchMockeado(400, { error: 'No se puede confirmar fecha en una OC recibida' });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(
      outboxOpts.procesarAccion({ tipo: 'confirmar_entrega', payload, offline_local_id: 'loc-1' }, 'tok-9')
    ).rejects.toMatchObject({
      conflicto: true,
      tipoConflicto: 'rechazado_servidor',
      message: 'No se puede confirmar fecha en una OC recibida',
    });
  });
});

describe('proveedor-offline.js — procesarAccion: subir_factura', () => {
  const payload = {
    orden_id: 'oc-2',
    numero_factura: 'A-0001-00001234',
    fecha_factura: '2026-08-01',
    total: 15000,
    archivo_base64: 'data:application/pdf;base64,AAA',
  };

  it('pega a subir-factura con el token, el body y el offline_local_id', async () => {
    const fetchMock = fetchMockeado(201, { ok: true, factura: { id: 'f-1' } });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    const resultado = await outboxOpts.procesarAccion(
      { tipo: 'subir_factura', payload, offline_local_id: 'loc-2' },
      'tok-9'
    );

    expect(resultado).toEqual({ ok: true, factura: { id: 'f-1' } });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('accion=subir-factura');
    expect(url).toContain('t=tok-9');
    const body = JSON.parse(opts.body);
    expect(body.offline_local_id).toBe('loc-2');
    expect(body.numero_factura).toBe('A-0001-00001234');
  });

  it('factura suelta (sin OC) manda orden_id null', async () => {
    const fetchMock = fetchMockeado(201, { ok: true, factura: { id: 'f-2' } });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await outboxOpts.procesarAccion(
      { tipo: 'subir_factura', payload: { ...payload, orden_id: null }, offline_local_id: 'loc-3' },
      'tok-9'
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.orden_id).toBeNull();
  });

  it('un rechazo del servidor (OC no encontrada) es conflicto, no error transitorio', async () => {
    const fetchMock = fetchMockeado(404, { error: 'Orden de compra no encontrada' });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(
      outboxOpts.procesarAccion({ tipo: 'subir_factura', payload, offline_local_id: 'loc-2' }, 'tok-9')
    ).rejects.toMatchObject({ conflicto: true, message: 'Orden de compra no encontrada' });
  });

  it('tipo desconocido lanza sin llegar a fetch', async () => {
    const fetchMock = fetchMockeado(200, {});
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(
      outboxOpts.procesarAccion({ tipo: 'lo_que_sea', payload: {}, offline_local_id: 'x' }, 'tok-9')
    ).rejects.toThrow('Tipo de acción offline desconocido');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('proveedor-offline.js — badge.formatoConflicto', () => {
  it('OC ya no admite cambios de fecha (mensaje "no se puede confirmar fecha")', () => {
    const { outboxOpts } = cargar();
    const { titulo } = outboxOpts.badge.formatoConflicto({
      tipo: 'confirmar_entrega',
      conflicto_datos: { error: 'No se puede confirmar fecha en una OC recibida' },
    });
    expect(titulo).toBe('Confirmación de fecha: la orden ya no admite cambios de fecha');
  });

  it('OC ya no disponible (mensaje "orden de compra no encontrada")', () => {
    const { outboxOpts } = cargar();
    const { titulo } = outboxOpts.badge.formatoConflicto({
      tipo: 'subir_factura',
      conflicto_datos: { error: 'Orden de compra no encontrada' },
    });
    expect(titulo).toBe('Carga de factura: la orden ya no está disponible');
  });

  it('mensaje genérico cuando no matchea ningún patrón conocido', () => {
    const { outboxOpts } = cargar();
    const { titulo, detalle } = outboxOpts.badge.formatoConflicto({
      tipo: 'subir_factura',
      conflicto_datos: { error: 'Error inesperado' },
    });
    expect(titulo).toBe('Carga de factura: el servidor la rechazó');
    expect(detalle).toContain('Error inesperado');
  });
});

describe('proveedor-offline.js — hooks', () => {
  it('onConflicto y onSincronizado llaman a window.cargarDatos si existe', async () => {
    const cargarDatos = vi.fn(async () => {});
    const { outboxOpts } = cargar({ windowExtra: { cargarDatos } });

    outboxOpts.onConflicto();
    outboxOpts.onSincronizado(1);

    expect(cargarDatos).toHaveBeenCalledTimes(2);
  });

  it('no rompe si window.cargarDatos no está definido', () => {
    const { outboxOpts } = cargar();
    expect(() => outboxOpts.onConflicto()).not.toThrow();
    expect(() => outboxOpts.onSincronizado(1)).not.toThrow();
  });
});
