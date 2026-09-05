// Fase 1 (P0), segunda página — pos.html. A diferencia de pedidos.js,
// pos.js no pega a PostgREST directo: todo pasa por `/api/pos/*` (ver
// pos.page.js). Sí carga Dexie desde CDN externo igual que el subsistema
// offline (pos-offline.js) — se vendoriza acá también para no depender
// de `cdn.jsdelivr.net` ni arrastrar errores de consola ajenos al flujo
// bajo test (ver hallazgo 11.3 del plan sobre este mismo CDN).
//
// Cobertura de este spec (carga inicial + alta + edición + borrado +
// validación + error de servidor, según sección 7 del plan):
//   1. Carga inicial: pantalla de turno, combo de cajas poblado.
//   2. Validación: abrir turno sin elegir caja → error de cliente, sin request.
//   3. Alta: abrir turno → buscar producto → cobrar → ticket de venta.
//   4. Edición: cambiar la cantidad de un ítem del carrito recalcula el total.
//   5. Borrado: quitar un ítem dejá el carrito vacío y el botón Cobrar deshabilitado.
//   6. Validación: cobrar con menos plata de la que corresponde → error, modal sigue abierto.
//   7. Error de servidor: el backend rechaza la venta (409) → error visible, carrito intacto.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarDexie, vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { PosPage } from '../../page-objects/admin/pos.page.js';

const CAJAS = [{ id: 'caja-1', nombre: 'Caja Principal' }];

const PRODUCTO = {
  id: 'prod-1', nombre: 'Coca Cola 500ml', codigo: '7791234567890',
  unidad: 'un', precio: 1000, stock_disponible: 50, iva: 21,
};

// Handlers base compartidos por (casi) todos los tests: catálogo de cajas,
// sin turnos abiertos previos, config de hardware neutra y sin favoritos.
// `/api/pos` (el POST de venta) se registra ACÁ primero y cada test que lo
// necesita lo pisa con su propio handler más específico — mockApi respeta
// orden de registro de Playwright (último registrado, primero evaluado),
// así que un handler agregado después de este objeto siempre gana.
function handlersBase(overrides = {}) {
  return {
    '/api/pos': overrides.venta || (() => ({ json: { ok: true, venta_id: 'venta-1', numero: '0001' } })),
    '/api/pos/cajas': overrides.cajas || (() => ({ json: CAJAS })),
    '/api/pos/caja-estado': () => ({ json: { turnos: [] } }),
    '/api/pos/config-hardware': () => ({ json: {} }),
    '/api/pos/favoritos': () => ({ json: [] }),
    '/api/pos/productos': overrides.productos || (() => ({ json: [PRODUCTO] })),
    '/api/pos/abrir-turno': overrides.abrirTurno || ((call) => {
      const body = call.request.postDataJSON();
      return { json: { id: 'turno-1', caja_id: body.caja_id, monto_inicial: body.monto_inicial } };
    }),
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function abrirPos(page, overrides) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarDexie(page);
  await vendorizarSupabase(page);
  await loguearComoAdmin(page);
  mockApi(page, handlersBase(overrides));

  const pos = new PosPage(page, staticServer.baseURL);
  const erroresConsola = pos.capturarErroresConsola();
  await pos.goto();
  return { pos, erroresConsola };
}

test.describe('POS (admin) — Fase 1', () => {

  test('carga inicial: pantalla de turno con el combo de cajas poblado', async ({ page }) => {
    const { pos, erroresConsola } = await abrirPos(page);

    await expect(pos.pantallaTurno).toBeVisible();
    await expect(pos.pantallaVenta).toBeHidden();
    await expect(pos.selectCaja.locator('option')).toHaveText(['Caja Principal']);

    // Ruido de red del sandbox (CDNs bloqueados, WebSocket de Realtime
    // contra el proyecto real) — no es un bug de la app, ver
    // filtrarRuidoRed() en mock-network.js.
    const erroresReales = filtrarRuidoRed(erroresConsola);
    expect(erroresReales, `Errores de consola:\n${erroresReales.join('\n')}`).toEqual([]);
  });

  test('validación: abrir turno sin elegir caja no manda request y muestra error', async ({ page }) => {
    let llamadasAbrirTurno = 0;
    // Sin cajas configuradas, `cargarCajas()` renderiza
    // `<option value="">No hay cajas configuradas</option>` (ver
    // pos.js) — es el único caso real en que el combo queda en value
    // vacío y se puede ejercitar la validación de pos.js sin elegir nada.
    const { pos } = await abrirPos(page, {
      cajas: () => ({ json: [] }),
      abrirTurno: () => { llamadasAbrirTurno++; return { json: {} }; },
    });

    await expect(pos.selectCaja.locator('option')).toHaveText(['No hay cajas configuradas']);
    await pos.btnAbrirTurno.click();

    await expect(pos.turnoError).toBeVisible();
    await expect(pos.turnoError).toContainText('Elegí una caja primero');
    expect(llamadasAbrirTurno).toBe(0);
  });

  test('alta: abrir turno, agregar un producto por código y cobrar en efectivo emite el ticket', async ({ page }) => {
    let bodyVenta = null;
    const { pos, erroresConsola } = await abrirPos(page, {
      venta: (call) => { bodyVenta = call.request.postDataJSON(); return { json: { ok: true, venta_id: 'venta-1', numero: '0001' } }; },
    });

    await pos.abrirTurno({ caja: 'caja-1', montoInicial: 0 });
    await expect(pos.pantallaVenta).toBeVisible();

    // Un solo resultado + Enter → se agrega directo al carrito (ver
    // pos.js::buscarProductos, rama `porEnter && resultados.length === 1`).
    await pos.agregarProductoPorEnter(PRODUCTO.codigo);
    await expect(pos.filaCarrito(PRODUCTO.id)).toBeVisible();
    await expect(pos.filaCarrito(PRODUCTO.id)).toContainText('Coca Cola 500ml');
    await expect(pos.totalCarrito).toContainText('1.210'); // 1000 + 21% IVA

    await pos.abrirModalCobro();
    await expect(pos.modalCobroTotal).toContainText('1.210');
    // La primera línea de pago viene precargada con el total exacto pero
    // con medio 'qr' por default (ver cliente-cobro.js::abrirModalCobro).
    // Cualquier medio tarjeta/qr pasa por PosTerminal.cobrarConTerminal(),
    // que con el driver 'manual' (default de config-hardware) abre un
    // diálogo real y espera a que alguien confirme/rechace — sin esto el
    // test queda esperando un click que nunca llega. Como acá queremos
    // testear el camino de efectivo (no terminal), lo seleccionamos.
    await pos.setMedioPrimeraLineaPago('efectivo');
    await pos.confirmarCobro();

    await expect(pos.modalTicketOverlay).toBeVisible();
    await expect(pos.ticketNumero).toContainText('0001');
    expect(bodyVenta).toMatchObject({
      caja_id: 'caja-1',
      turno_id: 'turno-1',
      items: [{ producto_id: PRODUCTO.id, cantidad: 1 }],
    });
    // v(actual): cliente-cobro.js manda también `codigo` (payment_id del
    // gateway MP/Prisma, ver comentario junto al .map de pagos) para poder
    // reconciliar/reversar contra el proveedor a futuro — antes se
    // capturaba y se perdía. En efectivo no hay gateway, así que viaja null.
    expect(bodyVenta.pagos).toEqual([{ medio: 'efectivo', monto: 1210, referencia: null, codigo: null }]);

    // El carrito se vacía después de una venta exitosa.
    await expect(pos.filasCarrito).toHaveCount(0);
  });

  test('edición: cambiar la cantidad de un ítem recalcula el total del carrito', async ({ page }) => {
    const { pos } = await abrirPos(page);
    await pos.abrirTurno({ caja: 'caja-1', montoInicial: 0 });
    await pos.agregarProductoPorEnter(PRODUCTO.codigo);
    await expect(pos.totalCarrito).toContainText('1.210');

    await pos.cambiarCantidad(PRODUCTO.id, 2);

    await expect(pos.totalCarrito).toContainText('2.420'); // 2000 + 21% IVA
  });

  test('borrado: quitar el único ítem deja el carrito vacío y Cobrar deshabilitado', async ({ page }) => {
    const { pos } = await abrirPos(page);
    await pos.abrirTurno({ caja: 'caja-1', montoInicial: 0 });
    await pos.agregarProductoPorEnter(PRODUCTO.codigo);
    await expect(pos.filaCarrito(PRODUCTO.id)).toBeVisible();

    await pos.quitarDelCarrito(PRODUCTO.id);

    await expect(pos.filasCarrito).toHaveCount(0);
    await expect(pos.btnCobrar).toBeDisabled();
  });

  test('validación: cobrar con menos plata de la que corresponde muestra error y no cierra el modal', async ({ page }) => {
    let llamadasVenta = 0;
    const { pos } = await abrirPos(page, {
      venta: () => { llamadasVenta++; return { json: { ok: true } }; },
    });
    await pos.abrirTurno({ caja: 'caja-1', montoInicial: 0 });
    await pos.agregarProductoPorEnter(PRODUCTO.codigo);

    await pos.abrirModalCobro();
    await pos.setMontoPrimeraLineaPago(500); // total real es 1210
    await pos.confirmarCobro();

    await expect(pos.cobroError).toBeVisible();
    await expect(pos.cobroError).toContainText('no alcanza el total');
    await expect(pos.modalCobroOverlay).toBeVisible();
    expect(llamadasVenta).toBe(0);
  });

  test('error de servidor: el backend rechaza la venta y el carrito no se pierde', async ({ page }) => {
    const { pos } = await abrirPos(page, {
      venta: () => ({ status: 409, json: { error: 'Sin stock suficiente de Coca Cola 500ml' } }),
    });
    await pos.abrirTurno({ caja: 'caja-1', montoInicial: 0 });
    await pos.agregarProductoPorEnter(PRODUCTO.codigo);

    await pos.abrirModalCobro();
    // Ver nota en el test de "alta": el medio por default es 'qr', que
    // dispara PosTerminal.cobrarConTerminal() y cuelga el test esperando
    // un diálogo manual que nadie confirma. Vamos por efectivo, que es
    // la rama que este test realmente quiere ejercitar (la venta llega
    // al backend y éste la rechaza).
    await pos.setMedioPrimeraLineaPago('efectivo');
    await pos.confirmarCobro(); // la línea precargada ya cierra el total exacto

    await expect(pos.cobroError).toBeVisible();
    await expect(pos.cobroError).toContainText('Sin stock suficiente');
    await expect(pos.modalTicketOverlay).toBeHidden();
    // La venta no se confirmó — el carrito sigue con el ítem, no se vació.
    await expect(pos.filaCarrito(PRODUCTO.id)).toBeVisible();
  });
});
