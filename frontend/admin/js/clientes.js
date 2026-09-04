// frontend/admin/js/clientes.js — v39 (sin fugas de memoria)
// MIGRACIÓN v39: renderTbody (DocumentFragment), toast() de admin-utils


// Optimizado para Etapa 6: Paginación y Performance

// ── Config ─────────────────────────────────────────────────────────────────
// sb se obtiene en init() una vez que authCtx esté listo
// Helper: siempre obtiene un token fresco (evita tokens vencidos en sesiones largas)
async function getFreshToken() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || '';
}

let sb = null;

// ── Estado ─────────────────────────────────────────────────────────────────
let usuario      = null;
let empresaData  = null;
let clientesData = [];
let filtrados    = [];
let zonas        = [];
let listas       = [];
let vendedores   = [];
let filtroEstado = '';

// Paginación
let paginaActual = 1;
const itemsPorPagina = 50;
let totalResultados = 0;

let modalClienteId = null;   // null = nuevo, uuid = edición

// ── Ver catálogo tal como lo ve un cliente ──────────────────────────────────
// FIX v477 (el botón abría la página pero el catálogo quedaba vacío / no
// cargaba): el comentario de acá abajo daba por hecho que el catálogo público
// "no requiere sesión, alcanza con ?empresa_id=". Eso dejó de ser así desde
// SEC-008 (ver supabase/migrations/292_fix_sec008_gate_catalogo_publico.sql
// y CHANGELOG_v296): el modo sin-login ahora exige que la empresa tenga
// habilitado explícitamente config.catalogo_publico_habilitado — pensado
// para compartir el link con clientes potenciales, opt-in por empresa. La
// gran mayoría de las empresas NO tiene ese flag activado (es a propósito,
// hay que prenderlo aparte), así que el botón caía siempre en ese camino
// vacío.
//
// El propio SEC-008 dejó una puerta explícitamente abierta para esto: "Sesión
// autenticada (Bearer token) sigue funcionando igual que siempre, sin
// cambios". Como el dueño/admin YA es un usuario autenticado de su propia
// empresa, alcanza con que el catálogo reciba su token de acceso — el
// backend (resolverEmpresaCliente) lo resuelve por sesión real, sin pasar
// por el gate del modo público. Se manda en el fragmento (#) de la URL, no
// en el query string: el fragmento nunca viaja al servidor (no queda en
// logs de Vercel/Supabase ni en el header Referer), a diferencia de un
// query param. catalogo.html lo lee, lo usa como Authorization Bearer en sus
// fetch, y limpia la URL de la barra de inmediato.
async function verCatalogoCliente() {
  if (!empresaData?.id) return;
  let token = '';
  try {
    const { data: { session } } = await sb.auth.getSession();
    token = session?.access_token || '';
  } catch (_e) { /* si falla, se abre igual en modo público (mejor que nada) */ }

  const url = `/cliente/catalogo?empresa_id=${empresaData.id}`
    + (token ? `#preview_token=${encodeURIComponent(token)}` : '');
  window.open(url, '_blank');
}
// FIX v477: clientes.js se carga como <script type="module">, así que las
// funciones top-level NO quedan expuestas en window por defecto (a diferencia
// de un <script> normal). El onclick="verCatalogoCliente()" del botón vive en
// el scope global del HTML, por eso nunca encontraba la función y el botón no
// generaba ningún evento. El resto de las funciones usadas desde onclick en
// este archivo sí se exportan más abajo (ver bloque "window.xxx = xxx");
// esta se había quedado afuera.
window.verCatalogoCliente = verCatalogoCliente;

// ── Inicialización ─────────────────────────────────────────────────────────
async function init() {
  sb          = window.authCtx.sb;
  usuario     = window.authCtx.perfil;
  empresaData = window.authCtx.perfil?.empresas || {
    id: window.authCtx.perfil?.empresa_id,
    nombre: '',
    config: {}
  };
  if (!empresaData?.id) {
    console.error('[clientes] empresa_id no disponible — verificar que el usuario tenga empresa_id en la tabla usuarios');
    const tbody = document.getElementById('tabla-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--color-danger)">Error: no se pudo obtener la empresa del usuario. Contactar soporte.</td></tr>';
    return;
  }

  // Deep-link desde otras pantallas (ej. "Resolver" en las alertas de
  // confianza del dashboard): ?filter=riesgo activa el filtro correspondiente,
  // ?id=<uuid> abre directo la ficha de ese cliente.
  const urlParams  = new URLSearchParams(window.location.search);
  const filterParam = urlParams.get('filter');
  if (filterParam) {
    filtroEstado = filterParam;
  }

  // Inyectar controles de paginación (envuelto en try por si falla el DOM)
  try { inyectarControlesPaginacion(); } catch(e) { console.warn('[clientes] paginacion init:', e.message); }

  // Buscador con debounce (250ms, mismo criterio que busqueda-global.js) en vez
  // de oninput inline: ahora que el fix filtra contra Supabase, disparar una
  // query por cada tecla sería innecesario y lento.
  const inputBusqueda = document.getElementById('input-busqueda');
  if (inputBusqueda) {
    let debounceBusquedaClientes = null;
    inputBusqueda.addEventListener('input', () => {
      clearTimeout(debounceBusquedaClientes);
      debounceBusquedaClientes = setTimeout(() => aplicarFiltros(), 250);
    });
  }

  try {
    await Promise.all([cargarZonas(), cargarListas(), cargarVendedores(), cargarClientes()]);
  } catch(e) {
    console.error('[clientes] Error en carga inicial:', e);
    const tbody = document.getElementById('tabla-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--color-danger)">Error al cargar datos: ' + e.message + '</td></tr>';
    return;
  }

  if (filterParam) {
    const pill = document.querySelector(`.e-pill[data-f="${filterParam}"]`);
    if (pill) {
      document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
      pill.classList.add('activa');
    }
  }

  const idParam = urlParams.get('id');
  if (idParam) {
    abrirModalEditar(idParam);
  }

  // Deep-link desde el viejo /admin/listas-precio (ahora redirect, ver
  // vercel.json) y desde cualquier link guardado que apuntaba a esa
  // pantalla — mismo criterio que ?tab=zonas en rutas.js.
  if (urlParams.get('tab') === 'listas') {
    cambiarVista('listas');
  }

  // No bloquea la carga principal: es solo para mostrar/ocultar el botón
  // "Geocodificar pendientes" si hay clientes con domicilio sin coordenadas.
  refrescarContadorGeocodificacion();
}

// ── Dropdown "Más acciones" del topbar (Exportar / Geocodificar pendientes) ─
// El botón tiene 2 modos:
//  - "menu": hay 2+ acciones disponibles (Geocodificar pendientes + Exportar)
//    → se comporta como dropdown, con el label "Más acciones" y chevron.
//  - "directo": solo Exportar está disponible (caso normal, sin pendientes
//    de geocodificar) → el botón deja de ser un dropdown y pasa a ser un
//    botón de acción directa con el label "Exportar", sin chevron ni menú
//    (no tiene sentido un dropdown de una sola opción).
function actualizarModoBotonAcciones() {
  const btn = document.getElementById('btn-mas-acciones');
  const menu = document.getElementById('menu-mas-acciones');
  const iconExportar = document.getElementById('btn-mas-acciones-icon-exportar');
  const texto = document.getElementById('btn-mas-acciones-texto');
  const chevron = document.getElementById('btn-mas-acciones-chevron');
  if (!btn || !menu) return;

  const hayGeocodificarPendiente = _pendientesGeocodificar.length > 0;

  if (hayGeocodificarPendiente) {
    btn.dataset.modo = 'menu';
    btn.setAttribute('aria-haspopup', 'true');
    iconExportar.style.display = 'none';
    texto.textContent = 'Más acciones';
    chevron.style.display = '';
  } else {
    btn.dataset.modo = 'directo';
    btn.removeAttribute('aria-haspopup');
    btn.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    iconExportar.style.display = '';
    texto.textContent = 'Exportar';
    chevron.style.display = 'none';
  }
}

function iniciarMenuMasAcciones() {
  const btn  = document.getElementById('btn-mas-acciones');
  const menu = document.getElementById('menu-mas-acciones');
  if (!btn || !menu) return;

  const cerrar = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const abrir = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (btn.dataset.modo === 'directo') {
      // Botón de acción directa: no hay menú que abrir, se exporta de una.
      exportarExcel();
      return;
    }
    if (menu.hidden) abrir(); else cerrar();
  });
  btn.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') cerrar();
  });
  document.addEventListener('click', cerrar);
  menu.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Cierra el menú al elegir una opción (ambas acciones son "dispara y listo":
    // exportarExcel descarga el archivo, geocodificarPendientesLote abre su propio confirm()).
    if (ev.target.closest('.dropdown-item')) cerrar();
  });
}

// ── Geocodificación automática desde domicilio ──────────────────────────────

let _pendientesGeocodificar = [];

iniciarMenuMasAcciones();
actualizarModoBotonAcciones();

async function refrescarContadorGeocodificacion() {
  const btn = document.getElementById('btn-geocodificar-lote');
  if (!btn) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/geocodificar?_svc=geocodificar', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al consultar pendientes');
    _pendientesGeocodificar = data || [];
    if (_pendientesGeocodificar.length > 0) {
      document.getElementById('btn-geocodificar-lote-texto').textContent =
        `Geocodificar pendientes (${_pendientesGeocodificar.length})`;
      btn.style.display = 'flex';
    } else {
      btn.style.display = 'none';
    }
    actualizarModoBotonAcciones();
  } catch (err) {
    // Silencioso: no es crítico para el uso normal de la pantalla.
    console.warn('[clientes] No se pudo consultar pendientes de geocodificación:', err.message);
  }
}

/**
 * Geocodifica el cliente que está abierto en el modal (nuevo o existente)
 * a partir de los campos domicilio/localidad ya tipeados en el formulario.
 */
async function geocodificarClienteActual() {
  const domicilio = document.getElementById('f-domicilio')?.value?.trim();
  const localidad = document.getElementById('f-localidad')?.value?.trim();
  const status = document.getElementById('geocodificar-status');
  const btn = document.getElementById('btn-geocodificar');

  if (!domicilio) {
    window.toast('Cargá el domicilio antes de buscar las coordenadas');
    return;
  }

  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Buscando...';

  try {
    const token = await getFreshToken();
    const body = modalClienteId
      ? { cliente_id: modalClienteId }
      : { domicilio, localidad };

    const resp = await fetch('/api/clientes/geocodificar?_svc=geocodificar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al geocodificar');

    document.getElementById('f-lat').value = data.lat;
    document.getElementById('f-lng').value = data.lng;
    window._actualizarMapLink?.();

    if (status) status.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Ubicación encontrada';
    window.toast('Coordenadas encontradas a partir del domicilio');

    // Si era un cliente ya guardado, el backend ya persistió lat/lng —
    // refrescamos el contador de pendientes por si era el último.
    if (modalClienteId) refrescarContadorGeocodificacion();
  } catch (err) {
    if (status) status.textContent = '';
    console.error(err);
    window.toast('No se pudo obtener la ubicación a partir del domicilio', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Geocodifica en lote todos los clientes con domicilio pero sin lat/lng.
 * Procesa de a uno con una pequeña pausa entre llamadas (política de uso
 * de Nominatim: máx. 1 request/segundo).
 */
async function geocodificarPendientesLote() {
  if (_pendientesGeocodificar.length === 0) return;

  const btn = document.getElementById('btn-geocodificar-lote');
  const textoEl = document.getElementById('btn-geocodificar-lote-texto');
  const pendientes = [..._pendientesGeocodificar];

  if (!confirm(`Se va a buscar la ubicación de ${pendientes.length} cliente(s) a partir de su domicilio. ¿Continuar?`)) {
    return;
  }

  btn.disabled = true;
  const token = await getFreshToken();
  let ok = 0, fallidos = 0;

  for (let i = 0; i < pendientes.length; i++) {
    const cliente = pendientes[i];
    textoEl.textContent = `Geocodificando ${i + 1}/${pendientes.length}...`;
    try {
      const resp = await fetch('/api/clientes/geocodificar?_svc=geocodificar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cliente_id: cliente.id }),
      });
      if (resp.ok) ok++; else fallidos++;
    } catch {
      fallidos++;
    }
    // Respeta el límite de 1 request/segundo de Nominatim
    if (i < pendientes.length - 1) await new Promise(r => setTimeout(r, 1100));
  }

  btn.disabled = false;
  window.toast(`Geocodificación terminada: ${ok} encontrados, ${fallidos} sin resultado`);
  await cargarClientes();
  await refrescarContadorGeocodificacion();
}
window.geocodificarClienteActual = geocodificarClienteActual;
window.geocodificarPendientesLote = geocodificarPendientesLote;

function inyectarControlesPaginacion() {
    if (document.getElementById('paginacion-clientes')) return; // ya existe
    const contenedor = document.getElementById('contenido-principal')
                    || document.querySelector('main')
                    || document.querySelector('.content')
                    || document.body;
    if (!contenedor) return; // no hay dónde inyectar, salir silenciosamente
    const div = document.createElement('div');
    div.id = 'paginacion-clientes';
    div.className = 'paginacion-container';
    div.innerHTML = `
        <button id="btn-prev" class="btn-pag" onclick="cambiarPagina(-1)">Anterior</button>
        <span id="info-pag">Página 1</span>
        <button id="btn-next" class="btn-pag" onclick="cambiarPagina(1)">Siguiente</button>
    `;
    contenedor.appendChild(div);
}

// ── Carga de datos auxiliares ──────────────────────────────────────────────
async function cargarZonas() {
  const { data } = await sb.from('zonas')
    .select('id, nombre')
    .eq('empresa_id', empresaData.id)
    .order('nombre');
  zonas = data || [];
  const sel = document.getElementById('filtro-zona');
  const selF = document.getElementById('f-zona_id');
  
  // Limpiar antes de agregar para evitar duplicados en re-cargas
  sel.innerHTML = '<option value="">Todas las zonas</option>';
  selF.innerHTML = '<option value="">Seleccionar zona...</option>';
  
  zonas.forEach(z => {
    [sel, selF].forEach(s => {
      const o = document.createElement('option');
      o.value = z.id; o.textContent = z.nombre;
      s.appendChild(o);
    });
  });
}

// Permite crear una zona sin salir del formulario de cliente — evita el
// viaje ida y vuelta a "Zonas de reparto" cuando el select está vacío
// porque la empresa todavía no cargó ninguna.
window.crearZonaRapida = async function () {
  const nombre = (window.prompt('Nombre de la nueva zona (ej: Centro, Zona Norte):') || '').trim();
  if (!nombre) return;

  const btn = document.getElementById('btn-nueva-zona-rapida');
  if (btn) btn.disabled = true;
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/maestros?recurso=zonas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.toast(data.error || 'No se pudo crear la zona', 'error');
      return;
    }
    await cargarZonas();
    // Preseleccionar la zona recién creada en el form abierto
    const selF = document.getElementById('f-zona_id');
    if (selF && data.id) selF.value = data.id;
    window.toast(`Zona "${nombre}" creada`, 'exito');
  } catch (e) {
    window.toast('Error de conexión al crear la zona', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

async function cargarListas() {
  const { data } = await sb.from('listas_precios')
    .select('id, nombre, es_default')
    .eq('empresa_id', empresaData.id)
    .eq('activa', true)
    .order('nombre');
  listas = data || [];
  const sel = document.getElementById('f-lista_precio_id');
  sel.innerHTML = '<option value="">Por defecto de la empresa</option>';
  listas.forEach(l => {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.nombre + (l.es_default ? ' (por defecto)' : '');
    sel.appendChild(o);
  });
}

// ── Carga principal con Paginación ─────────────────────────────────────────
async function cargarVendedores() {
  const { data } = await sb.from('usuarios')
    .select('id, nombre, rol')
    .eq('empresa_id', empresaData.id)
    .in('rol', ['vendedor', 'admin', 'dueno'])
    .eq('activo', true)
    .order('nombre');
  vendedores = data || [];
  const sel = document.getElementById('f-vendedor_id_default');
  if (!sel) return;
  sel.innerHTML = '<option value="">Sin vendedor asignado</option>';
  vendedores.forEach(v => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.nombre + (v.rol !== 'vendedor' ? ` (${v.rol})` : '');
    sel.appendChild(o);
  });
}

// Trae un cliente puntual por id (usado para deep-links: alertas del
// dashboard, notificaciones, etc. que pueden apuntar a un cliente que no
// está en la página actualmente cargada).
async function obtenerClientePorId(id) {
  const { data, error } = await sb.from('clientes')
    .select(`*, zonas(nombre), listas_precios(nombre),
      scores_cliente(score_pagos, score_frecuencia, score_deuda, score_devolucion, created_at)`)
    .eq('id', id)
    .eq('empresa_id', empresaData.id)
    .maybeSingle();

  if (error || !data) {
    console.error('[clientes] obtenerClientePorId:', error?.message);
    return null;
  }

  const scores = data.scores_cliente;
  const ultimo = Array.isArray(scores) && scores.length
    ? scores.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    : null;
  return {
    ...data,
    score_pagos:      ultimo?.score_pagos      ?? null,
    score_frecuencia: ultimo?.score_frecuencia ?? null,
    score_deuda:      ultimo?.score_deuda      ?? null,
    score_devolucion: ultimo?.score_devolucion ?? null,
  };
}

async function cargarClientes() {
  const desde = (paginaActual - 1) * itemsPorPagina;
  const hasta = desde + itemsPorPagina - 1;

  window.mostrarSkeletonTabla('tabla-body', 8); // Mostrar skeleton antes de cargar

  let query = sb.from('clientes')
    .select(`*, zonas(nombre), listas_precios(nombre),
      scores_cliente(score_pagos, score_frecuencia, score_deuda, score_devolucion, created_at)`,
      { count: 'exact' })
    .eq('empresa_id', empresaData.id)
    .order('razon_social')
    .range(desde, hasta);

  // Aplicar filtros de base de datos si es posible para eficiencia
  const busq = document.getElementById('input-busqueda').value.trim();
  const zonaFiltro = document.getElementById('filtro-zona').value;

  if (busq) query = query.or(`razon_social.ilike.%${busq}%,nombre_fantasia.ilike.%${busq}%,cuit.ilike.%${busq}%`);
  if (zonaFiltro) query = query.eq('zona_id', zonaFiltro);
  if (filtroEstado === 'activo') query = query.eq('activo', true);
  if (filtroEstado === 'inactivo') query = query.eq('activo', false);
  if (filtroEstado === 'deuda') query = query.gt('saldo_deuda', 0);
  // 'riesgo' se mantiene como riesgo+bloqueado combinado (compatibilidad con
  // el deep-link ?filter=riesgo que ya usan las alertas de confianza del
  // dashboard). 'bloqueado' es un pill nuevo, más específico, que aísla solo
  // esa categoría — igual criterio que el select de riesgo-cheques.js.
  if (filtroEstado === 'riesgo') query = query.in('score_categoria', ['riesgo', 'bloqueado']);
  if (filtroEstado === 'premium') query = query.eq('score_categoria', 'premium');
  if (filtroEstado === 'bueno') query = query.eq('score_categoria', 'bueno');
  if (filtroEstado === 'bloqueado') query = query.eq('score_categoria', 'bloqueado');

  const { data, count, error } = await query;

  if (error) {
    console.error('[clientes] Error en query:', error);
    const tbody = document.getElementById('tabla-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--color-danger)">Error al cargar clientes: ${sanitize(error.message)}</td></tr>`;
    return;
  }
  
  // Aplanar el último registro de scores_cliente en cada cliente
  clientesData = (data || []).map(c => {
    const scores = c.scores_cliente;
    const ultimo = Array.isArray(scores) && scores.length
      ? scores.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
      : null;
    return {
      ...c,
      score_pagos:      ultimo?.score_pagos      ?? null,
      score_frecuencia: ultimo?.score_frecuencia ?? null,
      score_deuda:      ultimo?.score_deuda      ?? null,
      score_devolucion: ultimo?.score_devolucion ?? null,
    };
  });
  totalResultados = count || 0;
  
  actualizarInfoPaginacion();
  renderTabla();
}

function actualizarInfoPaginacion() {
    const totalPaginas = Math.ceil(totalResultados / itemsPorPagina);
    // Guards defensivos: los IDs existen en el HTML estático y también los crea
    // inyectarControlesPaginacion() como fallback. Si por timing no están listos, no lanzar null.
    const elInfo = document.getElementById('info-pag');
    const elPrev = document.getElementById('btn-prev');
    const elNext = document.getElementById('btn-next');
    if (elInfo) elInfo.textContent = `Página ${paginaActual} de ${totalPaginas || 1} (${totalResultados} clientes)`;
    if (elPrev) elPrev.disabled = paginaActual <= 1;
    if (elNext) elNext.disabled = paginaActual >= totalPaginas;
}

async function cambiarPagina(delta) {
    paginaActual += delta;
    await cargarClientes();
}

// ── Filtros ────────────────────────────────────────────────────────────────
async function aplicarFiltros() {
  paginaActual = 1; // Resetear a la primera página al filtrar
  await cargarClientes();
}

function selFiltroEstado(estado, btn) {
  filtroEstado = estado;
  document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
  btn.classList.add('activa');
  aplicarFiltros();
}

function limpiarFiltros() {
  document.getElementById('input-busqueda').value = '';
  document.getElementById('filtro-zona').value = '';
  filtroEstado = '';
  document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
  document.querySelector('.e-pill[data-f=""]').classList.add('activa');
  aplicarFiltros();
}

// ── Render tabla ───────────────────────────────────────────────────────────
function renderTabla() {
  const tbody = document.getElementById('tabla-body');
  if (!tbody) return;

  if (!clientesData.length) {
    window.mostrarEstadoVacio('tabla-body', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
      titulo: 'Sin clientes registrados',
      descripcion: 'No se encontraron clientes con los filtros aplicados.',
      ctaLabel: '+ Nuevo cliente',
      ctaOnClick: 'abrirModalNuevo()',
    });
    return;
  }
  window.renderTbody(tbody, clientesData, (c) => {
    const nombre  = c.nombre_fantasia || c.razon_social;
    const deuda   = Number(c.saldo_deuda || 0);
    const limite  = Number(c.limite_credito || 0);
    const deudaCls = deuda > limite && limite > 0 ? 'num-rojo' : deuda > 0 ? 'num-amarillo' : 'num-verde';

    return `
      <tr class="fila-cliente fila-clickeable${c.activo ? '' : ' fila-inactiva'}" data-testid="clientes-fila" data-id="${c.id}" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalEditar('${c.id}')">
        <td class="td-cliente" data-label="Cliente">
          <div class="cli-avatar">${iniciales(nombre)}</div>
          <div>
            <div class="cli-nombre">${escHtml(nombre)}</div>
            ${c.nombre_fantasia ? `<div class="cli-razon">${escHtml(c.razon_social)}</div>` : ''}
            ${c.localidad ? `<div class="cli-loc">${escHtml(c.localidad)}</div>` : ''}
          </div>
        </td>
        <td class="td-text" data-label="CUIT">${c.cuit || '—'}</td>
        <td class="td-text" data-label="Zona">${escHtml(c.zonas?.nombre || '—')}</td>
        <td class="td-text" data-label="Teléfono">${c.telefono ? `<a href="tel:${sanitize(c.telefono)}" class="tel-link">${escHtml(c.telefono)}</a>` : '—'}</td>
        <td class="td-num td-muted" data-label="Límite crédito">${limite > 0 ? formatPeso(limite) : '—'}</td>
        <td class="td-num ${deudaCls}" data-label="Saldo deuda">${deuda > 0 ? formatPeso(deuda) : (deuda < 0 ? `<span style="color:var(--color-success)">${formatPeso(Math.abs(deuda))} a favor</span>` : '<span style="color:var(--color-success)">Al día</span>')}</td>
        <td data-label="Estado">
          <span class="badge-estado ${c.activo ? 'badge-ok' : 'badge-critico'}">
            <span class="badge-dot"></span>${c.activo ? 'Activo' : 'Inactivo'}
          </span>
        </td>
        <td data-label="Confianza" class="td-score" ${c.score_actual != null ? `onclick="verScoreCliente('${c.id}')"` : ''}>
          ${c.score_actual != null
            ? (() => {
                const _frase = motivoFrase(c, c.score_categoria);
                return `<button class="score-badge-btn ${(SCORE_CATEGORIAS[c.score_categoria] || SCORE_CATEGORIAS.normal).cls}"
                   title="${_frase || 'Ver detalle de confianza'}">
                   ${(SCORE_CATEGORIAS[c.score_categoria] || SCORE_CATEGORIAS.normal).icono} ${c.score_actual}
                 </button>
                 ${_frase ? `<div class="score-motivo-inline">${escHtml(_frase)}</div>` : ''}`;
              })()
            : '<span class="td-muted">—</span>'}
        </td>
        <td class="td-acciones col-sticky-end" data-label="Acciones">
          <span class="fila-acciones">
          <button class="btn-tabla" onclick="abrirModalEditar('${c.id}')">Ver / Editar</button>
          <button class="btn-portal ${c.usuario_id ? 'btn-portal--activo' : ''}"
                  onclick="btnAsyncClick(this, () => gestionarAccesoPortal('${c.id}', ${escOnclickArg(nombre)}, ${!!c.usuario_id}))"
                  title="${c.usuario_id ? 'Tiene acceso portal — click para revocar' : 'Dar acceso al portal'}">
            ${c.usuario_id ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>Portal' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Sin portal'}
          </button>
          </span>
        </td>
      </tr>`;
  }, 8);
}

// ── Modal ──────────────────────────────────────────────────────────────────
function abrirModalNuevo() {
  modalClienteId = null;
  document.getElementById('modal-titulo').textContent    = 'Nuevo cliente';
  document.getElementById('modal-subtitulo').textContent = 'Completá los datos del cliente';
  const _badgeCont = document.getElementById('badge-origen-migracion');
  if (_badgeCont) _badgeCont.innerHTML = '';
  document.getElementById('tab-historial').style.display = 'none';
  document.getElementById('tab-cta').style.display       = 'none';
  document.getElementById('tab-comprobantes').style.display = 'none';
  document.getElementById('tab-bloqueos').style.display     = 'none';
  document.getElementById('btn-baja').style.display      = 'none';
  document.getElementById('btn-desbloquear').style.display = 'none';
  document.getElementById('resumen-deuda').style.display = 'none';
  resetForm();
  selTab('datos', document.querySelector('.modal-tab[data-tab="datos"]'));
  abrirModal();
}

async function abrirModalEditar(id) {
  modalClienteId = id;
  let c = clientesData.find(x => x.id === id);

  if (!c) {
    // El cliente puede no estar en la página actual (la lista pagina de a
    // 50). Lo traemos puntualmente con el mismo shape que usa la tabla.
    c = await obtenerClientePorId(id);
    if (!c) {
      window.mostrarToast?.('No se encontró el cliente', 'err');
      return;
    }
    clientesData = [c, ...clientesData];
  }

  document.getElementById('modal-titulo').textContent    = c.nombre_fantasia || c.razon_social;
  document.getElementById('modal-subtitulo').textContent = c.cuit ? `CUIT: ${sanitize(c.cuit)}` : 'Sin CUIT cargado';
  if (typeof renderBadgeOrigenMigracion === 'function') renderBadgeOrigenMigracion('clientes', c.id, 'badge-origen-migracion');
  document.getElementById('tab-historial').style.display = 'flex';
  document.getElementById('tab-cta').style.display       = 'flex';
  document.getElementById('tab-comprobantes').style.display = 'flex';
  document.getElementById('tab-bloqueos').style.display     = 'flex';
  document.getElementById('btn-baja').style.display      = c.activo ? 'inline-flex' : 'none';
  document.getElementById('btn-desbloquear').style.display = c.bloqueado ? 'inline-flex' : 'none';

  // Poblar form
  document.getElementById('f-razon_social').value    = c.razon_social || '';
  document.getElementById('f-nombre_fantasia').value = c.nombre_fantasia || '';
  document.getElementById('f-cuit').value            = c.cuit || '';
  document.getElementById('f-condicion_iva').value   = c.condicion_iva || 'consumidor_final';
  document.getElementById('f-telefono').value        = c.telefono || '';
  document.getElementById('f-email').value           = c.email || '';
  document.getElementById('f-domicilio').value       = c.domicilio || '';
  document.getElementById('f-localidad').value       = c.localidad || '';
  document.getElementById('f-zona_id').value         = c.zona_id || '';
  document.getElementById('f-notas').value           = c.notas || '';
  document.getElementById('f-lista_precio_id').value = c.lista_precio_id || '';
  document.getElementById('f-dias_credito').value    = c.dias_credito || 0;
  document.getElementById('f-limite_credito').value  = c.limite_credito || 0;
  document.getElementById('f-activo').value          = String(c.activo !== false);
  document.getElementById('f-lat').value             = c.lat ?? '';
  document.getElementById('f-lng').value             = c.lng ?? '';
  document.getElementById('f-vendedor_id_default').value = c.vendedor_id_default || '';

  // Score exacto + link en panel-datos
  const scoreExactoEl = document.getElementById('score-exacto-dato');
  if (scoreExactoEl) {
    if (c.score_actual != null) {
      const catDef = SCORE_CATEGORIAS[c.score_categoria] || SCORE_CATEGORIAS.normal;
      scoreExactoEl.innerHTML = `
        <span class="score-badge-inline ${catDef.cls}" style="font-size:.9rem">
          ${catDef.icono} <strong>${c.score_actual}</strong>/100 — ${catDef.label}
        </span>
        <button type="button" class="btn-link-score" onclick="verScoreCliente('${id}')" title="Ver historial completo de confianza">
          Ver historial ↗
        </button>`;
    } else {
      scoreExactoEl.innerHTML = '<span style="color:var(--color-text-muted);font-size:.85rem">Sin score calculado todavía.</span>';
    }
  }

  // Resumen crédito
  const deuda   = Number(c.saldo_deuda || 0);
  const limite  = Number(c.limite_credito || 0);
  const usado   = limite > 0 ? Math.min((deuda / limite) * 100, 100) : 0;
  const deudaCls = deuda > limite && limite > 0 ? 'val-rojo' : deuda > 0 ? 'val-amarillo' : 'val-verde';
  document.getElementById('resumen-deuda').style.display = 'block';
  document.getElementById('credito-grid').innerHTML = `
    <div class="credito-item">
      <span class="cred-label">Saldo deuda</span>
      <span class="cred-val ${deudaCls}">${deuda > 0 ? formatPeso(deuda) : (deuda < 0 ? `${formatPeso(Math.abs(deuda))} a favor` : 'Al día')}</span>
    </div>
    <div class="credito-item">
      <span class="cred-label">Límite de crédito</span>
      <span class="cred-val">${limite > 0 ? formatPeso(limite) : 'Sin límite'}</span>
    </div>
    <div class="credito-item">
      <span class="cred-label">Días de crédito</span>
      <span class="cred-val">${c.dias_credito || 0} días</span>
    </div>
    <div class="credito-item">
      <span class="cred-label">Lista de precios</span>
      <span class="cred-val">${escHtml(c.listas_precios?.nombre || 'Por defecto')}</span>
    </div>
    ${limite > 0 ? `
    <div class="credito-item credito-full">
      <span class="cred-label">Crédito usado: ${usado.toFixed(0)}%</span>
      <div class="barra-credito">
        <div class="barra-fill ${deuda > limite ? 'barra-rojo' : deuda > limite * 0.8 ? 'barra-amarillo' : 'barra-verde'}" style="width:${usado}%"></div>
      </div>
    </div>` : ''}
    <div class="credito-item credito-full" style="margin-top:8px">
      <button class="btn-secundario" id="btn-estado-cuenta"
        onclick="enviarEstadoCuenta('${id}')"
        ${!c.email ? 'disabled title="El cliente no tiene email registrado"' : ''}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></svg>Enviar estado de cuenta
      </button>
    </div>
  `;

  // REQ-07: cargar sección Piloto Automático (ciclos + pedido sugerido)
  cli_ciclos_cargar(id);

  selTab('datos', document.querySelector('.modal-tab[data-tab="datos"]'));
  abrirModal();
}

// ── REQ-10: Enviar estado de cuenta por email ──────────────────────────────
async function enviarEstadoCuenta(clienteId) {
  const btn = document.getElementById('btn-estado-cuenta');
  if (!btn) return;
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  try {
    const { data: { session } } = await sb.auth.getSession();
    const resp = await fetch('/api/notif?_svc=estado-cuenta', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ cliente_id: clienteId }),
    });
    const data = await resp.json();
    if (resp.ok) {
      window.toast(`Estado de cuenta enviado a ${data.destinatario}`);
    } else {
      window.toast(data.error || 'Error al enviar', 'error');
    }
  } catch (e) {
    window.toast('Error de conexión', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

function abrirModal() {
  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-cliente').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function cerrarModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-cliente').classList.remove('open');
  document.body.style.overflow = '';
}

function selTab(tab, btn) {
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('activo'));
  btn.classList.add('activo');
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  document.getElementById('panel-' + tab).style.display = 'flex';
  document.getElementById('form-acciones').style.display =
    (tab === 'historial' || tab === 'cta' || tab === 'comprobantes') ? 'none' : 'flex';

  if (tab === 'historial' && modalClienteId) {
    window.NotasInternas?.resetPaginacion('historial-lista');
    cargarHistorialNotasCliente(modalClienteId);
  }
  if (tab === 'cta' && modalClienteId) cargarCtaCteCliente(modalClienteId);
  if (tab === 'comprobantes' && modalClienteId) cargarComprobantesHistoricosCliente(modalClienteId);
  if (tab === 'bloqueos' && modalClienteId) cargarBloqueos(modalClienteId);
}

async function cargarCtaCteCliente(clienteId) {
  const contenedor = document.getElementById('panel-cta');
  if (!contenedor) return;
  contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Cargando cuenta corriente...</p>';
  try {
    // FIX: antes leía de movimientos_cta_cte, una tabla que ningún proceso
    // del backend escribe (RPCs reales: registrar_movimiento_cta_cte,
    // emitir_nota_cta_cte, aplicar_nota_credito_cta_cte, POS, etc. todos
    // escriben en cta_cte). Esto dejaba el modal siempre vacío en producción.
    // Fix (Fase 12): faltaba 'nota_debito' acá — una nota de débito
    // (emitida vía emitir_nota_cta_cte) quedaba sin clasificar y no se
    // mostraba como deuda en el extracto. Mismo ajuste hecho en el
    // trigger sync_saldo_deuda_cliente().
    const DEBE_TIPOS  = ['factura', 'debito', 'cargo', 'nota_debito'];
    const HABER_TIPOS = ['cobro', 'credito', 'nota_credito', 'pago'];
    const { data, error } = await window.supabaseClient
      .from('cta_cte')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('fecha', { ascending: false })
      .limit(50);
    if (error) throw error;
    if (!data || data.length === 0) {
      contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Sin movimientos registrados.</p>';
      return;
    }
    const filas = data.map(m => {
      const esDebe = DEBE_TIPOS.includes(m.tipo);
      const esHaber = HABER_TIPOS.includes(m.tipo);
      const debe  = esDebe  ? m.monto : null;
      const haber = esHaber ? m.monto : null;
      return `
      <tr>
        <td>${m.fecha?.slice(0,10) ?? ''}</td>
        <td>${m.tipo ?? ''}</td>
        <td>${escHtml(m.descripcion ?? '')}</td>
        <td style="text-align:left">${debe != null ? '$' + Number(debe).toLocaleString('es-AR') : ''}</td>
        <td style="text-align:left">${haber != null ? '$' + Number(haber).toLocaleString('es-AR') : ''}</td>
        <td style="text-align:left;font-weight:600">${m.saldo != null ? '$' + Number(m.saldo).toLocaleString('es-AR') : ''}</td>
      </tr>`;
    }).join('');
    contenedor.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr>
          <th style="text-align:left;padding:.4rem .6rem">Fecha</th>
          <th style="text-align:left;padding:.4rem .6rem">Tipo</th>
          <th style="text-align:left;padding:.4rem .6rem">Descripción</th>
          <th style="text-align:left;padding:.4rem .6rem">Debe</th>
          <th style="text-align:left;padding:.4rem .6rem">Haber</th>
          <th style="text-align:left;padding:.4rem .6rem">Saldo</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
  } catch(e) {
    console.error('[clientes] Error cargando cta-cte:', e);
    contenedor.innerHTML = `<p style="padding:1rem;color:var(--color-danger)">Error: ${sanitize(e.message)}</p>`;
  }
}

// Migración 177 (cierre gap crítico 1): comprobantes fiscales históricos,
// puramente de solo lectura — vienen de la migración asistida (wizard) y no
// se editan ni generan movimientos desde acá, solo se listan.
const ETIQUETA_TIPO_COMPROBANTE = { factura: 'Factura', nota_credito: 'Nota de crédito', nota_debito: 'Nota de débito' };

async function cargarComprobantesHistoricosCliente(clienteId) {
  const contenedor = document.getElementById('panel-comprobantes');
  if (!contenedor) return;
  contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Cargando comprobantes...</p>';
  try {
    const { data, error } = await window.supabaseClient
      .from('comprobantes_historicos')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('fecha', { ascending: false })
      .limit(50);
    if (error) throw error;
    if (!data || data.length === 0) {
      contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Sin comprobantes históricos registrados.</p>';
      return;
    }
    const filas = data.map(c => `
      <tr>
        <td>${c.fecha?.slice(0,10) ?? ''}</td>
        <td>${ETIQUETA_TIPO_COMPROBANTE[c.tipo] || c.tipo || ''}</td>
        <td>${escHtml(c.numero_original ?? '')}</td>
        <td style="text-align:left">${c.monto != null ? '$' + Number(c.monto).toLocaleString('es-AR') + ' ' + (c.moneda || 'ARS') : ''}</td>
        <td>${escHtml(c.observaciones ?? '')}</td>
      </tr>`).join('');
    contenedor.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr>
          <th style="text-align:left;padding:.4rem .6rem">Fecha</th>
          <th style="text-align:left;padding:.4rem .6rem">Tipo</th>
          <th style="text-align:left;padding:.4rem .6rem">Número</th>
          <th style="text-align:left;padding:.4rem .6rem">Monto</th>
          <th style="text-align:left;padding:.4rem .6rem">Observaciones</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
  } catch(e) {
    console.error('[clientes] Error cargando comprobantes históricos:', e);
    contenedor.innerHTML = `<p style="padding:1rem;color:var(--color-danger)">Error: ${sanitize(e.message)}</p>`;
  }
}

async function cargarHistorialNotasCliente(clienteId) {
  const lista = document.getElementById('historial-lista');
  if (!lista || !window.NotasInternas) return;

  lista.innerHTML = '<div class="loading-row">Cargando notas...</div>';

  try {
    const notas = await window.NotasInternas.cargar('clientes', clienteId);
    window.NotasInternas.renderLista(notas, 'historial-lista', {
      onArchivar: () => cargarHistorialNotasCliente(clienteId),
    });
  } catch (e) {
    console.error('[clientes] Error cargando historial de notas:', e);
    lista.innerHTML = '<div class="loading-row">No se pudo cargar el historial.</div>';
  }

  window.NotasInternas.renderForm('historial-form', 'clientes', clienteId, {
    onGuardada: () => cargarHistorialNotasCliente(clienteId),
  });
}

async function cargarBloqueos(clienteId) {
  const contenedor = document.getElementById('panel-bloqueos');
  if (!contenedor) return;
  contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Cargando historial de bloqueos...</p>';
  try {
    const { data, error } = await window.supabaseClient
      .from('bloqueos_cliente')
      .select('*, usuarios(nombre)')
      .eq('cliente_id', clienteId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    if (!data || data.length === 0) {
      contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Sin bloqueos registrados para este cliente.</p>';
      return;
    }
    const filas = data.map(b => `
      <tr>
        <td>${b.created_at?.slice(0,10) ?? ''}</td>
        <td>
          <span class="badge-estado ${b.activo ? 'badge-critico' : 'badge-ok'}" style="font-size:.78rem">
            <span class="badge-dot"></span>${b.activo ? 'Activo' : 'Levantado'}
          </span>
        </td>
        <td>${escHtml(b.motivo ?? '—')}</td>
        <td>${escHtml(b.usuarios?.nombre ?? '—')}</td>
        <td>${b.updated_at?.slice(0,10) ?? ''}</td>
      </tr>`).join('');
    contenedor.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr>
          <th style="text-align:left;padding:.4rem .6rem">Fecha</th>
          <th style="text-align:left;padding:.4rem .6rem">Estado</th>
          <th style="text-align:left;padding:.4rem .6rem">Motivo</th>
          <th style="text-align:left;padding:.4rem .6rem">Registrado por</th>
          <th style="text-align:left;padding:.4rem .6rem">Actualizado</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
  } catch(e) {
    console.error('[clientes] Error cargando bloqueos:', e);
    contenedor.innerHTML = `<p style="padding:1rem;color:var(--color-danger)">Error: ${sanitize(e.message)}</p>`;
  }
}
window.cargarBloqueos = cargarBloqueos;

function resetForm() {
  ['f-razon_social','f-nombre_fantasia','f-cuit','f-telefono','f-email','f-domicilio','f-localidad','f-notas'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-condicion_iva').value  = 'consumidor_final';
  document.getElementById('f-zona_id').value        = '';
  document.getElementById('f-lista_precio_id').value = '';
  document.getElementById('f-dias_credito').value   = 0;
  document.getElementById('f-limite_credito').value = 0;
  document.getElementById('f-activo').value         = 'true';
  document.getElementById('f-lat').value            = '';
  document.getElementById('f-lng').value            = '';
  document.getElementById('f-vendedor_id_default').value = '';
  const scoreExactoElReset = document.getElementById('score-exacto-dato');
  if (scoreExactoElReset) scoreExactoElReset.innerHTML = '';
}

// ── Normaliza el CUIT al formato XX-XXXXXXXX-X que exige el constraint
// clientes_cuit_formato en DB (db/077_critical_rls_y_politicas.sql).
// Acepta que el usuario lo tipee con o sin guiones/espacios.
function normalizarCuit(valor) {
  const digitos = (valor || '').replace(/\D/g, '');
  if (!digitos) return { ok: true, valor: null };
  if (digitos.length !== 11) return { ok: false, valor: null };
  return { ok: true, valor: `${digitos.slice(0,2)}-${digitos.slice(2,10)}-${digitos.slice(10)}` };
}

// ── Guardar ────────────────────────────────────────────────────────────────
async function guardarCliente() {
  const razon = document.getElementById('f-razon_social').value.trim();
  if (!razon) { window.toast('La razón social es obligatoria'); return; }

  const cuitInput = document.getElementById('f-cuit').value.trim();
  const cuitNorm  = normalizarCuit(cuitInput);
  if (!cuitNorm.ok) {
    window.toast('El CUIT debe tener 11 dígitos (ej: 20-12345678-9)');
    return;
  }

  const payload = {
    razon_social:    razon,
    nombre_fantasia: document.getElementById('f-nombre_fantasia').value.trim() || null,
    cuit:            cuitNorm.valor,
    condicion_iva:   document.getElementById('f-condicion_iva').value,
    telefono:        document.getElementById('f-telefono').value.trim() || null,
    email:           document.getElementById('f-email').value.trim() || null,
    domicilio:       document.getElementById('f-domicilio').value.trim() || null,
    localidad:       document.getElementById('f-localidad').value.trim() || null,
    zona_id:         document.getElementById('f-zona_id').value || null,
    notas:           document.getElementById('f-notas').value.trim() || null,
    lista_precio_id: document.getElementById('f-lista_precio_id').value || null,
    dias_credito:    parseInt(document.getElementById('f-dias_credito').value) || 0,
    limite_credito:  parseFloat(document.getElementById('f-limite_credito').value) || 0,
    activo:          document.getElementById('f-activo').value === 'true',
    lat:             parseFloat(document.getElementById('f-lat').value) || null,
    lng:             parseFloat(document.getElementById('f-lng').value) || null,
    vendedor_id_default: document.getElementById('f-vendedor_id_default').value || null,
  };

  const esEdicion = !!modalClienteId;
  const ok = await window.confirmar(
    esEdicion
      ? `¿Guardar los cambios de "${razon}"?`
      : `¿Confirmás crear el cliente "${razon}"?`,
    { labelOk: esEdicion ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  const btn = document.getElementById('btn-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  // FIX (auditoría UX etapa 17, Hallazgo 2): antes insertaba directo contra
  // Supabase (sb.from('clientes').insert()), lo que bypaseaba por completo
  // exigirLimitePlan() -- el enforcement del cupo de clientes del plan
  // contratado solo corre del lado del handler HTTP, nunca en un trigger de
  // base. Ahora pasa por POST/PATCH /api/clientes como el resto de las
  // pantallas de este mismo archivo (precios, direcciones).
  try {
    const token = await getFreshToken();
    let resp, data;
    if (modalClienteId) {
      resp = await fetch('/api/clientes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: modalClienteId, ...payload }),
      });
      data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw Object.assign(new Error(data.error || 'Error al actualizar'), { code: data.code });
      window.toast('Cliente actualizado');
    } else {
      resp = await fetch('/api/clientes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw Object.assign(new Error(data.error || 'Error al crear'), { code: data.code });
      window.toast('Cliente creado');
    }
    cerrarModal();
    await cargarClientes();
  } catch (err) {
    console.error(err);
    if (err.code === 'LIMITE_PLAN_ALCANZADO') {
      window.toast('Se alcanzó el límite de clientes de tu plan actual. Contactanos para ampliarlo.');
    } else {
      window.toast('No se pudo guardar el cliente');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar cambios';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function iniciales(n) {
  return n.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
}
function formatPeso(n) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
}
// XSS: helper para escapar de forma segura un valor de texto libre (nombre,
// teléfono, etc.) cuando se inserta como argumento dentro de un atributo
// onclick="funcion('...')". escHtml() sola no alcanza acá porque no escapa
// comillas — un nombre con un apóstrofo rompe el string de JS. JSON.stringify
// escapa comillas/backslashes correctamente para el string JS, y el resto
// escapa lo necesario para el atributo HTML que lo contiene.
function escOnclickArg(valor) {
  return JSON.stringify(String(valor ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}
// mostrarToast ya definida arriba via admin-utils

// ── Precios especiales (vista global) ────────────────────────────────────
let preciosData = [];
let productosParaPrecios = [];
let direccionesData = [];
let vistaActual = 'clientes';

async function cambiarVista(vista) {
  vistaActual = vista;
  document.getElementById('vtab-clientes').classList.toggle('activa', vista === 'clientes');
  document.getElementById('vtab-precios').classList.toggle('activa', vista === 'precios');
  document.getElementById('vtab-direcciones').classList.toggle('activa', vista === 'direcciones');
  document.getElementById('vtab-listas').classList.toggle('activa', vista === 'listas');
  document.getElementById('vista-clientes').style.display = vista === 'clientes' ? '' : 'none';
  document.getElementById('vista-precios').style.display = vista === 'precios' ? '' : 'none';
  document.getElementById('vista-direcciones').style.display = vista === 'direcciones' ? '' : 'none';
  document.getElementById('vista-listas').style.display = vista === 'listas' ? '' : 'none';
  if (vista === 'precios' && preciosData.length === 0) {
    await cargarPreciosClientes();
  }
  if (vista === 'direcciones' && direccionesData.length === 0) {
    await cargarDirecciones();
  }
  if (vista === 'listas') {
    await cargarListasPreciosTab();
  }
}

async function cargarPreciosClientes() {
  const tbody = document.getElementById('tabla-precios-body');
  tbody.innerHTML = '<tr><td colspan="6" class="tabla-loading">Cargando precios...</td></tr>';
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/precios?_svc=precios', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al cargar precios');
    preciosData = data || [];
    renderTablaPrecios(preciosData);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="tabla-loading">${sanitize(err.message)}</td></tr>`;
  }
}

function renderTablaPrecios(rows) {
  const tbody = document.getElementById('tabla-precios-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="tabla-loading">Sin precios especiales cargados</td></tr>';
    return;
  }
  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    const clienteNombre = r.clientes?.nombre_fantasia || r.clientes?.razon_social || '—';
    const productoNombre = r.productos?.nombre ? `${r.productos.nombre}${r.productos.codigo ? ' (' + r.productos.codigo + ')' : ''}` : '—';
    const actualizado = r.updated_at ? new Date(r.updated_at).toLocaleDateString('es-AR') : '—';
    tr.innerHTML = `
      <td>${sanitize(clienteNombre)}</td>
      <td>${sanitize(productoNombre)}</td>
      <td class="th-num">$${Number(r.precio).toLocaleString('es-AR', {minimumFractionDigits:2})}</td>
      <td>${sanitize(r.notas || '—')}</td>
      <td>${actualizado}</td>
      <td class="col-sticky-end"><span class="fila-acciones"><button type="button" class="btn-tabla peligro" onclick="btnAsyncClick(this, () => eliminarPrecioCliente('${r.id}'))">Eliminar</button></span></td>
    `;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

function filtrarPrecios() {
  const b = document.getElementById('input-busqueda-precios').value.trim().toLowerCase();
  if (!b) return renderTablaPrecios(preciosData);
  const filtradas = preciosData.filter(r => {
    const cliente = (r.clientes?.nombre_fantasia || r.clientes?.razon_social || '').toLowerCase();
    const producto = (r.productos?.nombre || r.productos?.codigo || '').toLowerCase();
    return cliente.includes(b) || producto.includes(b);
  });
  renderTablaPrecios(filtradas);
}

async function abrirModalPrecio() {
  // Poblar select de clientes (reutiliza clientesData ya cargado)
  const selCliente = document.getElementById('fp-cliente_id');
  selCliente.innerHTML = '<option value="">Seleccioná un cliente</option>' +
    clientesData.map(c => `<option value="${c.id}">${sanitize(c.nombre_fantasia || c.razon_social)}</option>`).join('');

  // Poblar select de productos (consulta directa, igual que en compras.js)
  if (productosParaPrecios.length === 0) {
    const { data } = await sb.from('productos').select('id, nombre, codigo').eq('activo', true).order('nombre');
    productosParaPrecios = data || [];
  }
  const selProducto = document.getElementById('fp-producto_id');
  selProducto.innerHTML = '<option value="">Seleccioná un producto</option>' +
    productosParaPrecios.map(p => `<option value="${p.id}">${sanitize(p.nombre)}${p.codigo ? ' (' + sanitize(p.codigo) + ')' : ''}</option>`).join('');

  document.getElementById('fp-precio').value = '';
  document.getElementById('fp-notas').value = '';
  document.getElementById('modal-precio-backdrop').style.display = 'block';
  document.getElementById('modal-precio').style.display = 'flex';
  document.getElementById('modal-precio').classList.add('open');
}

function cerrarModalPrecio() {
  document.getElementById('modal-precio-backdrop').style.display = 'none';
  document.getElementById('modal-precio').classList.remove('open');
}

async function guardarPrecioCliente() {
  const cliente_id = document.getElementById('fp-cliente_id').value;
  const producto_id = document.getElementById('fp-producto_id').value;
  const precio = document.getElementById('fp-precio').value;
  const notas = document.getElementById('fp-notas').value.trim();

  if (!cliente_id) { window.toast('Seleccioná un cliente'); return; }
  if (!producto_id) { window.toast('Seleccioná un producto'); return; }
  if (precio === '' || Number(precio) < 0) { window.toast('Ingresá un precio válido'); return; }

  const ok = await window.confirmar(`¿Confirmás guardar este precio especial de $${precio}?`, { labelOk: 'Guardar', labelCancel: 'Revisar' });
  if (!ok) return;

  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/precios?_svc=precios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cliente_id, producto_id, precio: Number(precio), notas: notas || null })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al guardar');
    window.toast('Precio especial guardado');
    cerrarModalPrecio();
    await cargarPreciosClientes();
  } catch (err) {
    console.error(err);
    window.toast('No se pudo guardar el precio especial', 'error');
  }
}

async function eliminarPrecioCliente(id) {
  const ok = await window.confirmar(
    '¿Eliminar este precio especial? Esta acción no se puede deshacer.',
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/clientes/precios?_svc=precios&id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al eliminar');
    window.toast('Precio especial eliminado');
    preciosData = preciosData.filter(r => r.id !== id);
    renderTablaPrecios(preciosData);
  } catch (err) {
    console.error(err);
    window.toast('No se pudo eliminar el precio especial', 'error');
  }
}

// ── Direcciones de entrega (vista global) ────────────────────────────────
async function cargarDirecciones() {
  const tbody = document.getElementById('tabla-direcciones-body');
  tbody.innerHTML = '<tr><td colspan="7" class="tabla-loading">Cargando direcciones...</td></tr>';
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/direcciones?_svc=direcciones', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al cargar direcciones');
    direccionesData = data || [];
    renderTablaDirecciones(direccionesData);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="tabla-loading">${sanitize(err.message)}</td></tr>`;
  }
}

function renderTablaDirecciones(rows) {
  const tbody = document.getElementById('tabla-direcciones-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabla-loading">Sin direcciones cargadas</td></tr>';
    return;
  }
  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    const clienteNombre = r.clientes?.nombre_fantasia || r.clientes?.razon_social || '—';
    tr.innerHTML = `
      <td>${sanitize(clienteNombre)}</td>
      <td>${sanitize(r.etiqueta || '—')}</td>
      <td>${sanitize(r.domicilio)}</td>
      <td>${sanitize(r.localidad || '—')}</td>
      <td>${sanitize(r.provincia || '—')}</td>
      <td>${r.es_principal ? '<span class="sello sello--exito">Principal</span>' : ''}</td>
      <td class="col-sticky-end">
        <span class="fila-acciones">
        <button type="button" class="btn-tabla" onclick="abrirModalDireccion('${r.id}')">Editar</button>
        <button type="button" class="btn-tabla peligro" onclick="btnAsyncClick(this, () => eliminarDireccion('${r.id}'))">Eliminar</button>
        </span>
      </td>
    `;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

function filtrarDirecciones() {
  const b = document.getElementById('input-busqueda-direcciones').value.trim().toLowerCase();
  if (!b) return renderTablaDirecciones(direccionesData);
  const filtradas = direccionesData.filter(r => {
    const cliente = (r.clientes?.nombre_fantasia || r.clientes?.razon_social || '').toLowerCase();
    return cliente.includes(b) ||
      (r.domicilio || '').toLowerCase().includes(b) ||
      (r.localidad || '').toLowerCase().includes(b);
  });
  renderTablaDirecciones(filtradas);
}

function abrirModalDireccion(id) {
  const selCliente = document.getElementById('fd-cliente_id');
  selCliente.innerHTML = '<option value="">Seleccioná un cliente</option>' +
    clientesData.map(c => `<option value="${c.id}">${sanitize(c.nombre_fantasia || c.razon_social)}</option>`).join('');

  const existente = id ? direccionesData.find(r => r.id === id) : null;
  document.getElementById('modal-direccion-titulo').textContent = existente ? 'Editar dirección' : 'Nueva dirección';
  document.getElementById('fd-id').value = existente?.id || '';
  selCliente.value = existente?.cliente_id || '';
  selCliente.disabled = !!existente; // no se cambia el cliente de una dirección existente
  document.getElementById('fd-etiqueta').value = existente?.etiqueta || '';
  document.getElementById('fd-domicilio').value = existente?.domicilio || '';
  document.getElementById('fd-localidad').value = existente?.localidad || '';
  document.getElementById('fd-provincia').value = existente?.provincia || '';
  document.getElementById('fd-notas').value = existente?.notas || '';
  document.getElementById('fd-es_principal').checked = !!existente?.es_principal;

  document.getElementById('modal-direccion-backdrop').style.display = 'block';
  document.getElementById('modal-direccion').style.display = 'flex';
  document.getElementById('modal-direccion').classList.add('open');
}

function cerrarModalDireccion() {
  document.getElementById('modal-direccion-backdrop').style.display = 'none';
  document.getElementById('modal-direccion').classList.remove('open');
  document.getElementById('fd-cliente_id').disabled = false;
}

async function guardarDireccion() {
  const id = document.getElementById('fd-id').value;
  const cliente_id = document.getElementById('fd-cliente_id').value;
  const domicilio = document.getElementById('fd-domicilio').value.trim();

  if (!id && !cliente_id) { window.toast('Seleccioná un cliente'); return; }
  if (!domicilio) { window.toast('El domicilio es obligatorio'); return; }

  const ok = await window.confirmar(
    id ? `¿Guardar los cambios de esta dirección?` : `¿Confirmás agregar esta dirección de entrega?`,
    { labelOk: id ? 'Guardar' : 'Agregar', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  const payload = {
    cliente_id,
    etiqueta: document.getElementById('fd-etiqueta').value.trim() || null,
    domicilio,
    localidad: document.getElementById('fd-localidad').value.trim() || null,
    provincia: document.getElementById('fd-provincia').value.trim() || null,
    notas: document.getElementById('fd-notas').value.trim() || null,
    es_principal: document.getElementById('fd-es_principal').checked,
  };

  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/direcciones?_svc=direcciones', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(id ? { id, ...payload } : payload)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al guardar');
    window.toast('Dirección guardada');
    cerrarModalDireccion();
    direccionesData = []; // fuerza recarga completa (por el reseteo de es_principal en otras filas)
    await cargarDirecciones();
  } catch (err) {
    console.error(err);
    window.toast('No se pudo guardar la dirección', 'error');
  }
}

async function eliminarDireccion(id) {
  const ok = await window.confirmar(
    '¿Eliminar esta dirección de entrega? Esta acción no se puede deshacer.',
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/clientes/direcciones?_svc=direcciones&id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al eliminar');
    window.toast('Dirección eliminada');
    direccionesData = direccionesData.filter(r => r.id !== id);
    renderTablaDirecciones(direccionesData);
  } catch (err) {
    console.error(err);
    window.toast('No se pudo eliminar la dirección', 'error');
  }
}

// ── Listas de precio (vista global) ──────────────────────────────────────
// Ex /admin/listas-precio (página propia) — incorporada acá porque es un
// ABM chico y conceptualmente pertenece a Clientes: son las condiciones
// comerciales que se asignan desde la pestaña "Comercial" de la ficha de
// cada cliente (ver cargarListas() más arriba, que puebla ese combo).
// Mismo endpoint /api/maestros?recurso=listas-precios que usaba la página
// vieja — no se tocó nada del lado del servidor.
let listasPreciosTabData = [];
let modalListaPrecioId = null;

async function cargarListasPreciosTab() {
  const tbody = document.getElementById('tabla-listas-body');
  tbody.innerHTML = '<tr><td colspan="4" class="tabla-loading">Cargando listas...</td></tr>';
  try {
    const token = await getFreshToken();
    const activa = document.getElementById('filtro-activa-listas')?.value ?? 'true';
    const params = new URLSearchParams({ recurso: 'listas-precios' });
    if (activa !== '') params.set('activa', activa);

    const resp = await fetch(`/api/maestros?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'No se pudo cargar la lista de precios.');
    listasPreciosTabData = data.data || [];
    renderTablaListasPrecios();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="tabla-loading">${sanitize(err.message)}</td></tr>`;
  }
}

function renderTablaListasPrecios() {
  const tbody = document.getElementById('tabla-listas-body');
  if (!tbody) return;

  if (!listasPreciosTabData.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="tabla-loading">Todavía no cargaste ninguna lista. Creá la primera con «Nueva lista».</td></tr>';
    return;
  }

  tbody.innerHTML = listasPreciosTabData.map(l => `
    <tr>
      <td>${sanitize(l.nombre)}</td>
      <td style="text-align:center">${l.es_default ? '<span class="badge-estado badge-ok"><span class="badge-dot"></span>Sí</span>' : '—'}</td>
      <td><span class="badge-estado ${l.activa ? 'badge-ok' : 'badge-critico'}"><span class="badge-dot"></span>${l.activa ? 'Activa' : 'Inactiva'}</span></td>
      <td class="col-sticky-end">
        <span class="fila-acciones">
          <button type="button" class="btn-tabla" onclick="abrirModalListaPrecio('${l.id}')">Editar</button>
          ${l.activa
            ? `<button type="button" class="btn-tabla peligro" onclick="btnAsyncClick(this, () => desactivarListaPrecio('${l.id}'))">Dar de baja</button>`
            : `<button type="button" class="btn-tabla primario" onclick="btnAsyncClick(this, () => activarListaPrecio('${l.id}'))">Activar</button>`
          }
        </span>
      </td>
    </tr>
  `).join('');
}

function abrirModalListaPrecio(id) {
  modalListaPrecioId = id || null;
  const l = id ? listasPreciosTabData.find(x => x.id === id) : null;
  if (id && !l) { window.toast('No se pudo cargar la lista', 'error'); return; }

  document.getElementById('fl-id').value = id || '';
  document.getElementById('fl-nombre').value = l?.nombre || '';
  document.getElementById('fl-es_default').checked = !!l?.es_default;
  document.getElementById('modal-lista-precio-titulo').textContent = id ? 'Editar lista' : 'Nueva lista';

  document.getElementById('modal-lista-precio-backdrop').style.display = 'block';
  document.getElementById('modal-lista-precio').style.display = 'flex';
}

function cerrarModalListaPrecio() {
  document.getElementById('modal-lista-precio-backdrop').style.display = 'none';
  document.getElementById('modal-lista-precio').style.display = 'none';
  modalListaPrecioId = null;
}

async function guardarListaPrecio() {
  const id = document.getElementById('fl-id').value;
  const body = {
    nombre:     document.getElementById('fl-nombre').value.trim(),
    es_default: document.getElementById('fl-es_default').checked,
  };

  if (!body.nombre) { window.toast('El nombre es requerido', 'error'); return; }

  const ok = await window.confirmar(
    id ? `¿Guardar los cambios de la lista "${body.nombre}"?` : `¿Confirmás crear la lista "${body.nombre}"?`,
    { labelOk: id ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  try {
    const token = await getFreshToken();
    if (id) body.id = id;
    const resp = await fetch('/api/maestros?recurso=listas-precios', {
      method: id ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'No se pudo guardar la lista');

    window.toast(id ? 'Lista actualizada' : 'Lista creada', 'exito');
    cerrarModalListaPrecio();
    await cargarListasPreciosTab();
    await cargarListas(); // refresca el combo de la ficha del cliente (pestaña Comercial)
  } catch (err) {
    console.error(err);
    window.toast(err.message || 'No se pudo guardar la lista', 'error');
  }
}

async function desactivarListaPrecio(id) {
  const ok = await window.confirmar(
    '¿Dar de baja esta lista de precio? Los clientes que la tengan asignada pasarán a usar la lista predeterminada.',
    { labelOk: 'Dar de baja', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/maestros?recurso=listas-precios&id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'No se pudo dar de baja la lista');
    window.toast('Lista dada de baja', 'exito');
    await cargarListasPreciosTab();
    await cargarListas();
  } catch (err) {
    console.error(err);
    window.toast(err.message || 'No se pudo dar de baja la lista', 'error');
  }
}

async function activarListaPrecio(id) {
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/maestros?recurso=listas-precios', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, activa: true })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'No se pudo activar la lista');
    window.toast('Lista activada', 'exito');
    await cargarListasPreciosTab();
    await cargarListas();
  } catch (err) {
    console.error(err);
    window.toast(err.message || 'No se pudo activar la lista', 'error');
  }
}

// Globales para onclick
window.cambiarVista = cambiarVista;
window.abrirModalPrecio = abrirModalPrecio;
window.cerrarModalPrecio = cerrarModalPrecio;
window.guardarPrecioCliente = guardarPrecioCliente;
window.eliminarPrecioCliente = eliminarPrecioCliente;
window.filtrarPrecios = filtrarPrecios;
window.abrirModalDireccion = abrirModalDireccion;
window.cerrarModalDireccion = cerrarModalDireccion;
window.guardarDireccion = guardarDireccion;
window.eliminarDireccion = eliminarDireccion;
window.filtrarDirecciones = filtrarDirecciones;
window.cargarListasPreciosTab = cargarListasPreciosTab;
window.abrirModalListaPrecio = abrirModalListaPrecio;
window.cerrarModalListaPrecio = cerrarModalListaPrecio;
window.guardarListaPrecio = guardarListaPrecio;
window.activarListaPrecio = activarListaPrecio;
window.desactivarListaPrecio = desactivarListaPrecio;
window.init = init;
window.aplicarFiltros = aplicarFiltros;
window.selFiltroEstado = selFiltroEstado;
window.limpiarFiltros = limpiarFiltros;
window.abrirModalNuevo = abrirModalNuevo;
window.abrirModalEditar = abrirModalEditar;
window.cerrarModal = cerrarModal;
window.selTab = selTab;
window.guardarCliente = guardarCliente;
window.cambiarPagina = cambiarPagina;

// ── REQ-08: Exportar clientes a Excel ────────────────────────────────────
async function exportarExcel() {
  const btn = document.getElementById('btn-exportar-excel-clientes');
  const btnHtmlOriginal = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Generando…'; }
  window.toast?.('Preparando exportación…');
  try {

    // Traer TODOS los clientes con filtros activos (sin paginación)
    const busq      = document.getElementById('input-busqueda').value.trim();
    const zonaFiltro = document.getElementById('filtro-zona').value;

    let query = sb.from('clientes')
      .select('razon_social, nombre_fantasia, cuit, email, telefono, direccion, zona_id, zonas(nombre), saldo_deuda, limite_credito, condicion_iva, activo')
      .eq('empresa_id', empresaData.id)
      .order('razon_social');

    if (zonaFiltro) query = query.eq('zona_id', zonaFiltro);
    if (filtroEstado === 'activo')    query = query.eq('activo', true);
    if (filtroEstado === 'inactivo')  query = query.eq('activo', false);
    if (filtroEstado === 'deuda')     query = query.gt('saldo_deuda', 0);
    if (filtroEstado === 'riesgo')    query = query.in('score_categoria', ['riesgo', 'bloqueado']);
    if (filtroEstado === 'premium')   query = query.eq('score_categoria', 'premium');
    if (filtroEstado === 'bueno')     query = query.eq('score_categoria', 'bueno');
    if (filtroEstado === 'bloqueado') query = query.eq('score_categoria', 'bloqueado');
    if (busq) query = query.or(`razon_social.ilike.%${busq}%,nombre_fantasia.ilike.%${busq}%,cuit.ilike.%${busq}%`);

    const { data, error } = await query;
    if (error) throw error;

    const fecha = new Date().toISOString().slice(0, 10);

    if (typeof XLSX !== 'undefined') {
      const rows = [['Razón Social','Nombre Fantasia','CUIT','Email','Teléfono','Dirección','Zona','Saldo Deuda','Límite Crédito','Condición IVA','Estado']];
      (data || []).forEach(c => {
        rows.push([
          c.razon_social || '',
          c.nombre_fantasia || '',
          c.cuit || '',
          c.email || '',
          c.telefono || '',
          c.direccion || '',
          c.zonas?.nombre || '',
          Number(c.saldo_deuda || 0),
          Number(c.limite_credito || 0),
          c.condicion_iva || '',
          c.activo ? 'Activo' : 'Inactivo',
        ]);
      });
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(rows);
      // Ancho de columnas
      ws['!cols'] = [30,25,16,28,16,35,18,16,16,20,10].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
      XLSX.writeFile(wb, `clientes-${fecha}.xlsx`);
      window.toast(`${(data||[]).length} clientes exportados`);
    } else {
      // Fallback CSV
      let csv = 'Razón Social,Nombre Fantasia,CUIT,Email,Teléfono,Dirección,Zona,Saldo Deuda,Límite Crédito,Condición IVA,Estado\n';
      (data || []).forEach(c => {
        csv += [c.razon_social,c.nombre_fantasia,c.cuit,c.email,c.telefono,c.direccion,c.zonas?.nombre,c.saldo_deuda||0,c.limite_credito||0,c.condicion_iva,c.activo?'Activo':'Inactivo']
          .map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',') + '\n';
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `clientes-${fecha}.csv`;
      a.click();
      window.toast(`${(data||[]).length} clientes exportados (CSV)`);
    }
  } catch (err) {
    console.error('Error exportando clientes:', err);
    window.toast('Error al exportar', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btnHtmlOriginal; }
  }
}
window.exportarExcel = exportarExcel;

window.authReady.then(() => init()).catch((err) => {
  console.error('[auth] authReady falló:', err?.message);
  if (!window.authCtx || !window.authCtx.perfil) {
    window.location.href = '/admin/login';
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// REQ-5: Score Cliente — Semáforo Inteligente
// ═══════════════════════════════════════════════════════════════════════════

const SCORE_CATEGORIAS = {
  premium:   { cls: 'score-premium',  icono: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>', label: 'Premium'  },
  bueno:     { cls: 'score-bueno',    icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Bueno'    },
  normal:    { cls: 'score-normal',   icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Normal'   },
  riesgo:    { cls: 'score-riesgo',   icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Riesgo'   },
  bloqueado: { cls: 'score-bloqueado',icono: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>', label: 'Bloqueado'},
};

/**
 * Renderiza el badge de score dentro de una celda / card de cliente.
 * @param {number} score     Valor 0-100
 * @param {string} categoria Categoría calculada
 * @returns {string} HTML del badge
 */
/**
 * Genera una frase corta explicando la principal causa del riesgo.
 * Solo se muestra cuando cat === 'riesgo' o 'bloqueado'.
 * @param {object} comp  { score_pagos, score_frecuencia, score_deuda, score_devolucion }
 * @param {string} cat   Categoría del score
 * @returns {string} Frase legible o ''
 */
function motivoFrase(comp, cat) {
  if (!['riesgo', 'bloqueado'].includes(cat)) return '';
  if (!comp) return '';

  // Frases contextuales por componente según buckets del backend SQL
  function frasePagos(val) {
    if (val == null)  return 'Sin historial de pagos registrado';
    if (val <= 5)     return 'Paga con mucho atraso (más de 30 días después del vencimiento)';
    if (val <= 15)    return 'Paga con bastante atraso (15–30 días después del vencimiento)';
    if (val <= 25)    return 'Paga con algo de atraso (7–15 días después del vencimiento)';
    return null; // no es el problema dominante
  }
  function fraseFrecuencia(val) {
    if (val == null || val <= 3)  return 'Sin compras en los últimos 3 meses';
    if (val <= 9)                 return 'Muy pocas compras en los últimos 3 meses';
    if (val <= 15)                return 'Baja frecuencia de compras';
    return null;
  }
  function fraseDeuda(val) {
    if (val == null || val <= 5)  return 'Deuda supera ampliamente el límite de crédito';
    if (val <= 10)                return 'Deuda muy alta en relación al límite de crédito';
    if (val <= 14)                return 'Deuda alta en relación al límite de crédito';
    return null;
  }
  function fraseDevolucion(val) {
    if (val == null || val <= 3)  return 'Alta tasa de devoluciones (más del 20%)';
    if (val <= 7)                 return 'Tasa de devoluciones elevada (10–20%)';
    if (val <= 10)                return 'Tasa de devoluciones moderada (5–10%)';
    return null;
  }

  // Componentes con sus máximos para calcular el peor relativo
  const componentes = [
    { key: 'score_pagos',      max: 40, fn: frasePagos      },
    { key: 'score_deuda',      max: 20, fn: fraseDeuda      },
    { key: 'score_frecuencia', max: 25, fn: fraseFrecuencia },
    { key: 'score_devolucion', max: 15, fn: fraseDevolucion },
  ];

  // El componente con peor rendimiento relativo (% obtenido vs máximo)
  // Excluye score_pagos=20 (caso "sin datos", no es falla real)
  let peor = null, peorPct = Infinity;
  for (const c of componentes) {
    const val = comp[c.key] != null ? Number(comp[c.key]) : null;
    // score_pagos=20 es el default por "sin historial", no penalizar como malo
    if (c.key === 'score_pagos' && val === 20) continue;
    const efectivo = val ?? 0;
    const pct = efectivo / c.max;
    if (pct < peorPct) { peorPct = pct; peor = { ...c, val }; }
  }
  if (!peor) return '';

  const frase = peor.fn(peor.val);
  return frase || '';
}

function renderScore(score, categoria) {
  const cat = SCORE_CATEGORIAS[categoria] || SCORE_CATEGORIAS.normal;
  return `<span class="score-badge ${cat.cls}" title="Nivel de confianza ${score}/100">${cat.icono} ${Math.round(score)}</span>`;
}

/**
 * Muestra el modal detallado de score de un cliente.
 * @param {string} clienteId UUID del cliente
 */
async function verScoreCliente(clienteId) {
  const modal = document.getElementById('modal-score-cliente');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('score-cliente-body').innerHTML =
    '<div class="loading-row">Cargando nivel de confianza...</div>';

  try {
    const _freshTok = await getFreshToken();
    const resp = await fetch(`/api/score?accion=cliente&cliente_id=${clienteId}`, {
      headers: { Authorization: `Bearer ${_freshTok}` }
    });
    if (!resp.ok) throw new Error('Error al cargar nivel de confianza');
    const { cliente, historial, ultima_oferta_plan_pago } = await resp.json();

    const score    = Number(cliente?.score_actual ?? 0);
    const cat      = cliente?.score_categoria || 'normal';
    const catDef   = SCORE_CATEGORIAS[cat] || SCORE_CATEGORIAS.normal;
    const scoreHtml = renderScore(score, cat);

    const componenteHtml = (label, val, max, desc) => {
      const pct = Math.round((val / max) * 100);
      return `
        <div class="score-comp">
          <div class="score-comp-header">
            <span class="score-comp-label">${label}</span>
            <span class="score-comp-val">${Number(val).toFixed(1)}/${max}</span>
          </div>
          <div class="score-bar-wrap">
            <div class="score-bar-fill score-bar-fill--${pct > 70 ? 'alta' : pct > 40 ? 'media' : 'baja'}"
                 style="width:${pct}%"></div>
          </div>
          <small class="score-comp-desc">${desc}</small>
        </div>`;
    };

    // Historial simplificado (últimos 6 puntos)
    const hist6 = (historial || []).slice(0, 6).reverse();
    const histHtml = hist6.length
      ? hist6.map(h => `
          <div class="score-hist-row">
            <time>${new Date(h.created_at).toLocaleDateString('es-AR')}</time>
            <span class="score-hist-val">${Math.round(h.score)}</span>
            <small>${h.motivo_cambio || ''}</small>
          </div>`).join('')
      : '<p class="empty-hint">Sin historial</p>';

    const frase = motivoFrase(historial?.[0], cat);

    document.getElementById('score-cliente-body').innerHTML = `
      <div class="score-desglose">
        <div class="score-header">
          ${scoreHtml}
          <span class="score-cat-badge ${catDef.cls}">${catDef.icono} ${catDef.label}</span>
        </div>
        ${frase ? `<p class="score-motivo-frase">${escHtml(frase)}</p>` : ''}
        <div class="score-grid">
          ${componenteHtml('Comportamiento de pago', (historial?.[0]?.score_pagos || 0), 40, 'Velocidad de pago vs. vencimiento')}
          ${componenteHtml('Frecuencia de compra',   (historial?.[0]?.score_frecuencia || 0), 25, 'Pedidos en últimos 90 días')}
          ${componenteHtml('Nivel de deuda',          (historial?.[0]?.score_deuda || 0), 20, 'Ratio deuda/límite crédito')}
          ${componenteHtml('Devoluciones',            (historial?.[0]?.score_devolucion || 0), 15, 'Tasa de devoluciones')}
        </div>
        <div class="score-condiciones">
          <strong>Condiciones actuales:</strong>
          Días de crédito: <b>${cliente?.dias_credito ?? 0}</b>
        </div>
        <div class="score-historial">
          <strong>Historial</strong>
          ${histHtml}
        </div>
        <div class="score-acciones">
          <button class="btn btn--sm btn--primario" onclick="recalcularScore('${clienteId}')">
            ↺ Recalcular
          </button>
          ${['riesgo', 'bloqueado'].includes(cat) ? `
            <button class="btn btn--sm" style="background:#25D366;color:#fff;border:none;" onclick="ofrecerPlanPago('${clienteId}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>Ofrecer plan de pago
            </button>
            <small class="empty-hint" style="display:block;margin-top:4px;">
              ${ultima_oferta_plan_pago
                ? `Última oferta enviada: ${new Date(ultima_oferta_plan_pago).toLocaleDateString('es-AR')}`
                : 'Todavía no se le ofreció un plan de pago'}
            </small>
          ` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    document.getElementById('score-cliente-body').innerHTML =
      `<p class="empty-hint">Error: ${err.message}</p>`;
  }
}

window.cerrarModalScore = function() {
  const m = document.getElementById('modal-score-cliente');
  if (m) m.style.display = 'none';
};

window.recalcularScore = async function(clienteId) {
  try {
    const _freshTok = await getFreshToken();
    const resp = await fetch('/api/score?accion=recalcular', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_freshTok}`
      },
      body: JSON.stringify({ cliente_id: clienteId })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error');
    window.toast(`Nivel de confianza recalculado: ${Math.round(data.score)}/100`);
    await verScoreCliente(clienteId);
  } catch (err) {
    console.error(err);
    window.toast('No se pudo recalcular el nivel de confianza', 'error');
  }
};

window.ofrecerPlanPago = async function(clienteId) {
  if (!confirm('¿Enviar oferta de plan de pago por WhatsApp a este cliente ahora?')) return;
  try {
    const _freshTok = await getFreshToken();
    const resp = await fetch('/api/score?accion=ofrecer-plan-pago', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_freshTok}`
      },
      body: JSON.stringify({ cliente_id: clienteId })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error');
    window.toast('Oferta de plan de pago enviada por WhatsApp');
    await verScoreCliente(clienteId);
  } catch (err) {
    console.error(err);
    window.toast('No se pudo enviar la oferta por WhatsApp', 'error');
  }
};

// REQ-07: el envío de pedido habitual por WhatsApp ahora vive en
// clientes-ciclos.js (sección "Piloto Automático" de la ficha), que reemplaza
// a la función enviarPedidoHabitual() que pegaba directo a /api/piloto.

async function cargarAlertasScore() {
  try {
    const _freshTok = await getFreshToken();
    const resp = await fetch('/api/score?accion=alertas', {
      headers: { Authorization: `Bearer ${_freshTok}` }
    });
    if (!resp.ok) return;
    const { alertas } = await resp.json();
    renderAlertasScorePanel(alertas || []);
  } catch (err) {
    console.error('[Score] alertas:', err);
  }
}

function renderAlertasScorePanel(alertas) {
  const panel = document.getElementById('panel-alertas-score');
  if (!panel) return;
  if (!alertas.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  panel.innerHTML = `
    <div class="panel-alerta-title">⚠ ${alertas.length} alerta(s) de nivel de confianza</div>
    ${alertas.slice(0, 3).map(a => `
      <div class="alerta-score-row">
        <strong>${a.clientes?.razon_social}</strong>
        <span>${sanitize(a.mensaje)}</span>
        <button class="btn btn--xs btn--ghost" onclick="btnAsyncClick(this, () => resolverAlertaScore('${a.id}'))">Resolver</button>
      </div>`).join('')}
  `;
}

async function resolverAlertaScore(alertaId) {
  const _freshTok = await getFreshToken();
  await fetch('/api/score?accion=resolver-alerta', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_freshTok}`
    },
    body: JSON.stringify({ alerta_id: alertaId })
  });
  window.toast('Alerta resuelta');
  await cargarAlertasScore();
}

// Exponer en window
window.verScoreCliente    = verScoreCliente;
window.cargarAlertasScore = cargarAlertasScore;
window.resolverAlertaScore = resolverAlertaScore;

// ── confirmarBaja: dar de baja al cliente activo en modal ─────────────────
async function confirmarBaja() {
  if (!modalClienteId) return;
  if (!(await confirmar('¿Dar de baja a este cliente? Quedará inactivo.', { labelOk: 'Dar de baja', tipo: 'danger' }))) return;
  try {
    const { error } = await sb.from('clientes').update({ activo: false }).eq('id', modalClienteId);
    if (error) throw error;
    window.toast('Cliente dado de baja', 'warn');
    cerrarModal();
    await cargarClientes();
  } catch (err) {
    console.error(err);
    window.toast('No se pudo dar de baja al cliente', 'error');
  }
}
window.confirmarBaja = confirmarBaja;

// ── confirmarDesbloqueo: desbloqueo manual (override de admin) ────────────
// Hallazgo AUDITORIA_CRUD_TABLAS_2026: existía bloqueo automático por mora
// (motor de cierre) pero ningún botón para desbloquear a mano — un cliente
// que arregla la deuda por fuera del flujo automático (acuerdo de pago,
// error de carga) quedaba bloqueado para siempre salvo que se saldara
// completamente vía registrar_cobro_completo.
async function confirmarDesbloqueo() {
  if (!modalClienteId) return;
  if (!(await confirmar('¿Desbloquear a este cliente? Va a poder volver a hacer pedidos.', { labelOk: 'Desbloquear' }))) return;
  try {
    const token = await getFreshToken();
    const res = await fetch('/api/clientes?_svc=desbloquear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cliente_id: modalClienteId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'No se pudo desbloquear al cliente');
    }
    window.toast('Cliente desbloqueado', 'success');
    cerrarModal();
    await cargarClientes();
  } catch (err) {
    console.error(err);
    window.toast(err.message || 'No se pudo desbloquear al cliente', 'error');
  }
}
window.confirmarDesbloqueo = confirmarDesbloqueo;

// ── Acceso Portal Cliente ─────────────────────────────────────────────────────

async function gestionarAccesoPortal(clienteId, nombreCliente, tieneAcceso) {
  if (tieneAcceso) {
    // Revocar
    const ok = await confirmar(
      `¿Revocar el acceso portal de ${nombreCliente}? El cliente no podrá ingresar más.`,
      { labelOk: 'Revocar acceso', tipo: 'danger' }
    );
    if (!ok) return;

    try {
      const { data: { session: _sesRev } } = await sb.auth.getSession();
      const resp = await fetch('/api/clientes/acceso?_svc=acceso', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_sesRev?.access_token || ''}`
        },
        body: JSON.stringify({ cliente_id: clienteId, accion: 'revocar' })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      window.toast('Acceso revocado correctamente', 'warn');
      await cargarClientes();
    } catch (err) {
      console.error(err);
      window.toast('No se pudo revocar el acceso', 'error');
    }
    return;
  }

  // Crear acceso
  const overlay = document.getElementById('modal-portal-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.getElementById('modal-portal-nombre').textContent = nombreCliente;
  document.getElementById('modal-portal-resultado').style.display = 'none';
  document.getElementById('modal-portal-loading').style.display = 'flex';
  document.getElementById('btn-crear-acceso').dataset.clienteId = clienteId;
  document.getElementById('btn-crear-acceso').style.display = 'inline-flex';
  document.getElementById('modal-portal-loading').style.display = 'none';
}

async function confirmarCrearAcceso() {
  const btn = document.getElementById('btn-crear-acceso');
  const clienteId = btn.dataset.clienteId;
  btn.style.display = 'none';
  document.getElementById('modal-portal-loading').style.display = 'flex';

  try {
    const { data: { session: _sess } } = await sb.auth.getSession();
    const resp = await fetch('/api/clientes/acceso?_svc=acceso', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_sess?.access_token || ''}`
      },
      body: JSON.stringify({ cliente_id: clienteId, accion: 'crear' })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    document.getElementById('modal-portal-loading').style.display = 'none';
    document.getElementById('modal-portal-resultado').style.display = 'block';
    document.getElementById('portal-wa-texto').value = data.mensajeWA;
    // Setear link directo a WhatsApp
    document.getElementById('btn-abrir-wa').href = data.waLink;
    await cargarClientes();
  } catch (err) {
    console.error(err);
    document.getElementById('modal-portal-loading').style.display = 'none';
    document.getElementById('btn-crear-acceso').style.display = 'inline-flex';
    window.toast('No se pudo crear el acceso al portal', 'error');
  }
}

function copiarMensajeWA() {
  const txt = document.getElementById('portal-wa-texto').value;
  navigator.clipboard.writeText(txt).then(() => {
    window.toast('Mensaje copiado — pegalo en WhatsApp');
    document.getElementById('btn-copiar-wa').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Copiado';
    setTimeout(() => { document.getElementById('btn-copiar-wa').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>Copiar mensaje'; }, 2000);
  });
}

function cerrarModalPortal() {
  document.getElementById('modal-portal-overlay').style.display = 'none';
}

window.gestionarAccesoPortal = gestionarAccesoPortal;
window.confirmarCrearAcceso   = confirmarCrearAcceso;
window.copiarMensajeWA        = copiarMensajeWA;
window.cerrarModalPortal      = cerrarModalPortal;
// FIX: enviarEstadoCuenta se llama desde onclick="enviarEstadoCuenta('${id}')" generado
// dinámicamente, pero al ser este archivo un módulo ES6 no queda accesible en window.
window.enviarEstadoCuenta     = enviarEstadoCuenta;
