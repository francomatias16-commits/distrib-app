# v660 — Fix de los 2 problemas pendientes de v659 (83/90 → verificado sin esos 7 fallos)

Primera vez que se corrió la suite E2E completa contra un browser real
(este sandbox trae Chromium preinstalado, a diferencia del de v659). Con
eso se confirmaron y arreglaron los 2 problemas que habían quedado
diagnosticados pero sin aplicar: scope del Service Worker mal calculado, y
el 404 puntual en `login.html` + 5 páginas admin.

## 1. Scope del Service Worker

`vercel.json` manda el header `Service-Worker-Allowed` para los 4
`sw-*.js` — sin eso, `sw-admin.js` (que vive en `/frontend/admin/` pero
pide `scope: '/'`) no puede registrarse fuera de `/frontend/admin/`.
`tests/e2e/helpers/static-server.js` no replicaba ningún header.

**Fix**: `static-server.js` ahora manda `Service-Worker-Allowed` en los 4
scripts, con el mismo scope que declara `vercel.json` (`/`, `/chofer`,
`/cliente`, `/proveedor`).

## 2. 404 en login + 5 páginas admin

`cta-cte.html`, `liquidacion.html`, `lotes.html` y `presupuestos.html` son
stubs de redirect (`location.replace('/admin/<algo>')`) a URLs limpias sin
`.html`; `login.html` y `suspendida.html` redirigen igual tras resolver
sesión (a `/admin/dashboard`, `/setup`, etc.). `vercel.json` tiene ~90
reglas de rewrite 1:1 para esas URLs limpias que `static-server.js` no
replicaba.

**Fix**: en vez de copiar las ~90 entradas de `vercel.json` (se
desincroniza fácil), `static-server.js` resuelve genéricamente
`/<portal>/<slug>` sin extensión contra `/frontend/<portal>/<slug>.html`
si existe en disco, más un mapa chico para las pocas excepciones donde el
slug no coincide 1:1 con el archivo (`/admin` → `dashboard.html`, `/setup`
→ `/frontend/admin/setup.html`, `/cliente` → `inicio.html`, `/chofer` →
`index.html`, copiadas literal de `vercel.json`).

## Verificación

Ambos fixes verificados con Playwright real (no solo lectura de código):
reproduje el error exacto de cada uno sin el fix, confirmé que desaparece
con el fix aplicado. Detalle completo, incluida una limitación de red de
este sandbox que no tiene que ver con el código (bloquea `cdn.jsdelivr.net`,
de donde carga `supabase-js`), en `PLAN_E2E_COBERTURA_TOTAL.md`, sección 11.

## Archivos

- **`tests/e2e/helpers/static-server.js`** — header `Service-Worker-Allowed`
  + resolución de URLs limpias de página (rewrite genérico + alias chico).
- **`PLAN_E2E_COBERTURA_TOTAL.md`** — sección 11, nueva: qué se corrió, qué
  se arregló, y la limitación de red del sandbox (documentada para no
  confundirla con un bug real en una próxima vuelta).

## Pendiente

- Correr `npm run test:e2e` completo en un entorno con salida real a
  `cdn.jsdelivr.net`/`cdn.playwright.dev` (tu máquina o CI) para confirmar
  83/90 → 90/90 (acá solo se pudo confirmar spec por spec, filtrando a mano
  el ruido de red del sandbox).
- `admin/pedidos.spec.js` (piloto Fase 1) corrió por primera vez contra
  browser real hoy y pasa — el resto de Fase 1 (8 páginas P0 más) sigue sin
  validar contra código real.
