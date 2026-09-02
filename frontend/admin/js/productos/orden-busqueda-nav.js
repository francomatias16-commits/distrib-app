// frontend/admin/js/productos/orden-busqueda-nav.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Ordenamiento de columnas, total label, contador de topbar, alertas de stock, navegación de meses, búsqueda/escáner, menú de acciones por fila.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

/* ── Ordenamiento ── */
function ordenarPor(col) {
  if (ordenCol === col) {
    ordenAsc = !ordenAsc;
  } else {
    ordenCol = col;
    ordenAsc = true;
  }
  actualizarIconosOrden();
  recargarConFiltro();
}

function actualizarIconosOrden() {
  ['nombre', 'fechaAct', 'precio', 'stock'].forEach(col => {
    const el = document.getElementById(`sort-${col}`);
    if (!el) return;
    if (col === ordenCol) {
      el.textContent = ordenAsc ? ' ↑' : ' ↓';
    } else {
      el.textContent = '';
    }
  });
}

/* ── Total label ── */
function actualizarTotalLabel() {
  const el = document.getElementById('prod-total-label');
  if (!el) return;
  const filtroActivo = !!(busquedaTag.trim() || filtroEstado || filtroCatId || filtroFoto);
  if (filtroActivo) {
    el.textContent = `${totalCount} producto${totalCount === 1 ? '' : 's'} (filtrados)`;
  } else {
    el.textContent = `${totalCount} productos`;
  }
}

/* ── Topbar (usuario) ── */
function actualizarTopbarContador() {
  const uel = document.getElementById('topbar-usuario');
  if (uel && window.authCtx?.perfil?.nombre) {
    uel.textContent = window.authCtx.perfil.nombre;
  }
}

/* ── Alertas (contador global, viene de fn_productos_contadores) ── */
function actualizarAlertasStock() {
  const sinStock = contadores.total_sin_stock || 0;
  const el = document.getElementById('prod-alerta-link');
  if (!el) return;
  if (sinStock > 0) {
    el.textContent = `${sinStock} producto${sinStock > 1 ? 's' : ''} sin stock`;
    el.style.display = 'inline';
  } else {
    el.style.display = 'none';
  }
}



/* ── Navegación de meses ──────────────────────────────────────────────
   fix v544: recibe 'todos' o un número de mes (string desde dataset, o
   number). Compara contra btn.dataset.mes en vez de índice de posición
   en la NodeList, porque el tab "Todos" corrió el índice de los meses. */
function seleccionarMes(mes) {
  mesActivo = (mes === 'todos' || mes === null) ? null : Number(mes);
  const valorActivo = mesActivo === null ? 'todos' : String(mesActivo);
  document.querySelectorAll('.prod-mes-btn').forEach(btn => {
    btn.classList.toggle('activo', btn.dataset.mes === valorActivo);
  });
  // fix v350: ahora sí filtra — mesActivo/yearActivo se envían a
  // fn_productos_lista como p_mes/p_anio (ver cargarProductos()).
  recargarConFiltro();
}

/* ── Búsqueda ── */
let _busqTimer = null;
function onBusquedaTag(val) {
  clearTimeout(_busqTimer);
  _busqTimer = setTimeout(() => {
    busquedaTag = val;
    recargarConFiltro();
  }, 200);
}

function onFiltroEstado(val) {
  filtroEstado = val;
  recargarConFiltro();
}

function onFiltroCat(val) {
  filtroCatId = val;
  recargarConFiltro();
}

function onFiltroFoto(val) {
  filtroFoto = val;
  recargarConFiltro();
}

function onFiltroEtiqueta(val) {
  filtroEtiquetaId = val;
  recargarConFiltro();
}

/* ── Escanear para buscar en la lista (v628) ──────────────────────────────
   Botón "Escanear" del toolbar: abre la cámara de este dispositivo, y el
   código detectado se vuelca directo al buscador (fn_productos_lista ya
   busca por nombre O código — mismo p_busqueda). */
function abrirEscanerBusquedaProductos() {
  if (!window.CameraScanner) return;
  window.CameraScanner.abrir({
    titulo: 'Escanear para buscar',
    instrucciones: 'Apuntá la cámara al código de barras del producto que querés encontrar.',
    onCodigo: (codigo) => {
      const input = document.getElementById('prod-tag-input');
      if (input) input.value = codigo;
      onBusquedaTag(codigo);
    },
  });
}

/* ── Menú de acciones ── */
function abrirMenuAcciones(evt, id) {
  evt.stopPropagation();
  const p = productosPage.find(x => x.id === id);
  if (!p) return;
  // Antes esto mostraba un confirm() nativo del navegador que no hacía
  // nada real (ni guardaba, ni abría un formulario). Ahora abre el mismo
  // modal de edición que usa el botón "+" para altas, precargado con los
  // datos del producto — igual patrón que Clientes/Stock.
  abrirModalProducto(id);
}
