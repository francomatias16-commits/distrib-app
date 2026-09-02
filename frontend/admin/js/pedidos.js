// frontend/admin/js/pedidos.js — v257 (paginación y filtros server-side)
// MIGRACIÓN v39: window.renderTbody (DocumentFragment), toast() de admin-utils, AbortController
// MIGRACIÓN v257: se reemplaza el .limit(200) + filtrado/paginado en JS por
// las RPC fn_pedidos_lista / fn_pedidos_stats_mes (migración 257). `pedidos`
// y `filtrados` ahora contienen solo la página actual (≤20 filas), no el
// dataset completo — ver AUDITORIA_FILTROS_v280.md.

const mostrarToast = (msg, tipo='default') => window.mostrarToast(msg, tipo);

// REQ-13: Filtros avanzados — cliente, filtros rápidos "sin facturar" / "sin despachar",
//         persistencia en sessionStorage.
// REQ-06: Sugerencia FEFO al pasar pedido a estado "preparando".

// ── Config ─────────────────────────────────────────────────────────────────


// ── Estado ─────────────────────────────────────────────────────────────────
let usuario     = null;
let empresaData = null;
let pedidos     = [];           // todos los pedidos cargados
let filtrados   = [];           // después de filtros
let estadoActivo = '';
let pedidoActivo = null;        // pedido abierto en modal
let vendedoresMap = {};         // id vendedor -> nombre (para no mostrar el UUID crudo)

// pedido_id -> { estado, chofer_nombre } para los pedidos de la página
// actual que están asignados a una ruta de reparto (tabla `entregas`).
// Se usa para avisar en Pedidos si Despachar/Entregar se está confirmando
// a mano sin que el chofer lo haya hecho todavía desde su app.
let entregasPorPedido = new Map();

// ── Paginación de la tabla de pedidos ──────────────────────────────────────
const PEDIDOS_POR_PAGINA = 20;
let paginaActual = 1;
let totalCount   = 0;   // total de filas que matchean los filtros activos (viene de fn_pedidos_lista)

// REQ-06: Modal FEFO
let fefoModalPedidoId = null;

// Transiciones de estado válidas
const TRANSICIONES = {
  borrador:   ['confirmado', 'cancelado'],
  // FIX: rpc_crear_pedido (029) crea los pedidos con estado 'pendiente', no
  // 'borrador' — 'borrador' quedó como estado teórico sin uso real (0 filas
  // en producción al momento de este fix). 'pendiente' es el verdadero
  // estado inicial y le faltaban transiciones, chip y label.
  pendiente:  ['confirmado', 'cancelado'],
  confirmado: ['preparando', 'cancelado'],
  preparando: ['despachado', 'cancelado'],
  despachado: ['entregado'],
  entregado:  [],
  cancelado:  [],
};

// Mapeo estado → template de WhatsApp
const WA_TEMPLATE = {
  confirmado: (p) => ({
    template: 'confirmacion_pedido',
    params: {
      nombre_cliente: (p.clientes?.razon_social || '').split(/[\s,]+/)[0],
      // FIX: pedidos.numero no existe — usar id truncado como identificador
      numero_pedido:  p.id.substring(0, 8).toUpperCase(),
      total:          p.total,
    },
  }),
  despachado: (p) => ({
    template: 'pedido_despachado',
    params: {
      // FIX: pedidos.numero no existe — usar id truncado como identificador
      numero_pedido: p.id.substring(0, 8).toUpperCase(),
      total:         p.total,
    },
  }),
  cancelado: (p) => ({
    template: 'pedido_cancelado',
    params: {
      // FIX: pedidos.numero no existe — usar id truncado como identificador
      numero_pedido: p.id.substring(0, 8).toUpperCase(),
    },
  }),
};

async function enviarWhatsApp(template, telefono, params) {
  try {
    // FIX (auditoría v960): faltaba el Authorization Bearer — igual que
    // los demás fetch de este archivo (ver getSession() más abajo en el
    // mismo módulo). El backend ahora lo exige.
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    const resp = await fetch('/api/notif/whatsapp', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session?.access_token}`,
      },
      body:    JSON.stringify({ template, telefono, params }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.warn('[WA] Error al enviar:', data.error);
    } else {
      console.log('[WA] Enviado:', template, '→', telefono);
    }
  } catch (err) {
    console.error('[WA] Error de red:', err.message);
  }
}

// ── Inicialización ─────────────────────────────────────────────────────────
async function init() {
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }
  window.supabaseClient = window.supabaseClient;
  usuario     = window.authCtx.perfil;
  empresaData = window.authCtx.perfil?.empresas || { id: window.authCtx.perfil?.empresa_id, nombre: '', config: {} };

  if (empresaData) {
    document.title = `Pedidos — ${sanitize(empresaData.nombre)}`;
  }

  // Se carga primero el mapa de vendedores/zonas/clientes, después se
  // restauran los filtros guardados en sessionStorage (solo completa los
  // campos del form, no dispara fetch) y recién ahí se hace la única carga
  // inicial de pedidos, ya con esos filtros aplicados server-side.
  await cargarFiltrosSecundarios();
  initFiltroTabsEstado();
  restaurarFiltrosDeSession();
  await cargarPedidos();

  // Abrir pedido si viene por URL ?id=xxx (ej. deep-link desde "Confirmar"
  // en pedidos sugeridos del dashboard). El pedido puede no estar en la
  // página actual de la lista, así que si no aparece lo traemos puntual.
  const params = new URLSearchParams(window.location.search);
  if (params.get('id')) {
    await abrirModalPorId(params.get('id'));
  }

  suscribirRealtime();
}

// ── Lectura de filtros del form (compartida por cargarPedidos, export y
//    persistencia en sessionStorage) ────────────────────────────────────────
function leerFiltros() {
  return {
    busq:        document.getElementById('input-busqueda').value.toLowerCase().trim(),
    vendedor:    document.getElementById('filtro-vendedor').value,
    zona:        document.getElementById('filtro-zona').value,
    canal:       document.getElementById('filtro-canal')?.value || '',
    cliente:     document.getElementById('filtro-cliente')?.value || '',
    fechaDesde:  document.getElementById('filtro-fecha-desde')?.value || '',
    fechaHasta:  document.getElementById('filtro-fecha-hasta')?.value || '',
    montoMin:    parseFloat(document.getElementById('filtro-importe-min')?.value) || 0,
    sinFacturar:  document.getElementById('btn-sin-facturar')?.classList.contains('activo') || false,
    sinDespachar: document.getElementById('btn-sin-despachar')?.classList.contains('activo') || false,
  };
}

// Arma la fila plana que devuelve fn_pedidos_lista al mismo formato anidado
// {clientes: {..., zonas:{...}}} que ya esperan renderTabla/abrirModal, para
// no tener que tocar esas funciones.
function normalizarPedidoRpc(r) {
  return {
    id: r.id, estado: r.estado, subtotal: r.subtotal, descuento: r.descuento,
    iva_total: r.iva_total, total: r.total, remito_nro: r.remito_nro,
    notas_cliente: r.notas_cliente, fecha_pedido: r.fecha_pedido,
    fecha_entrega: r.fecha_entrega, created_at: r.created_at, canal: r.canal,
    forma_pago: r.forma_pago || 'cuenta_corriente',
    factura_id: r.factura_id, fecha_despacho: r.fecha_despacho,
    factura_estado: r.factura_estado, factura_error_detalle: r.factura_error_detalle,
    vendedor_id: r.vendedor_id,
    clientes: r.cliente_id ? {
      id: r.cliente_id, razon_social: r.cliente_razon_social,
      nombre_fantasia: r.cliente_nombre_fantasia, cuit: r.cliente_cuit,
      telefono: r.cliente_telefono, domicilio: r.cliente_domicilio,
      localidad: r.cliente_localidad, condicion_iva: r.cliente_condicion_iva,
      zonas: r.zona_id ? { id: r.zona_id, nombre: r.zona_nombre } : null,
    } : null,
  };
}

// ── Info de reparto para el aviso en Despachar/Entregar ─────────────────────
// Trae, para los pedidos de la página actual, si están asignados a una ruta
// (tabla `entregas`) y en qué estado está esa entrega desde el punto de
// vista del chofer ('pendiente'/'en_camino' = todavía no confirmó nada;
// 'entregado'/'no_entregado' = ya se expidió sobre esto desde su app).
// Best-effort: si falla, simplemente no se muestra el aviso extra — no
// bloquea la carga de pedidos.
async function cargarEntregasAsignadas(ids) {
  entregasPorPedido = new Map();
  if (!ids.length) return;
  // FIX (mismo bug de "Buscando y organizando..." colgado): esta llamada
  // corre ANTES de renderTabla() en cargarPedidos(), así que si se cuelga
  // (señal débil, ver conTimeoutRed en ui-utils.js) nunca se llega a pintar
  // la grilla aunque la carga principal de pedidos sí haya llegado. Es
  // best-effort (el aviso de reparto es un extra, no bloquea si falla), así
  // que ante timeout simplemente seguimos sin ese dato en vez de esperarlo.
  let data, error;
  try {
    ({ data, error } = await window.conTimeoutRed(
      window.supabaseClient
        .from('entregas')
        .select('pedido_id, estado, rutas(chofer_id, usuarios!chofer_id(nombre))')
        .in('pedido_id', ids),
      10000
    ));
  } catch (e) {
    console.warn('[Pedidos] No se pudo cargar info de reparto (timeout o error de red):', e.message);
    return;
  }
  if (error) {
    console.warn('[Pedidos] No se pudo cargar info de reparto:', error.message);
    return;
  }
  (data || []).forEach(e => {
    entregasPorPedido.set(e.pedido_id, {
      estado: e.estado,
      chofer_nombre: e.rutas?.usuarios?.nombre || null,
    });
  });
}

// ── Carga principal de pedidos (server-side: filtros + paginación) ─────────
async function cargarPedidos() {
  // REQ-09: Spinner humanizado mientras se buscan los pedidos
  const tbody = document.getElementById('tabla-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="8" class="tabla-loading" style="padding:48px 0;">
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
        <div style="width:36px;height:36px;border:3px solid var(--color-border-soft,#E7E9E4);border-top-color:var(--color-primary,#6A9873);border-radius:50%;animation:spin-loader .8s linear infinite;"></div>
        <span style="font-weight:600;color:var(--color-text,#111A17);font-size:14px;">Buscando y organizando la información en tiempo real...</span>
        <span style="font-size:12px;color:var(--color-text-light,#7A857E);">Esto tomará solo un instante. Gracias por tu paciencia.</span>
      </div>
    </td></tr>`;
  }

  const f = leerFiltros();
  const rpcParams = {
    p_busqueda:      f.busq || null,
    p_estado:        estadoActivo || null,
    p_vendedor_id:   f.vendedor || null,
    p_zona_id:       f.zona || null,
    p_canal:         f.canal || null,
    p_cliente_id:    f.cliente || null,
    p_fecha_desde:   f.fechaDesde || null,
    p_fecha_hasta:   f.fechaHasta || null,
    p_monto_min:     f.montoMin || null,
    p_sin_facturar:  f.sinFacturar,
    p_sin_despachar: f.sinDespachar,
    p_limit:         PEDIDOS_POR_PAGINA,
    p_offset:        (paginaActual - 1) * PEDIDOS_POR_PAGINA,
  };

  // Promise.allSettled en vez de Promise.all: ninguna de las dos llamadas
  // puede escapar sin capturar. Antes, si supabase-js tiraba una excepción
  // real (ej. carrera de refresh de token justo cuando se dispara esta carga
  // junto con otras llamadas casi simultáneas), Promise.all rechazaba entero
  // y la función cortaba sin manejar nada — acá cada resultado se resuelve
  // individualmente, haya sido éxito, error de negocio o excepción.
  //
  // FIX (bug reportado: pantalla de "Buscando y organizando..." colgada
  // para siempre con señal débil): window.supabaseClient apunta a Supabase
  // directo (otro origen), así que el Service Worker no la intercepta ni
  // le pone ningún límite de tiempo — y fetch() nativo tampoco tiene
  // timeout por defecto. Sin esto, Promise.allSettled esperaba a que la
  // llamada se rindiera sola, cosa que en una conexión débil (no caída del
  // todo) puede tardar más de un minuto o no pasar nunca. Con
  // conTimeoutRed(), a los 10s se rechaza igual que un error de red real y
  // cae en el branch de "No pudimos cargar los pedidos" que ya existía más
  // abajo — no hacía falta un estado nuevo, solo dejar de esperar de más.
  const [rLista, rStats] = await Promise.allSettled([
    window.conTimeoutRed(window.supabaseClient.rpc('fn_pedidos_lista', rpcParams), 10000),
    window.conTimeoutRed(window.supabaseClient.rpc('fn_pedidos_stats_mes'), 10000),
  ]);

  const data     = rLista.status === 'fulfilled' ? rLista.value?.data : null;
  const error    = rLista.status === 'fulfilled' ? rLista.value?.error : rLista.reason;
  const stats    = rStats.status === 'fulfilled' ? rStats.value?.data : null;
  const errStats = rStats.status === 'fulfilled' ? rStats.value?.error : rStats.reason;

  if (error) {
    console.error('[Pedidos] Error definitivo:', error);
    const tbodyErr = document.getElementById('tabla-body');
    if (tbodyErr) {
      tbodyErr.innerHTML = `<tr><td colspan="8" class="tabla-loading" style="padding:40px 0;">
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger-mid,#D1594A)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span style="font-weight:600;color:var(--color-text,#111A17);">No pudimos cargar los pedidos</span>
          <span style="font-size:13px;color:var(--color-text-muted,#5B6660);max-width:320px;text-align:center;">Revisá tu conexión a internet y recargá la página. Si el problema persiste, contactá soporte.</span>
          <button onclick="location.reload()" style="margin-top:4px;padding:6px 16px;border-radius:8px;background:var(--color-box-primary,#6A9873);color:var(--color-surface, #fff);border:none;cursor:pointer;font-weight:500;">Reintentar</button>
        </div>
      </td></tr>`;
    }
    return;
  }

  const filas = (data || []).map(normalizarPedidoRpc);
  pedidos    = filas;
  filtrados  = filas;
  totalCount = data && data.length ? Number(data[0].total_count) : 0;

  await cargarEntregasAsignadas(filas.map(p => p.id));

  renderTabla();
  guardarFiltrosEnSession();

  if (errStats) {
    console.warn('[Pedidos] No se pudieron cargar los stats del panel lateral:', errStats.message || errStats);
  } else {
    renderStatsLaterales(stats?.[0]);
  }
}

// ── Panel lateral: resumen del mes + conteo por estado ─────────────────────
// `s` viene de fn_pedidos_stats_mes(): global de la empresa, no depende de
// los filtros activos ni de la página actual (mismo comportamiento previo).
function renderStatsLaterales(s) {
  const elTotal = document.getElementById('side-total-pedidos');
  const elFact  = document.getElementById('side-total-facturado');
  if (!elTotal || !elFact || !s) return; // el tab de Presupuestos no tiene este panel

  elTotal.textContent = String(s.total_mes || 0);
  const facturado = Number(s.facturado_mes) || 0;
  elFact.textContent  = window.formatARS ? window.formatARS(facturado) : `$${facturado.toLocaleString('es-AR')}`;

  const conteo = {
    confirmado: s.conteo_confirmado || 0,
    preparando: s.conteo_preparando || 0,
    despachado: s.conteo_despachado || 0,
    entregado:  s.conteo_entregado  || 0,
  };
  ['confirmado', 'preparando', 'despachado', 'entregado'].forEach(e => {
    const el = document.getElementById(`side-e-${e}`);
    if (el) el.textContent = String(conteo[e]);
  });

  // Mismos totales del mes en los contadores de la barra FiltroTabs. No
  // hay conteo de "borrador"/"cancelado" en fn_pedidos_stats_mes ni un
  // total combinado confiable para "Todos" bajo los filtros activos —
  // esos badges quedan sin número (mismo criterio que "Todos" en
  // cheques.js).
  const contFiltro = document.getElementById('filtro-tabs-estado');
  if (contFiltro && typeof FiltroTabs !== 'undefined') {
    FiltroTabs.actualizarContadores(contFiltro, conteo);
  }
}

// ── Filtros secundarios (vendedores, zonas y clientes) ─────────────────────
async function cargarFiltrosSecundarios() {
  const [{ data: vendedores }, { data: zonas }, { data: clientes }] = await Promise.all([
    window.conTimeoutRed(window.supabaseClient.from('usuarios')
      .select('id, nombre')
      .eq('empresa_id', empresaData.id)
      .in('rol', ['vendedor','admin','dueno'])
      .eq('activo', true), 10000),
    window.conTimeoutRed(window.supabaseClient.from('zonas')
      .select('id, nombre')
      .eq('empresa_id', empresaData.id)
      .eq('activa', true), 10000),
    window.conTimeoutRed(window.supabaseClient.from('clientes')
      .select('id, razon_social, nombre_fantasia')
      .eq('empresa_id', empresaData.id)
      .eq('activo', true)
      .order('razon_social'), 10000),
  ]);

  const selV = document.getElementById('filtro-vendedor');
  (vendedores || []).forEach(v => {
    vendedoresMap[v.id] = v.nombre;
    const o = document.createElement('option');
    o.value = v.id; o.textContent = v.nombre;
    selV.appendChild(o);
  });

  const selZ = document.getElementById('filtro-zona');
  (zonas || []).forEach(z => {
    const o = document.createElement('option');
    o.value = z.id; o.textContent = z.nombre;
    selZ.appendChild(o);
  });

  // REQ-13: Filtro por cliente
  const selC = document.getElementById('filtro-cliente');
  if (selC) {
    (clientes || []).forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.nombre_fantasia || c.razon_social;
      selC.appendChild(o);
    });
  }
}

// ── Aplicar filtros ────────────────────────────────────────────────────────
// preservarPagina=true evita volver a la página 1 (usado por refrescos en
// segundo plano, p. ej. realtime, para no interrumpir al usuario mientras navega).
// preservarPagina=true: usado en refrescos en segundo plano (realtime) para
// no devolver al usuario a la página 1 mientras está navegando la tabla.
// Los filtros ahora se resuelven server-side (fn_pedidos_lista), así que
// "aplicar filtros" es: volver a página 1 (salvo que se pida preservarla) y
// disparar un nuevo fetch con el estado actual del form.
async function aplicarFiltros(preservarPagina = false) {
  if (!preservarPagina) paginaActual = 1;
  await cargarPedidos();
}

// ── REQ-13: Persistencia en sessionStorage ─────────────────────────────────
const SESSION_KEY = 'pedidos_filtros_v1';

function guardarFiltrosEnSession() {
  try {
    const estado = {
      busq:        document.getElementById('input-busqueda').value,
      vendedor:    document.getElementById('filtro-vendedor').value,
      zona:        document.getElementById('filtro-zona').value,
      canal:       document.getElementById('filtro-canal')?.value || '',
      cliente:     document.getElementById('filtro-cliente')?.value || '',
      fechaDesde:  document.getElementById('filtro-fecha-desde')?.value || '',
      fechaHasta:  document.getElementById('filtro-fecha-hasta')?.value || '',
      montoMin:  document.getElementById('filtro-importe-min')?.value || '',
      estadoActivo,
      sinFacturar:  document.getElementById('btn-sin-facturar')?.classList.contains('activo') || false,
      sinDespachar: document.getElementById('btn-sin-despachar')?.classList.contains('activo') || false,
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(estado));
  } catch {}
}

function restaurarFiltrosDeSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);

    if (s.busq)       document.getElementById('input-busqueda').value = s.busq;
    if (s.vendedor)   document.getElementById('filtro-vendedor').value = s.vendedor;
    if (s.zona)       document.getElementById('filtro-zona').value = s.zona;
    if (s.canal && document.getElementById('filtro-canal'))
                      document.getElementById('filtro-canal').value = s.canal;
    if (s.cliente && document.getElementById('filtro-cliente'))
                      document.getElementById('filtro-cliente').value = s.cliente;
    if (s.fechaDesde && document.getElementById('filtro-fecha-desde'))
                      document.getElementById('filtro-fecha-desde').value = s.fechaDesde;
    if (s.fechaHasta && document.getElementById('filtro-fecha-hasta'))
                      document.getElementById('filtro-fecha-hasta').value = s.fechaHasta;
    if (s.montoMin && document.getElementById('filtro-importe-min'))
                      document.getElementById('filtro-importe-min').value = s.montoMin;

    // Restaurar estado activo en la barra de FiltroTabs
    if (s.estadoActivo) {
      estadoActivo = s.estadoActivo;
      initFiltroTabsEstado();
    }

    // Restaurar filtros rápidos
    if (s.sinFacturar) {
      const btn = document.getElementById('btn-sin-facturar');
      if (btn) btn.classList.add('activo');
    }
    if (s.sinDespachar) {
      const btn = document.getElementById('btn-sin-despachar');
      if (btn) btn.classList.add('activo');
    }

    // No dispara fetch acá: solo completa el form. init() hace la única
    // carga inicial después de llamar a esta función, ya con estos valores
    // puestos (ver MIGRACIÓN v257).
  } catch {}
}

// ── REQ-13: Filtros rápidos ────────────────────────────────────────────────
// FIX (v706): en mobile, filtros-der (cliente/vendedor/zona/canal/fechas/
// importe) queda oculto por defecto (ver pedidos.css @media 900px) y se
// despliega solo al tocar este botón. En desktop el botón ni se muestra
// (display:none fuera del media query), así que acá no hace falta chequear
// el ancho de pantalla.
function toggleFiltrosAvanzados() {
  const btn = document.getElementById('btn-toggle-filtros-der');
  const der = document.getElementById('filtros-der');
  if (!der) return;
  const abierto = der.classList.toggle('abierto');
  if (btn) {
    btn.classList.toggle('abierto', abierto);
    btn.setAttribute('aria-expanded', String(abierto));
  }
}

function toggleFiltroRapido(id) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.classList.toggle('activo');

  // Los filtros rápidos son mutuamente excluyentes con el filtro de estado
  // (no se cancelan entre sí, se pueden combinar)
  aplicarFiltros();
}

// FiltroTabs (frontend/shared/filtro-tabs.js) — mismo patrón que
// cta-cte.js/cheques.js: crea la barra de pestañas y maneja el estado
// "activa" del botón clickeado, acá solo se sincroniza `estadoActivo` y
// se dispara el filtro. Los contadores por estado se completan aparte,
// en renderStatsLaterales(), con los mismos totales del mes que ya trae
// fn_pedidos_stats_mes() (no son exactos sobre los filtros combinados —
// vendedor/zona/búsqueda/fecha —, son el total del mes por estado, igual
// que el panel lateral que reemplazan en este rol).
function initFiltroTabsEstado() {
  const cont = document.getElementById('filtro-tabs-estado');
  if (!cont || typeof FiltroTabs === 'undefined') return;
  FiltroTabs.crear(cont, [
    { key: '',           label: 'Todos' },
    { key: 'borrador',   label: 'Borrador' },
    { key: 'confirmado', label: 'Confirmado' },
    { key: 'preparando', label: 'Preparando' },
    { key: 'despachado', label: 'Despachado' },
    { key: 'entregado',  label: 'Entregado' },
    { key: 'cancelado',  label: 'Cancelado' },
  ], estadoActivo, (key) => selEstado(key));
}

function selEstado(estado) {
  estadoActivo = estado;
  aplicarFiltros();
}

function limpiarFiltros() {
  document.getElementById('input-busqueda').value = '';
  document.getElementById('filtro-vendedor').value = '';
  document.getElementById('filtro-zona').value = '';
  if (document.getElementById('filtro-canal')) document.getElementById('filtro-canal').value = '';
  const selC = document.getElementById('filtro-cliente');
  if (selC) selC.value = '';
  if (document.getElementById('filtro-fecha-desde')) document.getElementById('filtro-fecha-desde').value = '';
  if (document.getElementById('filtro-fecha-hasta')) document.getElementById('filtro-fecha-hasta').value = '';
  if (document.getElementById('filtro-importe-min')) document.getElementById('filtro-importe-min').value = '';

  // Limpiar filtros rápidos
  document.getElementById('btn-sin-facturar')?.classList.remove('activo');
  document.getElementById('btn-sin-despachar')?.classList.remove('activo');

  estadoActivo = '';
  initFiltroTabsEstado();

  try { sessionStorage.removeItem(SESSION_KEY); } catch {}

  aplicarFiltros();
}

// ── Render tabla (paginada, 20 pedidos por página) ─────────────────────────
function renderTabla() {
  // `filtrados` ya es la página actual (vino de fn_pedidos_lista con
  // LIMIT/OFFSET), no hace falta recortarla acá.
  const totalPaginas = Math.max(1, Math.ceil(totalCount / PEDIDOS_POR_PAGINA));
  const desde  = (paginaActual - 1) * PEDIDOS_POR_PAGINA;
  const pagina = filtrados;

  const tbody = document.getElementById('tabla-body');
  window.renderTbody(tbody, pagina, (p) => {
    const cliente  = p.clientes?.nombre_fantasia || p.clientes?.razon_social || '—';
    const vendedor = vendedoresMap[p.vendedor_id] || (p.vendedor_id ? 'Vendedor eliminado' : '—');
    const zona     = p.clientes?.zonas?.nombre || '—';
    const fecha    = p.fecha_entrega ? fmtFecha(p.fecha_entrega) : '—';
    const hora     = new Date(p.created_at).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
    const sigEstados = TRANSICIONES[p.estado] || [];
    const facturaConError = !!p.factura_id && ['pendiente', 'error_afip'].includes(p.factura_estado);

    return `
      <tr class="fila-pedido" data-id="${p.id}" data-estado="${p.estado}" data-zona="${escHtml(p.clientes?.zonas?.nombre || '')}" onclick="abrirModalPorId('${p.id}')">
        <td class="td-id" data-label="N° Pedido">
          <span class="pedido-id">#${p.id.slice(-6).toUpperCase()}</span>
          <span class="pedido-hora">${hora}</span>
        </td>
        <td class="td-cliente" data-label="Cliente">
          <div class="cliente-celda">
            <span class="avatar-iniciales" style="background:${colorAvatar(cliente)}">${iniciales(cliente)}</span>
            <span class="cliente-nombre-txt" title="${escHtml(cliente)}">${escHtml(cliente)}</span>
          </div>
        </td>
        <td class="td-text" data-label="Vendedor">${escHtml(vendedor)}</td>
        <td class="td-text" data-label="Zona">${escHtml(zona)}</td>
        <td class="td-text" data-label="Entrega">${fecha}</td>
        <td class="td-total" data-label="Total">${window.formatARS(p.total)}</td>
        <td data-label="Estado">
          <span class="chips-estado-pedido">
            <span class="chip chip-${p.estado}">${capEstado(p.estado)}</span>
            ${facturaConError ? `<span class="chip" title="La factura de este pedido no se emitió con éxito (AFIP/ARCA)" style="background:var(--color-danger-bg,#F5DDD8);color:var(--color-danger,#7A2820);border:1px solid var(--color-danger-mid,#D1594A);margin-left:4px;">Factura con error</span>` : ''}
            ${chipDevolucion(p.devolucion_estado, p.id)}
          </span>
        </td>
        <td class="td-acciones col-sticky-end" data-label="Acciones" onclick="event.stopPropagation()">
          ${sigEstados.filter(e=>e!=='cancelado').map(e =>
            `<button class="btn-estado btn-est-${e}" title="${escHtml(etiquetaAccion(e, true))}" onclick="btnAsyncClick(this, () => cambiarEstado('${p.id}', '${e}'))">${etiquetaAccion(e)}</button>`
          ).join('')}
          ${sigEstados.length === 0
            ? `<button class="btn-ver-detalle" title="Ver detalle del pedido" onclick="abrirModalPorId('${p.id}')">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
               </button>`
            : ''}
          <button class="btn-eliminar-small" title="Eliminar pedido" onclick="confirmarEliminarPedido('${p.id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </td>
      </tr>`;
  }, 8, 'No hay pedidos que coincidan con los filtros. Probá cambiar el estado, la zona o el rango de fechas.');

  renderPaginacion(totalPaginas, desde, pagina.length);
}

// ── Paginador ──────────────────────────────────────────────────────────────
function renderPaginacion(totalPaginas, desde, cantidadEnPagina) {
  const cont = document.getElementById('paginacion-pedidos');
  if (!cont) return;

  if (!totalCount) { cont.innerHTML = ''; return; }

  const desdeVisible = totalCount ? desde + 1 : 0;
  const hastaVisible  = desde + cantidadEnPagina;

  // Ventana de números de página: máximo 5 alrededor de la actual
  const ventana = 5;
  let inicio = Math.max(1, paginaActual - Math.floor(ventana / 2));
  let fin    = Math.min(totalPaginas, inicio + ventana - 1);
  inicio     = Math.max(1, fin - ventana + 1);

  let numeros = '';
  for (let i = inicio; i <= fin; i++) {
    numeros += `<button type="button" class="pg-num${i === paginaActual ? ' activa' : ''}" onclick="irAPagina(${i})">${i}</button>`;
  }

  cont.innerHTML = `
    <span class="pg-rango">Mostrando <strong>${desdeVisible}–${hastaVisible}</strong> de <strong>${totalCount}</strong> pedidos</span>
    <div class="pg-controles">
      <button type="button" class="pg-nav" onclick="irAPagina(${paginaActual - 1})" ${paginaActual <= 1 ? 'disabled' : ''} aria-label="Página anterior">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      ${inicio > 1 ? `<button type="button" class="pg-num" onclick="irAPagina(1)">1</button><span class="pg-dots">…</span>` : ''}
      ${numeros}
      ${fin < totalPaginas ? `<span class="pg-dots">…</span><button type="button" class="pg-num" onclick="irAPagina(${totalPaginas})">${totalPaginas}</button>` : ''}
      <button type="button" class="pg-nav" onclick="irAPagina(${paginaActual + 1})" ${paginaActual >= totalPaginas ? 'disabled' : ''} aria-label="Página siguiente">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>`;
}

async function irAPagina(n) {
  const totalPaginas = Math.max(1, Math.ceil(totalCount / PEDIDOS_POR_PAGINA));
  if (n < 1 || n > totalPaginas || n === paginaActual) return;
  paginaActual = n;
  await cargarPedidos();
  // Llevar la vista al inicio de la tabla, no del todo arriba de la página
  document.querySelector('.tabla-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.irAPagina = irAPagina;

// ── Modal detalle ──────────────────────────────────────────────────────────
async function abrirModalPorId(id) {
  let p = pedidos.find(x => x.id === id);
  if (!p) {
    p = await obtenerPedidoPorId(id);
    if (!p) {
      window.mostrarToast?.('No se encontró el pedido', 'err');
      return;
    }
    pedidos = [p, ...pedidos];
  }
  await abrirModal(p);
}

// Trae un pedido puntual por id (usado para deep-links: dashboard de
// pedidos sugeridos confirmados, notificaciones, etc. que pueden apuntar a
// un pedido fuera de los 200 más recientes cargados en la lista).
async function obtenerPedidoPorId(id) {
  const { data, error } = await window.conTimeoutRed(window.supabaseClient.from('pedidos')
    .select(`
      id, estado, subtotal, descuento, iva_total, total, remito_nro,
      notas_cliente, fecha_pedido, fecha_entrega, created_at,
      factura_id, fecha_despacho,
      clientes(id, razon_social, nombre_fantasia, cuit, telefono,
               domicilio, localidad, condicion_iva, zonas(id, nombre)),
      facturas(estado, notas_error),
      vendedor_id
    `)
    .eq('id', id)
    .eq('empresa_id', empresaData.id)
    .maybeSingle(), 10000);

  if (error || !data) {
    console.error('[pedidos] obtenerPedidoPorId:', error?.message);
    return null;
  }
  // Aplanar facturas(...) al mismo shape que devuelve fn_pedidos_lista
  // (factura_estado/factura_error_detalle), para que abrirModal/puedeFacturar
  // no tengan que distinguir de dónde vino el pedido.
  const { facturas: fact, ...resto } = data;
  return { ...resto, factura_estado: fact?.estado || null, factura_error_detalle: fact?.notas_error || null };
}

const NOTIF_CANAL_LABEL  = { whatsapp: 'WhatsApp', email: 'Email', push: 'Push' };
const NOTIF_MOTIVO_LABEL = {
  sin_telefono:                  'Cliente sin teléfono cargado',
  sin_email:                     'Cliente sin email cargado',
  cliente_no_encontrado:         'No se encontraron los datos del cliente',
  no_configurado:                'Envío de emails no configurado',
  error_envio:                   'Error al enviar',
  error_resend:                  'Error del proveedor de email',
  error_red:                     'Error de red',
  error_inesperado:              'Error inesperado',
  error_desconocido:             'Error desconocido',
  sin_dispositivos:              'Cliente sin dispositivo registrado',
  error_consultando_dispositivos:'Error consultando dispositivos',
  todos_los_tokens_fallaron:     'Todos los dispositivos rechazaron el envío',
  rate_limit_interno:            'Límite interno de envíos alcanzado',
};

async function _renderNotifStatus(pedidoId) {
  const wrap = document.getElementById('modal-notif-wrap');
  const lista = document.getElementById('modal-notif-lista');
  if (!wrap || !lista) return;

  const { data: logs, error } = await window.conTimeoutRed(window.supabaseClient
    .from('notif_log')
    .select('canal, entregada, motivo, created_at')
    .eq('pedido_id', pedidoId)
    .eq('tipo', 'confirmacion_pedido')
    .order('created_at', { ascending: true }), 10000);

  if (error || !logs || logs.length === 0) {
    wrap.style.display = 'none';
    lista.innerHTML = '';
    return;
  }

  wrap.style.display = 'block';
  lista.innerHTML = logs.map(l => {
    const canalLabel = NOTIF_CANAL_LABEL[l.canal] || l.canal;
    const badgeClass = l.entregada ? 'notif-badge--ok' : 'notif-badge--fail';
    const badgeTexto = l.entregada ? 'Entregada' : 'No entregada';
    const motivo = !l.entregada && l.motivo
      ? `<span class="info-row" style="font-size:12px;color:var(--color-text-muted)">${sanitize(NOTIF_MOTIVO_LABEL[l.motivo] || l.motivo)}</span>`
      : '';
    return `
      <div class="notif-item">
        <span class="notif-canal">${sanitize(canalLabel)}</span>
        <span class="notif-badge ${badgeClass}">${badgeTexto}</span>
      </div>
      ${motivo}`;
  }).join('');
}

// v808: devoluciones vinculadas a este pedido — antes no había ninguna
// señal de esto en /admin/pedidos, había que ir a /admin/devoluciones y
// cruzar el pedido_id a mano. Mismo patrón que _renderNotifStatus: consulta
// directa vía RLS (window.supabaseClient), no pasa por el endpoint /api.
const DEVOLUCION_ESTADO_LABEL = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada' };
const DEVOLUCION_MOTIVO_LABEL = {
  producto_defectuoso: 'Producto defectuoso', error_pedido: 'Error de pedido',
  cliente_arrepentido: 'Cliente arrepentido', vencido: 'Vencido', otro: 'Otro',
};

async function _renderDevolucionesPedido(pedidoId) {
  const wrap  = document.getElementById('modal-devoluciones-wrap');
  const lista = document.getElementById('modal-devoluciones-lista');
  if (!wrap || !lista) return;

  const { data: devs, error } = await window.conTimeoutRed(window.supabaseClient
    .from('devoluciones')
    .select('id, estado, motivo, created_at')
    .eq('pedido_id', pedidoId)
    .order('created_at', { ascending: false }), 10000);

  if (error || !devs || devs.length === 0) {
    wrap.style.display = 'none';
    lista.innerHTML = '';
    return;
  }

  wrap.style.display = 'block';
  const badgeClasePorEstado = { pendiente: 'notif-badge--pendiente', aprobada: 'notif-badge--ok', rechazada: 'notif-badge--fail' };
  lista.innerHTML = devs.map(d => `
    <div class="notif-item">
      <span class="notif-canal">${DEVOLUCION_MOTIVO_LABEL[d.motivo] || d.motivo} · ${fmtFecha(d.created_at)}</span>
      <span class="notif-badge ${badgeClasePorEstado[d.estado] || 'notif-badge--fail'}">${DEVOLUCION_ESTADO_LABEL[d.estado] || d.estado}</span>
    </div>
  `).join('') + `
    <a href="/admin/devoluciones?pedido_id=${encodeURIComponent(pedidoId)}" class="btn-link" style="display:inline-block;margin-top:6px;">
      Ver detalle en Devoluciones →
    </a>`;
}

async function abrirModal(p) {
  pedidoActivo = p;
  window.pedidoActivo = p; // FIX v810: pedidos.js es módulo ES6, "let pedidoActivo"
  // no llega a window — los onclick inline en pedidos.html (btn-generar-factura,
  // btn-imprimir-remito) corren en scope global y tiraban "pedidoActivo is not
  // defined" (ReferenceError, antes tapado por el catch genérico de btnAsyncClick).

  // Título
  document.getElementById('modal-titulo').textContent = `Pedido #${p.id.slice(-6).toUpperCase()}`;
  document.getElementById('modal-subtitulo').textContent =
    new Date(p.created_at).toLocaleString('es-AR', { dateStyle:'long', timeStyle:'short' });

  // Estado actual + selector de próximo estado
  const sig = TRANSICIONES[p.estado] || [];
  document.getElementById('modal-estado-row').innerHTML = `
    <span class="chip chip-${p.estado} chip-lg">${capEstado(p.estado)}</span>
    ${p.forma_pago === 'pago_inmediato' ? `<span class="chip chip-pago-inmediato chip-lg" title="El cliente eligió pagar por afuera de la cuenta corriente — coordinar el cobro (transferencia/efectivo)">Pago inmediato — cobrar</span>` : ''}
    ${sig.filter(e=>e!=='cancelado').map(e =>
      `<button class="btn-estado btn-est-${e}" onclick="btnAsyncClick(this, async () => { const ok = await cambiarEstado('${p.id}','${e}'); if (ok) cerrarModal(); })">
        ${etiquetaAccion(e, true)}
      </button>`
    ).join('')}
    <span class="modal-acciones-danger">
      ${p.estado !== 'entregado' && p.estado !== 'cancelado'
        ? `<button class="btn-cancelar-modal" onclick="cerrarModal();confirmarCancelar('${p.id}')">Cancelar pedido</button>`
        : ''}
      <button class="btn-eliminar-modal" onclick="confirmarEliminarPedido('${p.id}')">Eliminar pedido</button>
    </span>
  `;

  // Info cliente
  const c = p.clientes;
  document.getElementById('modal-cliente-info').innerHTML = c ? `
    <div class="info-row"><strong>${sanitize(c.razon_social)}</strong>${c.nombre_fantasia ? ` · ${sanitize(c.nombre_fantasia)}` : ''}</div>
    ${c.telefono ? `<div class="info-row">
      <a class="link-wa" href="https://wa.me/${limpiarTel(c.telefono)}" target="_blank">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        ${sanitize(c.telefono)}
      </a>
    </div>` : ''}
    ${c.zonas?.nombre ? `<div class="info-row">Zona: ${sanitize(c.zonas.nombre)}</div>` : ''}
    ${p.fecha_entrega ? `<div class="info-row">Entrega pactada: <strong>${fmtFecha(p.fecha_entrega)}</strong></div>` : ''}
  ` : '<div class="info-row">Sin datos del cliente</div>';

  // REQ-07: Banner de rellenado predictivo
  _mostrarBannerPredictivo(p);

  // Items del pedido
  const { data: items } = await window.conTimeoutRed(window.supabaseClient.from('pedido_items')
    .select('cantidad, precio_unitario, descuento_pct, subtotal, productos(nombre, unidad)')
    .eq('pedido_id', p.id), 10000);

  document.getElementById('modal-items').innerHTML = (items||[]).map(i => `
    <div class="item-row">
      <div class="item-nombre">${sanitize(i.productos?.nombre || '—')}</div>
      <div class="item-det">
        ${i.cantidad} ${i.productos?.unidad || 'u'} × ${window.formatARS(i.precio_unitario)}
        ${i.descuento_pct > 0 ? `<span class="item-desc">−${i.descuento_pct}%</span>` : ''}
      </div>
      <div class="item-subtotal">${window.formatARS(i.subtotal)}</div>
    </div>`
  ).join('') || '<div class="info-row">Sin items</div>';

  // Totales
  document.getElementById('modal-totales').innerHTML = `
    <div class="total-row"><span>Subtotal</span><span>${window.formatARS(p.subtotal)}</span></div>
    ${p.descuento > 0 ? `<div class="total-row total-desc"><span>Descuento</span><span>−${window.formatARS(p.descuento)}</span></div>` : ''}
    <div class="total-row"><span>IVA</span><span>${window.formatARS(p.iva_total)}</span></div>
    <div class="total-row total-final"><span>Total</span><span>${window.formatARS(p.total)}</span></div>
  `;

  // Notas
  const notasWrap = document.getElementById('modal-notas-wrap');
  if (p.notas_cliente) {
    notasWrap.style.display = 'block';
    document.getElementById('modal-notas').textContent = p.notas_cliente;
  } else {
    notasWrap.style.display = 'none';
  }

  // v808: devoluciones vinculadas a este pedido — se consulta siempre acá
  // (no se confía en p.devolucion_estado, que solo viene resuelto cuando
  // el pedido salió de la lista paginada; si el modal se abrió por
  // deep-link vía obtenerPedidoPorId() ese campo no está).
  await _renderDevolucionesPedido(p.id);

  // Estado de notificaciones (Hallazgo 2, auditoría notificaciones): lee
  // notif_log para mostrar si la confirmación por WhatsApp/email/push se
  // entregó o falló (y por qué), en vez de quedar invisible como antes.
  await _renderNotifStatus(p.id);

  // Generar comprobante de venta: solo si el pedido ya está en curso (no borrador,
  // no cancelado) y todavía no tiene una factura asociada.
  const btnFactura = document.getElementById('btn-generar-factura');
  if (btnFactura) {
  // Generar comprobante de venta: si el pedido está en curso (no borrador,
  // no cancelado) y (a) todavía no tiene factura asociada, o (b) la tiene
  // pero nunca se emitió con éxito (pendiente/error_afip — el intento
  // anterior falló, hay que reintentar). Antes solo miraba `!p.factura_id`,
  // así que un pedido con factura fallida quedaba sin botón para
  // reintentar (Hallazgo 1, auditoría Etapa 1 - Pedidos).
  const facturaSinEmitir = !p.factura_id || ['pendiente', 'error_afip'].includes(p.factura_estado);
  const puedeFacturar = facturaSinEmitir && p.estado !== 'borrador' && p.estado !== 'pendiente' && p.estado !== 'cancelado';
  btnFactura.style.display = puedeFacturar ? '' : 'none';
  btnFactura.disabled = false;
  const esReintento = puedeFacturar && !!p.factura_id;
  btnFactura.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
    ${esReintento ? 'Reintentar Comprobante de Venta' : 'Generar Comprobante de Venta'}`;
  document.getElementById('info-error-factura')?.remove();
  if (esReintento && p.factura_error_detalle) {
    // FIX: antes se insertaba con btnFactura.insertAdjacentElement('afterend', ...),
    // lo que lo metía como TERCER hijo flex dentro de #modal-acciones (junto a los
    // dos botones). #modal-acciones es `display:flex; justify-content:flex-end`
    // sin flex-wrap (ver pedidos-gentelella.css) y este div no tenía ancho propio,
    // así que el texto se comprimía a un ancho mínimo y cada palabra terminaba en
    // su propia línea ("Último / error / de / facturación..."), superpuesto con
    // el botón "Imprimir remito". Se inserta ahora ANTES de #modal-acciones, como
    // fila propia de ancho completo (mismo patrón que .modal-seccion), y los
    // botones quedan solos en su fila.
    const errWrap = document.createElement('div');
    errWrap.id = 'info-error-factura';
    errWrap.className = 'info-row';
    errWrap.style.cssText = 'color:var(--color-danger,#7A2820);margin-top:-8px;';
    errWrap.textContent = `Último error de facturación: ${p.factura_error_detalle}`;
    const modalAcciones = document.getElementById('modal-acciones');
    modalAcciones.insertAdjacentElement('beforebegin', errWrap);
  }
  }

  // Abrir modal
  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-pedido').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function cerrarModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-pedido').classList.remove('open');
  document.body.style.overflow = '';
  pedidoActivo = null;
  window.pedidoActivo = null; // FIX v810: mantener sincronizado con el getter global
  // REQ-07: Limpiar banner predictivo al cerrar
  const bannerPrev = document.getElementById('banner-predictivo');
  if (bannerPrev) bannerPrev.remove();
}

// ── REQ-06: Modal FEFO ──────────────────────────────────────────────────────
async function mostrarSugerenciasFEFO(pedidoId) {
  try {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    const resp = await fetch(`/api/lotes/fefo?pedido_id=${pedidoId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    if (!resp.ok) {
      // Si no hay endpoint FEFO o falla, continuar sin bloquear el flujo
      console.warn('[FEFO] No se pudo obtener sugerencias:', resp.status);
      return true;
    }

    const json = await resp.json();
    const sugerencias = json.sugerencias || [];

    // Si no hay lotes registrados para ningún producto, no mostrar modal
    const haySugerencias = sugerencias.some(s => s.lotes.length > 0);
    if (!haySugerencias) return true;

    return new Promise(resolve => {
      fefoModalPedidoId = pedidoId;

      const html = `
        <div class="fefo-overlay" id="fefo-overlay" onclick="event.target.id==='fefo-overlay'&&cerrarFEFO(true)">
          <div class="fefo-box">
            <div class="fefo-header">
              <h3>Sugerencia de lotes — FEFO</h3>
              <p class="fefo-sub">Usá primero los lotes con fecha de vencimiento más próxima</p>
            </div>
            <div class="fefo-lista">
              ${sugerencias.map(s => `
                <div class="fefo-producto">
                  <div class="fefo-prod-nombre">
                    <strong>${escHtml(s.nombre)}</strong>
                    <span class="fefo-cant-badge">× ${s.cantidad_pedida}</span>
                    ${s.faltante > 0 ? `<span class="fefo-faltante">⚠ Falta: ${s.faltante}</span>` : ''}
                    ${s.sin_seguimiento > 0 ? `<span class="fefo-sin-seguimiento">ℹ ${s.sin_seguimiento} sin lote registrado</span>` : ''}
                  </div>
                  ${s.lotes.length === 0
                    ? (s.stock_disponible_real > 0
                        ? `<div class="fefo-sin-lotes">Sin lotes con vencimiento registrado — hay ${s.stock_disponible_real} en stock sin tracking de lote</div>`
                        : '<div class="fefo-sin-lotes">Sin lotes con vencimiento registrado</div>')
                    : s.lotes.map(l => `
                      <div class="fefo-lote">
                        <span class="fefo-lote-nro">${escHtml(l.numero_lote)}</span>
                        <span class="fefo-lote-dep">${escHtml(l.deposito)}</span>
                        <span class="fefo-lote-venc">Vence: <strong>${fmtFecha(l.fecha_vencimiento)}</strong></span>
                        <span class="fefo-lote-usar">Usar: <strong>${l.usar_cantidad}</strong></span>
                      </div>`).join('')
                  }
                </div>
              `).join('')}
            </div>
            <div class="fefo-acciones">
              <button class="btn-secundario" onclick="cerrarFEFO(false)">Cancelar</button>
              <button class="btn-primario" onclick="cerrarFEFO(true)">Entendido — continuar</button>
            </div>
          </div>
        </div>`;

      // Inyectar y mostrar
      const div = document.createElement('div');
      div.innerHTML = html;
      document.body.appendChild(div.firstElementChild);

      // Definir cerrarFEFO en window para los onclick inline
      window.cerrarFEFO = function(continuar) {
        const overlay = document.getElementById('fefo-overlay');
        if (overlay) overlay.remove();
        delete window.cerrarFEFO;
        resolve(continuar);
      };
    });

  } catch (err) {
    console.warn('[FEFO] Error:', err.message);
    return true; // no bloquear el flujo si FEFO falla
  }
}

// ── Generar comprobante de venta (factura) para un pedido ──────────────────
// Llama al endpoint /api/facturas (lib/facturas.js → emitirFactura), que ya
// existe en el backend: crea/reutiliza el registro en `facturas` e intenta
// emitirlo contra el proveedor de facturación configurado. No se toca nada
// de esa lógica acá, solo se expone el botón en la UI.
async function generarFactura(pedidoId) {
  if (!pedidoId) return;

  const btn = document.getElementById('btn-generar-factura');
  const iconoSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  const restaurarBoton = (texto) => {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = `${iconoSvg} ${texto}`;
  };

  try {
    // Antes esta llamada quedaba fuera del try/catch: si getSession() fallaba
    // (token vencido, hiccup de red al arrancar), la excepción se escapaba de
    // esta función y la atrapaba el catch genérico de btnAsyncClick, mostrando
    // "Ocurrió un error. Intentá de nuevo." sin ningún detalle útil.
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) { window.location.href = '/admin/login'; return; }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = 'Generando comprobante...';
    }

    const r = await fetch('/api/facturas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ pedido_id: pedidoId }),
    });

    let json = null;
    try {
      json = await r.json();
    } catch {
      // El backend respondió algo que no es JSON (ej: 500 sin body estructurado).
      throw new Error(`El servidor respondió con un error (${r.status}). Probá de nuevo en un momento.`);
    }

    if (!r.ok || json?.error) {
      // Este caso puntual no es una falla del sistema: es que la empresa
      // todavía no cargó su configuración de facturación ARCA/AFIP. Mostrarlo
      // como un toast de error rojo genera confusión (parece que algo se
      // rompió). En cambio, mostramos un aviso claro con una acción directa
      // para ir a resolverlo.
      if (json?.codigo === 'sin_configuracion_facturacion') {
        restaurarBoton('Generar Comprobante de Venta');
        const ir = await window.confirmar(
          'Todavía no configuraste la facturación electrónica (ARCA/AFIP) de esta empresa.<br><br>' +
          'Necesitás cargar el CUIT, el punto de venta y el certificado antes de poder emitir comprobantes.',
          { labelOk: 'Ir a configurar', labelCancel: 'Cerrar' }
        );
        if (ir) window.location.href = '/admin/facturacion-config';
        return;
      }

      window.toast(json?.error || 'No se pudo generar el comprobante. Probá de nuevo en un momento.', 'error');
      restaurarBoton('Generar Comprobante de Venta');
      return;
    }

    window.toast('Comprobante generado correctamente.', 'exito');

    // Reflejar el cambio sin recargar todo: marcamos el pedido como facturado
    const p = pedidos.find(x => x.id === pedidoId);
    if (p) p.factura_id = json?.factura?.id || true;
    if (btn) btn.style.display = 'none';
    aplicarFiltros();
  } catch (err) {
    console.error('[pedidos] Error al generar comprobante:', err);
    window.toast(err?.message || 'Error de conexión. Revisá tu internet e intentá de nuevo.', 'error');
    restaurarBoton('Generar Comprobante de Venta');
  }
}

// ── Cambiar estado del pedido (via RPC para transacciones atómicas) ─────────
// FIX: antes ningún cambio de estado pedía confirmación (salvo "cancelado"
// y "eliminar", que ya tenían su propio diálogo) — un solo click en el
// botón de la fila, o uno accidental cerca de otros botones, disparaba la
// transición al instante. Mensajes por estado para ese diálogo previo;
// "cancelado" queda afuera de este mapa porque ya se confirma en
// confirmarCancelar() y no queremos pedir confirmación dos veces.
const MENSAJE_CONFIRMACION_ESTADO = {
  confirmado: (num) => `¿Confirmar el pedido ${num}? Se reserva el stock y se valida el crédito del cliente.`,
  preparando: (num) => `¿Marcar el pedido ${num} como "En preparación"?`,
  despachado: (num) => `¿Despachar el pedido ${num}? Se avisa al cliente que su pedido está en camino.`,
  entregado:  (num) => `¿Confirmar la entrega del pedido ${num}? Es el último paso: una vez entregado no se puede volver atrás.`,
};

async function cambiarEstado(id, nuevoEstado) {
  const perfil = window.authCtx?.perfil;
  if (!perfil) { window.toast('Sin sesión'); return false; }

  // FIX: "Despachar" desde Pedidos actualizaba el estado directo a mano,
  // sin pasar nunca por Repartos — el pedido nunca generaba una fila en
  // `entregas`, así que quedaba invisible para ese módulo (no aparecía ni
  // como pendiente de asignar ni como parte de ninguna ruta). Ahora se
  // exige que el pedido ya tenga una ruta asignada (cualquier fila en
  // `entregas`, sea cual sea su estado) antes de poder despacharlo a mano;
  // si no la tiene, se lo manda a Repartos a asignarla primero.
  if (nuevoEstado === 'despachado' && !entregasPorPedido.has(id)) {
    const ir = await window.confirmar(
      'Este pedido todavía no tiene una ruta de reparto asignada.<br><br>' +
      'Asignalo desde Repartos antes de despacharlo.',
      { labelOk: 'Ir a Repartos', labelCancel: 'Cerrar' }
    );
    if (ir) window.location.href = '/admin/rutas';
    return false;
  }

  if (MENSAJE_CONFIRMACION_ESTADO[nuevoEstado]) {
    const numero = `#${id.slice(-6).toUpperCase()}`;
    let mensaje = MENSAJE_CONFIRMACION_ESTADO[nuevoEstado](numero);

    // FIX: si el pedido está asignado a una ruta y el chofer todavía no
    // marcó esto desde su app (entrega en 'pendiente'/'en_camino'), se lo
    // decimos al admin antes de que confirme a mano — evita que se marque
    // "Despachado"/"Entregado" sin que el chofer haya hecho nada todavía.
    if (nuevoEstado === 'despachado' || nuevoEstado === 'entregado') {
      const entrega = entregasPorPedido.get(id);
      if (entrega && !['entregado', 'no_entregado'].includes(entrega.estado)) {
        const quien = entrega.chofer_nombre ? `el chofer ${entrega.chofer_nombre}` : 'el chofer asignado';
        mensaje += ` ⚠️ Este pedido está asignado a un reparto y ${quien} todavía no lo confirmó desde su app.`;
      }
    }

    const ok = await window.confirmar(
      mensaje,
      { labelOk: etiquetaAccion(nuevoEstado), tipo: nuevoEstado === 'entregado' ? 'danger' : 'default' }
    );
    if (!ok) return false;
  }

  // REQ-06: Mostrar sugerencias FEFO antes de pasar a "preparando"
  if (nuevoEstado === 'preparando') {
    const continuar = await mostrarSugerenciasFEFO(id);
    if (!continuar) return false;
  }

  let result;

  try {
    // Etapa 4: firmas únicas post-migración 061 (auditoria v70).
    // confirmar_pedido valida crédito + reserva stock + registra movimientos_stock.
    // cancelar_pedido libera reservas y anula facturas pendientes.
    // marcar_preparado valida que el pedido esté confirmado (no descuenta stock real).
    if (nuevoEstado === 'confirmado') {
      const { data, error } = await window.conTimeoutRed(window.supabaseClient
        .rpc('confirmar_pedido', { p_pedido_id: id, p_forzar: false }), 10000);
      result = error
        ? { ok: false, error: error.message }
        : { ok: true, ...(data || {}) };

    } else if (nuevoEstado === 'cancelado') {
      const { data, error } = await window.conTimeoutRed(window.supabaseClient
        .rpc('cancelar_pedido', {
          p_pedido_id: id,
          p_motivo:    null
        }), 10000);
      result = error
        ? { ok: false, error: error.message }
        : { ok: true, ...(data || {}) };

    } else if (nuevoEstado === 'preparando') {
      const { data, error } = await window.conTimeoutRed(window.supabaseClient
        .rpc('marcar_preparado', { p_pedido_id: id }), 10000);
      result = error
        ? { ok: false, error: error.message }
        : { ok: true, ...(data || {}) };

    } else {
      // despachado, entregado — transición simple sin lógica de stock
      const updateData = { estado: nuevoEstado };
      if (nuevoEstado === 'despachado') { try { updateData.fecha_despacho = new Date().toISOString(); } catch(e) {} }
      const { error } = await window.conTimeoutRed(window.supabaseClient.from('pedidos').update(updateData).eq('id', id), 10000);
      result = error ? { ok: false, error: error.message } : { ok: true };
    }
  } catch (err) {
    // Antes esta llamada no tenía try/catch: si supabase-js tiraba una
    // excepción real (típico en una carrera de refresh de token cuando se
    // dispara más de una acción casi al mismo tiempo, ej: "Invalid Refresh
    // Token: Already Used"), la excepción quedaba sin capturar y el botón
    // se quedaba colgado sin reaccionar ni avisar nada al usuario.
    console.error('[pedidos] Error al cambiar estado:', err);
    window.toast(err?.message?.includes('Refresh Token')
      ? 'Tu sesión se refrescó en otra pestaña. Recargá la página e intentá de nuevo.'
      : 'Error de conexión. Revisá tu internet e intentá de nuevo.', 'error');
    return false;
  }

  if (!result?.ok) {
    window.toast('Error: ' + (result?.error || 'desconocido'), 'err');
    return false;
  }

  // El cambio de estado en la DB YA fue exitoso acá abajo (result.ok === true).
  // Todo lo que sigue es "efectos secundarios" en el cliente (refrescar la
  // tabla, avisar por WhatsApp, etc.). Antes este tramo no tenía try/catch
  // propio: cualquier excepción acá (ej. WA_TEMPLATE mal armado, un elemento
  // del DOM que no existe en esta vista) se escapaba de cambiarEstado() sin
  // capturar, subía hasta btnAsyncClick y mostraba el toast genérico
  // "Ocurrió un error. Intentá de nuevo." — dando a entender que el cambio
  // de estado había fallado, cuando en realidad YA se había guardado en la DB.
  // Lo separamos y logueamos con detalle para no repetir esa confusión.
  try {
    const idx = pedidos.findIndex(p => p.id === id);
    if (idx >= 0) pedidos[idx].estado = nuevoEstado;

    // Registrar en auditoría — registrar_auditoria() SÍ existe en la DB (backup.sql línea 3233)
    // FIX CRÍTICO: .rpc() de supabase-js devuelve un objeto "thenable" que solo
    // implementa .then() — NO tiene método .catch() propio. Encadenar .catch()
    // directo (como estaba antes) tira "TypeError: ... .catch is not a
    // function" DE FORMA SÍNCRONA apenas se ejecuta esta línea, en cada
    // cambio de estado sin excepción — esta era la causa real del toast
    // genérico "Ocurrió un error. Intentá de nuevo." en absolutamente todas
    // las transiciones. Se usa .then(onFulfilled, onRejected) en su lugar,
    // que sí es válido sobre un thenable.
    window.conTimeoutRed(window.supabaseClient.rpc('registrar_auditoria', {
      p_tabla:         'pedidos',
      p_accion:        'UPDATE',
      p_registro_id:   id,
      p_datos_despues: { estado: nuevoEstado },
    }).then(
      ({ error }) => { if (error) console.warn('[AUDIT] registrar_auditoria falló:', error.message); },
      (e) => console.warn('[AUDIT] registrar_auditoria falló silenciosamente:', e?.message)
    ), 10000);

    // No se espera (fire-and-forget) para no bloquear el toast de éxito, pero
    // se loguea cualquier falla interna para que no quede invisible en consola.
    aplicarFiltros().catch((e) => console.error('[pedidos] aplicarFiltros() falló tras cambiarEstado:', e));

    const msg = result.numero
      ? `Pedido ${result.numero} → ${capEstado(nuevoEstado)}`
      : `Pedido pasó a: ${capEstado(nuevoEstado)}`;
    window.toast(msg);

    const p = pedidos.find(x => x.id === id);
    if (p && WA_TEMPLATE[nuevoEstado] && p.clientes?.telefono) {
      const { template, params } = WA_TEMPLATE[nuevoEstado](p);
      enviarWhatsApp(template, p.clientes.telefono, params);
    }
  } catch (err) {
    // El estado YA cambió en la DB (result.ok === true) — este catch es solo
    // para que un error en los efectos secundarios (UI local, WhatsApp, etc.)
    // no se confunda con una falla del cambio de estado en sí.
    console.error('[pedidos] Error en post-proceso de cambiarEstado (el estado SÍ se guardó):', err);
    window.toast('El pedido se actualizó, pero hubo un problema al refrescar la pantalla. Recargá si no ves el cambio.', 'error');
  }
  return true;
}

// ── Cancelar pedido ────────────────────────────────────────────────────────
let idParaCancelar = null;

function confirmarCancelar(id) {
  idParaCancelar = id;
  document.getElementById('confirmar-overlay').style.display = 'flex';
  document.getElementById('btn-confirmar-cancelar').onclick = async () => {
    await cancelarPedido(idParaCancelar);
    cerrarConfirmar();
  };
}

function cerrarConfirmar() {
  document.getElementById('confirmar-overlay').style.display = 'none';
  idParaCancelar = null;
}

async function cancelarPedido(id) {
  await cambiarEstado(id, 'cancelado');
}

// ── Eliminar pedido (borrado físico, distinto de cancelar) ─────────────────
// Solo el backend valida si el estado lo permite (borrador/pendiente/
// cancelado); acá solo pedimos confirmación explícita antes de disparar
// el DELETE, porque no se puede deshacer.
async function confirmarEliminarPedido(id) {
  const p = pedidos.find(x => x.id === id) || pedidoActivo;
  const numero = p ? `#${p.id.slice(-6).toUpperCase()}` : 'este pedido';
  const ok = await window.confirmar(
    `¿Eliminar el pedido ${numero}? Esta acción no se puede deshacer.`,
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;
  await eliminarPedido(id);
}

async function eliminarPedido(id) {
  try {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) { window.location.href = '/admin/login'; return; }

    const r = await fetch(`/api/pedidos?id=${id}&accion=eliminar`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const json = await r.json();
    if (!r.ok) { window.toast(json.error || 'No se pudo eliminar el pedido.', 'error'); return; }

    window.toast('Pedido eliminado.', 'exito');
    if (document.getElementById('modal-pedido')?.classList.contains('open')) cerrarModal();
    await cargarPedidos();
  } catch (err) {
    console.error('[pedidos] Error al eliminar pedido:', err);
    window.toast('Error de conexión al eliminar el pedido.', 'error');
  }
}

// ── Realtime ───────────────────────────────────────────────────────────────
function suscribirRealtime() {
  if (!empresaData) return;
  window.supabaseClient.channel('pedidos-cambios')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'pedidos',
      filter: `empresa_id=eq.${empresaData.id}`
    }, async (payload) => {
      if (payload.eventType === 'INSERT') {
        await cargarPedidos();
        window.toast('Nuevo pedido recibido');
      } else if (payload.eventType === 'UPDATE') {
        // Se refresca la página actual desde el servidor en vez de parchear
        // el objeto local: con filtros server-side, un cambio de estado
        // puede sacar o meter la fila en la vista actual (ej. deja de
        // matchear "sin despachar"), y el total_count también cambia.
        await cargarPedidos();
      }
    })
    .subscribe();
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Avatar circular con iniciales del cliente (reemplaza el texto plano de la
// celda "Cliente" para que la tabla se sienta más a un producto que a una
// grilla admin genérica).
const _PALETA_AVATAR = ['#00AE70', '#6f42c1', '#17a2b8', '#fd7e14', '#e83e8c', '#0d6efd', '#20a39e'];
function iniciales(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  return (partes[0][0] + (partes[1]?.[0] || '')).toUpperCase();
}
function colorAvatar(nombre) {
  let hash = 0;
  const s = String(nombre || '');
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  return _PALETA_AVATAR[Math.abs(hash) % _PALETA_AVATAR.length];
}

function capEstado(e) {
  const m = { borrador:'Borrador', pendiente:'Pendiente', confirmado:'Confirmado', preparando:'Preparando',
    despachado:'Despachado', entregado:'Entregado', cancelado:'Cancelado' };
  return m[e] || e;
}

// v808: chip "Con devolución" junto al estado del pedido, cuando tiene al
// menos una devolución vinculada (`devolucion_estado` viene resuelto desde
// el backend — la más reciente si hay varias). Antes un pedido con
// devolución se veía igual que cualquier otro acá; había que ir a
// /admin/devoluciones y cruzar el pedido_id a mano para enterarse.
// Clickeable: lleva directo al módulo de devoluciones filtrado por este pedido.
function chipDevolucion(estado, pedidoId) {
  if (!estado) return '';
  const cfg = {
    pendiente: { texto: 'Devolución pendiente', bg: 'var(--color-warning-bg)', fg: 'var(--color-warning)', bd: 'var(--color-warning-mid)' },
    aprobada:  { texto: 'Con devolución',        bg: 'var(--color-info-bg)',    fg: 'var(--color-info)',    bd: 'var(--color-info-mid)' },
    rechazada: { texto: 'Devolución rechazada',  bg: 'transparent',             fg: 'var(--color-text-muted, #5B6660)', bd: 'var(--color-border, #DDE1DC)' },
  };
  const c = cfg[estado] || cfg.aprobada;
  return `<span class="chip" title="Ver en Devoluciones" style="background:${c.bg};color:${c.fg};border:1px solid ${c.bd};margin-left:4px;cursor:pointer;" onclick="event.stopPropagation(); window.location.href='/admin/devoluciones?pedido_id=' + encodeURIComponent('${pedidoId}')">${c.texto}</span>`;
}

// Verbos de negocio explícitos para los botones de acción (qué va a pasar al hacer clic),
// en vez de mostrar solo el nombre del estado. Solo cambia el texto del botón:
// la transición de estado la sigue resolviendo cambiarEstado() sin modificaciones.
const ETIQUETA_ACCION_CORTA = {
  confirmado: 'Confirmar pedido',
  preparando: 'Iniciar preparación',
  despachado: 'Despachar',
  entregado:  'Marcar entregado',
};
const ETIQUETA_ACCION_LARGA = {
  confirmado: 'Confirmar Pedido y Enviar a Logística',
  preparando: 'Marcar como En Preparación',
  despachado: 'Despachar Pedido al Cliente',
  entregado:  'Confirmar Entrega al Cliente',
};
function etiquetaAccion(e, larga) {
  return (larga ? ETIQUETA_ACCION_LARGA[e] : ETIQUETA_ACCION_CORTA[e]) || capEstado(e);
}

function fmtFecha(str) {
  if (!str) return '—';
  const [y,m,d] = str.split('T')[0].split('-');
  return `${d}/${m}/${y}`;
}

function limpiarTel(t) { return t.replace(/\D/g,''); }

function escHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js). Este
  // helper se interpola dentro de atributos HTML entre comillas dobles
  // (title="${escHtml(cliente)}", data-zona="${escHtml(...)}"), y
  // `cliente`/`zona` vienen de texto libre sin restricción de caracteres
  // (nombre_fantasia/razon_social, nombre de zona) — sanitize() ya
  // escapa todo correctamente vía DOM (textContent → innerHTML).
  return window.sanitize(s);
}

// mostrarToast → delegado a admin-utils.toast() vía alias al inicio

async function cerrarSesion() {
  await window.supabaseClient.auth.signOut();
  window.location.href = '/admin/login';
}

// ── REQ-08: Exportar pedidos a Excel ─────────────────────────────────────
async function exportarPedidosExcel() {
  try {
    // `filtrados` en memoria es solo la página actual (≤20 filas) desde la
    // migración a paginación server-side. Para exportar TODO lo que matchea
    // los filtros activos (no solo lo visible), se vuelve a pedir a
    // fn_pedidos_lista con un límite alto y offset 0, mismo criterio que la
    // nota dejada en productos.js para su exportarProductos().
    window.toast('Preparando exportación...');
    const f = leerFiltros();
    const { data, error } = await window.conTimeoutRed(window.supabaseClient.rpc('fn_pedidos_lista', {
      p_busqueda:      f.busq || null,
      p_estado:        estadoActivo || null,
      p_vendedor_id:   f.vendedor || null,
      p_zona_id:       f.zona || null,
      p_canal:         f.canal || null,
      p_cliente_id:    f.cliente || null,
      p_fecha_desde:   f.fechaDesde || null,
      p_fecha_hasta:   f.fechaHasta || null,
      p_monto_min:     f.montoMin || null,
      p_sin_facturar:  f.sinFacturar,
      p_sin_despachar: f.sinDespachar,
      p_limit:         10000,
      p_offset:        0,
    }), 10000);

    if (error) {
      console.error('Error exportando pedidos:', error);
      window.toast('Error al exportar');
      return;
    }

    const datos = (data || []).map(normalizarPedidoRpc);
    if (!datos.length) { window.toast('Sin pedidos para exportar'); return; }

    const fecha = new Date().toISOString().slice(0, 10);
    const estadoLabel = { borrador:'Borrador', pendiente:'Pendiente', confirmado:'Confirmado', preparando:'Preparando',
      despachado:'Despachado', entregado:'Entregado', cancelado:'Cancelado' };

    if (typeof XLSX !== 'undefined') {
      const rows = [['N° Remito','Fecha Pedido','Fecha Entrega','Estado','Cliente','CUIT','Zona','Vendedor','Subtotal','Descuento','IVA','Total','Notas']];
      datos.forEach(p => {
        rows.push([
          p.remito_nro || '',
          p.fecha_pedido ? new Date(p.fecha_pedido).toLocaleDateString('es-AR') : '',
          p.fecha_entrega || '',
          estadoLabel[p.estado] || p.estado,
          p.clientes?.razon_social || '',
          p.clientes?.cuit || '',
          p.clientes?.zonas?.nombre || '',
          vendedoresMap[p.vendedor_id] || '',
          Number(p.subtotal || 0),
          Number(p.descuento || 0),
          Number(p.iva_total || 0),
          Number(p.total || 0),
          p.notas_cliente || '',
        ]);
      });
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [10,14,14,14,30,16,16,18,12,12,12,12,25].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, 'Pedidos');
      XLSX.writeFile(wb, `pedidos-${fecha}.xlsx`);
      window.toast(`${datos.length} pedidos exportados`);
    } else {
      // Fallback CSV
      let csv = 'N° Remito,Fecha Pedido,Fecha Entrega,Estado,Cliente,CUIT,Zona,Vendedor,Subtotal,Descuento,IVA,Total,Notas\n';
      datos.forEach(p => {
        csv += [p.remito_nro||'', p.fecha_pedido ? new Date(p.fecha_pedido).toLocaleDateString('es-AR') : '', p.fecha_entrega||'',
          estadoLabel[p.estado]||p.estado, p.clientes?.razon_social||'', p.clientes?.cuit||'',
          p.clientes?.zonas?.nombre||'', vendedoresMap[p.vendedor_id] || '',
          p.subtotal||0, p.descuento||0, p.iva_total||0, p.total||0, p.notas_cliente||'']
          .map(v => `"${String(v).replace(/"/g,'""')}"`).join(',') + '\n';
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `pedidos-${fecha}.csv`; a.click();
      window.toast(`${datos.length} pedidos exportados (CSV)`);
    }
  } catch (err) {
    console.error('Error exportando pedidos:', err);
    window.toast('Error al exportar');
  }
}
window.exportarPedidosExcel = exportarPedidosExcel;

// ── Arranque ───────────────────────────────────────────────────────────────
window.authReady.then(() => init()).catch((err) => {
  console.error('[auth] authReady falló:', err?.message);
  if (!window.authCtx || !window.authCtx.perfil) {
    window.location.href = '/admin/login';
  }
});

// ── Exposición global requerida por type="module" ──────────────────────────
window.cerrarConfirmar  = cerrarConfirmar;
window.cerrarModal      = cerrarModal;
window.limpiarFiltros   = limpiarFiltros;
window.selEstado        = selEstado;
window.toggleFiltroRapido = toggleFiltroRapido;
window.toggleFiltrosAvanzados = toggleFiltrosAvanzados;
window.imprimirRemito   = (typeof imprimirRemito !== 'undefined') ? imprimirRemito : function(){};
window.generarFactura   = generarFactura;
// FIX bug botones de acción de estado sin evento (cambiarEstado, abrirModalPorId,
// confirmarCancelar quedaron fuera de esta lista — al ser pedidos.js un módulo ES6,
// sus funciones top-level no llegan a window y los onclick inline fallan en silencio).
window.cambiarEstado    = cambiarEstado;
window.abrirModalPorId  = abrirModalPorId;
window.confirmarCancelar = confirmarCancelar;
window.confirmarEliminarPedido = confirmarEliminarPedido;
window.eliminarPedido = eliminarPedido;
// FIX v797: aplicarFiltros quedó afuera de esta lista — es la función
// detrás del buscador (oninput) y de TODOS los selects de filtro
// (onchange), así que el buscador de "Cliente, N° pedido..." y los
// filtros de vendedor/zona/canal/cliente/fecha/importe no hacían nada.
window.aplicarFiltros = aplicarFiltros;

// ── REQ-07: Rellenado predictivo — banner informativo azul ─────────────────
// Muestra qué completó el sistema automáticamente al abrir el detalle del pedido.
// Solo visual: no toca ningún dato ni lógica de negocio.
function _mostrarBannerPredictivo(p) {
  const previo = document.getElementById('banner-predictivo');
  if (previo) previo.remove();

  const c = p.clientes;
  if (!c) return;

  const items = [];
  const domicilio = [c.domicilio, c.localidad].filter(Boolean).join(', ');
  if (domicilio) items.push(`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>Dirección de entrega: <strong>${escHtml(domicilio)}</strong>`);
  if (c.zonas?.nombre) items.push(`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21"/><line x1="8" y1="3" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="21"/></svg>Zona asignada: <strong>${escHtml(c.zonas.nombre)}</strong>`);
  if (c.condicion_iva) items.push(`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>Condición IVA: <strong>${escHtml(c.condicion_iva)}</strong>`);
  if (p.fecha_entrega) items.push(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Entrega pactada: <strong>${fmtFecha(p.fecha_entrega)}</strong>`);

  if (items.length === 0) return;

  const banner = document.createElement('div');
  banner.id = 'banner-predictivo';
  banner.style.cssText = `
    margin: 0 0 14px 0;
    padding: 12px 16px;
    background: var(--color-info-bg,#DDE6EE);
    border: 1px solid var(--color-info-mid,#33507A);
    border-radius: 10px;
    font-size: 13px;
    color: var(--color-info,#1F3555);
    animation: fadeInDown .3s ease;
  `;
  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-info,#1F3555)" stroke-width="2" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <div>
        <p style="margin:0 0 6px;font-weight:700;color:var(--color-info,#1F3555);">¡Datos cargados automáticamente!</p>
        <p style="margin:0 0 8px;color:var(--color-info-mid,#33507A);font-size:12px;">El sistema ya configuró la siguiente información del cliente:</p>
        <ul style="margin:0;padding-left:4px;list-style:none;display:flex;flex-direction:column;gap:4px;">
          ${items.map(i => `<li style="color:var(--color-text,#111A17);">${i}</li>`).join('')}
        </ul>
      </div>
    </div>
  `;

  const refEl = document.getElementById('modal-items')?.closest('.modal-seccion');
  if (refEl) refEl.parentNode.insertBefore(banner, refEl);
}
