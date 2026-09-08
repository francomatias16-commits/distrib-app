// tests/lib/asistente-providers-presupuesto.test.js
//
// FIX (timeout largo del asistente de IA, 3 proveedores): antes,
// responderConFallback() (lib/asistente-providers.js) dejaba que cada
// proveedor de la cadena (gemini -> groq -> openrouter) consumiera su
// propio timeoutMs de circuit breaker completo, sin importar cuánto
// tiempo ya se había gastado en los anteriores. Peor caso: 22s + 14s +
// 17s = 53s, contra un maxDuration de 60s en vercel.json — dejaba ~7s de
// margen para todo lo demás del handler (auth, RAG, guardar mensajes),
// resultando en que Vercel mataba la función sin que el usuario recibiera
// ninguna respuesta.
//
// Este test verifica, con fetch mockeado (sin red real) y fake timers,
// que:
//   1) la cadena completa no excede el presupuesto total configurado
//      (bastante menor a los ~53s de antes), y
//   2) si a un proveedor no le queda presupuesto mínimo razonable, se lo
//      saltea en vez de intentarlo con un timeout inútil.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'];
let envOriginal;
let fetchOriginal;

beforeEach(() => {
  envOriginal = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  fetchOriginal = global.fetch;
  vi.useFakeTimers();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envOriginal[k] === undefined) delete process.env[k];
    else process.env[k] = envOriginal[k];
  }
  global.fetch = fetchOriginal;
  vi.useRealTimers();
  vi.resetModules();
});

// fetch que jamás resuelve por su cuenta (simula un proveedor colgado /
// muy lento) pero SÍ respeta el AbortSignal, como haría un fetch real:
// deja que sea el propio timeout interno (fetchConTimeout) o el timeout
// del circuit breaker el que corte la llamada.
function crearFetchQueSeCuelga(urlsLlamadas) {
  return vi.fn((url, options) => {
    urlsLlamadas.push(url);
    return new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
}

describe('responderConFallback — presupuesto total de tiempo', () => {
  it('no excede ~30s en el peor caso (antes podía llegar a ~53s) y saltea el proveedor sin margen', async () => {
    process.env.GEMINI_API_KEYS = 'fake-gemini-key';
    process.env.GROQ_API_KEY = 'fake-groq-key';
    process.env.OPENROUTER_API_KEY = 'fake-openrouter-key';

    const urlsLlamadas = [];
    global.fetch = crearFetchQueSeCuelga(urlsLlamadas);

    const { responderConFallback } = await import('../../lib/asistente-providers.js');

    const inicio = Date.now();
    let finVirtual = null;
    const promesa = responderConFallback({
      systemPromptConTools: 'sistema con tools',
      systemPromptSinTools: 'sistema sin tools',
      historial: [],
      mensaje: 'hola, tengo una pregunta',
      tools: undefined,
    });
    // Captura el instante (en tiempo virtual) en que la promesa realmente
    // se resuelve — no cuánto tardamos nosotros en terminar de avanzar el
    // reloj después. Esto es lo que hay que comparar contra el peor caso
    // viejo, no el tiempo total que decidimos avanzar en el test.
    promesa.catch(() => {}).finally(() => {
      finVirtual = Date.now();
    });

    const expectacion = expect(promesa).rejects.toThrow(/Los 3 proveedores fallaron/);

    // Avanza el reloj virtual en pasos, dejando que las microtasks/backoffs
    // internos corran entre cada avance, hasta cubrir de sobra el peor
    // caso viejo (53s) y confirmar que la cadena ya terminó bastante antes.
    for (let i = 0; i < 60 && finVirtual === null; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    await expectacion;
    const duracionVirtual = finVirtual - inicio;

    // Antes del fix, el peor caso real era ~53s. Con el presupuesto total
    // nuevo, la cadena de 3 proveedores debe resolverse holgadamente por
    // debajo de eso.
    expect(duracionVirtual).toBeLessThan(35_000);

    // OpenRouter no debería haber tenido presupuesto suficiente para
    // intentarse siquiera: ninguna URL de openrouter.ai debería figurar
    // entre las llamadas de fetch realizadas.
    const llamoAOpenRouter = urlsLlamadas.some((u) => String(u).includes('openrouter.ai'));
    expect(llamoAOpenRouter).toBe(false);

    // Gemini sí debería haberse intentado (es el primero de la cadena).
    const llamoAGemini = urlsLlamadas.some((u) => String(u).includes('generativelanguage.googleapis.com'));
    expect(llamoAGemini).toBe(true);
  }, 15_000);

  it('el mensaje de error final documenta que a un proveedor no le quedó presupuesto', async () => {
    process.env.GEMINI_API_KEYS = 'fake-gemini-key';
    process.env.GROQ_API_KEY = 'fake-groq-key';
    process.env.OPENROUTER_API_KEY = 'fake-openrouter-key';

    global.fetch = crearFetchQueSeCuelga([]);

    const { responderConFallback } = await import('../../lib/asistente-providers.js');

    const promesa = responderConFallback({
      systemPromptConTools: 'sistema con tools',
      systemPromptSinTools: 'sistema sin tools',
      historial: [],
      mensaje: 'hola',
      tools: undefined,
    });

    const expectacion = expect(promesa).rejects.toThrow(/sin presupuesto de tiempo restante/);

    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    await expectacion;
  }, 15_000);
});
