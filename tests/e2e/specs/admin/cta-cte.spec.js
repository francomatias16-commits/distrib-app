// Fase 1 (P0), sexta página (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 12 —
// orden: pedidos, pos, stock, facturacion, cobranzas, clientes, cta-cte,
// compras, productos).
//
// Cubre la vista "Saldos por cliente" (ex `/admin/cta-cte`, lógica real en
// `cta-cte.js`, montada en `#vista-saldos` de `cobranzas.html`) que
// `cobranzas.spec.js` dejó a propósito para este spec — ver nota en
// `cta-cte.page.js` sobre por qué `cta-cte.html` en sí (el stub de
// redirect) no tiene nada que testear.
//
// Flujo de escritura cubierto: registrar un cobro directo desde la fila
// ("Cobrar" → `abrirModalCobroDirecto`), con sus tres variantes de
// resultado — éxito, validación de cliente (sin medio de pago) y rechazo
// del servidor —, mismo criterio que `stock.spec.js` con `ajustar_stock`.
// Además, un test de solo lectura para el panel lateral de detalle
// (`abrirCliente`), que a diferencia de las páginas anteriores pega un
// `fetch()` A MANO a `/rest/v1/cta_cte` en vez de usar `sb.from()` — ver
// nota de las 4 capas de red en `cta-cte.page.js`.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { CtaCtePage } from '../../page-objects/admin/cta-cte.page.js';

function formatPesoEsperado(n) {
  return '$' + (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CLIENTE_ID = 'e2e-cliente-000000000001';

// Fila que devuelve fn_cta_cte_lista: deuda_vencida > 0 → estadoSaldo()
// cae en "Vencido" (rojo) — se elige a propósito, junto con KPIS_BASE más
// abajo, para poder confirmar en el mismo test que la fila individual y
// los KPIs agregados muestran cifras consistentes entre sí sin que
// dependan una de la otra (son dos RPC separadas, fn_cta_cte_lista y
// fn_cta_cte_kpis, que en esta página no necesariamente coinciden si hay
// más de una página de resultados — acá sí, a propósito, para simplificar
// el fixture).
function filaCliente(overrides = {}) {
  return {
    cliente_id: CLIENTE_ID,
    razon_social: 'Cliente E2E SRL',
    nombre_fantasia: 'Cliente E2E',
    deuda_total: 15000,
    deuda_vencida: 10000,
    deuda_por_vencer: 5000,
    ultimo_pago: '2026-07-15',
    facturas_pendientes: 2,
    total_count: 1,
    ...overrides,
  };
}

const KPIS_BASE = {
  deuda_total: 15000,
  clientes_total: 1,
  deuda_vencida: 10000,
  clientes_vencido: 1,
  deuda_por_vencer: 5000,
  clientes_por_vencer: 0,
  deuda_al_dia: 0,
  clientes_al_dia: 0,
};

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

/** Setup de red compartido por los tests — devuelve los handles para leer contadores/params. */
async function armarPagina(page, { filaInicial = filaCliente(), kpis = KPIS_BASE } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);

  const obtenerLlamadasLista = mockearRpc(page, 'fn_cta_cte_lista', () => [filaInicial]);
  mockearRpc(page, 'fn_cta_cte_kpis', () => [kpis]);
  mockearTabla(page, 'cta_cte', { onSelect: () => [] });

  const ctaCtePage = new CtaCtePage(page, staticServer.baseURL);
  return { ctaCtePage, obtenerLlamadasLista };
}

test.describe('Cta-cte / Saldos por cliente (admin) — Fase 1 P0', () => {
  test('la lista y los KPIs cargan desde fn_cta_cte_lista / fn_cta_cte_kpis', async ({ page }) => {
    const { ctaCtePage } = await armarPagina(page);
    const erroresConsola = ctaCtePage.capturarErroresConsola();

    await ctaCtePage.goto();

    await expect(ctaCtePage.fila(CLIENTE_ID)).toBeVisible();
    await expect(ctaCtePage.fila(CLIENTE_ID)).toContainText('Cliente E2E');
    await expect(ctaCtePage.fila(CLIENTE_ID)).toContainText('Vencido');
    await expect(ctaCtePage.fila(CLIENTE_ID)).toContainText(formatPesoEsperado(15000));

    await expect(ctaCtePage.kpiTotal).toHaveText(formatPesoEsperado(15000));
    await expect(ctaCtePage.kpiVencido).toHaveText(formatPesoEsperado(10000));

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('abrir un cliente muestra el panel con el resumen de saldo correcto', async ({ page }) => {
    const { ctaCtePage } = await armarPagina(page);

    await ctaCtePage.goto();
    await ctaCtePage.abrirClientePorId(CLIENTE_ID);

    await expect(ctaCtePage.panelNombre).toHaveText('Cliente E2E');
    await expect(ctaCtePage.panelBody).toContainText(formatPesoEsperado(10000)); // deuda vencida
    await expect(ctaCtePage.panelBody).toContainText(formatPesoEsperado(5000));  // por vencer
  });

  test('cobrar desde la fila llama a registrar_cobro_completo con el payload correcto', async ({ page }) => {
    const { ctaCtePage } = await armarPagina(page);

    const obtenerParamsCobro = mockearRpc(page, 'registrar_cobro_completo', ({ params }) => {
      // Confirma el payload real armado por guardarCobro() para el cobro
      // genérico (sin factura vinculada, ese caso es de cobranzas.spec.js
      // vía abrirModalCobroParaFactura) — p_factura_id debe viajar null.
      expect(params).toMatchObject({
        p_cliente_id: CLIENTE_ID,
        p_monto: 4500,
        p_medio: 'transferencia',
        p_referencia: 'COMP-001',
        p_notas: 'Pago parcial',
        p_factura_id: null,
      });
      return { ok: true, nro: 'C-0001', factura_saldada: null };
    });

    await ctaCtePage.goto();
    await ctaCtePage.cobrarDesdeFilaPorId(CLIENTE_ID);

    await ctaCtePage.completarCobro({ monto: 4500, medio: 'transferencia', comprobante: 'COMP-001', obs: 'Pago parcial' });
    await ctaCtePage.guardarCobro();

    await expect(ctaCtePage.toast).toBeVisible();
    await expect(ctaCtePage.toast).toContainText('C-0001');
    await expect(ctaCtePage.modalCobro).toHaveClass(/hidden/);

    expect(obtenerParamsCobro(), 'registrar_cobro_completo debería haberse llamado exactamente una vez').toBe(1);
  });

  test('sin medio de pago no dispara ningún request — validación de cliente', async ({ page }) => {
    const { ctaCtePage } = await armarPagina(page);
    const obtenerParamsCobro = mockearRpc(page, 'registrar_cobro_completo', () => ({ ok: true, nro: 'C-0002' }));

    await ctaCtePage.goto();
    await ctaCtePage.cobrarDesdeFilaPorId(CLIENTE_ID);

    // Sin medio seleccionado: guardarCobro() corta en el segundo check
    // ("Seleccioná el medio de pago") antes de pedir confirmación — el
    // modal se queda abierto (no hay cierre en este camino).
    await ctaCtePage.completarCobro({ monto: 1000 });
    await ctaCtePage.btnGuardarCobro.click();

    await expect(ctaCtePage.toast).toContainText('Seleccioná el medio de pago');
    await expect(ctaCtePage.modalCobro).not.toHaveClass(/hidden/);
    expect(obtenerParamsCobro()).toBe(0);
  });

  test('rechazo del servidor (ok:false) muestra el error y no pierde los datos del formulario', async ({ page }) => {
    const { ctaCtePage } = await armarPagina(page);
    mockearRpc(page, 'registrar_cobro_completo', () => ({ ok: false, error: 'Cliente con crédito bloqueado' }));

    await ctaCtePage.goto();
    await ctaCtePage.cobrarDesdeFilaPorId(CLIENTE_ID);

    await ctaCtePage.completarCobro({ monto: 2000, medio: 'efectivo' });
    await ctaCtePage.guardarCobro();

    await expect(ctaCtePage.toast).toContainText('Cliente con crédito bloqueado');
    // A diferencia del camino feliz, acá el modal NO se cierra (el throw
    // dentro del try pasa por alto el cerrarModalCobro() de más abajo) —
    // el monto tipeado sigue en el input.
    await expect(ctaCtePage.modalCobro).not.toHaveClass(/hidden/);
    await expect(ctaCtePage.inputMonto).toHaveValue('2000');
  });
});
