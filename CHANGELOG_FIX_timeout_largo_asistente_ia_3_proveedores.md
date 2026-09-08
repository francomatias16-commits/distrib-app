# FIX: timeout largo del asistente de IA (cadena de 3 proveedores)

## Diagnóstico

`responderConFallback()` (lib/asistente-providers.js) encadena gemini →
groq → openrouter, protegiendo cada uno con su propio CircuitBreaker.
Cada `breaker.exec()` corta la llamada a los `timeoutMs` propios del
breaker (gemini 22s, groq 14s, openrouter 17s), pero esos timeouts están
pensados para UNA llamada aislada — al encadenarse, el peor caso real de
la cadena entera es la SUMA: **22 + 14 + 17 = 53 segundos**.

`api/index.js` tiene `maxDuration: 60` en `vercel.json`. Eso dejaba solo
~7s de margen para todo lo demás del handler (auth, búsqueda semántica
RAG, guardar mensajes en Supabase) — margen que en la práctica ya se
consume solo. Resultado en producción: Vercel mata la función a los 60s
sin que el usuario reciba ni siquiera el mensaje de error prolijo que
arma `responderConFallback()` ("los 3 proveedores fallaron") — un timeout
silencioso, peor que una falla clara.

Además, `generarEmbeddingPregunta()` (lib/handlers/asistente.js), que
corre ANTES de llegar a `responderConFallback()`, no tenía ningún timeout
propio (a diferencia de `fetchConTimeout` en asistente-providers.js) — un
fetch que Google no respondiera podía quedar colgado sin límite, y
además seguía mandando la key por query string (`?key=...`), el mismo
patrón ya identificado como frágil (401 `ACCESS_TOKEN_TYPE_UNSUPPORTED`
con las keys nuevas tipo "Auth key") y ya corregido en
asistente-providers.js.

## Cambios

- **lib/circuit-breaker.js**: `exec(fn, timeoutMsOverride?)` — permite
  pasar un timeout puntual menor (o mayor) al configurado en el breaker,
  sin romper a ningún caller existente (parámetro opcional, todos los
  demás `.exec(fn)` del proyecto siguen igual).
- **lib/asistente-providers.js**: `responderConFallback()` ahora reparte
  un **presupuesto total de 30s** entre los 3 proveedores en vez de
  dejar que cada uno gaste su timeout completo sin importar cuánto ya se
  gastó antes. Si a un proveedor no le queda presupuesto mínimo (2s), se
  lo saltea directamente (queda documentado en el detalle del error) en
  vez de intentarlo con un timeout inútil. Peor caso nuevo: **~30s**
  (antes ~53s).
- **lib/handlers/asistente.js**: `generarEmbeddingPregunta()` ahora usa
  `AbortController` con timeout de 8s por intento (antes: sin límite) y
  manda la API key por header `x-goog-api-key` (antes: query string
  `?key=...`).

## Presupuesto total del handler tras el fix

```
embedding (RAG, peor caso)  ~17s   (2 intentos x 8s + backoff)
cadena de 3 proveedores IA  ~30s   (presupuesto nuevo)
resto del handler (auth,
  DB, guardar mensajes)     margen ~13s dentro del maxDuration de 60s
```

## Tests agregados

- `tests/lib/circuit-breaker-timeout-override.test.js`: contrato del
  nuevo parámetro `timeoutMsOverride` de `CircuitBreaker.exec()`.
- `tests/lib/asistente-providers-presupuesto.test.js`: con fetch
  mockeado (sin red real) y fake timers, verifica que la cadena completa
  no excede el presupuesto nuevo y que un proveedor sin margen se
  saltea en vez de intentarse.

Se corrió la suite completa del proyecto (`npx vitest run`): 1920/1920
tests pasan en todo lo tocado por este fix. Hay 1 suite preexistente
(`tests/handlers/cliente-en-mora-listener.test.js`) que falla por un
problema de aislamiento de mocks entre `eventos-dispatcher.js` y
`notif.js` — no relacionado con este cambio ni con el fix anterior
(FIX-CPU-01); no se tocó nada de eso acá.

## Pendiente (no incluido en este fix)

- `tests/handlers/cliente-en-mora-listener.test.js` falla en la suite
  completa (aunque corrido solo, probablemente pase) — mockea
  `lib/handlers/notif.js` con un solo export, y algún otro listener
  importado transitivamente por `eventos-dispatcher.js` necesita otro
  export de ese módulo que queda `undefined`, rompiendo
  `TIPOS_EVENTO_SIN_LISTENER` al cargar el módulo.
