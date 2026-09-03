/* admin/js/gastos-generales.js — CRUD de /api/gastos-generales → tabla
   gastos_generales (migración 479). Gastos fijos del negocio (alquiler,
   sueldos, servicios, impuestos, otros) que se descuentan del Margen Bruto
   en Reportes → Finanzas para calcular la Ganancia Neta real del período. */

const ROLES_LECTURA_GASTOS  = ['dueno', 'admin', 'contador'];
const ROLES_ESCRITURA_GASTOS = ['dueno', 'admin', 'contador'];

const CATEGORIA_LABEL = {
  alquiler: 'Alquiler', sueldos: 'Sueldos', servicios: 'Servicios',
  impuestos: 'Impuestos', otros: 'Otros',
};

let gastosData      = [];   // filas crudas de /api/gastos-generales
let modalGastoId     = null; // null = nuevo, uuid = edición
let puedeEscribir    = false;

// ── Paginación cliente ("Cargar más") ───────────────────────────────────────
const GASTOS_MOSTRAR_INICIAL = 20;
const GASTOS_PAGINA          = 40;
let _gastosVisibles = GASTOS_MOSTRAR_INICIAL;
let _gastosListaActual = [];

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

  if (!ROLES_LECTURA_GASTOS.includes(user.rol)) {
    document.getElementById('contenido-gastos').classList.add('hidden');
    document.getElementById('sin-permiso').classList.remove('hidden');
    return;
  }

  puedeEscribir = ROLES_ESCRITURA_GASTOS.includes(user.rol);
  if (!puedeEscribir) {
    const btn = document.getElementById('btn-nuevo-gasto');
    if (btn) btn.classList.add('hidden');
  }

  await cargarGastos();
});

// ── Carga principal ───────────────────────────────────────────────────────
async function cargarGastos() {
  const tbody = document.getElementById('tbody-gastos');
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--color-text-light);">Cargando…</td></tr>`;
  document.getElementById('kpis-grid').innerHTML = '';

  try {
    const token = await getFreshToken();
    const categoria = document.getElementById('filtro-categoria').value;
    const activo = document.getElementById('filtro-estado').value;
    const qs = new URLSearchParams();
    if (categoria) qs.set('categoria', categoria);
    if (activo) qs.set('activo', activo);

    const r = await fetch(`/api/gastos-generales?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al cargar los gastos');

    gastosData = data || [];
    _gastosVisibles = GASTOS_MOSTRAR_INICIAL;
    renderKpis(gastosData);
    filtrarYRenderizar();
  } catch (e) {
    console.error('[GASTOS-GENERALES] cargar:', e);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--color-danger);">No se pudieron cargar los gastos generales.</td></tr>`;
    window.toast('No se pudieron cargar los gastos generales', 'error');
  }
}

// ── KPIs (resumen de lo cargado en pantalla, con los filtros aplicados) ───
function renderKpis(filas) {
  const cont = document.getElementById('kpis-grid');

  const total       = filas.length;
  const activos      = filas.filter(f => f.activo).length;
  const recurrentes = filas.filter(f => f.activo && f.recurrente).length;
  const montoTotal  = filas.filter(f => f.activo).reduce((s, f) => s + (Number(f.monto) || 0), 0);

  cont.className = 'franja-resumen-sololectura';
  cont.innerHTML = `
    <div class="dato-sello" title="Gastos cargados con los filtros actuales"><div class="dato-sello-valor">${total}</div><div class="dato-sello-etiqueta">Gastos</div></div>
    <div class="dato-sello" data-tono="verde" title="Suman al cálculo de Ganancia Neta"><div class="dato-sello-valor">${activos}</div><div class="dato-sello-etiqueta">Activos</div></div>
    <div class="dato-sello" title="Marcados como gasto fijo — no se vuelven a cargar solos, es solo una etiqueta"><div class="dato-sello-valor">${recurrentes}</div><div class="dato-sello-etiqueta">Recurrentes</div></div>
    <div class="dato-sello" data-tono="ambar" title="Suma de los gastos activos listados"><div class="dato-sello-valor">${fmtPeso(montoTotal)}</div><div class="dato-sello-etiqueta">Monto total</div></div>
  `;
}

// ── Filtro de texto (client-side, sobre lo ya cargado) ──────────────────────
function filtrarYRenderizar() {
  const b = document.getElementById('filtro-busqueda').value.trim().toLowerCase();
  if (!b) { _gastosVisibles = GASTOS_MOSTRAR_INICIAL; renderTabla(gastosData); return; }
  const filtradas = gastosData.filter(g => {
    return (g.descripcion || '').toLowerCase().includes(b) ||
      (CATEGORIA_LABEL[g.categoria] || '').toLowerCase().includes(b) ||
      (g.notas || '').toLowerCase().includes(b);
  });
  _gastosVisibles = GASTOS_MOSTRAR_INICIAL;
  renderTabla(filtradas);
}

// ── Tabla ─────────────────────────────────────────────────────────────────
function renderTabla(filas) {
  const tbody = document.getElementById('tbody-gastos');
  _gastosListaActual = filas;

  if (!filas.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--color-text-light);">Sin gastos generales cargados</td></tr>`;
    return;
  }

  const total    = filas.length;
  const visibles = filas.slice(0, _gastosVisibles);

  const filasHtml = visibles.map(g => {
    const categoria = `<span class="chip chip-cat-${g.categoria}">${CATEGORIA_LABEL[g.categoria] || g.categoria}</span>`;
    const recurrente = g.recurrente
      ? `<span class="chip chip-recurrente">Recurrente</span>`
      : '<span style="color:var(--color-text-light);">—</span>';
    const estado = g.activo
      ? `<span class="chip chip-activo">Activo</span>`
      : `<span class="chip chip-inactivo">Inactivo</span>`;

    const filaClase = !g.activo ? 'gasto-inactivo' : '';

    const accionesEscritura = puedeEscribir ? `
      <button type="button" onclick="abrirModalEditar('${g.id}')">Editar</button>
      <button type="button" class="danger" onclick="btnAsyncClick(this, () => eliminarGasto('${g.id}'), {confirm:true, confirmMsg:'¿Eliminar este gasto general?'})">Eliminar</button>
    ` : '';

    return `<tr class="${filaClase}${puedeEscribir ? ' fila-clickeable' : ''}" ${puedeEscribir ? `onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalEditar('${g.id}')"` : ''}>
      <td style="font-size:12px;">${window.formatFecha ? window.formatFecha(g.fecha) : g.fecha}</td>
      <td>${categoria}</td>
      <td><strong>${window.sanitize(g.descripcion)}</strong>${g.notas ? `<div style="font-size:11px;color:var(--color-text-light);">${window.sanitize(g.notas)}</div>` : ''}</td>
      <td>${fmtPeso(g.monto)}</td>
      <td>${recurrente}</td>
      <td>${estado}</td>
      <td class="col-sticky-end"><div class="fila-acciones">${accionesEscritura || '—'}</div></td>
    </tr>`;
  }).join('');

  const pie = piePaginacionHTML(7, total, _gastosVisibles, GASTOS_MOSTRAR_INICIAL, GASTOS_PAGINA, 'cargarMasGastos', 'colapsarGastos');
  tbody.innerHTML = filasHtml + pie;
}

function cargarMasGastos() {
  _gastosVisibles = Math.min(_gastosListaActual.length, _gastosVisibles + GASTOS_PAGINA);
  renderTabla(_gastosListaActual);
}
function colapsarGastos() {
  _gastosVisibles = GASTOS_MOSTRAR_INICIAL;
  renderTabla(_gastosListaActual);
}
window.cargarMasGastos = cargarMasGastos;
window.colapsarGastos  = colapsarGastos;

// ── Modal: alta / edición ────────────────────────────────────────────────
function abrirModalNuevo() {
  if (!puedeEscribir) return;
  modalGastoId = null;
  document.getElementById('modal-gasto-titulo').textContent = 'Nuevo gasto';

  document.getElementById('fg-descripcion').value = '';
  document.getElementById('fg-categoria').value = 'alquiler';
  document.getElementById('fg-monto').value = '';
  document.getElementById('fg-fecha').value = fmtFechaInput(new Date());
  document.getElementById('fg-recurrente').checked = false;
  document.getElementById('fg-notas').value = '';
  document.getElementById('fg-activo').checked = true;

  abrirModalGasto();
}

function abrirModalEditar(id) {
  if (!puedeEscribir) return;
  const g = gastosData.find(x => x.id === id);
  if (!g) return;
  modalGastoId = id;
  document.getElementById('modal-gasto-titulo').textContent = `Editar: ${g.descripcion}`;

  document.getElementById('fg-descripcion').value = g.descripcion || '';
  document.getElementById('fg-categoria').value = g.categoria || 'alquiler';
  document.getElementById('fg-monto').value = g.monto ?? '';
  document.getElementById('fg-fecha').value = g.fecha || '';
  document.getElementById('fg-recurrente').checked = !!g.recurrente;
  document.getElementById('fg-notas').value = g.notas || '';
  document.getElementById('fg-activo').checked = !!g.activo;

  abrirModalGasto();
}

function abrirModalGasto() {
  limpiarValidacionGastos();
  document.getElementById('modal-gasto-backdrop').style.display = 'block';
  document.getElementById('modal-gasto').style.display = 'flex';
  document.getElementById('modal-gasto').classList.add('open');
}

function cerrarModalGasto() {
  document.getElementById('modal-gasto-backdrop').style.display = 'none';
  document.getElementById('modal-gasto').classList.remove('open');
}

// ── Validación inline de campos ────────────────────────────────────────
function marcarCampoInvalido(id, mensaje) {
  const campo = document.getElementById(id);
  const msg = document.getElementById(`${id}-error`);
  if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.focus(); }
  if (msg) { msg.textContent = mensaje; msg.style.display = 'block'; }
}
function limpiarValidacionGastos() {
  ['fg-descripcion', 'fg-monto', 'fg-fecha'].forEach(id => {
    const campo = document.getElementById(id);
    const msg = document.getElementById(`${id}-error`);
    if (campo) campo.removeAttribute('aria-invalid');
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  });
}

async function guardarGasto() {
  limpiarValidacionGastos();
  const descripcion = document.getElementById('fg-descripcion').value.trim();
  const categoria = document.getElementById('fg-categoria').value;
  const monto = document.getElementById('fg-monto').value;
  const fecha = document.getElementById('fg-fecha').value;
  const recurrente = document.getElementById('fg-recurrente').checked;
  const notas = document.getElementById('fg-notas').value.trim();
  const activo = document.getElementById('fg-activo').checked;

  if (!descripcion) { marcarCampoInvalido('fg-descripcion', 'Ingresá una descripción'); window.toast('Ingresá una descripción', 'error'); return; }
  if (monto === '' || Number(monto) < 0) { marcarCampoInvalido('fg-monto', 'Ingresá un monto válido'); window.toast('Ingresá un monto válido', 'error'); return; }
  if (!fecha) { marcarCampoInvalido('fg-fecha', 'Ingresá una fecha'); window.toast('Ingresá una fecha', 'error'); return; }

  const body = {
    categoria,
    descripcion,
    monto: Number(monto),
    fecha,
    recurrente,
    notas: notas || null,
    activo,
  };

  try {
    const token = await getFreshToken();
    const url = modalGastoId ? `/api/gastos-generales?id=${modalGastoId}` : '/api/gastos-generales';
    const method = modalGastoId ? 'PATCH' : 'POST';

    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al guardar el gasto');

    window.toast(modalGastoId ? 'Gasto actualizado' : 'Gasto creado', 'ok');
    cerrarModalGasto();
    await cargarGastos();
  } catch (e) {
    console.error('[GASTOS-GENERALES] guardar:', e);
    window.toast('No se pudo guardar el gasto', 'error');
  }
}

// ── Eliminar (soft-delete) ──────────────────────────────────────────────
async function eliminarGasto(id) {
  try {
    const token = await getFreshToken();
    const r = await fetch(`/api/gastos-generales?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al eliminar el gasto');
    window.toast('Gasto eliminado', 'ok');
    await cargarGastos();
  } catch (e) {
    console.error('[GASTOS-GENERALES] eliminar:', e);
    window.toast('No se pudo eliminar el gasto', 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtPeso(n) {
  return '$' + Math.round(+n || 0).toLocaleString('es-AR');
}
// FIX (auditoría etapa 3 — Gastos generales): `d.toISOString().slice(0,10)`
// convierte a UTC antes de recortar la fecha. Para Argentina (UTC-3), cargar
// un gasto entre las 21:00 y las 23:59 hora local hacía que este campo se
// autocompletara con la fecha de MAÑANA (el mismo bug sistémico ya
// documentado y corregido en otros módulos — ver fechaLocalISO() en
// facturacion.js). Se usa el mismo criterio acá: componer la fecha con los
// getters locales (getFullYear/getMonth/getDate), sin pasar por UTC.
function fmtFechaInput(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
async function getFreshToken() {
  const { data: { session } } = await window.authCtx.sb.auth.getSession();
  return session?.access_token || '';
}

// Exponer para onclick inline
window.abrirModalNuevo   = abrirModalNuevo;
window.abrirModalEditar  = abrirModalEditar;
window.cerrarModalGasto  = cerrarModalGasto;
window.guardarGasto      = guardarGasto;
window.eliminarGasto     = eliminarGasto;
window.cargarGastos      = cargarGastos;
window.filtrarYRenderizar = filtrarYRenderizar;
