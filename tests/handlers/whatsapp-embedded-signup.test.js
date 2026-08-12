// tests/handlers/whatsapp-embedded-signup.test.js
//
// Etapa 7.1 del plan (PLAN_whatsapp_bidireccional_seguimiento.md): el
// handler que hace el intercambio server-to-server de Embedded Signup
// (code → token → token de larga duración → registrar número → suscribir
// webhooks → guardar cifrado en empresa_whatsapp) no tenía ningún test.
// Es el punto más sensible de la Fase 7 antes de producción real — maneja
// tokens de acceso de WhatsApp Business de cada empresa cliente — así que
// se cubre acá la orquestación completa y sus validaciones, sin pegarle a
// Meta real (se mockea `fetch` global).
//
// Se exportó `whatsappEmbeddedSignupHandler` (antes interna) para poder
// testearlo directamente, mismo criterio que crearPedidoDesdeItemsWhatsapp /
// procesarMensajeTexto.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  upsertResultado: { error: null },
  upsertLlamadas: [],
  updateResultado: { error: null },
  updateLlamadas: [],
}));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    from: (tabla) => ({
      upsert: (payload, opciones) => {
        dbMock.upsertLlamadas.push({ tabla, payload, opciones });
        return Promise.resolve(dbMock.upsertResultado);
      },
    }),
  }),
}));

// Lote 4: el guardado final de credenciales pasó de `supabase`
// (crearClienteSupabaseLazy, mockeado arriba) a
// `guardarCredencialesWhatsapp` en lib/repos/whatsapp-bot.js, que usa `db`
// de _db.js — mismo router de `upsertLlamadas`/`upsertResultado` para no
// duplicar las aserciones ya escritas más abajo.
vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    from: (tabla) => ({
      upsert: (payload, opciones) => {
        dbMock.upsertLlamadas.push({ tabla, payload, opciones });
        return Promise.resolve(dbMock.upsertResultado);
      },
      // Migración 436 (Coexistencia): `marcarHistorialSincronizado` hace un
      // `.update(...).eq(...)` tras disparar la sync post-alta. No es el
      // foco de este archivo (se cubre en el test file del webhook/repo),
      // pero sin esto la promesa fire-and-forget logueaba un error espurio
      // en cada test de Coexistencia.
      update: (payload) => {
        dbMock.updateLlamadas.push({ tabla, payload });
        return { eq: () => Promise.resolve(dbMock.updateResultado) };
      },
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
const { whatsappEmbeddedSignupHandler } = await import('../../lib/handlers/notif.js');

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
const BODY_OK = { code: 'code-123', waba_id: 'waba-1', phone_number_id: 'pnid-1' };

function respuestaFetch(ok, data) {
  return { ok, json: async () => data };
}

beforeEach(() => {
  dbMock.upsertResultado = { error: null };
  dbMock.upsertLlamadas = [];
  dbMock.updateResultado = { error: null };
  dbMock.updateLlamadas = [];
  verificarToken.mockReset();
  verificarToken.mockResolvedValue(PERFIL_DUENO);
  process.env.WA_APP_ID = 'app-id-test';
  process.env.WA_APP_SECRET = 'app-secret-test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WA_APP_ID;
  delete process.env.WA_APP_SECRET;
});

describe('whatsappEmbeddedSignupHandler — validaciones', () => {
  it('rechaza con 401 si no hay usuario autenticado', async () => {
    verificarToken.mockResolvedValue(null);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(401);
  });

  it('rechaza con 403 si el usuario no es dueño ni admin', async () => {
    verificarToken.mockResolvedValue({ id: 'u2', rol: 'vendedor', empresa_id: 'empresa-1' });
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(403);
  });

  it('rechaza con 400 si el usuario no tiene empresa asociada', async () => {
    verificarToken.mockResolvedValue({ id: 'u2', rol: 'dueno', empresa_id: null });
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(400);
  });

  // FIX (2026-08-04, CHANGELOG_v608): se sacó la opción "Crear un WhatsApp
  // Business nuevo" — Coexistencia (solo code + waba_id) quedó como único
  // flujo. phone_number_id ya no es un campo de entrada validado: siempre
  // se resuelve server-to-server más abajo (Paso 1ter).
  it('rechaza con 400 si faltan code/waba_id', async () => {
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: { code: 'x' } }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/code y waba_id son requeridos/);
  });

  it('rechaza con 500 si WA_APP_ID/WA_APP_SECRET no están configurados en el servidor', async () => {
    delete process.env.WA_APP_ID;
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(500);
  });

  it('responde 405 para métodos que no sean POST/OPTIONS', async () => {
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'GET', body: BODY_OK }, res);

    expect(res.statusCode).toBe(405);
  });
});

// FIX (2026-08-04, CHANGELOG_v608): Coexistencia (resolver phone_number_id
// server-to-server vía /phone_numbers, sin /register) es ahora el ÚNICO
// flujo — por eso el mock es por URL (no por orden secuencial) tanto acá
// como en el describe de Coexistencia de más abajo, que reutiliza esta
// misma factory.
function fetchMockPorUrl(overrides = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('grant_type=fb_exchange_token')) return overrides.longLived ?? respuestaFetch(true, { access_token: 'token-largo' });
    if (u.includes('/oauth/access_token'))          return overrides.shortLived ?? respuestaFetch(true, { access_token: 'token-corto' });
    if (u.includes('/phone_numbers'))               return overrides.phoneNumbers ?? respuestaFetch(true, { data: [{ id: 'pnid-1' }] });
    if (u.endsWith('/register'))                    return respuestaFetch(true, { success: true }); // no debería llamarse nunca
    if (u.includes('/subscribed_apps'))             return overrides.subscribe ?? respuestaFetch(true, { success: true });
    if (u.includes('fields=verified_name'))         return overrides.verifiedName ?? respuestaFetch(true, { verified_name: 'Distribuidora Test' });
    if (u.includes('/smb_app_data'))                return respuestaFetch(true, { messaging_product: 'whatsapp', request_id: 'req-1' });
    return respuestaFetch(true, {});
  });
}

describe('whatsappEmbeddedSignupHandler — orquestación contra Meta (Coexistencia, único flujo)', () => {
  it('camino feliz: intercambia token, canjea a larga duración, resuelve el número, suscribe y guarda cifrado', async () => {
    const fetchMock = fetchMockPorUrl();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, verified_name: 'Distribuidora Test', phone_number_id: 'pnid-1', es_coexistencia: true });
    expect(dbMock.upsertLlamadas).toHaveLength(1);
    expect(dbMock.upsertLlamadas[0].payload.access_token).toBe('CIFRADO(token-largo)'); // guarda el de larga duración, cifrado
    expect(dbMock.upsertLlamadas[0].payload.empresa_id).toBe('empresa-1');
    expect(dbMock.upsertLlamadas[0].opciones).toEqual({ onConflict: 'empresa_id' });

    const urlsLlamadas = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urlsLlamadas.some((u) => u.endsWith('/register'))).toBe(false); // Coexistencia: nunca se llama a /register
  });

  it('si falla el canje a token de larga duración, sigue el alta con el token corto (no corta)', async () => {
    const fetchMock = fetchMockPorUrl({ longLived: respuestaFetch(false, { error: { message: 'boom' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(200);
    expect(dbMock.upsertLlamadas[0].payload.access_token).toBe('CIFRADO(token-corto)'); // se guarda igual, con el corto
  });

  it('corta con 502 si Meta rechaza el intercambio inicial del code', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(respuestaFetch(false, { error: { message: 'invalid code' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no sigue a los pasos siguientes
    expect(dbMock.upsertLlamadas).toHaveLength(0);
  });

  it('corta con 502 si Meta no devuelve ningún número para el WABA (sin guardar nada en la base)', async () => {
    const fetchMock = fetchMockPorUrl({ phoneNumbers: respuestaFetch(true, { data: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(502);
    expect(dbMock.upsertLlamadas).toHaveLength(0);
  });

  it('corta con 502 si el número se resuelve bien pero falla la suscripción a webhooks (sin guardar nada)', async () => {
    const fetchMock = fetchMockPorUrl({ subscribe: respuestaFetch(false, { error: { message: 'no se pudo suscribir' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(502);
    expect(dbMock.upsertLlamadas).toHaveLength(0); // no queda un estado a medias en empresa_whatsapp
  });

  it('si falla la consulta de verified_name, el alta igual se completa (no es crítico)', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('fields=verified_name')) throw new Error('timeout consultando verified_name');
      return fetchMockPorUrl().getMockImplementation()(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.verified_name).toBeNull();
    expect(dbMock.upsertLlamadas).toHaveLength(1);
  });

  it('devuelve 500 con mensaje claro si Meta acepta todo pero falla el guardado en la base', async () => {
    dbMock.upsertResultado = { error: { message: 'connection reset' } };
    const fetchMock = fetchMockPorUrl();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(500);
  });

  it('no revienta (500 genérico) si Meta corta la conexión en cualquier paso', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network error'));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(500);
    expect(dbMock.upsertLlamadas).toHaveLength(0);
  });
});

// ── Coexistencia (migración 436) ────────────────────────────────────────
// "Onboard WhatsApp Business app users": el postMessage de Meta para este
// flujo solo trae `waba_id` (sin `phone_number_id`), así que el handler
// tiene que resolverlo server-to-server vía GET /{waba_id}/phone_numbers,
// y saltear /register porque el número ya está registrado en la app.
describe('whatsappEmbeddedSignupHandler — Coexistencia (resolución de phone_number_id)', () => {
  const BODY_COEXISTENCIA = { code: 'code-123', waba_id: 'waba-1' };

  it('resuelve el phone_number_id vía /phone_numbers server-to-server, y saltea /register', async () => {
    const fetchMock = fetchMockPorUrl({ phoneNumbers: respuestaFetch(true, { data: [{ id: 'pnid-coexistencia' }] }), verifiedName: respuestaFetch(true, { verified_name: 'Kiosco Coexistencia' }) });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_COEXISTENCIA }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.phone_number_id).toBe('pnid-coexistencia');
    expect(res.body.es_coexistencia).toBe(true);

    const urlsLlamadas = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urlsLlamadas.some((u) => u.endsWith('/register'))).toBe(false);
    expect(urlsLlamadas.some((u) => u.includes('/phone_numbers'))).toBe(true);

    expect(dbMock.upsertLlamadas).toHaveLength(1);
    const payload = dbMock.upsertLlamadas[0].payload;
    expect(payload.es_coexistencia).toBe(true);
    expect(payload.phone_number_id).toBe('pnid-coexistencia');
    expect(payload.register_pin).toBeNull();
    expect(payload.desconectado_en).toBeNull();
  });

  // FIX (2026-08-04): el handler ya no lee `phone_number_id` del body en
  // absoluto (ver destructuring de `req.body` más arriba: solo `code` y
  // `waba_id`) — el postMessage FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING de
  // Meta nunca lo trae, así que siempre se resuelve vía /phone_numbers,
  // aunque el frontend mande ese campo igual.
  it('ignora phone_number_id si el frontend lo manda de todos modos; igual resuelve vía /phone_numbers', async () => {
    const fetchMock = fetchMockPorUrl();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: { ...BODY_COEXISTENCIA, phone_number_id: 'pnid-ya-conocido' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.phone_number_id).toBe('pnid-1'); // el que devuelve /phone_numbers, no el del body
    const urlsLlamadas = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urlsLlamadas.some((u) => u.includes('/phone_numbers'))).toBe(true);
  });

  it('rechaza con 400 si falta waba_id', async () => {
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: { code: 'code-123' } }, res);

    expect(res.statusCode).toBe(400);
  });

  it('corta con 502 si Meta no devuelve ningún número para el WABA', async () => {
    const fetchMock = fetchMockPorUrl({ phoneNumbers: respuestaFetch(true, { data: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await whatsappEmbeddedSignupHandler({ method: 'POST', body: BODY_COEXISTENCIA }, res);

    expect(res.statusCode).toBe(502);
    expect(dbMock.upsertLlamadas).toHaveLength(0);
  });
});
