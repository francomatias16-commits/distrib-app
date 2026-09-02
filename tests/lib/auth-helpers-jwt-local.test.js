// tests/lib/auth-helpers-jwt-local.test.js
//
// Cubre el fix (2026-08-29, opción 1) sobre lib/auth-helpers.js#getUserSeguro:
// verificación local del JWT contra el JWKS público del proyecto, sin red a
// Supabase Auth, con fallback automático al camino remoto (sb.auth.getUser)
// cuando el token no es verificable localmente (firmado con el secreto
// legacy HS256, JWKS inalcanzable, vencido, etc.)
//
// Igual que en auth-helpers-cache.test.js: AUTH_CACHE_ENABLED y el gate del
// JWKS se leen una sola vez al importar el módulo según NODE_ENV en ese
// momento, así que forzamos NODE_ENV='production' + vi.resetModules() +
// import dinámico para poder ejercitar el camino local sin afectar al resto
// de la suite (que corre con NODE_ENV='test', donde este camino está
// desactivado a propósito).
//
// El JWKS remoto se sirve con un fetch mockeado (createRemoteJWKSet usa el
// `fetch` global por default), evitando cualquier llamada de red real.

import { vi, describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const NODE_ENV_ORIGINAL   = process.env.NODE_ENV;
const SUPABASE_URL_TEST   = 'https://test-project.supabase.co';
const ISSUER              = `${SUPABASE_URL_TEST}/auth/v1`;

async function cargarModulo(nodeEnv, supabaseUrl = SUPABASE_URL_TEST) {
  process.env.NODE_ENV = nodeEnv;
  if (supabaseUrl) process.env.SUPABASE_URL = supabaseUrl;
  else delete process.env.SUPABASE_URL;
  vi.resetModules();
  return import('../../lib/auth-helpers.js');
}

async function crearParDeClaves() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  return { publicJwk: jwk, privateKey };
}

function mockearFetchJWKS(publicJwk) {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('/.well-known/jwks.json')) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`fetch no mockeado para: ${url}`);
  });
}

async function firmarTokenES256(privateKey, payloadExtra = {}) {
  return new SignJWT({
    role: 'authenticated',
    email: 'user@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: { nombre: 'Test' },
    ...payloadExtra,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject('u1-uuid')
    .setExpirationTime('1h')
    .sign(privateKey);
}

describe('getUserSeguro — verificación local vía JWKS', () => {
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV_ORIGINAL;
    delete globalThis.fetch;
    vi.unstubAllGlobals();
  });

  it('valida el token localmente y NO llama a sb.auth.getUser', async () => {
    const { publicJwk, privateKey } = await crearParDeClaves();
    mockearFetchJWKS(publicJwk);

    const { getUserSeguro } = await cargarModulo('production');
    const token = await firmarTokenES256(privateKey);

    const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: null });
    const sb = { auth: { getUser } };

    const { data, error } = await getUserSeguro(sb, token);

    expect(error).toBeNull();
    expect(data.user.id).toBe('u1-uuid');
    expect(data.user.email).toBe('user@example.com');
    expect(data.user.user_metadata).toEqual({ nombre: 'Test' });
    expect(getUser).not.toHaveBeenCalled();
  });

  it('cae al camino remoto si el token está firmado con otra clave (legacy/rotada)', async () => {
    const { publicJwk } = await crearParDeClaves();
    const { privateKey: otraPrivateKey } = await crearParDeClaves(); // clave distinta a la publicada
    mockearFetchJWKS(publicJwk);

    const { getUserSeguro } = await cargarModulo('production');
    const tokenFirmadoConOtraClave = await firmarTokenES256(otraPrivateKey);

    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u1-uuid' } }, error: null });
    const sb = { auth: { getUser } };

    const { data, error } = await getUserSeguro(sb, tokenFirmadoConOtraClave);

    expect(error).toBeNull();
    expect(data.user.id).toBe('u1-uuid');
    expect(getUser).toHaveBeenCalledTimes(1); // no se resolvió local, tuvo que ir a Supabase
  });

  it('cae al camino remoto si el JWKS es inalcanzable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network unreachable'); });

    const { getUserSeguro } = await cargarModulo('production');
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u1-uuid' } }, error: null });
    const sb = { auth: { getUser } };

    const { data, error } = await getUserSeguro(sb, 'cualquier-token-legacy');

    expect(error).toBeNull();
    expect(data.user.id).toBe('u1-uuid');
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('sin SUPABASE_URL configurada, no intenta verificación local (va directo al camino remoto)', async () => {
    const { getUserSeguro } = await cargarModulo('production', null);
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u1-uuid' } }, error: null });
    const sb = { auth: { getUser } };

    const { data } = await getUserSeguro(sb, 'token-cualquiera');

    expect(data.user.id).toBe('u1-uuid');
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('bajo NODE_ENV=test nunca intenta la verificación local, aunque haya SUPABASE_URL', async () => {
    const { publicJwk, privateKey } = await crearParDeClaves();
    mockearFetchJWKS(publicJwk);

    const { getUserSeguro } = await cargarModulo('test');
    const token = await firmarTokenES256(privateKey);

    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u1-uuid' } }, error: null });
    const sb = { auth: { getUser } };

    await getUserSeguro(sb, token);

    // Ni siquiera para un token localmente válido: en test siempre pasa
    // por el mock de sb.auth.getUser (comportamiento normal de la suite).
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});
