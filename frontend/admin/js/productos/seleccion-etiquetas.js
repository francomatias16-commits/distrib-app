// frontend/admin/js/productos/seleccion-etiquetas.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Selección múltiple de productos y barra flotante "Generar etiquetas" (543, Etapa 2).
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

/* ── Selección múltiple + barra flotante "Generar etiquetas" (543, Etapa 2) ── */

function toggleSeleccionProducto(id, marcado) {
  if (marcado) seleccionEtiquetas.add(id);
  else seleccionEtiquetas.delete(id);
  sincronizarCheckTodos();
  actualizarBarraEtiquetas();
}

// Tilda/destilda solo los productos VISIBLES en la página actual — el resto
// de la selección (otras páginas) no se toca.
function toggleSeleccionTodos(marcado) {
  productosPage.forEach(p => {
    if (marcado) seleccionEtiquetas.add(p.id);
    else seleccionEtiquetas.delete(p.id);
  });
  document.querySelectorAll('.prod-chk-fila').forEach(chk => { chk.checked = marcado; });
  actualizarBarraEtiquetas();
}

// El checkbox "seleccionar todos" refleja el estado de la página actual:
// tildado si TODOS los productos visibles están seleccionados.
function sincronizarCheckTodos() {
  const todos = document.getElementById('prod-chk-todos');
  if (!todos || !productosPage.length) return;
  todos.checked = productosPage.every(p => seleccionEtiquetas.has(p.id));
}

// v979 — antes la única forma de sumar productos a la selección era tildar
// fila por fila (toggleSeleccionTodos solo tilda lo VISIBLE en la página
// actual, ver comentario arriba). Cuando hay más de una página de resultados
// y la página actual ya está 100% tildada, se ofrece este link para traer
// TODOS los ids del filtro activo (no solo esta página) de una sola vez,
// sin tener que ir página por página tildando "seleccionar todos" cada vez.
function actualizarBarraEtiquetas() {
  let barra = document.getElementById('prod-barra-etiquetas');
  const n = seleccionEtiquetas.size;

  if (!n) {
    if (barra) barra.remove();
    return;
  }

  if (!barra) {
    barra = document.createElement('div');
    barra.id = 'prod-barra-etiquetas';
    barra.className = 'prod-barra-etiquetas';
    document.body.appendChild(barra);
  }

  // Solo tiene sentido ofrecer "traer el resto" si: hay más resultados que
  // los que ya están seleccionados, y la página visible ya está completa
  // (si todavía queda algo sin tildar en esta página, tildar lo que falta
  // ahí es el paso obvio, no hace falta el atajo todavía).
  const quedanMasPaginas = totalCount > n && productosPage.length > 0 &&
    productosPage.every(p => seleccionEtiquetas.has(p.id));
  const linkTodos = quedanMasPaginas
    ? `<button type="button" class="prod-link-seleccionar-todos" onclick="seleccionarTodosLosResultados()"
               ${seleccionandoTodosResultados ? 'disabled' : ''}>
         ${seleccionandoTodosResultados ? 'Trayendo productos…' : `Seleccionar los ${totalCount} resultados`}
       </button>`
    : '';

  barra.innerHTML = `
    <span class="prod-barra-etiquetas-count">${n} producto${n === 1 ? '' : 's'} seleccionado${n === 1 ? '' : 's'}</span>
    ${linkTodos}
    <button type="button" class="btn-secundario" onclick="cancelarSeleccionEtiquetas()">Cancelar</button>
    <button type="button" class="btn btn--primary" onclick="abrirVistaPreviaEtiquetas()">Generar etiquetas</button>
  `;
}

// Trae TODOS los ids que matchean el filtro/búsqueda activos (no solo la
// página visible), reusando fn_productos_lista con los mismos parámetros
// que cargarProductos() pero con p_limit alto y p_offset 0 — mismo patrón
// ya usado (comentario de exportarProductos()) para el caso en que hace
// falta el resultado completo del filtro, no solo lo que se ve en pantalla.
async function seleccionarTodosLosResultados() {
  if (seleccionandoTodosResultados || !sb) return;
  if (totalCount > MAX_IDS_ETIQUETAS) {
    toast(`El filtro actual tiene ${totalCount} productos y el máximo por tanda es ${MAX_IDS_ETIQUETAS}. Achicá el filtro (por categoría, etiqueta o mes) y repetí en tandas.`, 'warning');
    return;
  }

  seleccionandoTodosResultados = true;
  actualizarBarraEtiquetas();
  try {
    const { data, error } = await window.conTimeoutRed(sb.rpc('fn_productos_lista', {
      p_busqueda:     busquedaTag.trim() || null,
      p_categoria_id: filtroCatId || null,
      p_estado:       filtroEstado || null,
      p_orden:        ordenCol,
      p_asc:          ordenAsc,
      p_limit:        MAX_IDS_ETIQUETAS,
      p_offset:       0,
      p_mes:          mesActivo === null ? null : mesActivo + 1,
      p_anio:         mesActivo === null ? null : yearActivo,
      p_foto_fuente:  filtroFoto || null,
      p_etiqueta_id:  filtroEtiquetaId || null,
    }), 10000);
    if (error) throw error;
    (data || []).forEach(p => seleccionEtiquetas.add(p.id));
    sincronizarCheckTodos();
    toast(`${seleccionEtiquetas.size} productos seleccionados.`, 'success');
  } catch (err) {
    console.error('[productos] Error seleccionando todos los resultados:', err);
    toast('No se pudieron traer todos los productos del filtro. Probá de nuevo.', 'error');
  } finally {
    seleccionandoTodosResultados = false;
    actualizarBarraEtiquetas();
  }
}

function cancelarSeleccionEtiquetas() {
  seleccionEtiquetas.clear();
  document.querySelectorAll('.prod-chk-fila').forEach(chk => { chk.checked = false; });
  sincronizarCheckTodos();
  actualizarBarraEtiquetas();
}

// La vista previa/impresión en sí (armar el modal, traer config+productos
// reales, imprimir) vive en etiquetas-preview.js (window.EtiquetasPreview)
// — se extrajo de acá en la Etapa 3 para que Compras la reutilice tal cual
// al ofrecer "Imprimir etiquetas de esta recepción", sin duplicar código.
async function abrirVistaPreviaEtiquetas() {
  const ids = Array.from(seleccionEtiquetas);
  if (!ids.length) return;
  // Sin precarga de copias (arrancan en 1) — a diferencia de Compras,
  // acá es selección manual del listado, no cantidades de una recepción.
  // onCerrar limpia checkboxes/barra flotante al cerrar o tras imprimir.
  await window.EtiquetasPreview.abrir(ids, null, cancelarSeleccionEtiquetas);
}

// v978 — entrada desde "Más funciones": si ya hay productos tildados (el
// usuario venía seleccionando y se acordó del menú), va directo a la vista
// previa. Si no hay nada tildado todavía, en vez de abrir un modal vacío
// hace scroll a la grilla y muestra el toast que indica el paso real
// (tildar filas → aparece la barra flotante con "Generar etiquetas"),
// para no duplicar el flujo de selección con uno nuevo.
function iniciarGenerarEtiquetasDesdeMenu() {
  if (seleccionEtiquetas.size) {
    abrirVistaPreviaEtiquetas();
    return;
  }
  const tw = document.querySelector('.prod-tabla-wrap');
  if (tw) tw.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.toast?.('Tildá los productos que querés etiquetar y tocá "Generar etiquetas" abajo.', 'default');
}
