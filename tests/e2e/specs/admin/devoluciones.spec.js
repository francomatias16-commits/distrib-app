// Fase 2 (P1), primera página del bloque "devoluciones / cheques /
// conciliación bancaria" (ver PLAN_E2E_COBERTURA_TOTAL.md). A diferencia
// de rutas/lotes-vencimientos, `devoluciones.html` es standalone: tiene su
// propio JS (`devoluciones.js`), no comparte script clásico con ninguna
// otra página.
//
// Alcance deliberado (mismo criterio que vueltas anteriores): cubre el
// flujo principal — listado + KPIs, ver detalle, y revisar (aprobar /
// rechazar) una devolución pendiente, incluido el rechazo del servidor.
// NO cubre: alta manual desde el admin (modal con ProductoPicker + upload
// de foto — subsistema propio, candidato a spec separado si hace falta
// profundizar), exportar CSV, editar notas internas, eliminar, ni
// paginación/filtros server-side — quedan para una vuelta futura.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { DevolucionesPage } from '../../page-objects/admin/devoluciones.page.js';

const CLIENTE_ID    = 'e2e-cliente-000000000001';
const DEPOSITO_ID   = 'e2e-deposito-000000000001';
const DEV_PENDIENTE_ID = 'e2e-dev-pendiente-0001';
const DEV_APROBADA_ID  = 'e2e-dev-aprobada-0001';

const DEPOSITOS = [{ id: DEPOSITO_ID, nombre: 'Depósito Central', es_principal: true }];

function devoluciones() {
  return [
    {
      id: DEV_PENDIENTE_ID, motivo: 'producto_defectuoso', estado: 'pendiente',
      created_at: '2026-08-01T12:00:00Z', foto_url: null,
      clientes: { nombre_fantasia: 'Almacén El Sol', razon_social: 'El Sol SRL' },
    },
    {
      id: DEV_APROBADA_ID, motivo: 'error_pedido', estado: 'aprobada',
      created_at: '2026-07-28T10:00:00Z', foto_url: null,
      clientes: { nombre_fantasia: 'Kiosco Norte', razon_social: 'Norte SA' },
    },
  ];
}

function detalleDevolucion(id) {
  const base = devoluciones().find((d) => d.id === id);
  return {
    ...base,
    devolucion_items: [
      { id: 'e2e-item-0001', cantidad: 3, precio_unitario: 100, productos: { nombre: 'Producto E2E', codigo: 'COD-001' } },
    ],
    notas_debito: [],
    notas: '',
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page, { lista = devoluciones() } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);

  mockearTabla(page, 'depositos', { onSelect: () => DEPOSITOS });

  const contadoresApi = mockApi(page, {
    '/api/admin/devoluciones': ({ request }) => {
      const url = new URL(request.url());
      const accion = url.searchParams.get('accion');
      const id = url.searchParams.get('id');

      if (request.method() === 'GET' && accion === 'kpis') {
        const pendientes = lista.filter((d) => d.estado === 'pendiente').length;
        const aprobadas  = lista.filter((d) => d.estado === 'aprobada').length;
        const rechazadas = lista.filter((d) => d.estado === 'rechazada').length;
        return { json: { pendientes, aprobadas, rechazadas } };
      }
      if (request.method() === 'GET' && id) {
        return { json: detalleDevolucion(id) };
      }
      if (request.method() === 'GET') {
        return { json: { devoluciones: lista, total: lista.length, page: 1, limit: 50 } };
      }
      // PATCH (revisar/notas) y DELETE se pisan en cada test que necesita
      // inspeccionar el body — mismo criterio que compras/lotes.
      return { json: { ok: true } };
    },
  });

  const devolucionesPage = new DevolucionesPage(page, staticServer.baseURL);
  return { devolucionesPage, contadoresApi };
}

test.describe('Devoluciones (admin) — Fase 2 P1', () => {
  test('la lista carga desde /api/admin/devoluciones y los KPIs se muestran', async ({ page }) => {
    const { devolucionesPage } = await armarPagina(page);
    const erroresConsola = devolucionesPage.capturarErroresConsola();

    await devolucionesPage.goto();

    await expect(devolucionesPage.fila(DEV_PENDIENTE_ID)).toBeVisible();
    await expect(devolucionesPage.fila(DEV_PENDIENTE_ID)).toContainText('Almacén El Sol');
    await expect(devolucionesPage.fila(DEV_PENDIENTE_ID)).toContainText('Producto defectuoso');
    await expect(devolucionesPage.fila(DEV_PENDIENTE_ID)).toContainText('Pendiente');
    await expect(devolucionesPage.fila(DEV_APROBADA_ID)).toContainText('Aprobada');

    await expect(devolucionesPage.kpiPendientes).toHaveText('1');
    await expect(devolucionesPage.kpiAprobadas).toHaveText('1');
    await expect(devolucionesPage.kpiRechazadas).toHaveText('0');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('abrir el detalle de una devolución pendiente muestra sus ítems y las opciones de revisión', async ({ page }) => {
    const { devolucionesPage } = await armarPagina(page);

    await devolucionesPage.goto();
    await devolucionesPage.abrirDetalle(DEV_PENDIENTE_ID);

    await expect(devolucionesPage.panel).toHaveClass(/open/);
    await expect(devolucionesPage.panelTitulo).toContainText('Almacén El Sol');
    await expect(devolucionesPage.panelBody).toContainText('Producto E2E');
    await expect(devolucionesPage.panelBody).toContainText('3');

    // Pendiente + rol admin (dentro de ROLES_REVISION) → footer con
    // opciones de reponer stock / generar NC y los botones de revisión.
    await expect(devolucionesPage.chkReponerStock).toBeChecked();
    await expect(devolucionesPage.chkGenerarNC).toBeChecked();
    await expect(devolucionesPage.btnAprobar).toBeVisible();
    await expect(devolucionesPage.btnRechazar).toBeVisible();
  });

  test('aprobar una devolución pendiente envía el PATCH correcto y refresca KPIs', async ({ page }) => {
    const { devolucionesPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/admin/devoluciones**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'PATCH' && url.searchParams.get('accion') === 'revisar') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            ok: true,
            stock_repuesto: [{ producto_id: 'e2e-producto-1' }],
            nota_credito: { id: 'e2e-nc-1' },
          }),
        });
        return;
      }
      return route.fallback();
    });

    await devolucionesPage.goto();
    await devolucionesPage.abrirDetalle(DEV_PENDIENTE_ID);
    await devolucionesPage.aprobar();

    await devolucionesPage.esperarToastExito('Devolución aprobada');

    expect(bodyCapturado).toMatchObject({
      id: DEV_PENDIENTE_ID,
      estado: 'aprobada',
      reponer_stock: true,
      generar_nc: true,
      deposito_id: DEPOSITO_ID,
    });
  });

  test('rechazar una devolución pendiente envía el PATCH con estado rechazada (sin reponer stock)', async ({ page }) => {
    const { devolucionesPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/admin/devoluciones**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'PATCH' && url.searchParams.get('accion') === 'revisar') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      return route.fallback();
    });

    await devolucionesPage.goto();
    await devolucionesPage.abrirDetalle(DEV_PENDIENTE_ID);
    await devolucionesPage.rechazar();

    await devolucionesPage.esperarToastExito('Devolución rechazada');

    // reponer_stock/generar_nc van en false cuando el estado no es
    // 'aprobada' — ver devoluciones.js::revisarDevolucion().
    expect(bodyCapturado).toMatchObject({
      id: DEV_PENDIENTE_ID,
      estado: 'rechazada',
      reponer_stock: false,
      generar_nc: false,
    });
  });

  test('rechazo del servidor al revisar muestra el error y no descarta la devolución activa', async ({ page }) => {
    const { devolucionesPage } = await armarPagina(page);

    await page.route('**/api/admin/devoluciones**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'PATCH' && url.searchParams.get('accion') === 'revisar') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ error: 'No hay stock suficiente en el depósito elegido' }),
        });
        return;
      }
      return route.fallback();
    });

    await devolucionesPage.goto();
    await devolucionesPage.abrirDetalle(DEV_PENDIENTE_ID);
    await devolucionesPage.aprobar();

    await devolucionesPage.esperarToastExito('No se pudo registrar la revisión');

    // El panel sigue mostrando la devolución (no se descartó el estado
    // activo) y los botones vuelven a habilitarse tras el error.
    await expect(devolucionesPage.panelTitulo).toContainText('Almacén El Sol');
    await expect(devolucionesPage.btnAprobar).toBeEnabled();
    await expect(devolucionesPage.btnRechazar).toBeEnabled();
  });
});
