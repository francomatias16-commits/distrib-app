// tests/e2e/specs/cliente/catalogo-precio-sw.spec.js
//
// Regresión F4-02 (checklist_pase_manual.md, punto 2): el catálogo del
// cliente mostraba el precio de lista viejo, cacheado por
// `sw-cliente.js`, en vez del precio real (especial/regla/lista) que
// devuelve `/api/cliente/productos`. Causa raíz real (ya confirmada:
// no era la RPC ni el dato) — el endpoint vivía en `SWR_PATTERNS`
// (stale-while-revalidate) y el SW servía la respuesta vieja del
// Cache Storage mientras revalidaba en segundo plano, sin que se notara
// hasta el próximo load. Fix: movido a `NETWORK_ONLY_PATTERNS`.
//
// A DIFERENCIA de la suite general (`playwright.config.e2e.js` bloquea
// el Service Worker en todo el resto de specs — ver comentario en esa
// config), este spec necesita el SW real activo: es la única forma de
// reproducir/verificar el bug tal cual pasaba en producción. Por eso usa
// su propio `test.use()` para permitirlo.
//
// Estrategia: mockear `/api/cliente/productos` para devolver un precio
// A en la primera carga, cambiar el mock a un precio B, recargar la
// página, y verificar que el catálogo muestra B. Si el SW estuviera
// sirviendo desde caché (regresión), seguiría mostrando A.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { mockearRestGenerico, mockearTabla } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionCliente } from '../../helpers/auth-helper.js';

// Habilita el SW real para este archivo únicamente (el resto de la suite
// lo sigue bloqueando vía playwright.config.e2e.js).
test.use({ serviceWorkers: 'allow' });

const EMPRESA_ID = 'e2e-empresa-1';
const CLIENTE_ID = 'e2e-cliente-001';
const PRODUCTO_ID = 'prod-coca-225';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

function productosResponse(precio) {
  return {
    productos: [{
      id: PRODUCTO_ID,
      nombre: 'Coca Cola 2.25L',
      precio_base: precio,
      oferta_liquidacion: null,
    }],
    pages: 1,
  };
}

async function prepararRed(page, { precioInicial }) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearTabla(page, 'usuarios', {
    onSelect: () => ({ empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }),
  });

  // Precio mutable entre cargas — simula que cambió la regla/precio
  // especial del cliente entre una request y la siguiente.
  //
  // OJO: esto tiene que ir en `page.context().route()`, NO en
  // `page.route()`. Con el SW activo (`serviceWorkers: 'allow'`),
  // `/api/cliente/productos` está en NETWORK_ONLY_PATTERNS de
  // sw-cliente.js, así que en el 2do load el SW mismo hace
  // `e.respondWith(fetch(req))` — un fetch propio del Service Worker,
  // no de la página. Playwright solo puede enrutar requests
  // "owned by the Service Worker" a nivel de BrowserContext:
  // page.route() es un handler de página/frame y nunca ve ese fetch,
  // por eso caía directo al static-server real y devolvía su 404 en
  // texto plano en vez del JSON mockeado (ver docs: Service Workers —
  // "Only the Service Worker-owned request ... was routable via
  // browserContext.route()"). En el 1er load no fallaba porque el SW
  // todavía no estaba activo/controlando, así que esa request la
  // servía la página normal y sí la agarraba page.route().
  const estado = { precio: precioInicial };
  await page.context().route('**/api/cliente/productos**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(productosResponse(estado.precio)),
    });
  });

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola), estado };
}

test.describe('cliente/catalogo.html — precio no debe quedar cacheado por el SW (F4-02)', () => {

  test('un segundo load con precio distinto NO debe mostrar el precio viejo', async ({ page }) => {
    await sembrarSesionCliente(page);
    const { estado } = await prepararRed(page, { precioInicial: 2500 });

    // OJO: navegar por la ruta limpia `/cliente/catalogo` (no
    // `/frontend/cliente/catalogo.html`). pwa-init.js registra el SW con
    // scope '/cliente/', y ese scope filtra por prefijo de URL de la
    // página, no de dónde vive el script. Con la ruta real en disco el SW
    // se instala y activa igual, pero nunca "reclama" esta pestaña (queda
    // fuera de su scope) — navigator.serviceWorker.controller no se
    // setea nunca y el waitForFunction de abajo cuelga hasta el timeout.
    await page.goto(`${staticServer.baseURL}/cliente/catalogo?empresa_id=${EMPRESA_ID}`);
    await expect(page.locator('#listaProductos')).toContainText('2.500', { timeout: 10_000 });

    // Esperar a que el SW quede activo y controlando la página antes de
    // cambiar el precio y recargar — si no, la 2da carga podría no pasar
    // siquiera por el SW y el test daría un falso verde.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 10_000 });

    estado.precio = 1600;
    await page.reload();

    await expect(page.locator('#listaProductos')).toContainText('1.600', { timeout: 10_000 });
    await expect(page.locator('#listaProductos')).not.toContainText('2.500');
  });

  test('regresión explícita: /api/cliente/productos nunca debe resolverse desde el Cache Storage del SW', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { precioInicial: 2500 });

    await page.goto(`${staticServer.baseURL}/cliente/catalogo?empresa_id=${EMPRESA_ID}`);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 10_000 });

    // Confirma directamente el contrato que exige el fix: el endpoint no
    // debe estar en ningún Cache Storage del SW después de una carga real.
    const cacheadoEnAlgunaCache = await page.evaluate(async () => {
      const nombres = await caches.keys();
      for (const nombre of nombres) {
        const cache = await caches.open(nombre);
        const claves = await cache.keys();
        if (claves.some((req) => req.url.includes('/api/cliente/productos'))) return true;
      }
      return false;
    });

    expect(cacheadoEnAlgunaCache).toBe(false);
  });
});
