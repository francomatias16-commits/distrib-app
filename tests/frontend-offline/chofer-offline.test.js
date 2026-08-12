// tests/frontend-offline/chofer-offline.test.js
//
// Cubre frontend/chofer/chofer-offline.js (v3). Foco:
//   - Los tres tipos (entregar, no_entregar, devolucion) suben antes sus
//     imágenes (firma/foto) y DESPUÉS pegan al endpoint principal, en el
//     mismo orden que seguiría el flujo online.
//   - Cualquier rechazo del endpoint principal (400 "no está despachado",
//     "no encontrado", cobro asociado rechazado) es conflicto — nunca
//     reintento ciego. Los fallos de SUBIDA de imagen quedan afuera de
//     ese tratamiento a propósito (siguen siendo errores simples de red).
//   - setEmpresaId es mutable (llega recién con el detalle del remito).
//   - badge.formatoConflicto: título específico según el mensaje del error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarModuloOffline } from '../helpers/cargar-modulo-offline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA = path.resolve(__dirname, '../../frontend/chofer/chofer-offline.js');

function cargar(opciones) {
  return cargarModuloOffline(RUTA, opciones);
}

function fetchSecuencial(respuestas) {
  let i = 0;
  return vi.fn(async (url) => {
    const r = respuestas[i] ?? respuestas[respuestas.length - 1];
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.data,
      _url: url,
    };
  });
}

describe('chofer-offline.js — configuración', () => {
  it('valida los 3 tipos soportados', () => {
    const { outboxOpts } = cargar();
    expect(outboxOpts.validarTipo('entregar')).toBe(true);
    expect(outboxOpts.validarTipo('no_entregar')).toBe(true);
    expect(outboxOpts.validarTipo('devolucion')).toBe(true);
    expect(outboxOpts.validarTipo('venta')).toBe(false);
  });

  it('getEmpresaId es null hasta que setEmpresaId() lo setea (llega con el detalle del remito)', async () => {
    const { outboxOpts, window } = cargar();
    expect(outboxOpts.getEmpresaId()).toBeNull();

    await window.ChoferOffline.init({ getToken: async () => 'tok' });
    window.ChoferOffline.setEmpresaId('empresa-7');
    expect(outboxOpts.getEmpresaId()).toBe('empresa-7');

    window.ChoferOffline.setEmpresaId(undefined);
    expect(outboxOpts.getEmpresaId()).toBeNull();
  });

  it('getContexto usa el getToken pasado a init()', async () => {
    const { outboxOpts, window } = cargar();
    await window.ChoferOffline.init({ getToken: async () => 'tok-del-chofer' });
    await expect(outboxOpts.getContexto()).resolves.toBe('tok-del-chofer');
  });
});

describe('chofer-offline.js — procesarAccion: entregar', () => {
  const payload = {
    pedido_id: 55,
    firma_data_url: 'data:image/png;base64,firma',
    foto_data_url: 'data:image/png;base64,foto',
    receptor: 'Juan Pérez',
    notas_entrega: null,
    cobro: null,
  };

  it('sube firma y foto ANTES del PATCH principal, en ese orden', async () => {
    const fetchMock = fetchSecuencial([
      { status: 200, data: { url: 'https://cdn/firma.png' } },
      { status: 200, data: { url: 'https://cdn/foto.png' } },
      { status: 200, data: { ok: true, pedido_id: 55 } },
    ]);
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    const resultado = await outboxOpts.procesarAccion(
      { tipo: 'entregar', payload, offline_local_id: 'loc-1' },
      'tok-1'
    );

    expect(resultado).toEqual({ ok: true, pedido_id: 55 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/chofer/entrega-foto',
      expect.objectContaining({
        body: JSON.stringify({ imagen_base64: payload.firma_data_url, tipo: 'firma' }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/chofer/entrega-foto',
      expect.objectContaining({
        body: JSON.stringify({ imagen_base64: payload.foto_data_url, tipo: 'foto' }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/chofer/remitos/55/entregar',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          id: 55,
          firma_url: 'https://cdn/firma.png',
          foto_url: 'https://cdn/foto.png',
          receptor: 'Juan Pérez',
          notas_entrega: null,
          cobro: null,
          offline_local_id: 'loc-1',
        }),
      })
    );
  });

  it('400 "El pedido no está despachado" ⇒ conflicto (rechazo evaluado, no error de red)', async () => {
    const fetchMock = fetchSecuencial([
      { status: 200, data: { url: 'f' } },
      { status: 200, data: { url: 'g' } },
      { status: 400, data: { error: 'El pedido no está despachado' } },
    ]);
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(
      outboxOpts.procesarAccion({ tipo: 'entregar', payload, offline_local_id: 'l' }, 'tok-1')
    ).rejects.toMatchObject({
      conflicto: true,
      tipoConflicto: 'rechazado_servidor',
      datosConflicto: { error: 'El pedido no está despachado' },
    });
  });

  it('un fallo al subir la firma es un error simple (no conflicto) — no llega a pegarle al endpoint principal', async () => {
    const fetchMock = fetchSecuencial([
      { status: 500, data: { error: 'Storage caído' } },
    ]);
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    let capturado;
    try {
      await outboxOpts.procesarAccion({ tipo: 'entregar', payload, offline_local_id: 'l' }, 'tok-1');
    } catch (e) {
      capturado = e;
    }
    expect(capturado.conflicto).toBeUndefined();
    expect(capturado.message).toBe('Storage caído');
    expect(fetchMock).toHaveBeenCalledTimes(1); // nunca llegó al PATCH principal
  });

  it('sin firma/foto (data_url ausente) no sube nada y manda firma_url/foto_url null', async () => {
    const fetchMock = fetchSecuencial([{ status: 200, data: { ok: true } }]);
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await outboxOpts.procesarAccion(
      { tipo: 'entregar', payload: { pedido_id: 1 }, offline_local_id: 'l' },
      'tok-1'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1); // fue directo al PATCH
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chofer/remitos/1/entregar',
      expect.objectContaining({
        body: JSON.stringify({
          id: 1,
          firma_url: null,
          foto_url: null,
          receptor: null,
          notas_entrega: null,
          cobro: null,
          offline_local_id: 'l',
        }),
      })
    );
  });
});

describe('chofer-offline.js — procesarAccion: no_entregar', () => {
  it('sube la foto y pega al PATCH de no-entregar', async () => {
    const fetchMock = fetchSecuencial([
      { status: 200, data: { url: 'https://cdn/foto-no-entrega.png' } },
      { status: 200, data: { ok: true } },
    ]);
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await outboxOpts.procesarAccion(
      {
        tipo: 'no_entregar',
        payload: { pedido_id: 8, motivo: 'cerrado', notas: null, foto_data_url: 'data:x' },
        offline_local_id: 'l2',
      },
      'tok-1'
    );

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/chofer/remitos/8/no-entregar',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          id: 8,
          motivo: 'cerrado',
          notas: null,
          foto_url: 'https://cdn/foto-no-entrega.png',
          offline_local_id: 'l2',
        }),
      })
    );
  });

  it('"Pedido no encontrado" ⇒ conflicto', async () => {
    const fetchMock = fetchSecuencial([
      { status: 200, data: { url: 'f' } },
      { status: 404, data: { error: 'Pedido no encontrado' } },
    ]);
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(
      outboxOpts.procesarAccion(
        {
          tipo: 'no_entregar',
          payload: { pedido_id: 8, motivo: 'x', foto_data_url: 'data:x' },
          offline_local_id: 'l',
        },
        'tok-1'
      )
    ).rejects.toMatchObject({ conflicto: true, tipoConflicto: 'rechazado_servidor' });
  });
});

describe('chofer-offline.js — procesarAccion: devolucion', () => {
  it('sube la foto de devolución (endpoint distinto al de entrega/no-entrega) y postea a /api/chofer/devolucion', async () => {
    const fetchMock = fetchSecuencial([
      { status: 200, data: { foto_url: 'https://cdn/devolucion.png' } },
      { status: 200, data: { ok: true } },
    ]);
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await outboxOpts.procesarAccion(
      {
        tipo: 'devolucion',
        payload: { pedido_id: 3, motivo: 'roto', notas: 'se rompió en el viaje', foto_data_url: 'data:y', items: [{ id: 1 }] },
        offline_local_id: 'l3',
      },
      'tok-1'
    );

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/chofer/devolucion-foto', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/chofer/devolucion',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          pedido_id: 3,
          motivo: 'roto',
          notas: 'se rompió en el viaje',
          foto_url: 'https://cdn/devolucion.png',
          items: [{ id: 1 }],
          offline_local_id: 'l3',
        }),
      })
    );
  });

  it('rechazo del cobro asociado (factura ya saldada) ⇒ conflicto', async () => {
    const fetchMock = fetchSecuencial([
      { status: 200, data: { foto_url: 'f' } },
      { status: 409, data: { error: 'La factura ya está saldada' } },
    ]);
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(
      outboxOpts.procesarAccion(
        {
          tipo: 'devolucion',
          payload: { pedido_id: 3, motivo: 'x', foto_data_url: 'data:z' },
          offline_local_id: 'l',
        },
        'tok-1'
      )
    ).rejects.toMatchObject({ conflicto: true, tipoConflicto: 'rechazado_servidor' });
  });
});

describe('chofer-offline.js — procesarAccion: tipo desconocido', () => {
  it('lanza error simple para un tipo no soportado', async () => {
    const { outboxOpts } = cargar();
    await expect(
      outboxOpts.procesarAccion({ tipo: 'otra_cosa', payload: {}, offline_local_id: 'l' }, 'tok-1')
    ).rejects.toThrow(/Tipo de acción offline desconocido: otra_cosa/);
  });
});

describe('chofer-offline.js — badge.formatoConflicto', () => {
  const casos = [
    ['entregar', 'El pedido no está despachado', /el pedido ya no está despachado/],
    ['no_entregar', 'Pedido no encontrado', /el pedido ya no está disponible/],
    ['devolucion', 'Cliente no encontrado', /el cobro asociado fue rechazado/],
    ['entregar', 'Error random del server', /el servidor la rechazó/],
  ];

  it.each(casos)('tipo %s con error "%s" arma el título esperado', (tipo, error, regexTitulo) => {
    const { outboxOpts } = cargar();
    const { titulo, detalle } = outboxOpts.badge.formatoConflicto({
      tipo,
      conflicto_datos: { error },
    });
    expect(titulo).toMatch(regexTitulo);
    expect(detalle).toContain(error);
  });

  it('usa "Acción" como nombre genérico para un tipo no mapeado', () => {
    const { outboxOpts } = cargar();
    const { titulo } = outboxOpts.badge.formatoConflicto({
      tipo: 'tipo_raro',
      conflicto_datos: { error: 'x' },
    });
    expect(titulo).toBe('Acción: el servidor la rechazó');
  });
});

describe('chofer-offline.js — hooks', () => {
  it('onConflicto refresca el remito abierto si está disponible', () => {
    const cargarRemito = vi.fn().mockResolvedValue();
    const { outboxOpts } = cargar({ windowExtra: { cargarRemito } });
    outboxOpts.onConflicto();
    expect(cargarRemito).toHaveBeenCalledTimes(1);
  });

  it('onConflicto no rompe si cargarRemito no está definido', () => {
    const { outboxOpts } = cargar();
    expect(() => outboxOpts.onConflicto()).not.toThrow();
  });
});
