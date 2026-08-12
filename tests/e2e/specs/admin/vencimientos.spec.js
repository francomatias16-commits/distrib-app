// Fase 2 (P1), segunda página del bloque "operación de depósito" (ver
// PLAN_E2E_COBERTURA_TOTAL.md, sección 21). `lotes.html` es solo un
// redirect a `/admin/vencimientos` (hallazgo 15, mismo patrón que
// `cta-cte.html`) — este spec navega directo a `vencimientos.html`.
//
// Alcance deliberado (mismo criterio que compras/cta-cte/rutas de las
// vueltas anteriores): cubre la pestaña "Lotes y vencimientos" (listado +
// alta + baja), que es la que abre por defecto. NO cubre la pestaña
// "Liquidación" (`liquidacion.js` — reglas de descuento automático por
// proximidad de vencimiento + gestión de ofertas), que es un sub-sistema
// propio con su tabla de reglas + tabla de ofertas + generación manual;
// queda para una vuelta futura si hace falta profundizar esta página más
// allá de lotes.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { VencimientosPage } from '../../page-objects/admin/vencimientos.page.js';

const DEPOSITO_ID = 'e2e-deposito-000000000001';
const PRODUCTO_ID = 'e2e-producto-000000000001';
const LOTE_VENCIDO_ID   = 'e2e-lote-vencido-0001';
const LOTE_POR_VENCER_ID = 'e2e-lote-porvencer-0001';
const LOTE_ACTIVO_ID    = 'e2e-lote-activo-0001';

const DEPOSITOS = [{ id: DEPOSITO_ID, nombre: 'Depósito Central' }];
const PRODUCTOS = [{ id: PRODUCTO_ID, codigo: 'COD-001', nombre: 'Producto E2E' }];

function fechaEnDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function lotes() {
  return [
    {
      id: LOTE_VENCIDO_ID, numero_lote: 'L-VENC-01', cantidad: 12, costo_unitario: 100,
      producto_id: PRODUCTO_ID, deposito_id: DEPOSITO_ID, estado: 'vencido',
      fecha_vencimiento: fechaEnDias(-3),
      productos: { nombre: 'Producto E2E', codigo: 'COD-001' },
      depositos: { nombre: 'Depósito Central' },
    },
    {
      id: LOTE_POR_VENCER_ID, numero_lote: 'L-PV-01', cantidad: 8, costo_unitario: 100,
      producto_id: PRODUCTO_ID, deposito_id: DEPOSITO_ID, estado: 'activo',
      fecha_vencimiento: fechaEnDias(3),
      productos: { nombre: 'Producto E2E', codigo: 'COD-001' },
      depositos: { nombre: 'Depósito Central' },
    },
    {
      id: LOTE_ACTIVO_ID, numero_lote: 'L-ACT-01', cantidad: 20, costo_unitario: 100,
      producto_id: PRODUCTO_ID, deposito_id: DEPOSITO_ID, estado: 'activo',
      fecha_vencimiento: fechaEnDias(60),
      productos: { nombre: 'Producto E2E', codigo: 'COD-001' },
      depositos: { nombre: 'Depósito Central' },
    },
  ];
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page, { lotesIniciales = lotes() } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);

  mockearTabla(page, 'depositos', { onSelect: () => DEPOSITOS });
  mockearTabla(page, 'productos', { onSelect: () => PRODUCTOS });

  const contadoresApi = mockApi(page, {
    '/api/lotes': ({ request }) => {
      const url = new URL(request.url());
      if (request.method() === 'GET') {
        return { json: { data: lotesIniciales, pages: 1, total: lotesIniciales.length } };
      }
      if (request.method() === 'DELETE') return { json: { ok: true } };
      // POST (alta) y PATCH (edición / dar_de_baja) se pisan en cada test
      // que necesita inspeccionar el body — mismo criterio que compras/rutas.
      return { json: { ok: true } };
    },
  });

  const vencimientosPage = new VencimientosPage(page, staticServer.baseURL);
  return { vencimientosPage, contadoresApi };
}

test.describe('Lotes y vencimientos (admin) — Fase 2 P1', () => {
  test('la lista carga desde /api/lotes y el banner marca vencidos y por vencer', async ({ page }) => {
    const { vencimientosPage } = await armarPagina(page);
    const erroresConsola = vencimientosPage.capturarErroresConsola();

    await vencimientosPage.goto();

    await expect(vencimientosPage.fila(LOTE_VENCIDO_ID)).toBeVisible();
    await expect(vencimientosPage.fila(LOTE_VENCIDO_ID)).toContainText('L-VENC-01');
    await expect(vencimientosPage.fila(LOTE_VENCIDO_ID)).toContainText('Vencido');
    await expect(vencimientosPage.fila(LOTE_POR_VENCER_ID)).toContainText('Activo');
    await expect(vencimientosPage.fila(LOTE_ACTIVO_ID)).toContainText('Activo');

    // Banner: 1 vencido + 1 por vencer en los próximos 7 días (calculado en
    // cliente desde fecha_vencimiento — 'por_vencer' nunca se persiste en
    // la DB, ver comentario FIX F3-03 en lotes.js::mostrarAlertas).
    await expect(vencimientosPage.bannerAlertas).toBeVisible();
    await expect(vencimientosPage.bannerAlertas).toContainText('1 lote vencido');
    await expect(vencimientosPage.bannerAlertas).toContainText('1 lote');
    await expect(vencimientosPage.bannerAlertas).toContainText('por vencer en los próximos 7 días');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('crear un lote con producto y cantidad válidos envía el POST correcto', async ({ page }) => {
    const { vencimientosPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/lotes**', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      bodyCapturado = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ ok: true, id: 'e2e-lote-nuevo-0001' }),
      });
    });

    await vencimientosPage.goto();
    await vencimientosPage.abrirModalNuevo();

    await vencimientosPage.buscarYElegirProducto('COD-001');
    await vencimientosPage.inputNumeroLote.fill('L-2026-099');
    await vencimientosPage.selectDeposito.selectOption(DEPOSITO_ID);
    await vencimientosPage.inputCantidad.fill('15');
    await vencimientosPage.inputCostoUnitario.fill('250');
    await vencimientosPage.inputFechaVencimiento.fill('2026-12-01');

    await vencimientosPage.guardarLote();

    await vencimientosPage.esperarToastExito('Lote creado');
    await expect(vencimientosPage.modalLote).not.toBeVisible();

    expect(bodyCapturado).toMatchObject({
      producto_id: PRODUCTO_ID,
      cantidad: 15,
      numero_lote: 'L-2026-099',
      deposito_id: DEPOSITO_ID,
      costo_unitario: 250,
      fecha_vencimiento: '2026-12-01',
    });
  });

  test('sin producto ni cantidad no dispara ningún request — validación de cliente', async ({ page }) => {
    const { vencimientosPage } = await armarPagina(page);

    let huboPost = false;
    await page.route('**/api/lotes**', async (route) => {
      if (route.request().method() === 'POST') huboPost = true;
      await route.fallback();
    });

    await vencimientosPage.goto();
    await vencimientosPage.abrirModalNuevo();

    // Sin tocar producto/cantidad: guardarLote() corta antes de pedir
    // confirmación ("Producto y cantidad son requeridos.") — el modal
    // se queda abierto.
    await vencimientosPage.btnGuardarLote.click();

    await vencimientosPage.esperarToastExito('Producto y cantidad son requeridos');
    await expect(vencimientosPage.modalLote).toBeVisible();
    await expect(vencimientosPage.dialogoConfirmar).not.toBeVisible();
    expect(huboPost).toBe(false);
  });

  test('dar de baja un lote llama a /api/lotes?accion=dar_de_baja y refresca la fila', async ({ page }) => {
    const { vencimientosPage } = await armarPagina(page);

    let huboPatchBaja = false;
    let bodyBaja = null;
    await page.route('**/api/lotes**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'PATCH' && url.searchParams.get('accion') === 'dar_de_baja') {
        huboPatchBaja = true;
        bodyBaja = request.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ ok: true, stock_anterior: 40, stock_nuevo: 20 }),
        });
        return;
      }
      return route.fallback();
    });

    await vencimientosPage.goto();
    await vencimientosPage.darDeBaja(LOTE_ACTIVO_ID);

    await vencimientosPage.esperarToastExito('Stock actualizado: 40 → 20');

    expect(huboPatchBaja).toBe(true);
    expect(bodyBaja).toMatchObject({ id: LOTE_ACTIVO_ID });
  });

  test('rechazo del servidor al guardar muestra el error y no cierra el modal', async ({ page }) => {
    const { vencimientosPage } = await armarPagina(page);

    await page.route('**/api/lotes**', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 400,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: 'Ya existe un lote con ese número para este producto' }),
      });
    });

    await vencimientosPage.goto();
    await vencimientosPage.abrirModalNuevo();

    await vencimientosPage.buscarYElegirProducto('COD-001');
    await vencimientosPage.inputNumeroLote.fill('L-DUP-01');
    await vencimientosPage.inputCantidad.fill('5');
    await vencimientosPage.guardarLote();

    await vencimientosPage.esperarToastExito('Ya existe un lote con ese número para este producto');
    await expect(vencimientosPage.modalLote).toBeVisible();
    await expect(vencimientosPage.inputNumeroLote).toHaveValue('L-DUP-01');
  });
});
