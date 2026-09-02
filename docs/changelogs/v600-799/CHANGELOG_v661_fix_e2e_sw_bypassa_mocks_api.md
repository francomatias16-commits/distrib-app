# v661 — Fix de los 3 fallos que dejó v660 (87/90 → 90/90)

## Diagnóstico

Los 3 fallos (`empresa-config.html`, `liquidacion.html`, `pos.html`, todos
"Admin — con sesión") tenían la misma causa raíz, no 3 bugs distintos:

`sw-admin.js` (Service Worker del portal admin) usa una estrategia
**stale-while-revalidate** para varios patrones de `/api/*`
(`SWR_PATTERNS`, incluye `/api/empresa/*`, `/api/lotes*`, `/api/pos/cajas*`
entre otros). Esa estrategia, dentro del propio Service Worker, hace su
**propio** `fetch(req)` para revalidar caché en segundo plano
(`staleWhileRevalidate()` en `sw-admin.js`).

Esa request nace en el scope del Service Worker, no en el de la página —
así que `page.route()` de Playwright (que solo intercepta el pipeline de
red de la *página*) nunca la ve. La request real sale, pega contra
`static-server.js` (que sirve archivos, no `/api/*`), y vuelve un 404 de
verdad — que sí queda visible en la consola de la página (DevTools loguea
ahí cualquier fetch fallido del cliente, sea de la página o de su SW), y
en el caso de `pos.html`, ese 404 es la respuesta que efectivamente recibe
`apiGet('/api/pos/cajas')`, de ahí el `Error: Error de red` en consola.

**Por qué apareció recién en v661 y no antes**: hasta v659, `sw-admin.js`
fallaba en registrarse (scope mal calculado, ver `CHANGELOG_v660`), así
que nunca llegó a activarse ni a interceptar nada — el bug estaba ahí pero
dormido. v660 arregló el registro (correctamente), y al hacerlo "despertó"
esta interferencia con el harness de test. **No es una regresión de v660
ni un bug de la app**: en producción esa misma request de revalidación sí
sale a internet real y resuelve bien: es un artefacto de correr contra un
static-server de test que no implementa `/api/*`.

Confirmado con Playwright real: con `serviceWorkers: 'allow'` (default)
reproduje el 404 de los 3 endpoints exactos; con `serviceWorkers: 'block'`
desaparecen sin tocar nada más. Ningún spec de esta suite (revisé los 8
archivos de `tests/e2e/specs/`) depende de que el Service Worker esté
realmente activo — todos mockean red vía `page.route`/`mockApi` e
IndexedDB vía Dexie vendorizado, no vía la caché del SW.

## Fix

**`playwright.config.e2e.js`** — `serviceWorkers: 'block'` en `use`, con
el razonamiento completo en un comentario (para que si en el futuro se
agrega un spec que sí necesite el SW real, quede claro por qué está
bloqueado acá y qué haría falta para habilitarlo solo en ese spec, ej. un
`test.use({ serviceWorkers: 'allow' })` puntual).

## Verificación

Reproduje el fallo exacto (mismos 3 endpoints, mismo mensaje) y confirmé
que desaparece con el fix, corriendo Playwright real contra el
static-server real (no solo lectura de código). Nota: el sandbox donde
verifiqué esto bloquea `fonts.googleapis.com`/`firebasejs`/`sentry-cdn`
(ninguno de estos tiene que ver con el bug — son CDNs externas que en tu
máquina con internet real cargan bien, y de hecho aparecen igual en
páginas que ya pasaban antes, como `dashboard.html` o `cajas.html`, así
que no son parte de este fix).

## Pendiente

- Correr `npm run test:e2e` completo en tu máquina (con salida real a
  internet) para confirmar 90/90.
