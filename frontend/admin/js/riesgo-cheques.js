/* admin/js/riesgo-cheques.js — Análisis de riesgo de cheques
 *
 * Cruza los cheques en cartera / rechazados de cada cliente con la
 * infraestructura de "Score de Salud del Cliente" que ya existe en el
 * proyecto (clientes.score_actual/score_categoria, alertas_score,
 * v_cobranza_priorizada vía /api/score) para dar una vista de riesgo
 * antes de depositar o aceptar un cheque nuevo.
 *
 * Fuentes de datos:
 *  - `cheques` + `clientes` (score_actual, score_categoria): query directa
 *    con el cliente Supabase autenticado (respeta RLS), mismo patrón que
 *    cheques.js.
 *  - `/api/score?accion=alertas`: alertas de caída de score no resueltas
 *    (mismo endpoint que usa clientes.js).
 *  - `/api/score?accion=cobranza-priorizada`: expone v_cobranza_priorizada
 *    (deuda_actual vía calcular_deuda_cliente(), límite de crédito). Esta
 *    RPC tiene el EXECUTE revocado para authenticated/anon (ver migración
 *    135/136), por eso NO se llama directo por RPC desde acá — se reusa
 *    el endpoint backend ya existente, que sí corre con service_role y
 *    filtra por empresa_id del token.
 */

let _sb = null;
let todosClientesRiesgo = [];
let filtroTabRiesgo = 'todos'; // 'todos' | 'en_riesgo' — ver initFiltroTabsRiesgo()
let filtroCategoriaRiesgo = ''; // '' | 'premium' | 'bueno' | 'normal' | 'riesgo' | 'bloqueado' — ver filtrarCategoriaRiesgo()

// ── Paginación cliente ("Cargar más") ───────────────────────────────────────
const RIESGO_MOSTRAR_INICIAL = 20;
const RIESGO_PAGINA          = 40;
let _riesgoVisibles = RIESGO_MOSTRAR_INICIAL;
let _riesgoListaActual = [];

function piePaginacionHTML(colspan, total, visibles, mostrarInicial, pagina, cargarMasFn, colapsarFn) {
  const hayMas        = total > visibles;
  const puedeColapsar = visibles > mostrarInicial;
  if (!hayMas && !puedeColapsar) return '';
  const restantes = total - visibles;
  return `<tr class="paginar-fila"><td colspan="${colspan}"><div class="paginar-foot">
    ${hayMas ? `<button type="button" class="paginar-btn" onclick="${cargarMasFn}()">Cargar ${Math.min(pagina, restantes)} más (quedan ${restantes})</button>` : ''}
    ${puedeColapsar ? `<button type="button" class="paginar-btn paginar-btn--ghost" onclick="${colapsarFn}()">Ver menos</button>` : ''}
  </div></td></tr>`;
}

const SCORE_CATEGORIAS = {
  premium:   { cls: 'score-premium',   icono: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:3px"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>', label: 'Premium'   },
  bueno:     { cls: 'score-bueno',     icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Bueno'     },
  normal:    { cls: 'score-normal',    icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Normal'    },
  riesgo:    { cls: 'score-riesgo',    icono: '<svg width="8" height="8" viewBox="0 0 8 8" style="vertical-align:1px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>', label: 'Riesgo'    },
  bloqueado: { cls: 'score-bloqueado', icono: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>', label: 'Bloqueado' },
};

window.authReady.then(async () => {
  const user = window.authCtx?.perfil;
  if (!user) { window.location.href = '/admin/login'; return; }
  _sb = window.authCtx.sb;

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent = hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;

  initFiltroTabsRiesgo();
  await cargarRiesgoCheques();
  cargarEntidadesBcraLibre(); // no bloqueante — el panel de consulta libre puede tardar en poblarse
}).catch(err => {
  console.error('[riesgo-cheques] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});

// ── Carga principal ─────────────────────────────────────────────────────
// XSS: helper para escapar de forma segura texto libre (nombre de cliente)
// dentro de un argumento de atributo onclick="funcion('...')". El patrón
// anterior (.replace(/'/g, "\\'")) solo escapaba comillas simples, no dobles
// ni el atributo HTML en sí. JSON.stringify escapa comillas/backslashes
// correctamente para el string JS, y el resto escapa lo necesario para el
// atributo HTML que lo contiene.
function escOnclickArg(valor) {
  return JSON.stringify(String(valor ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Modal de nivel de confianza (duplicado de clientes.js a propósito —
// ver CHANGELOG_v914; misma UI que en Clientes, invocada desde acá al
// hacer clic en el badge de score de la tabla de riesgo de cheques) ────────
function motivoFrase(comp, cat) {
  if (!['riesgo', 'bloqueado'].includes(cat)) return '';
  if (!comp) return '';

  function frasePagos(val) {
    if (val == null)  return 'Sin historial de pagos registrado';
    if (val <= 5)     return 'Paga con mucho atraso (más de 30 días después del vencimiento)';
    if (val <= 15)    return 'Paga con bastante atraso (15–30 días después del vencimiento)';
    if (val <= 25)    return 'Paga con algo de atraso (7–15 días después del vencimiento)';
    return null;
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

  const componentes = [
    { key: 'score_pagos',      max: 40, fn: frasePagos      },
    { key: 'score_deuda',      max: 20, fn: fraseDeuda      },
    { key: 'score_frecuencia', max: 25, fn: fraseFrecuencia },
    { key: 'score_devolucion', max: 15, fn: fraseDevolucion },
  ];

  let peor = null, peorPct = Infinity;
  for (const c of componentes) {
    const val = comp[c.key] != null ? Number(comp[c.key]) : null;
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
        ${frase ? `<p class="score-motivo-frase">${window.sanitize(frase)}</p>` : ''}
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

function cerrarModalScore() {
  const m = document.getElementById('modal-score-cliente');
  if (m) m.style.display = 'none';
}

async function recalcularScore(clienteId) {
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
    mostrarToast(`Nivel de confianza recalculado: ${Math.round(data.score)}/100`, 'ok');
    await verScoreCliente(clienteId);
  } catch (err) {
    console.error(err);
    mostrarToast('No se pudo recalcular el nivel de confianza', 'err');
  }
}

async function ofrecerPlanPago(clienteId) {
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
    mostrarToast('Oferta de plan de pago enviada por WhatsApp', 'ok');
    await verScoreCliente(clienteId);
  } catch (err) {
    console.error(err);
    mostrarToast('No se pudo enviar la oferta por WhatsApp', 'err');
  }
}

async function cargarRiesgoCheques() {
  try {
    window.mostrarSkeletonTabla('tbody-riesgo-cheques', 5, 7);

    const [riesgoRes, alertasPorCliente, deudaPorCliente] = await Promise.all([
      window.conTimeoutRed(_sb.rpc('fn_riesgo_cheques_lista'), 10000),
      cargarAlertasPorCliente(),
      cargarDeudaPorCliente(),
    ]);

    if (riesgoRes.error) throw riesgoRes.error;

    // La agregación por cliente (monto/cantidad de cartera y de rechazados,
    // ya filtrado a clientes con exposición o antecedentes) viene resuelta
    // en SQL por fn_riesgo_cheques_lista (migración 261) — acá solo se
    // adapta el nombre de los campos y se pega la info de alertas/deuda.
    const lista = (riesgoRes.data || []).map(r => ({
      id: r.id,
      nombre: r.nombre,
      cuit: r.cuit || null,
      score: r.score ?? 50,
      categoria: r.categoria || 'normal',
      carteraMonto: Number(r.cartera_monto) || 0,
      carteraCantidad: r.cartera_cantidad || 0,
      rechazadosMonto: Number(r.rechazados_monto) || 0,
      rechazadosCantidad: r.rechazados_cantidad || 0,
    }));

    lista.forEach(c => {
      c.ultimaAlerta = alertasPorCliente[c.id] || null;
      const deuda = deudaPorCliente[c.id];
      c.deudaActual   = deuda ? deuda.deuda_actual   : null;
      c.limiteCredito = deuda ? deuda.limite_credito : null;
    });

    todosClientesRiesgo = lista;
    _riesgoVisibles = RIESGO_MOSTRAR_INICIAL;
    actualizarKPIsRiesgo(lista);
    renderAlertasPanel(lista);
    renderTablaRiesgo(lista);
  } catch (e) {
    console.error('[riesgo-cheques] Error cargando análisis:', e);
    mostrarToast('No se pudo cargar el análisis de riesgo', 'err');
    document.getElementById('tbody-riesgo-cheques').innerHTML =
      `<tr><td colspan="7"><div class="empty-state">No se pudo cargar el análisis</div></td></tr>`;
  }
}

async function recargarRiesgoCheques() {
  await cargarRiesgoCheques();
  mostrarToast('Análisis actualizado', 'ok');
}

// ── Fuentes auxiliares ──────────────────────────────────────────────────
async function getFreshToken() {
  const { data: { session } } = await _sb.auth.getSession();
  return session?.access_token || '';
}

async function cargarAlertasPorCliente() {
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/score?accion=alertas&limite=todas', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return {};
    const { alertas } = await resp.json();
    const map = {};
    // Vienen ordenadas por created_at desc; nos quedamos con la más reciente por cliente
    (alertas || []).forEach(a => { if (!map[a.cliente_id]) map[a.cliente_id] = a; });
    return map;
  } catch (e) {
    console.error('[riesgo-cheques] alertas:', e);
    return {};
  }
}

async function cargarDeudaPorCliente() {
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/score?accion=cobranza-priorizada', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return {};
    const { cobranza } = await resp.json();
    const map = {};
    // deuda_actual/limite_credito son iguales en todas las filas de un mismo
    // cliente (una fila por factura pendiente); con la primera alcanza.
    (cobranza || []).forEach(f => {
      if (!map[f.cliente_id]) {
        map[f.cliente_id] = { deuda_actual: f.deuda_actual, limite_credito: f.limite_credito };
      }
    });
    return map;
  } catch (e) {
    console.error('[riesgo-cheques] deuda:', e);
    return {};
  }
}

// ── KPIs ─────────────────────────────────────────────────────────────────
function actualizarKPIsRiesgo(lista) {
  const enRiesgo = lista.filter(c => ['riesgo', 'bloqueado'].includes(c.categoria) && c.carteraCantidad > 0);
  const montoRiesgo = enRiesgo.reduce((s, c) => s + c.carteraMonto, 0);
  const cantChequesRiesgo = enRiesgo.reduce((s, c) => s + c.carteraCantidad, 0);

  const montoRechazado = lista.reduce((s, c) => s + c.rechazadosMonto, 0);
  const cantRechazados = lista.reduce((s, c) => s + c.rechazadosCantidad, 0);

  const alertasCount = lista.filter(c => c.ultimaAlerta && c.carteraCantidad > 0).length;

  FiltroTabs.actualizarContadores(document.getElementById('filtro-tabs-riesgo'), {
    todos: lista.length,
    en_riesgo: enRiesgo.length,
  });
  document.getElementById('kpi-monto-riesgo').textContent = formatPeso(montoRiesgo);
  document.getElementById('kpi-monto-riesgo-sub').textContent = `(${cantChequesRiesgo} cheque${cantChequesRiesgo === 1 ? '' : 's'})`;
  document.getElementById('kpi-rechazados').textContent = formatPeso(montoRechazado);
  document.getElementById('kpi-rechazados-sub').textContent = `(${cantRechazados} cheque${cantRechazados === 1 ? '' : 's'})`;
  document.getElementById('kpi-alertas').textContent = alertasCount;
}

function initFiltroTabsRiesgo() {
  FiltroTabs.crear(document.getElementById('filtro-tabs-riesgo'), [
    { key: 'todos',     label: 'Todos los clientes' },
    { key: 'en_riesgo', label: 'En riesgo o bloqueados' },
  ], 'todos', (key) => {
    filtroTabRiesgo = key;
    filtrarRiesgoCheques();
  });
}

function renderAlertasPanel(lista) {
  const panel = document.getElementById('alertas-score-panel');
  const conAlerta = lista.filter(c => c.ultimaAlerta && c.carteraCantidad > 0);
  if (!conAlerta.length) { panel.style.display = 'none'; return; }

  panel.style.display = 'block';
  panel.innerHTML = `<button type="button" class="alerta-inline warning alerta-inline--clickable" onclick="irAClientesConAlerta()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <span><strong>${conAlerta.length} cliente${conAlerta.length > 1 ? 's' : ''} con cheques en cartera ${conAlerta.length > 1 ? 'tuvieron' : 'tuvo'} una caída reciente de score</strong> — revisá antes de depositar.</span>
    <svg class="alerta-inline-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
  </button>`;
}

// Al hacer clic en el banner de "caída reciente de score": lleva a la tabla
// de abajo ("Clientes con cheques en cartera"), activa el checkbox "Solo con
// rechazos o alertas" (mismo criterio que usa el banner: c.ultimaAlerta) y
// hace scroll + destello visual para que quede claro a qué fila hace
// referencia la alerta, sin duplicar lógica de filtrado.
function irAClientesConAlerta() {
  const chk = document.getElementById('filtro-solo-alerta');
  if (chk && !chk.checked) {
    chk.checked = true;
    filtrarRiesgoCheques();
  }
  const wrap = document.getElementById('tabla-riesgo-wrap');
  if (!wrap) return;
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  wrap.classList.remove('tabla-wrap--flash'); // reinicia la animación si se clickea 2 veces seguidas
  void wrap.offsetWidth; // forzar reflow
  wrap.classList.add('tabla-wrap--flash');
  setTimeout(() => wrap.classList.remove('tabla-wrap--flash'), 1600);
}
window.irAClientesConAlerta = irAClientesConAlerta;

// ── Avatar circular con iniciales del cliente (estilo TravelBox) ───────────
const CLIENTE_PALETTE = ['#8B5CF6', '#F59E0B', '#3B82F6', '#0D9488', '#EF4444'];
function avatarCliente(nombre) {
  const n = (nombre || '?').trim();
  const iniciales = n.split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';
  let hash = 0;
  for (let i = 0; i < n.length; i++) hash = (hash * 31 + n.charCodeAt(i)) >>> 0;
  const color = CLIENTE_PALETTE[hash % CLIENTE_PALETTE.length];
  return `<span class="riesgo-cliente-fila">
    <span class="riesgo-cliente-avatar" style="background:${color}">${iniciales}</span>
    <span>${window.sanitize(n)}</span>
  </span>`;
}

// ── Tabla ────────────────────────────────────────────────────────────────
function renderTablaRiesgo(lista) {
  const tbody = document.getElementById('tbody-riesgo-cheques');
  _riesgoListaActual = lista;
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
      No hay clientes con cheques en cartera ni antecedentes de rechazo</div></td></tr>`;
    return;
  }

  const total    = lista.length;
  const visibles = lista.slice(0, _riesgoVisibles);

  const filas = visibles.map(c => {
    const cat = SCORE_CATEGORIAS[c.categoria] || SCORE_CATEGORIAS.normal;
    const scoreHtml = `<button type="button" class="score-badge-btn ${cat.cls}" onclick="verScoreCliente('${c.id}')" title="${cat.label} · nivel de confianza ${Math.round(c.score)}/100 — ver detalle">${cat.icono} ${Math.round(c.score)}</button>`;

    const carteraHtml = c.carteraCantidad
      ? `${formatPeso(c.carteraMonto)}<br><span style="font-size:11px;color:var(--color-text-muted)">${c.carteraCantidad} cheque${c.carteraCantidad > 1 ? 's' : ''}</span>`
      : '—';

    const rechazadosHtml = c.rechazadosCantidad
      ? `<span style="color:var(--color-danger);font-weight:600">${formatPeso(c.rechazadosMonto)}</span><br><span style="font-size:11px;color:var(--color-text-muted)">${c.rechazadosCantidad} cheque${c.rechazadosCantidad > 1 ? 's' : ''}</span>`
      : '—';

    let deudaHtml = '—';
    if (c.deudaActual != null) {
      if (c.limiteCredito) {
        const pct = Math.round((c.deudaActual / c.limiteCredito) * 100);
        const color = pct >= 90 ? 'var(--color-danger)' : pct >= 60 ? 'var(--color-warning, #8A5F13)' : 'inherit';
        deudaHtml = `<span style="color:${color}">${formatPeso(c.deudaActual)} / ${formatPeso(c.limiteCredito)}</span><br><span style="font-size:11px;color:var(--color-text-muted)">${pct}% usado</span>`;
      } else {
        deudaHtml = formatPeso(c.deudaActual);
      }
    }

    const alertaHtml = c.ultimaAlerta
      ? `<span title="${window.sanitize(c.ultimaAlerta.mensaje || '')}" style="color:var(--color-danger);font-size:12px;cursor:help"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:2px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${formatFechaCorta(c.ultimaAlerta.created_at)}</span>`
      : '—';

    const bcraHtml = c.cuit
      ? `<button class="btn btn-sm btn-secondary btn--secondary" style="font-size:11px" onclick="verificarBcraCliente('${c.id}')">Verificar</button>`
      : `<span style="font-size:11px;color:var(--color-text-muted)" title="El cliente no tiene CUIT cargado">Sin CUIT</span>`;

    return `<tr>
      <td data-label="Cliente">${avatarCliente(c.nombre)}</td>
      <td data-label="Score">${scoreHtml}</td>
      <td class="monto" data-label="En cartera">${carteraHtml}</td>
      <td class="monto" data-label="Rechazados (hist.)">${rechazadosHtml}</td>
      <td data-label="Deuda / Límite">${deudaHtml}</td>
      <td data-label="Última alerta">${alertaHtml}</td>
      <td data-label="BCRA (oficial)">${bcraHtml}</td>
      <td class="col-sticky-end" data-label="Acciones">
        <button class="btn btn-sm btn-secondary btn--secondary" style="font-size:11px" onclick="verChequesDeCliente(${escOnclickArg(c.nombre)})">Ver cheques</button>
      </td>
    </tr>`;
  }).join('');

  const pie = piePaginacionHTML(8, total, _riesgoVisibles, RIESGO_MOSTRAR_INICIAL, RIESGO_PAGINA, 'cargarMasRiesgo', 'colapsarRiesgo');
  tbody.innerHTML = filas + pie;
}

function cargarMasRiesgo() {
  _riesgoVisibles = Math.min(_riesgoListaActual.length, _riesgoVisibles + RIESGO_PAGINA);
  renderTablaRiesgo(_riesgoListaActual);
}
function colapsarRiesgo() {
  _riesgoVisibles = RIESGO_MOSTRAR_INICIAL;
  renderTablaRiesgo(_riesgoListaActual);
}
window.cargarMasRiesgo = cargarMasRiesgo;
window.colapsarRiesgo  = colapsarRiesgo;

// ── Filtros ──────────────────────────────────────────────────────────────
// Pills de nivel de confianza (reemplaza al <select> que tenía antes —
// mismo patrón que /admin/clientes, ver clientes.js:selFiltroEstado).
function filtrarCategoriaRiesgo(cat, btn) {
  filtroCategoriaRiesgo = cat;
  document.querySelectorAll('#filtro-categoria-riesgo .e-pill').forEach(b => b.classList.remove('activa'));
  btn.classList.add('activa');
  filtrarRiesgoCheques();
}
window.filtrarCategoriaRiesgo = filtrarCategoriaRiesgo;

function filtrarRiesgoCheques() {
  const q = document.getElementById('buscar-riesgo').value.toLowerCase();
  const cat = filtroCategoriaRiesgo;
  const soloAlerta = document.getElementById('filtro-solo-alerta').checked;

  const filtrado = todosClientesRiesgo.filter(c => {
    if (q && !c.nombre.toLowerCase().includes(q)) return false;
    if (cat && c.categoria !== cat) return false;
    if (soloAlerta && !(c.rechazadosCantidad > 0 || c.ultimaAlerta)) return false;
    if (filtroTabRiesgo === 'en_riesgo' && !(['riesgo', 'bloqueado'].includes(c.categoria) && c.carteraCantidad > 0)) return false;
    return true;
  });
  _riesgoVisibles = RIESGO_MOSTRAR_INICIAL;
  renderTablaRiesgo(filtrado);
}

// ── Navegación ───────────────────────────────────────────────────────────
function verChequesDeCliente(nombre) {
  window.location.href = `/admin/cheques?buscar=${encodeURIComponent(nombre)}`;
}

// ── Verificación oficial BCRA (Central de Deudores) ─────────────────────
// Dato público oficial del Banco Central, independiente del score interno
// del sistema. Ver lib/handlers/bcra.js — sin probar aún contra la API
// real, así que se muestra tal cual devuelva el backend y cualquier error
// de red/parseo se refleja en el modal en vez de romper la pantalla.
async function verificarBcraCliente(clienteId) {
  const cliente = todosClientesRiesgo.find(c => c.id === clienteId);
  if (!cliente || !cliente.cuit) return;

  abrirModalBcra();
  const body = document.getElementById('bcra-cliente-body');
  body.innerHTML = 'Consultando al Banco Central...';

  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/bcra?accion=verificar-cliente&cuit=${encodeURIComponent(cliente.cuit)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error || 'Error al consultar BCRA');

    body.innerHTML = renderResultadoBcra(cliente, json);
  } catch (e) {
    console.error('[riesgo-cheques] verificarBcraCliente:', e);
    body.innerHTML = `<div class="alerta-inline warning">No se pudo consultar al Banco Central. Probá de nuevo en un momento.</div>`;
  }
}

function renderResultadoBcra(cliente, json) {
  const { situacion, rechazados, errores } = json;

  // Situación crediticia (Deudas/{cuit}) — un registro por entidad financiera
  let situacionHtml;
  if (errores?.situacion) {
    situacionHtml = `<p style="color:var(--color-danger);font-size:13px">No se pudo obtener la situación: ${window.sanitize(errores.situacion)}</p>`;
  } else if (!situacion || !situacion.periodos?.length) {
    situacionHtml = `<p style="font-size:13px;color:var(--color-text-muted)">Sin registros en el sistema financiero (dato bueno, o CUIT sin movimientos bancarios).</p>`;
  } else {
    const ultimoPeriodo = situacion.periodos[0];
    const filas = (ultimoPeriodo.entidades || []).map(e => {
      const sit = e.situacion;
      const color = sit >= 5 ? 'var(--color-danger)' : sit >= 2 ? 'var(--color-warning, #8A5F13)' : 'inherit';
      return `<tr>
        <td style="font-size:12px">${window.sanitize(e.entidad || '—')}</td>
        <td style="font-size:12px;color:${color};font-weight:600">${sit ?? '—'}</td>
        <td class="monto" style="font-size:12px">${formatPeso((e.monto || 0) * 1000)}</td>
      </tr>`;
    }).join('');
    situacionHtml = `<p style="font-size:12px;color:var(--color-text-muted);margin-bottom:6px">Período ${window.sanitize(ultimoPeriodo.periodo || '')} — situación 1 (normal) a 6 (irrecuperable)</p>
      <table class="tabla" style="font-size:12px"><thead><tr><th>Entidad</th><th>Situación</th><th>Monto</th></tr></thead><tbody>${filas}</tbody></table>`;
  }

  // Cheques rechazados oficiales (Deudas/ChequesRechazados/{cuit})
  let rechazadosHtml;
  if (errores?.rechazados) {
    rechazadosHtml = `<p style="color:var(--color-danger);font-size:13px">No se pudo obtener el historial: ${window.sanitize(errores.rechazados)}</p>`;
  } else if (!rechazados || !rechazados.causales?.length) {
    rechazadosHtml = `<p style="font-size:13px;color:var(--color-text-muted)">Sin cheques rechazados registrados oficialmente.</p>`;
  } else {
    const filas = rechazados.causales.map(cs => (cs.entidades || []).map(e => (e.detalle || []).map(d => `<tr>
        <td style="font-size:12px">${window.sanitize(e.entidad || '—')}</td>
        <td style="font-size:12px">${window.sanitize(cs.causal || '—')}</td>
        <td class="monto" style="font-size:12px">${formatPeso(d.monto)}</td>
        <td style="font-size:12px">${formatFechaCorta(d.fechaRechazo)}</td>
        <td style="font-size:12px">${d.procesoJud ? 'Sí' : 'No'}</td>
      </tr>`).join('')).join('')).join('');
    rechazadosHtml = `<table class="tabla" style="font-size:12px"><thead><tr><th>Entidad</th><th>Causal</th><th>Monto</th><th>Fecha</th><th>Proceso jud.</th></tr></thead><tbody>${filas}</tbody></table>`;
  }

  return `
    <h3 style="font-size:13px;margin:0 0 8px">${window.sanitize(cliente.nombre)} — CUIT ${window.sanitize(cliente.cuit)}</h3>
    <div style="margin-bottom:16px">
      <h4 style="font-size:12px;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:6px">Situación crediticia oficial</h4>
      ${situacionHtml}
    </div>
    <div>
      <h4 style="font-size:12px;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:6px">Cheques rechazados oficiales (histórico completo del sistema)</h4>
      ${rechazadosHtml}
    </div>`;
}

function abrirModalBcra() {
  document.getElementById('modal-bcra-cliente').style.display = 'flex';
}

function cerrarModalBcra() {
  document.getElementById('modal-bcra-cliente').style.display = 'none';
}

// ── Consulta libre BCRA — por CUIT o por banco+número, sin requerir que ──
// el cliente/cheque exista ya en el sistema.
let _entidadesBcraLibre = null;

async function cargarEntidadesBcraLibre() {
  const select = document.getElementById('bcra-libre-entidad');
  if (!select) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/bcra?accion=entidades', { headers: { Authorization: `Bearer ${token}` } });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error || 'Error al listar bancos');
    _entidadesBcraLibre = json.entidades || [];
    select.innerHTML = '<option value="">Banco...</option>' +
      _entidadesBcraLibre.map(e => `<option value="${e.codigoEntidad}">${window.sanitize(e.denominacion || '')}</option>`).join('');
  } catch (e) {
    console.error('[riesgo-cheques] entidades BCRA:', e);
    select.innerHTML = '<option value="">No se pudo cargar el listado</option>';
  }
}

async function verificarBcraLibre() {
  const cuitRaw = document.getElementById('cuit-libre').value;
  const cuit = (cuitRaw || '').replace(/\D/g, '');
  if (cuit.length !== 11) {
    mostrarToast('Ingresá un CUIT/CUIL válido (11 dígitos)', 'err');
    return;
  }

  abrirModalBcra();
  const body = document.getElementById('bcra-cliente-body');
  body.innerHTML = 'Consultando al Banco Central...';

  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/bcra?accion=verificar-cliente&cuit=${encodeURIComponent(cuit)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error || 'Error al consultar BCRA');

    // Cliente "sintético" para el render: puede no existir en la base del sistema.
    const clienteExistente = todosClientesRiesgo.find(c => c.cuit === cuit);
    const pseudoCliente = clienteExistente || { nombre: 'Consulta libre', cuit };
    body.innerHTML = renderResultadoBcra(pseudoCliente, json);
  } catch (e) {
    console.error('[riesgo-cheques] verificarBcraLibre:', e);
    body.innerHTML = `<div class="alerta-inline warning">No se pudo consultar al Banco Central. Probá de nuevo en un momento.</div>`;
  }
}

async function verificarDenunciaLibre() {
  const codigoEntidad = document.getElementById('bcra-libre-entidad').value;
  const numeroCheque = document.getElementById('bcra-libre-numero').value.trim();
  const resultado = document.getElementById('bcra-libre-denuncia-resultado');

  if (!codigoEntidad || !numeroCheque) {
    resultado.innerHTML = `<div class="alerta-inline warning">Elegí el banco e ingresá el número de cheque.</div>`;
    return;
  }

  resultado.innerHTML = 'Consultando al Banco Central...';
  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/bcra?accion=denunciado&codigoEntidad=${encodeURIComponent(codigoEntidad)}&numeroCheque=${encodeURIComponent(numeroCheque)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error || 'Error al consultar BCRA');

    if (!json.encontrado) {
      resultado.innerHTML = `<div class="alerta-inline" style="background:var(--color-success-bg,#E2F0E5);color:var(--color-success,#487050)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Sin denuncia registrada para este cheque.</div>`;
    } else {
      const r = json.resultado || {};
      resultado.innerHTML = `<div class="alerta-inline warning"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><strong>Cheque denunciado.</strong> Motivo: ${window.sanitize(r.motivo || r.denunciado || 'ver detalle')}${r.fecha ? ` — ${formatFechaCorta(r.fecha)}` : ''}</div>`;
    }
  } catch (e) {
    console.error('[riesgo-cheques] verificarDenunciaLibre:', e);
    resultado.innerHTML = `<div class="alerta-inline warning">No se pudo consultar al Banco Central. Probá de nuevo en un momento.</div>`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function formatPeso(n) {
  return '$' + (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFechaCorta(f) {
  if (!f) return '—';
  return new Date(f).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// Exponer funciones al scope global (requerido por los onclick del HTML)
window.recargarRiesgoCheques = recargarRiesgoCheques;
window.filtrarRiesgoCheques = filtrarRiesgoCheques;
window.verChequesDeCliente = verChequesDeCliente;
window.verificarBcraCliente = verificarBcraCliente;
window.cerrarModalBcra = cerrarModalBcra;
window.verificarBcraLibre = verificarBcraLibre;
window.verificarDenunciaLibre = verificarDenunciaLibre;
window.verScoreCliente = verScoreCliente;
window.cerrarModalScore = cerrarModalScore;
window.recalcularScore = recalcularScore;
window.ofrecerPlanPago = ofrecerPlanPago;
