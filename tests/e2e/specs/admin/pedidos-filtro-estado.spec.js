// Cierra F4-01 del checklist de pase manual (checklist_pase_manual.md §1)
// por comando: el chip de filtro debía decir "Borrador" (no "Pendiente",
// estado que no existe en la base — ver AUDITORIA_2026) y filtrar de
// verdad contra `fn_pedidos_lista` con `p_estado: 'borrador'`.
//
// Dos casos: hay resultados (la fila borrador aparece) y no los hay (la
// tabla queda con el mensaje de "sin resultados", no colgada/rota) — el
// segundo es el que el pase manual original marcaba como "no debe
// romperse ni quedar cargando infinito", algo que un solo click no
// alcanza a confirmar sin mirar la red real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { PedidosPage } from '../../page-objects/admin/pedidos.page.js';

const PEDIDO_BORRADOR_ID = 'e2e-pedido-borrador-001';

const pedidoFila = (estado) => ({
  id: PEDIDO_BORRADOR_ID,
  estado,
  subtotal: 8000, descuento: 0, iva_total: 0, total: 8000,
  remito_nro: null, notas_cliente: null,
  fecha_pedido: '2026-09-01', fecha_entrega: '2026-09-05',
  created_at: '2026-09-01T09:00:00Z', canal: 'admin',
  factura_id: null, fecha_despacho: null, factura_estado: null, factura_error_detalle: null,
  vendedor_id: null,
  cliente_id: 'e2e-cliente-2', cliente_razon_social: 'Cliente Borrador SRL',
  cliente_nombre_fantasia: null, cliente_cuit: '30-22222222-2', cliente_telefono: null,
  cliente_domicilio: null, cliente_localidad: null, cliente_condicion_iva: 'RI',
  zona_id: null, zona_nombre: null,
});

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

test.describe('Pedidos (admin) — filtro de estado (F4-01)', () => {
  test('el chip dice "Borrador" y filtra p_estado=borrador con resultados', async ({ page }) => {
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await vendorizarSupabase(page);
    await loguearComoAdmin(page);

    mockearRpc(page, 'fn_pedidos_lista', ({ params }) => {
      // Sin filtro (carga inicial): todos. Con p_estado='borrador': solo
      // el pedido borrador. Cualquier otro valor: vacío — así el test
      // falla fuerte si el chip mandara el estado viejo 'pendiente'.
      if (!params?.p_estado) return [pedidoFila('entregado'), pedidoFila('borrador')];
      if (params.p_estado === 'borrador') return [pedidoFila('borrador')];
      return [];
    });
    mockearRpc(page, 'fn_pedidos_stats_mes', () => ({}));
    mockearTabla(page, 'notif_log', { onSelect: () => [] });

    const pedidosPage = new PedidosPage(page, staticServer.baseURL);
    const erroresConsola = pedidosPage.capturarErroresConsola();

    await pedidosPage.goto();

    // El chip existe y su label es "Borrador" — no "Pendiente".
    await expect(pedidosPage.chipEstado('borrador')).toBeVisible();
    await expect(pedidosPage.chipEstado('borrador')).toContainText('Borrador');
    await expect(pedidosPage.chipEstado('pendiente')).toHaveCount(0);

    await pedidosPage.filtrarPorEstado('borrador');

    await expect(pedidosPage.fila(PEDIDO_BORRADOR_ID)).toBeVisible();
    await expect(pedidosPage.filas).toHaveCount(1);

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('filtrar por un estado sin pedidos deja la tabla vacía, no colgada', async ({ page }) => {
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await vendorizarSupabase(page);
    await loguearComoAdmin(page);

    mockearRpc(page, 'fn_pedidos_lista', ({ params }) => {
      if (!params?.p_estado) return [pedidoFila('entregado')];
      return []; // ningún pedido cancelado en este fixture
    });
    mockearRpc(page, 'fn_pedidos_stats_mes', () => ({}));
    mockearTabla(page, 'notif_log', { onSelect: () => [] });

    const pedidosPage = new PedidosPage(page, staticServer.baseURL);
    await pedidosPage.goto();

    await pedidosPage.filtrarPorEstado('cancelado');

    await expect(pedidosPage.filas).toHaveCount(0);
    await expect(pedidosPage.mensajeVacio).toBeVisible({ timeout: 5000 });
  });
});
