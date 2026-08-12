/* ============================================================
   productos.js — Lógica de la sección Productos (v227)
   Distrib · MF Web Solutions
   ============================================================ */

'use strict';

/* ── Cliente Supabase (se asigna en init() desde window.authCtx) ── */
let sb = null;
let empresaData = null;

/* ── Estado global ──────────────────────────────────────────────────────
   Nota (auditoría filtros v280): antes `productosAll` traía TODA la tabla
   de productos de la empresa (1008 filas, sin .range() ni .eq(empresa_id)
   explícito) más el join completo de `stock`, y todo el filtrado/orden/
   paginación pasaba client-side sobre ese arreglo. Ahora `productosPage`
   guarda solo la página actual, ya resuelta por el RPC fn_productos_lista
   (búsqueda, filtro de categoría/estado, orden y stock agregado en SQL).
   `totalCount` viene del count(*) OVER() de ese mismo RPC. ──────────── */
let productosPage  = [];   // solo la página actual (server-side)
let totalCount      = 0;
let categoriasAll  = [];   // [{id, nombre}] — para el <select> del modal y el filtro
let depositosAll   = [];   // [{id, nombre, es_principal}] — para el checklist del modal (v351)
/* fix v544: antes arrancaba en el mes calendario actual (new Date().getMonth()),
   así que el catálogo aparecía vacío apenas cambiaba el mes y no se habían
   creado productos nuevos todavía ese mes — el filtro por mes/año (v350)
   quedó andando correctamente, pero el DEFAULT nunca debió ser "mes actual"
   para una lista de productos (no es una vista de altas del mes, es el
   catálogo completo). Ahora arranca en null = "Todos" (sin filtro). */
let mesActivo      = null; // null = "Todos" (sin filtro) | 0–11 = mes elegido
let yearActivo     = new Date().getFullYear();
let seleccionados  = new Set();
let busquedaTag    = '';
let filtroEstado   = '';
let filtroCatId    = '';   // ahora es el id de categoría, no el nombre
let filtroFoto     = '';   // 'real' | 'generica' | 'sin_foto' | '' (sin filtro) — v392
let ordenCol       = 'nombre';
let ordenAsc       = true;
let _page          = 1;
const PAGE_SIZE    = 50;
let _cargaEnCurso  = null; // evita carreras si el usuario tipea/filtra rápido

/* ── Modal Nuevo/Editar producto ── */
let modalProductoId = null; // null = alta, string (uuid) = edición

/* ── Foto de producto (v353) ─────────────────────────────────────────────
   fotoProductoFile: File seleccionado en el input, pendiente de subir al
   guardar (se sube recién en guardarProducto(), no al elegir el archivo).
   fotoProductoUrlActual: foto_url ya guardada en el producto (edición).
   fotoProductoQuitar: true si el usuario apretó "Quitar imagen" en edición
   (hay que mandar foto_url: null al guardar aunque no haya subido nada). */
let fotoProductoFile      = null;
let fotoProductoUrlActual = null;
let fotoProductoQuitar    = false;
// v629 — Fix "el escaneo mezcla el título/foto con un producto anterior":
// hacen falta para distinguir "este valor lo autocompletó un escaneo" de
// "esto lo cargó el usuario a mano", así un escaneo nuevo puede reemplazar
// lo que dejó un escaneo anterior sin arriesgarse a pisar lo que el usuario
// ya tipeó/eligió. Ver setNombreProductoSiVacio/setFotoProductoDesdeUrl y
// limpiarAutoCompletadoSiCorresponde() más abajo.
let nombreProductoAutoCompletado = false;
let fotoProductoAutoCompletada   = false;
const FOTO_PRODUCTO_MAX_BYTES = 5 * 1024 * 1024;
const FOTO_PRODUCTO_MIME_OK   = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/* ── Paletas inline por categoría (sin dependencia de Tailwind) ── */
const PALETA = [
  'background:#fef9c3;color:#a16207',
  'background:#fef3c7;color:#b45309',
  'background:#dcfce7;color:#15803d',
  'background:#ffedd5;color:#c2410c',
  'background:#dbeafe;color:#1d4ed8',
  'background:#f5f5f4;color:#57534e',
  'background:#fce7f3;color:#be185d',
  'background:#f1f5f9;color:#475569',
  'background:#f5f5f5;color:#525252',
  'background:#fee2e2;color:#b91c1c',
  'background:#ede9fe;color:#7c3aed',
  'background:#ccfbf1;color:#0f766e',
];

const catPaleta = {};
function getPaleta(cat) {
  if (!catPaleta[cat]) {
    const keys = Object.keys(catPaleta).length;
    catPaleta[cat] = PALETA[keys % PALETA.length];
  }
  return catPaleta[cat];
}

/* ── Utilidades ── */
function escHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

function formatPeso(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0 });
}

function formatFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh   = String(d.getHours()).padStart(2, '0');
  const mi   = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function iniciales(nombre) {
  const parts = (nombre || '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (nombre || '??').substring(0, 2).toUpperCase();
}

function donutSVG(pct) {
  const r   = 12;
  const c   = 2 * Math.PI * r;
  const off = c - (pct / 100) * c;
  const color = pct >= 40 ? 'var(--color-info-mid,#2E6088)' : pct >= 20 ? 'var(--color-warning-mid,#B87A00)' : 'var(--color-danger-mid,#B3261E)';
  return `
    <svg width="32" height="32" viewBox="0 0 32 32" style="transform:rotate(-90deg);flex-shrink:0">
      <circle cx="16" cy="16" r="${r}" fill="none" stroke="var(--color-border-soft,#DAD3C0)" stroke-width="3.5"/>
      <circle cx="16" cy="16" r="${r}" fill="none" stroke="${color}" stroke-width="3.5"
              stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
              stroke-linecap="round"/>
    </svg>
    <span style="position:absolute;font-size:9px;font-weight:700;color:var(--color-text-muted,#4B4A45);pointer-events:none">${pct}%</span>
  `;
}

function estadoBadge(estado) {
  const mapa = {
    'activo':    { cls: 'activo',    label: 'Activo'    },
    'borrador':  { cls: 'borrador',  label: 'Borrador'  },
    'sin_stock': { cls: 'sin-stock', label: 'Sin Stock' },
  };
  const key = (estado || '').toLowerCase().replace(/\s+/g, '_');
  const info = mapa[key] || { cls: 'borrador', label: escHtml(estado) };
  return `<span class="prod-badge ${info.cls}">${info.label}</span>`;
}

const toast = (msg, tipo = 'default') => {
  if (typeof window.mostrarToast === 'function') window.mostrarToast(msg, tipo);
  else console.info('[productos]', tipo, msg);
};

/* ── Carga de datos ──────────────────────────────────────────────────────
   Auditoría filtros v280: reemplaza el .from('productos').select(...) sin
   .range() ni .eq(empresa_id) (traía las 1008 filas + join completo de
   stock a memoria del navegador) por el RPC fn_productos_lista, que hace
   búsqueda, filtro de categoría/estado, orden y stock agregado en SQL, y
   devuelve solo la página actual + total_count para la paginación. ────── */
async function cargarProductos() {
  mostrarCargando();
  const miCarga = Symbol('carga');
  _cargaEnCurso = miCarga;
  try {
    if (!sb) {
      // Modo demo: no hay sesión autenticada
      const demo = datosDemoEstaticos();
      totalCount = demo.length;
      productosPage = demo.slice((_page - 1) * PAGE_SIZE, _page * PAGE_SIZE);
    } else {
      const { data, error } = await sb.rpc('fn_productos_lista', {
        p_busqueda:     busquedaTag.trim() || null,
        p_categoria_id: filtroCatId || null,
        p_estado:       filtroEstado || null,
        p_orden:        ordenCol,
        p_asc:          ordenAsc,
        p_limit:        PAGE_SIZE,
        p_offset:       (_page - 1) * PAGE_SIZE,
        // fix v350: antes mesActivo/yearActivo se guardaban en el estado pero
        // nunca se mandaban al RPC, por eso la lista no cambiaba entre meses.
        // mesActivo es 0–11 (JS Date), el RPC espera 1–12.
        // fix v544: mesActivo puede ser null ("Todos") — en ese caso no se
        // manda filtro de mes/año al RPC (antes siempre mandaba el mes
        // calendario actual por defecto, dejando el catálogo vacío fuera de
        // temporada de altas).
        p_mes:          mesActivo === null ? null : mesActivo + 1,
        p_anio:         mesActivo === null ? null : yearActivo,
        p_foto_fuente:  filtroFoto || null,
      });
      if (error) throw error;
      if (_cargaEnCurso !== miCarga) return; // llegó una carga más nueva primero
      productosPage = (data || []).map(normalizarRpc);
      totalCount    = data?.[0]?.total_count ?? 0;
    }
  } catch (err) {
    console.error('[productos] Error al cargar:', err);
    toast('No se pudieron cargar los productos. Mostrando datos de ejemplo.', 'warning');
    const demo = datosDemoEstaticos();
    totalCount = demo.length;
    productosPage = demo.slice((_page - 1) * PAGE_SIZE, _page * PAGE_SIZE);
  }

  if (_cargaEnCurso !== miCarga) return;
  renderTabla();
  actualizarContadorSeleccion();
  actualizarPaginacion();
  actualizarTotalLabel();
  if (window.ocultarPreloader) window.ocultarPreloader();
}

/* ── Contadores globales (topbar + alerta de stock) ──────────────────────
   Antes salían de productosAll.length / .filter() sobre el dataset entero
   ya cargado en memoria. Ahora vienen de fn_productos_contadores(), que
   agrega en SQL sin traer el catálogo completo al navegador. ────────── */
let contadores = { total_productos: 0, total_activos: 0, total_sin_stock: 0 };

async function cargarContadores() {
  if (!sb) {
    const demo = datosDemoEstaticos();
    contadores = {
      total_productos: demo.length,
      total_activos:   demo.filter(p => p.estado === 'activo').length,
      total_sin_stock: demo.filter(p => p.estado === 'sin_stock').length,
    };
  } else {
    try {
      const { data, error } = await sb.rpc('fn_productos_contadores');
      if (error) throw error;
      contadores = data?.[0] || contadores;
    } catch (err) {
      console.error('[productos] Error al cargar contadores:', err);
    }
  }
  actualizarTopbarContador();
  actualizarAlertasStock();
}

/* ── Categorías reales (para el <select> del modal y el filtro de la tabla) ── */
async function cargarCategorias() {
  if (!sb || !empresaData?.id) return;
  try {
    const { data, error } = await sb
      .from('categorias')
      .select('id, nombre')
      .eq('empresa_id', empresaData.id)
      .eq('activa', true)
      .order('nombre');
    if (error) throw error;
    categoriasAll = data || [];
  } catch (err) {
    console.error('[productos] Error al cargar categorías:', err);
    categoriasAll = [];
  }
  poblarFiltrosCategorias();
}

/* ── Depósitos (para el checklist "en qué depósito arranca" del alta) ──────
   v351: reemplaza el trigger que fanoteaba stock inicial a TODOS los
   depósitos de la empresa. Se carga on-demand cuando se abre el modal de
   alta (no hace falta en la tabla ni en el filtro). ─────────────────────── */
async function cargarDepositosModal() {
  if (!sb || !empresaData?.id) { depositosAll = []; return; }
  try {
    const { data, error } = await sb
      .from('depositos')
      .select('id, nombre, es_principal')
      .eq('empresa_id', empresaData.id)
      .order('nombre');
    if (error) throw error;
    depositosAll = data || [];
  } catch (err) {
    console.error('[productos] Error al cargar depósitos:', err);
    depositosAll = [];
  }
}

function poblarChecklistDepositosModal() {
  const cont = document.getElementById('fp-depositos-lista');
  if (!cont) return;
  const errEl = document.getElementById('fp-depositos-error');
  if (errEl) errEl.style.display = 'none';

  if (!depositosAll.length) {
    cont.innerHTML = '<p style="font-size:12.5px;color:var(--color-text-muted);margin:0">No hay depósitos cargados todavía.</p>';
    return;
  }

  cont.innerHTML = depositosAll.map(d => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
      <input type="checkbox" class="fp-deposito-chk" value="${d.id}" ${d.es_principal ? 'checked' : ''}>
      ${escHtml(d.nombre)}${d.es_principal ? ' <span style="color:var(--color-text-muted);font-size:11.5px">(principal)</span>' : ''}
    </label>
  `).join('');

  // Fallback: si ningún depósito está marcado como principal, se
  // precarga el primero para que el checklist no arranque vacío.
  if (!depositosAll.some(d => d.es_principal)) {
    const primero = cont.querySelector('.fp-deposito-chk');
    if (primero) primero.checked = true;
  }
}

function normalizarRpc(p) {
  // El RPC fn_productos_lista ya resuelve estado, stock agregado, margen-base
  // y categoría en SQL; acá solo se adaptan los nombres a los que usa el
  // render/CSV (que antes calculaba normalizar() íntegramente en JS).
  const precio = Number(p.precio_base ?? 0);
  const costo  = Number(p.costo ?? 0);
  const stock  = Number(p.stock_disponible ?? 0);
  const stockMin = Number(p.stock_minimo ?? 1);
  const margen = precio > 0 && costo > 0 ? Math.round(((precio - costo) / precio) * 100) : 0;
  const goal   = stockMin > 0 ? Math.min(100, Math.round((stock / (stockMin * 3)) * 100)) : 0;

  return {
    id:           p.id,
    codigo:       p.codigo || '',
    nombre:       p.nombre || '(sin nombre)',
    cat:          p.categoria_nombre || '—',
    categoriaId:  p.categoria_id || '',
    activo:       p.activo !== false,
    estado:       p.estado || 'borrador',
    fechaAct:     p.updated_at || p.created_at || null,
    precio,
    costo,
    stockMinimo:  stockMin,
    stock,
    fotoUrl:      p.foto_url || null,
    fotoFuente:   p.foto_fuente || null,
    margen:       Math.max(0, Math.min(100, margen)),
    goal:         Math.max(0, Math.min(100, goal)),
  };
}

function datosDemoEstaticos() {
  return [
    { id: 1,  nombre: 'Aceite Girasol 900ml',      cat: 'Aceites',      estado: 'activo',    fechaAct: '2026-07-06T14:30:00', precio: 2850,  costo: 1980,  stock: 342, margen: 31, goal: 65 },
    { id: 2,  nombre: 'Arroz Largo Fino 1kg',       cat: 'Cereales',     estado: 'activo',    fechaAct: '2026-07-06T13:15:00', precio: 1450,  costo: 980,   stock: 0,   margen: 33, goal: 89 },
    { id: 3,  nombre: 'Yerba Mate 500g',             cat: 'Infusiones',   estado: 'activo',    fechaAct: '2026-07-05T09:00:00', precio: 3200,  costo: 2100,  stock: 87,  margen: 34, goal: 47 },
    { id: 4,  nombre: 'Fideos Spaghetti 500g',       cat: 'Pastas',       estado: 'borrador',  fechaAct: '2026-07-04T18:45:00', precio: 1100,  costo: 720,   stock: 156, margen: 35, goal: 30 },
    { id: 5,  nombre: 'Dulce de Leche 400g',         cat: 'Lácteos',      estado: 'activo',    fechaAct: '2026-07-06T10:20:00', precio: 2400,  costo: 1600,  stock: 23,  margen: 33, goal: 78 },
    { id: 6,  nombre: 'Harina 000 1kg',              cat: 'Harinas',      estado: 'sin_stock', fechaAct: '2026-07-01T16:00:00', precio: 890,   costo: 590,   stock: 0,   margen: 34, goal: 12 },
    { id: 7,  nombre: 'Galletitas Surtidas 200g',    cat: 'Galletitas',   estado: 'activo',    fechaAct: '2026-07-06T11:55:00', precio: 1750,  costo: 1150,  stock: 210, margen: 34, goal: 55 },
    { id: 8,  nombre: 'Sal Fina 1kg',                cat: 'Condimentos',  estado: 'borrador',  fechaAct: '2026-07-03T08:30:00', precio: 480,   costo: 310,   stock: 445, margen: 35, goal: 20 },
    { id: 9,  nombre: 'Azúcar Blanca 1kg',           cat: 'Endulzantes',  estado: 'activo',    fechaAct: '2026-07-06T09:45:00', precio: 1230,  costo: 820,   stock: 78,  margen: 33, goal: 68 },
    { id: 10, nombre: 'Vinagre Manzana 500ml',       cat: 'Condimentos',  estado: 'sin_stock', fechaAct: '2026-06-28T17:00:00', precio: 960,   costo: 640,   stock: 0,   margen: 33, goal: 8  },
  ];
}

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
  const ti = document.getElementById('prod-tag-input');
  if (ti) ti.value = '';
  const se = document.getElementById('prod-filtro-estado');
  if (se) se.value = '';
  const sc = document.getElementById('prod-filtro-cat');
  if (sc) sc.value = '';
  const sf = document.getElementById('prod-filtro-foto');
  if (sf) sf.value = '';
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
   de las iniciales, con un punto de color en la esquina que indica el origen
   — verde "real" (barcode, búsqueda web o subida manual) o ámbar "genérica".
   (v394: la fuente 'pexels' ya no la genera auto-imagenes — se sacó el
   banco de fotos genérico del pipeline — el chequeo queda solo por si
   quedara algún registro viejo sin limpiar.) Si falla la carga de la
   imagen (URL rota, bucket borrado), cae de nuevo a las iniciales via
   onerror. */
function renderAvatarFoto(p, pal, ini) {
  if (!p.fotoUrl) {
    return `<span class="prod-avatar" style="${pal}">${escHtml(ini)}</span>`;
  }
  const esGenerica  = p.fotoFuente === 'pexels';
  const badgeClase  = esGenerica ? 'prod-foto-badge--generica' : 'prod-foto-badge--real';
  const badgeTitulo = esGenerica
    ? 'Foto genérica (banco de fotos, no es la marca exacta)'
    : 'Foto real del producto';
  const iniEsc = escHtml(ini);
  return `
    <span class="prod-avatar-wrap">
      <img class="prod-avatar prod-avatar--foto" src="${escHtml(p.fotoUrl)}" alt=""
           loading="lazy"
           onerror="this.outerHTML='<span class=&quot;prod-avatar&quot; style=&quot;${pal}&quot;>${iniEsc}</span>'">
      <span class="prod-foto-badge ${badgeClase}" title="${escHtml(badgeTitulo)}" aria-label="${escHtml(badgeTitulo)}"></span>
    </span>`;
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
    const chk = seleccionados.has(p.id) ? 'checked' : '';

    return `
      <tr data-id="${p.id}">
        <td>
          <input type="checkbox" class="prod-check prod-row-chk" ${chk}
                 aria-label="Seleccionar ${escHtml(p.nombre)}"
                 data-id="${p.id}" onchange="toggleFila('${p.id}', this.checked)">
        </td>
        <td>
          <div class="prod-nombre-cell">
            ${renderAvatarFoto(p, pal, ini)}
            <span class="prod-nombre-text" title="${escHtml(p.nombre)}">${escHtml(p.nombre)}</span>
          </div>
        </td>
        <td class="prod-cat-cell">${escHtml(p.cat)}</td>
        <td>${estadoBadge(p.estado)}</td>
        <td class="prod-fecha">${escHtml(formatFecha(p.fechaAct))}</td>
        <td class="prod-precio">${escHtml(formatPeso(p.precio))}</td>
        <td class="prod-costo">${escHtml(formatPeso(p.costo))}</td>
        <td class="prod-stock ${p.stock === 0 ? 'prod-stock-cero' : ''}">${escHtml(String(p.stock))}u</td>
        <td>
          <div class="prod-donut-wrap" title="Margen: ${p.margen}%">
            ${donutSVG(p.margen)}
          </div>
        </td>
        <td>
          <div class="prod-progress-wrap" title="Goal de ventas: ${p.goal}%">
            <div class="prod-progress-fill" style="width:${p.goal}%"></div>
          </div>
        </td>
        <td class="col-sticky-end">
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

/* ── Selección (sobre la página actual) ── */
function toggleTodos(checked) {
  seleccionados.clear();
  if (checked) productosPage.forEach(p => seleccionados.add(p.id));
  document.querySelectorAll('.prod-row-chk').forEach(el => { el.checked = checked; });
  actualizarContadorSeleccion();
}

function toggleFila(id, checked) {
  if (checked) seleccionados.add(id);
  else seleccionados.delete(id);
  const allChk = document.getElementById('prod-chk-all');
  if (allChk) {
    const visible = document.querySelectorAll('.prod-row-chk').length;
    allChk.checked    = seleccionados.size === visible && visible > 0;
    allChk.indeterminate = seleccionados.size > 0 && seleccionados.size < visible;
  }
  actualizarContadorSeleccion();
}

function actualizarContadorSeleccion() {
  const el = document.getElementById('prod-sel-count');
  if (!el) return;
  if (seleccionados.size > 0) {
    el.textContent = `${seleccionados.size} seleccionado${seleccionados.size > 1 ? 's' : ''}`;
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

/* ── Agregar producto ── */
function agregarProducto() {
  abrirModalProducto(null);
}

/* ── Modal Nuevo/Editar producto ─────────────────────────────────────────
   Reutiliza el mismo componente .modal-backdrop/.modal que Clientes, para
   que Productos quede sincronizado con el resto de las secciones en vez
   de depender de confirm()/alert() nativos sin conexión a la base. ──── */
async function abrirModalProducto(id) {
  if (!sb) {
    toast('No hay conexión con la base de datos (modo demo). Iniciá sesión para editar productos.', 'warning');
    return;
  }

  modalProductoId = id;
  await cargarCategorias();
  poblarSelectCategoriasModal();

  const titulo    = document.getElementById('modal-prod-titulo');
  const subtitulo = document.getElementById('modal-prod-subtitulo');

  const linkReceta    = document.getElementById('fp-link-receta');
  const secDepositos  = document.getElementById('fp-sec-depositos');
  const btnEliminar   = document.getElementById('btn-eliminar-producto');

  // El borrado físico solo tiene sentido en edición (un producto nuevo,
  // todavía no guardado, no existe en la base para poder borrarlo).
  if (btnEliminar) btnEliminar.style.display = id ? '' : 'none';

  if (id) {
    const p = productosPage.find(x => x.id === id);
    if (!p) { toast('No se encontró el producto', 'error'); return; }

    titulo.textContent    = p.nombre;
    subtitulo.textContent = p.codigo ? `Código: ${p.codigo}` : 'Sin código cargado';

    document.getElementById('fp-codigo').value       = p.codigo || '';
    document.getElementById('fp-nombre').value        = p.nombre || '';
    document.getElementById('fp-categoria_id').value = p.categoriaId || '';
    document.getElementById('fp-precio_base').value  = p.precio ?? 0;
    document.getElementById('fp-costo').value        = p.costo ?? 0;
    document.getElementById('fp-stock_minimo').value = p.stockMinimo ?? 0;
    document.getElementById('fp-activo').value       = String(p.activo !== false);
    if (linkReceta) linkReceta.style.display = 'inline';
    // v351: el selector de depósitos solo tiene sentido en el alta —
    // en edición el producto ya existe y el stock se gestiona desde Stock.
    if (secDepositos) secDepositos.style.display = 'none';

    // v353: precarga la foto actual del producto (si tiene).
    fotoProductoFile      = null;
    fotoProductoQuitar    = false;
    fotoProductoUrlActual = p.fotoUrl || null;
    fotoProductoAutoCompletada  = false;
    nombreProductoAutoCompletado = false;
    const fotoInput = document.getElementById('fp-foto-input');
    if (fotoInput) fotoInput.value = '';
    mostrarPreviewFoto(fotoProductoUrlActual);
  } else {
    titulo.textContent    = 'Nuevo producto';
    subtitulo.textContent = 'Completá los datos del producto';

    document.getElementById('fp-codigo').value       = '';
    document.getElementById('fp-nombre').value        = '';
    document.getElementById('fp-categoria_id').value = '';
    document.getElementById('fp-precio_base').value  = 0;
    document.getElementById('fp-costo').value        = 0;
    document.getElementById('fp-stock_minimo').value = 0;
    document.getElementById('fp-activo').value       = 'true';
    nombreProductoAutoCompletado = false;
    if (linkReceta) linkReceta.style.display = 'none';

    if (secDepositos) secDepositos.style.display = '';
    await cargarDepositosModal();
    poblarChecklistDepositosModal();

    // v353: limpio cualquier foto que haya quedado de una apertura anterior.
    resetFotoProductoModal();
  }

  document.getElementById('modal-backdrop-producto').style.display = 'block';
  document.getElementById('modal-producto').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function cerrarModalProducto() {
  document.getElementById('modal-backdrop-producto').style.display = 'none';
  document.getElementById('modal-producto').classList.remove('open');
  document.body.style.overflow = '';
}

/* ── Limpiar formulario (v628) ────────────────────────────────────────────
   Pedido explícito: cuando el autocompletado por código escaneado trae
   datos equivocados (nombre o foto de otro producto), poder vaciar todo
   el formulario de una sola vez en lugar de borrar campo por campo a mano.
   No toca el modo del modal (alta/edición) ni lo cierra — solo limpia los
   valores cargados en pantalla. */
async function limpiarFormularioProducto() {
  const esEdicion = !!modalProductoId;
  const ok = await window.confirmar(
    esEdicion
      ? 'Se van a borrar todos los cambios cargados en este formulario (no afecta lo ya guardado del producto). ¿Continuar?'
      : '¿Borrar todos los campos cargados hasta ahora?',
    { tipo: 'default' }
  );
  if (!ok) return;

  document.getElementById('fp-codigo').value       = '';
  document.getElementById('fp-nombre').value        = '';
  document.getElementById('fp-categoria_id').value = '';
  document.getElementById('fp-precio_base').value  = 0;
  document.getElementById('fp-costo').value        = 0;
  document.getElementById('fp-stock_minimo').value = 0;
  document.getElementById('fp-activo').value       = 'true';
  nombreProductoAutoCompletado = false;

  resetFotoProductoModal();

  // El checklist de depósitos solo existe en el alta (en edición está
  // oculto); si está visible, se vuelve al estado default (solo el
  // depósito principal tildado), igual que al abrir el modal de alta.
  if (document.getElementById('fp-sec-depositos')?.style.display !== 'none') {
    poblarChecklistDepositosModal();
  }

  document.getElementById('fp-nombre')?.focus();
  toast('Formulario limpio.', 'ok');
}

/* ── Foto de producto (v353) ─────────────────────────────────────────────
   Bucket público 'productos-fotos' con policies de insert/update/delete
   para 'authenticated' (ya configurado en Storage). Se sube client-side
   con el cliente Supabase logueado, evitando el round-trip por backend que
   usa devoluciones.js (ese flujo es para el chofer, que no tiene sesión
   Supabase con RLS). La separación multi-tenant a nivel de archivo se
   maneja por convención de path: ${empresa_id}/${uuid-random}.ext ─────── */
function mostrarPreviewFoto(url) {
  const img    = document.getElementById('fp-foto-preview');
  const icono  = document.getElementById('fp-foto-preview-icono');
  const btnQuitar = document.getElementById('fp-foto-quitar');
  if (!img) return;
  if (url) {
    img.src = url;
    img.style.display = 'block';
    if (icono) icono.style.display = 'none';
    if (btnQuitar) btnQuitar.style.display = 'inline-block';
  } else {
    img.src = '';
    img.style.display = 'none';
    if (icono) icono.style.display = '';
    if (btnQuitar) btnQuitar.style.display = 'none';
  }
}

function resetFotoProductoModal() {
  fotoProductoFile      = null;
  fotoProductoUrlActual = null;
  fotoProductoQuitar    = false;
  fotoProductoAutoCompletada = false;
  const input = document.getElementById('fp-foto-input');
  if (input) input.value = '';
  mostrarPreviewFoto(null);
}

function onFotoProductoSeleccionada(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;

  if (!FOTO_PRODUCTO_MIME_OK.includes(file.type)) {
    toast('Formato no admitido. Usá JPG, PNG, WEBP o GIF.', 'warning');
    ev.target.value = '';
    return;
  }
  if (file.size > FOTO_PRODUCTO_MAX_BYTES) {
    toast('La imagen supera los 5 MB permitidos.', 'warning');
    ev.target.value = '';
    return;
  }

  fotoProductoFile   = file;
  fotoProductoQuitar = false;
  fotoProductoAutoCompletada = false; // el usuario eligió el archivo a mano
  mostrarPreviewFoto(URL.createObjectURL(file));
}

function quitarFotoProducto() {
  fotoProductoFile      = null;
  fotoProductoUrlActual = null;
  fotoProductoQuitar    = true;
  fotoProductoAutoCompletada = false;
  const input = document.getElementById('fp-foto-input');
  if (input) input.value = '';
  mostrarPreviewFoto(null);
}

// Sube fotoProductoFile al bucket y devuelve la URL pública, o null si no
// había ningún archivo pendiente de subir.
async function subirFotoProductoSiCorresponde() {
  if (!fotoProductoFile || !sb || !empresaData?.id) return null;

  const ext = (fotoProductoFile.name.split('.').pop() || 'jpg').toLowerCase();
  const nombreArchivo = `${empresaData.id}/${crypto.randomUUID()}.${ext}`;

  const { error: errorSubida } = await sb.storage
    .from('productos-fotos')
    .upload(nombreArchivo, fotoProductoFile, {
      cacheControl: '3600',
      upsert: false,
      contentType: fotoProductoFile.type,
    });
  if (errorSubida) throw errorSubida;

  const { data } = sb.storage.from('productos-fotos').getPublicUrl(nombreArchivo);
  return data?.publicUrl || null;
}

/* ── Autocompletar por código escaneado (v618) ────────────────────────────
   Llamado desde productos-scanner-remoto.js cuando el código escaneado
   matchea contra el banco de códigos / Open Food Facts / Serper, etc.
   Nunca pisa datos que el usuario haya cargado A MANO (nombre tipeado,
   foto ya elegida o ya guardada en edición) — si algo de eso existe, se
   ignora en silencio y el usuario sigue completando manualmente.

   v629 — FIX ("el escaneo mezcla el título/foto con un producto anterior"):
   antes el guard era "solo completo si el campo está vacío", pero eso
   confundía dos cosas distintas: "el usuario tipeó esto" y "esto quedó de
   un escaneo ANTERIOR, en la misma sesión del formulario, que nunca se
   guardó ni se limpió" (típico al escanear varios productos seguidos con
   el celular vinculado, o al corregir un código mal leído sin haber
   guardado el anterior todavía). En ese segundo caso el campo NO está
   vacío pero tampoco es del usuario — así que el nombre/foto del código
   nuevo se descartaban en silencio y quedaba pegado el dato del producto
   anterior. Ahora se distingue con nombreProductoAutoCompletado/
   fotoProductoAutoCompletada: solo protegen lo tipeado/elegido a mano. */
function setNombreProductoSiVacio(nombre) {
  const input = document.getElementById('fp-nombre');
  if (!input || !nombre) return;
  if (input.value.trim() && !nombreProductoAutoCompletado) return; // lo tipeó el usuario
  input.value = nombre;
  nombreProductoAutoCompletado = true;
}

async function setFotoProductoDesdeUrl(url) {
  if (!url || fotoProductoUrlActual) return;
  if (fotoProductoFile && !fotoProductoAutoCompletada) return; // el usuario ya eligió una a mano
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const blob = await r.blob();
    if (!FOTO_PRODUCTO_MIME_OK.includes(blob.type)) return;
    if (blob.size > FOTO_PRODUCTO_MAX_BYTES) return;

    const ext  = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const file = new File([blob], `escaneo.${ext}`, { type: blob.type });

    // Puede haber tardado un momento en llegar (fetch + descarga) — si en
    // el ínterin el usuario ya eligió/quitó una foto a mano, no pisarla.
    // (Si lo que hay puesto es de un escaneo anterior, sí se puede pisar.)
    if (fotoProductoQuitar) return;
    if (fotoProductoFile && !fotoProductoAutoCompletada) return;

    fotoProductoFile          = file;
    fotoProductoQuitar        = false;
    fotoProductoAutoCompletada = true;
    mostrarPreviewFoto(URL.createObjectURL(file));
  } catch (err) {
    // CORS, timeout, red caída, etc. — la foto es un "extra", nunca debe
    // romper el autocompletado del nombre ni el alta del producto.
    console.warn('[productos] no se pudo traer la foto del código escaneado:', err?.message);
  }
}

window.setNombreProductoSiVacio = setNombreProductoSiVacio;
window.setFotoProductoDesdeUrl  = setFotoProductoDesdeUrl;

// v629 — Se llama apenas se detecta un código NUEVO (onCodigoEscaneado en
// productos-scanner-remoto.js), ANTES de salir a buscar sus datos. Si el
// nombre/foto que hay en pantalla vinieron de un escaneo anterior (nunca
// de que el usuario los haya tipeado/elegido a mano), los limpia — así:
//   1. Nunca queda a la vista, ni por un instante, el nombre/foto de OTRO
//      producto mientras se busca el del código recién leído.
//   2. El nuevo resultado no queda bloqueado por el guard de "no pisar lo
//      que ya hay", porque el campo vuelve a estar realmente vacío.
// Si el usuario sí tipeó/eligió algo a mano, esto no lo toca.
function limpiarAutoCompletadoSiCorresponde() {
  const inputNombre = document.getElementById('fp-nombre');
  if (inputNombre && nombreProductoAutoCompletado) {
    inputNombre.value = '';
    nombreProductoAutoCompletado = false;
  }
  if (fotoProductoAutoCompletada) {
    fotoProductoFile           = null;
    fotoProductoAutoCompletada = false;
    if (!fotoProductoUrlActual) mostrarPreviewFoto(null);
  }
}
window.limpiarAutoCompletadoSiCorresponde = limpiarAutoCompletadoSiCorresponde;

// v626 — forzarFotoProductoDesdeUrl: descarga y aplica una imagen al formulario
// SIN los guards de setFotoProductoDesdeUrl. Usada por refrescarImagen()
// (productos-scanner-remoto.js) cuando ya hay una imagen auto-completada y se
// quiere pisar con la nueva foto devuelta por /api/banco-codigos?accion=refrescar.
//
// A diferencia de setFotoProductoDesdeUrl, esta función:
//   - No verifica si fotoProductoFile ya está seteado (guard de "no pisar al usuario")
//   - No verifica fotoProductoUrlActual
//   - Sí resetea limpiamente el estado antes de aplicar la nueva imagen
//   - No pisa si el usuario actuó MIENTRAS se descargaba (mismo chequeo final)
async function forzarFotoProductoDesdeUrl(url) {
  if (!url) return;
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const blob = await r.blob();
    if (!FOTO_PRODUCTO_MIME_OK.includes(blob.type)) return;
    if (blob.size > FOTO_PRODUCTO_MAX_BYTES) return;

    const ext  = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const file = new File([blob], `escaneo.${ext}`, { type: blob.type });

    // Chequeo de concurrencia: si el usuario tocó el input de archivo manualmente
    // mientras se descargaba, no pisarle su elección. Sí se puede pisar fotoProductoFile
    // porque eso lo setea el scanner, no el usuario.
    if (fotoProductoQuitar) return;

    fotoProductoFile      = file;
    fotoProductoUrlActual = null;
    fotoProductoQuitar    = false;
    fotoProductoAutoCompletada = true;
    mostrarPreviewFoto(URL.createObjectURL(file));
  } catch (err) {
    console.warn('[productos] forzarFotoProductoDesdeUrl:', err?.message);
  }
}

window.forzarFotoProductoDesdeUrl = forzarFotoProductoDesdeUrl;

function poblarSelectCategoriasModal() {
  const sel = document.getElementById('fp-categoria_id');
  if (!sel) return;
  const actual = sel.value;
  sel.innerHTML = '<option value="">Sin categoría</option>' +
    categoriasAll.map(c => `<option value="${c.id}">${escHtml(c.nombre)}</option>`).join('') +
    '<option value="__nueva__">+ Nueva categoría...</option>';
  sel.value = actual;
}

// Detecta "+ Nueva categoría..." en el select del modal de producto y abre
// el alta rápida sin perder lo que ya se cargó del producto.
function onCambioCategoriaFP(select) {
  if (select.value === '__nueva__') {
    select.value = '';
    abrirModalCategoriaRapida();
  }
}

function abrirModalCategoriaRapida() {
  document.getElementById('cat-nombre').value = '';
  document.getElementById('modal-backdrop-cat-rapida').style.display = 'block';
  document.getElementById('modal-categoria-rapida').style.display = 'block';
  setTimeout(() => document.getElementById('cat-nombre')?.focus(), 50);
}

function cerrarModalCategoriaRapida() {
  document.getElementById('modal-backdrop-cat-rapida').style.display = 'none';
  document.getElementById('modal-categoria-rapida').style.display = 'none';
}

function cerrarModalCategoriaRapidaSiFondo(event) {
  cerrarModalCategoriaRapida();
}

async function guardarCategoriaRapida() {
  const nombre = document.getElementById('cat-nombre').value.trim();
  if (!nombre) { toast('El nombre es obligatorio', 'warning'); return; }

  const token = await getToken();
  const res = await fetch('/api/maestros?recurso=categorias', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nombre }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'No se pudo crear la categoría', 'error');
    return;
  }

  const nueva = await res.json();
  toast('Categoría creada', 'success');
  cerrarModalCategoriaRapida();

  await cargarCategorias();
  poblarSelectCategoriasModal();
  const sel = document.getElementById('fp-categoria_id');
  if (sel) sel.value = nueva.id;
}

/* ── Aportar al banco de códigos compartido (440) ─────────────────────────
   Fire-and-forget: no bloquea el guardado del producto ni muestra error al
   usuario si falla (falta de conexión, permiso, etc.) — es un "extra" que
   beneficia a otras empresas del SaaS, nunca debe entorpecer el alta de
   este producto. Se llama tanto desde guardarProducto() (aporte "manual",
   con lo que el usuario tipeó) como desde productos-scanner-remoto.js
   cuando Open Food Facts/Open Products Facts/Mercado Libre devuelven un
   match (fuente correspondiente), para cachear ese hallazgo acá. */
async function aportarBancoCodigos(codigo, nombre, fotoUrl, fuente = 'manual') {
  if (!codigo || (!nombre && !fotoUrl)) return;
  try {
    const token = await getToken();
    await fetch('/api/banco-codigos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ codigo, nombre, foto_url: fotoUrl, fuente }),
    });
  } catch (err) {
    console.warn('[productos] no se pudo aportar al banco de códigos:', err?.message);
  }
}

window.aportarBancoCodigos = aportarBancoCodigos;

async function guardarProducto() {
  const nombre = document.getElementById('fp-nombre').value.trim();
  if (!nombre) { toast('El nombre es obligatorio', 'warning'); return; }

  const payload = {
    empresa_id:   empresaData?.id,
    codigo:       document.getElementById('fp-codigo').value.trim() || null,
    nombre,
    categoria_id: document.getElementById('fp-categoria_id').value || null,
    precio_base:  parseFloat(document.getElementById('fp-precio_base').value) || 0,
    costo:        parseFloat(document.getElementById('fp-costo').value) || 0,
    stock_minimo: parseFloat(document.getElementById('fp-stock_minimo').value) || 0,
    activo:       document.getElementById('fp-activo').value === 'true',
  };

  if (!payload.empresa_id) {
    toast('No se pudo determinar la empresa del usuario actual.', 'error');
    return;
  }

  const okConfirm = await window.confirmar(
    modalProductoId ? `¿Guardar los cambios de "${nombre}"?` : `¿Confirmás crear el producto "${nombre}"?`,
    { labelOk: modalProductoId ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!okConfirm) return;

  try {
    // v353: si el usuario eligió un archivo nuevo, subirlo primero al
    // bucket 'productos-fotos' y usar la URL pública resultante.
    let fotoUrlNueva = null;
    try {
      fotoUrlNueva = await subirFotoProductoSiCorresponde();
    } catch (errFoto) {
      console.error('[productos] Error al subir la foto:', errFoto);
      toast('No se pudo subir la imagen. Se guardará el producto sin foto.', 'warning');
    }

    if (modalProductoId) {
      // Edición: sin cambios respecto a antes — el stock por depósito ya
      // existe y se gestiona desde la sección Stock, no acá.
      // v353: se agrega foto_url — nueva si se subió una, null si se pidió
      // "Quitar imagen", o la que ya tenía si no se tocó nada.
      if (fotoUrlNueva) {
        payload.foto_url = fotoUrlNueva;
      } else if (fotoProductoQuitar) {
        payload.foto_url = null;
      } else {
        payload.foto_url = fotoProductoUrlActual;
      }

      const { error } = await sb.from('productos').update(payload).eq('id', modalProductoId);
      if (error) throw error;
      toast('Producto actualizado', 'success');
      aportarBancoCodigos(payload.codigo, payload.nombre, payload.foto_url);
    } else {
      // Alta (v351): ya no se inserta directo en `productos` (eso disparaba
      // el trigger que fanoteaba stock a TODOS los depósitos). Ahora se usa
      // fn_crear_producto(), que crea el producto + stock inicial en 0 SOLO
      // en los depósitos elegidos en el checklist.
      const depositoIds = Array.from(document.querySelectorAll('.fp-deposito-chk:checked')).map(el => el.value);
      if (!depositoIds.length) {
        const errEl = document.getElementById('fp-depositos-error');
        if (errEl) errEl.style.display = 'block';
        toast('Elegí al menos un depósito para el producto nuevo.', 'warning');
        return;
      }

      const { error } = await sb.rpc('fn_crear_producto', {
        p_nombre:       payload.nombre,
        p_deposito_ids: depositoIds,
        p_codigo:       payload.codigo,
        p_categoria_id: payload.categoria_id,
        p_precio_base:  payload.precio_base,
        p_costo:        payload.costo,
        p_stock_minimo: payload.stock_minimo,
        p_activo:       payload.activo,
        p_foto_url:     fotoUrlNueva,
      });
      if (error) throw error;
      toast('Producto creado', 'success');
      aportarBancoCodigos(payload.codigo, payload.nombre, fotoUrlNueva);
    }
    cerrarModalProducto();
    await cargarProductos();
  } catch (err) {
    console.error('[productos] Error al guardar:', err);
    toast('No se pudo guardar el producto. Probá de nuevo en un momento.', 'error');
  }
}

/* ── Eliminar producto (borrado físico) ───────────────────────────────────
   Distinto de "dar de baja" (campo ESTADO → inactivo), que es lo normal
   para dejar de vender algo sin perder su historial. Esto borra la fila
   de verdad. Si el producto ya tiene movimientos de stock, pedidos,
   facturas, etc. asociados, la base va a rechazar el DELETE por FK —
   en ese caso avisamos y sugerimos desactivarlo en su lugar. ──────────── */
async function eliminarProducto() {
  if (!modalProductoId) return;

  const p = productosPage.find(x => x.id === modalProductoId);
  const nombre = p?.nombre || 'este producto';

  const ok = await window.confirmar(
    `¿Eliminar "${nombre}" definitivamente? Esta acción no se puede deshacer.`,
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;

  try {
    const { error } = await sb.from('productos').delete().eq('id', modalProductoId);
    if (error) throw error;
    toast('Producto eliminado', 'success');
    cerrarModalProducto();
    await cargarProductos();
  } catch (err) {
    console.error('[productos] Error al eliminar:', err);
    // 23503 = foreign_key_violation — el producto tiene historial asociado
    // (stock, pedidos, facturas, movimientos, etc.) y no se puede borrar
    // sin perder ese historial.
    if (err?.code === '23503') {
      toast('No se puede eliminar: este producto ya tiene stock, pedidos o movimientos asociados. Marcalo como inactivo en su lugar.', 'error');
    } else {
      toast('No se pudo eliminar el producto. Probá de nuevo en un momento.', 'error');
    }
  }
}

/* ── Editar columnas ── */
function editarColumnas() {
  alert('Personalización de columnas disponible próximamente.');
}

/* ── Alertas (desde la topbar) ── */
function verAlertas() {
  if (!contadores.total_sin_stock) { toast('No hay productos sin stock.', 'info'); return; }
  filtroEstado = 'sin_stock';
  const sel = document.getElementById('prod-filtro-estado');
  if (sel) sel.value = 'sin_stock';
  recargarConFiltro();
}

/* ── Exportar CSV ──────────────────────────────────────────────────────────
   Auditoría filtros v280: ya no existe un array completo en memoria
   (productosAll/productosFilt) — solo tenemos la página actual
   (productosPage), resuelta por fn_productos_lista con LIMIT/OFFSET.
   Exportamos lo que el usuario está viendo en pantalla (la página actual,
   ya filtrada/ordenada). Si se necesita exportar TODO el resultado
   filtrado (no solo la página visible), habría que pedirle a
   fn_productos_lista un p_limit alto y armar el CSV con esa respuesta. ── */
function exportarProductos() {
  const lista = productosPage;
  if (!lista.length) { toast('No hay productos para exportar.', 'warning'); return; }

  const cols = ['Nombre', 'Categoría', 'Estado', 'Última Actualización', 'Precio', 'Costo', 'Stock', 'Margen%', 'Goal%'];
  const filas = lista.map(p => [
    p.nombre, p.cat, p.estado, formatFecha(p.fechaAct),
    p.precio, p.costo, p.stock, p.margen, p.goal
  ]);
  const csv = [cols, ...filas]
    .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `productos_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`${lista.length} productos exportados correctamente.`, 'success');
}

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
}

/* ── DOMContentLoaded ── */
document.addEventListener('DOMContentLoaded', () => {
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
      });
  } else {
    // Fallback: auth-ready.js no cargó (raro), arrancar en modo demo
    console.warn('[productos] window.authReady no disponible, cargando en modo demo.');
    init(null);
  }
});

/* ── Receta (BOM) — v343: insumos que se descuentan automáticamente al
   producir este producto vía "Producción propia" en Stock (tabla
   producto_insumos + RPC producir_con_insumos). ──────────────────────── */
let recetaProductoInsumos = [];

async function abrirModalReceta() {
  if (!modalProductoId) return; // solo tiene sentido para un producto ya guardado
  if (!sb) { toast('No hay conexión con la base de datos (modo demo).', 'warning'); return; }

  const p = productosPage.find(x => x.id === modalProductoId);
  document.getElementById('modal-receta-subtitulo').textContent = p ? p.nombre : '';

  await Promise.all([cargarInsumosDisponibles(), cargarRecetaProducto()]);

  document.getElementById('modal-backdrop-receta').style.display = 'block';
  document.getElementById('modal-receta').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function cerrarModalReceta() {
  document.getElementById('modal-backdrop-receta').style.display = 'none';
  document.getElementById('modal-receta').classList.remove('open');
  document.body.style.overflow = '';
}

async function cargarInsumosDisponibles() {
  const sel = document.getElementById('receta-select-insumo');
  if (!sel) return;
  const { data, error } = await sb
    .from('productos')
    .select('id, nombre, unidad')
    .eq('empresa_id', empresaData?.id)
    .eq('activo', true)
    .neq('id', modalProductoId)
    .order('nombre');
  if (error) { console.error('[productos] insumos disponibles:', error); return; }
  sel.innerHTML = (data || [])
    .map(pr => `<option value="${pr.id}">${escHtml(pr.nombre)}${pr.unidad ? ` (${escHtml(pr.unidad)})` : ''}</option>`)
    .join('') || '<option value="">No hay otros productos activos para usar como insumo</option>';
}

async function cargarRecetaProducto() {
  const { data, error } = await sb
    .from('producto_insumos')
    .select('id, insumo_id, cantidad_por_unidad, productos:insumo_id(nombre, unidad)')
    .eq('producto_terminado_id', modalProductoId)
    .order('created_at');
  if (error) { console.error('[productos] receta:', error); recetaProductoInsumos = []; }
  else recetaProductoInsumos = data || [];
  renderRecetaLista();
}

function renderRecetaLista() {
  const cont = document.getElementById('receta-lista');
  if (!cont) return;
  if (!recetaProductoInsumos.length) {
    cont.innerHTML = '<p style="font-size:12.5px;color:var(--color-text-muted);margin:0">Todavía no cargaste insumos para este producto.</p>';
    return;
  }
  cont.innerHTML = recetaProductoInsumos.map(ri => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--color-border, #C7BFA9);border-radius:8px">
      <span style="font-size:13px">
        <strong>${fmt(ri.cantidad_por_unidad)}</strong> ${escHtml(ri.productos?.unidad || 'u')} de ${escHtml(ri.productos?.nombre || 'insumo')}
      </span>
      <button type="button" class="prod-menu-btn" aria-label="Quitar insumo" onclick="btnAsyncClick(this, () => eliminarInsumoReceta('${ri.id}'))">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

async function agregarInsumoReceta() {
  const insumoId  = document.getElementById('receta-select-insumo').value;
  const cantidad  = parseInt(document.getElementById('receta-input-cantidad').value, 10);
  if (!insumoId) { toast('Elegí un insumo', 'warning'); return; }
  if (isNaN(cantidad) || cantidad <= 0) { toast('Ingresá una cantidad entera por unidad, mayor a cero', 'warning'); return; }

  const { error } = await sb.from('producto_insumos').upsert({
    empresa_id: empresaData?.id,
    producto_terminado_id: modalProductoId,
    insumo_id: insumoId,
    cantidad_por_unidad: cantidad,
  }, { onConflict: 'producto_terminado_id,insumo_id' });

  if (error) { toast('No se pudo agregar el insumo: ' + error.message, 'error'); return; }

  document.getElementById('receta-input-cantidad').value = '';
  await cargarRecetaProducto();
  toast('Insumo agregado a la receta', 'success');
}

async function eliminarInsumoReceta(id) {
  const { error } = await sb.from('producto_insumos').delete().eq('id', id);
  if (error) { toast('No se pudo quitar el insumo: ' + error.message, 'error'); return; }
  await cargarRecetaProducto();
}

function fmt(n) {
  const num = Number(n) || 0;
  return num % 1 === 0 ? String(num) : num.toFixed(3).replace(/\.?0+$/, '');
}

// ── Auto-carga de imágenes ──────────────────────────────────────────────
// Llama a /api/auto-imagenes en lotes chicos hasta que no queden productos
// sin foto_url. Cada lote procesa lo que puede: los que no encontraron
// match quedan con foto_url = null a propósito (la ficha del producto
// muestra el ícono de la categoría como respaldo, no una URL inventada).
//
// v2 (post-confusión con el confirm() nativo): antes esto era un
// confirm()/toast() de una sola pasada, sin forma de frenar a mitad de
// camino ni de deshacer si tocabas la opción equivocada por error. Ahora:
//   1) elegirModoImagenes() — modal propio con las dos opciones bien
//      diferenciadas en vez de un bloque de texto en un confirm() nativo.
//   2) mostrarProgresoImagenes() — panel con botón "Detener" que corta el
//      proceso antes de arrancar el siguiente lote (no cancela un lote ya
//      en vuelo, pero no arranca uno nuevo).
//   3) mostrarResultadoImagenes() — resumen final con botón "Deshacer esta
//      búsqueda", que revierte SOLO los productos tocados en esta corrida
//      (vuelve foto_url a null y borra el archivo subido al bucket).
async function buscarImagenesAutomaticas() {
  const token = await getToken();
  if (!token) { toast('No se pudo verificar la sesión.', 'error'); return; }

  const contadorPrevio = await obtenerContadorSerper(token);
  const modo = await elegirModoImagenes(contadorPrevio);
  if (!modo) return; // el usuario cerró/canceló el modal, no se hace nada

  // v394: se sacó la opción de banco genérico (Pexels) por completo — solo
  // queda el opt-in de foto real por nombre (Serper), además de la Capa 1
  // de código de barras que siempre está activa.
  const incluirBusquedaReal = modo === 'con_busqueda_real';
  const progreso = mostrarProgresoImagenes();

  let totalConFoto = 0;
  let totalConFotoBusqueda = 0;
  let totalProcesados = 0;
  let restantes = null;
  let tandas = 0;
  let detenidoPorUsuario = false;
  let errorMsg = null;
  let contadorSerper = contadorPrevio;
  const productosTocados = []; // [{id, fuente}] — para poder deshacer solo esto
  // v397: IDs de productos ya intentados en ESTA corrida (con o sin match).
  // Sin esto, un producto que no matchea en ninguna capa se queda con
  // foto_url null para siempre y la query del backend lo vuelve a traer en
  // cada tanda del loop — el loop nunca converge porque "restantes" (el
  // total de la empresa sin foto) no baja. Se manda de vuelta en cada POST
  // para que el backend lo excluya y el próximo lote siempre traiga
  // productos nuevos. Ver auto-imagenes.js, nota en procesarLote().
  const excluirIds = [];

  do {
    if (progreso.fueDetenido()) { detenidoPorUsuario = true; break; }

    tandas++;
    progreso.actualizar({ fase: 'procesando', tandas, totalConFoto, totalProcesados });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55_000); // por debajo del límite de 60s de la función

    let r;
    try {
      r = await fetch('/api/auto-imagenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lote: 8, incluirBusquedaReal, excluirIds }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      errorMsg = err?.name === 'AbortError'
        ? `Se colgó el lote #${tandas} (más de 55s sin respuesta). Se detuvo el proceso — podés reintentar, va a seguir desde donde quedó.`
        : 'Error de red buscando imágenes. Se detuvo el proceso.';
      break;
    }
    clearTimeout(timeoutId);

    const d = await r.json().catch(() => null);

    // El backend limita a 20 lotes por minuto por IP (rate-limit.js) — con
    // catálogos grandes (varios cientos de productos) es normal pisar ese
    // límite antes de terminar. Antes esto cortaba el proceso entero como
    // si fuera un error fatal; ahora se espera el tiempo que indica el
    // propio backend (header Retry-After) y se reintenta el mismo lote,
    // sin perder lo ya procesado ni molestar a la persona con un error por
    // algo que se resuelve solo en unos segundos.
    if (r.status === 429) {
      const esperaSeg = Number(r.headers.get('Retry-After')) || 5;
      progreso.actualizar({
        fase: 'esperando',
        tandas, totalConFoto, totalProcesados,
        mensaje: `Pausando ${esperaSeg}s (límite de solicitudes por minuto) antes de seguir...`,
      });
      await new Promise(resolve => setTimeout(resolve, (esperaSeg + 1) * 1000));
      tandas--; // este intento no contó como lote real, se reintenta
      continue;
    }

    if (!r.ok || !d?.ok) {
      errorMsg = d?.error || `No se pudo completar la búsqueda de imágenes (lote #${tandas}).`;
      break;
    }

    for (const item of d.detalle || []) {
      excluirIds.push(item.id); // ya se intentó en esta corrida, no se vuelve a pedir
      if (item.resultado === 'ok') {
        productosTocados.push({ id: item.id, fuente: item.fuente || null });
        // v396: la Capa 2 ahora puede devolver 'busqueda_web_mercadolibre'
        // (etapa 1, restringida a ML) o 'busqueda_web' (etapa 2, general) —
        // ambas cuentan para el resumen, la distinción es solo interna/debug.
        if (item.fuente === 'busqueda_web' || item.fuente === 'busqueda_web_mercadolibre') totalConFotoBusqueda++;
      }
    }

    totalConFoto    += d.con_foto;
    totalProcesados += d.procesados;
    restantes = d.restantes;
    if (d.contadorSerper?.usados != null) contadorSerper = d.contadorSerper.usados;

    if (d.procesados === 0) break; // nada más para procesar

    // Pequeño respiro entre lotes para no pisar el límite de 20/min del
    // backend en catálogos grandes (con lote=8, 20/min alcanza para ~160
    // productos/min sin pausa — con este delay se reparte mejor y hace
    // falta pausar por 429 con mucha menos frecuencia).
    if (restantes > 0) await new Promise(resolve => setTimeout(resolve, 1500));
  } while (restantes > 0);

  progreso.cerrar();
  await cargarProductos();

  await mostrarResultadoImagenes({
    detenidoPorUsuario,
    errorMsg,
    totalConFoto,
    totalConFotoBusqueda,
    totalProcesados,
    productosTocados,
    contadorSerper,
    token,
  });
}

// v395: consulta liviana (GET) al mismo endpoint solo para leer cuántas
// consultas a Serper se llevan hechas hasta ahora — no dispara ninguna
// búsqueda. Si falla (red, permisos), no bloquea el flujo: se muestra el
// modal igual, simplemente sin el dato del contador.
async function obtenerContadorSerper(token) {
  try {
    const r = await fetch('/api/auto-imagenes', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d?.contadorSerper?.usados ?? null;
  } catch {
    return null;
  }
}

// Modal de elección (reemplaza el confirm() nativo). Devuelve
// 'solo_barcode' | 'con_busqueda_real' | null (null = canceló).
//
// v394: se sacó la tarjeta de "banco de fotos genérico" (Pexels) por
// completo — devolvía imágenes representativas, no la foto real del
// producto, y terminaba siendo la única capa que corría en la práctica.
// Ahora solo hay dos niveles: código de barras (match exacto) y foto real
// por nombre (búsqueda web vía Serper) — lo que no matchea en ninguno de
// los dos queda con el ícono de categoría, sin excepción.
function elegirModoImagenes(contadorPrevio) {
  return new Promise((resolve) => {
    // v395: aviso informativo del contador interno de uso de Serper — no es
    // el saldo exacto de la cuenta (eso solo lo tiene serper.dev), es una
    // referencia aproximada para no arrancar una corrida grande a ciegas.
    const avisoContador = (contadorPrevio == null) ? '' : `
      <div style="font-size:11.5px;color:var(--color-text-muted);background:rgba(0,0,0,.03);
                  border-radius:var(--radius-sm,6px);padding:7px 10px;margin-bottom:14px;line-height:1.4">
        📊 Consultas a Serper registradas hasta ahora: <strong>${contadorPrevio}</strong>
        de las 2.500 gratis iniciales (conteo interno aproximado, no el saldo exacto de la cuenta).
      </div>`;

    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="ei-titulo"
           style="position:fixed;inset:0;z-index:var(--z-modal,400);
                  display:flex;align-items:center;justify-content:center;
                  background:rgba(0,0,0,.45);padding:1rem">
        <div style="background:var(--color-surface);border-radius:var(--radius-lg);
                    padding:1.5rem;max-width:480px;width:100%;box-shadow:var(--shadow-xl)">
          <h3 id="ei-titulo" style="margin:0 0 4px;font-size:17px;font-weight:700;color:var(--color-text)">
            Buscar imágenes automáticamente
          </h3>
          <p style="margin:0 0 16px;font-size:13px;color:var(--color-text-muted);line-height:1.45">
            Elegí cómo buscar. Podés detener el proceso en cualquier momento y también deshacerlo
            al final si el resultado no te convence.
          </p>
          ${avisoContador}
          <button type="button" data-action="solo_barcode" style="all:unset;box-sizing:border-box;display:block;width:100%;
                    text-align:left;padding:14px;margin-bottom:10px;border-radius:var(--radius-md);
                    border:1.5px solid var(--color-primary);background:rgba(0,0,0,.015);cursor:pointer">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:16px">📷</span>
              <strong style="font-size:14px;color:var(--color-text)">Solo código de barras</strong>
              <span style="margin-left:auto;font-size:10px;font-weight:700;text-transform:uppercase;
                    color:var(--color-primary);background:var(--color-primary-bg,rgba(232,160,0,.14));padding:3px 7px;border-radius:999px">
                Más confiable
              </span>
            </div>
            <div style="font-size:12.5px;color:var(--color-text-muted);line-height:1.4">
              Usa la foto real del producto por match exacto de código de barras. Lo que no
              tiene match real queda con el ícono de categoría, sin fotos inventadas.
            </div>
          </button>

          <button type="button" data-action="con_busqueda_real" style="all:unset;box-sizing:border-box;display:block;width:100%;
                    text-align:left;padding:14px;margin-bottom:16px;border-radius:var(--radius-md);
                    border:1.5px solid rgba(0,0,0,.1);cursor:pointer">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:16px">🔍</span>
              <strong style="font-size:14px;color:var(--color-text)">+ Buscar foto real por nombre</strong>
              <span style="margin-left:auto;font-size:10px;font-weight:700;text-transform:uppercase;
                    color:var(--color-success,#17402F);background:var(--color-success-bg,#DCEDE3);padding:3px 7px;border-radius:999px">
                Recomendado
              </span>
            </div>
            <div style="font-size:12.5px;color:var(--color-text-muted);line-height:1.4">
              Para los productos sin match por código, busca en la web la foto real del producto
              puntual por nombre (sitios de venta, fabricantes) — no usa banco de fotos genérico.
              Lo que tampoco matchea acá queda con el ícono de categoría.
            </div>
          </button>

          <div style="display:flex;justify-content:flex-end">
            <button data-action="cancel" class="btn btn--ghost btn--sm">Cancelar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(null); };

    function cleanup(result) {
      document.removeEventListener('keydown', onKeydown);
      document.body.removeChild(overlay);
      resolve(result);
    }

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'cancel') return cleanup(null);
      cleanup(action); // 'solo_barcode' | 'con_busqueda_real'
    });

    document.addEventListener('keydown', onKeydown);
  });
}

// Panel de progreso con botón "Detener". No usa Promise porque conviene
// poder actualizarlo en vivo desde el loop de lotes; expone
// { actualizar(info), fueDetenido(), cerrar() }.
function mostrarProgresoImagenes() {
  let detenido = false;

  const overlay = document.createElement('div');
  overlay.innerHTML = `
    <div role="status" aria-live="polite"
         style="position:fixed;inset:0;z-index:var(--z-modal,400);
                display:flex;align-items:center;justify-content:center;
                background:rgba(0,0,0,.45);padding:1rem">
      <div style="background:var(--color-surface);border-radius:var(--radius-lg);
                  padding:1.5rem;max-width:380px;width:100%;box-shadow:var(--shadow-xl);text-align:center">
        <div style="width:36px;height:36px;margin:0 auto 14px;border-radius:50%;
                    border:3px solid rgba(0,0,0,.08);border-top-color:var(--color-primary);
                    animation:ei-spin 0.8s linear infinite"></div>
        <style>@keyframes ei-spin { to { transform: rotate(360deg); } }</style>
        <h3 style="margin:0 0 6px;font-size:15px;font-weight:700;color:var(--color-text)">
          Buscando imágenes…
        </h3>
        <p id="ei-progreso-texto" style="margin:0 0 16px;font-size:12.5px;color:var(--color-text-muted);line-height:1.4">
          Arrancando…
        </p>
        <button type="button" data-action="detener" class="btn btn--ghost btn--sm">Detener</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('[data-action="detener"]').addEventListener('click', () => {
    detenido = true;
    const p = overlay.querySelector('#ei-progreso-texto');
    if (p) p.textContent = 'Deteniendo… termina el lote actual y para.';
  });

  return {
    fueDetenido: () => detenido,
    actualizar: ({ tandas, totalConFoto, totalProcesados, mensaje }) => {
      const p = overlay.querySelector('#ei-progreso-texto');
      if (p) p.textContent = mensaje || `Tanda ${tandas} — ${totalConFoto}/${totalProcesados} productos con foto hasta ahora.`;
    },
    cerrar: () => { if (overlay.isConnected) document.body.removeChild(overlay); },
  };
}

// Resumen final con opción de deshacer SOLO lo tocado en esta corrida.
function mostrarResultadoImagenes({ detenidoPorUsuario, errorMsg, totalConFoto, totalConFotoBusqueda, totalProcesados, productosTocados, contadorSerper, token }) {
  return new Promise((resolve) => {
    let estado = 'resultado'; // 'resultado' | 'deshecho'

    const tituloInicial = errorMsg
      ? 'Se detuvo por un error'
      : detenidoPorUsuario
        ? 'Búsqueda detenida'
        : 'Búsqueda completada';

    const detalleFuente = totalConFotoBusqueda > 0
      ? `<div style="font-size:12px;color:var(--color-text-muted);margin-top:4px">
           Incluye ${totalConFotoBusqueda} imagen${totalConFotoBusqueda === 1 ? '' : 'es'} encontrada${totalConFotoBusqueda === 1 ? '' : 's'} por nombre (búsqueda web) — conviene revisarlas.
         </div>`
      : '';

    // v395: solo tiene sentido mostrar el contador si esta corrida usó la
    // Capa 2 (Serper) — con "solo código de barras" no se consumió nada.
    const detalleContador = (contadorSerper != null && totalConFotoBusqueda > 0)
      ? `<div style="font-size:11.5px;color:var(--color-text-muted);margin-top:8px">
           📊 Consultas a Serper acumuladas: <strong>${contadorSerper}</strong> (conteo interno aproximado).
         </div>`
      : '';

    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="ei-res-titulo"
           style="position:fixed;inset:0;z-index:var(--z-modal,400);
                  display:flex;align-items:center;justify-content:center;
                  background:rgba(0,0,0,.45);padding:1rem">
        <div style="background:var(--color-surface);border-radius:var(--radius-lg);
                    padding:1.5rem;max-width:400px;width:100%;box-shadow:var(--shadow-xl)">
          <h3 id="ei-res-titulo" style="margin:0 0 8px;font-size:16px;font-weight:700;color:var(--color-text)">
            ${tituloInicial}
          </h3>
          <div id="ei-res-cuerpo">
            <p style="margin:0;font-size:13.5px;color:var(--color-text);line-height:1.5">
              ${errorMsg ? escHtml(errorMsg) : `${totalConFoto} de ${totalProcesados} producto${totalProcesados === 1 ? '' : 's'} consiguieron imagen automáticamente.`}
            </p>
            ${errorMsg ? '' : detalleFuente}
            ${errorMsg ? '' : detalleContador}
          </div>
          <div id="ei-res-acciones" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
            ${productosTocados.length > 0 ? '<button data-action="deshacer" class="btn btn--danger btn--sm">Deshacer esta búsqueda</button>' : ''}
            <button data-action="cerrar" class="btn btn--primary btn--sm">Cerrar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;

      if (action === 'cerrar') {
        document.body.removeChild(overlay);
        resolve();
        return;
      }

      if (action === 'deshacer' && estado === 'resultado') {
        const btn = e.target.closest('[data-action="deshacer"]');
        btn.disabled = true;
        btn.textContent = 'Deshaciendo…';
        const okCount = await deshacerBusquedaImagenes(productosTocados, token);
        estado = 'deshecho';
        overlay.querySelector('#ei-res-titulo').textContent = 'Búsqueda deshecha';
        overlay.querySelector('#ei-res-cuerpo').innerHTML = `
          <p style="margin:0;font-size:13.5px;color:var(--color-text);line-height:1.5">
            Se revirtieron ${okCount} de ${productosTocados.length} producto${productosTocados.length === 1 ? '' : 's'}
            a "sin foto". Podés volver a intentar cuando quieras.
          </p>`;
        overlay.querySelector('#ei-res-acciones').innerHTML =
          '<button data-action="cerrar" class="btn btn--primary btn--sm">Cerrar</button>';
        await cargarProductos();
      }
    });
  });
}

// Revierte foto_url a null y borra el archivo del bucket, solo para los
// productos tocados en la corrida actual (no toca fotos cargadas antes).
async function deshacerBusquedaImagenes(productosTocados, token) {
  if (!productosTocados.length) return 0;

  const ids = productosTocados.map(p => p.id);

  const { error: errUpdate } = await sb.from('productos')
    .update({ foto_url: null, foto_fuente: null })
    .in('id', ids);

  if (errUpdate) {
    toast('No se pudo deshacer la búsqueda. Probá de nuevo.', 'error');
    return 0;
  }

  // Borrado de los archivos del bucket (best-effort: si falla el storage,
  // el producto igual queda sin foto_url, que es lo que importa para el catálogo).
  if (empresaData?.id) {
    const paths = ids.map(id => `${empresaData.id}/${id}.jpg`);
    try { await sb.storage.from('productos-fotos').remove(paths); } catch (_) { /* best-effort */ }
  }

  toast(`Se deshizo la búsqueda: ${ids.length} producto${ids.length === 1 ? '' : 's'} volvió a quedar sin foto.`, 'success');
  return ids.length;
}

async function getToken() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || '';
}
