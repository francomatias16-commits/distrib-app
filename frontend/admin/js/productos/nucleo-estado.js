// frontend/admin/js/productos/nucleo-estado.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Cliente Supabase, estado global (filtros, paginación, selección de etiquetas), paleta de colores por categoría, utilidades de formato (escHtml, formatPeso, formatFecha, iniciales, donutSVG, estadoBadge, toast).
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

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
let busquedaTag    = '';
let filtroEstado   = '';
let filtroCatId    = '';   // ahora es el id de categoría, no el nombre
let filtroFoto     = '';   // 'real' | 'generica' | 'sin_foto' | '' (sin filtro) — v392
let filtroEtiquetaId = ''; // id de etiqueta (Etiquetas, v473/474) | '' (sin filtro)
let ordenCol       = 'nombre';
let ordenAsc       = true;
let _page          = 1;
const PAGE_SIZE    = 50;
let _cargaEnCurso  = null; // evita carreras si el usuario tipea/filtra rápido

/* ── Selección múltiple para "Generar etiquetas" (543, Etapa 2) ──────────
   Set de ids de producto, persiste entre páginas/filtros (igual criterio
   que un carrito: el usuario puede tildar productos en la página 1, pasar
   a la página 2 y seguir sumando sin perder lo ya elegido). Se vacía solo
   al cerrar la vista previa de impresión o con "Cancelar selección". ── */
let seleccionEtiquetas = new Set();
let seleccionandoTodosResultados = false; // evita doble click mientras trae los ids de todas las páginas

// Mismo tope que MAX_IDS_ETIQUETAS en lib/handlers/etiquetas.js — una
// selección más grande que eso ya no entra en un solo POST /api/etiquetas/productos.
const MAX_IDS_ETIQUETAS = 500;

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
  const color = pct >= 40 ? 'var(--color-info-mid,#33507A)' : pct >= 20 ? 'var(--color-warning-mid,#E0A53E)' : 'var(--color-danger-mid,#D1594A)';
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
    'borrador':  { cls: 'borrador',  label: 'Inactivo' },
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
