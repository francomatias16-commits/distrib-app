// frontend/admin/js/productos/render-tabla.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Render de la tabla de productos: loading, avatar/zoom de foto, filas, paginación.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

/* ── Render tabla ── */
function mostrarCargando() {
  const tbody = document.getElementById('prod-tbody');
  if (!tbody) return;
  tbody.innerHTML = `
    <tr>
      <td colspan="11" class="prod-empty">
        <div class="prod-empty-spinner"></div>
        Cargando productos…
      </td>
    </tr>
  `;
}

/* Avatar de la fila (v392): si el producto tiene foto real la muestra en vez
   de las iniciales. Si falla la carga de la imagen (URL rota, bucket
   borrado), cae de nuevo a las iniciales via onerror.
   (v730: se sacó el punto de color que indicaba el origen de la foto —
   quedaba como ruido visual sin uso real; el origen se sigue pudiendo
   filtrar desde el combo "Foto real" del header. Se agrega click para
   hacer zoom a la imagen en grande, vía abrirZoomFoto().) */
function renderAvatarFoto(p, pal, ini) {
  if (!p.fotoUrl) {
    return `<span class="prod-avatar" style="${pal}">${escHtml(ini)}</span>`;
  }
  const iniEsc = escHtml(ini);
  const urlEsc = escHtml(p.fotoUrl);
  return `
    <span class="prod-avatar-wrap">
      <img class="prod-avatar prod-avatar--foto" src="${urlEsc}" alt="Foto de ${escHtml(p.nombre)}"
           loading="lazy" tabindex="0" role="button"
           title="Ver imagen en grande"
           aria-label="Ver imagen en grande de ${escHtml(p.nombre)}"
           onclick="event.stopPropagation(); abrirZoomFoto('${urlEsc}')"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();abrirZoomFoto('${urlEsc}');}"
           onerror="this.outerHTML='<span class=&quot;prod-avatar&quot; style=&quot;${pal}&quot;>${iniEsc}</span>'">
    </span>`;
}

/* v730: lightbox simple para ver en grande la foto de un producto — se
   engancha tanto desde la miniatura de la fila (renderAvatarFoto) como
   desde la preview del formulario de editar/crear (ver productos.html). */
function abrirZoomFoto(url) {
  if (!url) return;
  const backdrop = document.getElementById('foto-zoom-backdrop');
  const modal    = document.getElementById('foto-zoom-modal');
  const img      = document.getElementById('foto-zoom-img');
  if (!backdrop || !modal || !img) return;
  img.src = url;
  backdrop.classList.add('activo');
  modal.classList.add('activo');
  document.addEventListener('keydown', _escCerrarZoomFoto);
}

function cerrarZoomFoto() {
  const backdrop = document.getElementById('foto-zoom-backdrop');
  const modal    = document.getElementById('foto-zoom-modal');
  const img      = document.getElementById('foto-zoom-img');
  if (backdrop) backdrop.classList.remove('activo');
  if (modal) modal.classList.remove('activo');
  if (img) img.src = '';
  document.removeEventListener('keydown', _escCerrarZoomFoto);
}

function _escCerrarZoomFoto(ev) {
  if (ev.key === 'Escape') cerrarZoomFoto();
}

function renderTabla() {
  const tbody = document.getElementById('prod-tbody');
  if (!tbody) return;

  if (!productosPage.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="prod-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-light,#6B695F)" stroke-width="1.5" style="margin-bottom:8px">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
          </svg>
          <div>No se encontraron productos con los filtros actuales.</div>
          <button onclick="limpiarFiltros()" class="prod-pill-btn" style="margin-top:8px">Limpiar filtros</button>
        </td>
      </tr>
    `;
    const pw = document.getElementById('prod-pag-wrap');
    if (pw) pw.style.display = 'none';
    return;
  }

  // La página ya viene resuelta por fn_productos_lista (LIMIT/OFFSET en SQL).
  tbody.innerHTML = productosPage.map(p => {
    const pal = getPaleta(p.cat);
    const ini = iniciales(p.nombre);

    return `
      <tr data-id="${p.id}" class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalProducto('${p.id}')">
        <td onclick="event.stopPropagation()">
          <input type="checkbox" class="prod-chk-fila" data-id="${p.id}"
                 aria-label="Seleccionar ${escHtml(p.nombre)} para etiquetas"
                 ${seleccionEtiquetas.has(p.id) ? 'checked' : ''}
                 onchange="toggleSeleccionProducto('${p.id}', this.checked)" />
        </td>
        <td data-label="Nombre">
          <div class="prod-nombre-cell">
            ${renderAvatarFoto(p, pal, ini)}
            <span class="prod-nombre-text" title="${escHtml(p.nombre)}">${escHtml(p.nombre)}</span>
            ${p.destacado ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color:var(--color-warning, #b8860b);flex-shrink:0" aria-label="Destacado"><title>Destacado</title><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>` : ''}
          </div>
        </td>
        <td class="prod-cat-cell" data-label="Categoría">${escHtml(p.cat)}</td>
        <td data-label="Estado">${estadoBadge(p.estado)}</td>
        <td class="prod-fecha" data-label="Última Act.">${escHtml(formatFecha(p.fechaAct))}</td>
        <td class="prod-precio" data-label="Precio">${escHtml(formatPeso(p.precio))}</td>
        <td class="prod-costo" data-label="Costo">${escHtml(formatPeso(p.costo))}</td>
        <td class="prod-stock ${p.stock === 0 ? 'prod-stock-cero' : ''}" data-label="Stock">${escHtml(String(p.stock))}u</td>
        <td data-label="Margen">
          <div class="prod-donut-wrap" title="Margen: ${p.margen}%">
            ${donutSVG(p.margen)}
          </div>
        </td>
        <td class="col-sticky-end" data-label="Acciones">
          <button class="prod-menu-btn" aria-label="Más acciones para ${escHtml(p.nombre)}"
                  onclick="abrirMenuAcciones(event, '${p.id}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <circle cx="12" cy="5"  r="1.2" fill="currentColor"/>
              <circle cx="12" cy="12" r="1.2" fill="currentColor"/>
              <circle cx="12" cy="19" r="1.2" fill="currentColor"/>
            </svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  actualizarPaginacion();
  sincronizarCheckTodos();
  actualizarBarraEtiquetas();
}

/* ── Paginación (basada en totalCount, que viene de count(*) OVER() del RPC) ── */
function actualizarPaginacion() {
  const paginas = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pw      = document.getElementById('prod-pag-wrap');
  const info    = document.getElementById('prod-pag-info');
  const ant     = document.getElementById('prod-btn-ant');
  const sig     = document.getElementById('prod-btn-sig');

  if (!pw) return;
  pw.style.display = paginas > 1 ? 'flex' : 'none';
  if (info) info.textContent = `Página ${_page} de ${paginas} (${totalCount} productos)`;
  if (ant)  ant.disabled = _page <= 1;
  if (sig)  sig.disabled = _page >= paginas;
}

function irPagina(n) {
  const paginas = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  _page = Math.max(1, Math.min(n, paginas));
  cargarProductos().then(() => {
    // Scroll suave al top de la tabla
    const tw = document.querySelector('.prod-tabla-wrap');
    if (tw) tw.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
