// Fase 1 (P0) — página `clientes`, siguiente en la cola después de
// `pedidos`, `pos` y `cobranzas` (ver PLAN_E2E_COBERTURA_TOTAL.md,
// sección 12: "Siguiente paso concreto: seguir con las 7 páginas P0
// restantes: stock, facturacion, cobranzas, clientes, cta-cte, compras,
// productos").
//
// A diferencia de `pos.js` (todo por /api/*) y de `pedidos.js` (listado
// por RPC), `clientes.js` arma su listado principal con PostgREST directo
// (`sb.from('clientes').select(..., {count:'exact'})`, con `zonas`,
// `listas_precios` y `scores_cliente` embebidos) — un tercer shape más
// dentro del mismo patrón de 3 capas de red del hallazgo 10.1.
//
// Alcance deliberado de este primer spec, igual criterio que
// pedidos.spec.js: solo lectura (listado + abrir ficha de un cliente).
// El flujo de "crear/editar cliente" (submit del form) queda para la
// siguiente vuelta.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { ClientesPage } from '../../page-objects/admin/clientes.page.js';

const CLIENTE_ID = 'e2e-cliente-000000000001';

const ZONA = { id: 'e2e-zona-1', nombre: 'Zona Norte' };
const LISTA_PRECIO = { id: 'e2e-lista-1', nombre: 'Lista Mayorista', es_default: false };

const CLIENTE = {
  id: CLIENTE_ID,
  razon_social: 'Almacén El Progreso SRL',
  nombre_fantasia: 'El Progreso',
  cuit: '30-22222222-2',
  condicion_iva: 'RI',
  telefono: '3482-555555',
  email: 'contacto@elprogreso.com.ar',
  domicilio: 'Av. San Martín 1234',
  localidad: 'Reconquista',
  zona_id: ZONA.id,
  notas: null,
  lista_precio_id: LISTA_PRECIO.id,
  dias_credito: 30,
  limite_credito: 100000,
  saldo_deuda: 25000,
  activo: true,
  lat: null,
  lng: null,
  vendedor_id_default: null,
  usuario_id: null,
  score_actual: 78,
  score_categoria: 'normal',
  // Shape real embebido por `.select('*, zonas(nombre), listas_precios(nombre), ...')`
  zonas: { nombre: ZONA.nombre },
  listas_precios: { nombre: LISTA_PRECIO.nombre },
  scores_cliente: [
    { score_pagos: 80, score_frecuencia: 75, score_deuda: 70, score_devolucion: 90, created_at: '2026-08-01T00:00:00Z' },
  ],
};

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

test.describe('Clientes (admin) — Fase 1 piloto', () => {
  test('la lista carga desde PostgREST y abrir la ficha de un cliente muestra sus datos correctos', async ({ page }) => {
    // Red de seguridad primero (ver 10.1) — mocks específicos registrados
    // después tienen prioridad (Playwright usa el último route que matchea).
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await vendorizarSupabase(page);

    await loguearComoAdmin(page);

    mockearTabla(page, 'clientes', { onSelect: () => [CLIENTE] });
    mockearTabla(page, 'zonas', { onSelect: () => [ZONA] });
    mockearTabla(page, 'listas_precios', { onSelect: () => [LISTA_PRECIO] });

    // Hallazgo real leyendo clientes-ciclos.js::cli_ciclos_render: espera
    // recibir `{ ciclos, sugerido, ultima_notif }` y hace `ciclos.length`
    // sin guard — el catch-all genérico de /api/* (mockearApiGenerico)
    // devuelve `[]` para cualquier GET, así que `data.ciclos` sería
    // `undefined` y esto tiraría un TypeError real en cli_ciclos_cargar()
    // (llamado automáticamente al abrir la ficha, vía abrirModalEditar).
    // Override puntual, registrado DESPUÉS del catch-all para que gane.
    await page.route('**/api/ciclos**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ ciclos: [], sugerido: null, ultima_notif: null }),
      });
    });

    const clientesPage = new ClientesPage(page, staticServer.baseURL);
    const erroresConsola = clientesPage.capturarErroresConsola();

    await clientesPage.goto();

    // La fila real del cliente mockeado está en el DOM (no solo "la
    // tabla tiene contenido" — el id concreto).
    await expect(clientesPage.fila(CLIENTE_ID)).toBeVisible();
    await expect(clientesPage.fila(CLIENTE_ID)).toContainText('El Progreso');
    await expect(clientesPage.fila(CLIENTE_ID)).toContainText('Zona Norte');

    // Click real sobre "Ver / Editar" — ejercita el onclick inline tal
    // como lo dispara un click de usuario de verdad.
    await clientesPage.abrirDetallePorId(CLIENTE_ID);

    await expect(clientesPage.modalTitulo).toContainText('El Progreso');
    await expect(clientesPage.modalSubtitulo).toContainText('30-22222222-2');

    // Form poblado con los datos reales del cliente.
    await expect(clientesPage.campoForm('razon_social')).toHaveValue('Almacén El Progreso SRL');
    await expect(clientesPage.campoForm('cuit')).toHaveValue('30-22222222-2');
    await expect(clientesPage.campoForm('zona_id')).toHaveValue(ZONA.id);
    await expect(clientesPage.campoForm('lista_precio_id')).toHaveValue(LISTA_PRECIO.id);
    await expect(clientesPage.campoForm('dias_credito')).toHaveValue('30');

    // Resumen de crédito — clientes.js tiene su PROPIO formatPeso() (Intl.NumberFormat
    // es-AR/ARS), distinto al de cobranzas.js (concatenación manual '$'+toLocaleString):
    // acá el símbolo va separado del número por un espacio (no-breaking space real).
    // Se chequea solo la parte numérica para no depender de ese carácter.
    await expect(clientesPage.creditoGrid).toContainText('25.000,00'); // saldo deuda
    await expect(clientesPage.creditoGrid).toContainText('100.000,00'); // límite crédito
    await expect(clientesPage.creditoGrid).toContainText('Lista Mayorista');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });
});
