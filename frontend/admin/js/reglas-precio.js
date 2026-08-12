/* admin/js/reglas-precio.js — Etapa 2 (Comercial y precios), ítem 1/3
   CRUD de /api/reglas-precio → tabla reglas_precio (243), resuelta en
   tiempo real por resolver_precios_cliente() en pedidos/POS. Esta pantalla
   solo administra las reglas; no hay motor de cálculo acá. */

const ROLES_LECTURA_REGLAS  = ['dueno', 'admin', 'contador', 'vendedor'];
const ROLES_ESCRITURA_REGLAS = ['dueno', 'admin', 'contador'];

let reglasData        = [];   // filas crudas de /api/reglas-precio
let productosCache     = [];  // {id, nombre, codigo}
let categoriasCache    = [];  // {id, nombre}
let zonasCache          = []; // {id, nombre}
let modalReglaId        = null; // null = nueva, uuid = edición
let puedeEscribir       = false;

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

  if (!ROLES_LECTURA_REGLAS.includes(user.rol)) {
    document.getElementById('contenido-reglas').classList.add('hidden');
    document.getElementById('sin-permiso').classList.remove('hidden');
    return;
  }

  puedeEscribir = ROLES_ESCRITURA_REGLAS.includes(user.rol);
  if (!puedeEscribir) {
    const btn = document.getElementById('btn-nueva-regla');
    if (btn) btn.classList.add('hidden');
  }

  await Promise.all([cargarCatalogos(), cargarReglas()]);
});

// ── Catálogos (consulta directa vía RLS, mismo patrón que clientes.js) ─────
async function cargarCatalogos() {
  try {
    const sb = window.authCtx.sb;
    const [{ data: productos }, { data: categorias }, { data: zonas }] = await Promise.all([
      sb.from('productos').select('id, nombre, codigo').eq('activo', true).order('nombre'),
      sb.from('categorias').select('id, nombre').order('nombre'),
      sb.from('zonas').select('id, nombre').eq('activa', true).order('nombre'),
    ]);
    productosCache  = productos  || [];
    categoriasCache = categorias || [];
    zonasCache       = zonas     || [];

    const selZona = document.getElementById('fr-zona_id');
    selZona.innerHTML = '<option value="">Todas las zonas</option>' +
      zonasCache.map(z => `<option value="${z.id}">${window.sanitize(z.nombre)}</option>`).join('');
  } catch (e) {
    console.error('[REGLAS-PRECIO] catálogos:', e);
  }
}

// ── Carga principal ───────────────────────────────────────────────────────
async function cargarReglas() {
  const tbody = document.getElementById('tbody-reglas');
  tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--color-text-light);">Cargando…</td></tr>`;
  document.getElementById('kpis-grid').innerHTML = '';

  try {
    const token = await getFreshToken();
    const estado = document.getElementById('filtro-estado').value;
    const qs = new URLSearchParams();
    if (estado) qs.set('activa', estado);

    const r = await fetch(`/api/reglas-precio?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al cargar las reglas');

    reglasData = data || [];
    renderKpis(reglasData);
    filtrarYRenderizar();
  } catch (e) {
    console.error('[REGLAS-PRECIO] cargar:', e);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--color-danger);">No se pudieron cargar los descuentos automáticos.</td></tr>`;
    window.toast('No se pudieron cargar los descuentos automáticos', 'error');
  }
}

// ── KPIs ──────────────────────────────────────────────────────────────────
function renderKpis(filas) {
  const cont = document.getElementById('kpis-grid');
  const hoy = fmtFechaInput(new Date());

  const total     = filas.length;
  const activas   = filas.filter(f => f.activa).length;
  const inactivas = total - activas;
  const vigentesHoy = filas.filter(f =>
    f.activa &&
    (!f.fecha_desde || f.fecha_desde <= hoy) &&
    (!f.fecha_hasta || f.fecha_hasta >= hoy)
  ).length;

  cont.className = 'franja-resumen-sololectura';
  cont.innerHTML = `
    <span title="Total de reglas configuradas">Reglas cargadas: <strong>${total}</strong></span>
    <span class="sep">·</span>
    <span title="Aplicándose en pedidos y catálogo">Activas: <strong>${activas}</strong></span>
    <span class="sep">·</span>
    <span title="Desactivadas, no afectan precios">Inactivas: <strong>${inactivas}</strong></span>
    <span class="sep">·</span>
    <span title="Dentro de su rango de fechas">Vigentes hoy: <strong>${vigentesHoy}</strong></span>
  `;
}

// ── Filtro de texto (client-side, sobre lo ya cargado) ──────────────────────
function filtrarYRenderizar() {
  const b = document.getElementById('filtro-busqueda').value.trim().toLowerCase();
  if (!b) { renderTabla(reglasData); return; }
  const filtradas = reglasData.filter(r => {
    return (r.nombre || '').toLowerCase().includes(b) ||
      (r.productos?.nombre || '').toLowerCase().includes(b) ||
      (r.categorias?.nombre || '').toLowerCase().includes(b) ||
      (r.zonas?.nombre || '').toLowerCase().includes(b);
  });
  renderTabla(filtradas);
}

// ── Tabla ─────────────────────────────────────────────────────────────────
function renderTabla(filas) {
  const tbody = document.getElementById('tbody-reglas');

  if (!filas.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--color-text-light);">Sin reglas de precio cargadas</td></tr>`;
    return;
  }

  const hoy = fmtFechaInput(new Date());

  tbody.innerHTML = filas.map(f => {
    const alcance = f.productos?.nombre
      ? `Producto: ${window.sanitize(f.productos.nombre)}${f.productos.codigo ? ' (' + window.sanitize(f.productos.codigo) + ')' : ''}`
      : f.categorias?.nombre
      ? `Categoría: ${window.sanitize(f.categorias.nombre)}`
      : `<span style="color:var(--color-text-light);">Todo el catálogo</span>`;

    const zona = f.zonas?.nombre ? window.sanitize(f.zonas.nombre) : '<span style="color:var(--color-text-light);">Todas</span>';

    const descuento = f.tipo_descuento === 'porcentaje'
      ? `<span class="chip chip-desc-pct">${fmtNum(f.valor)}% off</span>`
      : `<span class="chip chip-desc-fijo">${fmtPeso(f.valor)} fijo</span>`;

    const vencida = f.fecha_hasta && f.fecha_hasta < hoy;
    let vigencia = '—';
    if (f.fecha_desde || f.fecha_hasta) {
      vigencia = `${f.fecha_desde ? window.formatFecha ? window.formatFecha(f.fecha_desde) : f.fecha_desde : '…'} → ${f.fecha_hasta ? (window.formatFecha ? window.formatFecha(f.fecha_hasta) : f.fecha_hasta) : '…'}`;
      if (vencida) vigencia += ' <span class="chip chip-vencida">Vencida</span>';
    }

    const estado = f.activa
      ? `<span class="chip chip-activa">Activa</span>`
      : `<span class="chip chip-inactiva">Inactiva</span>`;

    const filaClase = !f.activa ? 'regla-inactiva' : (vencida ? 'regla-vencida' : '');

    const accionesEscritura = puedeEscribir ? `
      <button type="button" onclick="abrirModalEditar('${f.id}')">Editar</button>
      <button type="button" onclick="btnAsyncClick(this, () => toggleActiva('${f.id}', ${!f.activa}))">${f.activa ? 'Desactivar' : 'Activar'}</button>
      <button type="button" class="danger" onclick="btnAsyncClick(this, () => eliminarRegla('${f.id}'), {confirm:true, confirmMsg:'¿Eliminar esta regla de precio?'})">Eliminar</button>
    ` : '';

    return `<tr class="${filaClase}">
      <td><strong>${window.sanitize(f.nombre)}</strong></td>
      <td>${alcance}</td>
      <td>${zona}</td>
      <td>${fmtNum(f.cantidad_minima)}</td>
      <td>${descuento}</td>
      <td style="font-size:12px;">${vigencia}</td>
      <td>${f.prioridad ?? 0}</td>
      <td>${estado}</td>
      <td class="col-sticky-end"><div class="fila-acciones">${accionesEscritura || '—'}</div></td>
    </tr>`;
  }).join('');
}

// ── Modal: alta / edición ────────────────────────────────────────────────
function poblarSelectsAlcance() {
  const selProd = document.getElementById('fr-producto_id');
  selProd.innerHTML = '<option value="">Seleccioná un producto</option>' +
    productosCache.map(p => `<option value="${p.id}">${window.sanitize(p.nombre)}${p.codigo ? ' (' + window.sanitize(p.codigo) + ')' : ''}</option>`).join('');

  const selCat = document.getElementById('fr-categoria_id');
  selCat.innerHTML = '<option value="">Seleccioná una categoría</option>' +
    categoriasCache.map(c => `<option value="${c.id}">${window.sanitize(c.nombre)}</option>`).join('');
}

function cambiarAlcance() {
  const valor = document.querySelector('input[name="fr-alcance"]:checked')?.value || 'todo';
  document.getElementById('fr-producto_id').classList.toggle('hidden', valor !== 'producto');
  document.getElementById('fr-categoria_id').classList.toggle('hidden', valor !== 'categoria');
}

function actualizarPlaceholderValor() {
  const tipo = document.getElementById('fr-tipo_descuento').value;
  const input = document.getElementById('fr-valor');
  input.placeholder = tipo === 'porcentaje' ? 'Ej: 10 (= 10%)' : 'Ej: 850.00';
  if (tipo === 'precio_fijo') input.removeAttribute('max'); else input.setAttribute('max', '100');
}

function abrirModalNueva() {
  if (!puedeEscribir) return;
  modalReglaId = null;
  document.getElementById('modal-regla-titulo').textContent = 'Nueva regla de precio';

  poblarSelectsAlcance();
  document.querySelector('input[name="fr-alcance"][value="todo"]').checked = true;
  cambiarAlcance();

  document.getElementById('fr-nombre').value = '';
  document.getElementById('fr-producto_id').value = '';
  document.getElementById('fr-categoria_id').value = '';
  document.getElementById('fr-zona_id').value = '';
  document.getElementById('fr-cantidad_minima').value = '1';
  document.getElementById('fr-tipo_descuento').value = 'porcentaje';
  document.getElementById('fr-valor').value = '';
  document.getElementById('fr-fecha_desde').value = '';
  document.getElementById('fr-fecha_hasta').value = '';
  document.getElementById('fr-prioridad').value = '0';
  document.getElementById('fr-activa').checked = true;
  actualizarPlaceholderValor();

  abrirModalRegla();
}

function abrirModalEditar(id) {
  if (!puedeEscribir) return;
  const f = reglasData.find(r => r.id === id);
  if (!f) return;
  modalReglaId = id;
  document.getElementById('modal-regla-titulo').textContent = `Editar: ${f.nombre}`;

  poblarSelectsAlcance();

  const alcance = f.producto_id ? 'producto' : (f.categoria_id ? 'categoria' : 'todo');
  document.querySelector(`input[name="fr-alcance"][value="${alcance}"]`).checked = true;
  cambiarAlcance();

  document.getElementById('fr-nombre').value = f.nombre || '';
  document.getElementById('fr-producto_id').value = f.producto_id || '';
  document.getElementById('fr-categoria_id').value = f.categoria_id || '';
  document.getElementById('fr-zona_id').value = f.zona_id || '';
  document.getElementById('fr-cantidad_minima').value = f.cantidad_minima ?? 1;
  document.getElementById('fr-tipo_descuento').value = f.tipo_descuento || 'porcentaje';
  document.getElementById('fr-valor').value = f.valor ?? '';
  document.getElementById('fr-fecha_desde').value = f.fecha_desde || '';
  document.getElementById('fr-fecha_hasta').value = f.fecha_hasta || '';
  document.getElementById('fr-prioridad').value = f.prioridad ?? 0;
  document.getElementById('fr-activa').checked = !!f.activa;
  actualizarPlaceholderValor();

  abrirModalRegla();
}

function abrirModalRegla() {
  limpiarValidacionReglas();
  document.getElementById('modal-regla-backdrop').style.display = 'block';
  document.getElementById('modal-regla').style.display = 'flex';
  document.getElementById('modal-regla').classList.add('open');
}

function cerrarModalRegla() {
  document.getElementById('modal-regla-backdrop').style.display = 'none';
  document.getElementById('modal-regla').classList.remove('open');
}

// ── Validación inline de campos (aria-invalid + mensaje bajo el input) ─────
// Complementa el toast existente: el toast avisa QUE algo está mal, esto
// señala EN QUÉ campo, sin sacar el toast (no se toca comportamiento previo).
function marcarCampoInvalido(id, mensaje) {
  const campo = document.getElementById(id);
  const msg = document.getElementById(`${id}-error`);
  if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.focus(); }
  if (msg) { msg.textContent = mensaje; msg.style.display = 'block'; }
}
function limpiarValidacionReglas() {
  ['fr-nombre', 'fr-alcance', 'fr-valor', 'fr-fecha_hasta'].forEach(id => {
    const campo = document.getElementById(id);
    const msg = document.getElementById(`${id}-error`);
    if (campo) campo.removeAttribute('aria-invalid');
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  });
}

async function guardarRegla() {
  limpiarValidacionReglas();
  const alcance = document.querySelector('input[name="fr-alcance"]:checked')?.value || 'todo';
  const nombre = document.getElementById('fr-nombre').value.trim();
  const producto_id = alcance === 'producto' ? document.getElementById('fr-producto_id').value : '';
  const categoria_id = alcance === 'categoria' ? document.getElementById('fr-categoria_id').value : '';
  const zona_id = document.getElementById('fr-zona_id').value;
  const cantidad_minima = Number(document.getElementById('fr-cantidad_minima').value || 1);
  const tipo_descuento = document.getElementById('fr-tipo_descuento').value;
  const valor = document.getElementById('fr-valor').value;
  const fecha_desde = document.getElementById('fr-fecha_desde').value;
  const fecha_hasta = document.getElementById('fr-fecha_hasta').value;
  const prioridad = Number(document.getElementById('fr-prioridad').value || 0);
  const activa = document.getElementById('fr-activa').checked;

  if (!nombre) { marcarCampoInvalido('fr-nombre', 'Ingresá un nombre para la regla'); window.toast('Ingresá un nombre para la regla', 'error'); return; }
  if (alcance === 'producto' && !producto_id) { marcarCampoInvalido('fr-alcance', 'Seleccioná un producto'); window.toast('Seleccioná un producto', 'error'); return; }
  if (alcance === 'categoria' && !categoria_id) { marcarCampoInvalido('fr-alcance', 'Seleccioná una categoría'); window.toast('Seleccioná una categoría', 'error'); return; }
  if (valor === '' || Number(valor) < 0) { marcarCampoInvalido('fr-valor', 'Ingresá un valor de descuento válido'); window.toast('Ingresá un valor de descuento válido', 'error'); return; }
  if (tipo_descuento === 'porcentaje' && Number(valor) > 100) { marcarCampoInvalido('fr-valor', 'Un descuento porcentual no puede superar 100%'); window.toast('Un descuento porcentual no puede superar 100%', 'error'); return; }
  if (fecha_desde && fecha_hasta && fecha_desde > fecha_hasta) { marcarCampoInvalido('fr-fecha_hasta', 'No puede ser anterior a la fecha "desde"'); window.toast('La fecha "desde" no puede ser posterior a "hasta"', 'error'); return; }

  const body = {
    nombre,
    producto_id: producto_id || null,
    categoria_id: categoria_id || null,
    zona_id: zona_id || null,
    cantidad_minima,
    tipo_descuento,
    valor: Number(valor),
    fecha_desde: fecha_desde || null,
    fecha_hasta: fecha_hasta || null,
    prioridad,
    activa,
  };

  try {
    const token = await getFreshToken();
    const url = modalReglaId ? `/api/reglas-precio?id=${modalReglaId}` : '/api/reglas-precio';
    const method = modalReglaId ? 'PATCH' : 'POST';

    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al guardar la regla');

    window.toast(modalReglaId ? 'Regla actualizada' : 'Regla creada', 'ok');
    cerrarModalRegla();
    await cargarReglas();
  } catch (e) {
    console.error('[REGLAS-PRECIO] guardar:', e);
    window.toast('No se pudo guardar la regla', 'error');
  }
}

// ── Activar / desactivar / eliminar ─────────────────────────────────────
async function toggleActiva(id, nuevoValor) {
  try {
    const token = await getFreshToken();
    const r = await fetch('/api/reglas-precio?_svc=toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, activa: nuevoValor }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al actualizar el estado');
    window.toast(nuevoValor ? 'Regla activada' : 'Regla desactivada', 'ok');
    await cargarReglas();
  } catch (e) {
    console.error('[REGLAS-PRECIO] toggle:', e);
    window.toast('No se pudo cambiar el estado de la regla', 'error');
  }
}

async function eliminarRegla(id) {
  try {
    const token = await getFreshToken();
    const r = await fetch(`/api/reglas-precio?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al eliminar la regla');
    window.toast('Regla eliminada', 'ok');
    reglasData = reglasData.filter(r => r.id !== id);
    renderKpis(reglasData);
    filtrarYRenderizar();
  } catch (e) {
    console.error('[REGLAS-PRECIO] eliminar:', e);
    window.toast('No se pudo eliminar la regla', 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtPeso(n) {
  return '$' + Math.round(+n || 0).toLocaleString('es-AR');
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
}
function fmtFechaInput(d) {
  return d.toISOString().slice(0, 10);
}
async function getFreshToken() {
  const { data: { session } } = await window.authCtx.sb.auth.getSession();
  return session?.access_token || '';
}

// Exponer para onclick inline
window.abrirModalNueva   = abrirModalNueva;
window.abrirModalEditar  = abrirModalEditar;
window.cerrarModalRegla  = cerrarModalRegla;
window.cambiarAlcance    = cambiarAlcance;
window.actualizarPlaceholderValor = actualizarPlaceholderValor;
window.guardarRegla      = guardarRegla;
window.toggleActiva       = toggleActiva;
window.eliminarRegla      = eliminarRegla;
window.cargarReglas       = cargarReglas;
window.filtrarYRenderizar = filtrarYRenderizar;
