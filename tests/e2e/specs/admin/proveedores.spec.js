// Fase 2 (P1), segunda página del bloque "usuarios / proveedores / notas /
// presupuestos" (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 25).
// `proveedores.html` es standalone: JS propio (`proveedores.js`), CRUD
// contra `/api/proveedores` (`lib/handlers/proveedores.js`) — sin
// PostgREST directo para su propio dominio (las 2 queries a
// `usuarios`/`empresas` que sí ve la página son las de `auth.js`
// resolviendo el perfil logueado, ver auth-helper.js). Suma un sub-router
// `_svc=portal-admin` para el portal de autogestión del proveedor
// (#10 — Vidriera Inversa).
//
// Alcance deliberado: listado + filtro activo/búsqueda (server-side desde
// v282, no in-memory — ver nota en proveedores.page.js), alta sin
// confirmación, edición sin confirmación, dar de baja CON confirmación,
// activar sin confirmación, generar link del portal, y el panel "Links de
// acceso activos" (carga + revocar con confirmación). NO cubre: paginación
// más allá de 200 registros, envío del link por WhatsApp (abre
// `wa.me` en pestaña nueva, fuera del alcance de Playwright sin mockear
// `window.open`), ni el detalle de "ver compras" (navega a
// `compras.html?proveedor=<id>`, cubierto por compras.spec.js) — quedan
// para una vuelta futura si hace falta profundizar.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { ProveedoresPage } from '../../page-objects/admin/proveedores.page.js';

const PROV_ACTIVO_ID   = 'e2e-proveedor-activo-0001';
const PROV_INACTIVO_ID = 'e2e-proveedor-inactivo-0001';
const LINK_ID = 'e2e-link-portal-0001';

function proveedores() {
  return [
    {
      id: PROV_ACTIVO_ID, razon_social: 'García Distribuciones S.A.', nombre_fantasia: 'García Distrib',
      cuit: '20-12345678-9', contacto: 'Marcos García', telefono: '3482111111', dias_pago: 30,
      activo: true, condicion_iva: 'responsable_inscripto', email: 'compras@garcia.com',
      domicilio: 'Av. Siempre Viva 123', localidad: 'Reconquista', notas: '',
    },
    {
      id: PROV_INACTIVO_ID, razon_social: 'Ex Proveedor SRL', nombre_fantasia: '',
      cuit: '20-99999999-9', contacto: '', telefono: '', dias_pago: 0,
      activo: false, condicion_iva: 'monotributo', email: '', domicilio: '', localidad: '', notas: '',
    },
  ];
}

function linksPorProveedor() {
  return {
    [PROV_ACTIVO_ID]: [{
      id: LINK_ID, estado: 'activo', usos: 3,
      creado_at: '2026-06-01T12:00:00Z', expira_at: '2026-09-01T12:00:00Z',
      ultimo_uso_at: '2026-07-15T12:00:00Z', usuarios: { nombre: 'Vos Admin' },
    }],
    [PROV_INACTIVO_ID]: [],
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page, { rol = 'admin', lista } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page, { rol });
  const listaFinal = lista || proveedores();
  const links = linksPorProveedor();

  const contadoresApi = mockApi(page, {
    '/api/proveedores': ({ request }) => {
      const url = new URL(request.url());
      const svc = url.searchParams.get('_svc');
      const accion = url.searchParams.get('accion');

      if (request.method() === 'GET' && svc === 'portal-admin' && accion === 'links') {
        const proveedorId = url.searchParams.get('proveedor_id');
        return { json: { links: links[proveedorId] || [] } };
      }
      if (request.method() === 'POST' && svc === 'portal-admin' && accion === 'generar-link') {
        return {
          json: {
            ok: true, url: `${staticServer.baseURL}/portal/proveedor?token=e2e-token-abc`,
            expira_at: '2026-09-08T00:00:00Z', dias_validez: 30,
          },
        };
      }
      if (request.method() === 'POST' && svc === 'portal-admin' && accion === 'revocar') {
        return { json: { ok: true } };
      }

      if (request.method() === 'GET') {
        const id = url.searchParams.get('id');
        if (id) return { json: listaFinal.find((p) => p.id === id) || {} };

        const activo = url.searchParams.get('activo');
        const busqueda = (url.searchParams.get('busqueda') || '').toLowerCase();
        let filtrados = listaFinal;
        if (activo === 'true') filtrados = filtrados.filter((p) => p.activo);
        if (activo === 'false') filtrados = filtrados.filter((p) => !p.activo);
        if (busqueda) {
          filtrados = filtrados.filter((p) =>
            p.razon_social.toLowerCase().includes(busqueda) ||
            (p.nombre_fantasia || '').toLowerCase().includes(busqueda) ||
            (p.cuit || '').includes(busqueda));
        }
        return { json: { proveedores: filtrados, total: filtrados.length } };
      }

      // POST (alta) / PATCH (edición, activar) / DELETE (baja) se pisan en
      // cada test que necesita inspeccionar el body.
      return { json: { ok: true } };
    },
  });

  const proveedoresPage = new ProveedoresPage(page, staticServer.baseURL);
  return { proveedoresPage, contadoresApi, listaFinal };
}

test.describe('Proveedores (admin) — Fase 2 P1', () => {
  test('la lista carga desde /api/proveedores y oculta inactivos por defecto (filtro activo=true)', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);
    const erroresConsola = proveedoresPage.capturarErroresConsola();

    await proveedoresPage.goto();

    await expect(proveedoresPage.fila(PROV_ACTIVO_ID)).toBeVisible();
    await expect(proveedoresPage.fila(PROV_ACTIVO_ID)).toContainText('García Distribuciones S.A.');
    await expect(proveedoresPage.fila(PROV_ACTIVO_ID)).toContainText('20-12345678-9');
    await expect(proveedoresPage.fila(PROV_INACTIVO_ID)).toHaveCount(0);

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('cambiar el filtro a "Todos" muestra también los inactivos', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);

    await proveedoresPage.goto();
    await proveedoresPage.filtrarPorActivo('');

    await expect(proveedoresPage.fila(PROV_INACTIVO_ID)).toBeVisible();
    await expect(proveedoresPage.fila(PROV_INACTIVO_ID)).toContainText('Ex Proveedor SRL');
  });

  test('buscar dispara una request server-side con el término de búsqueda (no filtrado in-memory)', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);

    let ultimaBusqueda = null;
    await page.route('**/api/proveedores**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET' && !url.searchParams.get('id') && !url.searchParams.get('_svc')) {
        ultimaBusqueda = url.searchParams.get('busqueda');
      }
      return route.fallback();
    });

    await proveedoresPage.goto();
    await proveedoresPage.buscar('garcía');

    expect(ultimaBusqueda).toBe('garcía');
    await expect(proveedoresPage.fila(PROV_ACTIVO_ID)).toBeVisible();
  });

  test('alta de un proveedor nuevo: sin confirmación, envía el POST correcto y refresca la lista', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/proveedores**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && !url.searchParams.get('_svc')) {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({
          status: 201, contentType: 'application/json',
          body: JSON.stringify({ id: 'e2e-proveedor-nuevo-0001', ...bodyCapturado }),
        });
        return;
      }
      return route.fallback();
    });

    await proveedoresPage.goto();
    await proveedoresPage.abrirModalNuevo();
    await expect(proveedoresPage.modalTitulo).toHaveText('Nuevo proveedor');

    await proveedoresPage.completarFormulario({
      razonSocial: 'Nuevo Proveedor S.R.L.', cuit: '20-11122233-4',
      contacto: 'Ana López', telefono: '3482222222', diasPago: 15,
    });
    await proveedoresPage.guardar();

    await proveedoresPage.esperarToastExito('Proveedor creado');
    expect(bodyCapturado).toMatchObject({
      razon_social: 'Nuevo Proveedor S.R.L.', cuit: '20-11122233-4',
      contacto: 'Ana López', telefono: '3482222222', dias_pago: 15,
    });
  });

  test('editar un proveedor existente precarga el formulario y envía el PATCH correcto', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/proveedores**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'PATCH' && !url.searchParams.get('_svc')) {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await proveedoresPage.goto();
    await proveedoresPage.abrirModalEditar(PROV_ACTIVO_ID);

    await expect(proveedoresPage.modalTitulo).toHaveText('Editar proveedor');
    await expect(proveedoresPage.inputRazonSocial).toHaveValue('García Distribuciones S.A.');
    await expect(proveedoresPage.inputCuit).toHaveValue('20-12345678-9');

    await proveedoresPage.inputTelefono.fill('3482999999');
    await proveedoresPage.guardar();

    await proveedoresPage.esperarToastExito('Proveedor actualizado');
    expect(bodyCapturado).toMatchObject({ id: PROV_ACTIVO_ID, telefono: '3482999999' });
  });

  test('dar de baja un proveedor pide confirmación y envía el DELETE correcto', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);

    let idBorrado = null;
    await page.route('**/api/proveedores**', async (route) => {
      const request = route.request();
      if (request.method() === 'DELETE') {
        idBorrado = new URL(request.url()).searchParams.get('id');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await proveedoresPage.goto();
    await proveedoresPage.desactivarFila(PROV_ACTIVO_ID);

    await proveedoresPage.esperarToastExito('Proveedor dado de baja');
    expect(idBorrado).toBe(PROV_ACTIVO_ID);
  });

  test('activar un proveedor inactivo envía el PATCH con activo:true, SIN pedir confirmación', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/proveedores**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'PATCH' && !url.searchParams.get('_svc')) {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await proveedoresPage.goto();
    await proveedoresPage.filtrarPorActivo('');
    await proveedoresPage.activarFila(PROV_INACTIVO_ID);

    await proveedoresPage.esperarToastExito('Proveedor activado');
    expect(bodyCapturado).toEqual({ id: PROV_INACTIVO_ID, activo: true });
  });

  test('generar el link del portal de un proveedor lo pega en el modal, listo para copiar', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);

    await proveedoresPage.goto();
    await proveedoresPage.abrirPortalFila(PROV_ACTIVO_ID);

    await expect(proveedoresPage.portalTitulo).toContainText('García Distribuciones S.A.');
    await expect(proveedoresPage.portalLinkInput).toHaveValue(/token=e2e-token-abc/);
    await expect(proveedoresPage.btnEnviarWhatsapp).toBeVisible(); // el fixture tiene teléfono cargado
  });

  test('el panel "Links de acceso activos" carga los links vigentes y revocar pide confirmación', async ({ page }) => {
    const { proveedoresPage } = await armarPagina(page);

    await proveedoresPage.goto();

    await expect(proveedoresPage.filaLink(LINK_ID)).toBeVisible();
    await expect(proveedoresPage.filaLink(LINK_ID)).toContainText('García Distribuciones S.A.');
    await expect(proveedoresPage.filaLink(LINK_ID)).toContainText('3'); // usos

    await proveedoresPage.revocarLink(LINK_ID);

    await proveedoresPage.esperarToastExito('Link revocado correctamente');
    await expect(proveedoresPage.filaLink(LINK_ID)).toHaveCount(0);
  });
});
