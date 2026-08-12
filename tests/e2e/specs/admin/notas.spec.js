// Fase 2 (P1), tercera página del bloque "usuarios / proveedores / notas /
// presupuestos" (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 26).
// `notas.html` es standalone: JS propio (`notas.js`, 287 líneas). A
// diferencia de usuarios/proveedores (que pegan a `/api/*`), acá el
// listado y el alta son dos RPC de Postgres distintas
// (`fn_notas_lista`/`emitir_nota_cta_cte`) — se mockean con `mockearRpc()`,
// no `mockApi()`. `cargarClientes()` sí es PostgREST directo
// (`fetch` a `/rest/v1/clientes`, no supabase-js `.from()`, pero
// `mockearTabla` lo cubre igual porque intercepta a nivel de red).
//
// Alcance deliberado: listado server-side (búsqueda + filtro de tipo),
// abrir el detalle de una fila, alta de nota de crédito CON confirmación
// (labels custom "Emitir"/"Revisar"), alta cancelada en el diálogo de
// confirmación (no debe disparar la RPC), y el error de negocio que
// devuelve la RPC con `ok:false` (ej. algo que la función SQL rechaza).
// NO cubre: paginación más allá de 200 registros ni nota de débito
// específicamente (mismo código que crédito, solo cambia `tipoSeleccionado`
// y el color del chip) — se comparte cobertura con el caso de crédito.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { NotasPage } from '../../page-objects/admin/notas.page.js';

const NOTA_ID = 'e2e-nota-000000000001';
const CLIENTE_ID = 'e2e-cliente-000000001';

// Shape real que devuelve `fn_notas_lista` (columnas planas con prefijo
// `cliente_`, que notas.js::cargarNotas() envuelve en `{clientes:{...}}`
// — ver el `.map()` en cargarNotas()) más `total_count` repetido en cada fila.
function notaFila(overrides = {}) {
  return {
    id: NOTA_ID,
    fecha: '2026-08-01',
    nro_comprobante: 'NC-00001234',
    tipo: 'nota_credito',
    importe: 5000,
    descripcion: 'Devolución de mercadería',
    cliente_razon_social: 'Cliente E2E SRL',
    cliente_nombre_fantasia: null,
    total_count: 1,
    ...overrides,
  };
}

const CLIENTE_FIXTURE = { id: CLIENTE_ID, razon_social: 'Cliente E2E SRL', nombre_fantasia: null };

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page, { rpcLista } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);
  mockearTabla(page, 'clientes', { onSelect: () => [CLIENTE_FIXTURE] });
  mockearRpc(page, 'fn_notas_lista', rpcLista || (() => [notaFila()]));

  const notasPage = new NotasPage(page, staticServer.baseURL);
  return { notasPage };
}

test.describe('Notas de crédito/débito (admin) — Fase 2 P1', () => {
  test('la lista carga desde fn_notas_lista y muestra los datos de la fila', async ({ page }) => {
    const { notasPage } = await armarPagina(page);
    const erroresConsola = notasPage.capturarErroresConsola();

    await notasPage.goto();

    await expect(notasPage.fila(NOTA_ID)).toBeVisible();
    await expect(notasPage.fila(NOTA_ID)).toContainText('NC-00001234');
    await expect(notasPage.fila(NOTA_ID)).toContainText('Cliente E2E SRL');
    await expect(notasPage.fila(NOTA_ID)).toContainText('Nota de Crédito');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('buscar y cambiar el filtro de tipo disparan la RPC con los parámetros correctos (server-side)', async ({ page }) => {
    let ultimosParams = null;
    const { notasPage } = await armarPagina(page, {
      rpcLista: ({ params }) => { ultimosParams = params; return [notaFila()]; },
    });

    await notasPage.goto();
    await notasPage.buscar('cliente e2e');

    expect(ultimosParams).toMatchObject({ p_busqueda: 'cliente e2e', p_tipo: null });

    await notasPage.filtrarPorTipo('debito');
    expect(ultimosParams).toMatchObject({ p_tipo: 'nota_debito' });
  });

  test('abrir el detalle de una fila muestra los datos correctos (sin fetch aparte)', async ({ page }) => {
    const { notasPage } = await armarPagina(page);

    await notasPage.goto();
    await notasPage.abrirDetalle(NOTA_ID);

    await expect(notasPage.detalleNumero).toHaveText('NC-00001234');
    await expect(notasPage.detalleTipo).toContainText('Nota de Crédito');
    await expect(notasPage.detalleCliente).toContainText('Cliente E2E SRL');
    await expect(notasPage.detalleMotivo).toContainText('Devolución de mercadería');
  });

  test('emitir una nota de crédito pide confirmación (labels "Emitir"/"Revisar") y llama a la RPC correcta', async ({ page }) => {
    const { notasPage } = await armarPagina(page);

    let paramsEnviados = null;
    mockearRpc(page, 'emitir_nota_cta_cte', ({ params }) => {
      paramsEnviados = params;
      return { ok: true, nro: 'NC-00005678' };
    });

    await notasPage.goto();
    await notasPage.abrirModalNueva();
    await notasPage.completarFormulario({
      tipo: 'credito', clienteId: CLIENTE_ID, monto: 3500, motivo: 'Bonificación por flete',
    });

    await expect(notasPage.dialogoConfirmar).toHaveCount(0);
    await notasPage.guardarConfirmando();

    await notasPage.esperarToastExito('NC-00005678');
    expect(paramsEnviados).toMatchObject({
      p_cliente_id: CLIENTE_ID, p_tipo: 'nota_credito', p_importe: 3500, p_descripcion: 'Bonificación por flete',
    });
    await expect(notasPage.modal).toBeHidden();
  });

  test('cancelar el diálogo de confirmación NO dispara la RPC de emisión', async ({ page }) => {
    const { notasPage } = await armarPagina(page);

    let llamadas = 0;
    mockearRpc(page, 'emitir_nota_cta_cte', () => { llamadas += 1; return { ok: true, nro: 'NC-X' }; });

    await notasPage.goto();
    await notasPage.abrirModalNueva();
    await notasPage.completarFormulario({ tipo: 'debito', clienteId: CLIENTE_ID, monto: 1000 });
    await notasPage.guardarYCancelar();

    expect(llamadas).toBe(0);
    await expect(notasPage.modal).toBeVisible(); // sigue abierto, no se cerró
  });

  test('si la RPC devuelve ok:false (rechazo de negocio), muestra el error y no cierra el modal', async ({ page }) => {
    const { notasPage } = await armarPagina(page);

    mockearRpc(page, 'emitir_nota_cta_cte', () => ({ ok: false, error: 'El cliente no tiene cuenta corriente habilitada' }));

    await notasPage.goto();
    await notasPage.abrirModalNueva();
    await notasPage.completarFormulario({ tipo: 'credito', clienteId: CLIENTE_ID, monto: 2000 });
    await notasPage.guardarConfirmando();

    await notasPage.esperarToastExito('No se pudo emitir la nota');
    await expect(notasPage.modal).toBeVisible();
  });
});
