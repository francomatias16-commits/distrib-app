// NOTA: La tabla 'lotes' no existe en la base de datos actual.
// Ejecutar 047_sincronizacion_real_db.sql para crearla.
// frontend/admin/js/lotes.js
// REQ-06: Control de lotes y vencimientos

const ACCESO_PAGINA = { 'lotes.html': ['dueno', 'admin', 'depositero'] };

let sb          = null;
let usuario     = null;
let empresaData = null;
let lotesData   = [];
let filtrados   = [];
let depositos   = [];
let paginaActual = 1;
let totalPaginas = 1;
const ITEMS_POR_PAGINA = 100;

let modalLoteId       = null; // null = nuevo
let modalCantidadOrig = null; // cantidad al abrir el modal, para detectar si cambió
let prodSugs          = [];   // sugerencias de producto en modal

// ── Init ──────────────────────────────────────────────────────────────────
// Nombrada `initLotes` (no `init`) a propósito: liquidacion.js, cargado
// después en el mismo <script> clásico de vencimientos.html, también
// declara `async function init()` a nivel top-level — mismo scope global
// compartido entre scripts clásicos, la declaración que carga último pisa
// a la anterior. Con el mismo nombre, el `await init()` de más abajo
// terminaba resolviendo al init() de liquidacion.js (llamada asíncrona,
// se resuelve recién cuando el nombre global YA fue pisado) y sb/usuario/
// empresaData de esta página nunca se inicializaban — ver hallazgo real
// corriendo el spec E2E contra Chromium: filas de la tabla nunca
// aparecían, y cualquier acción posterior tiraba "Cannot read properties
// of null (reading 'auth')" al llamar sb.auth.getSession().
async function initLotes() {
  sb      = window.authCtx.sb;
  usuario = window.authCtx.perfil;

  // perfil.empresas puede no estar disponible en algunos flujos de auth —
  // fallback a construirlo desde empresa_id si es necesario.
  empresaData = window.authCtx.perfil?.empresas
    || (window.authCtx.perfil?.empresa_id
        ? { id: window.authCtx.perfil.empresa_id, nombre: window.authCtx.perfil?.empresa_nombre || '' }
        : null);

  if (!empresaData?.id) {
    console.error('[lotes] empresaData sin id — perfil:', window.authCtx.perfil);
    return;
  }

  // v903: sidebar-logo/sidebar-empresa los pinta nav.js (pintarEmpresaSidebar,
  // corre en cada renderConRol) — no duplicar acá, pisaba el valor bueno.
  if (empresaData.nombre) {
    document.title = `Lotes — ${sanitize(empresaData.nombre)}`;
  }
  const elUsuario = document.getElementById('topbar-usuario');
  if (elUsuario) elUsuario.textContent = usuario?.nombre || '';

  await cargarDepositos();
  await cargarLotes();
}

// ── Depósitos ─────────────────────────────────────────────────────────────
async function cargarDepositos() {
  try {
    const { data, error } = await window.conTimeoutRed(sb.from('depositos')
      .select('id, nombre')
      .eq('empresa_id', empresaData.id)
      .order('nombre'), 10000);
    if (error) throw error;
    depositos = data || [];

    const sels = [document.getElementById('filtro-deposito'), document.getElementById('f-deposito_id')];
    depositos.forEach(d => {
      sels.forEach(sel => {
        if (!sel) return;
        const o = document.createElement('option');
        o.value = d.id; o.textContent = d.nombre;
        sel.appendChild(o);
      });
    });
  } catch (err) {
    toast(err.message || 'No se pudieron cargar los depósitos.', 'error');
  }
}

// ── Cargar lotes ──────────────────────────────────────────────────────────
async function cargarLotes() {
  try {
    const estado   = document.getElementById('filtro-estado').value;
    const deposito = document.getElementById('filtro-deposito').value;

    let url = `/api/lotes?page=${paginaActual}&limit=${ITEMS_POR_PAGINA}`;
    if (estado)   url += `&estado=${estado}`;
    if (deposito) url += `&deposito_id=${deposito}`;

    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!r.ok) throw new Error('No se pudo cargar la lista de lotes.');
    const json = await r.json();

    lotesData    = json.data || [];
    totalPaginas = json.pages || 1;

    mostrarAlertas(lotesData);
    filtrar();
    actualizarPaginacion(json.total || 0);
  } catch (err) {
    toast(err.message || 'No se pudo cargar la lista de lotes.', 'error');
  }
}

// ── Alertas banner ────────────────────────────────────────────────────────
function mostrarAlertas(lotes) {
  const banner   = document.getElementById('banner-alertas');
  const vencidos = lotes.filter(l => l.estado === 'vencido').length;

  // FIX (F3-03, auditoría de páginas Fase 3): el constraint de lotes.estado
  // actual es ('activo','agotado','vencido') — 'por_vencer' nunca se almacena
  // en la DB, así que filtrar por l.estado === 'por_vencer' siempre daba 0.
  // Se calcula dinámicamente desde fecha_vencimiento.
  const ahora    = Date.now();
  const limite7d = ahora + 7 * 86_400_000;
  const porVencer = lotes.filter(l => {
    if (l.estado !== 'activo' || !l.fecha_vencimiento) return false;
    const msVenc = new Date(l.fecha_vencimiento).getTime();
    return msVenc >= ahora && msVenc <= limite7d;
  }).length;

  if (vencidos === 0 && porVencer === 0) { banner.style.display = 'none'; return; }
  banner.style.display = 'block';
  let html = '';
  if (vencidos > 0)
    html += `<div class="alerta-banner alerta-rojo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${vencidos} lote${vencidos > 1 ? 's' : ''} vencido${vencidos > 1 ? 's' : ''}. Revisar y dar de baja.</div>`;
  if (porVencer > 0)
    html += `<div class="alerta-banner alerta-naranja"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>${porVencer} lote${porVencer > 1 ? 's' : ''} por vencer en los próximos 7 días.</div>`;
  banner.innerHTML = html;
}

// ── Filtrar en cliente ────────────────────────────────────────────────────
function filtrar() {
  const q = document.getElementById('busqueda').value.toLowerCase().trim();
  filtrados = q
    ? lotesData.filter(l => {
        const nombre  = (l.productos?.nombre || '').toLowerCase();
        const codigo  = (l.productos?.codigo || '').toLowerCase();
        const nroLote = (l.numero_lote || '').toLowerCase();
        return nombre.includes(q) || codigo.includes(q) || nroLote.includes(q);
      })
    : [...lotesData];

  renderTablaLotes();
}

// ── Render tabla ──────────────────────────────────────────────────────────
function renderTablaLotes() {
  const tbody = document.getElementById('tbody-lotes');
  if (!filtrados.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="vacio">No hay lotes con estos filtros. Se crean al registrar una recepción de compra o con «Nuevo lote».</td></tr>';
    return;
  }

  tbody.innerHTML = filtrados.map(l => {
    const prod    = l.productos?.nombre ? sanitize(l.productos.nombre) : '—';
    const cod     = l.productos?.codigo ? `<span class="cod-badge">${sanitize(l.productos.codigo)}</span>` : '';
    const dep     = l.depositos?.nombre ? sanitize(l.depositos.nombre) : '—';
    const nro     = l.numero_lote ? sanitize(l.numero_lote) : '<em class="muted">Sin número</em>';
    const cant    = fmtNum(l.cantidad);
    const venc    = l.fecha_vencimiento ? fmtFecha(l.fecha_vencimiento) : '—';
    const estado  = badgeEstado(l.estado);
    const esEscritor = ['dueno','admin','depositero'].includes(usuario?.rol);

    return `<tr data-testid="lote-fila" data-id="${l.id}" class="${esEscritor ? 'fila-clickeable' : ''}" ${esEscritor ? `onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalEditar('${l.id}')"` : ''}>
      <td data-label="Producto">${cod} ${prod}</td>
      <td data-label="Nº Lote">${nro}</td>
      <td data-label="Depósito">${dep}</td>
      <td data-label="Cantidad" style="text-align:left">${cant}</td>
      <td data-label="Vencimiento">${venc}</td>
      <td data-label="Estado">${estado}</td>
      <td class="acciones col-sticky-end" data-label="Acciones">
        ${ComponentesAdmin.renderFilaAcciones([
          esEscritor ? { label: 'Editar', attrs: `onclick="abrirModalEditar('${l.id}')"` } : null,
          esEscritor && l.cantidad > 0 ? { label: 'Dar de baja', cls: 'peligro', attrs: `onclick="btnAsyncClick(this, () => darDeBajaLote('${l.id}'))"` } : null,
          esEscritor && l.cantidad == 0 ? { label: 'Eliminar', cls: 'peligro', attrs: `onclick="btnAsyncClick(this, () => eliminarLote('${l.id}'))"` } : null,
        ].filter(Boolean))}
      </td>
    </tr>`;
  }).join('');
}

function badgeEstado(e) {
  const m = {
    activo:       { variante: 'ok',       txt: 'Activo' },
    por_vencer:   { variante: 'warning',  txt: 'Por vencer' },
    vencido:      { variante: 'critico',  txt: 'Vencido' },
    agotado:      { variante: 'inactivo', txt: 'Agotado' },
    // dado_de_baja removed (not a valid lotes.estado value)

  };
  const b = m[e] || { variante: 'inactivo', txt: e };
  return ComponentesAdmin.renderBadgeEstado(b.txt, b.variante);
}

// ── Paginación ────────────────────────────────────────────────────────────
function actualizarPaginacion(total) {
  const pag = document.getElementById('paginacion-lotes');
  pag.style.display = totalPaginas > 1 ? 'flex' : 'none';
  document.getElementById('info-pag').textContent = `Página ${paginaActual} de ${totalPaginas}`;
  document.getElementById('btn-prev').disabled = paginaActual === 1;
  document.getElementById('btn-next').disabled = paginaActual === totalPaginas;
}

function cambiarPagina(delta) {
  paginaActual = Math.max(1, Math.min(totalPaginas, paginaActual + delta));
  cargarLotes();
}

// ── Modal: nuevo ──────────────────────────────────────────────────────────
function abrirModalNuevo() {
  modalLoteId = null;
  modalCantidadOrig = null;
  document.getElementById('modal-titulo').textContent = 'Nuevo lote';
  limpiarModal();
  document.getElementById('f-motivo-wrap').style.display = 'none';
  document.getElementById('modal-lote').style.display = 'flex';
}

function abrirModalEditar(id) {
  const l = lotesData.find(x => x.id === id);
  if (!l) return;
  modalLoteId = id;
  modalCantidadOrig = l.cantidad;
  document.getElementById('modal-titulo').textContent = 'Editar lote';
  document.getElementById('f-producto-busq').value   = `${l.productos?.codigo || ''} — ${l.productos?.nombre || ''}`;
  document.getElementById('f-producto_id').value      = l.producto_id;
  document.getElementById('f-numero_lote').value      = l.numero_lote || '';
  document.getElementById('f-deposito_id').value      = l.deposito_id || '';
  document.getElementById('f-cantidad').value         = l.cantidad;
  document.getElementById('f-costo_unitario').value   = l.costo_unitario || '';
  document.getElementById('f-fecha_fabricacion').value = l.fecha_fabricacion || '';
  document.getElementById('f-fecha_vencimiento').value = l.fecha_vencimiento || '';
  document.getElementById('f-motivo').value = '';
  document.getElementById('f-motivo-wrap').style.display = 'none';
  document.getElementById('modal-lote').style.display = 'flex';
}

function limpiarModal() {
  ['f-producto-busq','f-numero_lote','f-cantidad','f-costo_unitario','f-fecha_fabricacion','f-fecha_vencimiento','f-motivo'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-producto_id').value = '';
  document.getElementById('f-deposito_id').value = '';
}

// Etapa 3 del robustecimiento de lotes: si estás editando un lote y tocás
// la cantidad, aparece (y se exige) el campo de motivo — ese cambio va a
// quedar registrado como un movimiento de stock real (ver 470).
function onCantidadInput() {
  if (modalLoteId === null) return; // en alta no aplica
  const nueva = parseFloat(document.getElementById('f-cantidad').value);
  const cambio = !isNaN(nueva) && nueva !== modalCantidadOrig;
  document.getElementById('f-motivo-wrap').style.display = cambio ? '' : 'none';
}

function cerrarModal() {
  document.getElementById('modal-lote').style.display = 'none';
  document.getElementById('f-producto-sugs').hidden = true;
}

function cerrarModalSiFondo(e) {
  if (e.target.classList.contains('modal-overlay')) cerrarModal();
}

// ── Búsqueda de producto en modal ─────────────────────────────────────────
async function buscarProducto() {
  const q = document.getElementById('f-producto-busq').value.trim();
  const drop = document.getElementById('f-producto-sugs');
  if (q.length < 2) { drop.hidden = true; return; }
  if (!sb || !empresaData?.id) return; // auth aún no lista

  try {
    const { data, error } = await window.conTimeoutRed(sb.from('productos')
      .select('id, codigo, nombre')
      .eq('empresa_id', empresaData.id)
      .eq('activo', true)
      .or(`codigo.ilike.%${q}%,nombre.ilike.%${q}%`)
      .limit(8), 10000);
    if (error) throw error;

    prodSugs = data || [];
    if (!prodSugs.length) { drop.hidden = true; return; }

    drop.innerHTML = '';
    const frag = document.createDocumentFragment();
    prodSugs.forEach(p => {
      const item = document.createElement('div');
      item.className = 'sug-item';
      const strong = document.createElement('strong');
      strong.textContent = p.codigo || '';
      item.appendChild(strong);
      item.appendChild(document.createTextNode(' — ' + (p.nombre || '')));
      item.addEventListener('click', () => seleccionarProducto(p.id, p.codigo, p.nombre));
      frag.appendChild(item);
    });
    drop.appendChild(frag);
    drop.hidden = false;
  } catch (err) {
    // Se dispara en cada tecla (oninput) — un toast por error sería spam.
    // Solo se oculta el dropdown y se deja rastro en consola para debug.
    drop.hidden = true;
    console.warn('[lotes] buscarProducto falló:', err?.message);
  }
}

function seleccionarProducto(id, codigo, nombre) {
  document.getElementById('f-producto_id').value   = id;
  document.getElementById('f-producto-busq').value = `${codigo} — ${nombre}`;
  document.getElementById('f-producto-sugs').hidden = true;
}

// ── Guardar lote ──────────────────────────────────────────────────────────
async function guardarLote() {
  const producto_id      = document.getElementById('f-producto_id').value;
  const cantidad         = parseFloat(document.getElementById('f-cantidad').value);
  const numero_lote      = document.getElementById('f-numero_lote').value.trim() || null;
  const deposito_id      = document.getElementById('f-deposito_id').value || null;
  const costo_unitario   = parseFloat(document.getElementById('f-costo_unitario').value) || null;
  const fecha_fabricacion = document.getElementById('f-fecha_fabricacion').value || null;
  const fecha_vencimiento = document.getElementById('f-fecha_vencimiento').value || null;
  const motivo            = document.getElementById('f-motivo').value.trim() || null;

  if (!modalLoteId && (!producto_id || isNaN(cantidad) || cantidad <= 0)) {
    toast('Producto y cantidad son requeridos.', 'error'); return;
  }

  const cantidadCambio = modalLoteId !== null && !isNaN(cantidad) && cantidad !== modalCantidadOrig;
  if (cantidadCambio && !motivo) {
    toast('Indicá un motivo para el cambio de cantidad.', 'error');
    document.getElementById('f-motivo-wrap').style.display = '';
    document.getElementById('f-motivo').focus();
    return;
  }

  const okLote = await confirmar(
    modalLoteId ? '¿Guardar los cambios de este lote?' : '¿Confirmás crear este lote?',
    { labelOk: modalLoteId ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!okLote) return;

  try {
    const { data: { session } } = await sb.auth.getSession();
    const tok = session.access_token;

    let r;
    if (modalLoteId) {
      const body = { id: modalLoteId, numero_lote, deposito_id, costo_unitario, fecha_fabricacion, fecha_vencimiento };
      // Solo se manda `cantidad` (y su motivo obligatorio) si realmente
      // cambió — así una edición de, por ejemplo, la fecha de vencimiento
      // no dispara de paso un movimiento de stock por una cantidad igual.
      if (cantidadCambio) { body.cantidad = cantidad; body.motivo = motivo; }

      r = await fetch('/api/lotes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify(body),
      });
    } else {
      r = await fetch('/api/lotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ producto_id, cantidad, numero_lote, deposito_id, costo_unitario, fecha_fabricacion, fecha_vencimiento }),
      });
    }

    const json = await r.json();
    if (!r.ok) { toast(json.error || 'No se pudo guardar el lote.', 'error'); return; }

    if (!modalLoteId && json.stock_sincronizado === false) {
      toast('Lote creado, pero sin depósito no se sumó al stock real (asignale un depósito principal a la empresa o uno al lote).', 'toast--warning');
    } else {
      toast(modalLoteId ? 'Lote actualizado.' : 'Lote creado.', 'exito');
    }
    cerrarModal();
    paginaActual = 1;
    await cargarLotes();
  } catch (err) {
    toast(err.message || 'No se pudo guardar el lote.', 'error');
  }
}

// ── Dar de baja (impacta el stock real — ver migración 352) ───────────────
async function darDeBajaLote(id) {
  const l = lotesData.find(x => x.id === id);
  const nombreProd = l?.productos?.nombre || 'este producto';
  const cant       = l ? fmtNum(l.cantidad) : '';
  if (!(await confirmar(
    `¿Dar de baja el lote de ${nombreProd}? Se van a descontar ${cant} unidades del stock real del depósito. Esta acción no se puede deshacer.`,
    { labelOk: 'Dar de baja', tipo: 'danger' }
  ))) return;

  try {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch('/api/lotes?accion=dar_de_baja', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ id }),
    });
    const json = await r.json();
    if (!r.ok || json?.ok === false) { toast(json.error || 'No se pudo dar de baja el lote.', 'error'); return; }

    toast(
      json.ya_estaba_en_cero
        ? 'El lote ya estaba en 0.'
        : `Lote dado de baja. Stock actualizado: ${fmtNum(json.stock_anterior)} → ${fmtNum(json.stock_nuevo)}.`,
      'exito'
    );
    await cargarLotes();
  } catch (err) {
    toast(err.message || 'No se pudo dar de baja el lote.', 'error');
  }
}

// ── Eliminar lote ─────────────────────────────────────────────────────────
async function eliminarLote(id) {
  if (!(await confirmar('¿Eliminar este lote? Solo se puede si la cantidad es 0.', { labelOk: 'Eliminar', tipo: 'danger' }))) return;
  try {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(`/api/lotes?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const json = await r.json();
    if (!r.ok) { toast(json.error || 'No se pudo eliminar el lote.', 'error'); return; }
    toast('Lote eliminado.', 'exito');
    await cargarLotes();
  } catch (err) {
    toast(err.message || 'No se pudo eliminar el lote.', 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtNum(n) { return Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 3 }); }
function fmtFecha(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('T')[0].split('-');
  return `${d}/${m}/${y}`;
}


function toast(msg, tipo = 'exito') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = `toast ${tipo} visible`;
  setTimeout(() => t.classList.remove('visible'), 3000);
}

function cerrarSesion() {
  if (window.authCtx?.sb) window.authCtx.sb.auth.signOut();
  window.location.href = '/admin/login';
}

// Scripts al final del body: DOMContentLoaded ya pasó.
// Usar authReady directamente (resuelve cuando auth.js termina).
window.authReady
  .then(async () => {
    if (!window.authCtx) { window.location.href = '/admin/login'; return; }
    await initLotes();
  })
  .catch(err => {
    console.error('[lotes] authReady falló:', err?.message);
    window.location.href = '/admin/login';
  });