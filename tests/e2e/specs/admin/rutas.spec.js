// Fase 2 (P1), primera página (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 6
// — bloque "operación de depósito" priorizado explícitamente por el
// usuario sobre el resto de las 20 páginas de P1).
//
// A diferencia de las 9 páginas de Fase 1 (que en su mayoría hablan con
// `/api/*`), `rutas.js` arma la ruta con 3 escrituras PostgREST directas
// vía `sb.from()` en secuencia (`rutas` insert → `entregas` insert →
// `pedidos` update a `preparando`) y recién después notifica al chofer
// por WhatsApp/push (`/api/notif/*`, fuera de alcance de aserción acá —
// cubierto por el catch-all genérico). El mock de las 3 tablas lleva
// estado en memoria (no fixtures estáticos) para poder confirmar el
// efecto real de punta a punta: el pedido recién ruteado desaparece del
// panel de pendientes en el siguiente `cargarDatos()`.
//
// Alcance deliberado (mismo criterio que compras/cta-cte de Fase 1): NO
// cubre "Seguimiento en vivo" (mapa Leaflet + suscripción realtime),
// "Historial" ni "Reporte de ruta" — cada una es un sub-flujo con su
// propia complejidad (más parecido a "Recepcionar" en compras.spec.js
// que a un submit simple). Tampoco cubre "Ingresar como chofer" ni
// "Invitar chofer" (ambas abren de más, ya semi-cubiertas por el patrón
// de `ingresarComoChofer` en clientes.spec.js — `verCatalogoCliente`).

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearTabla, mockearRestGenerico, mockearApiGenerico, HEADER_SINGLE } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { RutasPage } from '../../page-objects/admin/rutas.page.js';

const PEDIDO_ID  = 'e2e-pedido-000000000001';
const CHOFER_ID  = 'e2e-chofer-000000000001';
const RUTA_ID    = 'e2e-ruta-existente-000001';
const RUTA_NUEVA_ID = 'e2e-ruta-nueva-000001';

const CHOFERES = [{ id: CHOFER_ID, nombre: 'Matías Gómez' }];

function pedidoDespachable(overrides = {}) {
  return {
    id: PEDIDO_ID,
    estado: 'confirmado',
    total: 5000,
    notas_cliente: null,
    fecha_entrega: null,
    clientes: {
      id: 'e2e-cliente-1',
      razon_social: 'Almacén E2E SRL',
      domicilio: 'Calle Falsa 123',
      localidad: 'Reconquista',
      telefono: '3482111111',
      zonas: { nombre: 'Zona Norte' },
    },
    ...overrides,
  };
}

function rutaExistente(overrides = {}) {
  return {
    id: RUTA_ID,
    fecha: new Date().toISOString().split('T')[0],
    estado: 'pendiente',
    notas: null,
    created_at: new Date().toISOString(),
    usuarios: { nombre: 'Pedro Otro Chofer' },
    entregas: [
      { id: 'e2e-entrega-vieja-1', estado: 'pendiente', pedido_id: 'e2e-pedido-000000000099', monto_cobrado: null, pedidos: { total: 3000 } },
    ],
    ...overrides,
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

/**
 * Setup de red compartido por los tests. A diferencia de Fase 1, acá se
 * mantiene estado mutable de `rutas`/`entregas` en closures (no fixtures
 * fijos) porque `confirmarRuta()` hace 3 escrituras PostgREST directas
 * cuyo efecto (pedido ya no aparece como despachable) el propio
 * `cargarPedidosDespachables()` vuelve a consultar en el siguiente
 * `cargarDatos()` — ver Hallazgo 2 en la exploración previa del código
 * (filtro `pedidosYaEnRuta` contra `entregas` activas).
 */
async function armarPagina(page, { pedidosIniciales = [pedidoDespachable()], rutasIniciales = [rutaExistente()] } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  const { perfil } = await loguearComoAdmin(page);

  // `usuarios` sirve DOS propósitos en esta página: el `.single()` de
  // auth.js (perfil logueado) y el listado sin `.single()` de
  // `cargarChoferes()` (combo de choferes). El mock de `loguearComoAdmin`
  // ya cubre el primero pero siempre devuelve `[]` para el segundo — se
  // pisa acá (registrado después, gana por orden — mismo criterio
  // documentado en auth-helper.js y ya usado en smoke-universal.spec.js).
  mockearTabla(page, 'usuarios', {
    onSelect: ({ request }) => {
      const esSingle = (request.headers()['accept'] || '').includes(HEADER_SINGLE);
      return esSingle ? perfil : CHOFERES;
    },
  });

  let rutasCreadas = [...rutasIniciales];
  let entregasActivas = [];

  const contadorRutas = mockearTabla(page, 'rutas', {
    onSelect: () => rutasCreadas,
    onInsert: ({ body }) => {
      const nueva = { id: RUTA_NUEVA_ID, ...body };
      rutasCreadas = [
        ...rutasCreadas,
        {
          ...nueva,
          usuarios: { nombre: CHOFERES.find((c) => c.id === body.chofer_id)?.nombre || '?' },
          entregas: [],
        },
      ];
      return nueva;
    },
  });

  const contadorEntregas = mockearTabla(page, 'entregas', {
    onSelect: () => entregasActivas,
    onInsert: ({ body }) => {
      const items = Array.isArray(body) ? body : [body];
      entregasActivas = [...entregasActivas, ...items.map((e) => ({ pedido_id: e.pedido_id }))];
      return items;
    },
  });

  const contadorPedidos = mockearTabla(page, 'pedidos', {
    onSelect: () => pedidosIniciales,
    onUpdate: () => ({}),
  });

  const rutasPage = new RutasPage(page, staticServer.baseURL);
  return { rutasPage, contadorRutas, contadorEntregas, contadorPedidos };
}

test.describe('Rutas (admin) — Fase 2 P1', () => {
  test('la lista carga pedidos despachables y las rutas del día con los datos correctos', async ({ page }) => {
    const { rutasPage } = await armarPagina(page);
    const erroresConsola = rutasPage.capturarErroresConsola();

    await rutasPage.goto();

    await expect(rutasPage.pedidoCard(PEDIDO_ID)).toBeVisible();
    await expect(rutasPage.pedidoCard(PEDIDO_ID)).toContainText('Almacén E2E SRL');
    // agruparZona=true es el default (rutas.js) — el nombre de zona se
    // pinta como header del grupo, no repetido en cada card individual
    // (ver cardPedidoHtml(p, { mostrarZona: false })). Test actualizado
    // para reflejar ese rediseño intencional en vez de esperar el texto
    // suelto en la card.
    await expect(rutasPage.grupoZonaDe(PEDIDO_ID)).toContainText('Zona Norte');
    // Singular correcto: renderPendientes() pluraliza "pedido"/"disponible"
    // según libres.length (ver rutas.js) y agrega el monto total con
    // formatARS — con 1 pedido el texto queda "1 pedido disponible · $X".
    await expect(rutasPage.labelPendientes).toContainText('1 pedido disponible');

    await expect(rutasPage.tablaRutasDia).toContainText('Pedro Otro Chofer');
    await expect(rutasPage.tablaRutasDia).toContainText('Pendiente');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('armar la ruta con un pedido y confirmar crea la ruta, las entregas y notifica al chofer', async ({ page }) => {
    const { rutasPage } = await armarPagina(page);

    let bodyRuta = null;
    let bodyEntregas = null;
    let bodyUpdatePedidos = null;
    await page.route('**/rest/v1/rutas**', async (route, request = route.request()) => {
      if (request.method() === 'POST') bodyRuta = request.postDataJSON();
      return route.fallback();
    });
    await page.route('**/rest/v1/entregas**', async (route, request = route.request()) => {
      if (request.method() === 'POST') bodyEntregas = request.postDataJSON();
      return route.fallback();
    });
    await page.route('**/rest/v1/pedidos**', async (route, request = route.request()) => {
      if (request.method() === 'PATCH') bodyUpdatePedidos = request.postDataJSON();
      return route.fallback();
    });

    await rutasPage.goto();

    await rutasPage.agregarPedido(PEDIDO_ID);
    await expect(rutasPage.dropEmpty).not.toBeVisible();
    await expect(rutasPage.statPedidos).toHaveText('1');
    await expect(rutasPage.statTotal).toContainText('5.000');

    await rutasPage.rutaFecha.fill('2026-08-10');
    await rutasPage.rutaChofer.selectOption(CHOFER_ID);
    await rutasPage.rutaNotas.fill('Zona norte AM');

    await rutasPage.confirmarRuta();

    await rutasPage.esperarToastExito('Matías Gómez notificado');

    expect(bodyRuta).toMatchObject({
      chofer_id: CHOFER_ID,
      fecha: '2026-08-10',
      estado: 'pendiente',
      notas: 'Zona norte AM',
    });
    expect(bodyEntregas).toEqual([
      expect.objectContaining({ pedido_id: PEDIDO_ID, orden: 1, estado: 'pendiente' }),
    ]);
    expect(bodyUpdatePedidos).toMatchObject({ estado: 'preparando' });

    // limpiarRuta() + cargarDatos() de vuelta: el panel de armado queda
    // vacío y el pedido recién ruteado ya no vuelve a aparecer como
    // despachable (filtro `pedidosYaEnRuta` contra la entrega recién
    // insertada — ver armarPagina()).
    await expect(rutasPage.dropEmpty).toBeVisible();
    await expect(rutasPage.statPedidos).toHaveText('0');
    await expect(rutasPage.pedidoCard(PEDIDO_ID)).not.toBeVisible();
  });

  test('sin chofer elegido no dispara ningún request — validación de cliente', async ({ page }) => {
    const { rutasPage } = await armarPagina(page);

    let huboInsertRuta = false;
    await page.route('**/rest/v1/rutas**', async (route) => {
      if (route.request().method() === 'POST') huboInsertRuta = true;
      await route.fallback();
    });

    await rutasPage.goto();
    await rutasPage.agregarPedido(PEDIDO_ID);
    await rutasPage.rutaFecha.fill('2026-08-10');
    // Chofer sin seleccionar a propósito.

    await rutasPage.btnConfirmarRuta.click();

    await rutasPage.esperarToastExito('Seleccioná un chofer');
    // confirmarRuta() corta antes de pedir confirmación — no hay diálogo.
    await expect(rutasPage.dialogoConfirmar).not.toBeVisible();
    await expect(rutasPage.statPedidos).toHaveText('1'); // la ruta armada no se pierde
    expect(huboInsertRuta).toBe(false);
  });

  test('sin pedidos en la ruta no dispara ningún request — validación de cliente', async ({ page }) => {
    const { rutasPage } = await armarPagina(page);

    let huboInsertRuta = false;
    await page.route('**/rest/v1/rutas**', async (route) => {
      if (route.request().method() === 'POST') huboInsertRuta = true;
      await route.fallback();
    });

    await rutasPage.goto();
    // Sin agregar ningún pedido a la ruta.
    await rutasPage.rutaChofer.selectOption(CHOFER_ID);

    await rutasPage.btnConfirmarRuta.click();

    await rutasPage.esperarToastExito('Agregá al menos un pedido a la ruta');
    await expect(rutasPage.dialogoConfirmar).not.toBeVisible();
    expect(huboInsertRuta).toBe(false);
  });

  test('rechazo del servidor al crear la ruta muestra el error y no pierde la ruta armada', async ({ page }) => {
    const { rutasPage } = await armarPagina(page);

    // Pisa el insert de `rutas` para forzar el error — registrado DESPUÉS
    // de armarPagina(), gana por orden (mismo criterio que compras.spec.js).
    await page.route('**/rest/v1/rutas**', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 400,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ message: 'RLS: no autorizado para crear rutas en esta empresa' }),
      });
    });

    await rutasPage.goto();
    await rutasPage.agregarPedido(PEDIDO_ID);
    await rutasPage.rutaFecha.fill('2026-08-10');
    await rutasPage.rutaChofer.selectOption(CHOFER_ID);

    await rutasPage.confirmarRuta();

    // confirmarRuta() atrapa cualquier error del try/catch y siempre
    // muestra este mensaje genérico — no el de RLS de arriba (ver
    // catch en rutas.js: no interpola `err.message`). Documentado acá en
    // vez de "corregido" porque no forma parte del pedido original de
    // esta vuelta — queda anotado para una futura pasada de UX errors.
    await rutasPage.esperarToastExito('Error al crear la ruta — revisá la consola');

    // La ruta armada sigue en pantalla — limpiarRuta() solo corre en el
    // camino feliz, después de que las 3 escrituras resuelven OK.
    await expect(rutasPage.dropEmpty).not.toBeVisible();
    await expect(rutasPage.statPedidos).toHaveText('1');
    await expect(rutasPage.rutaChofer).toHaveValue(CHOFER_ID);
  });
});
