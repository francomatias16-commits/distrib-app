// frontend/admin/js/productos/carga-datos.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Carga de datos server-side: cargarProductos (RPC fn_productos_lista), contadores, categorías, depósitos del modal, normalización de RPC, datos demo estáticos.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';


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
      const { data, error } = await window.conTimeoutRed(sb.rpc('fn_productos_lista', {
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
        p_etiqueta_id:  filtroEtiquetaId || null,
      }), 10000);
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
      const { data, error } = await window.conTimeoutRed(sb.rpc('fn_productos_contadores'), 10000);
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
    const { data, error } = await window.conTimeoutRed(sb
      .from('categorias')
      .select('id, nombre')
      .eq('empresa_id', empresaData.id)
      .eq('activa', true)
      .order('nombre'), 10000);
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
    const { data, error } = await window.conTimeoutRed(sb
      .from('depositos')
      .select('id, nombre, es_principal')
      .eq('empresa_id', empresaData.id)
      .order('nombre'), 10000);
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
  const stockObjetivo = Number(p.stock_objetivo ?? 0);
  const margen = precio > 0 && costo > 0 ? Math.round(((precio - costo) / precio) * 100) : 0;
  const goal   = stockMin > 0 ? Math.min(100, Math.round((stock / (stockMin * 3)) * 100)) : 0;

  return {
    id:           p.id,
    codigo:       p.codigo || '',
    nombre:       p.nombre || '(sin nombre)',
    cat:          p.categoria_nombre || '—',
    categoriaId:  p.categoria_id || '',
    activo:       p.activo !== false,
    destacado:    p.destacado === true,
    estado:       p.estado || 'borrador',
    fechaAct:     p.updated_at || p.created_at || null,
    precio,
    costo,
    stockMinimo:  stockMin,
    stockObjetivo,
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
