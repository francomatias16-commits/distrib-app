// tests/handlers/auth-revocar-sesiones.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🟠 #10. Ni `handleChangePassword` ni
// `handleConfirmarCodigoWhatsapp` (lib/handlers/auth.js) invalidaban los
// refresh_tokens existentes del usuario al cambiar la contraseña — un
// refresh token robado (sesión comprometida) seguía siendo válido hasta
// 7 días después de que el usuario "solucionara" el problema cambiando
// su contraseña. v957 agregó `revocarSesionesUsuario()`, invocada desde
// ambos flujos tras actualizar la contraseña con éxito.
//
// Este test fija el contrato: tras un cambio de contraseña exitoso (por
// cualquiera de los dos caminos), debe dispararse
// `UPDATE refresh_tokens SET revocado = true WHERE usuario_id = X AND
// revocado = false` — y NO debe dispararse si la contraseña actual es
// incorrecta o el código de WhatsApp es inválido.

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── Mock genérico de supabaseAdmin: encadenable (.from().select().eq()...)
// y "thenable" en cualquier punto de la cadena, con log de llamadas por
// tabla para poder aserir la revocación de sesiones sin que
// revocarSesionesUsuario() esté exportada.
const supaState = vi.hoisted(() => ({
  calls: [],           // [{ table, method, args }]
  usuarioRow: null,     // fila devuelta por from('usuarios')...maybeSingle/single
  filaCodigo: null,     // fila devuelta por from('whatsapp_reset_codigos')...maybeSingle
  signInError: null,    // error de auth.signInWithPassword
  updateUserError: null, // error de auth.admin.updateUserById
}));

function chain(table, terminalResult) {
  const self = {
    select: vi.fn((...a) => { supaState.calls.push({ table, method: 'select', args: a }); return self; }),
    eq: vi.fn((...a) => { supaState.calls.push({ table, method: 'eq', args: a }); return self; }),
    limit: vi.fn((...a) => self),
    order: vi.fn((...a) => self),
    update: vi.fn((...a) => { supaState.calls.push({ table, method: 'update', args: a }); return self; }),
    insert: vi.fn((...a) => self),
    maybeSingle: vi.fn(() => Promise.resolve(terminalResult)),
    single: vi.fn(() => Promise.resolve(terminalResult)),
    then: (resolve, reject) => Promise.resolve(terminalResult).then(resolve, reject),
  };
  return self;
}

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    auth: {
      signInWithPassword: vi.fn(() => Promise.resolve({
        data: supaState.signInError ? null : { user: { id: 'user-1' } },
        error: supaState.signInError,
      })),
      admin: {
        updateUserById: vi.fn(() => Promise.resolve({ error: supaState.updateUserError })),
      },
    },
    from: vi.fn((table) => {
      if (table === 'usuarios') return chain(table, { data: supaState.usuarioRow, error: null });
      if (table === 'whatsapp_reset_codigos') return chain(table, { data: supaState.filaCodigo, error: null });
      if (table === 'refresh_tokens') return chain(table, { error: null });
      return chain(table, { data: null, error: null });
    }),
  }),
}));

vi.mock('../../lib/email.js', () => ({ enviarEmailRecuperacionPassword: vi.fn() }));
vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => vi.fn().mockResolvedValue(false),
  rateLimitAuth: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../lib/security-headers.js', () => ({ applySecurityHeaders: vi.fn(), applyCorsHeaders: vi.fn() }));
vi.mock('../../lib/circuit-breaker.js', () => ({
  CircuitBreaker: class { exec(fn) { return fn(); } },
  CircuitBreakerOpenError: class extends Error {},
}));
vi.mock('../../lib/retry.js', () => ({ withRetry: (fn) => fn() }));
vi.mock('../../lib/error-response.js', () => ({ errorSeguro: vi.fn((res) => res.status(500).json({ error: 'err' })) }));
vi.mock('../../lib/auth/leaked-password-check.js', () => ({ chequearPasswordONull: vi.fn().mockResolvedValue(null) }));

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', async () => {
  const actual = await vi.importActual('../../lib/auth-helpers.js');
  return {
    ...actual,
    verificarToken: verificarTokenMock,
  };
});

const handler = (await import('../../lib/handlers/auth.js')).default;

function mockReq(overrides = {}) {
  return {
    method: 'POST',
    query: {},
    headers: {},
    body: {},
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

function revocacionesDe(usuarioId) {
  // Busca la secuencia from('refresh_tokens') → update({revocado:true}) →
  // eq('usuario_id', X) → eq('revocado', false) en el log de llamadas.
  const idx = supaState.calls.findIndex(c =>
    c.table === 'refresh_tokens' && c.method === 'update' && c.args[0]?.revocado === true);
  if (idx === -1) return [];
  const siguientes = supaState.calls.slice(idx + 1, idx + 3);
  return siguientes.filter(c => c.table === 'refresh_tokens' && c.method === 'eq')
    .map(c => c.args);
}

beforeEach(() => {
  supaState.calls = [];
  supaState.usuarioRow = null;
  supaState.filaCodigo = null;
  supaState.signInError = null;
  supaState.updateUserError = null;
});

describe('handleChangePassword — regresión hallazgo #10 (revocación de sesiones)', () => {
  it('tras un cambio de contraseña exitoso, revoca todos los refresh_tokens activos del usuario', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'user-1', email: 'user@test.com', rol: 'admin' });

    const res = mockRes();
    await handler(mockReq({
      query: { _ruta: 'change-password' },
      body: { password_actual: 'actual123', password_nuevo: 'nuevo1234' },
    }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const eqCalls = revocacionesDe('user-1');
    expect(eqCalls).toEqual([['usuario_id', 'user-1'], ['revocado', false]]);
  });

  it('si la contraseña actual es incorrecta, NO revoca sesiones', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'user-1', email: 'user@test.com', rol: 'admin' });
    supaState.signInError = { message: 'Invalid credentials' };

    const res = mockRes();
    await handler(mockReq({
      query: { _ruta: 'change-password' },
      body: { password_actual: 'mala', password_nuevo: 'nuevo1234' },
    }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(revocacionesDe('user-1')).toEqual([]);
  });
});

describe('handleConfirmarCodigoWhatsapp — regresión hallazgo #10 (revocación de sesiones)', () => {
  const CODIGO = '123456';

  beforeEach(() => {
    supaState.usuarioRow = { id: 'cliente-user-1', cliente_id: 'cliente-1', rol: 'cliente', activo: true };
  });

  it('tras confirmar el código y fijar la contraseña, revoca todos los refresh_tokens activos del usuario', async () => {
    const crypto = await import('crypto');
    const hashToken = (v) => crypto.createHash('sha256').update(v).digest('hex');
    supaState.filaCodigo = {
      id: 'codigo-1',
      codigo_hash: hashToken(CODIGO),
      intentos: 0,
      expira_at: new Date(Date.now() + 10 * 60000).toISOString(),
      usado: false,
    };

    const res = mockRes();
    await handler(mockReq({
      query: { _ruta: 'confirmar-codigo-whatsapp' },
      body: { telefono: '+5491111111111', codigo: CODIGO, password_nuevo: 'nuevo1234' },
    }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const eqCalls = revocacionesDe('cliente-user-1');
    expect(eqCalls).toEqual([['usuario_id', 'cliente-user-1'], ['revocado', false]]);
  });

  it('si el código es inválido, NO revoca sesiones', async () => {
    supaState.filaCodigo = {
      id: 'codigo-1',
      codigo_hash: 'hash-que-no-matchea',
      intentos: 0,
      expira_at: new Date(Date.now() + 10 * 60000).toISOString(),
      usado: false,
    };

    const res = mockRes();
    await handler(mockReq({
      query: { _ruta: 'confirmar-codigo-whatsapp' },
      body: { telefono: '+5491111111111', codigo: '000000', password_nuevo: 'nuevo1234' },
    }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(revocacionesDe('cliente-user-1')).toEqual([]);
  });
});
