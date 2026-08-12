// Fase 1 (P0), página piloto — primer spec de click real (no offline) de
// la suite. Cubre el flujo de lectura completo: la lista carga desde la
// RPC real (`fn_pedidos_lista`, mockeada — ver hallazgo 10.1 del plan),
// se clickea una fila real del DOM, y se verifica que el modal de
// detalle muestra los datos correctos (viene de `pedido_items`, otra
// tabla mockeada aparte).
//
// Alcance deliberado de este primer spec: solo lectura (listado + abrir
// detalle). El flujo de "crear pedido" queda para la siguiente vuelta —
// depende de `ProductoPicker` (buscador visual) y tiene más superficie
// para mockear bien; no vale la pena resolverlo a ciegas sin poder
// correr el test acá (ver limitación de red en el README).

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { PedidosPage } from '../../page-objects/admin/pedidos.page.js';

const PEDIDO_ID = 'e2e-pedido-000000000001';

const PEDIDO_FILA = {
  // Shape real que devuelve `fn_pedidos_lista`: columnas planas con
  // prefijo `cliente_`/`zona_` (incluido el id — es clave, ver abajo),
  // que `normalizarPedidoRpc()` en pedidos.js convierte al shape
  // anidado `{clientes:{...,zonas:{...}}}` que usa el render y el
  // modal. CONFIRMADO contra el código real (no contra el schema SQL,
  // al que no tengo acceso desde acá): `normalizarPedidoRpc` arma
  // `clientes: r.cliente_id ? {...} : null` — es decir, si falta
  // `cliente_id` en la fila (como pasaba en la versión anterior de
  // este fixture, que solo traía `cliente_nombre`), el resultado es
  // `clientes: null` sin importar los demás campos, y tanto la celda
  // de la lista como el modal terminan mostrando "—" en vez del
  // nombre. Mismo mecanismo para `zona_id`/`zona_nombre`.
  id: PEDIDO_ID,
  estado: 'entregado', // sin transiciones (TRANSICIONES.entregado = []) → template de fila más simple
  subtotal: 15000,
  descuento: 0,
  iva_total: 0,
  total: 15000,
  remito_nro: null,
  notas_cliente: null,
  fecha_pedido: '2026-08-01',
  fecha_entrega: '2026-08-10',
  created_at: '2026-08-01T10:00:00Z',
  canal: 'admin',
  factura_id: null,
  fecha_despacho: null,
  factura_estado: null,
  factura_error_detalle: null,
  vendedor_id: null,
  cliente_id: 'e2e-cliente-1',
  cliente_razon_social: 'Cliente E2E SRL',
  cliente_nombre_fantasia: null,
  cliente_cuit: '30-11111111-1',
  cliente_telefono: null,
  cliente_domicilio: null,
  cliente_localidad: null,
  cliente_condicion_iva: 'RI',
  zona_id: 'e2e-zona-1',
  zona_nombre: 'Zona Norte',
};

const CLIENTE_INFO = {
  id: 'e2e-cliente-1',
  razon_social: 'Cliente E2E SRL',
  nombre_fantasia: null,
  cuit: '30-11111111-1',
  telefono: null,
  domicilio: null,
  localidad: null,
  condicion_iva: 'RI',
  zonas: { id: 'e2e-zona-1', nombre: 'Zona Norte' },
};

const ITEMS = [
  { cantidad: 3, precio_unitario: 5000, descuento_pct: 0, subtotal: 15000, productos: { nombre: 'Producto E2E', unidad: 'u' } },
];

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

test.describe('Pedidos (admin) — Fase 1 piloto', () => {
  test('la lista carga desde fn_pedidos_lista y clickear una fila abre el detalle correcto', async ({ page }) => {
    // Red de seguridad primero (ver 10.1) — cualquier tabla que la página
    // toque y este spec no anticipó devuelve vacío en vez de pegarle a
    // Supabase real; los mocks específicos de abajo, registrados después,
    // tienen prioridad sobre este catch-all.
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await vendorizarSupabase(page);

    await loguearComoAdmin(page);

    mockearRpc(page, 'fn_pedidos_lista', () => [PEDIDO_FILA]);
    mockearRpc(page, 'fn_pedidos_stats_mes', () => ({}));
    mockearTabla(page, 'clientes', { onSelect: () => [CLIENTE_INFO] });
    mockearTabla(page, 'pedido_items', { onSelect: () => ITEMS });
    mockearTabla(page, 'notif_log', { onSelect: () => [] });

    const pedidosPage = new PedidosPage(page, staticServer.baseURL);
    const erroresConsola = pedidosPage.capturarErroresConsola();

    await pedidosPage.goto();

    // La fila real del pedido mockeado está en el DOM (no solo "la
    // tabla tiene contenido" — el id concreto).
    await expect(pedidosPage.fila(PEDIDO_ID)).toBeVisible();
    await expect(pedidosPage.fila(PEDIDO_ID)).toContainText('Cliente E2E SRL');

    // Click real, no page.evaluate() — ejercita el `onclick` inline tal
    // como lo dispara un click de usuario de verdad.
    await pedidosPage.abrirDetallePorId(PEDIDO_ID);

    await expect(pedidosPage.modalTitulo).toContainText(PEDIDO_ID.slice(-6).toUpperCase());
    await expect(pedidosPage.modalClienteInfo).toContainText('Cliente E2E SRL');
    await expect(pedidosPage.modalItems).toContainText('Producto E2E');
    await expect(pedidosPage.modalTotales).toContainText('15.000'); // formatARS — separador de miles es '.', no ','

    // Ruido de red del sandbox (CDNs bloqueados, WebSocket de Realtime
    // contra el proyecto real) — no es un bug de la app, ver
    // filtrarRuidoRed() en mock-network.js.
    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });
});
