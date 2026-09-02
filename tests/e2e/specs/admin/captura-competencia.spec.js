// Plan 1.6 (PLAN_CAPTURA_COMPETENCIA.md): el piso de margen ya tiene su
// control obligatorio a nivel unitario en
// tests/handlers/captura-competencia-margen.test.js. Este spec cubre lo
// que quedaba pendiente de esa misma sección — el flujo E2E completo con
// clicks reales sobre la pantalla:
//
//   1. Carga inicial: lista + filtro por estado.
//   2. Nueva captura: subir foto → analizar → abre el panel de revisión
//      automáticamente con los renglones detectados.
//   3. Ajuste de renglón: cantidad/precio propio, y asignar producto
//      propio a un renglón que no matcheó solo.
//   4. Cerrar cotización: caso éxito (resumen de ahorro) y caso
//      rechazado por el piso de margen (409, warning en el renglón).
//   5. Convertir en cliente + pedido: cliente existente y cliente nuevo.
//   6. Feature flag deshabilitado por empresa (403): oculta "+ Nueva
//      captura" y muestra el mensaje, en vez del error crudo.
//
// Igual que pos.js/compras.js, todo pasa por `/api/*` (nunca PostgREST
// directo) — pero acá las 6 acciones comparten el mismo endpoint base
// `/api/captura-competencia`, discriminadas por `?accion=...`. mockApi
// matchea por substring de URL, así que cada acción necesita su propia
// key con el querystring incluido (mismo patrón que
// '/api/fidelizacion?accion=canjear' en cuenta.spec.js) — SIN esto,
// cualquier key más corta como '/api/captura-competencia' a secas
// matchearía las 6 acciones con la MISMA respuesta.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { CapturaCompetenciaPage } from '../../page-objects/admin/captura-competencia.page.js';

const CAPTURA_ID = 'cc-000000000001';

const PRODUCTO_MATCHEADO = { id: 'prod-1', nombre: 'Coca Cola 500ml', precio_base: 1000 };
const PRODUCTO_A_BUSCAR = { id: 'prod-2', nombre: 'Sprite 500ml', precio_base: 950 };
const CLIENTE_EXISTENTE = { id: 'cliente-1', razon_social: 'Almacén Don José' };

function itemMatcheado(overrides = {}) {
  return {
    id: 'cc-item-1',
    texto_original: 'COCA COLA 500ML X24',
    producto_id: PRODUCTO_MATCHEADO.id,
    cantidad: 24,
    precio_unitario_competencia: 950,
    precio_unitario_propio: 850,
    confianza_match: 0.92,
    productos: PRODUCTO_MATCHEADO,
    descartado: false,
    ...overrides,
  };
}

function itemSinMatch(overrides = {}) {
  return {
    id: 'cc-item-2',
    texto_original: 'SPRITE 500 X12 (manuscrito, borroso)',
    producto_id: null,
    cantidad: 12,
    precio_unitario_competencia: 900,
    precio_unitario_propio: null,
    confianza_match: null,
    productos: null,
    descartado: false,
    ...overrides,
  };
}

function capturaDetalle({ estado = 'pendiente_revision', items, totales = {} } = {}) {
  return {
    id: CAPTURA_ID,
    estado,
    proveedor_competencia_nombre: 'Distribuidora Rival SRL',
    fecha_captura: '2026-08-20T10:00:00Z',
    imagen_original_url: 'https://example.com/fake-signed-url/factura.jpg',
    usuarios: { nombre: 'Vendedor E2E' },
    captura_competencia_items: items ?? [itemMatcheado(), itemSinMatch()],
    total_competencia: null,
    total_propio_cotizado: null,
    ahorro_absoluto: null,
    ahorro_porcentual: null,
    pedido_id: null,
    ...totales,
  };
}

const CAPTURA_FILA_LISTADO = {
  id: CAPTURA_ID,
  fecha_captura: '2026-08-20T10:00:00Z',
  proveedor_competencia_nombre: 'Distribuidora Rival SRL',
  estado: 'pendiente_revision',
  ahorro_absoluto: null,
  ahorro_porcentual: null,
  usuarios: { nombre: 'Vendedor E2E' },
};

const METRICAS_VACIAS = {
  total_capturas: 1,
  total_convertidas: 0,
  tasa_conversion_pct: 0,
  tiempo_promedio_foto_cierre_horas: null,
};

// Handlers base compartidos por (casi) todos los tests — mismo criterio
// que handlersBase() en pos.spec.js: cada test que necesita una acción
// distinta la pisa vía `overrides`.
function handlersBase(overrides = {}) {
  return {
    '/api/captura-competencia?accion=listar': overrides.listar || (() => ({ json: { capturas: [CAPTURA_FILA_LISTADO] } })),
    '/api/captura-competencia?accion=metricas': overrides.metricas || (() => ({ json: METRICAS_VACIAS })),
    '/api/captura-competencia?accion=detalle': overrides.detalle || (() => ({ json: { captura: capturaDetalle() } })),
    '/api/captura-competencia?accion=crear': overrides.crear || (() => ({
      status: 201,
      json: { captura: capturaDetalle({ items: [itemMatcheado(), itemSinMatch()] }) },
    })),
    '/api/captura-competencia?accion=confirmar_item': overrides.confirmarItem || (() => ({ json: { ok: true } })),
    '/api/captura-competencia?accion=cerrar': overrides.cerrar || (() => ({
      json: { ok: true, total_competencia: 33600, total_propio_cotizado: 30000, ahorro_absoluto: 3600, ahorro_porcentual: 10.7 },
    })),
    '/api/captura-competencia?accion=convertir': overrides.convertir || (() => ({
      status: 201,
      json: { ok: true, cliente_id: CLIENTE_EXISTENTE.id, pedido: { ok: true, pedido_id: 'pedido-e2e-1' } },
    })),
    '/api/pos/productos': overrides.productos || (() => ({ json: [PRODUCTO_A_BUSCAR] })),
    '/api/clientes': overrides.clientes || (() => ({ json: [CLIENTE_EXISTENTE] })),
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function abrirCaptura(page, overrides) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);
  await loguearComoAdmin(page);
  const contadores = mockApi(page, handlersBase(overrides));

  const cc = new CapturaCompetenciaPage(page, staticServer.baseURL);
  const erroresConsola = cc.capturarErroresConsola();
  await cc.goto();
  return { cc, erroresConsola, contadores };
}

test.describe('Captura de competencia (admin) — flujo E2E completo (Plan 1.6)', () => {

  test('carga inicial: lista con la fila de la captura pendiente, filtro por estado', async ({ page }) => {
    const { cc, erroresConsola } = await abrirCaptura(page);

    await expect(cc.filas).toHaveCount(1);
    await expect(cc.fila(CAPTURA_ID)).toContainText('Distribuidora Rival SRL');
    await expect(cc.fila(CAPTURA_ID)).toContainText('Pendiente de revisión');
    await expect(cc.kpis).toBeVisible();
    await expect(cc.kpis).toContainText('1');

    await cc.filtrarPorEstado('revisado');
    await expect(cc.filas).toHaveCount(0);

    expect(filtrarRuidoRed(erroresConsola)).toEqual([]);
  });

  test('nueva captura: subir foto y analizar abre el panel de revisión con los renglones detectados', async ({ page }) => {
    let bodyRecibido = null;
    const { cc } = await abrirCaptura(page, {
      crear: (call) => {
        bodyRecibido = call.request.postDataJSON();
        return { status: 201, json: { captura: capturaDetalle({ items: [itemMatcheado(), itemSinMatch()] }) } };
      },
    });

    await cc.abrirModalNueva();
    await cc.adjuntarFoto();
    await cc.crearCaptura({ proveedor: 'Distribuidora Rival SRL' });

    await cc.esperarToastExito('analizada');
    await expect(cc.modalNueva).toBeHidden();
    await cc.esperarPanelAbierto();
    await expect(cc.panelTitulo).toContainText('Pendiente de revisión');
    await expect(cc.item('cc-item-1')).toBeVisible();
    await expect(cc.item('cc-item-2')).toBeVisible();

    expect(bodyRecibido.imagen_mime_type).toBe('image/jpeg');
    expect(bodyRecibido.proveedor_competencia_nombre).toBe('Distribuidora Rival SRL');
    expect(typeof bodyRecibido.imagen_base64).toBe('string');
    expect(bodyRecibido.imagen_base64.length).toBeGreaterThan(0);
  });

  test('ajuste de renglón: cambiar cantidad/precio propio y asignar producto a un ítem sin match', async ({ page }) => {
    let ultimoPayloadConfirmar = null;
    const { cc } = await abrirCaptura(page, {
      confirmarItem: (call) => {
        ultimoPayloadConfirmar = call.request.postDataJSON();
        return { json: { ok: true } };
      },
    });

    await cc.abrirFila(CAPTURA_ID);
    await cc.esperarPanelAbierto();

    // Renglón ya matcheado: ajusta cantidad y precio propio a mano.
    await cc.completarItem('cc-item-1', { cantidad: 20, precioPropio: 900 });
    expect(ultimoPayloadConfirmar).toMatchObject({ item_id: 'cc-item-1', precio_unitario_propio: 900 });

    // Renglón sin match automático: busca y asigna el producto propio.
    await expect(cc.item('cc-item-2')).toContainText('Sin match');
    await cc.buscarYElegirProducto('cc-item-2', 'sprite', PRODUCTO_A_BUSCAR.id);
    expect(ultimoPayloadConfirmar).toMatchObject({ item_id: 'cc-item-2', producto_id: PRODUCTO_A_BUSCAR.id });
    await expect(cc.item('cc-item-2').locator('input[data-rol="buscar-producto"]')).toHaveValue(PRODUCTO_A_BUSCAR.nombre);
  });

  test('cerrar cotización: caso éxito muestra el resumen de ahorro', async ({ page }) => {
    const { cc } = await abrirCaptura(page);

    await cc.abrirFila(CAPTURA_ID);
    await cc.esperarPanelAbierto();
    await cc.cerrarCotizacion();

    await cc.esperarToastExito('ahorro calculado');
    await expect(cc.panelTitulo).toContainText('Revisado');
    await expect(cc.resumenAhorro).toContainText('10.7%');
  });

  test('cerrar cotización: rechazada por el piso de margen muestra el warning en el renglón', async ({ page }) => {
    const { cc } = await abrirCaptura(page, {
      cerrar: () => ({
        status: 409,
        json: {
          error: '1 renglón(es) quedarían por debajo del margen mínimo (8%). Ajustá el precio antes de cerrar.',
          violaciones_margen: [{ item_id: 'cc-item-1', margen_actual_pct: 3.2 }],
        },
      }),
    });

    await cc.abrirFila(CAPTURA_ID);
    await cc.esperarPanelAbierto();
    await cc.cerrarCotizacion();

    await cc.esperarToastExito('margen mínimo');
    await expect(cc.itemWarningMargen('cc-item-1')).toContainText('3.2%');
    // La captura sigue pendiente — no hay bypass del control cerrando igual.
    await expect(cc.panelTitulo).toContainText('Pendiente de revisión');
  });

  test('convertir en cliente + pedido: cliente existente', async ({ page }) => {
    const { cc } = await abrirCaptura(page, {
      detalle: () => ({
        json: {
          captura: capturaDetalle({
            estado: 'revisado',
            items: [itemMatcheado(), itemSinMatch({ producto_id: PRODUCTO_A_BUSCAR.id, productos: PRODUCTO_A_BUSCAR, precio_unitario_propio: 800 })],
            totales: { total_competencia: 33600, total_propio_cotizado: 30000, ahorro_absoluto: 3600, ahorro_porcentual: 10.7 },
          }),
        },
      }),
    });

    await cc.abrirFila(CAPTURA_ID);
    await cc.esperarPanelAbierto();
    await expect(cc.resumenAhorro).toContainText('10.7%');

    await cc.buscarYElegirCliente('don jose', CLIENTE_EXISTENTE.id);
    await expect(cc.clienteElegidoTexto).toContainText(CLIENTE_EXISTENTE.razon_social);
    await cc.convertir();

    await cc.esperarToastExito('Cliente y pedido creados');
    await expect(cc.alertaConvertida).toContainText('pedido-e2e-1');
    await expect(cc.panelTitulo).toContainText('Convertido en pedido');
  });

  test('convertir en cliente + pedido: cliente nuevo, manda razón social/teléfono/dirección en el body', async ({ page }) => {
    let bodyConvertir = null;
    const { cc } = await abrirCaptura(page, {
      detalle: () => ({
        json: {
          captura: capturaDetalle({
            estado: 'revisado',
            totales: { total_competencia: 33600, total_propio_cotizado: 30000, ahorro_absoluto: 3600, ahorro_porcentual: 10.7 },
          }),
        },
      }),
      convertir: (call) => {
        bodyConvertir = call.request.postDataJSON();
        return { status: 201, json: { ok: true, cliente_id: 'cliente-nuevo-1', pedido: { ok: true, pedido_id: 'pedido-e2e-2' } } };
      },
    });

    await cc.abrirFila(CAPTURA_ID);
    await cc.esperarPanelAbierto();

    await cc.completarClienteNuevo({ razonSocial: 'Kiosco La Esquina', telefono: '3400123456', direccion: 'San Martín 123' });
    await cc.convertir();

    await cc.esperarToastExito('Cliente y pedido creados');
    await expect(cc.alertaConvertida).toContainText('pedido-e2e-2');
    expect(bodyConvertir.cliente_nuevo).toMatchObject({
      razon_social: 'Kiosco La Esquina',
      telefono: '3400123456',
      direccion: 'San Martín 123',
    });
    expect(bodyConvertir.cliente_id).toBeUndefined();
  });

  // FIX: se sacó este test. Probaba el gate de
  // `empresas.config->>'captura_competencia_habilitada'`
  // (CAPTURA_COMPETENCIA_DESHABILITADA), pero ese gate se removió del
  // backend "a pedido directo" (ver el comentario "Ex-gate de flag" en
  // lib/handlers/captura-competencia.js y lib/handlers/prospectos-competencia.js):
  // la función queda disponible para TODAS las empresas sin excepción, sin
  // depender de esa clave de config. No es un bug de la pantalla — el
  // backend simplemente ya no devuelve ese 403 nunca, así que no hay nada
  // que este test pueda seguir verificando. Si el flag vuelve a existir en
  // el futuro, este es el lugar para reponerlo.
});
