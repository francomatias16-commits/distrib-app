# Suite E2E offline (Playwright) — sección 1.2 del plan Etapa 6

Cierra el punto 1.2 de `PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md`: los
tres escenarios que ningún test unitario (`tests/frontend-offline/*.test.js`)
puede cubrir porque necesitan un browser real (IndexedDB/Dexie, eventos
`online`/`offline`, Service Worker) en vez de mocks de esos APIs.

## ⚠️ Sin ejecutar todavía — bloqueo de red del sandbox, no del código

Instalé Playwright (`npm i -D playwright @playwright/test`, ya quedó en
`package.json`) y armé los 14 tests, pero **no pude correrlos acá**:
`npx playwright install chromium` devuelve 403 porque `cdn.playwright.dev`
no está en la allowlist de este sandbox (mismo tipo de bloqueo que ya
tenías vos con `npm install` en v658, pero un escalón más allá: acá sí
pude instalar `node_modules` porque `registry.npmjs.org` está permitido,
pero el binario de Chromium se descarga de un CDN aparte que no lo está).

Lo que SÍ verifiqué desde acá, sin browser:
- Los 4 archivos de spec y los 2 helpers pasan `node --check` (sintaxis
  ES module válida).
- `playwright test --list` reconoce los 14 tests y arma correctamente el
  árbol de specs (config de Playwright válida).
- El servidor estático (`helpers/static-server.js`) sirve de verdad los
  archivos reales del repo — probé standalone con `fetch()` desde Node
  (sin Playwright) que `/frontend/proveedor/portal.html`,
  `/frontend/shared/offline-core.js`, `/frontend/admin/js/pos-offline.js`
  y los harness de `tests/e2e/fixtures/` devuelven 200.
- Cada llamada `fetch`/endpoint que mockeo (`/api/proveedores`,
  `/api/chofer/remitos/.../no-entregar`, `/api/pedidos`, `/api/pos`) la
  saqué leyendo el código real de cada `*-offline.js`/`portal.js` — no
  inventé shapes de payload.

Lo que falta, y que no se puede cerrar desde este repo (como el punto 3
de la sección 0, que ya tenías anotado): correr

```bash
npm run test:e2e
```

en un entorno con salida a `cdn.playwright.dev` (tu máquina, CI, o
agregando ese host a la allowlist acá) para confirmar que el
comportamiento real coincide con lo que infería leyendo el código.

## Qué cubre cada escenario (los 3 de la sección 1.2 del plan)

Por cada uno de los 4 portales (`proveedor`, `chofer`, `cliente`, `pos`):

1. **Modo avión a mitad de la operación** — `context.setOffline(true)`
   antes de disparar la acción, confirmo que se encola sin tocar la red
   (`llamadas === 0`), reconecto y confirmo que sincroniza sola vía el
   listener `online` de `offline-core.js` — sin intervención manual.
2. **Cierre a mitad del sync** (proveedor y pos) — mock del servidor con
   `delayMs`, reconecto, dejo que el sync arranque, `page.reload()` a
   mitad de vuelo (simula cerrar la pestaña), reabro y confirmo que el
   outbox — persistido en IndexedDB, sobrevive al reload — termina de
   sincronizar sin que el contador de llamadas al servidor supere el
   máximo posible de reintentos (no hay duplicado silencioso del lado
   cliente).
3. **Reconexión intermitente** — varios ciclos cortos
   `setOffline(false)/setOffline(true)` (el caso real de señal
   intermitente) y confirmo que el servidor recibe la acción **una sola
   vez**, no una por cada evento `online` disparado.

Sumé además, donde el módulo lo define, un test de **conflicto** (rechazo
4xx del servidor por estado real, no error transitorio) porque es la otra
mitad de la Etapa 4 que tampoco cubren bien los tests unitarios en un
browser real.

## Por qué encontré (y agregué un test para) una carrera concreta

`offline-core.js::sincronizarPendientes()` chequea la guarda
`_estado.syncEnCurso` de forma **síncrona** al entrar, pero recién la
pone en `true` **después** de un `await getContexto()`:

```js
async function sincronizarPendientes() {
  if (_estado.syncEnCurso || !_estado.online) return;   // check síncrono
  const contexto = await Promise.resolve(...getContexto());  // ← yield acá
  ...
  _estado.syncEnCurso = true;                            // se setea recién acá
```

Si el listener `window.addEventListener('online', ...)` dispara
`sincronizarPendientes()` dos veces seguidas antes de que la primera
llamada llegue a poner la guarda en `true` (exactamente lo que puede pasar
con una reconexión intermitente real), las dos ejecuciones pasan el check
y procesan el mismo outbox en paralelo. El test de "reconexión
intermitente" en cada spec está pensado para las condiciones más
favorables a que esto se manifieste (mock sin `delayMs`, varios toggles
rápidos). **No confirmé si esto se manifiesta de verdad en un browser
real** — no pude correr el test — pero el código, leído en frío, tiene la
ventana de carrera. Vale la pena correrlo antes de dar por cerrado el
punto 1.2, y si el test falla (`llamadas > 1`), el fix es mover
`_estado.syncEnCurso = true` antes del `await getContexto()`.

## Decisión de alcance: UI real vs. nivel de módulo

- **`proveedor.spec.js`** testea la UI real (`portal.html`, clicks de
  verdad) porque es el único portal público sin login — no hace falta
  mockear autenticación, solo el endpoint de datos.
- **`chofer.spec.js` / `cliente.spec.js` / `pos.spec.js`** testean a
  nivel de módulo: cargan `offline-core.js` + el `*-offline.js`
  correspondiente en una página mínima (`tests/e2e/fixtures/harness-*.html`,
  que **no es código de producción**, solo carga los mismos `<script>`
  reales) y llaman `window.XOffline.init(...)` / `encolarAccion(...)`
  directamente vía `page.evaluate()`, simulando la sesión con
  `getToken`/`window.authCtx` en vez de loguearse de verdad.

  Elegí esto en vez de manejar clicks sobre `remito.html`/`carrito.html`/
  `pos.html` porque esas tres páginas necesitan sesión de Supabase Auth
  real para renderizar (turno de caja abierto en el caso de POS), y
  mockear ese flujo completo de forma confiable era un proyecto aparte —
  cada uno de esos tres módulos no lee el DOM salvo para inyectar su
  propio badge (que sí incluyo en cada harness), así que a nivel de la
  lógica de outbox que este plan pide probar (IndexedDB real, eventos
  `online`/`offline` reales, Service Worker real) el nivel de módulo
  ejercita exactamente lo mismo que ejercitaría clickear el botón real.

  **Lo que esto NO cubre**: bugs en el pegamento entre la UI de
  `remito.html`/`carrito.html`/`pos.html` y su módulo offline (ej. que el
  botón real no le pase bien el payload, o que el turno de caja cerrado
  bloquee el flujo antes de llegar a `encolarVenta`). Si querés cerrar
  también esa capa, el siguiente paso natural es mockear la respuesta de
  Supabase Auth (`page.route` a `*.supabase.co/auth/v1/**`) e ir a full
  UI en los tres — puedo armarlo si te sirve.

## Vendoring de Dexie

`fixtures/vendor/dexie.min.js` es una copia de `node_modules/dexie/dist/dexie.min.js`
(instalado con `npm install dexie` para sacar el archivo real, misma
versión que declara el `<script src="https://cdn.jsdelivr.net/npm/dexie@4/...">`
que usan las páginas de producción). `helpers/mock-network.js` intercepta
esa URL de CDN y sirve el vendor local — así los tests no dependen de que
`cdn.jsdelivr.net` esté disponible en el entorno donde corran (acá no lo
está; en tu CI puede que sí, pero mejor no depender de eso para algo tan
central a lo que se está testeando).

## Cómo correrla (en un entorno con red completa)

```bash
npx playwright install chromium   # una vez
npm run test:e2e                  # headless
npm run test:e2e:ui               # con el UI runner de Playwright, para debuggear
```

## Extender a stock-offline.js / cobros-offline.js

Quedaron afuera de esta primera pasada (elegiste los 4 portales, que
mapean 1:1 a los 4 módulos con UI propia; `stock-offline.js` y
`cobros-offline.js` viven dentro del portal admin igual que `pos-offline.js`).
El patrón es idéntico al de `pos.spec.js` — mismo `window.authCtx`, mismo
armado de harness — así que agregarlos es copiar `harness-pos.html` →
`harness-stock.html`/`harness-cobros.html` cambiando el único `<script>`
del módulo, y `pos.spec.js` → `stock.spec.js`/`cobros.spec.js` cambiando
el endpoint mockeado y el nombre de la función `encolar*`. Si querés, lo
armo en la próxima vuelta.
