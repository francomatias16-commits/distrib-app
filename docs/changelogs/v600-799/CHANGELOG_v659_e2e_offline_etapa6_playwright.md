# v659 — Etapa 6 (sección 1.2): suite E2E Playwright para offline, + corrida real de vitest sobre v658

Dos cosas separadas en esta entrega.

## 1. Corrida real de `npm test` sobre lo que dejó v658

`proveedor-offline.test.js` (14 tests) y el resto de la suite (47 archivos,
948 tests) corren en verde con `vitest run` real — instalé `node_modules`
en un entorno con salida a `registry.npmjs.org` (el sandbox donde se armó
v658 no la tenía). Se puede sacar del changelog de v658 la nota de
"falta correr con npm test real antes de mergear".

## 2. Suite E2E (Playwright) — sección 1.2 del plan Etapa 6

Nuevo: `tests/e2e/` — 14 tests Playwright cubriendo, para los 4 portales
con módulo offline propio (proveedor, chofer, cliente, pos), los 3
escenarios de la sección 1.2 de `PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md`
que ningún test unitario puede cubrir (necesitan IndexedDB/Dexie/eventos
online-offline/Service Worker reales, no mockeados):

1. Modo avión a mitad de la operación.
2. Cerrar la pestaña a mitad del sync (persistencia del outbox en
   IndexedDB across reload, sin duplicar).
3. Reconexión intermitente — sin disparar dos syncs en paralelo.

Más un test de conflicto (rechazo 4xx real) por módulo, donde aplica.

**Hallazgo a validar**: `offline-core.js::sincronizarPendientes()` chequea
`syncEnCurso` de forma síncrona pero lo setea en `true` recién después de
un `await getContexto()` — ventana de carrera teórica si dos eventos
`online` se disparan seguidos (reconexión intermitente real). El test de
"reconexión intermitente" de cada spec está armado para exponer esto si
se manifiesta. **No se pudo confirmar si se manifiesta de verdad** — ver
limitación de abajo.

### No se pudo ejecutar en este entorno (bloqueo de red, no de código)

`npx playwright install chromium` devuelve 403: `cdn.playwright.dev` no
está en la allowlist de este sandbox (`registry.npmjs.org` sí lo está,
por eso `node_modules` se pudo instalar bien). Quedó todo verificado
hasta donde se pudo sin browser (sintaxis, `playwright test --list`,
servidor estático probado standalone) — falta correr `npm run test:e2e`
de verdad en un entorno con esa salida de red antes de dar por cerrado el
punto 1.2. Detalle completo en `tests/e2e/README.md`.

## Archivos

- **Nuevo** `tests/e2e/README.md` — alcance, decisiones de diseño
  (UI real vs. nivel de módulo por portal), y la limitación de arriba.
- **Nuevo** `tests/e2e/helpers/static-server.js` — sirve el repo real
  (no un dist ni un mock) para que los tests peguen contra los mismos
  archivos que sirve producción.
- **Nuevo** `tests/e2e/helpers/mock-network.js` — vendoriza Dexie (evita
  depender de `cdn.jsdelivr.net` en CI) y mockea endpoints de API con
  contador de llamadas (clave para detectar duplicados).
- **Nuevo** `tests/e2e/fixtures/vendor/dexie.min.js` — copia de
  `node_modules/dexie` (misma versión que el `<script>` de producción).
- **Nuevo** `tests/e2e/fixtures/harness-{chofer,cliente,pos}.html` — NO
  son páginas de producción: cargan los mismos `<script>` reales que
  `remito.html`/`carrito.html`/`pos.html` sin necesitar sesión de
  Supabase Auth completa. Ver README para el porqué de este alcance.
- **Nuevo** `tests/e2e/specs/{proveedor,chofer,cliente,pos}.spec.js`.
- **Nuevo** `playwright.config.e2e.js` — config separada, no pisa un
  eventual `playwright.config.js` futuro para otra cosa.
- **`package.json`** — suma `playwright`/`@playwright/test` a
  devDependencies y los scripts `test:e2e`/`test:e2e:ui`.

## Pendiente

- Correr `npm run test:e2e` de verdad (requiere `npx playwright install
  chromium` en un entorno con red completa) y confirmar/descartar la
  carrera de `syncEnCurso`.
- `stock-offline.js`/`cobros-offline.js` (viven en el portal admin junto
  a `pos-offline.js`) quedaron afuera de esta pasada — el patrón para
  sumarlos está documentado en el README.
- Sección 1.3 del plan (manual, dos dispositivos) sigue sin arrancar —
  no es automatizable.
