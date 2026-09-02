// tests/handlers/fidelizacion.test.js
//
// Hallazgo #9 — sin casos propios. A diferencia de los otros 3 handlers
// de este lote (gastos-generales/reglas-precio/maestros), este es de cara
// al portal cliente, no al admin: no usa permisos-service, resuelve
// { empresa_id, cliente_id } a partir del token de sesión de Supabase
// (resolverClienteDesdeSesion). El punto sensible a cubrir es justamente
// ese: que cliente_id salga siempre del server, nunca de lo que mande el
// navegador, y que cada paso de la cadena de validación (token → usuario
// → rol=cliente → cliente asociado → activo) corte con el error correcto
// antes de tocar catálogo o RPC de canje.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({ auth: { getUser: supabaseMock.getUser } }),
}));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false,
}));

const reposMock = vi.hoisted(() => ({
  obtenerUsuarioPorAuthId: vi.fn(),
  obtenerClientePorId: vi.fn(),
  obtenerClientePorEmail: vi.fn(),
  listarRecompensasActivas: vi.fn(async () => ({
    data: [
      { id: 'rec1', nombre: 'Remera', cantidad_disponible: null, cantidad_canjeada: 0 },
      { id: 'rec2', nombre: 'Gorra', cantidad_disponible: 5, cantidad_canjeada: 5 }, // agotada
      { id: 'rec3', nombre: 'Termo', cantidad_disponible: 5, cantidad_canjeada: 2 }, // con stock
    ],
    error: null,
  })),
  obtenerSaldoPuntos: vi.fn(async () => ({ data: { puntos_disponibles: 300, puntos_totales: 800 }, error: null })),
  canjearRecompensaRpc: vi.fn(async () => ({ data: { puntos_restantes: 100 }, error: null })),
}));
vi.mock('../../lib/repos/fidelizacion.js', () => reposMock);

vi.mock('../../lib/error-response.js', () => ({
  errorSeguro: vi.fn((res, _err, status, msg) => res.status(status).json({ error: msg })),
}));

const { default: handler } = await import('../../lib/handlers/fidelizacion.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

const usuarioClienteActivo = { empresa_id: 'e1', cliente_id: 'cli-1', email: 'cli@test.com', rol: 'cliente' };
const clienteActivo = { id: 'cli-1', activo: true };

beforeEach(() => {
  vi.clearAllMocks();
  supabaseMock.getUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  reposMock.obtenerUsuarioPorAuthId.mockResolvedValue({ data: usuarioClienteActivo, error: null });
  reposMock.obtenerClientePorId.mockResolvedValue({ data: clienteActivo, error: null });
});

describe('resolverClienteDesdeSesion — cadena de validación', () => {
  it('sin header authorization → 401, no llama a supabase', async () => {
    const res = mockRes();
    await handler({ method: 'GET', headers: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(supabaseMock.getUser).not.toHaveBeenCalled();
  });

  it('token inválido (supabase rechaza) → 401', async () => {
    supabaseMock.getUser.mockResolvedValue({ data: { user: null }, error: new Error('jwt inválido') });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido' });
  });

  it('usuario no encontrado en la tabla usuarios → 403', async () => {
    reposMock.obtenerUsuarioPorAuthId.mockResolvedValue({ data: null, error: null });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Usuario no encontrado' });
  });

  it('usuario con rol distinto de "cliente" → 403, no busca el cliente asociado', async () => {
    reposMock.obtenerUsuarioPorAuthId.mockResolvedValue({ data: { ...usuarioClienteActivo, rol: 'vendedor' }, error: null });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Solo los clientes pueden canjear recompensas' });
    expect(reposMock.obtenerClientePorId).not.toHaveBeenCalled();
  });

  it('sin cliente_id en el usuario → resuelve por email en vez de por id', async () => {
    reposMock.obtenerUsuarioPorAuthId.mockResolvedValue({ data: { ...usuarioClienteActivo, cliente_id: null }, error: null });
    reposMock.obtenerClientePorEmail.mockResolvedValue({ data: clienteActivo, error: null });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    expect(reposMock.obtenerClientePorEmail).toHaveBeenCalledWith('e1', 'cli@test.com');
    expect(reposMock.obtenerClientePorId).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('no se encuentra el cliente asociado → 403', async () => {
    reposMock.obtenerClientePorId.mockResolvedValue({ data: null, error: null });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'No se encontró un cliente asociado a esta cuenta' });
  });

  it('cliente inactivo → 403', async () => {
    reposMock.obtenerClientePorId.mockResolvedValue({ data: { id: 'cli-1', activo: false }, error: null });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cliente inactivo. Contacte a la distribuidora.' });
  });

  it('cliente_id nunca sale del body/query del request, aunque el cliente intente mandar uno propio', async () => {
    reposMock.listarRecompensasActivas.mockClear();
    const res = mockRes();
    // el cliente manda un cliente_id ajeno en query — el handler ni lo mira
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' }, query: { cliente_id: 'cli-de-otro' } }, res);

    expect(reposMock.obtenerSaldoPuntos).toHaveBeenCalledWith('e1', 'cli-1'); // el real, derivado del token
  });
});

describe('GET — catálogo', () => {
  it('filtra recompensas agotadas (cantidad_disponible - cantidad_canjeada <= 0)', async () => {
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    const body = res.json.mock.calls[0][0];
    const ids = body.recompensas.map(r => r.id);
    expect(ids).toEqual(['rec1', 'rec3']); // rec2 quedó afuera (agotada)
    expect(body.puntos_disponibles).toBe(300);
    expect(body.puntos_totales).toBe(800);
  });

  it('sin saldo previo (cliente nuevo) → puntos en 0, no rompe', async () => {
    reposMock.obtenerSaldoPuntos.mockResolvedValue({ data: null, error: null });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.puntos_disponibles).toBe(0);
    expect(body.puntos_totales).toBe(0);
  });

  it('error del repo de recompensas → 500 vía errorSeguro', async () => {
    reposMock.listarRecompensasActivas.mockResolvedValue({ data: null, error: new Error('db caída') });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('POST ?accion=canjear', () => {
  function reqCanje(body) {
    return { method: 'POST', query: { accion: 'canjear' }, headers: { authorization: 'Bearer x' }, body };
  }

  it('sin recompensa_id → 400, no llama a la RPC', async () => {
    const res = mockRes();
    await handler(reqCanje({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(reposMock.canjearRecompensaRpc).not.toHaveBeenCalled();
  });

  it('canje exitoso → llama la RPC con cliente_id derivado del token, no del body', async () => {
    const res = mockRes();
    await handler(reqCanje({ recompensa_id: 'rec3', cliente_id: 'otro-cliente' }), res);

    expect(reposMock.canjearRecompensaRpc).toHaveBeenCalledWith({
      empresa_id: 'e1', cliente_id: 'cli-1', recompensa_id: 'rec3',
    });
    expect(res.json).toHaveBeenCalledWith({ ok: true, puntos_restantes: 100 });
  });

  it('RPC devuelve error de negocio (saldo insuficiente) → 400 con el mensaje tal cual, no errorSeguro', async () => {
    reposMock.canjearRecompensaRpc.mockResolvedValue({ data: null, error: { message: 'Saldo insuficiente' } });
    const res = mockRes();
    await handler(reqCanje({ recompensa_id: 'rec3' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Saldo insuficiente' });
  });
});

it('método/acción no soportada → 405', async () => {
  const res = mockRes();
  await handler({ method: 'DELETE', headers: { authorization: 'Bearer x' }, query: {} }, res);

  expect(res.status).toHaveBeenCalledWith(405);
});
