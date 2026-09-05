// tests/handlers/piloto-recalcular-ciclos-cron.test.js
//
// Hallazgo v1063: la RPC calcular_ciclos_cliente (migración 032, motor real
// de detección de ciclos de compra) nunca se invocaba desde ningún cron ni
// handler — ciclos_compra quedaba en cero para TODOS los tenants reales, no
// solo para el tenant de demo. Sin datos en ciclos_compra, ni el Piloto
// Automático de Pedidos (generar_pedidos_sugeridos) ni "Clientes en fuga"
// tienen de dónde leer. Este test cubre el nuevo branch
// accion=recalcular-ciclos && esCron en lib/handlers/piloto.js: el guard de
// CRON_SECRET, que recorre TODAS las empresas activas (incluida demo, a
// diferencia de whatsapp-cron), y que un error puntual en una empresa no
// corta el resto de la corrida.
//
// Mismo criterio de mocking que retencion-permisos.test.js: rate-limit
// siempre libre, auth-helpers mockeado (no se llega a usar en el branch de
// cron), y lib/repos/piloto.js mockeado entero para no pegarle a Supabase
// real.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
  rateLimitPorClave: () => async () => false, // nunca limitado (usado por _auto-push.js)
}));

vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(() => Promise.resolve(null)),
}));

const pilotoRepoMock = vi.hoisted(() => ({
  empresas: [],
  resultadosPorEmpresa: {}, // empresa_id -> { error: null | { message } }
  llamadas: [],
}));

vi.mock('../../lib/repos/piloto.js', () => ({
  listarEmpresasActivas: vi.fn(async (opts) => {
    pilotoRepoMock.llamadas.push({ fn: 'listarEmpresasActivas', opts });
    return pilotoRepoMock.empresas;
  }),
  calcularCiclosClienteRpc: vi.fn(async (empresa_id) => {
    pilotoRepoMock.llamadas.push({ fn: 'calcularCiclosClienteRpc', empresa_id });
    return pilotoRepoMock.resultadosPorEmpresa[empresa_id] ?? { error: null };
  }),
  // Resto de exports que el handler importa pero no ejercita este branch —
  // se mockean como no-op para que el import del módulo no falle.
  generarPedidosSugeridosRpc: vi.fn(),
  obtenerSugeridosParaWhatsappRpc: vi.fn(),
  listarPedidosSugeridos: vi.fn(),
  contarPedidosSugeridos: vi.fn(),
  confirmarPedidoSugerido: vi.fn(),
  descartarPedidoSugerido: vi.fn(),
  listarCiclosCompraActivos: vi.fn(),
  insertarNotifLogWhatsapp: vi.fn(),
}));

const { listarEmpresasActivas, calcularCiclosClienteRpc } =
  await import('../../lib/repos/piloto.js');
const { default: handler } = await import('../../lib/handlers/piloto.js');

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    // Como el resto de vercel/express, json() sin .status() previo implica 200.
    json(payload) { if (this.statusCode == null) this.statusCode = 200; this.body = payload; return this; },
    setHeader() { return this; },
    removeHeader() { return this; },
    end() { return this; },
  };
  return res;
}

function fakeReq({ secret = 'cron-secret-test', metodo = 'GET' } = {}) {
  return {
    method: metodo,
    query: { accion: 'recalcular-ciclos' },
    body: {},
    headers: secret == null ? {} : { authorization: `Bearer ${secret}` },
  };
}

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret-test';
  pilotoRepoMock.empresas = [];
  pilotoRepoMock.resultadosPorEmpresa = {};
  pilotoRepoMock.llamadas = [];
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

describe('piloto.js — accion=recalcular-ciclos (cron v1063)', () => {
  it('sin CRON_SECRET configurado, cae al 401 general (no autorizado)', async () => {
    delete process.env.CRON_SECRET;
    const res = fakeRes();
    await handler(fakeReq(), res);
    expect(res.statusCode).toBe(401);
    expect(calcularCiclosClienteRpc).not.toHaveBeenCalled();
  });

  it('con un secreto incorrecto, cae al 401 general', async () => {
    const res = fakeRes();
    await handler(fakeReq({ secret: 'no-es-el-secreto' }), res);
    expect(res.statusCode).toBe(401);
    expect(calcularCiclosClienteRpc).not.toHaveBeenCalled();
  });

  it('recorre TODAS las empresas activas, incluida demo (no pasa excluirDemo)', async () => {
    pilotoRepoMock.empresas = [{ id: 'emp-1' }, { id: 'emp-2' }];
    const res = fakeRes();
    await handler(fakeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, procesadas: 2, con_error: 0 });
    expect(listarEmpresasActivas).toHaveBeenCalledWith();
    expect(calcularCiclosClienteRpc).toHaveBeenCalledWith('emp-1');
    expect(calcularCiclosClienteRpc).toHaveBeenCalledWith('emp-2');
  });

  it('un error puntual en una empresa no corta la corrida del resto', async () => {
    pilotoRepoMock.empresas = [{ id: 'emp-ok' }, { id: 'emp-error' }, { id: 'emp-ok-2' }];
    pilotoRepoMock.resultadosPorEmpresa['emp-error'] = { error: { message: 'boom' } };

    const res = fakeRes();
    await handler(fakeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, procesadas: 2, con_error: 1 });
    expect(calcularCiclosClienteRpc).toHaveBeenCalledTimes(3);
  });

  it('sin empresas activas, responde 0/0 sin llamar a la RPC', async () => {
    pilotoRepoMock.empresas = [];
    const res = fakeRes();
    await handler(fakeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, procesadas: 0, con_error: 0 });
    expect(calcularCiclosClienteRpc).not.toHaveBeenCalled();
  });
});
