/* frontend/admin/js/fidelizacion.js
   Panel de Fidelización — programa de puntos, catálogo recompensas,
   canjes_recompensas, reglas_score y bonus_pct_categoria.
   Tablas Supabase: programas_fidelizacion, recompensas, canjes_recompensas,
                    saldo_puntos, movimientos_puntos, reglas_score
*/
'use strict';

const ROLES_FIDELIZACION = ['dueno', 'admin'];

let sb              = null;
let empresaId       = null;
let tabActiva       = 'configuracion';
let recompensasData = [];
let clientesPuntosData = [];
let historialData   = [];
let canjesData      = [];
let editRecompensaId = null;

// ── Paginación cliente ("Cargar más") ───────────────────────────────────────
// Mismo patrón que stockauto en stock.js: se pide todo de una vez a Supabase
// (con .limit() de resguardo en los que corresponde) y se corta la lista en
// el cliente para no renderizar de entrada una lista interminable.
const RECOMP_MOSTRAR_INICIAL    = 9;
const RECOMP_PAGINA             = 12;
const CANJES_MOSTRAR_INICIAL    = 15;
const CANJES_PAGINA             = 30;
const CLIENTES_MOSTRAR_INICIAL  = 15;
const CLIENTES_PAGINA           = 30;
const HISTORIAL_MOSTRAR_INICIAL = 20;
const HISTORIAL_PAGINA          = 40;

let _recompVisibles    = RECOMP_MOSTRAR_INICIAL;
let _canjesVisibles    = CANJES_MOSTRAR_INICIAL;
let _clientesVisibles  = CLIENTES_MOSTRAR_INICIAL;
let _historialVisibles = HISTORIAL_MOSTRAR_INICIAL;

// Última lista renderizada de clientes/historial (post-filtro), para que
// "Cargar más"/"Ver menos" sepan sobre qué lista operar sin recalcular filtros.
let _clientesListaActual  = [];
let _historialListaActual = [];

// Genera los botones "Cargar N más (quedan N)" / "Ver menos". Devuelve ''
// si la lista completa ya entra en la vista actual (no hay nada que plegar
// ni expandir).
function piePaginacionHTML(total, visibles, mostrarInicial, pagina, cargarMasFn, colapsarFn) {
  const hayMas        = total > visibles;
  const puedeColapsar = visibles > mostrarInicial;
  if (!hayMas && !puedeColapsar) return '';
  const restantes = total - visibles;
  return `
    ${hayMas ? `<button type="button" class="fidel-paginar-btn" onclick="${cargarMasFn}()">Cargar ${Math.min(pagina, restantes)} más (quedan ${restantes})</button>` : ''}
    ${puedeColapsar ? `<button type="button" class="fidel-paginar-btn fidel-paginar-btn--ghost" onclick="${colapsarFn}()">Ver menos</button>` : ''}
  `;
}
// Envuelve el pie para usar dentro de un <tbody> (fila con colspan).
function piePaginacionFila(colspan, total, visibles, mostrarInicial, pagina, cargarMasFn, colapsarFn) {
  const pie = piePaginacionHTML(total, visibles, mostrarInicial, pagina, cargarMasFn, colapsarFn);
  return pie ? `<tr class="fidel-paginar-fila"><td colspan="${colspan}"><div class="fidel-paginar-foot">${pie}</div></td></tr>` : '';
}
// Envuelve el pie para usar dentro de un grid (ej. recompensas-grid).
function piePaginacionGrid(total, visibles, mostrarInicial, pagina, cargarMasFn, colapsarFn) {
  const pie = piePaginacionHTML(total, visibles, mostrarInicial, pagina, cargarMasFn, colapsarFn);
  return pie ? `<div class="fidel-paginar-foot" style="grid-column:1/-1">${pie}</div>` : '';
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.authReady.then(async () => {
  const perfil = window.authCtx?.perfil;
  if (!perfil) { window.location.href = '/admin/login'; return; }

  sb        = window.authCtx.sb;
  empresaId = perfil.empresa_id;

  (document.getElementById('topbar-usuario') || {}).textContent = perfil.nombre || perfil.email;

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent =
    hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  await Promise.all([cargarKPIs(), cargarConfig(), cargarReglaScore()]);

  document.getElementById('form-config')?.addEventListener('submit', guardarConfig);
  document.getElementById('form-bonus')?.addEventListener('submit', guardarBonus);
  document.getElementById('form-reglas-score')?.addEventListener('submit', guardarReglaScore);
  document.getElementById('form-recompensa')?.addEventListener('submit', guardarRecompensa);
}).catch(err => {
  console.error('[fidelizacion] authReady:', err?.message);
  window.location.href = '/admin/login';
});

// ── KPIs ──────────────────────────────────────────────────────────────────────
async function cargarKPIs() {
  try {
    const [
      { data: saldos },
      { data: canjesMes },
      { data: ganadosMes },
    ] = await Promise.all([
      window.conTimeoutRed(sb.from('saldo_puntos').select('puntos_disponibles, puntos_canjeados').eq('empresa_id', empresaId), 10000),
      (() => {
        const ini = new Date(); ini.setDate(1); ini.setHours(0,0,0,0);
        return window.conTimeoutRed(sb.from('movimientos_puntos').select('cantidad').eq('empresa_id', empresaId)
          .eq('tipo', 'canje').gte('created_at', ini.toISOString()), 10000);
      })(),
      // FIX (auditoría de módulos, etapa 10, Hallazgo 5): el KPI anterior
      // ("Puntos bonus este mes") filtraba tipo='bonus', un valor que
      // acreditarPuntos() (lib/handlers/pedidos.js) nunca inserta -- el
      // bonus por categoría de score va sumado dentro de la ganancia
      // total con tipo='ganancia'. El KPI mostraba siempre 0. Se
      // reemplaza por un dato real: total de puntos ganados en el mes.
      (() => {
        const ini = new Date(); ini.setDate(1); ini.setHours(0,0,0,0);
        return window.conTimeoutRed(sb.from('movimientos_puntos').select('cantidad').eq('empresa_id', empresaId)
          .eq('tipo', 'ganancia').gte('created_at', ini.toISOString()), 10000);
      })(),
    ]);

    const totalActivos    = saldos?.reduce((s,r)=>s+Number(r.puntos_disponibles||0),0)||0;
    const clientesActivos = saldos?.filter(r=>r.puntos_disponibles>0).length||0;
    const cantCanjes      = canjesMes?.length||0;
    const valorCanjeado   = canjesMes?.reduce((s,r)=>s+Math.abs(Number(r.cantidad||0)),0)||0;
    const totalGanados    = ganadosMes?.reduce((s,r)=>s+Number(r.cantidad||0),0)||0;

    // Canjes pendientes para el badge
    const { count: pendCnt } = await window.conTimeoutRed(sb.from('canjes_recompensas')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresaId).eq('estado', 'pendiente'), 10000);
    actualizarBadgeCanjes(pendCnt || 0);

    const cont = document.getElementById('kpis-fidel');
    if (!cont) return;
    cont.className = 'franja-resumen-sololectura';
    cont.innerHTML = `
      <div class="dato-sello"><div class="dato-sello-valor">${totalActivos.toLocaleString('es-AR')}</div><div class="dato-sello-etiqueta">Puntos en circulación</div></div>
      <div class="dato-sello"><div class="dato-sello-valor">${clientesActivos}</div><div class="dato-sello-etiqueta">Clientes en programa</div></div>
      <div class="dato-sello" data-tono="ambar"><div class="dato-sello-valor">${cantCanjes}</div><div class="dato-sello-etiqueta">Canjes este mes</div><div class="dato-sello-nota">$${valorCanjeado.toLocaleString('es-AR')}</div></div>
      <div class="dato-sello" data-tono="verde"><div class="dato-sello-valor">${totalGanados.toLocaleString('es-AR')}</div><div class="dato-sello-etiqueta">Puntos ganados este mes</div></div>
      ${pendCnt > 0 ? `<div class="dato-sello" data-tono="ambar"><div class="dato-sello-valor">${pendCnt}</div><div class="dato-sello-etiqueta">Canjes pendientes</div></div>` : ''}
    `;
  } catch (e) { console.error('[fidelizacion] KPIs:', e); }
}

function actualizarBadgeCanjes(n) {
  const badge = document.getElementById('badge-canjes-pend');
  if (!badge) return;
  if (n > 0) {
    badge.textContent = n;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ── Config del programa ───────────────────────────────────────────────────────
async function cargarConfig() {
  try {
    const { data } = await window.conTimeoutRed(sb.from('programas_fidelizacion')
      .select('*').eq('empresa_id', empresaId).maybeSingle(), 10000);
    if (!data) return;

    setVal('config-nombre',          data.nombre || 'Programa de Puntos');
    setVal('config-puntos-por-peso', data.puntos_por_peso ?? 1.0);
    setVal('config-puntos-minimos',  data.puntos_minimos_canje ?? 100);
    const chk = document.getElementById('config-activo');
    if (chk) chk.checked = data.activo !== false;

    const b = data.bonus_pct_categoria || {};
    setVal('bonus-premium',   b.premium   ?? 20);
    setVal('bonus-bueno',     b.bueno     ?? 10);
    setVal('bonus-normal',    b.normal    ?? 0);
    setVal('bonus-riesgo',    b.riesgo    ?? 0);
    setVal('bonus-bloqueado', b.bloqueado ?? 0);
  } catch (e) { console.error('[fidelizacion] cargarConfig:', e); }
}

async function guardarConfig(e) {
  e.preventDefault();
  const ok = await window.confirmar('¿Guardar la configuración del programa de fidelización?', { labelOk: 'Guardar', labelCancel: 'Revisar' });
  if (!ok) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const { error } = await window.conTimeoutRed(sb.from('programas_fidelizacion').upsert({
      empresa_id:           empresaId,
      nombre:               getVal('config-nombre'),
      puntos_por_peso:      parseFloat(getVal('config-puntos-por-peso')) || 1.0,
      puntos_minimos_canje: parseInt(getVal('config-puntos-minimos'))   || 100,
      activo:               document.getElementById('config-activo')?.checked ?? true,
      updated_at:           new Date().toISOString(),
    }, { onConflict: 'empresa_id' }), 10000);
    if (error) throw error;
    window.toast('Configuración guardada', 'ok');
  } catch (e) {
    console.error('[fidelizacion] guardarConfig:', e);
    window.toast('No se pudo guardar la configuración', 'err');
  } finally { btn.disabled = false; btn.textContent = 'Guardar configuración'; }
}

async function guardarBonus(e) {
  e.preventDefault();
  const ok = await window.confirmar('¿Guardar el bonus por nivel de confianza?', { labelOk: 'Guardar', labelCancel: 'Revisar' });
  if (!ok) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const { error } = await window.conTimeoutRed(sb.from('programas_fidelizacion').upsert({
      empresa_id: empresaId,
      bonus_pct_categoria: {
        premium:   parseInt(getVal('bonus-premium'))   || 0,
        bueno:     parseInt(getVal('bonus-bueno'))     || 0,
        normal:    parseInt(getVal('bonus-normal'))    || 0,
        riesgo:    parseInt(getVal('bonus-riesgo'))    || 0,
        bloqueado: parseInt(getVal('bonus-bloqueado')) || 0,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'empresa_id' }), 10000);
    if (error) throw error;
    window.toast('Bonus por nivel de confianza guardado', 'ok');
  } catch (e) {
    console.error('[fidelizacion] guardarBonus:', e);
    window.toast('No se pudo guardar el bonus por nivel de confianza', 'err');
  } finally { btn.disabled = false; btn.textContent = 'Guardar bonus'; }
}

// ── Reglas de Score ───────────────────────────────────────────────────────────
async function cargarReglaScore() {
  try {
    const { data } = await window.conTimeoutRed(sb.from('reglas_score')
      .select('*').eq('empresa_id', empresaId).maybeSingle(), 10000);
    if (!data) return;

    setVal('rs-umbral-premium', data.umbral_premium  ?? 80);
    setVal('rs-umbral-bueno',   data.umbral_bueno    ?? 65);
    setVal('rs-umbral-normal',  data.umbral_normal   ?? 45);
    setVal('rs-umbral-riesgo',  data.umbral_riesgo   ?? 30);

    setVal('rs-mult-premium', data.mult_credito_premium ?? 2.0);
    setVal('rs-mult-bueno',   data.mult_credito_bueno   ?? 1.5);
    setVal('rs-mult-normal',  data.mult_credito_normal  ?? 1.0);
    setVal('rs-mult-riesgo',  data.mult_credito_riesgo  ?? 0.5);

    setVal('rs-dias-premium', data.dias_cred_premium ?? 45);
    setVal('rs-dias-bueno',   data.dias_cred_bueno   ?? 30);
    setVal('rs-dias-normal',  data.dias_cred_normal  ?? 15);
    setVal('rs-dias-riesgo',  data.dias_cred_riesgo  ?? 0);
  } catch (e) { console.error('[fidelizacion] cargarReglaScore:', e); }
}

async function guardarReglaScore(e) {
  e.preventDefault();
  const ok = await window.confirmar('¿Guardar las reglas del nivel de confianza? Afecta el crédito y los días de pago de todos los clientes.', { labelOk: 'Guardar', labelCancel: 'Revisar' });
  if (!ok) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const payload = {
      empresa_id:           empresaId,
      umbral_premium:       parseInt(getVal('rs-umbral-premium')),
      umbral_bueno:         parseInt(getVal('rs-umbral-bueno')),
      umbral_normal:        parseInt(getVal('rs-umbral-normal')),
      umbral_riesgo:        parseInt(getVal('rs-umbral-riesgo')),
      mult_credito_premium: parseFloat(getVal('rs-mult-premium')),
      mult_credito_bueno:   parseFloat(getVal('rs-mult-bueno')),
      mult_credito_normal:  parseFloat(getVal('rs-mult-normal')),
      mult_credito_riesgo:  parseFloat(getVal('rs-mult-riesgo')),
      dias_cred_premium:    parseInt(getVal('rs-dias-premium')),
      dias_cred_bueno:      parseInt(getVal('rs-dias-bueno')),
      dias_cred_normal:     parseInt(getVal('rs-dias-normal')),
      dias_cred_riesgo:     parseInt(getVal('rs-dias-riesgo')),
    };
    const { error } = await window.conTimeoutRed(sb.from('reglas_score')
      .upsert(payload, { onConflict: 'empresa_id' }), 10000);
    if (error) throw error;
    window.toast('Reglas del nivel de confianza guardadas', 'ok');
  } catch (e) {
    console.error('[fidelizacion] guardarReglaScore:', e);
    window.toast('No se pudieron guardar las reglas del nivel de confianza', 'err');
  } finally { btn.disabled = false; btn.textContent = 'Guardar reglas del nivel de confianza'; }
}

// ── Recompensas ───────────────────────────────────────────────────────────────
async function cargarRecompensas() {
  const grid = document.getElementById('recompensas-grid');
  if (!grid) return;
  grid.innerHTML = '<p style="padding:16px;color:var(--color-text-muted)">Cargando recompensas…</p>';
  try {
    const { data, error } = await window.conTimeoutRed(sb.from('recompensas').select('*')
      .eq('empresa_id', empresaId).order('puntos_requeridos', { ascending: true }), 10000);
    if (error) throw error;
    recompensasData = data || [];
    _recompVisibles = RECOMP_MOSTRAR_INICIAL;
    renderRecompensas();
  } catch (e) {
    console.error('[fidelizacion] cargarRecompensas:', e);
    grid.innerHTML = '<p style="padding:16px;color:var(--color-danger)">Error al cargar recompensas</p>';
  }
}

function renderRecompensas() {
  const grid = document.getElementById('recompensas-grid');
  if (!grid) return;

  if (!recompensasData.length) {
    grid.innerHTML = '<p style="padding:20px;color:var(--color-text-muted);grid-column:1/-1">No hay recompensas aún. Creá la primera con el botón de arriba.</p>';
    return;
  }

  const TIPOS = { descuento_fijo:'Descuento fijo', descuento_porcentaje:'Descuento %', producto_gratis:'Producto gratis', envio_gratis:'Envío gratis' };

  const total    = recompensasData.length;
  const visibles = recompensasData.slice(0, _recompVisibles);

  const tarjetas = visibles.map(r => `
    <div class="recomp-card ${r.activa ? '' : 'inactiva'}" style="cursor:pointer" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) editarRecompensa('${r.id}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
        <strong style="font-size:14px;line-height:1.3">${esc(r.nombre)}</strong>
        <span style="font-size:11px;padding:2px 8px;border-radius:99px;white-space:nowrap;background:${r.activa?'var(--color-success-bg,#E2F0E5)':'var(--color-surface-2,#ECEEEA)'};color:${r.activa?'var(--color-success,#487050)':'var(--color-text-muted,#5B6660)'}">
          ${r.activa ? 'Activa' : 'Inactiva'}
        </span>
      </div>
      ${r.descripcion ? `<p style="font-size:12px;color:var(--color-text-muted);margin:0">${esc(r.descripcion)}</p>` : ''}
      <div style="font-size:12px;color:var(--color-text-muted)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:3px"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>${TIPOS[r.tipo] || r.tipo}${r.valor ? ` · $${Number(r.valor).toLocaleString('es-AR')}` : ''}
      </div>
      <div class="recomp-pts">${Number(r.puntos_requeridos).toLocaleString('es-AR')} pts</div>
      ${r.cantidad_disponible ? `<div style="font-size:12px;color:var(--color-text-muted)">Stock: ${r.cantidad_disponible - (r.cantidad_canjeada||0)} restantes</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:4px;">
        <button class="btn btn--ghost" style="font-size:12px;padding:4px 10px;" onclick="editarRecompensa('${r.id}')">Editar</button>
        <button class="btn btn--ghost" style="font-size:12px;padding:4px 10px;color:${r.activa?'var(--color-danger,#7A2820)':'var(--color-success,#487050)'}" onclick="toggleRecompensa('${r.id}',${!r.activa})">
          ${r.activa ? 'Desactivar' : 'Activar'}
        </button>
      </div>
    </div>
  `).join('');

  const pie = piePaginacionGrid(total, _recompVisibles, RECOMP_MOSTRAR_INICIAL, RECOMP_PAGINA, 'cargarMasRecompensas', 'colapsarRecompensas');
  grid.innerHTML = tarjetas + pie;
}

function cargarMasRecompensas() {
  _recompVisibles = Math.min(recompensasData.length, _recompVisibles + RECOMP_PAGINA);
  renderRecompensas();
}
function colapsarRecompensas() {
  _recompVisibles = RECOMP_MOSTRAR_INICIAL;
  renderRecompensas();
  document.getElementById('recompensas-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function abrirModalRecompensa() {
  editRecompensaId = null;
  document.getElementById('form-recompensa')?.reset();
  document.getElementById('grupo-valor')?.classList.add('hidden');
  document.getElementById('modal-recomp-titulo').textContent = 'Nueva Recompensa';
  document.getElementById('btn-guardar-recomp').textContent  = 'Crear recompensa';
  document.getElementById('modal-backdrop').style.display    = 'block';
  document.getElementById('modal-recompensa').style.display  = 'block';
}

function editarRecompensa(id) {
  const r = recompensasData.find(x => x.id === id);
  if (!r) return;
  editRecompensaId = id;
  setVal('r-nombre',       r.nombre);
  setVal('r-descripcion',  r.descripcion || '');
  setVal('r-puntos',       r.puntos_requeridos);
  setVal('r-tipo',         r.tipo);
  setVal('r-valor',        r.valor || '');
  setVal('r-cantidad',     r.cantidad_disponible || '');
  setVal('r-fecha-inicio', r.fecha_inicio || '');
  setVal('r-fecha-fin',    r.fecha_fin || '');
  actualizarTipoRecompensa();
  document.getElementById('modal-recomp-titulo').textContent = 'Editar Recompensa';
  document.getElementById('btn-guardar-recomp').textContent  = 'Guardar cambios';
  document.getElementById('modal-backdrop').style.display    = 'block';
  document.getElementById('modal-recompensa').style.display  = 'block';
}

async function toggleRecompensa(id, activa) {
  try {
    const { error } = await window.conTimeoutRed(sb.from('recompensas')
      .update({ activa, updated_at: new Date().toISOString() })
      .eq('id', id).eq('empresa_id', empresaId), 10000);
    if (error) throw error;
    recompensasData = recompensasData.map(r => r.id === id ? { ...r, activa } : r);
    renderRecompensas();
    window.toast(activa ? 'Recompensa activada' : 'Recompensa desactivada', 'ok');
  } catch (e) { console.error('[fidelizacion] toggleRecompensa:', e); window.toast('No se pudo cambiar el estado de la recompensa', 'err'); }
}

async function guardarRecompensa(e) {
  e.preventDefault();
  const ok = await window.confirmar(
    editRecompensaId ? '¿Guardar los cambios de esta recompensa?' : '¿Confirmás crear esta recompensa?',
    { labelOk: editRecompensaId ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!ok) return;
  const btn = document.getElementById('btn-guardar-recomp');
  btn.disabled = true;
  try {
    const payload = {
      empresa_id:         empresaId,
      nombre:             getVal('r-nombre'),
      descripcion:        getVal('r-descripcion') || null,
      puntos_requeridos:  parseInt(getVal('r-puntos')) || 0,
      tipo:               getVal('r-tipo'),
      valor:              parseFloat(getVal('r-valor')) || null,
      cantidad_disponible:parseInt(getVal('r-cantidad')) || null,
      fecha_inicio:       getVal('r-fecha-inicio') || null,
      fecha_fin:          getVal('r-fecha-fin')    || null,
      activa:             true,
      updated_at:         new Date().toISOString(),
    };
    let error;
    if (editRecompensaId) {
      ({ error } = await window.conTimeoutRed(sb.from('recompensas').update(payload).eq('id', editRecompensaId).eq('empresa_id', empresaId), 10000));
    } else {
      ({ error } = await window.conTimeoutRed(sb.from('recompensas').insert(payload), 10000));
    }
    if (error) throw error;
    cerrarModal();
    await cargarRecompensas();
    window.toast(editRecompensaId ? 'Recompensa actualizada' : 'Recompensa creada', 'ok');
  } catch (e) {
    console.error('[fidelizacion] guardarRecompensa:', e);
    window.toast('No se pudo guardar la recompensa', 'err');
  } finally { btn.disabled = false; }
}

function actualizarTipoRecompensa() {
  const tipo  = getVal('r-tipo');
  const grupo = document.getElementById('grupo-valor');
  const label = document.getElementById('label-valor');
  if (!grupo) return;
  const necesitaValor = ['descuento_fijo','descuento_porcentaje','producto_gratis'].includes(tipo);
  grupo.classList.toggle('hidden', !necesitaValor);
  if (label) label.textContent = tipo === 'descuento_porcentaje' ? 'Porcentaje (%)' : 'Valor ($)';
}

function cerrarModal() {
  document.getElementById('modal-backdrop').style.display   = 'none';
  document.getElementById('modal-recompensa').style.display = 'none';
  editRecompensaId = null;
}

// ── Canjes Recompensas ────────────────────────────────────────────────────────
async function cargarCanjes() {
  const tbody = document.getElementById('tbody-canjes');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--color-text-muted)">Cargando…</td></tr>';
  try {
    const estado = document.getElementById('filtro-estado-canjes')?.value || '';
    let q = sb.from('canjes_recompensas')
      .select('*, clientes(razon_social, nombre_fantasia), recompensas(nombre, puntos_requeridos)')
      .eq('empresa_id', empresaId)
      .order('created_at', { ascending: false })
      .limit(150);
    if (estado) q = q.eq('estado', estado);

    const { data, error } = await window.conTimeoutRed(q, 10000);
    if (error) throw error;
    canjesData = data || [];
    _canjesVisibles = CANJES_MOSTRAR_INICIAL;
    renderCanjes(canjesData);

    // Actualizar badge con pendientes reales
    const pend = canjesData.filter(c => c.estado === 'pendiente').length;
    actualizarBadgeCanjes(pend);
  } catch (e) {
    console.error('[fidelizacion] cargarCanjes:', e);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--color-danger);">No se pudieron cargar los canjes.</td></tr>`;
  }
}

function filtrarCanjes() { cargarCanjes(); }

function renderCanjes(lista) {
  const tbody = document.getElementById('tbody-canjes');
  if (!tbody) return;
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--color-text-muted)">Sin solicitudes de canje en este estado</td></tr>';
    return;
  }

  const CHIP_CLASS = { pendiente:'chip-pendiente', aplicado:'chip-aplicado', expirado:'chip-expirado' };
  const ESTADO_LABEL = { pendiente:'Pendiente', aplicado:'Aplicado', expirado:'Expirado' };

  const total    = lista.length;
  const visibles = lista.slice(0, _canjesVisibles);

  const filas = visibles.map(c => {
    const cliente  = c.clientes;
    const nombCli  = cliente?.razon_social || cliente?.nombre_fantasia || c.cliente_id;
    const nombRec  = c.recompensas?.nombre || '—';
    const fecha    = new Date(c.created_at).toLocaleDateString('es-AR');
    const cls      = CHIP_CLASS[c.estado] || '';

    const acciones = c.estado === 'pendiente' ? `
      <button class="btn btn--ghost" style="font-size:12px;padding:4px 10px;color:var(--color-success)" onclick="actualizarEstadoCanje('${c.id}','aplicado')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Aplicar</button>
      <button class="btn btn--ghost" style="font-size:12px;padding:4px 10px;color:var(--color-danger)"  onclick="actualizarEstadoCanje('${c.id}','expirado')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Expirar</button>
    ` : '—';

    return `<tr>
      <td style="white-space:nowrap;">${fecha}</td>
      <td>${esc(nombCli)}</td>
      <td>${esc(nombRec)}</td>
      <td style="text-align:left;font-weight:600;">${Number(c.puntos_gastados||0).toLocaleString('es-AR')}</td>
      <td><span class="chip-base ${cls}">${ESTADO_LABEL[c.estado]||c.estado}</span></td>
      <td class="col-sticky-end" style="white-space:nowrap;">${acciones}</td>
    </tr>`;
  }).join('');

  const pie = piePaginacionFila(6, total, _canjesVisibles, CANJES_MOSTRAR_INICIAL, CANJES_PAGINA, 'cargarMasCanjes', 'colapsarCanjes');
  tbody.innerHTML = filas + pie;
}

function cargarMasCanjes() {
  _canjesVisibles = Math.min(canjesData.length, _canjesVisibles + CANJES_PAGINA);
  renderCanjes(canjesData);
}
function colapsarCanjes() {
  _canjesVisibles = CANJES_MOSTRAR_INICIAL;
  renderCanjes(canjesData);
}

async function actualizarEstadoCanje(id, nuevoEstado) {
  try {
    const patch = { estado: nuevoEstado };
    if (nuevoEstado === 'aplicado') patch.aplicado_at = new Date().toISOString();
    const { error } = await window.conTimeoutRed(sb.from('canjes_recompensas')
      .update(patch).eq('id', id).eq('empresa_id', empresaId), 10000);
    if (error) throw error;
    window.toast(nuevoEstado === 'aplicado' ? 'Canje aplicado' : 'Canje expirado', 'ok');
    await cargarCanjes();
    await cargarKPIs();
  } catch (e) {
    console.error('[fidelizacion] actualizarEstadoCanje:', e);
    window.toast('No se pudo actualizar el canje', 'err');
  }
}

// ── Clientes con puntos ───────────────────────────────────────────────────────
async function cargarClientesPuntos() {
  const tbody = document.getElementById('tabla-clientes-puntos');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--color-text-muted)">Cargando…</td></tr>';
  try {
    const { data, error } = await window.conTimeoutRed(sb.from('saldo_puntos')
      .select('puntos_disponibles, puntos_canjeados, puntos_totales, ultimo_movimiento, cliente_id, clientes(razon_social, nombre_fantasia)')
      .eq('empresa_id', empresaId)
      .order('puntos_disponibles', { ascending: false }), 10000);
    if (error) throw error;
    clientesPuntosData = data || [];
    _clientesVisibles = CLIENTES_MOSTRAR_INICIAL;
    renderClientesPuntos(clientesPuntosData);
  } catch (e) {
    console.error('[fidelizacion] cargarClientesPuntos:', e);
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--color-danger);text-align:center;padding:32px">Error al cargar</td></tr>';
  }
}

function renderClientesPuntos(lista) {
  const tbody = document.getElementById('tabla-clientes-puntos');
  if (!tbody) return;
  _clientesListaActual = lista;
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--color-text-muted)">Sin clientes con puntos aún</td></tr>';
    return;
  }
  const total    = lista.length;
  const visibles = lista.slice(0, _clientesVisibles);

  const filas = visibles.map(r => {
    const c    = r.clientes;
    const name = c?.razon_social || c?.nombre_fantasia || r.cliente_id;
    const ult  = r.ultimo_movimiento ? new Date(r.ultimo_movimiento).toLocaleDateString('es-AR') : '—';
    return `<tr>
      <td>${esc(name)}</td>
      <td style="text-align:left;font-weight:700;color:var(--color-primary)">${Number(r.puntos_disponibles||0).toLocaleString('es-AR')}</td>
      <td style="text-align:left;">${Number(r.puntos_totales||0).toLocaleString('es-AR')}</td>
      <td style="text-align:left;color:var(--color-text-muted);">${Number(r.puntos_canjeados||0).toLocaleString('es-AR')}</td>
      <td style="text-align:center;font-size:12px;color:var(--color-text-muted);">${ult}</td>
    </tr>`;
  }).join('');

  const pie = piePaginacionFila(5, total, _clientesVisibles, CLIENTES_MOSTRAR_INICIAL, CLIENTES_PAGINA, 'cargarMasClientes', 'colapsarClientes');
  tbody.innerHTML = filas + pie;
}

function cargarMasClientes() {
  _clientesVisibles = Math.min(_clientesListaActual.length, _clientesVisibles + CLIENTES_PAGINA);
  renderClientesPuntos(_clientesListaActual);
}
function colapsarClientes() {
  _clientesVisibles = CLIENTES_MOSTRAR_INICIAL;
  renderClientesPuntos(_clientesListaActual);
}

function filtrarClientes() {
  const q = (document.getElementById('busqueda-cliente')?.value || '').toLowerCase();
  const filtrados = q
    ? clientesPuntosData.filter(r => {
        const c = r.clientes;
        return (c?.razon_social || '').toLowerCase().includes(q) ||
               (c?.nombre_fantasia || '').toLowerCase().includes(q);
      })
    : clientesPuntosData;
  _clientesVisibles = CLIENTES_MOSTRAR_INICIAL;
  renderClientesPuntos(filtrados);
}

// ── Historial ─────────────────────────────────────────────────────────────────
async function cargarHistorial() {
  const tbody = document.getElementById('tabla-historial-movimientos');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--color-text-muted)">Cargando…</td></tr>';
  try {
    const { data, error } = await window.conTimeoutRed(sb.from('movimientos_puntos')
      .select('*, clientes(razon_social, nombre_fantasia)')
      .eq('empresa_id', empresaId)
      .order('created_at', { ascending: false })
      .limit(200), 10000);
    if (error) throw error;
    historialData = data || [];
    _historialVisibles = HISTORIAL_MOSTRAR_INICIAL;
    renderHistorial(historialData);
  } catch (e) {
    console.error('[fidelizacion] cargarHistorial:', e);
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--color-danger);text-align:center;padding:32px">Error al cargar</td></tr>';
  }
}

function filtrarHistorial() {
  const tipo = document.getElementById('filtro-tipo-mov')?.value || '';
  _historialVisibles = HISTORIAL_MOSTRAR_INICIAL;
  renderHistorial(tipo ? historialData.filter(m => m.tipo === tipo) : historialData);
}

function renderHistorial(lista) {
  const tbody = document.getElementById('tabla-historial-movimientos');
  if (!tbody) return;
  _historialListaActual = lista;
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--color-text-muted)">Sin movimientos</td></tr>';
    return;
  }
  const CLR = { ganancia:'var(--color-success,#487050)', canje:'var(--color-danger,#7A2820)', ajuste:'var(--color-warning,#8A5F13)', bonus:'var(--nav-facturacion,#5B4A8F)' };
  const LBL = { ganancia:'Ganancia', canje:'Canje', ajuste:'Ajuste', bonus:'Bonus' };

  const total    = lista.length;
  const visibles = lista.slice(0, _historialVisibles);

  const filas = visibles.map(m => {
    const c     = m.clientes;
    const name  = c?.razon_social || c?.nombre_fantasia || m.cliente_id;
    const fecha = new Date(m.created_at).toLocaleDateString('es-AR');
    const sign  = m.tipo === 'canje' ? '-' : '+';
    const color = CLR[m.tipo] || 'var(--color-text)';
    return `<tr>
      <td style="white-space:nowrap;font-size:12px;color:var(--color-text-muted);">${fecha}</td>
      <td>${esc(name)}</td>
      <td><span style="font-size:11px;padding:2px 8px;border-radius:99px;background:${color}22;color:${color};font-weight:600;">${LBL[m.tipo]||m.tipo}</span></td>
      <td style="text-align:left;font-weight:700;color:${color};">${sign}${Math.abs(Number(m.cantidad)).toLocaleString('es-AR')}</td>
      <td style="font-size:12px;color:var(--color-text-muted);">${esc(m.motivo||'—')}</td>
    </tr>`;
  }).join('');

  const pie = piePaginacionFila(5, total, _historialVisibles, HISTORIAL_MOSTRAR_INICIAL, HISTORIAL_PAGINA, 'cargarMasHistorial', 'colapsarHistorial');
  tbody.innerHTML = filas + pie;
}

function cargarMasHistorial() {
  _historialVisibles = Math.min(_historialListaActual.length, _historialVisibles + HISTORIAL_PAGINA);
  renderHistorial(_historialListaActual);
}
function colapsarHistorial() {
  _historialVisibles = HISTORIAL_MOSTRAR_INICIAL;
  renderHistorial(_historialListaActual);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
async function selTab(tab) {
  tabActiva = tab;
  document.querySelectorAll('.fidel-tab').forEach(b =>
    b.classList.toggle('activo', b.getAttribute('onclick')?.includes(`'${tab}'`))
  );
  document.querySelectorAll('.tab-content').forEach(c =>
    c.classList.toggle('activo', c.id === `tab-${tab}`)
  );
  if (tab === 'recompensas' && !recompensasData.length) await cargarRecompensas();
  if (tab === 'canjes')                                  await cargarCanjes();
  if (tab === 'clientes'    && !clientesPuntosData.length) await cargarClientesPuntos();
  if (tab === 'historial'   && !historialData.length)    await cargarHistorial();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getVal(id)  { return document.getElementById(id)?.value ?? ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }
function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

// Exponer globales para onclick inline
window.selTab                 = selTab;
window.abrirModalRecompensa   = abrirModalRecompensa;
window.editarRecompensa       = editarRecompensa;
window.toggleRecompensa       = toggleRecompensa;
window.actualizarTipoRecompensa = actualizarTipoRecompensa;
window.cerrarModal            = cerrarModal;
window.filtrarClientes        = filtrarClientes;
window.filtrarCanjes          = filtrarCanjes;
window.cargarCanjes           = cargarCanjes;
window.actualizarEstadoCanje  = actualizarEstadoCanje;
window.filtrarHistorial       = filtrarHistorial;
window.cargarMasRecompensas   = cargarMasRecompensas;
window.colapsarRecompensas    = colapsarRecompensas;
window.cargarMasCanjes        = cargarMasCanjes;
window.colapsarCanjes         = colapsarCanjes;
window.cargarMasClientes      = cargarMasClientes;
window.colapsarClientes       = colapsarClientes;
window.cargarMasHistorial     = cargarMasHistorial;
window.colapsarHistorial      = colapsarHistorial;
