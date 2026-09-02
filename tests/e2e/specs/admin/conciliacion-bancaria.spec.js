// Fase 2 (P1), tercera y última parada del bloque "devoluciones / cheques /
// conciliación bancaria" (ver PLAN_E2E_COBERTURA_TOTAL.md, secciones 21-22)
// — cierra el bloque. `conciliacion-bancaria.html` es standalone: JS propio
// (`conciliacion-bancaria.js`), sin PostgREST/RPC en ningún lado — todo pasa
// por un único endpoint `/api/conciliacion-bancaria`, discriminado por
// método + querystring (`_svc=confirmar|deshacer|descartar|auto`, `lote_id`,
// `estado`). Mismo patrón de mock que devoluciones.spec.js.
//
// Alcance deliberado: gate de permisos (lectura/escritura por rol), carga
// de lotes + selección + KPIs, filtro de movimientos por estado, las tres
// acciones sobre un movimiento pendiente (confirmar match / descartar) y
// sobre uno conciliado (deshacer), auto-conciliar, e importación de CSV
// (drag&drop se cubre indirectamente vía `setInputFiles`, que dispara el
// mismo `onArchivoSeleccionado`). NO cubre: el parseo de formatos de
// extracto (fechas DD/MM/AAAA, montos AR con coma decimal, layout
// débito/crédito separado) — es lógica pura sin DOM, candidata a spec de
// unidad si hace falta profundizar, no a E2E.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRestGenerico, mockearApiGenerico, mockearAuthGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, vendorizarPapaparse, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { ConciliacionBancariaPage } from '../../page-objects/admin/conciliacion-bancaria.page.js';

const LOTE_ID = 'e2e-lote-000000000001';
const MOV_PENDIENTE_ID  = 'e2e-mov-pendiente-0001';
const MOV_CONCILIADO_ID = 'e2e-mov-conciliado-0001';
const COBRO_ID = 'e2e-cobro-000000000001';

function lotes() {
  return [
    { id: LOTE_ID, nombre_archivo: 'extracto-julio.csv', cantidad_movimientos: 2, cantidad_conciliados: 1, created_at: '2026-08-01T12:00:00Z' },
  ];
}

function movimientos() {
  return [
    {
      id: MOV_PENDIENTE_ID, fecha: '2026-08-01', descripcion: 'Transferencia recibida',
      tipo: 'credito', monto: 5000, estado: 'pendiente',
      candidatos: [{ fecha: '2026-08-01', monto: 5000, cliente_nombre: 'Cliente Test', score: 95, cobro_id: COBRO_ID }],
    },
    {
      id: MOV_CONCILIADO_ID, fecha: '2026-07-30', descripcion: 'Depósito',
      tipo: 'credito', monto: 3000, estado: 'conciliado', candidatos: [],
      cobros: { fecha: '2026-07-30', monto: 3000, clientes: { razon_social: 'Cliente Test SRL' } },
    },
  ];
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page, { rol = 'admin', lista = movimientos() } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  // Hallazgo real (bug del test, no de la app): el catch-all de
  // mockearApiGenerico devuelve `[]` para cualquier GET a `/api/**`,
  // incluido `/api/setup/status` — que admin/login.html sí llega a pedir
  // apenas carga (antes incluso de mirar la sesión). Ese endpoint no
  // devuelve un listado sino `{ inicializado: boolean }`; con `[]`,
  // `data.inicializado` da `undefined` y login.html interpreta "sistema
  // no inicializado" y redirige de una a `/setup`. Eso solo importa para
  // el test de "rol fuera de PAGINA_ROLES_PERMITIDOS" (único que termina
  // navegando a /admin/login de verdad): la URL pasa por `/admin/login`
  // y se va a `/setup` casi en el mismo tick, así que
  // `waitForURL('**/admin/login**')` nunca llega a capturarla asentada
  // ahí y cuelga hasta el timeout — no es contención de paralelismo.
  // Se registra DESPUÉS del catch-all para pisarlo (Playwright prioriza
  // el último route que matchea).
  await page.route('**/api/setup/status', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ inicializado: true }) });
  });
  // Mismo test: una vez que login.html ve `inicializado:true`, sigue de
  // largo y encuentra la sesión sembrada por `sembrarSesion` (localStorage
  // persiste entre navegaciones dentro del mismo `page`) — como no está en
  // modo demo, dispara `sb.auth.signOut()` con el SDK real. Sin este mock,
  // esa llamada le pega a `/auth/v1/logout` de verdad, bloqueada en el
  // sandbox, y nunca resuelve. No rompe la URL en sí, pero es la otra
  // mitad de por qué este flujo de logout necesita `mockearAuthGenerico`
  // (ver su doc en supabase-rest-mock.js) igual que cuenta.spec.js y
  // chofer/index.spec.js.
  mockearAuthGenerico(page);
  await vendorizarSupabase(page);
  await vendorizarPapaparse(page); // necesario para el test de importar CSV — ver nota en mock-network.js

  await loguearComoAdmin(page, { rol });

  const contadoresApi = mockApi(page, {
    '/api/conciliacion-bancaria': ({ request }) => {
      const url = new URL(request.url());
      const svc = url.searchParams.get('_svc');

      if (request.method() === 'GET' && !url.searchParams.get('lote_id')) {
        return { json: lotes() };
      }
      if (request.method() === 'GET') {
        const estado = url.searchParams.get('estado');
        const filtradas = estado ? lista.filter((m) => m.estado === estado) : lista;
        return { json: filtradas };
      }
      if (request.method() === 'POST' && svc === 'auto') {
        return { json: { conciliados: 1 } };
      }
      // confirmar/deshacer/descartar e importación de CSV se pisan en
      // cada test que necesita inspeccionar el body.
      return { json: { ok: true } };
    },
  });

  const conciliacionPage = new ConciliacionBancariaPage(page, staticServer.baseURL);
  return { conciliacionPage, contadoresApi };
}

test.describe('Conciliación bancaria (admin) — Fase 2 P1', () => {
  test('con un rol fuera de PAGINA_ROLES_PERMITIDOS, auth.js redirige a /admin/login antes de renderizar la página', async ({ page }) => {
    // Hallazgo real corriendo contra Chromium: `ROLES_LECTURA_CONCILIACION`
    // (gate interno de conciliacion-bancaria.js, que muestra `#sin-permiso`)
    // y `window.PAGINA_ROLES_PERMITIDOS` (gate de auth.js, que redirige TODA
    // la página) son hoy la MISMA lista (dueno/admin/contador). Con un rol
    // fuera de ambas (ej. 'vendedor'), auth.js redirige a /admin/login antes
    // de que `#nav-root`/`#contenido-conciliacion` lleguen a existir en el
    // DOM — el `esperarAppLista()` del page object (que espera `#nav-root`)
    // nunca resuelve y el test cuelga hasta timeout. Por eso este test NO
    // usa `conciliacionPage.goto()`, navega directo y solo verifica la URL
    // final. El branch `#sin-permiso` de la propia página es, con la
    // configuración de roles actual, código inalcanzable: no existe ningún
    // rol que pase el gate de auth.js y falle el de la página (ver segundo
    // test más abajo, que documenta esto explícitamente).
    // 20s ya no alcanzaba: en una corrida real bajo los 4 workers en
    // paralelo (ver playwright.config.e2e.js) esta prueba flakeó a los
    // 23.5s. Revisado auth.js completo — no hay ningún retry/setTimeout en
    // el camino de un usuario válido con rol fuera de lista (el perfil
    // existe y está activo, así que cargarPerfilConReintento resuelve en
    // el primer intento); la lentitud es contención real de CPU/red bajo
    // paralelismo, no un cambio de comportamiento de la app. Subimos el
    // margen a 35s y además extendemos el timeout propio del test (por
    // default hereda el global de 30s de playwright.config.e2e.js, que
    // quedaría más corto que el propio waitForURL).
    test.setTimeout(45_000);
    await armarPagina(page, { rol: 'vendedor' });

    await page.goto(`${staticServer.baseURL}/frontend/admin/conciliacion-bancaria.html`);
    await page.waitForURL('**/admin/login**', { timeout: 35_000 });
  });

  test('la lista de lotes carga y al elegir uno se muestran sus movimientos y KPIs', async ({ page }) => {
    const { conciliacionPage } = await armarPagina(page);
    const erroresConsola = conciliacionPage.capturarErroresConsola();

    await conciliacionPage.goto();

    await expect(conciliacionPage.lote(LOTE_ID)).toBeVisible();
    await expect(conciliacionPage.lote(LOTE_ID)).toContainText('extracto-julio.csv');
    await expect(conciliacionPage.lote(LOTE_ID)).toContainText('1/2 conciliados');

    await conciliacionPage.seleccionarLote(LOTE_ID);

    await expect(conciliacionPage.tituloMovimientos).toHaveText('extracto-julio.csv');
    await expect(conciliacionPage.fila(MOV_PENDIENTE_ID)).toBeVisible();
    await expect(conciliacionPage.fila(MOV_PENDIENTE_ID)).toContainText('Transferencia recibida');
    await expect(conciliacionPage.fila(MOV_CONCILIADO_ID)).toContainText('Cliente Test SRL');

    await expect(conciliacionPage.kpisGrid).toContainText('Movimientos');
    await expect(conciliacionPage.kpisGrid).toContainText('Pendientes');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('filtrar por estado vuelve a pedir los movimientos con el querystring correcto', async ({ page }) => {
    const { conciliacionPage } = await armarPagina(page);

    await conciliacionPage.goto();
    await conciliacionPage.seleccionarLote(LOTE_ID);
    await expect(conciliacionPage.fila(MOV_CONCILIADO_ID)).toBeVisible();

    await conciliacionPage.filtroEstado.selectOption('pendiente');

    await expect(conciliacionPage.fila(MOV_PENDIENTE_ID)).toBeVisible();
    await expect(conciliacionPage.fila(MOV_CONCILIADO_ID)).toHaveCount(0);
  });

  test('confirmar un match candidato envía el POST con movimiento y cobro correctos', async ({ page }) => {
    const { conciliacionPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/conciliacion-bancaria**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.searchParams.get('_svc') === 'confirmar') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await conciliacionPage.goto();
    await conciliacionPage.seleccionarLote(LOTE_ID);
    await conciliacionPage.botonConfirmar(MOV_PENDIENTE_ID, COBRO_ID).click();

    await conciliacionPage.esperarToastExito('Match confirmado');
    expect(bodyCapturado).toEqual({ movimiento_id: MOV_PENDIENTE_ID, cobro_id: COBRO_ID });
  });

  test('deshacer un match conciliado envía el POST con el movimiento correcto', async ({ page }) => {
    const { conciliacionPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/conciliacion-bancaria**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.searchParams.get('_svc') === 'deshacer') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await conciliacionPage.goto();
    await conciliacionPage.seleccionarLote(LOTE_ID);
    await conciliacionPage.botonDeshacer(MOV_CONCILIADO_ID).click();

    await conciliacionPage.esperarToastExito('Match deshecho');
    expect(bodyCapturado).toEqual({ movimiento_id: MOV_CONCILIADO_ID });
  });

  test('descartar un movimiento pendiente envía el POST correcto y refresca la tabla', async ({ page }) => {
    const { conciliacionPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/conciliacion-bancaria**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.searchParams.get('_svc') === 'descartar') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await conciliacionPage.goto();
    await conciliacionPage.seleccionarLote(LOTE_ID);
    await conciliacionPage.botonDescartar(MOV_PENDIENTE_ID).click();

    await conciliacionPage.esperarToastExito('Movimiento descartado');
    expect(bodyCapturado).toEqual({ movimiento_id: MOV_PENDIENTE_ID });
  });

  test('auto-conciliar envía el lote activo y muestra la cantidad conciliada', async ({ page }) => {
    const { conciliacionPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/conciliacion-bancaria**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.searchParams.get('_svc') === 'auto') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conciliados: 1 }) });
        return;
      }
      return route.fallback();
    });

    await conciliacionPage.goto();
    await conciliacionPage.seleccionarLote(LOTE_ID);
    await expect(conciliacionPage.btnAutoConciliar).toBeVisible();
    await conciliacionPage.btnAutoConciliar.click();

    await conciliacionPage.esperarToastExito('Auto-conciliados: 1');
    expect(bodyCapturado).toEqual({ lote_id: LOTE_ID });
  });

  test('ROLES_LECTURA_CONCILIACION y ROLES_ESCRITURA_CONCILIACION son hoy la misma lista que PAGINA_ROLES_PERMITIDOS — el gate interno #sin-permiso es inalcanzable con la config actual', async ({ page }) => {
    // No es un test de comportamiento (no hay ninguna acción de usuario que
    // ejercite una rama distinta) — documenta en el código, no solo en el
    // plan, un hallazgo que de otra forma quedaría solo en un comentario y
    // se podría perder de vista si algún día se agrega un cuarto rol a
    // PAGINA_ROLES_PERMITIDOS sin tocar las listas de conciliacion-bancaria.js
    // (o viceversa) — ese día este assert exacto de igualdad de arrays
    // rompe y avisa. Ver el test anterior para el comportamiento real que
    // sí se puede disparar (redirect completo por auth.js).
    const htmlSrc = await page.context().request
      .get(`${staticServer.baseURL}/frontend/admin/conciliacion-bancaria.html`)
      .then((r) => r.text());
    const jsSrc = await page.context().request
      .get(`${staticServer.baseURL}/frontend/admin/js/conciliacion-bancaria.js`)
      .then((r) => r.text());

    const paginaRoles = htmlSrc.match(/PAGINA_ROLES_PERMITIDOS\s*=\s*(\[[^\]]*\])/)?.[1];
    const lecturaRoles = jsSrc.match(/ROLES_LECTURA_CONCILIACION\s*=\s*(\[[^\]]*\])/)?.[1];
    const escrituraRoles = jsSrc.match(/ROLES_ESCRITURA_CONCILIACION\s*=\s*(\[[^\]]*\])/)?.[1];

    expect(paginaRoles).toBeTruthy();
    expect(JSON.parse(lecturaRoles.replace(/'/g, '"'))).toEqual(JSON.parse(paginaRoles.replace(/'/g, '"')));
    expect(JSON.parse(escrituraRoles.replace(/'/g, '"'))).toEqual(JSON.parse(paginaRoles.replace(/'/g, '"')));
  });

  test('importar un CSV válido dispara el POST con los movimientos parseados', async ({ page }) => {
    const { conciliacionPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/conciliacion-bancaria**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && !url.searchParams.get('_svc')) {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: LOTE_ID }),
        });
        return;
      }
      return route.fallback();
    });

    await conciliacionPage.goto();
    await conciliacionPage.importarCsv(
      'fecha,descripcion,monto,tipo\n2026-08-01,Transferencia,5000,credito\n',
      'extracto.csv'
    );

    await conciliacionPage.esperarToastExito('Importado: 1 movimientos');
    expect(bodyCapturado.nombre_archivo).toBe('extracto.csv');
    expect(bodyCapturado.movimientos).toEqual([
      { fecha: '2026-08-01', descripcion: 'Transferencia', monto: 5000, tipo: 'credito' },
    ]);
  });
});
