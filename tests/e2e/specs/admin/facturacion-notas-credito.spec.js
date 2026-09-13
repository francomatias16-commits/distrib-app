// Cierra F3-05 del checklist de pase manual (checklist_pase_manual.md §8)
// por comando en vez de click manual — ver
// docs/auditorias/AUDITORIA_2026/etapas_paginas/06_fase3_sincronizacion.md
// para el hallazgo y fix originales.
//
// Escenario: usuario en facturacion.html, tab "Facturas" (carga inicial),
// cambia a "Notas de crédito", crea una NC vinculada a una factura real y
// la emite contra ARCA. Vuelve al tab "Facturas" SIN recargar la página.
// Antes del fix, la factura seguía apareciendo "Emitida" (con el botón
// "Anular" disponible) hasta F5 manual — ver emitirNC() en
// notas-credito.js, que ahora llama a window.cargarFacturas()/
// cargarContadoresFacturas() tras emitir.
//
// Estrategia de mock: `fn_facturas_lista` devuelve el estado de la
// factura leyendo una variable compartida (`estadoRed.facturaAnulada`)
// que el mock de `/api/notas-credito?accion=emitir` flipea al responder —
// así el spec no depende de que el código real dispare el refresh, lo
// VERIFICA: si `cargarFacturas()` no se llamara tras emitir, la próxima
// aserción seguiría viendo 'emitida' aunque el mock ya haya cambiado.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { mockApi, vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { FacturacionPage } from '../../page-objects/admin/facturacion.page.js';

const FACTURA_ID = 'e2e-factura-000000000001';
const CLIENTE_ID = 'e2e-cliente-nc-1';
const NC_ID = 'e2e-nc-000000000001';

const FACTURA_BASE = {
  id: FACTURA_ID,
  numero: '0001-00001234',
  fecha_emision: '2026-09-01',
  total: 50000,
  cae: '71234567890123',
  clientes: { razon_social: 'Cliente NC E2E SRL', email: null },
  factura_error_detalle: null,
};

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

test.describe('Facturación — tab Facturas ↔ tab Notas de crédito (F3-05)', () => {
  test('emitir una NC vinculada anula la factura y el tab Facturas se refresca sin F5', async ({ page }) => {
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await vendorizarSupabase(page);
    await loguearComoAdmin(page);

    // Estado compartido entre el mock de fn_facturas_lista y el de
    // /api/notas-credito?accion=emitir — simula lo que hace de verdad
    // emitirNotaCreditoARCA() del lado servidor (marcar la factura
    // original como 'anulada' cuando la NC está vinculada).
    const estadoRed = { facturaAnulada: false, ncCreada: false };

    mockearRpc(page, 'fn_facturas_contadores', () => ({}));
    mockearRpc(page, 'fn_facturas_lista', () => [{
      ...FACTURA_BASE,
      estado: estadoRed.facturaAnulada ? 'anulada' : 'emitida',
    }]);
    mockearRpc(page, 'fn_notas_credito_lista', () => {
      if (!estadoRed.ncCreada) return [];
      return [{
        id: NC_ID,
        tipo: 'B',
        numero: estadoRed.facturaAnulada ? '0001-00000099' : null,
        estado: estadoRed.facturaAnulada ? 'emitida' : 'pendiente',
        motivo: 'Devolución de mercadería',
        total: 5000,
        fecha_emision: '2026-09-12',
        cae: estadoRed.facturaAnulada ? '71234567890999' : null,
        pdf_url: null,
        cliente_razon_social: 'Cliente NC E2E SRL',
        cliente_nombre_fantasia: null,
        factura_numero: FACTURA_BASE.numero,
        fuente: 'nc',
        total_count: 1,
      }];
    });
    mockearTabla(page, 'clientes', {
      onSelect: () => [{ id: CLIENTE_ID, razon_social: 'Cliente NC E2E SRL', nombre_fantasia: null, condicion_iva: 'responsable_inscripto', activo: true }],
    });
    // `onClienteNC()` — sb.from('facturas').select('id,numero').eq('cliente_id',...)
    mockearTabla(page, 'facturas', {
      onSelect: () => [{ id: FACTURA_ID, numero: FACTURA_BASE.numero }],
    });

    mockApi(page, {
      '/api/notas-credito': ({ request }) => {
        const url = new URL(request.url());
        if (url.searchParams.get('accion') === 'emitir') {
          estadoRed.facturaAnulada = true;
          return { json: { nc: { cae: '71234567890999' } } };
        }
        // Alta (POST sin `accion`) — la NC nace 'pendiente', sin CAE.
        estadoRed.ncCreada = true;
        return { json: { ok: true, nc: { id: NC_ID } } };
      },
    });

    const facturacionPage = new FacturacionPage(page, staticServer.baseURL);
    const erroresConsola = facturacionPage.capturarErroresConsola();

    await facturacionPage.goto();

    // 1. Tab "Facturas" — estado inicial: Emitida, con "Anular" disponible.
    await expect(facturacionPage.fila(FACTURA_ID)).toBeVisible();
    await facturacionPage.abrirDetallePorId(FACTURA_ID);
    await expect(facturacionPage.btnAnular).toBeVisible();
    await facturacionPage.cerrarModal();

    // 2. Cambiar a "Notas de crédito", dar de alta una NC vinculada a esa factura.
    await facturacionPage.irATabNC();
    await facturacionPage.abrirModalNuevaNC();
    await facturacionPage.completarNuevaNC({
      clienteId: CLIENTE_ID,
      facturaId: FACTURA_ID,
      motivo: 'Devolución de mercadería',
      item: { descripcion: 'Producto E2E devuelto', precio_unitario: 5000 },
    });
    await facturacionPage.guardarNC();
    await facturacionPage.esperarToastExito('creada');

    // 3. Emitir la NC contra ARCA — este es el disparador real del bug.
    await facturacionPage.emitirNC(NC_ID);
    await facturacionPage.esperarToastExito('CAE');

    // 4. Volver al tab "Facturas" SIN recargar la página — debe reflejar
    // 'anulada' porque emitirNC() ya disparó cargarFacturas() solo.
    await facturacionPage.irATabFacturas();
    await expect(facturacionPage.fila(FACTURA_ID)).toContainText('Anulada', { timeout: 5000 });

    // 5. El modal de detalle tampoco debe seguir ofreciendo "Anular".
    await facturacionPage.abrirDetallePorId(FACTURA_ID);
    await expect(facturacionPage.btnAnular).toHaveCount(0);

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });
});
