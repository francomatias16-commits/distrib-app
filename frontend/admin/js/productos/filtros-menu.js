// frontend/admin/js/productos/filtros-menu.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Filtros de la tabla (categoría/estado/foto/etiqueta) y menús desplegables (más funciones, gestión de etiquetas).
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

/* ── Filtros ──────────────────────────────────────────────────────────────
   Auditoría filtros v280: ya no hay un array completo en memoria para
   filtrar/ordenar/paginar client-side. Cualquier cambio de filtro, orden o
   página vuelve a página 1 (si corresponde) y dispara cargarProductos(),
   que le pasa el estado actual a fn_productos_lista(). ─────────────────── */
function poblarFiltrosCategorias() {
  const sel = document.getElementById('prod-filtro-cat');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Todas las categorías</option>' +
    categoriasAll.map(c => `<option value="${c.id}" ${c.id === current ? 'selected' : ''}>${escHtml(c.nombre)}</option>`).join('');
}

function recargarConFiltro() {
  _page = 1;
  cargarProductos();
}

function limpiarFiltros() {
  busquedaTag  = '';
  filtroEstado = '';
  filtroCatId  = '';
  filtroFoto   = '';
  filtroEtiquetaId = '';
  const ti = document.getElementById('prod-tag-input');
  if (ti) ti.value = '';
  const se = document.getElementById('prod-filtro-estado');
  if (se) se.value = '';
  const sc = document.getElementById('prod-filtro-cat');
  if (sc) sc.value = '';
  const sf = document.getElementById('prod-filtro-foto');
  if (sf) sf.value = '';
  const set = document.getElementById('prod-filtro-etiqueta');
  if (set) set.value = '';
  recargarConFiltro();
}

// FIX v481 — menú "Más funciones" (Importar / Exportar / Buscar imágenes),
// agrupadas para que dejen de estar sueltas y poco visibles en el topbar y
// en la fila de filtros.
function toggleMenuMasFunciones(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('menu-mas-funciones');
  const btn  = document.getElementById('btn-mas-funciones');
  if (!menu || !btn) return;
  const abrir = menu.hidden;
  menu.hidden = !abrir;
  btn.setAttribute('aria-expanded', String(abrir));
}

function cerrarMenuMasFunciones() {
  const menu = document.getElementById('menu-mas-funciones');
  const btn  = document.getElementById('btn-mas-funciones');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Cerrar al hacer clic afuera o con Escape — mismo patrón que cualquier
// dropdown de la app (ver nav-mobile.js / búsqueda global).
document.addEventListener('click', (ev) => {
  const wrap = document.querySelector('.topbar-more-wrap');
  if (wrap && !wrap.contains(ev.target)) cerrarMenuMasFunciones();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') cerrarMenuMasFunciones();
});

// Popover "Gestionar etiquetas" (crear/renombrar/recolorear/eliminar
// etiquetas del catálogo), colgado del filtro de etiquetas — mismo patrón
// de apertura/cierre que "Más funciones" arriba.
function toggleGestionEtiquetas(ev) {
  if (ev) ev.stopPropagation();
  const pop = document.getElementById('popover-gestion-etiquetas');
  if (!pop) return;
  const abrir = pop.hidden;
  pop.hidden = !abrir;
  if (abrir && window.Etiquetas) {
    Etiquetas.renderGestion('gestion-etiquetas-body', {
      onCambio: async () => {
        // Después de crear/renombrar/recolorear/eliminar: refrescar el
        // <select> de filtro (puede haber cambiado nombre/color/desaparecido
        // la opción elegida) y, si justo se borró la etiqueta activa como
        // filtro, volver a "Todas las etiquetas".
        await Etiquetas.renderFiltroSelect('prod-filtro-etiqueta', { onCambio: onFiltroEtiqueta });
        const sel = document.getElementById('prod-filtro-etiqueta');
        if (sel && filtroEtiquetaId && !Array.from(sel.options).some(o => o.value === filtroEtiquetaId)) {
          filtroEtiquetaId = '';
          sel.value = '';
        }
        cargarContadores().catch(() => {});
        recargarConFiltro();
      },
    }).catch(err => console.warn('[productos] No se pudo abrir la gestión de etiquetas:', err?.message || err));
  }
}

function cerrarGestionEtiquetas() {
  const pop = document.getElementById('popover-gestion-etiquetas');
  if (pop) pop.hidden = true;
}

document.addEventListener('click', (ev) => {
  const wrap = document.querySelector('.prod-etiqueta-filtro-wrap');
  if (wrap && !wrap.contains(ev.target)) cerrarGestionEtiquetas();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') cerrarGestionEtiquetas();
});
