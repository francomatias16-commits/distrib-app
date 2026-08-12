/* admin/js/conciliacion-bancaria.js — Etapa 3 (Cobranzas y riesgo financiero)
   CRUD de /api/conciliacion-bancaria → tablas conciliacion_bancaria_lotes /
   conciliacion_bancaria_movimientos (248). Matching por tolerancia fecha/monto
   resuelto en SQL (conciliacion_buscar_candidatos); esta pantalla solo importa
   el CSV y confirma/deshace/descarta los matches. */

const ROLES_LECTURA_CONCILIACION  = ['dueno', 'admin', 'contador'];
const ROLES_ESCRITURA_CONCILIACION = ['dueno', 'admin', 'contador'];

let lotesData      = [];
let loteActivoId    = null;
let movimientosData = [];
let puedeEscribir   = false;

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady;

  const hoy = new Date();
  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  const user = window.authCtx?.perfil;
  if (!user) return;
  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;

  if (!ROLES_LECTURA_CONCILIACION.includes(user.rol)) {
    document.getElementById('contenido-conciliacion').classList.add('hidden');
    document.getElementById('sin-permiso').classList.remove('hidden');
    return;
  }

  puedeEscribir = ROLES_ESCRITURA_CONCILIACION.includes(user.rol);
  if (!puedeEscribir) {
    document.getElementById('wrap-import').classList.add('hidden');
  }

  configurarDropZone();
  await cargarLotes();
});

// ── Drag & drop del CSV ─────────────────────────────────────────────────
function configurarDropZone() {
  const zone = document.getElementById('drop-zone');
  ['dragenter', 'dragover'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('dragover'); })
  );
  zone.addEventListener('drop', e => {
    const file = e.dataTransfer.files?.[0];
    if (file) onArchivoSeleccionado(file);
  });
}

// ── Parseo e importación del CSV ────────────────────────────────────────
async function onArchivoSeleccionado(file) {
  if (!file) return;
  if (!window.Papa) {
    console.error('[CONCILIACION] PapaParse no está cargado');
    window.toast('No se pudo procesar el archivo. Recargá la página y probá de nuevo.', 'error');
    return;
  }

  try {
    const texto = await file.text();
    const { data: filas } = window.Papa.parse(texto, { header: true, skipEmptyLines: true });

    const movimientos = filas.map(mapearFilaExtracto).filter(Boolean);

    if (!movimientos.length) {
      window.toast('El archivo no tiene filas para importar', 'error');
      return;
    }

    const token = await getFreshToken();
    const r = await fetch('/api/conciliacion-bancaria', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nombre_archivo: file.name, movimientos }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al importar el extracto');

    window.toast(`Importado: ${movimientos.length} movimientos`, 'ok');
    document.getElementById('input-csv').value = '';
    await cargarLotes();
    await seleccionarLote(data.id);
  } catch (e) {
    console.error('[CONCILIACION] importar:', e);
    window.toast('No se pudo importar el extracto. Probá de nuevo.', 'error');
  }
}

function normalizarTipo(tipoCrudo, montoCrudo) {
  const t = String(tipoCrudo || '').trim().toLowerCase();
  if (['credito', 'crédito', 'haber', 'deposito', 'depósito'].includes(t)) return 'credito';
  if (['debito', 'débito', 'debe', 'extraccion', 'extracción'].includes(t)) return 'debito';
  // Si no vino columna tipo, se infiere del signo del monto (negativo = débito).
  return parsearMontoAR(montoCrudo) < 0 ? 'debito' : 'credito';
}

// Busca un campo en la fila probando varias claves posibles (case/acento-insensitive).
// Los headers de extractos bancarios varían mucho entre bancos y entre exportaciones
// del mismo banco (CSV vs XLS-convertido-a-CSV), así que se compara normalizando.
function buscarCampo(fila, claves) {
  const normalizado = s => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // saca acentos: "débito" -> "debito"
  const mapaClaves = {};
  for (const k of Object.keys(fila)) mapaClaves[normalizado(k)] = fila[k];
  for (const c of claves) {
    const v = mapaClaves[normalizado(c)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Fecha: soporta AAAA-MM-DD (ya viene bien), DD/MM/AAAA y DD-MM-AAAA
// (formato estándar de los extractos de bancos argentinos), y DD/MM/AA.
function parsearFechaFlexible(str) {
  const s = String(str || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // ya está en ISO

  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return s; // no reconocido: se manda tal cual, la validación del backend lo va a rechazar con mensaje claro
  let [, d, mo, y] = m;
  if (y.length === 2) y = (Number(y) <= 69 ? '20' : '19') + y; // pivote estándar para años de 2 dígitos
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Monto: soporta formato US (1234.56) y formato argentino (1.234,56 / 1234,56).
// Se distingue mirando cuál separador aparece último en el string.
function parsearMontoAR(valor) {
  let s = String(valor ?? '').trim();
  if (!s) return 0;
  const negativoConParentesis = /^\(.*\)$/.test(s); // algunos extractos marcan negativos como "(1.234,56)"
  s = s.replace(/[()$\s]/g, '').replace(/ARS|AR\$/gi, '');

  const posComa = s.lastIndexOf(',');
  const posPunto = s.lastIndexOf('.');
  if (posComa > posPunto) {
    // formato AR: punto = miles, coma = decimal
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (posPunto > posComa && posComa !== -1) {
    // formato US con separador de miles: coma = miles, punto = decimal
    s = s.replace(/,/g, '');
  }
  // si solo hay un tipo de separador y una sola vez, Number() ya lo interpreta bien tal cual

  const n = Number(s);
  if (Number.isNaN(n)) return 0;
  return negativoConParentesis ? -Math.abs(n) : n;
}

// Mapea una fila del CSV parseado a { fecha, descripcion, monto, tipo }.
// Soporta dos layouts:
//   a) una columna de monto + una columna de tipo (o signo)
//   b) columnas separadas Débito / Crédito (patrón típico de Nación/Provincia
//      y de la mayoría de los extractos exportados desde home banking AR)
function mapearFilaExtracto(f) {
  const fecha = parsearFechaFlexible(
    buscarCampo(f, ['fecha', 'fecha valor', 'fecha operacion', 'fecha operación'])
  );
  const descripcion = buscarCampo(f, ['descripcion', 'descripción', 'concepto', 'detalle', 'leyenda']);

  const debito = buscarCampo(f, ['debito', 'débito', 'debe']);
  const credito = buscarCampo(f, ['credito', 'crédito', 'haber']);

  let monto, tipo;
  if (debito || credito) {
    // Layout de columnas separadas: la que tenga valor manda.
    if (parsearMontoAR(debito) !== 0) {
      monto = Math.abs(parsearMontoAR(debito));
      tipo = 'debito';
    } else {
      monto = Math.abs(parsearMontoAR(credito));
      tipo = 'credito';
    }
  } else {
    // Layout de una sola columna de monto (+ tipo o signo).
    const montoCrudo = buscarCampo(f, ['monto', 'importe']);
    const tipoCrudo = buscarCampo(f, ['tipo']);
    monto = Math.abs(parsearMontoAR(montoCrudo));
    tipo = normalizarTipo(tipoCrudo, montoCrudo);
  }

  if (!fecha && !descripcion && !monto) return null; // fila vacía / de encabezado repetido
  return { fecha, descripcion, monto, tipo };
}

// ── Lotes ─────────────────────────────────────────────────────────────────
async function cargarLotes() {
  const cont = document.getElementById('lista-lotes');
  cont.innerHTML = `<div style="padding:16px;color:var(--color-text-light);font-size:13px;">Cargando…</div>`;
  try {
    const token = await getFreshToken();
    const r = await fetch('/api/conciliacion-bancaria', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al cargar los extractos');

    lotesData = data || [];
    renderLotes();
  } catch (e) {
    console.error('[CONCILIACION] lotes:', e);
    cont.innerHTML = `<div style="padding:16px;color:var(--color-danger);font-size:13px;">No se pudieron cargar los extractos. Probá de nuevo en un momento.</div>`;
  }
}

function renderLotes() {
  const cont = document.getElementById('lista-lotes');
  if (!lotesData.length) {
    cont.innerHTML = `<div style="padding:16px;color:var(--color-text-light);font-size:13px;">Todavía no importaste ningún extracto.</div>`;
    return;
  }

  cont.innerHTML = lotesData.map(l => {
    const pct = l.cantidad_movimientos ? Math.round((l.cantidad_conciliados / l.cantidad_movimientos) * 100) : 0;
    return `
      <div class="lote-item ${l.id === loteActivoId ? 'activo' : ''}" data-testid="lote-item" data-id="${l.id}" onclick="seleccionarLote('${l.id}')">
        <div class="lote-nombre">${window.sanitize(l.nombre_archivo)}</div>
        <div class="lote-meta">${l.cantidad_conciliados}/${l.cantidad_movimientos} conciliados · ${fmtFecha(l.created_at)}</div>
        <div class="lote-progreso"><div class="lote-progreso-fill" style="width:${pct}%"></div></div>
        ${puedeEscribir ? `<button type="button" class="lote-btn-eliminar" title="Eliminar extracto" onclick="event.stopPropagation();eliminarLote('${l.id}')" style="margin-top:6px;background:none;border:none;color:var(--color-danger,#B02A37);font-size:12px;cursor:pointer;padding:0">Eliminar</button>` : ''}
      </div>`;
  }).join('');
}

// ── Eliminar lote (y sus movimientos, en cascada del lado del servidor) ────
async function eliminarLote(loteId) {
  const lote = lotesData.find(l => l.id === loteId);
  const nombre = lote ? lote.nombre_archivo : 'este extracto';
  const ok = await (window.confirmar
    ? window.confirmar(`¿Eliminar "${nombre}"? Se van a borrar también todos sus movimientos y conciliaciones. Esta acción no se puede deshacer.`, { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' })
    : Promise.resolve(confirm(`¿Eliminar "${nombre}"? Esta acción no se puede deshacer.`)));
  if (!ok) return;

  try {
    const token = await getFreshToken();
    const r = await fetch(`/api/conciliacion-bancaria?lote_id=${loteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) throw new Error(data?.error || 'No se pudo eliminar el extracto');

    if (loteActivoId === loteId) {
      loteActivoId = null;
      document.getElementById('tbody-movimientos').innerHTML = '';
      document.getElementById('titulo-movimientos').textContent = 'Movimientos';
      document.getElementById('kpis-grid').innerHTML = '';
      document.getElementById('btn-auto-conciliar').style.display = 'none';
    }

    window.toast('Extracto eliminado', 'ok');
    await cargarLotes();
  } catch (e) {
    console.error('[CONCILIACION] eliminarLote:', e);
    window.toast(e.message || 'No se pudo eliminar el extracto.', 'error');
  }
}
window.eliminarLote = eliminarLote;

async function seleccionarLote(loteId) {
  loteActivoId = loteId;
  renderLotes();
  document.getElementById('btn-auto-conciliar').style.display = puedeEscribir ? 'inline-flex' : 'none';
  await cargarMovimientos();
}
window.seleccionarLote = seleccionarLote;

// ── Movimientos + candidatos ────────────────────────────────────────────
async function cargarMovimientos() {
  if (!loteActivoId) return;
  const tbody = document.getElementById('tbody-movimientos');
  const lote = lotesData.find(l => l.id === loteActivoId);
  document.getElementById('titulo-movimientos').textContent = lote ? lote.nombre_archivo : 'Movimientos';
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--color-text-light);">Cargando…</td></tr>`;
  document.getElementById('kpis-grid').innerHTML = '';

  try {
    const token = await getFreshToken();
    const estado = document.getElementById('filtro-estado-mov').value;
    const qs = new URLSearchParams({ lote_id: loteActivoId });
    if (estado) qs.set('estado', estado);

    const r = await fetch(`/api/conciliacion-bancaria?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al cargar los movimientos');

    movimientosData = data || [];
    renderKpis(movimientosData);
    renderMovimientos();
  } catch (e) {
    console.error('[CONCILIACION] movimientos:', e);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--color-danger);">No se pudieron cargar los movimientos. Probá de nuevo en un momento.</td></tr>`;
  }
}
window.cargarMovimientos = cargarMovimientos;

function renderKpis(filas) {
  const cont = document.getElementById('kpis-grid');
  const total = filas.length;
  const conciliados = filas.filter(f => f.estado === 'conciliado').length;
  const pendientes = filas.filter(f => f.estado === 'pendiente').length;
  const sinCandidatos = filas.filter(f => f.estado === 'pendiente' && !(f.candidatos || []).length).length;

  cont.className = 'franja-resumen-sololectura';
  cont.innerHTML = [
    { label: 'Movimientos', valor: total, sub: 'Del extracto bancario importado' },
    { label: 'Conciliados', valor: conciliados, sub: 'Ya vinculados a un comprobante' },
    { label: 'Pendientes', valor: pendientes, sub: 'Todavía sin conciliar' },
    { label: 'Sin candidato', valor: sinCandidatos, sub: 'No se encontró comprobante posible' },
  ].map((k, i) => `${i > 0 ? '<span class="sep">·</span>' : ''}<span title="${k.sub}">${k.label}: <strong>${k.valor}</strong></span>`).join('');
}

function renderMovimientos() {
  const tbody = document.getElementById('tbody-movimientos');
  if (!movimientosData.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--color-text-light);">No hay movimientos con ese filtro.</td></tr>`;
    return;
  }

  tbody.innerHTML = movimientosData.map(m => `
    <tr data-testid="mov-fila" data-id="${m.id}">
      <td>${fmtFecha(m.fecha)}</td>
      <td>${window.sanitize(m.descripcion || '—')}</td>
      <td><span class="badge-tipo ${m.tipo}">${m.tipo === 'credito' ? 'Crédito' : 'Débito'}</span></td>
      <td>${fmtPeso(m.monto)}</td>
      <td><span class="badge-estado ${m.estado}">${capitalizar(m.estado)}</span></td>
      <td>${renderCandidatosOMatch(m)}</td>
      <td class="fila-acciones col-sticky-end">${renderAcciones(m)}</td>
    </tr>
  `).join('');
}

function renderCandidatosOMatch(m) {
  if (m.estado === 'conciliado' && m.cobros) {
    const c = m.cobros;
    return `<div style="font-size:12px;">Cobro ${fmtFecha(c.fecha)} · ${fmtPeso(c.monto)}${c.clientes?.razon_social ? ` · ${window.sanitize(c.clientes.razon_social)}` : ''}</div>`;
  }
  if (m.estado !== 'pendiente') return '<span class="sin-candidatos">—</span>';

  const candidatos = m.candidatos || [];
  if (!candidatos.length) return '<span class="sin-candidatos">Sin candidatos dentro de tolerancia</span>';

  return `<div class="candidatos-list">${candidatos.slice(0, 4).map(c => `
    <div class="candidato-item">
      <span>${fmtFecha(c.fecha)} · ${fmtPeso(c.monto)}${c.cliente_nombre ? ` · ${window.sanitize(c.cliente_nombre)}` : ''}
        <span class="score ${claseScore(c.score)}"> (${Math.round(c.score)})</span>
      </span>
      ${puedeEscribir ? `<button type="button" onclick="btnAsyncClick(this, () => confirmarMatch('${m.id}','${c.cobro_id}'))">Confirmar</button>` : ''}
    </div>
  `).join('')}</div>`;
}

function claseScore(score) {
  if (score >= 90) return 'alto';
  if (score >= 60) return 'medio';
  return 'bajo';
}

function renderAcciones(m) {
  if (!puedeEscribir) return '';
  if (m.estado === 'conciliado') {
    return `<button type="button" onclick="btnAsyncClick(this, () => deshacerMatch('${m.id}'))">Deshacer</button>`;
  }
  if (m.estado === 'pendiente') {
    return `<button type="button" class="danger" onclick="btnAsyncClick(this, () => descartarMovimiento('${m.id}'))">Descartar</button>`;
  }
  return '';
}

// ── Acciones ─────────────────────────────────────────────────────────────
async function confirmarMatch(movimiento_id, cobro_id) {
  try {
    const token = await getFreshToken();
    const r = await fetch('/api/conciliacion-bancaria?_svc=confirmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ movimiento_id, cobro_id }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al confirmar el match');
    window.toast('Match confirmado', 'ok');
    await Promise.all([cargarLotes(), cargarMovimientos()]);
  } catch (e) {
    console.error('[CONCILIACION] confirmar:', e);
    window.toast('No se pudo confirmar el match. Probá de nuevo.', 'error');
  }
}
window.confirmarMatch = confirmarMatch;

async function deshacerMatch(movimiento_id) {
  try {
    const token = await getFreshToken();
    const r = await fetch('/api/conciliacion-bancaria?_svc=deshacer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ movimiento_id }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al deshacer el match');
    window.toast('Match deshecho', 'ok');
    await Promise.all([cargarLotes(), cargarMovimientos()]);
  } catch (e) {
    console.error('[CONCILIACION] deshacer:', e);
    window.toast('No se pudo deshacer el match. Probá de nuevo.', 'error');
  }
}
window.deshacerMatch = deshacerMatch;

async function descartarMovimiento(movimiento_id) {
  try {
    const token = await getFreshToken();
    const r = await fetch('/api/conciliacion-bancaria?_svc=descartar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ movimiento_id }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al descartar el movimiento');
    window.toast('Movimiento descartado', 'ok');
    await cargarMovimientos();
  } catch (e) {
    console.error('[CONCILIACION] descartar:', e);
    window.toast('No se pudo descartar el movimiento. Probá de nuevo.', 'error');
  }
}
window.descartarMovimiento = descartarMovimiento;

async function autoConciliar() {
  if (!loteActivoId) return;
  try {
    const token = await getFreshToken();
    const r = await fetch('/api/conciliacion-bancaria?_svc=auto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ lote_id: loteActivoId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al auto-conciliar');
    window.toast(`Auto-conciliados: ${data.conciliados}`, 'ok');
    await Promise.all([cargarLotes(), cargarMovimientos()]);
  } catch (e) {
    console.error('[CONCILIACION] auto:', e);
    window.toast('No se pudo auto-conciliar. Probá de nuevo.', 'error');
  }
}
window.autoConciliar = autoConciliar;

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtPeso(n) {
  return '$' + Math.round(+n || 0).toLocaleString('es-AR');
}
function fmtFecha(f) {
  if (!f) return '—';
  return new Date(f).toLocaleDateString('es-AR');
}
function capitalizar(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
async function getFreshToken() {
  const { data: { session } } = await window.authCtx.sb.auth.getSession();
  return session?.access_token || '';
}

window.onArchivoSeleccionado = onArchivoSeleccionado;
