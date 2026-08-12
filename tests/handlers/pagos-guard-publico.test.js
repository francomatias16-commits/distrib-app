// tests/handlers/pagos-guard-publico.test.js
//
// Etapa 6 offline (PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md, sección 0):
// hueco de test sobre el guard de MP público (_svc=publico en
// lib/handlers/pagos.js). Al escribir este archivo apareció un bug real,
// no cosmético: el handler llamaba a `PagosRepo.obtenerPedidoParaPagoPublico`,
// pero esa función vive en `lib/repos/pedidos.js`, nunca existió en el
// namespace `PagosRepo` (repos/pagos.js) — cualquier POST real a este
// endpoint tiraba TypeError ("is not a function") en vez del 404 que
// documenta el propio código. El guard de Etapa 5 punto 2 nunca llegó a
// ejecutarse en producción. Se corrigió el import en lib/handlers/pagos.js
// como parte de este mismo cambio; este test es el que lo hubiera
// atrapado, y queda para que no vuelva a pasar.

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

const pedidoPublicoMock = vi.hoisted(() => ({ resultado: { data: null, error: null } }));

vi.mock('../../lib/repos/pedidos.js', () => ({
  obtenerPedidoParaPagoPublico: vi.fn(() => Promise.resolve(pedidoPublicoMock.resultado)),
}));

vi.mock('../../lib/repos/pagos.js', async () => {
  // esPedidoPilotoWhatsApp es la función bajo prueba en pagos.test.js — se
  // reusa la implementación real acá (vi.importActual) en vez de
  // duplicarla, para que este test no pueda "pasar de casualidad" con una
  // copia de la lógica que se desincroniza del código real.
  const real = await vi.importActual('../../lib/repos/pagos.js');
  return {
    esPedidoPilotoWhatsApp: real.esPedidoPilotoWhatsApp,
    obtenerTransaccionPendientePorPedido: vi.fn(() => Promise.resolve(null)),
    obtenerItemsPedido: vi.fn(() => Promise.resolve([])),
    obtenerIntegracionMPActiva: vi.fn(() => Promise.resolve({ data: null, error: { message: 'no configurado' } })),
  };
});

// node-fetch no debería llamarse en ninguno de estos casos (el guard corta
// antes o el flujo se detiene en "MP no configurado"), pero se mockea
// igual para que un fallo de guard no intente pegarle a la red real.
vi.mock('node-fetch', () => ({ default: vi.fn() }));

const { default: handler } = await import('../../lib/handlers/pagos.js');

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function fakeReq(pedido_id) {
  return {
    method: 'POST',
    query: { _svc: 'publico' },
    body: { pedido_id },
    headers: {},
  };
}

beforeEach(() => {
  pedidoPublicoMock.resultado = { data: null, error: null };
});

describe('crearPreferenciaPublicaHandler — guard esPedidoPilotoWhatsApp', () => {
  it('devuelve 404 si el pedido no existe', async () => {
    pedidoPublicoMock.resultado = { data: null, error: null };

    const res = fakeRes();
    await handler(fakeReq('ped-inexistente'), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Pedido no encontrado' });
  });

  it('devuelve 404 (no 500) para un pedido real que NO salió del piloto de WhatsApp — este es el caso que estaba roto', async () => {
    pedidoPublicoMock.resultado = {
      data: { id: 'ped1', empresa_id: 'e1', cliente_id: 'c1', total: 1000, estado: 'confirmado', generado_automatico: false },
      error: null,
    };

    const res = fakeRes();
    await handler(fakeReq('ped1'), res);

    // Antes del fix esto tiraba TypeError dentro del try/catch del handler
    // y devolvía 500 "No se pudo completar la operación" en vez de este 404.
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Pedido no encontrado' });
  });

  it('deja pasar el guard para un pedido que sí salió del piloto (generado_automatico: true) y sigue de largo al flujo de MP', async () => {
    pedidoPublicoMock.resultado = {
      data: { id: 'ped2', empresa_id: 'e1', cliente_id: 'c1', total: 1000, estado: 'confirmado', generado_automatico: true },
      error: null,
    };

    const res = fakeRes();
    await handler(fakeReq('ped2'), res);

    // Con el guard superado, el flujo sigue a _generarPreferenciaPago, que
    // en este mock corta en "MP no configurado" (400) — la señal
    // importante acá es que NO es un 404 "Pedido no encontrado": el pedido
    // sí pasó el guard.
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Mercado Pago no configurado para esta empresa' });
  });

  it('responde 400 "Datos incompletos" si no viene pedido_id, sin tocar el repo', async () => {
    const res = fakeRes();
    await handler(fakeReq(undefined), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Datos incompletos' });
  });
});
