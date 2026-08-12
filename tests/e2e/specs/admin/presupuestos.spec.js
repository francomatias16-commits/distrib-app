// Fase 2 (P1), cuarta y última página del bloque "usuarios / proveedores /
// notas / presupuestos" (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 27).
// NO es standalone: vive como pestaña de `pedidos.html` (el módulo real
// es `presupuestos.js`, cargado condicionalmente) — `presupuestos.html`
// es solo un stub de redirect de compatibilidad. Ver el page object para
// el detalle completo de por qué esto es así y qué mecanismos de esta
// pestaña rompen el patrón de las otras 3 páginas del bloque (búsqueda
// in-memory en vez de server-side, y TRES mecanismos de confirmación
// distintos en la misma pantalla).
//
// Alcance deliberado: listado + filtro por estado (server-side) + buscar
// (in-memory, sin request nuevo), ver detalle, eliminar un borrador
// (confirmación custom, desde la fila), rechazar un enviado (confirm()
// nativo, desde el panel, con su cancelación), aceptar y generar pedido
// (sin confirmación, incluyendo el caso "otro usuario ya lo procesó"), y
// enviar por WhatsApp (captura la URL de wa.me sin dejarla navegar). NO
// cubre: alta de presupuesto nuevo (usa `ProductoPicker`, misma razón por
// la que pedidos.spec.js dejó afuera "crear pedido" — ver el page object).

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRestGenerico, mockearApiGenerico, mockearTabla } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { PresupuestosPage } from '../../page-objects/admin/presupuestos.page.js';

const PRES_BORRADOR_ID = 'e2e-presupuesto-borrador-001';
const PRES_ENVIADO_ID  = 'e2e-presupuesto-enviado-001';

function listaPresupuestos() {
  return [
    {
      id: PRES_BORRADOR_ID, numero: 'PRE-00001001', estado: 'borrador', total: 12500,
      fecha_vencimiento: null,
      clientes: { nombre_fantasia: null, razon_social: 'Cliente Borrador SRL' },
      usuarios: { nombre: 'Vos Admin' },
    },
    {
      id: PRES_ENVIADO_ID, numero: 'PRE-00001002', estado: 'enviado', total: 8300,
      fecha_vencimiento: '2026-09-01',
      clientes: { nombre_fantasia: 'Cliente Enviado', razon_social: 'Cliente Enviado S.A.' },
      usuarios: { nombre: 'Vos Admin' },
    },
  ];
}

function detalle(id) {
  const base = listaPresupuestos().find((p) => p.id === id);
  return {
    ...base,
    notas: 'Entrega en el depósito central',
    pedido_id: null,
    clientes: { ...base.clientes, telefono: '3482111111' },
    presupuesto_items: [
      { descripcion: 'Producto E2E', cantidad: 3, precio_unitario: 2500, descuento_pct: 0, subtotal: 7500 },
    ],
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);
  mockearTabla(page, 'clientes', { onSelect: () => [] });

  const contadoresApi = mockApi(page, {
    '/api/presupuestos': ({ request }) => {
      const url = new URL(request.url());
      const id = url.searchParams.get('id');
      const accion = url.searchParams.get('accion');

      if (request.method() === 'GET' && accion === 'precios-cliente') return { json: [] };
      if (request.method() === 'GET' && id) return { json: detalle(id) };

      if (request.method() === 'GET') {
        const estado = url.searchParams.get('estado');
        const lista = listaPresupuestos();
        return { json: estado ? lista.filter((p) => p.estado === estado) : lista };
      }

      // DELETE / PATCH se pisan en cada test que necesita inspeccionar el body o el resultado.
      return { json: { ok: true } };
    },
  });

  const presupuestosPage = new PresupuestosPage(page, staticServer.baseURL);
  return { presupuestosPage, contadoresApi };
}

test.describe('Presupuestos (admin, pestaña de pedidos.html) — Fase 2 P1', () => {
  test('la lista carga desde /api/presupuestos y muestra los datos de cada fila', async ({ page }) => {
    const { presupuestosPage } = await armarPagina(page);
    const erroresConsola = presupuestosPage.capturarErroresConsola();

    await presupuestosPage.goto();

    await expect(presupuestosPage.fila(PRES_BORRADOR_ID)).toContainText('PRE-00001001');
    await expect(presupuestosPage.fila(PRES_BORRADOR_ID)).toContainText('Cliente Borrador SRL');
    await expect(presupuestosPage.fila(PRES_ENVIADO_ID)).toContainText('Cliente Enviado');
    await expect(presupuestosPage.contador).toContainText('2 presupuestos');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('filtrar por un pill de estado dispara una nueva carga server-side con el querystring correcto', async ({ page }) => {
    let ultimoEstado = 'sin-pedir';
    const { presupuestosPage } = await armarPagina(page);

    await page.route('**/api/presupuestos**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET' && !url.searchParams.get('id')) {
        ultimoEstado = url.searchParams.get('estado');
      }
      return route.fallback();
    });

    await presupuestosPage.goto();
    await presupuestosPage.filtrarPorEstado('enviado');

    expect(ultimoEstado).toBe('enviado');
    await expect(presupuestosPage.fila(PRES_ENVIADO_ID)).toBeVisible();
    await expect(presupuestosPage.fila(PRES_BORRADOR_ID)).toHaveCount(0);
  });

  test('buscar filtra EN EL NAVEGADOR — no dispara un request nuevo a /api/presupuestos', async ({ page }) => {
    const { presupuestosPage, contadoresApi } = await armarPagina(page);

    await presupuestosPage.goto();
    const llamadasAntes = contadoresApi['/api/presupuestos'];

    await presupuestosPage.buscar('cliente enviado');

    expect(contadoresApi['/api/presupuestos']).toBe(llamadasAntes); // sin request nuevo
    await expect(presupuestosPage.fila(PRES_ENVIADO_ID)).toBeVisible();
    await expect(presupuestosPage.fila(PRES_BORRADOR_ID)).toHaveCount(0);
  });

  test('ver el detalle de un presupuesto enviado muestra sus ítems y las acciones correspondientes', async ({ page }) => {
    const { presupuestosPage } = await armarPagina(page);

    await presupuestosPage.goto();
    await presupuestosPage.abrirDetalle(PRES_ENVIADO_ID);

    await expect(presupuestosPage.panelNombre).toHaveText('PRE-00001002');
    await expect(presupuestosPage.panelBody).toContainText('Producto E2E');
    await expect(presupuestosPage.panelBody).toContainText('Entrega en el depósito central');
    await expect(presupuestosPage.botonPanel('pres_aceptarYGenerarPedido')).toBeVisible();
    await expect(presupuestosPage.botonPanel('pres_rechazar')).toBeVisible();
  });

  test('eliminar un borrador desde la fila pide confirmación (overlay custom) y envía el DELETE correcto', async ({ page }) => {
    const { presupuestosPage } = await armarPagina(page);

    let idBorrado = null;
    await page.route('**/api/presupuestos**', async (route) => {
      const request = route.request();
      if (request.method() === 'DELETE') {
        idBorrado = new URL(request.url()).searchParams.get('id');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      return route.fallback();
    });

    await presupuestosPage.goto();
    await presupuestosPage.eliminarFila(PRES_BORRADOR_ID);

    await presupuestosPage.esperarToastExito('Presupuesto eliminado');
    expect(idBorrado).toBe(PRES_BORRADOR_ID);
  });

  test('rechazar desde el panel usa el confirm() nativo del navegador — cancelarlo no dispara el PATCH', async ({ page }) => {
    const { presupuestosPage } = await armarPagina(page);

    let llamadasPatch = 0;
    await page.route('**/api/presupuestos**', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') { llamadasPatch += 1; }
      return route.fallback();
    });

    await presupuestosPage.goto();
    await presupuestosPage.abrirDetalle(PRES_ENVIADO_ID);
    await presupuestosPage.rechazarDesdePanelYCancelar();

    expect(llamadasPatch).toBe(0);

    await presupuestosPage.rechazarDesdePanel();
    await presupuestosPage.esperarToastExito('Estado actualizado a "rechazado"');
    expect(llamadasPatch).toBe(1);
  });

  test('aceptar y generar pedido sin confirmación; si otro usuario ya lo procesó, avisa y refresca la lista', async ({ page }) => {
    const { presupuestosPage } = await armarPagina(page);

    let bodyEnviado = null;
    await page.route('**/api/presupuestos**', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        bodyEnviado = request.postDataJSON();
        await route.fulfill({
          status: 409, contentType: 'application/json',
          body: JSON.stringify({ codigo: 'presupuesto_ya_convertido', error: 'Ya fue procesado' }),
        });
        return;
      }
      return route.fallback();
    });

    await presupuestosPage.goto();
    await presupuestosPage.abrirDetalle(PRES_ENVIADO_ID);
    await presupuestosPage.aceptarYGenerarPedidoDesdePanel();

    await presupuestosPage.esperarToastExito('Este presupuesto ya fue procesado por otro usuario');
    expect(bodyEnviado).toMatchObject({ id: PRES_ENVIADO_ID, estado: 'aceptado' });
    await expect(presupuestosPage.panelDetalle).not.toHaveClass(/abierto/);
  });

  test('enviar por WhatsApp abre wa.me con el teléfono normalizado y el número de presupuesto', async ({ page }) => {
    const { presupuestosPage } = await armarPagina(page);

    await presupuestosPage.goto();
    const url = await presupuestosPage.enviarWhatsappYCapturarUrl(PRES_ENVIADO_ID);

    expect(url).toContain('wa.me/543482111111');
    const mensaje = decodeURIComponent(url.split('text=')[1] || '');
    expect(mensaje).toContain('PRE-00001002');
  });
});
