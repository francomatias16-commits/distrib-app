// Cuatro responsabilidades:
//
// 1. `vendorizarDexie(page)` — intercepta el <script src="https://cdn.jsdelivr.net/npm/dexie@4/..."
//    y lo sirve desde el vendor local (tests/e2e/fixtures/vendor/dexie.min.js).
//    Así los tests no dependen de la disponibilidad de un CDN externo, y
//    siguen ejercitando el mismo Dexie real que usa producción (misma
//    versión que declara package.json vía `npm install dexie` al armar el
//    fixture — ver README de esta suite).
//
// 2. `vendorizarSupabase(page)` — mismo patrón para
//    `@supabase/supabase-js` (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/...`),
//    que cargan TODAS las páginas admin (no solo las offline). Sin esto,
//    en cualquier sandbox/CI con `cdn.jsdelivr.net` bloqueado,
//    `window.supabaseClient` nunca se crea, `auth.js` tira
//    "Cannot read properties of undefined (reading 'createClient')" antes
//    de resolver `authReady`, y CUALQUIER spec que dependa de una sesión
//    logueada (todo lo de `page-objects/admin/*`) cuelga esperando
//    elementos que nunca se muestran — no es un bug de la app, ver
//    PLAN_E2E_COBERTURA_TOTAL.md sección 11.3. El vendor local
//    (`supabase-js.umd.js`) es una copia literal de
//    `node_modules/@supabase/supabase-js/dist/umd/supabase.js`, la misma
//    versión que declara `package.json` — no un mock, el SDK real.
//
// 3. `mockApi(page, rutas, redEstado)` — intercepta llamadas fetch a
//    endpoints de API específicos y devuelve respuestas controladas,
//    contando invocaciones. Esto es lo que permite simular "el servidor
//    tarda en responder" (cierre durante el sync) o "el servidor rechaza
//    porque el estado cambió" (conflicto), sin pegarle a Supabase real.
//
// 4. `irOffline`/`irOnline` — IMPORTANTE: `context.setOffline()` de
//    Playwright NO alcanza a una request que ya está interceptada por
//    `page.route()` (la respuesta la arma el mock antes de que la
//    emulación de red offline tenga chance de cortarla) — es una
//    limitación conocida, no un bug de esta suite. Por eso el corte real
//    de "avión" lo hacemos nosotros mismos, en el propio mock, vía
//    `redEstado.offline`: cuando está en true, CUALQUIER ruta mockeada
//    aborta la conexión (mismo TypeError que vería el código real en un
//    corte de red de verdad). `context.setOffline()` se sigue llamando
//    en paralelo porque offline-core.js sí necesita los eventos reales
//    `window.addEventListener('online'/'offline')` para disparar el sync
//    solo al reconectar — pero el CORTE de la request depende de
//    `redEstado`, no de eso.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEXIE_VENDOR_PATH = fileURLToPath(new URL('../fixtures/vendor/dexie.min.js', import.meta.url));
const SUPABASE_VENDOR_PATH = fileURLToPath(new URL('../fixtures/vendor/supabase-js.umd.js', import.meta.url));
const PAPAPARSE_VENDOR_PATH = fileURLToPath(new URL('../fixtures/vendor/papaparse.min.js', import.meta.url));

export async function vendorizarDexie(page) {
  const dexieSrc = readFileSync(DEXIE_VENDOR_PATH, 'utf-8');
  await page.route('https://cdn.jsdelivr.net/npm/dexie@4/**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: dexieSrc });
  });
}

export async function vendorizarSupabase(page) {
  const supabaseSrc = readFileSync(SUPABASE_VENDOR_PATH, 'utf-8');
  await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: supabaseSrc });
  });
}

// Mismo patrón para PapaParse (`https://cdn.jsdelivr.net/npm/papaparse@5.4.1/...`),
// que carga `conciliacion-bancaria.html` para parsear el CSV del extracto
// bancario. Sin esto, en un sandbox con `cdn.jsdelivr.net` bloqueado
// `window.Papa` nunca existe y `onArchivoSeleccionado` cae directo al toast
// de error ("No se pudo procesar el archivo") — no es un bug de la app,
// mismo caso que Dexie (ver nota arriba). Vendor = copia literal de
// `papaparse.min.js@5.4.1` (misma versión que pide el `<script>` del HTML),
// no un mock.
export async function vendorizarPapaparse(page) {
  const papaparseSrc = readFileSync(PAPAPARSE_VENDOR_PATH, 'utf-8');
  await page.route('https://cdn.jsdelivr.net/npm/papaparse@5.4.1/**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: papaparseSrc });
  });
}

// Ruido de consola específico de correr contra hosts externos bloqueados
// en un sandbox de salida restringida (CDNs opcionales tipo Sentry/xlsx/
// fonts, y el WebSocket de Supabase Realtime que el SDK real —vendorizado
// arriba— intenta abrir contra el proyecto de verdad). Nada de esto es un
// bug de la app: en un entorno con esa salida de red habilitada estos
// mismos requests resuelven bien. Se filtra ANTES de comparar
// `capturarErroresConsola()` contra "sin errores", así ese assert sigue
// sirviendo para pescar errores reales del código bajo test.
const RUIDO_RED_SANDBOX = /Failed to load resource|sentry-cdn\.com|realtime\/v1\/websocket/;

export function filtrarRuidoRed(errores) {
  return errores.filter((e) => !RUIDO_RED_SANDBOX.test(e));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, (call: {count:number, request: import('@playwright/test').Request}) => (
 *   { status?: number, json?: any, delayMs?: number }
 * )>} handlers  Mapa de "substring de la URL" -> función que decide la respuesta.
 * @param {{ offline: boolean }} redEstado  Objeto compartido con el test — ver irOffline/irOnline.
 */
export function mockApi(page, handlers, redEstado = { offline: false }) {
  const contadores = {};
  for (const [match, handler] of Object.entries(handlers)) {
    contadores[match] = 0;
    // `**` de los dos lados (no solo `*`) — algunos endpoints tienen
    // segmentos de path DESPUÉS del substring que matcheamos (ej.
    // `/api/chofer/remitos/<id>/no-entregar`), y `*` no cruza `/`.
    page.route(`**${match}**`, async (route) => {
      if (redEstado.offline) {
        await route.abort('internetdisconnected');
        return;
      }

      contadores[match] += 1;
      const resultado = handler({ count: contadores[match], request: route.request() });

      if (resultado?.delayMs) {
        await new Promise((r) => setTimeout(r, resultado.delayMs));
      }
      await route.fulfill({
        status: resultado?.status ?? 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(resultado?.json ?? {}),
      });
    });
  }
  return contadores;
}

/**
 * Corta la red "de verdad" para los mocks (ver nota arriba) + dispara el
 * evento `offline` real.
 *
 * Espera a que `navigator.onLine` en la página confirme el cambio antes de
 * devolver el control. Sin este chequeo, `redEstado.offline` (que decide
 * si `mockApi` aborta o cumple la request) puede cambiar de valor ANTES de
 * que offline-core.js reciba el evento `online`/`offline` real del
 * browser — dos señales async con timing propio, no necesariamente
 * sincronizadas tick a tick. Bajo carga de CPU (varios workers en
 * paralelo) esa ventana se agranda lo suficiente como para que un toggle
 * rápido de `irOnline()`→`irOffline()` deje una sincronización en curso
 * "huérfana": la app cree que sigue online cuando `redEstado.offline` ya
 * dice que no, o viceversa. No agrega demora al escenario que el test
 * quiere estresar (toggles reales consecutivos) — solo garantiza que cada
 * toggle ya haya sido observado por la página antes de aplicar el
 * siguiente, mismo criterio que ya usaba el resto de la suite offline
 * para no asumir timing implícito entre capas async independientes.
 */
export async function irOffline(context, redEstado, page) {
  redEstado.offline = true;
  await context.setOffline(true);
  if (page) await page.waitForFunction(() => navigator.onLine === false);
}

/** Reconecta — dispara el evento `online` real, que es lo que offline-core.js escucha para sincronizar solo. */
export async function irOnline(context, redEstado, page) {
  redEstado.offline = false;
  await context.setOffline(false);
  if (page) await page.waitForFunction(() => navigator.onLine === true);
}
