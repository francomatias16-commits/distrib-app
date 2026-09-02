# v446 — Fase 4.1 del plan de acción (parte 2): Sentry en el frontend

**Contexto:** continúa `CHANGELOG_v445_fase4.1_sentry_backend.md`, que
cerró Sentry en el dispatcher (`api/index.js`). Esta entrega agrega la
otra mitad: error tracking en el navegador, sobre las 56 páginas del
frontend (admin, cliente, chofer).

## Por qué en `env-config.js` y no en cada HTML

Las 56 páginas del frontend ya incluyen `frontend/env-config.js` — es el
primer `<script>` de la lista en todas ellas, y es justamente lo que se
había relevado en la sesión anterior (conteo de páginas que lo incluyen)
como paso previo para decidir dónde enganchar Sentry. Insertar el
bootstrap ahí evita tocar 56 archivos HTML con formatos de `<script>`
levemente distintos entre sí (`defer` en unos, query strings de versión
distintas en otros) y da un solo punto de mantenimiento.

## Qué hace

- `frontend/env-config.js`:
  - Nueva clave pública `window.ENV.SENTRY_DSN` (vacía por defecto). Igual
    que `SUPABASE_ANON_KEY` o las claves de Firebase que ya vivían en este
    archivo, el DSN de Sentry está pensado para ir en código cliente — no
    es secreto, cualquiera puede verlo en el bundle igual.
  - Al final del archivo, una función `bootstrapSentry()` que:
    - No hace nada si `SENTRY_DSN` está vacío (el default) — cero impacto
      mientras no se configure.
    - Si hay DSN, inyecta el bundle oficial de Sentry vía su CDN
      (`browser.sentry-cdn.com/10.68.0/bundle.min.js` — misma versión
      10.68.0 que `@sentry/node` en el backend, sin necesidad de bundler
      ni de agregar el paquete a `package.json` porque el frontend de este
      proyecto no pasa por un bundler de módulos para terceros, solo
      `esbuild` sobre el JS propio).
    - Al cargar ese bundle, llama `Sentry.init()` con el mismo DSN y con
      `environment` inferido por hostname (`localhost`/`127.0.0.1` →
      `development`, cualquier otra cosa → `production`) — no hay
      `VERCEL_ENV` disponible en el navegador, así que esto es lo más
      simple que se puede hacer sin agregar infraestructura nueva.
    - `tracesSampleRate: 0`, igual criterio que el backend: por ahora solo
      error tracking, no performance tracing.

## Pendiente

- Completar `SENTRY_DSN` en `env-config.js` cuando el proyecto de Sentry
  esté creado (puede ser el mismo proyecto de Sentry que usa el backend,
  con DSN propio, o uno separado — según se prefiera separar señal
  backend/frontend en el dashboard de Sentry).
- `plan-de-accion.md` (marcar 4.1 completa — no está en este export del
  proyecto, marcar en el repo real).

## Verificado en esta entrega

- `node --check frontend/env-config.js` OK.
- Con `SENTRY_DSN` vacío (el estado actual del archivo), `bootstrapSentry()`
  corta en el primer `if` y no inyecta ningún script — comportamiento
  idéntico al de antes de este cambio en las 56 páginas.
- No se probó contra un DSN real (no hay proyecto de Sentry creado
  todavía) — queda para cuando se complete el paso pendiente de arriba.

## Archivos

- `frontend/env-config.js` (`SENTRY_DSN` + bootstrap del Sentry Browser SDK)
