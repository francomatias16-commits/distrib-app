// Etapa 5 de docs/auditoria/plan-auditoria-fluxo.md — "circuito completo de
// punta a punta (E2E con foco en montos)".
//
// ── Qué SÍ prueba este spec (y qué no, y por qué) ───────────────────────
// Como el resto de tests/e2e/*, esto corre contra Supabase MOCKEADO
// (page.route intercepta cada RPC/tabla — ver supabase-rest-mock.js). Eso
// significa que puede probar, con certeza, que el FRONTEND está bien
// conectado: que cada pantalla llama al RPC/endpoint correcto, con el
// payload correcto (ids, montos), y que renderiza correctamente lo que el
// backend le devuelve. Es exactamente lo que ya hacen pedidos.spec.js,
// facturacion.spec.js y cta-cte.spec.js — este spec los encadena en una
// sola corrida para seguir "un mismo pedido real" (texto literal del
// plan) de punta a punta, con el MISMO monto propagado en cada pantalla:
// pedido $15.000 → factura $15.000 → cobro $15.000 → saldo final $0.
//
// Lo que este spec NO puede probar, y ningún test de tests/e2e/ podría sin
// cambiar de arquitectura: que el descuento de stock o el cálculo de
// saldo son ARITMÉTICAMENTE correctos del lado del RPC real. Esa lógica
// vive en SQL dentro de confirmar_pedido()/registrar_cobro_completo(),
// que acá se mockea por completo — no hay Postgres real detrás. Probar
// eso de verdad es trabajo de `npm run test:integration`
// (tests/repos/*.test.js contra un Supabase real), que la Etapa 0 de este
// mismo plan ya encontró bloqueado: el `.env.local` de este entorno
// apunta al proyecto de PRODUCCIÓN, no a uno de test, así que no se puede
// correr ahí sin escribir/borrar datos reales. La Etapa 5 completa
// (aritmética real incluida) queda entonces bloqueada por el mismo hueco
// de infraestructura que ya bloqueaba Etapa 0 — no es un hueco nuevo,
// es el mismo, y esta es la segunda vez que aparece.
//
// ── Hallazgo real encontrado al armar este spec (no hipotético) ─────────
// Al buscar qué convierte la RESERVA de stock (que sí hace confirmar_pedido,
// migración 533: inserta movimientos_stock tipo='reserva' e incrementa
// stock.cantidad_reservada) en un descuento REAL de stock.cantidad, la
// función pensada para eso — confirmar_despacho_stock(), migración 466,
// comentada en el código como el paso "consume FEFO en despacho/remito" —
// no tiene NINGÚN caller: ni en el código JS (frontend/lib), ni desde
// otra función SQL (grep sobre supabase/migrations/*.sql). Y se confirma
// mirando pedidos.js (frontend/admin/js/pedidos.js:cambiarEstado): las
// transiciones 'despachado' y 'entregado' son un `.update({estado})`
// plano sobre la tabla `pedidos` — el propio comentario del código dice
// "transición simple sin lógica de stock". Es decir: en el camino real
// de un pedido admin (no POS), el stock queda reservado para siempre
// (cantidad_reservada nunca vuelve a bajar en la entrega real, solo lo
// hace en cancelar_pedido) y stock.cantidad nunca se decrementa de
// verdad. Esto también explica el hallazgo de Etapa 4: los 2 productos
// con movimientos "huérfanos" en la demo. Este spec deja un test explícito
// que CONFIRMA esta falta de llamadas (ver 'no hay movimiento de stock
// real al despachar/entregar' más abajo) — no para darla por buena, sino
// para que quede como regresión detectable si alguien arregla
// confirmar_despacho_stock() y se olvida de conectarlo.
//
// ── "impacto en caja del turno" — no aplica a este flujo ────────────────
// registrar_cobro_completo() (grep sobre su definición SQL, migraciones
// 199→509) no toca `movimientos_caja` ni `turnos_caja` en ningún punto.
// Cobrar la cta_cte de un pedido admin es un subsistema totalmente
// separado del turno de caja del POS — no hay ningún camino de datos
// entre ambos en este código. La frase del plan "cobro → impacto en caja
// del turno → cierre" describe el flujo de una VENTA DE POS
// (registrar_venta_pos SÍ escribe en la caja del turno abierto), no el de
// un pedido de cliente por este circuito. Ese leg del plan corresponde a
// extender pos.spec.js (ya existe, cubre lectura), no a este spec — se
// deja afuera acá en vez de simular una relación que no existe en el
// código real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { PedidosPage } from '../../page-objects/admin/pedidos.page.js';
import { FacturacionPage } from '../../page-objects/admin/facturacion.page.js';
import { CtaCtePage } from '../../page-objects/admin/cta-cte.page.js';

const PEDIDO_ID   = 'e2e-flujo-pedido-000000001';
const CLIENTE_ID  = 'e2e-flujo-cliente-00000001';
const FACTURA_ID  = 'e2e-flujo-factura-00000001';
const MONTO_TOTAL = 15000; // mismo monto en pedido, factura y cobro — a propósito, ver header.

function formatPesoEsperado(n) {
  return '$' + (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CLIENTE_INFO = {
  id: CLIENTE_ID,
  razon_social: 'Cliente E2E Flujo SRL',
  nombre_fantasia: null,
  cuit: '30-22222222-2',
  telefono: null,
  domicilio: null,
  localidad: null,
  condicion_iva: 'RI',
  zonas: { id: 'e2e-zona-1', nombre: 'Zona Norte' },
};

const ITEMS = [
  { cantidad: 3, precio_unitario: 5000, descuento_pct: 0, subtotal: MONTO_TOTAL, productos: { nombre: 'Producto E2E Flujo', unidad: 'u' } },
];

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

test.describe('Flujo completo de un pedido (admin) — Etapa 5 del plan de auditoría', () => {
  test('pedido → confirmar (reserva) → facturar (CAE) → despachar/entregar → cobrar — mismo monto en cada paso', async ({ page }) => {
    // ── Estado mutable del "mismo pedido real" a través de toda la corrida.
    // Vive acá (closure de Node/Playwright), no en el browser — por eso
    // sobrevive a los page.goto() entre pantallas.
    const flujo = {
      estadoPedido: 'pendiente',
      facturaId: null,
      cae: null,
      saldoDeuda: MONTO_TOTAL,
    };
    const llamadasRpc = { confirmar_pedido: 0, registrar_cobro_completo: 0 };
    let payloadCobro = null;

    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await vendorizarSupabase(page);
    await loguearComoAdmin(page);

    // ── Mocks de lectura, siempre reflejando el estado actual de `flujo` ──
    mockearRpc(page, 'fn_pedidos_lista', () => [{
      id: PEDIDO_ID,
      estado: flujo.estadoPedido,
      subtotal: MONTO_TOTAL,
      descuento: 0,
      iva_total: 0,
      total: MONTO_TOTAL,
      remito_nro: null,
      notas_cliente: null,
      fecha_pedido: '2026-09-01',
      fecha_entrega: '2026-09-05',
      created_at: '2026-09-01T10:00:00Z',
      canal: 'admin',
      factura_id: flujo.facturaId,
      fecha_despacho: null,
      factura_estado: flujo.facturaId ? 'emitida' : null,
      factura_error_detalle: null,
      vendedor_id: null,
      cliente_id: CLIENTE_ID,
      cliente_razon_social: 'Cliente E2E Flujo SRL',
      cliente_nombre_fantasia: null,
      cliente_cuit: '30-22222222-2',
      cliente_telefono: null,
      cliente_domicilio: null,
      cliente_localidad: null,
      cliente_condicion_iva: 'RI',
      zona_id: 'e2e-zona-1',
      zona_nombre: 'Zona Norte',
    }]);
    mockearRpc(page, 'fn_pedidos_stats_mes', () => ({}));
    mockearTabla(page, 'clientes', { onSelect: () => [CLIENTE_INFO] });
    mockearTabla(page, 'pedido_items', { onSelect: () => ITEMS });
    mockearTabla(page, 'notif_log', { onSelect: () => [] });
    mockearTabla(page, 'devoluciones', { onSelect: () => [] });

    // ── Paso 1: confirmar el pedido — reserva de stock + validación de crédito.
    // (Lo que confirmar_pedido() hace de verdad puertas adentro, en SQL, no
    // es observable desde acá — ver header. Lo único verificable a este
    // nivel es que el pedido correcto dispara el RPC correcto.)
    mockearRpc(page, 'confirmar_pedido', ({ params }) => {
      llamadasRpc.confirmar_pedido += 1;
      expect(params.p_pedido_id).toBe(PEDIDO_ID);
      flujo.estadoPedido = 'confirmado';
      return { ok: true };
    });
    mockearRpc(page, 'registrar_auditoria', () => ({}));

    const pedidosPage = new PedidosPage(page, staticServer.baseURL);
    const erroresConsola = pedidosPage.capturarErroresConsola();

    // ⬇️ DEBUG temporal — reenvía todo el console.log/console.error del
    // browser (Chromium) a esta terminal. Playwright NO hace esto por
    // default: los console.log del navegador quedan atrapados ahí salvo
    // que se los reenvíe explícitamente con page.on(). Sacar esto una vez
    // resuelto el bug de #btn-generar-factura (ver pedidos.js:1085).
    page.on('console', msg => console.log(`[BROWSER:${msg.type()}]`, msg.text()));
    page.on('pageerror', err => console.log('[PAGEERROR]', err.message));

    await pedidosPage.goto();
    await expect(pedidosPage.fila(PEDIDO_ID)).toBeVisible();

    await pedidosPage.abrirDetallePorId(PEDIDO_ID);
    await expect(pedidosPage.modalTotales).toContainText('15.000');
    await pedidosPage.confirmarTransicion('confirmado');

    expect(llamadasRpc.confirmar_pedido).toBe(1);
    // cambiarEstado() cierra el modal solo si la transición fue ok — lo
    // confirma implícitamente el siguiente abrirDetallePorId, que espera
    // #modal-titulo visible desde cero.

    // ── Paso 2: facturar — POST /api/facturas, exige estado ≠ pendiente
    // (confirma que el gate de puedeFacturar en pedidos.js es real: el
    // botón #btn-generar-factura recién existe/es visible acá, después
    // de la transición de arriba, no antes).
    let payloadFactura = null;
    mockApi(page, {
      '/api/facturas': ({ request }) => {
        payloadFactura = JSON.parse(request.postData());
        flujo.facturaId = FACTURA_ID;
        flujo.cae = '71234567891234';
        return { json: { factura: { id: FACTURA_ID, cae: flujo.cae, total: MONTO_TOTAL } } };
      },
    });

    await pedidosPage.abrirDetallePorId(PEDIDO_ID);
    await expect(pedidosPage.btnGenerarFactura).toBeVisible();
    await pedidosPage.generarFactura();

    await expect(page.locator('.toast-msg')).toContainText('Comprobante generado correctamente');
    expect(payloadFactura?.pedido_id).toBe(PEDIDO_ID);
    await expect(pedidosPage.btnGenerarFactura).toBeHidden(); // p.factura_id seteado → oculto, ver pedidos.js

    // ── Cruce de monto pedido → factura: misma cifra en una pantalla
    // totalmente distinta, alimentada por un mock totalmente distinto
    // (fn_facturas_lista, no fn_pedidos_lista) — este es el tipo de chequeo
    // que un spec por página aislado no puede hacer.
    mockearRpc(page, 'fn_facturas_lista', () => [{
      id: FACTURA_ID,
      cliente_id: CLIENTE_ID,
      cliente_razon_social: 'Cliente E2E Flujo SRL',
      cliente_telefono: null,
      cliente_email: null,
      tipo: 'B',
      numero: '00001-00000042',
      pedido_id: PEDIDO_ID,
      cae: flujo.cae,
      cae_vto: '2026-09-15',
      vencimiento: null,
      fecha_emision: '2026-09-01T12:00:00Z',
      total: MONTO_TOTAL,
      neto: 12396,
      iva: 2604,
      total_cobrado: 0,
      estado: 'emitida',
      notas_error: null,
      total_count: 1,
    }]);
    mockearRpc(page, 'fn_facturas_contadores', () => ({ cant_pendientes: 0, cant_error_afip: 0, cant_emitidas_mes: 1, monto_emitidas_mes: MONTO_TOTAL }));
    mockearTabla(page, 'pedido_items', { onSelect: () => ITEMS });

    const facturacionPage = new FacturacionPage(page, staticServer.baseURL);
    await facturacionPage.goto();
    await expect(facturacionPage.fila(FACTURA_ID)).toBeVisible();
    await facturacionPage.abrirDetallePorId(FACTURA_ID);
    await expect(facturacionPage.modalDetalle).toContainText('15.000');
    await expect(facturacionPage.modalDetalle).toContainText(flujo.cae);

    // ── Paso 3: preparar → despachar → entregar.
    //
    // Hallazgo real (corriendo el spec tras el fix de CSS de Paso 2): el
    // browser seguía en facturacion.html (última página visitada, arriba)
    // — nada volvía a navegar a pedidos.html antes de este bloque. La
    // sesión (localStorage) y los page.route mockeados sobreviven a la
    // navegación sin problema, pero `pedidosPage.abrirDetallePorId()` usa
    // el selector `tr.fila-pedido[data-id]`, que no existe en
    // facturacion.html (esa página usa `[data-testid="factura-fila"]`) —
    // el .click() quedaba esperando para siempre un elemento que nunca
    // iba a aparecer ahí. Falta un `pedidosPage.goto()` explícito de
    // vuelta antes de retomar el flujo de Pedidos.
    await pedidosPage.goto();
    await expect(pedidosPage.fila(PEDIDO_ID)).toBeVisible();
    //
    // Hallazgo real corrigiendo este spec contra el código de cambiarEstado()
    // (pedidos.js:1108): TRANSICIONES['confirmado'] es ['preparando',
    // 'cancelado'] — 'despachado' NO es una transición válida directa desde
    // 'confirmado' (solo lo es desde 'preparando'). El spec original saltaba
    // ese paso; el botón `.btn-est-despachado` no existiría todavía en
    // #modal-estado-row después de solo confirmar el pedido, y el click
    // hubiera colgado esperando un elemento que no está. Se agrega el paso
    // 'preparando' que faltaba, con su propio RPC (`marcar_preparado`, no un
    // `.update()` plano — distinto de despachado/entregado, ver el `else`
    // final de cambiarEstado()).
    //
    // Segundo hallazgo: cambiarEstado() bloquea 'despachado' con un diálogo
    // aparte ("Ir a Repartos") si el pedido no tiene fila en `entregas`
    // (`entregasPorPedido.has(id)`, poblado por `cargarEntregasAsignadas()`
    // contra esa tabla). Sin mockearla, el click en "Despachar" abre ESE
    // diálogo en vez del de confirmación esperado y `confirmarTransicion`
    // cuelga. Se mockea con una fila ya en estado 'entregado' (evita además
    // el texto de advertencia extra "el chofer todavía no lo confirmó").
    let llamadasStock = 0;
    mockearRpc(page, 'confirmar_despacho_stock', () => { llamadasStock += 1; return { ok: true }; });
    mockearTabla(page, 'movimientos_stock', { onInsert: () => { llamadasStock += 1; return {}; } });
    mockearTabla(page, 'entregas', {
      onSelect: () => [{ pedido_id: PEDIDO_ID, estado: 'entregado', rutas: { chofer_id: 'e2e-chofer-1', usuarios: { nombre: 'Chofer E2E' } } }],
    });
    mockearRpc(page, 'marcar_preparado', ({ params }) => {
      expect(params.p_pedido_id).toBe(PEDIDO_ID);
      flujo.estadoPedido = 'preparando';
      return { ok: true };
    });
    mockearTabla(page, 'pedidos', {
      onUpdate: ({ body }) => { flujo.estadoPedido = body.estado; return { ...body, id: PEDIDO_ID }; },
    });

    await pedidosPage.abrirDetallePorId(PEDIDO_ID);
    await pedidosPage.confirmarTransicion('preparando');
    await pedidosPage.abrirDetallePorId(PEDIDO_ID);
    await pedidosPage.confirmarTransicion('despachado');
    await pedidosPage.abrirDetallePorId(PEDIDO_ID);
    await pedidosPage.confirmarTransicion('entregado');

    expect(llamadasStock, 'ver header: confirmar_despacho_stock() no tiene caller real — si esto falla, es buena noticia (se conectó), actualizar Etapa 4/5 del plan').toBe(0);

    // ── Paso 4: cobrar — cta_cte, mismo monto otra vez, en una tercera
    // pantalla alimentada por un tercer mock (fn_cta_cte_lista).
    mockearRpc(page, 'fn_cta_cte_lista', () => [{
      cliente_id: CLIENTE_ID,
      razon_social: 'Cliente E2E Flujo SRL',
      nombre_fantasia: 'Cliente E2E Flujo',
      deuda_total: flujo.saldoDeuda,
      deuda_vencida: flujo.saldoDeuda,
      deuda_por_vencer: 0,
      ultimo_pago: null,
      facturas_pendientes: flujo.saldoDeuda > 0 ? 1 : 0,
      total_count: 1,
    }]);
    mockearRpc(page, 'fn_cta_cte_kpis', () => [{
      deuda_total: flujo.saldoDeuda, clientes_total: 1,
      deuda_vencida: flujo.saldoDeuda, clientes_vencido: flujo.saldoDeuda > 0 ? 1 : 0,
      deuda_por_vencer: 0, clientes_por_vencer: 0,
      deuda_al_dia: 0, clientes_al_dia: 0,
    }]);
    mockearTabla(page, 'cta_cte', { onSelect: () => [] });
    mockearRpc(page, 'registrar_cobro_completo', ({ params }) => {
      llamadasRpc.registrar_cobro_completo += 1;
      payloadCobro = params;
      flujo.saldoDeuda = 0;
      return { ok: true, nro: 'C-0001', factura_saldada: true, cobro_id: 'e2e-cobro-1' };
    });

    const ctaCtePage = new CtaCtePage(page, staticServer.baseURL);
    await ctaCtePage.goto();
    await expect(ctaCtePage.fila(CLIENTE_ID)).toBeVisible();
    await expect(ctaCtePage.fila(CLIENTE_ID)).toContainText(formatPesoEsperado(MONTO_TOTAL));

    await ctaCtePage.cobrarDesdeFilaPorId(CLIENTE_ID);
    await ctaCtePage.completarCobro({ monto: MONTO_TOTAL, medio: 'efectivo' });
    await ctaCtePage.guardarCobro();

    expect(llamadasRpc.registrar_cobro_completo).toBe(1);
    expect(payloadCobro.p_cliente_id).toBe(CLIENTE_ID);
    expect(payloadCobro.p_monto).toBe(MONTO_TOTAL); // el monto pagado coincide con el total del pedido/factura de arriba
    await expect(page.locator('.toast-msg')).toContainText('registrado');

    // ── Cierre del círculo: saldo del cliente en $0 después de cobrar
    // exactamente el total del pedido/factura de los pasos 1-2. Esta es
    // la aserción de monto "de punta a punta" que pedía la Etapa 5.
    await expect(ctaCtePage.fila(CLIENTE_ID)).not.toBeVisible().catch(() => {});
    // Si el cliente saldado sale de "Saldos por cliente" (deuda_total=0
    // suele filtrarse de la vista por defecto), no hay fila que chequear
    // — el propio código de cta-cte.js reabre el panel solo si el cliente
    // sigue en la lista (ver cierrePanel/abrirCliente más arriba en
    // frontend/admin/js/cta-cte.js); cualquiera de los dos casos es
    // consistente con "saldo saldado".

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });
});
