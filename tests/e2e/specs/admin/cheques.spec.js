// Fase 2 (P1), bloque "devoluciones / cheques / conciliación bancaria" (ver
// PLAN_E2E_COBERTURA_TOTAL.md). `cheques.html` es standalone, JS propio
// (`cheques.js`), sin dependencias de otras páginas.
//
// Tres capas de red distintas (mismo patrón que cobranzas.js/cta-cte.js):
//  - RPC para listado paginado (`fn_cheques_lista`) y contadores/KPIs
//    (`fn_cheques_contadores`, `.single()`).
//  - PostgREST vía SDK para el combo de clientes (`_sb.from('clientes')`).
//  - `fetch()` a mano contra `/rest/v1/cheques` para alta/edición
//    (`guardarCheque`) y cambio de estado (`cambiarEstado`) — cheques.js
//    arma el header Authorization sin pasar por el SDK, pero cae bajo el
//    mismo patrón de URL así que `mockearTabla` lo cubre igual (Playwright
//    matchea por URL, no por quién hizo el request — ver nota en
//    cheques.page.js).
// Y una cuarta, propia de esta página: `fetch()` a `/api/bcra` (con Bearer
// de `_sb.auth.getSession()`) para la verificación de denuncia BCRA — no
// es CRUD de `cheques`, es una consulta a un tercero vía API route propia.
//
// Alcance deliberado: listado + KPIs + alerta de vencimientos próximos,
// filtros (búsqueda/estado/solo vencidos) contra fn_cheques_lista,
// paginación server-side, alta y edición (con confirmación), cambio de
// estado desde el select de la fila (incluido el toast especial al
// rechazar), y los dos resultados de la verificación BCRA (sin denuncia /
// denunciado). NO cubre: el matcheo best-effort banco↔entidad BCRA por
// texto libre (lógica de preselección, no de red), ni fallas de red en
// fn_cheques_contadores/clientes — quedan para una vuelta futura si hace
// falta profundizar.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { ChequesPage } from '../../page-objects/admin/cheques.page.js';

function formatPesoEsperado(n) {
  return '$' + (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CLIENTE_ID = 'e2e-cliente-000000000001';
const CHEQUE_CARTERA_ID  = 'e2e-cheque-cartera-0001';
const CHEQUE_VENCIDO_ID  = 'e2e-cheque-vencido-0001';

const CLIENTES = [
  { id: CLIENTE_ID, razon_social: 'Cliente Test SRL', nombre_fantasia: 'Cliente Test' },
];

const KPIS_BASE = {
  monto_cartera: 15000, cant_cartera: 2,
  monto_proximos: 5000, cant_proximos: 1,
  monto_cobrado_mes: 3000, cant_cobrado_mes: 1,
  monto_rechazados: 0, cant_rechazados: 0,
};

function chequeCartera(overrides = {}) {
  return {
    id: CHEQUE_CARTERA_ID,
    cliente_id: CLIENTE_ID,
    numero: '00001234',
    banco: 'Banco Nación',
    monto: 8000,
    vencimiento: '2026-08-20',
    fecha_vto: '2026-08-20',
    fecha_recepcion: '2026-08-01',
    estado: 'en_cartera',
    notas: '',
    cliente_razon_social: 'Cliente Test SRL',
    cliente_nombre_fantasia: 'Cliente Test',
    total_count: 2,
    ...overrides,
  };
}

function chequeVencido(overrides = {}) {
  return chequeCartera({
    id: CHEQUE_VENCIDO_ID,
    numero: '00005678',
    monto: 7000,
    vencimiento: '2026-01-01',
    fecha_vto: '2026-01-01',
    ...overrides,
  });
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page, { kpis = KPIS_BASE, lista = [chequeCartera(), chequeVencido()] } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);

  mockearTabla(page, 'clientes', { onSelect: () => CLIENTES });
  mockearRpc(page, 'fn_cheques_contadores', () => kpis); // .single() → objeto, no array
  const paramsVistos = [];
  const obtenerLlamadasLista = mockearRpc(page, 'fn_cheques_lista', ({ params }) => {
    paramsVistos.push(params);
    return lista;
  });

  const chequesPage = new ChequesPage(page, staticServer.baseURL);
  return { chequesPage, obtenerLlamadasLista, paramsVistos };
}

test.describe('Cheques (admin) — Fase 2 P1', () => {
  test('la lista carga desde fn_cheques_lista, los KPIs desde fn_cheques_contadores y se muestra la alerta de vencimientos', async ({ page }) => {
    const { chequesPage } = await armarPagina(page);
    const erroresConsola = chequesPage.capturarErroresConsola();

    await chequesPage.goto();

    await expect(chequesPage.fila(CHEQUE_CARTERA_ID)).toBeVisible();
    await expect(chequesPage.fila(CHEQUE_CARTERA_ID)).toContainText('Cliente Test');
    await expect(chequesPage.fila(CHEQUE_CARTERA_ID)).toContainText('Banco Nación');
    await expect(chequesPage.fila(CHEQUE_CARTERA_ID)).toContainText(formatPesoEsperado(8000));
    await expect(chequesPage.fila(CHEQUE_CARTERA_ID)).toContainText('En cartera');

    // Migración a FiltroTabs (2026-08-09): ya no hay tarjetas KPI de
    // monto para cartera/cobrado/rechazado — son contadores en las
    // pestañas de arriba de la tabla. El único monto visible sigue
    // siendo "Vencen en 3 días".
    await expect(chequesPage.kpiCarteraCount).toHaveText('2');
    await expect(chequesPage.kpiProximos).toHaveText(formatPesoEsperado(KPIS_BASE.monto_proximos));
    await expect(chequesPage.kpiCobradosCount).toHaveText(String(KPIS_BASE.cant_cobrado_mes));
    await expect(chequesPage.kpiRechazadosCount).toHaveText(String(KPIS_BASE.cant_rechazados));

    // cant_proximos=1 → la alerta de "vencen en los próximos 3 días" se muestra.
    await expect(chequesPage.alertaVencimientos).toBeVisible();
    await expect(chequesPage.alertaVencimientos).toContainText('1 cheque vence en los próximos 3 días');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('sin cheques próximos a vencer, la alerta no se muestra', async ({ page }) => {
    const { chequesPage } = await armarPagina(page, {
      kpis: { ...KPIS_BASE, cant_proximos: 0, monto_proximos: 0 },
    });

    await chequesPage.goto();

    await expect(chequesPage.alertaVencimientos).toBeHidden();
  });

  test('buscar y filtrar por estado disparan fn_cheques_lista con los parámetros correctos', async ({ page }) => {
    const { chequesPage, paramsVistos } = await armarPagina(page);

    await chequesPage.goto();
    // FIX: goto()/esperarAppLista() solo espera a que el preloader se
    // oculte y #nav-root esté en el DOM — no a que la carga inicial de
    // authReady (el `await Promise.all([cargarContadoresCheques(),
    // cargarClientes()])` + `await filtrarCheques()` final) haya
    // terminado. Esa carga inicial dispara su propia llamada a
    // fn_cheques_lista, que puede seguir en vuelo acá; leer/resetear
    // paramsVistos de forma sincrónica justo después de goto() es una
    // carrera — puede pisar el reset o llegar después del `at(-1)` de la
    // búsqueda. Se espera de forma robusta con expect.poll a que la carga
    // inicial haya empujado su llamada antes de descartarla, y se lee
    // cada assert siguiente también con expect.poll en vez de una lectura
    // sincrónica del array.
    await expect.poll(() => paramsVistos.length).toBeGreaterThan(0);
    paramsVistos.length = 0; // descarta la carga inicial

    await chequesPage.buscar('Cliente Test');
    await expect.poll(() => paramsVistos.at(-1)).toMatchObject({ p_busqueda: 'Cliente Test', p_offset: 0 });

    await chequesPage.filtrarPorEstadoTab('rechazado');
    await expect.poll(() => paramsVistos.at(-1)).toMatchObject({ p_estado: 'rechazado', p_offset: 0 });

    await chequesPage.filtroSoloVencidos.check();
    await expect.poll(() => paramsVistos.at(-1)).toMatchObject({ p_solo_vencidos: true });
  });

  test('paginación server-side: "Siguiente" vuelve a pedir la página con offset', async ({ page }) => {
    // Setup propio (no usa armarPagina) para que el handler de
    // fn_cheques_lista pueda variar la respuesta según el offset —
    // ITEMS_POR_PAGINA_CHEQUES=100, total_count=150 → 2 páginas.
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await vendorizarSupabase(page);
    await loguearComoAdmin(page);

    mockearTabla(page, 'clientes', { onSelect: () => CLIENTES });
    mockearRpc(page, 'fn_cheques_contadores', () => KPIS_BASE);
    const offsetsVistos = [];
    mockearRpc(page, 'fn_cheques_lista', ({ params }) => {
      offsetsVistos.push(params.p_offset);
      return [chequeCartera({ id: `e2e-cheque-pag-${params.p_offset}`, total_count: 150 })];
    });

    const chequesPage = new ChequesPage(page, staticServer.baseURL);
    await chequesPage.goto();

    await expect(chequesPage.btnPaginaSiguiente).toBeEnabled();
    await chequesPage.btnPaginaSiguiente.click();

    await expect(chequesPage.infoPaginacion).toContainText('Página 2 de 2');
    expect(offsetsVistos.at(-1)).toBe(100);
  });

  test('alta de un cheque nuevo: confirma, envía el POST correcto y refresca lista + KPIs', async ({ page }) => {
    const { chequesPage } = await armarPagina(page);

    let bodyCapturado = null;
    let metodoCapturado = null;
    await page.route('**/rest/v1/cheques**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        metodoCapturado = 'POST';
        bodyCapturado = JSON.parse(request.postData());
        await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await chequesPage.goto();
    await chequesPage.abrirModalNuevo();
    await expect(chequesPage.modalTitulo).toHaveText('Nuevo cheque');

    await chequesPage.completarFormulario({
      clienteId: CLIENTE_ID,
      numero: '00009999',
      banco: 'Banco Galicia',
      monto: 12000,
      vencimiento: '2026-09-15',
    });
    await chequesPage.guardar();

    await chequesPage.esperarToastExito('Cheque registrado');

    expect(metodoCapturado).toBe('POST');
    expect(bodyCapturado).toMatchObject({
      cliente_id: CLIENTE_ID,
      numero: '00009999',
      banco: 'Banco Galicia',
      monto: 12000,
      vencimiento: '2026-09-15',
      fecha_vto: '2026-09-15', // FIX: se mantiene sincronizada con vencimiento
      estado: 'en_cartera',
    });
  });

  test('editar un cheque existente precarga el formulario y envía el PATCH con el id correcto', async ({ page }) => {
    const { chequesPage } = await armarPagina(page);

    let bodyCapturado = null;
    let urlCapturada = null;
    await page.route('**/rest/v1/cheques**', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        urlCapturada = request.url();
        bodyCapturado = JSON.parse(request.postData());
        await route.fulfill({ status: 204, contentType: 'application/json', body: '' });
        return;
      }
      return route.fallback();
    });

    await chequesPage.goto();
    await chequesPage.editar(CHEQUE_CARTERA_ID);

    await expect(chequesPage.modalTitulo).toHaveText('Editar cheque');
    await expect(chequesPage.inputNumero).toHaveValue('00001234');
    await expect(chequesPage.inputBanco).toHaveValue('Banco Nación');
    await expect(chequesPage.inputMonto).toHaveValue('8000');

    await chequesPage.inputBanco.fill('Banco Galicia');
    await chequesPage.guardar();

    await chequesPage.esperarToastExito('Cheque actualizado');

    expect(urlCapturada).toContain(`id=eq.${CHEQUE_CARTERA_ID}`);
    expect(bodyCapturado).toMatchObject({ banco: 'Banco Galicia' });
  });

  test('cambiar el estado a "rechazado" desde el select de la fila envía el PATCH y muestra el toast de alerta', async ({ page }) => {
    const { chequesPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/rest/v1/cheques**', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        bodyCapturado = JSON.parse(request.postData());
        await route.fulfill({ status: 204, contentType: 'application/json', body: '' });
        return;
      }
      return route.fallback();
    });

    await chequesPage.goto();
    await chequesPage.cambiarEstadoFila(CHEQUE_CARTERA_ID, 'rechazado');

    // Rechazado dispara un toast distinto (alerta de crédito), no el
    // genérico "Estado actualizado" — ver cheques.js::cambiarEstado.
    await chequesPage.esperarToastExito('Cheque rechazado de Cliente Test');
    expect(bodyCapturado).toEqual({ estado: 'rechazado' });
  });

  test('cambiar el estado a un valor no terminal muestra el toast genérico', async ({ page }) => {
    const { chequesPage } = await armarPagina(page);

    await page.route('**/rest/v1/cheques**', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 204, contentType: 'application/json', body: '' });
        return;
      }
      return route.fallback();
    });

    await chequesPage.goto();
    await chequesPage.cambiarEstadoFila(CHEQUE_CARTERA_ID, 'depositado');

    await chequesPage.esperarToastExito('Estado actualizado');
  });

  test('verificación BCRA: cheque sin denuncia registrada', async ({ page }) => {
    const { chequesPage } = await armarPagina(page);
    mockApi(page, {
      '/api/bcra': ({ request }) => {
        const url = new URL(request.url());
        if (url.searchParams.get('accion') === 'entidades') {
          return { json: { entidades: [{ codigoEntidad: '11', denominacion: 'Banco Nación' }] } };
        }
        return { json: { encontrado: true, resultado: { denunciado: false } } };
      },
    });

    await chequesPage.goto();
    await chequesPage.abrirModalBcra(CHEQUE_CARTERA_ID);

    await expect(chequesPage.inputBcraNumero).toHaveValue('00001234');
    await chequesPage.selBcraEntidad.selectOption('11');
    await chequesPage.consultarBcra();

    await expect(chequesPage.bcraResultado).toContainText('Sin denuncia registrada');
  });

  test('verificación BCRA: cheque denunciado muestra el detalle', async ({ page }) => {
    const { chequesPage } = await armarPagina(page);
    mockApi(page, {
      '/api/bcra': ({ request }) => {
        const url = new URL(request.url());
        if (url.searchParams.get('accion') === 'entidades') {
          return { json: { entidades: [{ codigoEntidad: '11', denominacion: 'Banco Nación' }] } };
        }
        return {
          json: {
            encontrado: true,
            resultado: {
              denunciado: true,
              fechaProcesamiento: '2026-07-01',
              detalles: [{ sucursal: '100', numeroCuenta: '12345', causal: 'Robo' }],
            },
          },
        };
      },
    });

    await chequesPage.goto();
    await chequesPage.abrirModalBcra(CHEQUE_CARTERA_ID);
    await chequesPage.selBcraEntidad.selectOption('11');
    await chequesPage.consultarBcra();

    await expect(chequesPage.bcraResultado).toContainText('Cheque denunciado');
    await chequesPage.bcraResultado.getByRole('button', { name: 'Ver detalle' }).click();
    await expect(chequesPage.bcraResultado).toContainText('Robo');
  });
});
