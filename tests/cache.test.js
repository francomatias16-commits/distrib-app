// tests/cache.test.js
//
// Etapa 3 del PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md — lib/cache.js
// no tenía cobertura propia (tampoco la tenía el piloto de KPIs que lo usa
// primero). Se cubre acá el módulo compartido en vez de mockearlo por cada
// handler que lo consuma (KPIs del dashboard, catálogo de cliente) — así
// cualquier handler nuevo que lo use hereda esta garantía sin duplicar tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cacheado, invalidar } from '../lib/cache.js';

describe('lib/cache.js — cacheado()', () => {
  it('la segunda llamada con la misma clave no vuelve a ejecutar calcular()', async () => {
    const calcular = vi.fn(async () => ({ valor: 1 }));

    const a = await cacheado('clave-1', 10_000, calcular);
    const b = await cacheado('clave-1', 10_000, calcular);

    expect(a).toEqual({ valor: 1 });
    expect(b).toEqual({ valor: 1 });
    expect(calcular).toHaveBeenCalledTimes(1);
  });

  it('claves distintas nunca comparten resultado (scope por empresa/filtros)', async () => {
    const calcularA = vi.fn(async () => 'resultado-A');
    const calcularB = vi.fn(async () => 'resultado-B');

    const a = await cacheado('empresa-1:pagina-1', 10_000, calcularA);
    const b = await cacheado('empresa-2:pagina-1', 10_000, calcularB);

    expect(a).toBe('resultado-A');
    expect(b).toBe('resultado-B');
    expect(calcularA).toHaveBeenCalledTimes(1);
    expect(calcularB).toHaveBeenCalledTimes(1);
  });

  it('vuelve a ejecutar calcular() una vez vencido el TTL', async () => {
    vi.useFakeTimers();
    try {
      const calcular = vi.fn(async () => Date.now());

      await cacheado('clave-ttl', 1_000, calcular);
      vi.advanceTimersByTime(1_001);
      await cacheado('clave-ttl', 1_000, calcular);

      expect(calcular).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fail-open: si calcular() tira, no cachea nada y el error sube tal cual', async () => {
    const error = new Error('boom');
    const calcular = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok-recien-ahora');

    await expect(cacheado('clave-error', 10_000, calcular)).rejects.toThrow('boom');

    // Un dato viejo en caché nunca debe esconder un error real de la
    // próxima consulta — el siguiente llamado tiene que intentar de nuevo,
    // no servir nada cacheado (no había nada válido para servir).
    const resultado = await cacheado('clave-error', 10_000, calcular);
    expect(resultado).toBe('ok-recien-ahora');
    expect(calcular).toHaveBeenCalledTimes(2);
  });

  it('invalidar() fuerza que la próxima lectura recalcule', async () => {
    const calcular = vi.fn(async () => 'valor');

    await cacheado('clave-inv', 60_000, calcular);
    invalidar('clave-inv');
    await cacheado('clave-inv', 60_000, calcular);

    expect(calcular).toHaveBeenCalledTimes(2);
  });
});
