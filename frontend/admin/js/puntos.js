/* frontend/admin/js/puntos.js — DT-02: UI Canje de Puntos */

let _sb = null; // FIX v125: usa authCtx.sb (patrón unificado)


// ── Estado global ────────────────────────────────────────────────────────────
let clientesPagina = [];      // solo la página actual (ver paginación abajo)
let clienteActivo  = null;    // cliente seleccionado en el modal
let historialActivo = [];     // v_puntos_movimientos del cliente activo
let filtroBusqueda = '';

// Paginación real (antes: se traían TODOS los clientes con saldo —hasta
// 2.510, uno por cliente activo— y se filtraba/sumaban KPIs con
// Array.filter()/reduce() en el navegador, sin debounce en el buscador;
// confirmado en AUDITORIA_FILTROS_v280 §4 y §6.3).
let paginaActualPuntos = 1;
const ITEMS_POR_PAGINA_PUNTOS = 50;
let totalClientesFiltrados = 0;

// ── Init ─────────────────────────────────────────────────────────────────────
window.authReady.then(async () => {
  const user = window.authCtx?.perfil;
  if (!user) { window.location.href = '/admin/login'; return; }
  _sb = window.authCtx.sb;

  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent = hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  // Solo dueno/admin pueden acreditar/ajustar; vendedor puede canjear
  const puedeAcreditar = window.tieneRol?.('dueno', 'admin') ?? true;
  document.querySelectorAll('.solo-admin').forEach(el => {
    el.style.display = puedeAcreditar ? '' : 'none';
  });

  try { inyectarControlesPaginacionPuntos(); } catch (e) { console.warn('[puntos] paginacion init:', e.message); }

  await cargarClientes();
  await cargarKPIs();

  let debounceBusquedaPuntos = null;
  document.getElementById('buscar-input').addEventListener('input', e => {
    filtroBusqueda = e.target.value.trim();
    clearTimeout(debounceBusquedaPuntos);
    debounceBusquedaPuntos = setTimeout(() => {
      paginaActualPuntos = 1;
      cargarClientes();
    }, 250);
  });
}).catch(err => {
  console.error('[puntos] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});

// verificarSesion() eliminada en v125 — se usa window.authReady directamente


// ── Cargar clientes con saldo ────────────────────────────────────────────────
// FIX (continuación AUDITORIA_FILTROS_v280, §2/§4/§6.3): antes traía
// TODOS los clientes con saldo (hasta 2.510 filas) sin .limit/.range y
// filtraba con Array.filter() en cada tecla, sin debounce. Ahora
// fn_puntos_lista() (migración 270) resuelve búsqueda + paginación en
// SQL — search y page viajan como parámetros de la RPC.
async function cargarClientes() {
  document.getElementById('tabla-body').innerHTML =
    '<tr><td colspan="5" class="tabla-loading">Cargando...</td></tr>';

  try {
    const offset = (paginaActualPuntos - 1) * ITEMS_POR_PAGINA_PUNTOS;
    const { data, error } = await _sb.rpc('fn_puntos_lista', {
      p_busqueda: filtroBusqueda || null,
      p_limit:    ITEMS_POR_PAGINA_PUNTOS,
      p_offset:   offset,
    });

    if (error) throw error;

    clientesPagina = data || [];
    totalClientesFiltrados = clientesPagina[0]?.total_count ?? 0;
    renderTabla();
    actualizarControlesPaginacionPuntos();

  } catch (e) {
    console.warn('[Puntos] fn_puntos_lista no disponible, uso fallback sin paginar:', e.message);
    await cargarClientesFallback();
  }
}

// Fallback defensivo por si la RPC fn_puntos_lista no estuviera disponible
// en algún tenant viejo (migración 270 no corrida todavía): vuelve al
// comportamiento anterior — trae todo y filtra/pagina en el navegador —
// pero al menos no rompe la pantalla. De paso corrige un bug latente: el
// código viejo llamaba `.ok`/`.json()` sobre el resultado de supabase-js
// (que devuelve `{data, error}`, no un `Response` de fetch), así que este
// fallback nunca había funcionado realmente.
async function cargarClientesFallback() {
  try {
    const empresaId = window.authCtx?.perfil?.empresa_id;
    const { data: vData, error: vErr } = await _sb
      .from('v_puntos_clientes')
      .select('*')
      .eq('empresa_id', empresaId)
      .order('saldo', { ascending: false });

    let datos = vErr || !vData ? [] : vData;

    if (filtroBusqueda) {
      const f = filtroBusqueda.toLowerCase();
      datos = datos.filter(d =>
        (d.cliente_nombre || '').toLowerCase().includes(f) ||
        (d.cliente_email  || '').toLowerCase().includes(f)
      );
    }

    totalClientesFiltrados = datos.length;
    const offset = (paginaActualPuntos - 1) * ITEMS_POR_PAGINA_PUNTOS;
    clientesPagina = datos.slice(offset, offset + ITEMS_POR_PAGINA_PUNTOS);

    renderTabla();
    actualizarControlesPaginacionPuntos();
  } catch (e) {
    console.error('[Puntos]', e);
    window.toast('Error al cargar los puntos', 'err');
    document.getElementById('tabla-body').innerHTML =
      '<tr><td colspan="5" class="tabla-loading" style="color:var(--color-danger)">Error al cargar</td></tr>';
  }
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
// Antes se sumaban en JS sobre el array completo de clientes (hasta 2.510
// filas). Ahora vienen agregados en una sola fila desde fn_puntos_kpis()
// (migración 270) — independiente de la página/búsqueda actual de la tabla.
async function cargarKPIs() {
  try {
    const { data, error } = await _sb.rpc('fn_puntos_kpis');
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;

    document.getElementById('kpi-total-puntos').textContent  = Number(row?.total_puntos || 0).toLocaleString('es-AR');
    document.getElementById('kpi-clientes-con').textContent  = Number(row?.clientes_con_puntos || 0).toLocaleString('es-AR');
    document.getElementById('kpi-canjeados-mes').textContent = Number(row?.total_canjeado || 0).toLocaleString('es-AR');
  } catch (e) {
    console.warn('[Puntos] fn_puntos_kpis no disponible, KPIs no se pudieron actualizar:', e.message);
  }
}

// ── Render tabla principal ───────────────────────────────────────────────────
function renderTabla() {
  const tbody  = document.getElementById('tabla-body');
  const datos  = clientesPagina;

  if (!datos.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="tabla-loading">
      ${filtroBusqueda ? 'Sin resultados para "' + escHtml(filtroBusqueda) + '"' : 'No hay clientes con puntos todavía'}
    </td></tr>`;
    return;
  }

  tbody.innerHTML = datos.map(d => {
    const saldo  = d.saldo || 0;
    const badge  = saldo === 0 ? '' :
      saldo < 100  ? `<span class="badge badge-low">${saldo} pts</span>` :
      saldo < 500  ? `<span class="badge badge-mid">${saldo} pts</span>` :
                     `<span class="badge badge-high">${saldo} pts</span>`;

    return `<tr onclick="abrirModal('${d.cliente_id}')" style="cursor:pointer">
      <td class="td-nombre" data-label="Cliente">
        <span class="cliente-nombre">${escHtml(d.cliente_nombre)}</span>
        ${d.cliente_email ? `<span class="cliente-email">${escHtml(d.cliente_email)}</span>` : ''}
      </td>
      <td class="td-center" data-label="Saldo">${badge || '—'}</td>
      <td class="td-right td-muted" data-label="Total ganado">${(d.total_ganado || 0).toLocaleString('es-AR')}</td>
      <td class="td-right td-muted" data-label="Total canjeado">${(d.total_canjeado || 0).toLocaleString('es-AR')}</td>
      <td class="td-right td-muted" data-label="Última actividad">${window.formatFecha(d.updated_at)}</td>
    </tr>`;
  }).join('');
}

// ── Paginación ────────────────────────────────────────────────────────────────
function inyectarControlesPaginacionPuntos() {
  if (document.getElementById('paginacion-puntos')) return; // ya existe
  const contenedor = document.querySelector('.tabla-wrap') || document.body;
  const div = document.createElement('div');
  div.id = 'paginacion-puntos';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-puntos" class="btn-pag" onclick="cambiarPaginaPuntos(-1)">Anterior</button>
      <span id="info-pag-puntos">Página 1</span>
      <button id="btn-next-puntos" class="btn-pag" onclick="cambiarPaginaPuntos(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionPuntos() {
  const totalPaginas = Math.max(1, Math.ceil(totalClientesFiltrados / ITEMS_POR_PAGINA_PUNTOS));
  const info = document.getElementById('info-pag-puntos');
  if (info) info.textContent = `Página ${paginaActualPuntos} de ${totalPaginas} (${totalClientesFiltrados} clientes)`;
  const btnPrev = document.getElementById('btn-prev-puntos');
  const btnNext = document.getElementById('btn-next-puntos');
  if (btnPrev) btnPrev.disabled = paginaActualPuntos <= 1;
  if (btnNext) btnNext.disabled = paginaActualPuntos >= totalPaginas;
}

window.cambiarPaginaPuntos = function (delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalClientesFiltrados / ITEMS_POR_PAGINA_PUNTOS));
  const nueva = paginaActualPuntos + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualPuntos = nueva;
  cargarClientes();
};

// ── Modal cliente ─────────────────────────────────────────────────────────────
async function abrirModal(clienteId) {
  clienteActivo = clientesPagina.find(c => c.cliente_id === clienteId);
  if (!clienteActivo) return;

  // Header modal
  document.getElementById('modal-cliente-nombre').textContent = clienteActivo.cliente_nombre;
  document.getElementById('modal-cliente-email').textContent  = clienteActivo.cliente_email || 'Sin email';

  // Saldo
  renderSaldo(clienteActivo.saldo || 0);

  // Limpiar tabs
  selModalTab('historial');

  // Cargar historial
  await cargarHistorialCliente(clienteId);

  // Resetear forms
  resetFormCanje();
  resetFormAcreditar();

  // Mostrar modal
  document.getElementById('modal-backdrop').style.display = '';
  document.getElementById('modal-puntos').style.display = '';
  document.body.style.overflow = 'hidden';
}

function cerrarModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-puntos').style.display  = 'none';
  document.body.style.overflow = '';
  clienteActivo  = null;
  historialActivo = [];
}

function renderSaldo(saldo) {
  const el = document.getElementById('modal-saldo');
  el.textContent = `${saldo.toLocaleString('es-AR')} pts`;
  el.className   = 'modal-saldo-valor ' +
    (saldo === 0 ? 'saldo-cero' : saldo < 100 ? 'saldo-bajo' : saldo >= 500 ? 'saldo-alto' : 'saldo-medio');
}

// ── Tabs del modal ────────────────────────────────────────────────────────────
function selModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('activo'));
  document.querySelectorAll('.modal-tab-panel').forEach(p => p.style.display = 'none');

  document.querySelector(`[data-modal-tab="${tab}"]`)?.classList.add('activo');
  document.getElementById(`modal-panel-${tab}`)?.style.setProperty('display', '');

  if (tab === 'canje') setTimeout(() => document.getElementById('canje-puntos')?.focus(), 50);
  if (tab === 'acreditar') setTimeout(() => document.getElementById('acred-puntos')?.focus(), 50);
}

// ── Historial ─────────────────────────────────────────────────────────────────
async function cargarHistorialCliente(clienteId) {
  const lista = document.getElementById('historial-body');
  lista.innerHTML = '<tr><td colspan="4" class="tabla-loading">Cargando historial...</td></tr>';

  try {
    const { data: movData } = await _sb
      .from('v_puntos_movimientos')
      .select('*')
      .eq('empresa_id', window.authCtx.perfil.empresa_id)
      .eq('cliente_id', clienteId)
      .order('created_at', { ascending: false })
      .limit(50);

    historialActivo = movData || [];
    renderHistorial(historialActivo);

  } catch (e) {
    lista.innerHTML = '<tr><td colspan="4" class="tabla-loading" style="color:var(--color-danger)">Error</td></tr>';
  }
}

function renderHistorial(movs) {
  const tbody = document.getElementById('historial-body');

  if (!movs.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="tabla-loading">Sin movimientos todavía</td></tr>';
    return;
  }

  tbody.innerHTML = movs.map(m => {
    const esPositivo = m.puntos > 0;
    const iconoTipo  = {
      acreditacion: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
      canje:        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
      ajuste:       '◈',
      vencimiento:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    }[m.tipo] || '•';

    return `<tr>
      <td class="td-fecha">${window.formatFecha(m.created_at)}</td>
      <td>
        <span class="tipo-badge tipo-${m.tipo}">${iconoTipo} ${capitalize(m.tipo)}</span>
        ${m.concepto ? `<span class="mov-concepto">${escHtml(m.concepto)}</span>` : ''}
      </td>
      <td class="td-right ${esPositivo ? 'pts-positivo' : 'pts-negativo'}">
        ${esPositivo ? '+' : ''}${m.puntos.toLocaleString('es-AR')} pts
      </td>
      <td class="td-right td-muted">${(m.saldo_post ?? 0).toLocaleString('es-AR')} pts</td>
    </tr>`;
  }).join('');
}

// ── Canje ─────────────────────────────────────────────────────────────────────
function resetFormCanje() {
  const inp = document.getElementById('canje-puntos');
  if (inp) inp.value = '';
  const inp2 = document.getElementById('canje-concepto');
  if (inp2) inp2.value = '';
  actualizarPreviewCanje();
}

function actualizarPreviewCanje() {
  const puntos  = parseInt(document.getElementById('canje-puntos')?.value || '0') || 0;
  const saldo   = clienteActivo?.saldo || 0;
  const preview = document.getElementById('canje-preview');
  const btnCanjear = document.getElementById('btn-confirmar-canje');

  if (!preview) return;

  if (puntos <= 0) {
    preview.innerHTML = '';
    if (btnCanjear) btnCanjear.disabled = true;
    return;
  }

  const excede = puntos > saldo;
  const saldoPost = Math.max(0, saldo - puntos);

  preview.innerHTML = `
    <div class="canje-preview-fila ${excede ? 'preview-error' : ''}">
      <span>Saldo actual</span>
      <strong>${saldo.toLocaleString('es-AR')} pts</strong>
    </div>
    <div class="canje-preview-fila ${excede ? 'preview-error' : ''}">
      <span>A canjear</span>
      <strong style="color:var(--color-danger)">− ${puntos.toLocaleString('es-AR')} pts</strong>
    </div>
    <div class="canje-preview-fila canje-preview-total">
      <span>Saldo restante</span>
      <strong class="${excede ? 'pts-negativo' : 'pts-positivo'}">${saldoPost.toLocaleString('es-AR')} pts</strong>
    </div>
    ${excede ? '<div class="canje-error-msg">⚠ Puntos insuficientes</div>' : ''}
  `;

  if (btnCanjear) btnCanjear.disabled = excede;
}

async function confirmarCanje() {
  const puntos   = parseInt(document.getElementById('canje-puntos')?.value || '0');
  const concepto = document.getElementById('canje-concepto')?.value.trim() || 'Canje de puntos';
  const btn      = document.getElementById('btn-confirmar-canje');

  if (!puntos || puntos <= 0) { window.toast('Ingresá la cantidad de puntos a canjear', 'err'); return; }
  if (puntos > (clienteActivo?.saldo || 0)) { window.toast('Saldo insuficiente', 'err'); return; }

  btn.disabled    = true;
  btn.textContent = 'Canjeando…';

  try {
    const perfil = window.authCtx?.perfil;
    const sb     = window.authCtx?.sb;

    const { data, error } = await sb.rpc('canjear_puntos', {
      p_empresa_id:     perfil.empresa_id,
      p_cliente_id:     clienteActivo.cliente_id,
      p_puntos:         puntos,
      p_concepto:       concepto,
      p_ref_tipo:       'manual',
      p_usuario_id:     perfil.id,
      p_usuario_nombre: perfil.nombre || perfil.email,
    });

    if (error) throw new Error(error.message);

    // Actualizar estado local
    const saldoNuevo = data.saldo_nuevo;
    clienteActivo.saldo = saldoNuevo;
    const idx = clientesPagina.findIndex(c => c.cliente_id === clienteActivo.cliente_id);
    if (idx !== -1) clientesPagina[idx].saldo = saldoNuevo;

    renderSaldo(saldoNuevo);
    renderTabla();
    await cargarKPIs();
    resetFormCanje();
    await cargarHistorialCliente(clienteActivo.cliente_id);
    selModalTab('historial');

    window.toast(`Canje de ${puntos.toLocaleString('es-AR')} pts registrado`, 'ok');

  } catch (e) {
    console.error('[Canje]', e);
    window.toast('No se pudo registrar el canje', 'err');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Confirmar canje';
  }
}

// ── Acreditación manual ───────────────────────────────────────────────────────
function resetFormAcreditar() {
  const inp = document.getElementById('acred-puntos');
  if (inp) inp.value = '';
  const inp2 = document.getElementById('acred-concepto');
  if (inp2) inp2.value = '';
}

async function confirmarAcreditacion() {
  const puntos   = parseInt(document.getElementById('acred-puntos')?.value || '0');
  const concepto = document.getElementById('acred-concepto')?.value.trim() || 'Acreditación manual';
  const btn      = document.getElementById('btn-confirmar-acred');

  if (!puntos || puntos <= 0) { window.toast('Ingresá la cantidad de puntos', 'err'); return; }
  if (puntos > 99999)         { window.toast('Máximo 99.999 puntos por acreditación', 'err'); return; }

  btn.disabled    = true;
  btn.textContent = 'Acreditando…';

  try {
    const perfil = window.authCtx?.perfil;
    const sb     = window.authCtx?.sb;

    const { data, error } = await sb.rpc('acreditar_puntos', {
      p_empresa_id:     perfil.empresa_id,
      p_cliente_id:     clienteActivo.cliente_id,
      p_puntos:         puntos,
      p_concepto:       concepto,
      p_ref_tipo:       'manual',
      p_usuario_id:     perfil.id,
      p_usuario_nombre: perfil.nombre || perfil.email,
    });

    if (error) throw new Error(error.message);

    const saldoNuevo = data.saldo;
    clienteActivo.saldo = saldoNuevo;
    const idx = clientesPagina.findIndex(c => c.cliente_id === clienteActivo.cliente_id);
    if (idx !== -1) {
      clientesPagina[idx].saldo        = saldoNuevo;
      clientesPagina[idx].total_ganado = (clientesPagina[idx].total_ganado || 0) + puntos;
    }

    renderSaldo(saldoNuevo);
    renderTabla();
    await cargarKPIs();
    resetFormAcreditar();
    await cargarHistorialCliente(clienteActivo.cliente_id);
    selModalTab('historial');

    window.toast(`${puntos.toLocaleString('es-AR')} pts acreditados`, 'ok');

  } catch (e) {
    console.error('[Acreditación]', e);
    window.toast('No se pudo acreditar los puntos', 'err');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Acreditar puntos';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}


function capitalize(s) {
  return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
}



// Exponer funciones al scope global (requerido por los onclick del HTML)
window.cerrarModal = cerrarModal;
window.confirmarAcreditacion = confirmarAcreditacion;
window.confirmarCanje = confirmarCanje;
window.selModalTab = selModalTab;
