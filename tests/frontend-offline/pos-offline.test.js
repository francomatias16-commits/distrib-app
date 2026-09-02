// tests/frontend-offline/pos-offline.test.js
//
// Cubre frontend/admin/js/pos-offline.js (v3). Foco:
//   - v2 tomaba cualquier 409 como "duplicado, ya sincronizado" — bug real
//     corregido en v3: ahora todo 4xx es conflicto real (con `data.tipo`
//     como stock_insuficiente/turno_cerrado/etc.), y un 5xx sigue el
//     camino normal de reintento (no conflicto).
//   - cachearProductos/buscarProductosLocal (caché de solo lectura, sin
//     pasar por el outbox).
//   - Migración one-shot desde pos_offline_db v1 (IndexedDB manual) antes
//     de que OfflineCore abra la DB en la versión nueva.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarModuloOffline } from '../helpers/cargar-modulo-offline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA = path.resolve(__dirname, '../../frontend/admin/js/pos-offline.js');

function cargar(opciones) {
  return cargarModuloOffline(RUTA, opciones);
}

function fetchConRespuesta(status, data) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }));
}

// Fake mínimo de IndexedDB para la migración one-shot v1 → OfflineCore.
// Simula un navegador con 'pos_offline_db' v2 conteniendo N ventas
// pendientes en el store legacy 'ventas_pendientes'.
function fakeIndexedDBConVentas(ventasPendientes) {
  return {
    databases: async () => [{ name: 'pos_offline_db', version: 2 }],
    open: () => {
      const req = {};
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: (s) => s === 'ventas_pendientes' },
          transaction: () => ({
            objectStore: () => ({
              getAll: () => {
                const r = {};
                setTimeout(() => {
                  r.result = ventasPendientes;
                  if (r.onsuccess) r.onsuccess();
                }, 0);
                return r;
              },
              clear: () => {
                const r = {};
                setTimeout(() => {
                  if (r.onsuccess) r.onsuccess();
                }, 0);
                return r;
              },
            }),
          }),
          close: vi.fn(),
        };
        req.result = db;
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
  };
}

function fakeIndexedDBSinDbVieja() {
  return {
    databases: async () => [],
    open: () => {
      throw new Error('no debería abrir la DB vieja si databases() no la lista');
    },
  };
}

describe('pos-offline.js — configuración', () => {
  it('valida únicamente el tipo venta', () => {
    const { outboxOpts } = cargar();
    expect(outboxOpts.validarTipo('venta')).toBe(true);
    expect(outboxOpts.validarTipo('pedido')).toBe(false);
  });

  it('getEmpresaId lee window.authCtx.perfil.empresa_id', () => {
    const { outboxOpts } = cargar({
      windowExtra: { authCtx: { perfil: { empresa_id: 'empresa-3' } } },
    });
    expect(outboxOpts.getEmpresaId()).toBe('empresa-3');
  });

  it('getContexto lee window.authCtx.session.access_token', () => {
    const { outboxOpts } = cargar({
      windowExtra: { authCtx: { session: { access_token: 'tok-pos' } } },
    });
    expect(outboxOpts.getContexto()).toBe('tok-pos');
  });

  it('getContexto es null sin sesión', () => {
    const { outboxOpts } = cargar();
    expect(outboxOpts.getContexto()).toBeNull();
  });
});

describe('pos-offline.js — procesarAccion', () => {
  const accion = { payload: { total: 5000 }, offline_local_id: 'loc-1' };

  it('éxito (incluido ya_existia:true del dedup) devuelve el data del servidor', async () => {
    const fetchMock = fetchConRespuesta(200, { ok: true, venta_id: 9, ya_existia: true });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(outboxOpts.procesarAccion(accion, 'tok-1')).resolves.toEqual({
      ok: true,
      venta_id: 9,
      ya_existia: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pos',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ total: 5000, offline_local_id: 'loc-1' }),
      })
    );
  });

  it.each([
    [409, 'stock_insuficiente'],
    [409, 'turno_cerrado'],
    [400, 'pagos_no_coinciden'],
    [402, 'limite_credito'],
    [422, 'cliente_requerido'],
  ])('4xx (%d) con data.tipo=%s marca conflicto usando ese tipo', async (status, tipo) => {
    const fetchMock = fetchConRespuesta(status, { error: `rechazo: ${tipo}`, tipo });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(outboxOpts.procesarAccion(accion, 'tok-1')).rejects.toMatchObject({
      conflicto: true,
      tipoConflicto: tipo,
      datosConflicto: { error: `rechazo: ${tipo}`, tipo },
    });
  });

  it('4xx sin data.tipo cae en rechazado_servidor', async () => {
    const fetchMock = fetchConRespuesta(418, { error: 'algo raro' });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(outboxOpts.procesarAccion(accion, 'tok-1')).rejects.toMatchObject({
      conflicto: true,
      tipoConflicto: 'rechazado_servidor',
    });
  });

  it('5xx NO marca conflicto — sigue el camino normal de reintento', async () => {
    const fetchMock = fetchConRespuesta(500, { error: 'Error interno' });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    let capturado;
    try {
      await outboxOpts.procesarAccion(accion, 'tok-1');
    } catch (e) {
      capturado = e;
    }
    expect(capturado.conflicto).toBeUndefined();
    expect(capturado.message).toBe('Error interno');
  });
});

describe('pos-offline.js — badge.formatoConflicto', () => {
  const casos = [
    ['stock_insuficiente', 'Venta rechazada: no hay stock suficiente'],
    ['turno_cerrado', 'Venta rechazada: el turno de caja ya está cerrado'],
    ['pagos_no_coinciden', 'Venta rechazada: los pagos no coinciden con el total'],
    ['limite_credito', 'Venta rechazada: supera el límite de crédito del cliente'],
    ['cliente_requerido', 'Venta rechazada: falta elegir un cliente para cuenta corriente'],
  ];

  it.each(casos)('conflicto_tipo=%s arma el título esperado', (conflictoTipo, tituloEsperado) => {
    const { outboxOpts } = cargar();
    const { titulo, detalle } = outboxOpts.badge.formatoConflicto({
      conflicto_tipo: conflictoTipo,
      conflicto_datos: { error: 'detalle del rechazo' },
    });
    expect(titulo).toBe(tituloEsperado);
    expect(detalle).toContain('detalle del rechazo');
  });

  it('usa título genérico para un conflicto_tipo no mapeado', () => {
    const { outboxOpts } = cargar();
    const { titulo } = outboxOpts.badge.formatoConflicto({
      conflicto_tipo: 'algo_no_mapeado',
      conflicto_datos: {},
    });
    expect(titulo).toBe('Venta rechazada por el servidor');
  });
});

describe('pos-offline.js — caché de productos', () => {
  it('buscarProductosLocal sin término devuelve los primeros 20 activos', async () => {
    const { window, cacheFake } = cargar();
    const productos = Array.from({ length: 25 }, (_, i) => ({
      id: i,
      nombre: `Producto ${i}`,
      activo: true,
    }));
    cacheFake.todosVigentes.mockResolvedValue(productos);

    const resultado = await window.PosOffline.buscarProductosLocal('');
    expect(resultado).toHaveLength(20);
  });

  it('buscarProductosLocal filtra inactivos', async () => {
    const { window, cacheFake } = cargar();
    cacheFake.todosVigentes.mockResolvedValue([
      { id: 1, nombre: 'Coca Cola', activo: true },
      { id: 2, nombre: 'Producto viejo', activo: false },
    ]);

    const resultado = await window.PosOffline.buscarProductosLocal('');
    expect(resultado).toEqual([{ id: 1, nombre: 'Coca Cola', activo: true }]);
  });

  it('buscarProductosLocal con término busca por nombre/código/código de barras', async () => {
    const { window, cacheFake } = cargar();
    cacheFake.todosVigentes.mockResolvedValue([
      { id: 1, nombre: 'Coca Cola 500ml', codigo: 'COC500', codigo_barras: '7791234' },
      { id: 2, nombre: 'Sprite', codigo: 'SPR500', codigo_barras: '7795678' },
    ]);

    const resultado = await window.PosOffline.buscarProductosLocal('coca');
    expect(resultado).toEqual([
      { id: 1, nombre: 'Coca Cola 500ml', codigo: 'COC500', codigo_barras: '7791234' },
    ]);
  });

  it('buscarProductosLocal con término de 1 carácter se ignora (vuelve al top-20)', async () => {
    const { window, cacheFake } = cargar();
    cacheFake.todosVigentes.mockResolvedValue([{ id: 1, nombre: 'X', activo: true }]);

    const resultado = await window.PosOffline.buscarProductosLocal('x');
    expect(resultado).toHaveLength(1);
  });

  it('sin productos vigentes devuelve array vacío', async () => {
    const { window, cacheFake } = cargar();
    cacheFake.todosVigentes.mockResolvedValue([]);
    await expect(window.PosOffline.buscarProductosLocal('algo')).resolves.toEqual([]);
  });
});

describe('pos-offline.js — migración one-shot desde pos_offline_db v1', () => {
  it('migra las ventas pendientes de v1 al outbox nuevo y vacía la cola vieja', async () => {
    const indexedDB = fakeIndexedDBConVentas([
      { estado: 'pendiente', body: { total: 100 } },
      { estado: 'pendiente', body: { total: 200 } },
      { estado: 'sincronizado', body: { total: 300 } }, // no se migra
    ]);
    const { window, outboxFake } = cargar({ windowExtra: { indexedDB } });

    await window.PosOffline.init();

    expect(outboxFake.encolarLegacySinTenant).toHaveBeenCalledTimes(2);
    expect(outboxFake.encolarLegacySinTenant).toHaveBeenNthCalledWith(1, 'venta', { total: 100 }, 'pos_offline_db_v1');
    expect(outboxFake.encolarLegacySinTenant).toHaveBeenNthCalledWith(2, 'venta', { total: 200 }, 'pos_offline_db_v1');
    expect(outboxFake.encolarAccion).not.toHaveBeenCalled();
    expect(outboxFake.init).toHaveBeenCalledTimes(1);
  });

  it('sin pos_offline_db v1 en el navegador, init no rompe y no migra nada', async () => {
    const indexedDB = fakeIndexedDBSinDbVieja();
    const { window, outboxFake } = cargar({ windowExtra: { indexedDB } });

    await window.PosOffline.init();

    expect(outboxFake.encolarAccion).not.toHaveBeenCalled();
    expect(outboxFake.init).toHaveBeenCalledTimes(1);
  });

  it('sin indexedDB.databases disponible (navegador viejo), init es best-effort y no rompe', async () => {
    // No se pasa windowExtra.indexedDB — queda undefined, como un entorno
    // sin IndexedDB expuesto de la forma esperada.
    const { window, outboxFake } = cargar();

    await expect(window.PosOffline.init()).resolves.toBeUndefined();
    expect(outboxFake.encolarAccion).not.toHaveBeenCalled();
    expect(outboxFake.init).toHaveBeenCalledTimes(1);
  });
});

describe('pos-offline.js — hooks', () => {
  it('onConflicto refresca el listado de ventas si está disponible', () => {
    const cargarVentas = vi.fn().mockResolvedValue();
    const { outboxOpts } = cargar({ windowExtra: { cargarVentas } });
    outboxOpts.onConflicto();
    expect(cargarVentas).toHaveBeenCalledTimes(1);
  });

  it('onConflicto no rompe si cargarVentas no está definido', () => {
    const { outboxOpts } = cargar();
    expect(() => outboxOpts.onConflicto()).not.toThrow();
  });

  it('mensajes.sincronizado usa singular/plural (genérico venta/factura desde v4 — Etapa 5)', () => {
    const { outboxOpts } = cargar();
    expect(outboxOpts.mensajes.sincronizado(1)).toBe('1 pendiente offline (venta o factura) sincronizado con el servidor.');
    expect(outboxOpts.mensajes.sincronizado(3)).toBe('3 pendientes offline (ventas y/o facturas) sincronizados.');
  });
});
