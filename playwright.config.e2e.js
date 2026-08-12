// Config separada de un eventual playwright.config.js de UI general, para
// no pisar nada si en el futuro se suma Playwright para otra cosa.
//
// Uso: npx playwright test -c playwright.config.e2e.js
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/specs',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    // v661: ningún spec de esta suite ejercita el Service Worker real (todas
    // las páginas admin registran sw-admin.js apenas cargan). Antes de v660
    // ese registro fallaba en silencio (scope mal calculado — ver
    // CHANGELOG_v660) así que nunca llegó a interferir. Al arreglar el
    // registro, el SW pasa a activarse y controlar la página de verdad, y
    // su estrategia stale-while-revalidate (sw-admin.js::staleWhileRevalidate,
    // patrones SWR_PATTERNS: /api/empresa/*, /api/lotes*, /api/pos/cajas*,
    // etc.) dispara un `fetch()` DESDE el propio Service Worker para
    // revalidar caché — esa request nace en el scope del SW, no en el de la
    // página, así que `page.route()` (que solo intercepta el pipeline de
    // red de la página) no la ve: pega directo contra el static-server de
    // test, que no sirve `/api/*` y devuelve 404 real. El síntoma exacto
    // eran los 3 fallos de smoke-universal.spec.js en empresa-config.html,
    // liquidacion.html (redirige a vencimientos, que llama /api/lotes) y
    // pos.html (/api/pos/cajas) — las 3 únicas páginas admin cuyo primer
    // fetch cae en un patrón SWR. Nada de esto es un bug de la app: en
    // producción esa misma request de revalidación sí sale a la red real y
    // resuelve bien. `serviceWorkers: 'block'` corta el registro del SW en
    // todo el navegador de test, que es lo correcto: esta suite testea
    // wiring de página, no la estrategia de caché del SW (eso, si algún día
    // se quiere cubrir, es un spec dedicado con su propio contexto).
    serviceWorkers: 'block',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
