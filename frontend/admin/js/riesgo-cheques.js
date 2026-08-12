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

async function cargarRiesgoCheques() {
  try {
    window.mostrarSkeletonTabla('tbody-riesgo-cheques', 5, 7);

    const [riesgoRes, alertasPorCliente, deudaPorCliente] = await Promise.all([
      _sb.rpc('fn_riesgo_cheques_lista'),
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
  panel.innerHTML = `<div class="alerta-inline warning">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <strong>${conAlerta.length} cliente${conAlerta.length > 1 ? 's' : ''} con cheques en cartera ${conAlerta.length > 1 ? 'tuvieron' : 'tuvo'} una caída reciente de score</strong> — revisá antes de depositar.
  </div>`;
}

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
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
      No hay clientes con cheques en cartera ni antecedentes de rechazo</div></td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(c => {
    const cat = SCORE_CATEGORIAS[c.categoria] || SCORE_CATEGORIAS.normal;
    const scoreHtml = `<span class="score-badge ${cat.cls}" title="${cat.label} · nivel de confianza ${Math.round(c.score)}/100">${cat.icono} ${Math.round(c.score)}</span>`;

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
        const color = pct >= 90 ? 'var(--color-danger)' : pct >= 60 ? 'var(--color-warning, #7A4A00)' : 'inherit';
        deudaHtml = `<span style="color:${color}">${formatPeso(c.deudaActual)} / ${formatPeso(c.limiteCredito)}</span><br><span style="font-size:11px;color:var(--color-text-muted)">${pct}% usado</span>`;
      } else {
        deudaHtml = formatPeso(c.deudaActual);
      }
    }

    const alertaHtml = c.ultimaAlerta
      ? `<span title="${window.sanitize(c.ultimaAlerta.mensaje || '')}" style="color:var(--color-danger);font-size:12px;cursor:help"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:2px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${formatFechaCorta(c.ultimaAlerta.created_at)}</span>`
      : '—';

    const bcraHtml = c.cuit
      ? `<button class="btn btn-sm btn-secondary" style="font-size:11px" onclick="verificarBcraCliente('${c.id}')">Verificar</button>`
      : `<span style="font-size:11px;color:var(--color-text-muted)" title="El cliente no tiene CUIT cargado">Sin CUIT</span>`;

    return `<tr>
      <td>${avatarCliente(c.nombre)}</td>
      <td>${scoreHtml}</td>
      <td class="monto">${carteraHtml}</td>
      <td class="monto">${rechazadosHtml}</td>
      <td>${deudaHtml}</td>
      <td>${alertaHtml}</td>
      <td>${bcraHtml}</td>
      <td class="col-sticky-end">
        <button class="btn btn-sm btn-secondary" style="font-size:11px" onclick="verChequesDeCliente(${escOnclickArg(c.nombre)})">Ver cheques</button>
      </td>
    </tr>`;
  }).join('');
}

// ── Filtros ──────────────────────────────────────────────────────────────
function filtrarRiesgoCheques() {
  const q = document.getElementById('buscar-riesgo').value.toLowerCase();
  const cat = document.getElementById('filtro-categoria-riesgo').value;
  const soloAlerta = document.getElementById('filtro-solo-alerta').checked;

  const filtrado = todosClientesRiesgo.filter(c => {
    if (q && !c.nombre.toLowerCase().includes(q)) return false;
    if (cat && c.categoria !== cat) return false;
    if (soloAlerta && !(c.rechazadosCantidad > 0 || c.ultimaAlerta)) return false;
    if (filtroTabRiesgo === 'en_riesgo' && !(['riesgo', 'bloqueado'].includes(c.categoria) && c.carteraCantidad > 0)) return false;
    return true;
  });
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
      const color = sit >= 5 ? 'var(--color-danger)' : sit >= 2 ? 'var(--color-warning, #7A4A00)' : 'inherit';
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
      resultado.innerHTML = `<div class="alerta-inline" style="background:var(--color-success-bg,#DCEDE3);color:var(--color-success,#17402F)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Sin denuncia registrada para este cheque.</div>`;
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
