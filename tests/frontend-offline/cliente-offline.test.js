// tests/frontend-offline/cliente-offline.test.js
//
// Cubre frontend/cliente/cliente-offline.js (v3). Foco:
//   - prepararRegistro exige idempotency_key (Etapa 3, "Hallazgo 3").
//   - POST /api/pedidos?accion=confirmar con 409 + tipo:'stock_insuficiente'
//     ⇒ conflicto; cualquier otro !ok ⇒ error transitorio normal.
//   - onSincronizado usa mostrarToast si está, alert() si no.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarModuloOffline } from '../helpers/cargar-modulo-offline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA = path.resolve(__dirname, '../../frontend/cliente/cliente-offline.js');

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

describe('cliente-offline.js — configuración del outbox', () => {
  it('valida únicamente el tipo pedido', () => {
    const { outboxOpts } = cargar();
    expect(outboxOpts.validarTipo('pedido')).toBe(true);
    expect(outboxOpts.validarTipo('venta')).toBe(false);
  });

  it('prepararRegistro exige idempotency_key', () => {
    const { outboxOpts } = cargar();
    // Es sync (no async) — lanza directo, no devuelve una promesa rechazada.
    expect(() => outboxOpts.prepararRegistro('pedido', { items: [] })).toThrow(
      /idempotency_key/
    );
    expect(
      outboxOpts.prepararRegistro('pedido', { items: [], idempotency_key: 'abc' })
    ).toEqual({});
  });
});

describe('cliente-offline.js — procesarAccion', () => {
  const payload = { items: [{ producto_id: 1, cantidad: 2 }], idempotency_key: 'k-1' };

  it('409 + tipo stock_insuficiente marca conflicto', async () => {
    const fetchMock = fetchConRespuesta(409, {
      tipo: 'stock_insuficiente',
      error: 'No hay stock suficiente de Producto X',
    });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(
      outboxOpts.procesarAccion({ payload }, 'token-1')
    ).rejects.toMatchObject({
      conflicto: true,
      tipoConflicto: 'stock_insuficiente',
      datosConflicto: { error: 'No hay stock suficiente de Producto X' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pedidos?accion=confirmar',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      })
    );
  });

  it('409 sin tipo stock_insuficiente NO marca conflicto (error transitorio normal)', async () => {
    const fetchMock = fetchConRespuesta(409, { error: 'Conflicto genérico' });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    let capturado;
    try {
      await outboxOpts.procesarAccion({ payload }, 'token-1');
    } catch (e) {
      capturado = e;
    }
    expect(capturado.conflicto).toBeUndefined();
    expect(capturado.message).toBe('Conflicto genérico');
  });

  it('500 no marca conflicto, sigue el camino de reintento', async () => {
    const fetchMock = fetchConRespuesta(500, {});
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    let capturado;
    try {
      await outboxOpts.procesarAccion({ payload }, 'token-1');
    } catch (e) {
      capturado = e;
    }
    expect(capturado.conflicto).toBeUndefined();
    expect(capturado.message).toBe('HTTP 500');
  });

  it('éxito devuelve el data del servidor', async () => {
    const fetchMock = fetchConRespuesta(200, { ok: true, pedido_id: 42 });
    const { outboxOpts } = cargar({ windowExtra: { fetch: fetchMock } });

    await expect(
      outboxOpts.procesarAccion({ payload }, 'token-1')
    ).resolves.toEqual({ ok: true, pedido_id: 42 });
  });
});

describe('cliente-offline.js — badge.formatoConflicto', () => {
  it('usa el error de la RPC en el detalle', () => {
    const { outboxOpts } = cargar();
    const { titulo, detalle } = outboxOpts.badge.formatoConflicto({
      conflicto_datos: { error: 'Sin stock de Producto Y' },
    });
    expect(titulo).toBe('Pedido: el stock cambió mientras estabas sin conexión');
    expect(detalle).toContain('Sin stock de Producto Y');
  });

  it('usa un mensaje default si no hay error puntual', () => {
    const { outboxOpts } = cargar();
    const { detalle } = outboxOpts.badge.formatoConflicto({ conflicto_datos: {} });
    expect(detalle).toContain('ya no tienen stock suficiente');
  });
});

describe('cliente-offline.js — hooks', () => {
  it('onConflicto refresca el carrito si está disponible', () => {
    const cargarCarrito = vi.fn().mockResolvedValue();
    const { outboxOpts } = cargar({ windowExtra: { cargarCarrito } });
    outboxOpts.onConflicto();
    expect(cargarCarrito).toHaveBeenCalledTimes(1);
  });

  it('onConflicto no rompe si cargarCarrito no está definido', () => {
    const { outboxOpts } = cargar();
    expect(() => outboxOpts.onConflicto()).not.toThrow();
  });

  it('onSincronizado usa mostrarToast cuando está disponible (singular)', () => {
    const mostrarToast = vi.fn();
    const { outboxOpts } = cargar({ windowExtra: { mostrarToast } });
    outboxOpts.onSincronizado(1);
    expect(mostrarToast).toHaveBeenCalledWith(
      'Tu pedido pendiente ya se envió — quedó confirmado.',
      'success'
    );
  });

  it('onSincronizado usa mostrarToast en plural para más de uno', () => {
    const mostrarToast = vi.fn();
    const { outboxOpts } = cargar({ windowExtra: { mostrarToast } });
    outboxOpts.onSincronizado(3);
    expect(mostrarToast).toHaveBeenCalledWith(
      '3 pedidos pendientes ya se enviaron — quedaron confirmados.',
      'success'
    );
  });

  it('onSincronizado cae a alert() si no hay mostrarToast', () => {
    const { outboxOpts, window } = cargar();
    outboxOpts.onSincronizado(1);
    expect(window.alert).toHaveBeenCalledWith('Tu pedido pendiente ya se envió — quedó confirmado.');
  });
});
