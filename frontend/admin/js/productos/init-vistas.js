// frontend/admin/js/productos/init-vistas.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Init de la página, toggle de vista Productos/Combos, tab inicial, blindaje anti-modal-pegado, DOMContentLoaded.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

/* ── Init ── */
async function init(authCtx) {
  // Obtener cliente Supabase desde el contexto de auth
  sb = authCtx?.sb || null;
  empresaData = authCtx?.perfil?.empresas || (authCtx?.perfil?.empresa_id ? { id: authCtx.perfil.empresa_id } : null);

  // Mostrar nombre del usuario en topbar
  const uel = document.getElementById('topbar-usuario');
  if (uel && authCtx?.perfil?.nombre) uel.textContent = authCtx.perfil.nombre;

  // Cargar datos
  await cargarProductos();
  actualizarAlertasStock();

  // Etiquetas (v473/474): poblar el filtro de la tabla con las etiquetas
  // ya creadas por la empresa (no bloquea el resto de la carga si falla).
  if (sb && window.Etiquetas) {
    Etiquetas.renderFiltroSelect('prod-filtro-etiqueta', { onCambio: onFiltroEtiqueta })
      .catch(err => console.warn('[productos] No se pudo cargar el filtro de etiquetas:', err?.message || err));
  }

  // Badge de la pestaña "Combos" (FIX 2026-08-23): contador liviano,
  // independiente de la carga completa de combosAll que sigue siendo
  // lazy (recién al primer click en la pestaña, ver cambiarVistaProductos).
  if (sb && window.cb_cargarContadorCombos) {
    window.cb_cargarContadorCombos();
  }
}

/* ── Toggle de vista Productos/Combos ── */
let _combosCargados = false;
function cambiarVistaProductos(vista) {
  // Combos ya no usa modal (FIX 2026-08-23, cuarta vuelta): el formulario
  // de "Nuevo/Editar combo" es un panel inline dentro de #vista-combos
  // (ver #cb-panel-form en productos.html), así que se oculta solo al
  // togglear la vista. El de Producto sigue siendo modal aparte — se
  // cierra acá como buena práctica al cambiar de pestaña.
  cerrarModalProducto();
  if (window.cb_cerrarFormulario) window.cb_cerrarFormulario();

  document.getElementById('vtab-productos').classList.toggle('activa', vista === 'productos');
  document.getElementById('vtab-combos').classList.toggle('activa', vista === 'combos');
  document.getElementById('vista-productos').style.display = vista === 'productos' ? '' : 'none';
  document.getElementById('vista-combos').style.display = vista === 'combos' ? '' : 'none';
  if (vista === 'combos' && !_combosCargados && window.cb_cargarCombos) {
    _combosCargados = true;
    window.cb_cargarCombos();
  }
}
window.cambiarVistaProductos = cambiarVistaProductos;

function aplicarTabInicialProductos() {
  const urlParams = new URLSearchParams(window.location.search);
  // Deep-link desde el viejo /admin/combos (ahora redirect, ver
  // vercel.json) y desde cualquier link guardado que apuntaba a esa
  // pantalla — mismo criterio que ?tab=listas en clientes.js.
  if (urlParams.get('tab') === 'combos') {
    cambiarVistaProductos('combos');
  }
}

/* ── Blindaje anti-modal-pegado (solo el modal de Producto — Combos ya no
   usa modal, ver arriba) ── el navegador puede restaurar la página desde
   bfcache (back/forward) con el DOM tal cual quedó, sin volver a correr
   los <script>, así que se fuerza el cierre acá también en 'pageshow'. */
function _cerrarModalesForzado() {
  document.getElementById('modal-backdrop-producto')?.style.setProperty('display', 'none');
  document.getElementById('modal-producto')?.classList.remove('open');
  document.body.style.overflow = '';
}
window.addEventListener('pageshow', (e) => {
  if (e.persisted) _cerrarModalesForzado();
});

/* ── DOMContentLoaded ── */
document.addEventListener('DOMContentLoaded', () => {
  _cerrarModalesForzado();

  // Año dinámico en la nav
  const yearEl = document.getElementById('prod-nav-year');
  if (yearEl) yearEl.textContent = yearActivo;

  // Botones de mes: marcar el activo y escuchar clics
  // fix v544: se compara por data-mes (no por índice) y arranca en "Todos"
  const valorActivoInit = mesActivo === null ? 'todos' : String(mesActivo);
  document.querySelectorAll('.prod-mes-btn').forEach(btn => {
    btn.classList.toggle('activo', btn.dataset.mes === valorActivoInit);
    btn.addEventListener('click', () => seleccionarMes(btn.dataset.mes));
  });

  // Debounce de búsqueda ya está en oninput del HTML.
  // El checkbox "seleccionar todos" también está en el HTML con onchange.

  // Iniciar icono de orden default
  actualizarIconosOrden();

  // Foto de producto (v353): preview al elegir archivo
  const fotoInput = document.getElementById('fp-foto-input');
  if (fotoInput) fotoInput.addEventListener('change', onFotoProductoSeleccionada);

  // Esperar que auth esté lista y luego arrancar
  if (window.authReady) {
    window.authReady
      .then(ctx => init(ctx))
      .catch(err => {
        console.warn('[productos] Auth no disponible, modo demo:', err?.message || err);
        init(null);
      })
      .finally(() => aplicarTabInicialProductos());
  } else {
    // Fallback: auth-ready.js no cargó (raro), arrancar en modo demo
    console.warn('[productos] window.authReady no disponible, cargando en modo demo.');
    init(null).finally(() => aplicarTabInicialProductos());
  }
});
