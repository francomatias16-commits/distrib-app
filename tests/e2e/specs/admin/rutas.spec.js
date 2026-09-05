// Fase 2 (P1), primera página (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 6
// — bloque "operación de depósito" priorizado explícitamente por el
// usuario sobre el resto de las 20 páginas de P1).
//
// A diferencia de las 9 páginas de Fase 1 (que en su mayoría hablan con
// `/api/*`), `rutas.js` arma la ruta con UNA RPC transaccional
// (`rpc_confirmar_ruta`, migración 576) que hace las 3 escrituras (INSERT
// rutas, INSERT entregas, UPDATE pedidos) del lado del servidor — antes
// (hasta v1054) eran 3 escrituras PostgREST sueltas desde el cliente; se
// migró a v1055 para que un fallo a mitad de camino no deje estado
// inconsistente. El test mockea la RPC, no las tablas directamente — el
// detalle interno de las 3 escrituras queda fuera del alcance de este
// E2E (vive en la función de Postgres, no en el cliente) y recién después
// notifica al chofer por WhatsApp/push (`/api/notif/*`, fuera de alcance
// de aserción acá — cubierto por el catch-all genérico). El mock de
// las tablas `rutas`/`entregas`/`pedidos` sigue llevando estado en
// memoria (no fixtures estáticos) para poder confirmar el efecto real
// de punta a punta tras la RPC: el pedido recién ruteado desaparece del
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
import { mockearTabla, mockearRestGenerico, mockearApiGenerico, mockearRpc, HEADER_SINGLE } from '../../helpers/supabase-rest-mock.js';
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
 * fijos) porque el mock de `rpc_confirmar_ruta` aplica sobre esos mocks
 * de tabla el mismo efecto que la RPC real aplica del lado del servidor,
 * y `cargarPedidosDespachables()` vuelve a consultar ese estado en el
 * siguiente `cargarDatos()` — ver Hallazgo 2 en la exploración previa del
 * código (filtro `pedidosYaEnRuta` contra `entregas` activas).
 */
async function armarPagina(page, { pedidosIniciales = [pedidoDespachable()], rutasIniciales = [rutaExistente()] } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  // FIX: el catch-all de mockearApiGenerico responde `{ ok: true }` a
  // cualquier POST, pero notificarChofer() (rutas.js) exige
  // `result.enviadas > 0` en la respuesta de /api/notif/push-chofer para
  // considerar la notificación exitosa (`pushOk`). Como CHOFERES no trae
  // `telefono`, el camino de WhatsApp ni siquiera se intenta (`waOk`
  // queda en false), así que sin este mock específico `waOk||pushOk` da
  // false siempre y el toast real es "No se pudo enviar la notificación
  // al chofer" — nunca "<chofer> notificado", que es lo que espera el
  // test de armado de ruta. Registrado después del catch-all para
  // pisarlo (mismo criterio ya documentado arriba con `usuarios`).
  await page.route('**/api/notif/push-chofer**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ enviadas: 1 }),
    });
  });
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
  });

  const contadorEntregas = mockearTabla(page, 'entregas', {
    onSelect: () => entregasActivas,
  });

  const contadorPedidos = mockearTabla(page, 'pedidos', {
    onSelect: () => pedidosIniciales,
    onUpdate: () => ({}),
  });

  // Mock de la RPC transaccional real (ver comentario de cabecera). Éxito
  // por defecto: aplica a los mocks de tabla de arriba el mismo efecto que
  // antes aplicaban los onInsert sueltos (así `cargarDatos()` después de
  // confirmar ve la ruta/entrega nuevas y el pedido ya no aparece como
  // despachable) — un test puntual puede pisar este mock después de
  // `armarPagina()` para forzar el camino de error (mismo criterio de
  // "el último registrado gana" ya documentado en el resto del archivo).
  let ultimaLlamadaConfirmarRuta = null;
  const contadorConfirmarRuta = mockearRpc(page, 'rpc_confirmar_ruta', ({ params }) => {
    ultimaLlamadaConfirmarRuta = params;
    const nueva = {
      id:        RUTA_NUEVA_ID,
      chofer_id: params.p_chofer_id,
      fecha:     params.p_fecha,
      estado:    'pendiente',
      notas:     params.p_notas ?? null,
    };
    rutasCreadas = [
      ...rutasCreadas,
      { ...nueva, usuarios: { nombre: CHOFERES.find((c) => c.id === params.p_chofer_id)?.nombre || '?' }, entregas: [] },
    ];
    entregasActivas = [
      ...entregasActivas,
      ...(params.p_pedido_ids || []).map((pedidoId, idx) => ({ pedido_id: pedidoId, orden: idx + 1, estado: 'pendiente' })),
    ];
    return { ok: true, ruta: nueva };
  });

  const rutasPage = new RutasPage(page, staticServer.baseURL);
  return {
    rutasPage, contadorRutas, contadorEntregas, contadorPedidos, contadorConfirmarRuta,
    obtenerUltimaLlamadaConfirmarRuta: () => ultimaLlamadaConfirmarRuta,
  };
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
    // FIX: el label pasó de "N pedido(s) disponible(s) · $monto" a "N
    // disponible(s) · M seleccionado(s)" (rediseño que sumó selección
    // múltiple por zona — ver renderPendientes() en rutas.js, ya no
    // pluraliza "pedido" ni muestra el monto acá). Con 1 pedido cargado y
    // ninguno todavía agregado a la ruta: "1 disponible · 0 seleccionado".
    await expect(rutasPage.labelPendientes).toContainText('1 disponible · 0 seleccionado');

    await expect(rutasPage.tablaRutasDia).toContainText('Pedro Otro Chofer');
    await expect(rutasPage.tablaRutasDia).toContainText('Pendiente');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('armar la ruta con un pedido y confirmar crea la ruta, las entregas y notifica al chofer', async ({ page }) => {
    // FIX (v1054 → v1055): las 3 escrituras (INSERT rutas, INSERT entregas,
    // UPDATE pedidos) ya no salen del cliente como requests PostgREST
    // sueltas — viven del lado del servidor dentro de `rpc_confirmar_ruta`
    // (ver comentario de cabecera y `armarPagina()`). Este test ya no puede
    // interceptar `POST /rest/v1/rutas|entregas` ni `PATCH /rest/v1/pedidos`
    // porque esas rutas nunca se disparan; lo que SÍ podemos seguir
    // verificando desde el E2E es que el cliente arma correctamente el
    // payload que le manda a la RPC — `obtenerUltimaLlamadaConfirmarRuta()`
    // expone justamente eso. El detalle de que la RPC efectivamente haga
    // las 3 escrituras es responsabilidad de la función de Postgres, fuera
    // del alcance de este test (documentado también en la cabecera).
    const { rutasPage, obtenerUltimaLlamadaConfirmarRuta } = await armarPagina(page);

    await rutasPage.goto();

    await rutasPage.agregarPedido(PEDIDO_ID);
    await expect(rutasPage.dropEmpty).not.toBeVisible();
    await expect(rutasPage.statPedidos).toHaveText('1');
    await expect(rutasPage.statTotal).toContainText('5.000');

    await rutasPage.rutaFecha.fill('2026-08-10');
    await rutasPage.rutaChofer.selectOption(CHOFER_ID);
    // FIX: "Notas" se sacó del formulario visible en v964 (ver comentario
    // en rutas.html) y quedó como <input type="hidden"> solo por
    // compatibilidad con rutas.js — ya no es .fill()-eable, y rutas.js
    // manda `notas: null` cuando el campo queda vacío (ver
    // `document.getElementById('ruta-notas').value || null`).

    await rutasPage.confirmarRuta();

    await rutasPage.esperarToastExito('Matías Gómez notificado');

    // Payload que el cliente le mandó a rpc_confirmar_ruta — reemplaza a
    // los bodyRuta/bodyEntregas/bodyUpdatePedidos de la versión pre-v1055.
    expect(obtenerUltimaLlamadaConfirmarRuta()).toMatchObject({
      p_chofer_id:  CHOFER_ID,
      p_fecha:      '2026-08-10',
      p_notas:      null,
      p_pedido_ids: [PEDIDO_ID],
    });

    // limpiarRuta() + cargarDatos() de vuelta: el panel de armado queda
    // vacío y el pedido recién ruteado ya no vuelve a aparecer como
    // despachable (filtro `pedidosYaEnRuta` contra la entrega recién
    // insertada — ver armarPagina()).
    await expect(rutasPage.dropEmpty).toBeVisible();
    await expect(rutasPage.statPedidos).toHaveText('0');
    await expect(rutasPage.pedidoCard(PEDIDO_ID)).not.toBeVisible();
  });

  test('sin chofer elegido no dispara ningún request — validación de cliente', async ({ page }) => {
    // FIX (v1054 → v1055): "ningún request" ahora se verifica contra la
    // RPC (`rpc_confirmar_ruta`), no contra `POST /rest/v1/rutas` — esa
    // ruta REST ya no existe en el camino de confirmarRuta() (ver test
    // de armado más arriba). `contadorConfirmarRuta` cuenta llamadas
    // reales a la RPC, así que sigue probando lo mismo que antes:
    // la validación de cliente corta ANTES de tocar la red.
    const { rutasPage, contadorConfirmarRuta } = await armarPagina(page);

    await rutasPage.goto();
    await rutasPage.agregarPedido(PEDIDO_ID);
    await rutasPage.rutaFecha.fill('2026-08-10');
    // Chofer sin seleccionar a propósito.

    await rutasPage.btnConfirmarRuta.click();

    await rutasPage.esperarToastExito('Seleccioná un chofer');
    // confirmarRuta() corta antes de pedir confirmación — no hay diálogo.
    await expect(rutasPage.dialogoConfirmar).not.toBeVisible();
    await expect(rutasPage.statPedidos).toHaveText('1'); // la ruta armada no se pierde
    expect(contadorConfirmarRuta()).toBe(0);
  });

  test('sin pedidos en la ruta no dispara ningún request — validación de cliente', async ({ page }) => {
    const { rutasPage, contadorConfirmarRuta } = await armarPagina(page);

    await rutasPage.goto();
    // Sin agregar ningún pedido a la ruta.
    await rutasPage.rutaChofer.selectOption(CHOFER_ID);

    await rutasPage.btnConfirmarRuta.click();

    await rutasPage.esperarToastExito('Agregá al menos un pedido a la ruta');
    await expect(rutasPage.dialogoConfirmar).not.toBeVisible();
    expect(contadorConfirmarRuta()).toBe(0);
  });

  test('rechazo del servidor al crear la ruta muestra el error y no pierde la ruta armada', async ({ page }) => {
    const { rutasPage } = await armarPagina(page);

    // FIX (v1054 → v1055): el error ya no se fuerza pisando el INSERT de
    // `rutas` (esa request no existe más en este flujo) — hay que pisar
    // la RPC misma. Un status no-2xx hace que supabase-js resuelva
    // `rpcErr` con verdad, así que `confirmarRuta()` toma el mismo camino
    // (`if (rpcErr) throw rpcErr`) que un error real de red/servidor —
    // registrado DESPUÉS de armarPagina(), gana por orden (mismo criterio
    // que compras.spec.js).
    await page.route('**/rest/v1/rpc/rpc_confirmar_ruta**', async (route) => {
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
    // camino feliz, después de que la RPC resuelve OK.
    await expect(rutasPage.dropEmpty).not.toBeVisible();
    await expect(rutasPage.statPedidos).toHaveText('1');
    await expect(rutasPage.rutaChofer).toHaveValue(CHOFER_ID);
  });
});
