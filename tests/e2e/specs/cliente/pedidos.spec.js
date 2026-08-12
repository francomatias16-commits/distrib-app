// Historial de pedidos del portal cliente. Listado + filtro server-side
// por estado, detalle expandible (CSS puro), "Pagar online" (pedidos
// confirmado/preparando) y "Ver seguimiento en vivo" (solo despachado).
// Ver page object sobre el stub de Leaflet que usan los tests de
// seguimiento — TODAVÍA NO vendorizado como Dexie/supabase-js/PapaParse,
// candidato a resolver igual que esas 3 en una próxima vuelta si el
// seguimiento en vivo necesita más profundidad que "abre/cierra el
// overlay y pinta el ETA".

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { mockearTabla, mockearRestGenerico } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionCliente } from '../../helpers/auth-helper.js';
import { ClientePedidosPage } from '../../page-objects/cliente/pedidos.page.js';

const CLIENTE_ID = 'e2e-cliente-001';

const PEDIDO_CONFIRMADO = {
  id: 'p-1', numero_pedido: 'PED-0001', estado: 'confirmado', total: 5000,
  fecha_pedido: '2026-08-01', notas_cliente: null,
  pedido_items: [{ id: 'pi-1', cantidad: 2, precio_unitario: 2500, productos: { nombre: 'Coca Cola 2.25L' } }],
};
const PEDIDO_DESPACHADO = {
  id: 'p-2', numero_pedido: 'PED-0002', estado: 'despachado', total: 8000,
  fecha_pedido: '2026-08-02', notas_cliente: 'Dejar en portería',
  pedido_items: [],
};

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

/** Stub mínimo de Leaflet — ver nota en pedidos.page.js. NO es la librería real. */
async function stubLeaflet(page) {
  await page.addInitScript(() => {
    window.L = {
      map: () => ({
        setView: () => {},
        invalidateSize: () => {},
      }),
      tileLayer: () => ({ addTo: () => {} }),
      marker: () => ({ addTo: () => ({ setLatLng: () => {} }), setLatLng: () => {} }),
    };
  });
}

async function prepararRed(page, { pedidos = [PEDIDO_CONFIRMADO, PEDIDO_DESPACHADO], onPagar, onSeguimiento } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearTabla(page, 'usuarios', { onSelect: () => ({ cliente_id: CLIENTE_ID }) });
  mockearTabla(page, 'pedidos', { onSelect: () => pedidos });
  mockApi(page, {
    '/api/pagos': () => (onPagar ? onPagar() : { json: { checkout_url: 'https://mp.example/pay/xyz' } }),
    '/api/rutas-live': () => (onSeguimiento ? onSeguimiento() : { json: { disponible: false, mensaje: 'El pedido todavía no salió a la calle.' } }),
  });

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola) };
}

test.describe('cliente/pedidos.html', () => {

  test('sin pedidos: muestra el estado vacío', async ({ page }) => {
    await sembrarSesionCliente(page);
    const { erroresConsola } = await prepararRed(page, { pedidos: [] });
    const pedidosPage = new ClientePedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();

    await expect(pedidosPage.listaPedidos).toContainText('No hay pedidos todavía');
    expect(erroresConsola()).toEqual([]);
  });

  test('lista pedidos con estado y total', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const pedidosPage = new ClientePedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();

    await expect(pedidosPage.cardPorNumero('PED-0001')).toContainText('Confirmado');
    await expect(pedidosPage.cardPorNumero('PED-0002')).toContainText('Despachado');
  });

  test('filtrar por estado: repite la carga con el filtro aplicado', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { pedidos: [PEDIDO_CONFIRMADO] });
    const pedidosPage = new ClientePedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();
    await pedidosPage.filtrarPor('confirmado');

    await expect(pedidosPage.chipFiltro('confirmado')).toHaveClass(/activo/);
    await expect(pedidosPage.cardPorNumero('PED-0001')).toBeVisible();
  });

  test('toggle detalle: expande y muestra los ítems del pedido', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const pedidosPage = new ClientePedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();
    await pedidosPage.toggleDetalle('PED-0001');

    await expect(pedidosPage.cardPorNumero('PED-0001')).toContainText('Coca Cola 2.25L');
  });

  test('pagar online (pedido confirmado): pide el link y navega al checkout_url', async ({ page }) => {
    await sembrarSesionCliente(page);
    let bodyPago = null;
    await prepararRed(page, {
      onPagar: () => ({ json: { checkout_url: 'https://mp.example/pay/xyz' } }),
    });
    page.on('request', (req) => {
      if (req.url().includes('/api/pagos') && req.method() === 'POST') bodyPago = JSON.parse(req.postData() || '{}');
    });
    const pedidosPage = new ClientePedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();
    await pedidosPage.toggleDetalle('PED-0001');
    await pedidosPage.botonPagarOnline('PED-0001').click();

    await expect.poll(() => bodyPago).toMatchObject({ pedido_id: PEDIDO_CONFIRMADO.id });
  });

  test('pagar online con error: muestra el toast de error y reactiva el botón', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { onPagar: () => ({ status: 400, json: { error: 'El pedido ya fue pagado.' } }) });
    const pedidosPage = new ClientePedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();
    await pedidosPage.toggleDetalle('PED-0001');
    const boton = pedidosPage.botonPagarOnline('PED-0001');
    await boton.click();

    await expect(page.locator('body')).toContainText('El pedido ya fue pagado.');
    await expect(boton).toBeEnabled();
  });

  test('ver seguimiento en vivo (pedido despachado): abre el overlay y muestra el ETA', async ({ page }) => {
    await sembrarSesionCliente(page);
    await stubLeaflet(page);
    await prepararRed(page, {
      onSeguimiento: () => ({ json: { disponible: true, ubicacion: { lat: -34.6, lng: -58.4 }, eta_minutos: 12, paradas_restantes: 2 } }),
    });
    const pedidosPage = new ClientePedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();
    await pedidosPage.toggleDetalle('PED-0002');
    await pedidosPage.abrirSeguimiento('PED-0002');

    await expect(pedidosPage.etaTexto).toContainText('12 min');
  });

  test('cerrar seguimiento: oculta el overlay', async ({ page }) => {
    await sembrarSesionCliente(page);
    await stubLeaflet(page);
    await prepararRed(page);
    const pedidosPage = new ClientePedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();
    await pedidosPage.toggleDetalle('PED-0002');
    await pedidosPage.abrirSeguimiento('PED-0002');
    await pedidosPage.cerrarSeguimiento();
  });
});
