// tests/lib/auth-helpers-cache.test.js
//
// Cubre el fix (2026-08-29, incidente "Supabase API Gateway: Degraded
// Performance") sobre lib/auth-helpers.js#getUserSeguro:
//
//   1) timeout por defecto 8s → 3s
//   2) caché en memoria de getUser() por token (TTL, solo resultados OK,
//      deshabilitada en NODE_ENV=test, invalidable con limpiarCacheAuth)
//
// AUTH_CACHE_ENABLED se lee una sola vez al importar el módulo (según
// process.env.NODE_ENV en ese momento), así que estos tests fuerzan
// NODE_ENV='production' y hacen vi.resetModules() + import dinámico ANTES
// de leer el módulo, para poder ejercitar la caché sin afectar al resto de
// la suite (que corre con NODE_ENV='test' y por lo tanto con la caché
// desactivada — ver comentario en auth-helpers.js).

import { vi, describe, it, expect, afterEach } from 'vitest';

const NODE_ENV_ORIGINAL = process.env.NODE_ENV;

async function cargarModulo(nodeEnv) {
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  return import('../../lib/auth-helpers.js');
}

describe('getUserSeguro — timeout por defecto', () => {
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV_ORIGINAL;
    vi.useRealTimers();
  });

  it('corta a los 3s (no a los 8s) cuando Supabase no contesta', async () => {
    vi.useFakeTimers();
    const { getUserSeguro } = await cargarModulo('production');
    const sb = { auth: { getUser: () => new Promise(() => {}) } }; // nunca resuelve

    const promesa = getUserSeguro(sb, 'token-lento');
    const assertion = expect(promesa).rejects.toMatchObject({ esTimeoutAuth: true });

    await vi.advanceTimersByTimeAsync(2999);
    // Todavía no debería haber cortado
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });
});

describe('getUserSeguro — caché en memoria (NODE_ENV != test)', () => {
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV_ORIGINAL;
  });

  it('no repite la consulta de red dentro del TTL para el mismo token', async () => {
    const { getUserSeguro } = await cargarModulo('production');
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    const sb = { auth: { getUser } };

    const r1 = await getUserSeguro(sb, 'token-abc');
    const r2 = await getUserSeguro(sb, 'token-abc');

    expect(r1.data.user.id).toBe('u1');
    expect(r2.data.user.id).toBe('u1');
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('nunca cachea un resultado de error (token inválido no queda pegado)', async () => {
    const { getUserSeguro } = await cargarModulo('production');
    const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
    const sb = { auth: { getUser } };

    await getUserSeguro(sb, 'token-malo');
    await getUserSeguro(sb, 'token-malo');

    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('tokens distintos no comparten entrada de caché', async () => {
    const { getUserSeguro } = await cargarModulo('production');
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    const sb = { auth: { getUser } };

    await getUserSeguro(sb, 'token-1');
    await getUserSeguro(sb, 'token-2');

    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('limpiarCacheAuth(token) fuerza a repetir la consulta para ese token', async () => {
    const { getUserSeguro, limpiarCacheAuth } = await cargarModulo('production');
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    const sb = { auth: { getUser } };

    await getUserSeguro(sb, 'token-abc');
    limpiarCacheAuth('token-abc');
    await getUserSeguro(sb, 'token-abc');

    expect(getUser).toHaveBeenCalledTimes(2);
  });
});

describe('getUserSeguro — caché deshabilitada bajo NODE_ENV=test', () => {
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV_ORIGINAL;
  });

  it('siempre repite la consulta de red (comportamiento normal de la suite)', async () => {
    const { getUserSeguro } = await cargarModulo('test');
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    const sb = { auth: { getUser } };

    await getUserSeguro(sb, 'token-abc');
    await getUserSeguro(sb, 'token-abc');

    expect(getUser).toHaveBeenCalledTimes(2);
  });
});
