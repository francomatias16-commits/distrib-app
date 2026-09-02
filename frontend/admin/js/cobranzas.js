// FIX v125: cambiado .eq("fecha", hoyStr) → .eq("fecha_date", hoyStr)
//   fecha_date es columna generada en cta_cte (migración 105) que castea
//   el timestamp a date en timezone America/Argentina/Buenos_Aires
/* admin/js/cobranzas.js — Pantalla K: Cobranzas del día */
// FIX v124: eliminado SB_URL/SB_KEY/getHeaders local → usa authCtx.sb (patrón unificado Etapa 2)

let _sb = null; // asignado en init desde window.authCtx.sb

let facturasVencidas = []; // solo la página actual del tab "vencidas" (para el modal de cobro puntual)
let facturasListaActual = []; // última página renderizada en hoy/semana/vencidas (para el botón "Cobrar" por índice)
let cobrosHoy = [];
let cobranzaPriorizada = null; // null = aún no se pidió (carga perezosa)
let tabActiva = 'priorizada';
let ultimosKpisCob = {}; // última respuesta de fn_cobranzas_kpis(), para enviarRecordatorioMasivo

// migración 268: paginación server-side por balde (hoy/semana/vencidas).
// La pestaña "priorizada" no usa esto, sigue con /api/score aparte.
let paginaActualCob = 1;
const ITEMS_POR_PAGINA_COB = 50;
let totalCobFiltradas = 0;

window.authReady.then(async () => {
  const perfil = window.authCtx?.perfil;
  if (!perfil) { window.location.href = '/admin/login'; return; }
  _sb = window.authCtx.sb;

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent =
    hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  (document.getElementById('topbar-usuario') || {}).textContent = perfil.nombre || perfil.email;
  // v903: sidebar-empresa/sidebar-logo los pinta nav.js (pintarEmpresaSidebar,
  // corre en cada renderConRol) — no duplicar acá, pisaba el valor bueno.

  await cargarDatos();
}).catch(err => {
  console.error('[cobranzas] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});

async function cargarDatos() {
  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  const hoyStr  = hoy.toISOString().split('T')[0];

  try {
    // Cobros de hoy (ya acotado por fecha, no necesita cambios)
    const { data: cobrosData } = await window.conTimeoutRed(_sb
      .from('cta_cte')
      .select('*,clientes(razon_social,nombre_fantasia)')
      .eq('empresa_id', window.authCtx?.perfil?.empresa_id)
      .eq('tipo', 'cobro')
      .eq('fecha_date', hoyStr), 10000);
    cobrosHoy = cobrosData || [];

    // migración 268: antes traía TODAS las facturas emitida/parcial con
    // .limit(500) y las repartía en 3 baldes con Array.filter() — si un
    // tenant superaba las 500 facturas abiertas, "Vence hoy" y "Total
    // vencido" subcontaban. fn_cobranzas_kpis() agrega los 3 baldes en
    // SQL sin tope.
    const { data: kpisData, error: kpisErr } = await window.conTimeoutRed(_sb.rpc('fn_cobranzas_kpis'), 10000);
    if (kpisErr) throw kpisErr;
    const kpis = kpisData?.[0] || {};
    ultimosKpisCob = kpis;

    actualizarKPIs(kpis);
    await renderFacturas(tabActiva);
  } catch(e) {
    console.error(e);
    mostrarToast('No se pudieron cargar los cobros y saldos', 'err');
  }
}

function actualizarKPIs(kpis) {
  const totalCobrado = cobrosHoy.reduce((s,c) => s + (c.monto||0), 0);

  document.getElementById('kpi-cobrado-hoy').textContent = formatPeso(totalCobrado);
  document.getElementById('kpi-cobrado-sub').textContent = `${cobrosHoy.length} cobro${cobrosHoy.length!==1?'s':''}`;

  // "Vence hoy" / "Próximos 7 días" / "Total vencido" ya no son tarjetas
  // aparte — se fusionaron como monto dentro de los tabs de "Facturas
  // pendientes" que ya filtran exactamente esas mismas categorías.
  const setTabAmt = (id, monto) => { const el = document.getElementById(id); if (el) el.textContent = formatPeso(monto); };
  setTabAmt('tabamt-hoy',      kpis.pendiente_hoy || 0);
  setTabAmt('tabamt-semana',   kpis.pendiente_semana || 0);
  setTabAmt('tabamt-vencidas', kpis.total_vencido || 0);
}

async function cargarCobranzaPriorizada() {
  if (cobranzaPriorizada !== null) return; // ya cargada, no repetir el fetch
  try {
    const { data: { session } } = await window.authCtx.sb.auth.getSession();
    if (!session) { cobranzaPriorizada = []; return; }
    const r = await fetch('/api/score?accion=cobranza-priorizada', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await r.json();
    cobranzaPriorizada = r.ok ? (data.cobranza || []) : [];
  } catch (e) {
    console.error(e);
    cobranzaPriorizada = [];
  }
}

const PRIORIDAD_CHIP = {
  accion_urgente: { cls: 'chip-rojo',     label: 'Acción urgente' },
  seguimiento:    { cls: 'chip-amarillo', label: 'Seguimiento' },
  cobro_probable: { cls: 'chip-verde',    label: 'Cobro probable' },
};

const THEAD_FACTURAS   = `<th>N° Factura</th><th>Cliente</th><th>Total</th><th>Pendiente</th><th>Vencimiento</th><th class="col-sticky-end">Acciones</th>`;
const THEAD_PRIORIZADA = `<th>N° Factura</th><th>Cliente</th><th>Pendiente</th><th>Días vencida</th><th>Prioridad</th><th class="col-sticky-end">Acciones</th>`;

async function renderFacturas(tab) {
  tabActiva = tab;
  const thead = document.getElementById('thead-facturas');

  if (tab === 'priorizada') {
    thead.innerHTML = THEAD_PRIORIZADA;
    const tbody = document.getElementById('tbody-facturas');
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Calculando prioridad...</div></td></tr>`;
    ocultarPaginacionCob();
    await cargarCobranzaPriorizada();
    const hayRiesgoAlto = (cobranzaPriorizada || []).some(f => f.prioridad === 'accion_urgente');
    const tabCobranza = document.getElementById('vptab-cobranza');
    if (tabCobranza) tabCobranza.classList.toggle('urgente--pulso', hayRiesgoAlto);
    renderPriorizada();
    return;
  }

  // migración 268: hoy/semana/vencidas ya no vienen de un array completo
  // filtrado en JS — cada tab pide su propia página a fn_cobranzas_facturas().
  thead.innerHTML = THEAD_FACTURAS;
  const tbody = document.getElementById('tbody-facturas');
  tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Cargando...</div></td></tr>`;

  const desde = (paginaActualCob - 1) * ITEMS_POR_PAGINA_COB;
  const { data, error } = await window.conTimeoutRed(_sb.rpc('fn_cobranzas_facturas', {
    p_bucket: tab,
    p_limit:  ITEMS_POR_PAGINA_COB,
    p_offset: desde,
  }), 10000);

  if (error) {
    console.error('[cobranzas] Error cargando facturas:', error);
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Error al cargar</div></td></tr>`;
    ocultarPaginacionCob();
    return;
  }

  const lista = data || [];
  totalCobFiltradas = lista?.[0]?.total_count || 0;
  facturasListaActual = lista;
  if (tab === 'vencidas') facturasVencidas = lista; // usado por enviarRecordatorioMasivo

  if (!lista.length) {
    const MSJ_VACIO = {
      hoy:      'No hay cobros programados para hoy.',
      semana:   'No hay facturas por vencer esta semana.',
      vencidas: 'No hay facturas vencidas — todo al día.',
    };
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">${MSJ_VACIO[tab] || 'No hay facturas en esta sección'}</div></td></tr>`;
    ocultarPaginacionCob();
    return;
  }

  tbody.innerHTML = lista.map((f, idx) => {
    return `<tr data-testid="cobranza-fila" data-id="${f.id}">
      <td data-label="N° Factura" style="font-family:monospace">${f.numero || '—'}</td>
      <td data-label="Cliente">${window.sanitize(f.cliente_nombre || '—')}</td>
      <td class="monto" data-label="Total">${formatPeso(f.total)}</td>
      <td class="monto monto-rojo" data-label="Pendiente">${formatPeso(f.pendiente)}</td>
      <td data-label="Vencimiento">${formatFecha(f.vencimiento)}</td>
      <td class="col-sticky-end" data-label="Acciones">
        <button class="btn btn-sm btn-primary btn--primary" onclick="abrirCobroFacturaIdx(${idx})">Cobrar</button>
      </td>
    </tr>`;
  }).join('');

  actualizarControlesPaginacionCob();
}

// ── Paginación (tabs hoy/semana/vencidas — no aplica a priorizada) ────
function inyectarControlesPaginacionCob() {
  if (document.getElementById('paginacion-cob')) return;
  // FIX (e2e cobranzas.spec.js): con la fusión cobranzas.html + cta-cte.html,
  // "Saldos por cliente" pasó a ser un <main id="vista-saldos"> HERMANO de
  // #vista-cobranza, no un segundo bloque adentro. El selector de acá
  // asumía 2 `.tabla-wrap` dentro de #vista-cobranza (índice [1] = "Facturas
  // pendientes"), pero hoy hay uno solo — el índice [1] siempre daba
  // `undefined` y esta función cortaba en silencio, así que los controles
  // de paginación nunca llegaban a crearse (nadie lo notó porque solo un
  // test con más de 50 resultados ejercita este código).
  const contenedor = document.querySelector('#vista-cobranza .tabla-wrap'); // "Facturas pendientes"
  if (!contenedor) return;
  const div = document.createElement('div');
  div.id = 'paginacion-cob';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-cob" class="btn-pag" onclick="cambiarPaginaCob(-1)">Anterior</button>
      <span id="info-pag-cob">Página 1</span>
      <button id="btn-next-cob" class="btn-pag" onclick="cambiarPaginaCob(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionCob() {
  inyectarControlesPaginacionCob();
  const div = document.getElementById('paginacion-cob');
  if (div) div.style.display = '';
  const totalPaginas = Math.max(1, Math.ceil(totalCobFiltradas / ITEMS_POR_PAGINA_COB));
  const info = document.getElementById('info-pag-cob');
  if (info) info.textContent = `Página ${paginaActualCob} de ${totalPaginas} (${totalCobFiltradas} facturas)`;
  const btnPrev = document.getElementById('btn-prev-cob');
  const btnNext = document.getElementById('btn-next-cob');
  if (btnPrev) btnPrev.disabled = paginaActualCob <= 1;
  if (btnNext) btnNext.disabled = paginaActualCob >= totalPaginas;
}

function ocultarPaginacionCob() {
  const div = document.getElementById('paginacion-cob');
  if (div) div.style.display = 'none';
}

function cambiarPaginaCob(delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalCobFiltradas / ITEMS_POR_PAGINA_COB));
  const nueva = paginaActualCob + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualCob = nueva;
  renderFacturas(tabActiva);
}
window.cambiarPaginaCob = cambiarPaginaCob;

function renderPriorizada() {
  const tbody = document.getElementById('tbody-facturas');
  const lista = cobranzaPriorizada || [];
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No hay facturas pendientes de cobro. Cuando las haya, acá vas a ver primero las de los clientes con mayor riesgo según su score.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map((f, idx) => {
    const chip = PRIORIDAD_CHIP[f.prioridad] || { cls: 'chip-gris', label: f.prioridad || '—' };
    return `<tr data-testid="cobranza-priorizada-fila" data-cliente-id="${f.cliente_id}">
      <td data-label="N° Factura" style="font-family:monospace">${window.sanitize(f.numero_factura || '—')}</td>
      <td data-label="Cliente">${window.sanitize(f.cliente_nombre || '—')}</td>
      <td class="monto monto-rojo" data-label="Pendiente">${formatPeso(f.saldo_pendiente)}</td>
      <td data-label="Días vencida">${f.dias_vencida > 0 ? f.dias_vencida + ' días' : '—'}</td>
      <td data-label="Prioridad"><span class="chip ${chip.cls}" title="Nivel de cobrabilidad: ${f.score_cobrabilidad}/100">${window.sanitize(chip.label)}</span></td>
      <td class="col-sticky-end" data-label="Acciones">
        <button class="btn btn-sm btn-primary btn--primary" onclick="abrirCobroPriorizadaIdx(${idx})">Cobrar</button>
      </td>
    </tr>`;
  }).join('');
}

async function cambiarTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  paginaActualCob = 1; // reset al cambiar de tab
  await renderFacturas(tab);
}

function abrirCobroFacturaIdx(idx) {
  const f = facturasListaActual[idx];
  if (!f) return;
  abrirCobroFactura(f.id, f.cliente_id, f.cliente_nombre, f.pendiente);
}
window.abrirCobroFacturaIdx = abrirCobroFacturaIdx;

function abrirCobroPriorizadaIdx(idx) {
  const f = (cobranzaPriorizada || [])[idx];
  if (!f) return;
  // f.factura_id puede venir null en las filas sintéticas "Sin comprobante"
  // (deuda sin factura real, ver migración 412) — en ese caso el cobro
  // queda genérico a cuenta del cliente, como antes.
  abrirCobroFactura(f.factura_id || null, f.cliente_id, f.cliente_nombre, f.saldo_pendiente);
}
window.abrirCobroPriorizadaIdx = abrirCobroPriorizadaIdx;

async function abrirCobroFactura(facturaId, clienteId, clienteNombre, montoPendiente) {
  // Fase 0 (auditoría IA/UX): antes redirigía a /admin/cta-cte (página
  // separada); ahora cambia a la pestaña "Saldos por cliente" en esta misma
  // pantalla y abre directo la ficha del cliente, sin recargar.
  window.cambiarVistaPrincipal('saldos');
  if (typeof window.abrirCliente === 'function') {
    await window.abrirCliente(clienteId);
  }
  // FIX (bug "Cobrar quedaba habilitado para siempre"): antes esto solo
  // abría el panel del cliente — el cobro que se registrara después quedaba
  // como saldo genérico, nunca aplicado a ESTA factura, así que la factura
  // no salía nunca de "Facturas pendientes" aunque se cobrara. Ahora se abre
  // directo el modal de cobro con la factura vinculada.
  if (typeof window.abrirModalCobroParaFactura === 'function') {
    window.abrirModalCobroParaFactura(facturaId, clienteId, clienteNombre, montoPendiente);
  }
}

// FIX v269 (bug real, encontrado por cobranzas.spec.js): "Recordatorio masivo"
//   pedía confirmación DOS veces — el botón en cobranzas.html traía
//   btnAsyncClick(..., {confirm:true, confirmMsg:'...'}) Y esta función
//   volvía a llamar a confirmar() puertas adentro. Se sacó el
//   {confirm:true} del botón (ver cobranzas.html) y se dejó una sola
//   confirmación acá, que además es la más informativa de las dos (incluye
//   el total real de clientes, algo que el botón no puede saber antes de
//   tener los KPIs cargados).
async function enviarRecordatorioMasivo() {
  const total = (ultimosKpisCob.facturas_vencidas || 0) + (ultimosKpisCob.facturas_hoy || 0);
  if (total === 0) {
    mostrarToast('No hay facturas vencidas para reclamar', 'ok');
    return;
  }
  if (!(await confirmar(`¿Enviar recordatorio por WhatsApp a ${total} clientes con facturas vencidas?`, { labelOk: 'Enviar recordatorios', tipo: 'danger' }))) return;
  mostrarToast('Enviando recordatorios...', 'ok');
}

function formatPeso(n) {
  return '$' + (n||0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFecha(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('es-AR');
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// Invalida el caché de "priorizada" (se pide una sola vez por lazy-load).
// La llama cta-cte.js después de registrar un cobro vinculado a una
// factura puntual, para que al volver a esta pestaña no siga mostrando
// una factura que ya se saldó.
function invalidarCobranzaPriorizada() {
  cobranzaPriorizada = null;
}
window.invalidarCobranzaPriorizada = invalidarCobranzaPriorizada;

// FIX F3-04: Refresca solo los KPIs y el bloque de medios de pago del
// dashboard de cobranzas sin rerenderizar las tabs (que pueden estar en
// cualquier estado de carga). La llama cta-cte.js después de guardar un
// cobro, para que "Cobrado hoy", "Vence hoy", "Total vencido" y el
// desglose de medios de pago reflejen el cobro recién registrado.
async function refrescarKPIsCobranzas() {
  if (!_sb) return; // no inicializado todavía (tab no cargó)
  try {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const hoyStr = hoy.toISOString().split('T')[0];

    const [cobrosRes, kpisRes] = await Promise.all([
      window.conTimeoutRed(_sb
        .from('cta_cte')
        .select('*,clientes(razon_social,nombre_fantasia)')
        .eq('empresa_id', window.authCtx?.perfil?.empresa_id)
        .eq('tipo', 'cobro')
        .eq('fecha_date', hoyStr), 10000),
      window.conTimeoutRed(_sb.rpc('fn_cobranzas_kpis'), 10000),
    ]);

    if (cobrosRes.error || kpisRes.error) return; // silencioso — el toast ya lo mostró cta-cte.js

    cobrosHoy = cobrosRes.data || [];
    const kpis = kpisRes.data?.[0] || {};
    ultimosKpisCob = kpis;

    actualizarKPIs(kpis);
    // Si la pestaña activa es "priorizada", la forzamos a recargar en el próximo cambio
    // (cobranzaPriorizada ya fue invalidado por invalidarCobranzaPriorizada() llamado antes)
  } catch (e) {
    // Error silencioso — no interrumpir el flujo del cobro en cta-cte.js
    console.warn('[cobranzas] refrescarKPIsCobranzas falló silenciosamente:', e?.message);
  }
}
window.refrescarKPIsCobranzas = refrescarKPIsCobranzas;

// Exponer funciones al scope global (requerido por los onclick del HTML)
window.cambiarTab = cambiarTab;
window.enviarRecordatorioMasivo = enviarRecordatorioMasivo;
