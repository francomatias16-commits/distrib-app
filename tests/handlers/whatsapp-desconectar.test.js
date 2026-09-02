// tests/handlers/whatsapp-desconectar.test.js
//
// Handler de desconexión manual del WhatsApp propio de una empresa (botón
// "Desconectar" en /admin/whatsapp-onboarding, ver whatsapp-onboarding.js).
// Mismo criterio que whatsapp-embedded-signup.test.js: se mockea `fetch`
// global (llamada a Meta) y `lib/repos/_db.js`, sin pegarle a Meta ni a
// Supabase real.
//
// Se exportó `whatsappDesconectarHandler` (antes interna) para poder
// testearlo directamente, mismo criterio que whatsappEmbeddedSignupHandler.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  selectResultado: { data: { waba_id: 'waba-1', access_token: 'CIFRADO(token-largo)' }, error: null },
  selectLlamadas: [],
  deleteResultado: { error: null },
  deleteLlamadas: [],
}));

vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    from: (tabla) => ({
      select: (columnas) => ({
        eq: (col, val) => ({
          maybeSingle: () => {
            dbMock.selectLlamadas.push({ tabla, columnas, col, val });
            return Promise.resolve(dbMock.selectResultado);
          },
        }),
      }),
      delete: () => ({
        eq: (col, val) => {
          dbMock.deleteLlamadas.push({ tabla, col, val });
          return Promise.resolve(dbMock.deleteResultado);
        },
      }),
    }),
  },
}));

vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(),
}));

vi.mock('../../lib/crypto-secrets.js', () => ({
  cifrar: (texto) => `CIFRADO(${texto})`,
  descifrar: (texto) => texto?.replace(/^CIFRADO\((.*)\)$/, '$1'),
}));

const { verificarToken } = await import('../../lib/auth-helpers.js');
const { whatsappDesconectarHandler } = await import('../../lib/handlers/notif.js');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    end() { return this; },
  };
  return res;
}

const PERFIL_DUENO = { id: 'user-1', rol: 'dueno', empresa_id: 'empresa-1' };

function respuestaFetch(ok, data) {
  return { ok, json: async () => data };
}

beforeEach(() => {
  dbMock.selectResultado = { data: { waba_id: 'waba-1', access_token: 'CIFRADO(token-largo)' }, error: null };
  dbMock.selectLlamadas = [];
  dbMock.deleteResultado = { error: null };
  dbMock.deleteLlamadas = [];
  verificarToken.mockReset();
  verificarToken.mockResolvedValue(PERFIL_DUENO);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('whatsappDesconectarHandler — validaciones', () => {
  it('rechaza con 401 si no hay usuario autenticado', async () => {
    verificarToken.mockResolvedValue(null);
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(401);
  });

  it('rechaza con 403 si el usuario no es dueño ni admin', async () => {
    verificarToken.mockResolvedValue({ id: 'u2', rol: 'vendedor', empresa_id: 'empresa-1' });
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(403);
  });

  it('rechaza con 400 si el usuario no tiene empresa asociada', async () => {
    verificarToken.mockResolvedValue({ id: 'u2', rol: 'dueno', empresa_id: null });
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(400);
  });

  it('responde 405 para métodos que no sean POST/OPTIONS', async () => {
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'GET', body: {} }, res);

    expect(res.statusCode).toBe(405);
  });
});

describe('whatsappDesconectarHandler — orquestación', () => {
  it('camino feliz: desuscribe en Meta y borra la fila local', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuestaFetch(true, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Se avisa a Meta con el token descifrado, contra el waba_id guardado.
    const [url, opciones] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/waba-1/subscribed_apps');
    expect(opciones.method).toBe('DELETE');
    expect(opciones.headers.Authorization).toBe('Bearer token-largo');

    expect(dbMock.deleteLlamadas).toHaveLength(1);
    expect(dbMock.deleteLlamadas[0]).toEqual({ tabla: 'empresa_whatsapp', col: 'empresa_id', val: 'empresa-1' });
  });

  it('si ya no había nada conectado, responde 200 sin llamar a Meta ni borrar nada', async () => {
    dbMock.selectResultado = { data: null, error: null };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, ya_estaba_desconectado: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.deleteLlamadas).toHaveLength(0);
  });

  it('si Meta rechaza la desuscripción, igual borra la fila local y responde 200 (no es crítico)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuestaFetch(false, { error: { message: 'token vencido' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(dbMock.deleteLlamadas).toHaveLength(1);
  });

  it('si Meta corta la conexión de red, igual borra la fila local y responde 200 (no es crítico)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(dbMock.deleteLlamadas).toHaveLength(1);
  });

  it('devuelve 500 si falla la lectura de las credenciales actuales', async () => {
    dbMock.selectResultado = { data: null, error: { message: 'connection reset' } };
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(500);
  });

  it('devuelve 500 si falla el borrado en la base', async () => {
    dbMock.deleteResultado = { error: { message: 'connection reset' } };
    const fetchMock = vi.fn().mockResolvedValue(respuestaFetch(true, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappDesconectarHandler({ method: 'POST', body: {} }, res);

    expect(res.statusCode).toBe(500);
  });
});
