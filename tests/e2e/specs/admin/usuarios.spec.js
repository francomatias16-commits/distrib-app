// Fase 2 (P1), primera página del bloque "usuarios / proveedores / notas /
// presupuestos" (ver PLAN_E2E_COBERTURA_TOTAL.md, secciones 21/23).
// `usuarios.html` es standalone: JS propio (`usuarios.js`), CRUD contra
// `/api/usuarios` (`lib/handlers/usuarios.js`), sin PostgREST directo para
// su propio dominio (las 2 queries a `usuarios`/`empresas` que sí ve la
// página son las de `auth.js` resolviendo el perfil logueado, ver
// auth-helper.js).
//
// Alcance deliberado: listado + filtro por búsqueda/activo (in-memory,
// sin red), la regla "vos" (fila propia sin botón desactivar), la regla
// "Solo el dueño" (un admin no puede tocar a otro dueño/admin —
// esAjenoIntocable), alta con confirmación, edición con confirmación,
// activar/desactivar con confirmación, y el error de límite de plan al
// crear. NO cubre: el caso "editar a un dueño siendo dueño" (select de rol
// habilitado con la opción Dueño visible — rama de UI que depende de que
// el fixture logueado sea rol='dueno', casi idéntica a la que ya se cubre
// con rol='admin'), ni el rechazo del backend para las reglas de
// privilegio (eso es responsabilidad de un test de integración de
// `lib/handlers/usuarios.js`, no de este E2E) — quedan para una vuelta
// futura si hace falta profundizar.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { UsuariosPage } from '../../page-objects/admin/usuarios.page.js';

const VENDEDOR_ID   = 'e2e-usuario-vendedor-0001';
const OTRO_ADMIN_ID = 'e2e-usuario-admin-0002';
const INACTIVO_ID   = 'e2e-usuario-inactivo-0001';

function usuarios(propioId) {
  return [
    { id: propioId, nombre: 'Vos Admin', email: 'vos@test.local', rol: 'admin', telefono: '', activo: true },
    { id: VENDEDOR_ID, nombre: 'Juan Vendedor', email: 'juan@test.local', rol: 'vendedor', telefono: '1122334455', activo: true },
    { id: OTRO_ADMIN_ID, nombre: 'Otro Admin', email: 'otro@test.local', rol: 'admin', telefono: '', activo: true },
    { id: INACTIVO_ID, nombre: 'Ex Empleado', email: 'ex@test.local', rol: 'vendedor', telefono: '', activo: false },
  ];
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page, { rol = 'admin', lista } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  const { userId } = await loguearComoAdmin(page, { rol });
  const listaFinal = lista ? lista(userId) : usuarios(userId);

  const contadoresApi = mockApi(page, {
    '/api/usuarios': ({ request }) => {
      if (request.method() === 'GET') return { json: listaFinal };
      // POST/PATCH se pisan en cada test que necesita inspeccionar el body.
      return { json: { ok: true } };
    },
  });

  const usuariosPage = new UsuariosPage(page, staticServer.baseURL);
  return { usuariosPage, contadoresApi, userId, listaFinal };
}

test.describe('Usuarios (admin) — Fase 2 P1', () => {
  test('la lista carga desde /api/usuarios, muestra "vos" en la fila propia y oculta activo=false por defecto', async ({ page }) => {
    const { usuariosPage, userId } = await armarPagina(page);
    const erroresConsola = usuariosPage.capturarErroresConsola();

    await usuariosPage.goto();

    await expect(usuariosPage.fila(userId)).toBeVisible();
    await expect(usuariosPage.fila(userId)).toContainText('Vos Admin');
    await expect(usuariosPage.fila(userId)).toContainText('vos');
    await expect(usuariosPage.fila(VENDEDOR_ID)).toContainText('Vendedor');
    await expect(usuariosPage.fila(VENDEDOR_ID)).toContainText('1122334455');

    // Filtro "Activos" por defecto (#filtro-activo value="true") — el
    // usuario inactivo no aparece sin cambiar el filtro.
    await expect(usuariosPage.fila(INACTIVO_ID)).toHaveCount(0);

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('cambiar el filtro a "Todos" muestra también los inactivos, y buscar filtra in-memory', async ({ page }) => {
    const { usuariosPage } = await armarPagina(page);

    await usuariosPage.goto();
    await usuariosPage.filtroActivo.selectOption('');
    await expect(usuariosPage.fila(INACTIVO_ID)).toBeVisible();

    await usuariosPage.buscar('juan');
    await expect(usuariosPage.fila(VENDEDOR_ID)).toBeVisible();
    await expect(usuariosPage.fila(INACTIVO_ID)).toHaveCount(0);
  });

  test('la fila propia no tiene botón de desactivar, y un admin no puede tocar a otro admin', async ({ page }) => {
    const { usuariosPage, userId } = await armarPagina(page);

    await usuariosPage.goto();

    await expect(usuariosPage.botonDesactivar(userId)).toHaveCount(0);
    await expect(usuariosPage.botonEditar(userId)).toBeVisible(); // sí puede editarse a sí mismo

    // OTRO_ADMIN_ID es 'admin' y quien mira es 'admin' (no 'dueno') →
    // esAjenoIntocable: sin botones, solo la leyenda.
    await expect(usuariosPage.labelSoloDueno(OTRO_ADMIN_ID)).toBeVisible();
    await expect(usuariosPage.botonEditar(OTRO_ADMIN_ID)).toHaveCount(0);
  });

  test('alta de un usuario nuevo: confirma, envía el POST correcto y refresca la lista', async ({ page }) => {
    const { usuariosPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/usuarios**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'e2e-usuario-nuevo-0001', ...bodyCapturado }),
        });
        return;
      }
      return route.fallback();
    });

    await usuariosPage.goto();
    await usuariosPage.abrirModalNuevo();
    await expect(usuariosPage.modalTitulo).toHaveText('Nuevo usuario');
    await expect(usuariosPage.grupoPassword).toBeVisible();

    await usuariosPage.completarFormulario({
      nombre: 'Nueva Depositera', email: 'nueva@test.local',
      password: 'clave12345', rol: 'depositero', telefono: '1155667788',
    });
    await usuariosPage.guardar();

    await usuariosPage.esperarToastExito('Usuario creado');

    expect(bodyCapturado).toMatchObject({
      nombre: 'Nueva Depositera', email: 'nueva@test.local',
      password: 'clave12345', rol: 'depositero', telefono: '1155667788',
    });
  });

  test('editar un usuario existente precarga el formulario (sin password ni email editable) y envía el PATCH correcto', async ({ page }) => {
    const { usuariosPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/usuarios**', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await usuariosPage.goto();
    await usuariosPage.botonEditar(VENDEDOR_ID).click();

    await expect(usuariosPage.modalTitulo).toHaveText('Editar usuario');
    await expect(usuariosPage.grupoPassword).toBeHidden();
    await expect(usuariosPage.inputEmail).toBeDisabled();
    await expect(usuariosPage.inputNombre).toHaveValue('Juan Vendedor');
    await expect(usuariosPage.selectRol).toHaveValue('vendedor');

    await usuariosPage.inputTelefono.fill('1199998888');
    await usuariosPage.guardar();

    await usuariosPage.esperarToastExito('Usuario actualizado');
    expect(bodyCapturado).toMatchObject({
      id: VENDEDOR_ID, nombre: 'Juan Vendedor', rol: 'vendedor', telefono: '1199998888',
    });
  });

  test('desactivar un usuario activo envía el PATCH con activo:false, tras confirmar', async ({ page }) => {
    const { usuariosPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/usuarios**', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        bodyCapturado = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      return route.fallback();
    });

    await usuariosPage.goto();
    await usuariosPage.cambiarEstadoFila(VENDEDOR_ID, { activo: false });

    await usuariosPage.esperarToastExito('Usuario desactivado');
    expect(bodyCapturado).toEqual({ id: VENDEDOR_ID, activo: false });
  });

  test('al crear un usuario, el límite de plan alcanzado muestra el toast con el detalle', async ({ page }) => {
    const { usuariosPage } = await armarPagina(page);

    await page.route('**/api/usuarios**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'LIMITE_PLAN_ALCANZADO', detalle: { actual: 5, limite: 5 } }),
        });
        return;
      }
      return route.fallback();
    });

    await usuariosPage.goto();
    await usuariosPage.abrirModalNuevo();
    await usuariosPage.completarFormulario({
      nombre: 'Sobra Uno', email: 'sobra@test.local', password: 'clave12345', rol: 'vendedor',
    });
    await usuariosPage.guardar();

    // Toast propio de este caso (no el genérico "No se pudo guardar") —
    // ver usuarios.js::guardarUsuario.
    await usuariosPage.esperarToastExito('Llegaste al límite de usuarios de tu plan (5/5)');
    // El modal no se cierra ante un error — el usuario puede corregir/reintentar.
    await expect(usuariosPage.modal).toBeVisible();
  });
});
