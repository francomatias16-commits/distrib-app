// tests/lib/circuit-breaker-timeout-override.test.js
//
// FIX (timeout largo del asistente de IA, 3 proveedores): responderConFallback
// (ver lib/asistente-providers.js) necesita poder acotar cada llamada a un
// timeout MENOR que el configurado en el breaker, para repartir un
// presupuesto de tiempo total entre gemini/groq/openrouter en vez de
// dejar que cada uno consuma su propio timeoutMs completo sin importar
// cuánto ya se gastó en los anteriores. Este test cubre el contrato nuevo
// de CircuitBreaker.exec(fn, timeoutMsOverride) de forma aislada, sin
// depender de la red ni de los adaptadores de IA.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../lib/circuit-breaker.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CircuitBreaker.exec con timeoutMsOverride', () => {
  it('sin override, respeta this.timeoutMs (comportamiento de siempre)', async () => {
    const breaker = new CircuitBreaker({ name: 'test', timeoutMs: 5000, umbralFallas: 10 });

    const promesa = breaker.exec(() => sleep(10_000).then(() => 'nunca-llega'));
    const expectacion = expect(promesa).rejects.toThrow(/Timeout 5000ms/);

    await vi.advanceTimersByTimeAsync(5001);
    await expectacion;
  });

  it('con override MENOR que this.timeoutMs, corta antes', async () => {
    const breaker = new CircuitBreaker({ name: 'test', timeoutMs: 20_000, umbralFallas: 10 });

    const promesa = breaker.exec(() => sleep(10_000).then(() => 'nunca-llega'), 2_000);
    const expectacion = expect(promesa).rejects.toThrow(/Timeout 2000ms/);

    await vi.advanceTimersByTimeAsync(2001);
    await expectacion;
  });

  it('con override MAYOR que this.timeoutMs, igual se resuelve si fn termina rápido', async () => {
    const breaker = new CircuitBreaker({ name: 'test', timeoutMs: 1000, umbralFallas: 10 });

    const promesa = breaker.exec(() => sleep(500).then(() => 'ok'), 30_000);
    await vi.advanceTimersByTimeAsync(500);

    await expect(promesa).resolves.toBe('ok');
  });

  it('un override negativo o ínfimo corta casi de inmediato', async () => {
    const breaker = new CircuitBreaker({ name: 'test', timeoutMs: 20_000, umbralFallas: 10 });

    const promesa = breaker.exec(() => sleep(5000).then(() => 'nunca-llega'), 10);
    const expectacion = expect(promesa).rejects.toThrow(/Timeout 10ms/);

    await vi.advanceTimersByTimeAsync(11);
    await expectacion;
  });
});
