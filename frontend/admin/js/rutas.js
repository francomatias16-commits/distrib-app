

// frontend/admin/js/rutas.js

// ── Config ────────────────────────────────────────────────────────────────
// sb se asigna en el handler de DOMContentLoaded una vez que authCtx esté listo
let sb = null;

// ── Estado ────────────────────────────────────────────────────────────────
let empresaId   = null;
let pedidos     = [];       // pedidos despachables
let pedidosFilt = [];       // filtrados en panel izquierdo
let rutaItems   = [];       // pedidos en la ruta en construcción
let choferes    = [];
let agruparZona = true;     // agrupar "Pedidos para despachar" por zona (default: on)

// ── Avatar circular con iniciales del chofer (estilo TravelBox) ────────────
const CHOFER_PALETTE = ['#8B5CF6', '#F59E0B', '#3B82F6', '#0D9488', '#EF4444'];
function avatarChofer(nombre) {
  const n = (nombre || '?').trim();
  const iniciales = n.split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';
  let hash = 0;
  for (let i = 0; i < n.length; i++) hash = (hash * 31 + n.charCodeAt(i)) >>> 0;
  const color = CHOFER_PALETTE[hash % CHOFER_PALETTE.length];
  return `<span class="chofer-fila">
    <span class="chofer-avatar" style="background:${color}">${iniciales}</span>
    <strong>${esc(n)}</strong>
  </span>`;
}
let rutasHoy    = [];
let seguimientoTimer = null;
let entregasSeguimientoActual = []; // últimas entregas cargadas en "Seguimiento en vivo" (deep-link desde alertas)

// ── Helpers de API (mismo patrón que cajas.html) ──────────────────────────
function authHeader() {
  const token = window.authCtx?.session?.access_token || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function apiPost(url, body) {
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body:    JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || 'Error de red');
  return data;
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // authReady espera hasta que auth.js completa su IIFE async
  await window.authReady.catch((err) => {
    console.error('[auth] authReady falló:', err?.message);
    if (!window.authCtx || !window.authCtx.perfil) {
      window.location.href = '/admin/login';
    }
  });
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }

  sb        = window.authCtx.sb;
  empresaId = window.authCtx.perfil.empresa_id;

  // Fecha de hoy por defecto en los filtros
  // FIX (auditoría UX etapa 16, Hallazgo 1): toISOString() (UTC) precargaba
  // la fecha de mañana entre las 21:00 y las 00:00 hora Argentina.
  const hoy = window.hoyLocalISO ? window.hoyLocalISO() : new Date().toISOString().split('T')[0];
  document.getElementById('filtro-fecha').value = hoy;
  document.getElementById('ruta-fecha').value   = hoy;
  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      new Date().toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
  }

  await cargarDatos();

  // Deep-link desde la alerta "Entrega con cobro parcial" del dashboard (ver
  // handleAlertas en admin.js, sección 8): en vez de que el dueño tenga que
  // buscar la ruta a mano en Seguimiento en vivo, saltamos directo a la
  // fecha/ruta correctas y abrimos el modal de la entrega en cuestión.
  // Mismo patrón que turno_dif en cajas.html.
  const params = new URLSearchParams(location.search);
  const entregaDifParam = params.get('entrega_dif');
  const rutaDifParam    = params.get('ruta_id');
  const fechaDifParam   = params.get('fecha');

  // Deep-link desde el viejo /admin/zonas (ahora redirect, ver vercel.json)
  // y desde cualquier link guardado que apuntaba a la sección de zonas.
  if (params.get('tab') === 'zonas') {
    mostrarTab('zonas');
  }

  if (entregaDifParam && rutaDifParam) {
    if (fechaDifParam && fechaDifParam !== document.getElementById('filtro-fecha').value) {
      document.getElementById('filtro-fecha').value = fechaDifParam;
      await cargarRutasDelDia();
    }
    mostrarTab('seguimiento');
    const sel = document.getElementById('sel-ruta-seguimiento');
    if (sel) {
      sel.value = rutaDifParam;
      await cargarSeguimiento();
      const entregaObjetivo = entregasSeguimientoActual.find(e => e.id === entregaDifParam);
      if (entregaObjetivo) abrirModalEntrega(entregaObjetivo);
    }
  }
});

async function cargarDatos() {
  await Promise.all([cargarChoferes(), cargarPedidosDespachables(), cargarRutasDelDia()]);
}

// ── Ingresar como chofer (impersonar) ───────────────────────────────────────
// Abre el panel del chofer seleccionado en una pestaña nueva, ya logueado,
// vía un link de un solo uso que genera el backend (ver ?accion=impersonar
// en lib/handlers/chofer_invitacion.js). Pensado para demos comerciales o
// soporte, sin tener que pedirle al chofer su contraseña.
async function ingresarComoChofer() {
  const choferId = document.getElementById('ruta-chofer').value;
  if (!choferId) { window.toast('Seleccioná primero un chofer de la lista'); return; }

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch('/api/chofer-invitacion?accion=impersonar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario_id: choferId }),
    });
    const data = await res.json();
    if (!res.ok) { window.toast(data.error || 'No se pudo generar el acceso', 'error'); return; }
    window.open(data.url, '_blank');
  } catch (err) {
    window.toast(err.message || 'No se pudo generar el acceso', 'error');
  }
}
// FIX v477: rutas.js también es <script type="module"> — mismo problema que
// verCatalogoCliente en clientes.js. El botón "Ingresar como" (onclick="
// ingresarComoChofer()") vive en el HTML global, así que sin este export
// nunca encontraba la función: no abría el panel del chofer ni tiraba error
// visible, simplemente no hacía nada.
window.ingresarComoChofer = ingresarComoChofer;

// ── Cargar choferes ───────────────────────────────────────────────────────
async function cargarChoferes() {
  const { data } = await sb
    .from('usuarios')
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .eq('rol', 'chofer')
    .eq('activo', true)
    .order('nombre');

  choferes = data || [];
  const sel = document.getElementById('ruta-chofer');
  sel.innerHTML = '<option value="">Seleccionar chofer...</option>';
  choferes.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.nombre;
    sel.appendChild(o);
  });
}

// ── Cargar pedidos despachables ───────────────────────────────────────────
// Pedidos en estado 'confirmado' o 'preparando' sin ruta asignada (o para la fecha)
async function cargarPedidosDespachables() {
  const fecha = document.getElementById('filtro-fecha').value;

  window.mostrarSkeletonTabla('lista-pendientes', 3, 4); // Mostrar skeleton antes de cargar

  const { data } = await sb
    .from('pedidos')
    .select(`
      id, estado, total, notas_cliente, fecha_entrega,
      clientes(id, razon_social, domicilio, localidad, telefono, zonas(nombre))
    `)
    .eq('empresa_id', empresaId)
    .in('estado', ['confirmado', 'preparando'])
    .order('fecha_entrega', { ascending: true });

  // FIX (auditoría etapa 6 — Hallazgo 2): el comentario de arriba decía
  // "sin ruta asignada" pero nunca se filtraba eso — solo por estado. Un
  // pedido en 'preparando' (ya agregado a otra ruta, todavía no
  // despachada) volvía a aparecer acá como disponible, y se podía asignar
  // dos veces. Ahora se excluyen los que ya tienen una entrega activa
  // (pendiente/en_camino) en cualquier ruta.
  const { data: entregasActivas } = await sb
    .from('entregas')
    .select('pedido_id')
    .in('estado', ['pendiente', 'en_camino']);
  const pedidosYaEnRuta = new Set((entregasActivas || []).map(e => e.pedido_id));

  pedidos = (data || [])
    .filter(p => !pedidosYaEnRuta.has(p.id))
    .filter(p => {
      // Incluir si no tiene fecha de entrega, o si la fecha coincide con el filtro
      if (!p.fecha_entrega) return true;
      return p.fecha_entrega === fecha;
    });

  pedidosFilt = [...pedidos];
  renderPendientes();
}

function filtrarPendientes() {
  const q = document.getElementById('buscar-pendiente').value.toLowerCase();
  pedidosFilt = pedidos.filter(p =>
    p.clientes?.razon_social?.toLowerCase().includes(q) ||
    p.clientes?.zonas?.nombre?.toLowerCase().includes(q) ||
    p.clientes?.localidad?.toLowerCase().includes(q)
  );
  renderPendientes();
}

// Toggle "Por zona" — agrupa la lista de pendientes por zona de entrega
// (ver botón #btn-toggle-agrupar en rutas.html).
function toggleAgruparZona() {
  agruparZona = !agruparZona;
  const btn = document.getElementById('btn-toggle-agrupar');
  const label = document.getElementById('btn-toggle-agrupar-label');
  if (btn) btn.setAttribute('aria-pressed', String(agruparZona));
  if (label) label.textContent = agruparZona ? 'Por zona' : 'Sin agrupar';
  renderPendientes();
}
window.toggleAgruparZona = toggleAgruparZona;

function cardPedidoHtml(p, { mostrarZona = true } = {}) {
  return `
    <div class="pedido-card"
      draggable="true"
      data-id="${p.id}"
      ondragstart="onDragStart(event, '${p.id}')"
      onclick="agregarALaRuta('${p.id}')"
      title="Click para agregar a la ruta"
    >
      <div class="pedido-card-top">
        <span class="pedido-card-cliente">${esc(p.clientes?.razon_social)}</span>
        <span class="pedido-card-monto">${window.formatARS(p.total)}</span>
      </div>
      <div class="pedido-card-meta">
        <span>${esc(p.clientes?.localidad || p.clientes?.domicilio || 'Sin dirección')}</span>
        ${p.fecha_entrega ? `<span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${window.formatFecha(p.fecha_entrega)}</span>` : ''}
      </div>
      ${mostrarZona && p.clientes?.zonas?.nombre ? `<span class="pedido-card-zona">${esc(p.clientes.zonas.nombre)}</span>` : ''}
    </div>
  `;
}

function renderPendientes() {
  const lista = document.getElementById('lista-pendientes');
  const label = document.getElementById('label-pendientes');

  const enRuta = new Set(rutaItems.map(r => r.id));
  const libres = pedidosFilt.filter(p => !enRuta.has(p.id));

  const totalMonto = libres.reduce((acc, p) => acc + (Number(p.total) || 0), 0);
  label.textContent = libres.length === 0
    ? '0 pedidos disponibles'
    : `${libres.length} pedido${libres.length === 1 ? '' : 's'} disponible${libres.length === 1 ? '' : 's'} · ${window.formatARS(totalMonto)}`;

  if (libres.length === 0) {
    window.mostrarEstadoVacio('lista-pendientes', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
      titulo: 'Sin pedidos para despachar hoy',
      descripcion: 'Todos los pedidos han sido asignados o no hay pedidos pendientes.',
    });
    return;
  }

  if (!agruparZona) {
    window.renderTbody(lista, libres, (p) => cardPedidoHtml(p, { mostrarZona: true }));
    return;
  }

  // ── Agrupado por zona ──────────────────────────────────────────────
  const grupos = new Map(); // nombre de zona -> { pedidos: [], monto: 0 }
  libres.forEach(p => {
    const zona = p.clientes?.zonas?.nombre || 'Sin zona asignada';
    if (!grupos.has(zona)) grupos.set(zona, { pedidos: [], monto: 0 });
    const g = grupos.get(zona);
    g.pedidos.push(p);
    g.monto += Number(p.total) || 0;
  });

  // Zonas con más pedidos primero; "Sin zona asignada" siempre al final
  const zonasOrdenadas = [...grupos.entries()].sort((a, b) => {
    if (a[0] === 'Sin zona asignada') return 1;
    if (b[0] === 'Sin zona asignada') return -1;
    return b[1].pedidos.length - a[1].pedidos.length;
  });

  lista.innerHTML = zonasOrdenadas.map(([zona, g]) => `
    <div class="grupo-zona">
      <div class="grupo-zona-header">
        <span class="grupo-zona-nombre"><span class="grupo-zona-dot"></span>${esc(zona)}</span>
        <span class="grupo-zona-meta">${g.pedidos.length} · ${window.formatARS(g.monto)}</span>
      </div>
      ${g.pedidos.map(p => cardPedidoHtml(p, { mostrarZona: false })).join('')}
    </div>
  `).join('');
}

// ── Drag & drop ───────────────────────────────────────────────────────────
let dragId = null;

function onDragStart(e, id) {
  dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
  setTimeout(() => e.currentTarget?.classList.remove('dragging'), 300);
}

function onDragOver(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.add('over');
}

function onDragLeave() {
  document.getElementById('drop-zone').classList.remove('over');
}

function onDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('over');
  if (dragId) { agregarALaRuta(dragId); dragId = null; }
}

function agregarALaRuta(id) {
  if (rutaItems.find(r => r.id === id)) return; // ya está
  const p = pedidos.find(p => p.id === id);
  if (!p) return;
  rutaItems.push(p);
  renderRuta();
  renderPendientes();
}

function quitarDeRuta(id) {
  rutaItems = rutaItems.filter(r => r.id !== id);
  renderRuta();
  renderPendientes();
}

function renderRuta() {
  const listaEl   = document.getElementById('lista-ruta');
  const emptyEl   = document.getElementById('drop-empty');
  const statPed   = document.getElementById('stat-pedidos');
  const statTotal = document.getElementById('stat-total');

  const total = rutaItems.reduce((s, p) => s + (p.total || 0), 0);
  statPed.textContent   = rutaItems.length;
  statTotal.textContent = window.formatARS(total);

  if (rutaItems.length === 0) {
    emptyEl.style.display = '';
    listaEl.innerHTML = '';
    return;
  }

  emptyEl.style.display = 'none';
  listaEl.innerHTML = rutaItems.map((p, i) => `
    <div class="ruta-item">
      <div class="ruta-item-num">${i + 1}</div>
      <div class="ruta-item-info">
        <span class="ruta-item-cliente">${esc(p.clientes?.razon_social)}</span>
        <span class="ruta-item-dir">${esc(p.clientes?.domicilio || p.clientes?.localidad || 'Sin dirección')}</span>
      </div>
      <span class="ruta-item-monto">${window.formatARS(p.total)}</span>
      <button class="btn-quitar" onclick="quitarDeRuta('${p.id}')" title="Quitar de la ruta">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

function limpiarRuta() {
  rutaItems = [];
  renderRuta();
  renderPendientes();
}

// ── Cargar rutas del día ──────────────────────────────────────────────────
async function cargarRutasDelDia() {
  const fecha = document.getElementById('filtro-fecha').value;

  window.mostrarSkeletonTabla('tabla-rutas-dia', 6); // Mostrar skeleton antes de cargar

  const { data } = await sb
    .from('rutas')
    .select(`
      id, fecha, estado, notas, created_at,
      usuarios(nombre),
      entregas(id, estado, pedido_id, monto_cobrado, pedidos(total))
    `)
    .eq('empresa_id', empresaId)
    .eq('fecha', fecha)
    .order('created_at', { ascending: false });

  rutasHoy = data || [];
  renderRutasDelDia();
  poblarSelectorSeguimiento();
}

// ── Total de la ruta + alerta de cobro parcial ────────────────────────────
// FIX (Matías): antes esta columna estaba hardcodeada en "—" (nunca se
// calculaba). Ahora suma pedidos.total de las entregas de la ruta, y si el
// chofer registró un cobro (entregas.monto_cobrado) menor al total del
// pedido, lo marca con una advertencia en vez de dejarlo pasar en silencio.
function celdaTotalRuta(entregas) {
  const lista = entregas || [];
  const total = lista.reduce((s, e) => s + (e.pedidos?.total || 0), 0);
  if (total <= 0) return '—';

  const hayCobroRegistrado = lista.some(e => e.monto_cobrado != null);
  const cobrado = lista.reduce((s, e) => s + (e.monto_cobrado || 0), 0);
  const diferencia = total - cobrado;

  if (hayCobroRegistrado && diferencia > 0.5) {
    return `${window.formatARS(total)}<br><span style="color:var(--color-danger);font-size:11px;font-weight:600;white-space:nowrap;" title="Cobrado ${window.formatARS(cobrado)} de ${window.formatARS(total)} — faltan ${window.formatARS(diferencia)}">⚠ falta ${window.formatARS(diferencia)}</span>`;
  }
  return window.formatARS(total);
}

function renderRutasDelDia() {
  const tbody = document.getElementById('tabla-rutas-dia');
  if (!tbody) return;

  if (rutasHoy.length === 0) {
    window.mostrarEstadoVacio('tabla-rutas-dia', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
      titulo: 'Sin rutas este día',
      descripcion: 'No hay rutas creadas para la fecha seleccionada.',
    });
    return;
  }

  window.renderTbody(tbody, rutasHoy, (r) => {
    const pedidos   = r.entregas?.length || 0;
    const chip      = chipEstadoRuta(r.estado);
    const hora      = new Date(r.created_at).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
    return `<tr>
      <td data-label="Chofer">${avatarChofer(r.usuarios?.nombre)}</td>
      <td data-label="Pedidos">${pedidos} pedido${pedidos !== 1 ? 's' : ''}</td>
      <td data-label="Total">${celdaTotalRuta(r.entregas)}</td>
      <td data-label="Estado">${chip}</td>
      <td data-label="Creada" style="color:var(--color-text-light);font-size:12px;">${hora}</td>
      <td data-label="" style="display:flex;gap:6px;">
        <button class="btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="mostrarTab('seguimiento');document.getElementById('sel-ruta-seguimiento').value='${r.id}';cargarSeguimiento()">Ver</button>
        ${r.estado === 'pendiente' ? `<button class="btn-danger" style="padding:5px 10px;font-size:12px;" onclick="cancelarRuta('${r.id}')">Cancelar</button>` : ''}
      </td>
    </tr>`;
  }, 6);
}

// ── Confirmar ruta ────────────────────────────────────────────────────────
async function confirmarRuta() {
  if (rutaItems.length === 0) { window.toast('Agregá al menos un pedido a la ruta'); return; }

  const choferId = document.getElementById('ruta-chofer').value;
  if (!choferId) { window.toast('Seleccioná un chofer'); return; }

  const fecha = document.getElementById('ruta-fecha').value;
  if (!fecha)  { window.toast('Indicá la fecha de entrega'); return; }

  const choferSelTxt = document.getElementById('ruta-chofer')?.selectedOptions?.[0]?.textContent?.trim() || 'el chofer seleccionado';
  const okRuta = await confirmar(
    `¿Confirmás crear esta ruta con ${rutaItems.length} pedido${rutaItems.length === 1 ? '' : 's'} y notificar a ${choferSelTxt} por WhatsApp?`,
    { labelOk: 'Crear ruta', labelCancel: 'Revisar' }
  );
  if (!okRuta) return;

  const btn = document.getElementById('btn-confirmar-ruta');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    // 1. Crear la ruta
    const { data: ruta, error: rutaErr } = await sb
      .from('rutas')
      .insert({
        empresa_id: empresaId,
        chofer_id:  choferId,
        fecha:      fecha,
        estado:     'pendiente',
        notas:      document.getElementById('ruta-notas').value || null,
      })
      .select()
      .single();

    if (rutaErr) throw rutaErr;

    // 2. Insertar entregas
    const entregas = rutaItems.map((p, i) => ({
      ruta_id:   ruta.id,
      pedido_id: p.id,
      orden:     i + 1,
      estado:    'pendiente',
    }));

    const { error: entErr } = await sb.from('entregas').insert(entregas);
    if (entErr) throw entErr;

    // 3. Cambiar estado logístico → 'preparando' (cambio de estado sin modificar stock).
    //    El stock se descontará cuando admin llame a marcar_preparado desde pedidos.js.
    const ids = rutaItems.map(p => p.id);
    const { error: prepErr } = await sb
      .from('pedidos')
      .update({ estado: 'preparando' })
      .in('id', ids)
      .eq('empresa_id', empresaId);
    if (prepErr) throw prepErr;

    // 4. Notificar al chofer por WhatsApp
    const chofer = choferes.find(c => c.id === choferId);
    await notificarChofer(ruta.id, chofer, fecha, rutaItems.length);

    window.toast(`Ruta creada y ${chofer?.nombre || 'chofer'} notificado`);
    limpiarRuta();
    document.getElementById('ruta-notas').value = '';
    await cargarDatos();

  } catch (err) {
    console.error('[RUTAS] Error al confirmar:', err);
    window.toast('Error al crear la ruta — revisá la consola');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 16a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.9 5.11h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 12.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg> Confirmar y notificar chofer`;
  }
}

async function guardarRutaBorrador() {
  window.toast('Borrador guardado (próximamente)');
}

async function cancelarRuta(id) {
  if (!(await confirmar('¿Cancelar esta ruta? Los pedidos volverán a "confirmado".', { labelOk: 'Cancelar ruta', tipo: 'danger' }))) return;
  await sb.from('rutas').update({ estado: 'cancelada' }).eq('id', id);
  // Revertir pedidos a 'confirmado' (reserva de stock sigue vigente, solo estado logístico)
  const { data: entregas } = await sb.from('entregas').select('pedido_id').eq('ruta_id', id);
  if (entregas?.length) {
    const ids = entregas.map(e => e.pedido_id);
    const perfil = window.authCtx?.perfil;
    // Revertir cada pedido individualmente usando RPC para que quede en audit_log
    for (const pedidoId of ids) {
      await sb.from('pedidos')
        .update({ estado: 'confirmado' })
        .eq('id', pedidoId)
        .eq('empresa_id', perfil?.empresa_id);
    }
  }
  // FIX (auditoría etapa 6 — Hallazgo 2c): esto revertía los pedidos pero
  // nunca cerraba las filas de `entregas` de la ruta cancelada, que
  // quedaban huérfanas en 'pendiente' para siempre — y como el pedido
  // volvía a estar disponible, terminaba en una ruta nueva mientras la
  // fila vieja seguía "pendiente", generando entregas duplicadas para el
  // mismo pedido (encontrado en producción durante esta auditoría).
  await sb.from('entregas')
    .update({ estado: 'no_entregado', motivo_no_entrega: 'otro', notas_entrega: 'Ruta cancelada' })
    .eq('ruta_id', id)
    .in('estado', ['pendiente', 'en_camino']);
  window.toast('Ruta cancelada');
  await cargarDatos();
}

// ── Notificar chofer (WA + Push) ──────────────────────────────────────────
async function notificarChofer(rutaId, chofer, fecha, cantPedidos) {
  // 1. WhatsApp (si tiene teléfono)
  if (chofer?.telefono) {
    try {
      await fetch('/api/notif/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: 'ruta_asignada',
          telefono: chofer.telefono,
          params: {
            nombre_chofer: chofer.nombre.split(/[\s,]+/)[0],
            fecha:         window.formatFecha(fecha),
            cant_pedidos:  cantPedidos,
            link_app:      `${window.location.origin}/chofer`,
          },
        }),
      });
    } catch (err) {
      console.warn('[NOTIF] Error WA chofer:', err.message);
    }
  }

  // 2. Push notification (si el chofer tiene dispositivos registrados)
  if (chofer?.id) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      const resp = await fetch('/api/notif/push-chofer', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          chofer_id:    chofer.id,
          empresa_id:   empresaId,
          ruta_id:      rutaId,
          fecha:        fecha,
          cant_pedidos: cantPedidos,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        console.warn('[NOTIF] push-chofer error:', resp.status, body);
      } else {
        const result = await resp.json();
        console.log(`[NOTIF] Push enviado a ${result.enviadas ?? 0} dispositivo(s) del chofer ${sanitize(chofer.nombre)}`);
      }
    } catch (err) {
      console.warn('[NOTIF] Error push chofer:', err.message);
    }
  }
}

// ── Seguimiento ───────────────────────────────────────────────────────────
function poblarSelectorSeguimiento() {
  const sel = document.getElementById('sel-ruta-seguimiento');
  const val = sel.value;
  sel.innerHTML = '<option value="">Seleccionar ruta...</option>';
  rutasHoy.forEach(r => {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = `${r.usuarios?.nombre || 'Sin chofer'} — ${r.entregas?.length || 0} paradas`;
    sel.appendChild(o);
  });
  if (val) sel.value = val;
}

async function cargarSeguimiento() {
  const rutaId = document.getElementById('sel-ruta-seguimiento').value;
  if (!rutaId) return;

  if (seguimientoTimer) { clearInterval(seguimientoTimer); }

  await actualizarSeguimiento(rutaId);
  seguimientoTimer = setInterval(() => actualizarSeguimiento(rutaId), 30000);
}

// ── Mapa de entregas con Leaflet ──────────────────────────────────────────
let _mapaLeaflet = null;
let _mapaMarkers = [];

function inicializarMapa(entregas) {
  const contenedor = document.getElementById('mapa');

  // Determinar puntos a mostrar: ubicación GPS real confirmada por el chofer,
  // o si todavía no confirmó, la ubicación registrada del cliente (estimada).
  const puntos = entregas.map((e, i) => {
    const ub  = e.pedidos?.ubicacion_entrega;
    const cl  = e.pedidos?.clientes;
    const lat = ub?.lat ?? cl?.lat;
    const lng = ub?.lng ?? cl?.lng;
    const esEstimada = !(ub?.lat && ub?.lng) && !!(cl?.lat && cl?.lng);
    return { ...e, _lat: lat, _lng: lng, _estimada: esEstimada, _i: i };
  }).filter(p => p._lat && p._lng);

  if (puntos.length === 0) {
    // Sin coordenadas de ningún tipo: mostrar placeholder
    if (_mapaLeaflet) { _mapaLeaflet.remove(); _mapaLeaflet = null; }
    contenedor.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;color:var(--color-text-light);font-size:14px;">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <span>Las ubicaciones aparecerán cuando el chofer confirme entregas</span>
      </div>`;
    return;
  }

  // Inicializar mapa si no existe
  if (!_mapaLeaflet) {
    contenedor.innerHTML = '';
    _mapaLeaflet = L.map(contenedor, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(_mapaLeaflet);
  }

  // Limpiar marcadores anteriores
  _mapaMarkers.forEach(m => m.remove());
  _mapaMarkers = [];

  const colores = {
    entregado:    '#1F5B4A',
    no_entregado: '#B3261E',
    pendiente:    '#8F5F00',
    en_camino:    '#2E6088',
  };

  const bounds = [];

  puntos.forEach((e) => {
    const lat = e._lat;
    const lng = e._lng;
    const color = colores[e.estado] || colores.pendiente;
    const cliente = e.pedidos?.clientes?.razon_social || 'Cliente';
    const dir = e.pedidos?.clientes?.domicilio || '';

    // Ubicación estimada (domicilio del cliente, aún no confirmada por el chofer):
    // se dibuja más tenue y con borde punteado para diferenciarla de una entrega real.
    const estiloBorde = e._estimada ? '2px dashed #fff' : '2px solid #fff';
    const opacidad = e._estimada ? '0.65' : '1';

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:28px;height:28px;border-radius:50%;background:${color};opacity:${opacidad};border:${estiloBorde};box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;">${e.orden || e._i + 1}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    const hora = e.fecha_confirmacion
      ? new Date(e.fecha_confirmacion).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : '';

    const marker = L.marker([lat, lng], { icon })
      .bindPopup(`
        <strong>${cliente}</strong><br>
        ${dir ? `${dir}<br>` : ''}
        Estado: <b>${capEstado(e.estado)}</b>
        ${hora ? `<br>Confirmado: ${hora}` : ''}
        ${e.receptor ? `<br>Recibió: ${e.receptor}` : ''}
        ${e._estimada ? `<br><span style="color:var(--color-text-light,#6B695F);font-size:11px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>Ubicación estimada (domicilio registrado, aún sin confirmar por el chofer)</span>` : ''}
      `)
      .addTo(_mapaLeaflet);

    _mapaMarkers.push(marker);
    bounds.push([lat, lng]);
  });

  if (bounds.length > 0) {
    _mapaLeaflet.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
}

async function actualizarSeguimiento(rutaId) {
  const { data } = await sb
    .from('entregas')
    .select(`
      id, orden, estado, receptor, notas_entrega, fecha_confirmacion,
      monto_cobrado, medio_cobro,
      pedidos(id, total, ubicacion_entrega, clientes(razon_social, domicilio, localidad, telefono, lat, lng))
    `)
    .eq('ruta_id', rutaId)
    .order('orden');

  const entregas = data || [];
  entregasSeguimientoActual = entregas;
  const entregadas    = entregas.filter(e => e.estado === 'entregado').length;
  const noEntregadas  = entregas.filter(e => e.estado === 'no_entregado').length;

  document.getElementById('label-entregas-seg').textContent =
    `${entregadas}/${entregas.length} entregados · ${noEntregadas} sin entregar`;
  document.getElementById('ultima-actualizacion').textContent =
    `Actualizado: ${new Date().toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' })}`;

  renderListaEntregas(entregas);
  inicializarMapa(entregas);
}

function renderListaEntregas(entregas) {
  const lista = document.getElementById('lista-entregas-seg');
  if (!lista) return;

  if (entregas.length === 0) {
    window.mostrarEstadoVacio('lista-entregas-seg', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
      titulo: 'Sin entregas en esta ruta',
      descripcion: 'El chofer aún no ha registrado entregas.',
    });
    return;
  }

  lista.innerHTML = entregas.map(e => {
    const estadoClass = e.estado === 'entregado' ? 'entregado' :
                        e.estado === 'no_entregado' ? 'no-entregado' :
                        e.estado === 'en_camino' ? 'en-camino' : '';
    const iconEstado  = e.estado === 'entregado'    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>' :
                        e.estado === 'no_entregado' ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' :
                        e.estado === 'en_camino'    ? '→' : e.orden;
    const hora = e.fecha_confirmacion
      ? new Date(e.fecha_confirmacion).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' })
      : '';
    return `
      <div class="entrega-row ${estadoClass}" onclick="abrirModalEntrega(${JSON.stringify(e).replace(/"/g, '&quot;')})">
        <div class="entrega-orden">${iconEstado}</div>
        <div class="entrega-info">
          <span class="entrega-cliente">${esc(e.pedidos?.clientes?.razon_social)}</span>
          <span class="entrega-dir">${esc(e.pedidos?.clientes?.domicilio || e.pedidos?.clientes?.localidad || '—')}</span>
        </div>
        <div style="text-align:right;display:flex;flex-direction:column;gap:2px;align-items:flex-end;">
          <span style="font-size:12px;font-weight:700;color:var(--color-primary);">${window.formatARS(e.pedidos?.total)}</span>
          ${hora ? `<span style="font-size:11px;color:var(--color-text-light);">${hora}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function abrirModalEntrega(e) {
  document.getElementById('modal-entrega-titulo').textContent =
    e.pedidos?.clientes?.razon_social || 'Entrega';

  // FIX (Matías): antes este modal mostraba el total del pedido pero nunca
  // lo que realmente cobró el chofer, así que un cobro parcial pasaba
  // desapercibido para el admin salvo que fuera a mirar Historial.
  const total    = e.pedidos?.total ?? null;
  const cobrado  = e.monto_cobrado ?? null;
  const diferencia = (total != null && cobrado != null) ? (total - cobrado) : 0;
  const medioLabel = { efectivo: 'efectivo', transferencia: 'transferencia', cheque: 'cheque', tarjeta: 'tarjeta' };
  const hayDiferencia = diferencia > 0.5;

  let cobroHtml = '';
  if (cobrado != null) {
    cobroHtml = `<div><strong>Cobrado:</strong> ${window.formatARS(cobrado)}${e.medio_cobro ? ` (${esc(medioLabel[e.medio_cobro] || e.medio_cobro)})` : ''}</div>`;
    if (hayDiferencia) {
      cobroHtml += `<div style="color:var(--color-danger);font-weight:600;">⚠ Faltan ${window.formatARS(diferencia)} respecto al total del pedido</div>`;
    }
  }

  // Si hay diferencia, chequeamos si ya fue marcada como resuelta (misma
  // tabla anomalias_revisadas que usa el panel de alertas del dashboard —
  // ver handleAlertas en admin.js, sección 8 — y el mismo mecanismo que ya
  // usa cajas.html para diferencia_caja). Sin esto, la alerta de esta
  // entrega seguiría reapareciendo en el dashboard aunque el admin ya la
  // haya revisado.
  let yaResuelta = false;
  if (hayDiferencia) {
    try {
      const rev = await fetch('/api/auditoria?accion=revisadas', { headers: authHeader() }).then(r => r.json());
      yaResuelta = (rev?.revisadas || []).some(
        r => r.tipo_anomalia === 'entrega_cobro_parcial' && r.entidad_id === e.id
      );
    } catch (_) { /* si falla, se muestra el botón igual */ }
  }

  const resolverHtml = hayDiferencia ? `
    <div id="resolver-cobro-parcial-wrap" style="padding-top:8px;border-top:1px solid var(--color-border);display:flex;justify-content:flex-end;">
      ${yaResuelta ? `
        <span style="display:inline-flex;align-items:center;gap:4px;color:var(--color-success,#17402F);font-size:13px;font-weight:600;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Marcada como resuelta
        </span>
      ` : `
        <button type="button" class="btn-secondary" style="padding:5px 10px;font-size:12px;" onclick="marcarCobroParcialResuelto('${e.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>
          Marcar como resuelto
        </button>
      `}
    </div>
  ` : '';

  document.getElementById('modal-entrega-body').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;font-size:14px;">
      <div><strong>Estado:</strong> <span class="chip chip-${e.estado === 'entregado' ? 'completada' : e.estado === 'no_entregado' ? 'cancelada' : 'pendiente'}">${capEstado(e.estado)}</span></div>
      <div><strong>Dirección:</strong> ${esc(e.pedidos?.clientes?.domicilio || e.pedidos?.clientes?.localidad || '—')}</div>
      <div><strong>Total pedido:</strong> ${window.formatARS(total)}</div>
      ${cobroHtml}
      ${e.receptor ? `<div><strong>Recibió:</strong> ${esc(e.receptor)}</div>` : ''}
      ${e.notas_entrega ? `<div><strong>Notas:</strong> ${esc(e.notas_entrega)}</div>` : ''}
      ${e.fecha_confirmacion ? `<div><strong>Confirmado:</strong> ${new Date(e.fecha_confirmacion).toLocaleString('es-AR')}</div>` : ''}
      ${e.pedidos?.ubicacion_entrega?.lat && e.pedidos?.ubicacion_entrega?.lng ? `<div><a href="https://www.google.com/maps?q=${e.pedidos?.ubicacion_entrega.lat},${e.pedidos?.ubicacion_entrega.lng}" target="_blank" style="color:var(--color-primary);"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>Ver ubicación de la entrega en el mapa</a></div>` : ''}
      ${e.pedidos?.clientes?.telefono ? `<div><a href="https://wa.me/${limpiarTel(e.pedidos.clientes.telefono)}" target="_blank" style="color:var(--color-primary);">Contactar por WhatsApp</a></div>` : ''}
      ${resolverHtml}
    </div>
  `;
  document.getElementById('modal-entrega').classList.remove('hidden');
}

// Marca la entrega como resuelta reusando anomalias_revisadas (mismo
// mecanismo que ya usa cajas.html para diferencia_caja). Con esto la alerta
// deja de aparecer en el panel del dashboard sin esperar a que salga de la
// ventana de 30 días.
async function marcarCobroParcialResuelto(entregaId) {
  const wrap = document.getElementById('resolver-cobro-parcial-wrap');
  if (wrap) wrap.innerHTML = '<span style="color:var(--color-text-light);font-size:12px;">Guardando…</span>';
  try {
    await apiPost('/api/auditoria?accion=resolver', {
      tipo_anomalia: 'entrega_cobro_parcial',
      entidad_id:    entregaId,
    });
    if (wrap) {
      wrap.innerHTML = `
        <span style="display:inline-flex;align-items:center;gap:4px;color:var(--color-success,#17402F);font-size:13px;font-weight:600;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Marcada como resuelta
        </span>`;
    }
    if (window.toast) window.toast('Diferencia marcada como resuelta.');
  } catch (e) {
    if (wrap) wrap.innerHTML = `<span style="color:var(--color-danger);font-size:12px;">${esc(e.message)}</span>`;
  }
}

function cerrarModalEntrega() {
  document.getElementById('modal-entrega').classList.add('hidden');
}

// ── Historial ─────────────────────────────────────────────────────────────
async function cargarHistorial() {
  window.mostrarSkeletonTabla('tabla-historial', 8);

  const { data } = await sb
    .from('rutas')
    .select(`
      id, fecha, estado, created_at,
      usuarios(nombre),
      entregas(id, estado, monto_cobrado, pedidos(total))
    `)
    .eq('empresa_id', empresaId)
    .order('fecha', { ascending: false })
    .limit(60);

  const tbody = document.getElementById('tabla-historial');
  if (!tbody) return;

  if (!data?.length) {
    window.mostrarEstadoVacio('tabla-historial', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
      titulo: 'Sin rutas en el historial',
      descripcion: 'Aún no se han creado rutas históricas.',
    });
    return;
  }

  window.renderTbody(tbody, data, (r) => {
    const tot = r.entregas?.length || 0;
    const ent = r.entregas?.filter(e => e.estado === 'entregado').length || 0;
    const noE = r.entregas?.filter(e => e.estado === 'no_entregado').length || 0;
    return `<tr>
      <td data-label="Fecha">${window.formatFecha(r.fecha)}</td>
      <td data-label="Chofer">${avatarChofer(r.usuarios?.nombre)}</td>
      <td data-label="Pedidos">${tot}</td>
      <td data-label="Entregados" style="color:var(--color-success);">${ent}</td>
      <td data-label="No entregados" style="color:var(--color-danger);">${noE}</td>
      <td data-label="Total">${celdaTotalRuta(r.entregas)}</td>
      <td data-label="Estado">${chipEstadoRuta(r.estado)}</td>
      <td data-label=""></td>
    </tr>`;
  }, 8);
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function mostrarTab(tab) {
  ['resumen', 'armar', 'seguimiento', 'historial', 'zonas', 'reporte'].forEach(t => {
    const content = document.getElementById(`tab-${t}-content`);
    const btn     = document.getElementById(`tab-${t}`);
    if (content) content.classList.toggle('hidden', t !== tab);
    if (btn)     btn.classList.toggle('active', t === tab);
  });
  if (tab === 'historial')   cargarHistorial();
  if (tab === 'seguimiento') poblarSelectorSeguimiento();
  if (tab === 'reporte')     cargarReporteRuta();
  if (tab === 'zonas' && window.cargarZonas) window.cargarZonas();
  if (tab === 'resumen' && window.cargarResumenRepartos) window.cargarResumenRepartos();
  if (tab === 'resumen' && window.animarCamionResumen) window.animarCamionResumen();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function chipEstadoRuta(e) {
  const map = { pendiente: 'chip-pendiente', en_camino: 'chip-en-camino', completada: 'chip-completada', cancelada: 'chip-cancelada' };
  const label = { pendiente: 'Pendiente', en_camino: 'En camino', completada: 'Completada', cancelada: 'Cancelada' };
  return `<span class="chip ${map[e] || 'chip-pendiente'}">${label[e] || e}</span>`;
}

function capEstado(e) {
  const m = { pendiente:'Pendiente', en_camino:'En camino', entregado:'Entregado', no_entregado:'No entregado', parcial:'Parcial', cancelada:'Cancelada', completada:'Completada' };
  return m[e] || e;
}



function limpiarTel(t) {
  if (!t) return '';
  let l = String(t).replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (!l.startsWith('549') && l.length <= 10) l = '549' + l.replace(/^0/, '');
  return l;
}

function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

function cerrarSesion() {
  sb.auth.signOut().then(() => window.location.href = '/admin/login');
}

// Cerrar modal con Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') cerrarModalEntrega();
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-3: Rutas Dinámicas — Suscripción Realtime + Agregar Entrega Urgente
// ═══════════════════════════════════════════════════════════════════════════

let _rutaEnVivoId     = null;
let _realtimeChannel  = null;

/**
 * Abre una suscripción Realtime a la ruta activa para actualizar el mapa
 * y la lista de entregas en tiempo real cuando el chofer cambia posición.
 * @param {string} rutaId  UUID de la ruta
 */
function suscribirRutaEnVivo(rutaId) {
  if (_realtimeChannel) {
    sb.removeChannel(_realtimeChannel);
    _realtimeChannel = null;
  }
  _rutaEnVivoId = rutaId;

  _realtimeChannel = sb.channel(`ruta-live-${rutaId}`)
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'rutas',
      filter: `id=eq.${rutaId}`
    }, async (payload) => {
      const nueva = payload.new || {};
      actualizarMarcadorChofer(nueva.chofer_lat, nueva.chofer_lng);
    })
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'entregas',
      filter: `ruta_id=eq.${rutaId}`
    }, async () => {
      await actualizarEstadoEntregas(rutaId);
    })
    .subscribe();
}

function actualizarMarcadorChofer(lat, lng) {
  if (!lat || !lng) return;

  // Actualizar marcador en el mapa si existe (Leaflet / Google Maps / div)
  const markerEl = document.getElementById('marcador-chofer');
  if (markerEl) {
    markerEl.dataset.lat = lat;
    markerEl.dataset.lng = lng;
    markerEl.style.display = '';
  }
  // Actualizar texto de posición
  const posEl = document.getElementById('chofer-posicion');
  if (posEl) posEl.textContent = `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

async function actualizarEstadoEntregas(rutaId) {
  try {
    const resp = await fetch(`/api/rutas-live?accion=estado&ruta_id=${rutaId}`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });
    if (!resp.ok) return;
    const { ruta } = await resp.json();

    const lista = document.getElementById('lista-entregas-live');
    if (!lista || !ruta?.entregas) return;

    const frag = document.createDocumentFragment();
    for (const e of ruta.entregas.sort((a, b) => a.orden - b.orden)) {
      const div = document.createElement('div');
      div.className = `entrega-live entrega-${e.estado}`;
      div.innerHTML = `
        <span class="entrega-orden">#${e.orden}</span>
        <span class="entrega-cliente">${esc(e.pedidos?.clientes?.razon_social || '—')}</span>
        <span class="entrega-dir">${esc(e.pedidos?.clientes?.domicilio || '')}</span>
        <span class="entrega-estado badge badge--${e.estado}">${e.estado}</span>
      `;
      frag.appendChild(div);
    }
    lista.innerHTML = '';
    lista.appendChild(frag);
  } catch (err) {
    console.error('[Rutas Live] actualizarEstadoEntregas:', err);
  }
}

/**
 * Agrega una entrega urgente a una ruta en curso y la re-optimiza.
 * @param {string} rutaId    UUID de la ruta activa
 * @param {string} pedidoId  UUID del pedido a insertar
 */
async function agregarEntregaUrgente(rutaId, pedidoId) {
  try {
    const resp = await fetch('/api/rutas-live?accion=agregar-urgente', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
      },
      body: JSON.stringify({ ruta_id: rutaId, pedido_id: pedidoId })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al agregar entrega');
    window.toast('Entrega urgente agregada y ruta re-optimizada');
    return data;
  } catch (err) {
    console.error(err);
    window.toast('No se pudo agregar la entrega urgente a la ruta', 'error');
    throw err;
  }
}

// Helper de auth token — usa la variable global del auth.js
function getToken() {
  return window.authCtx?.session?.access_token || '';
}

// ══════════════════════════════════════════════════════════════════════════
// Invitar chofer — link de activación de acceso a /chofer (sin tener que
// asignarle email+password a mano desde Usuarios). Ver lib/handlers/chofer_invitacion.js.
// ══════════════════════════════════════════════════════════════════════════
async function cambiarTipoInvitacion() {
  const esNuevo = document.querySelector('input[name="invitar-tipo"]:checked').value === 'nuevo';
  document.getElementById('invitar-campos-nuevo').style.display = esNuevo ? 'block' : 'none';
  document.getElementById('invitar-campos-existente').style.display = esNuevo ? 'none' : 'block';

  if (!esNuevo) {
    // Todos los choferes ya cargados (activos e inactivos), no solo los del select de ruta
    const sel = document.getElementById('invitar-chofer-existente');
    sel.innerHTML = '<option>Cargando...</option>';
    const { data } = await sb
      .from('usuarios')
      .select('id, nombre, telefono')
      .eq('empresa_id', empresaId)
      .eq('rol', 'chofer')
      .order('nombre');
    sel.innerHTML = (data || []).map(c =>
      `<option value="${c.id}">${c.nombre}${c.telefono ? '' : ' (sin teléfono)'}</option>`
    ).join('') || '<option value="">No hay choferes cargados</option>';
  }
}

function abrirModalInvitarChofer() {
  document.getElementById('invitar-nombre').value = '';
  document.getElementById('invitar-telefono').value = '';
  document.getElementById('invitar-resultado').style.display = 'none';
  document.querySelector('input[name="invitar-tipo"][value="nuevo"]').checked = true;
  cambiarTipoInvitacion();
  document.getElementById('modal-invitar-chofer').classList.remove('hidden');
}

function cerrarModalInvitarChofer() {
  document.getElementById('modal-invitar-chofer').classList.add('hidden');
}

async function generarInvitacionChofer() {
  const btn = document.getElementById('btn-generar-invitacion');
  const esNuevo = document.querySelector('input[name="invitar-tipo"]:checked').value === 'nuevo';

  let body, accion;
  if (esNuevo) {
    const nombre = document.getElementById('invitar-nombre').value.trim();
    const telefono = document.getElementById('invitar-telefono').value.trim();
    if (!nombre || !telefono) { window.toast('Completá nombre y teléfono'); return; }
    accion = 'invitar-nuevo';
    body = { nombre, telefono };
  } else {
    const usuario_id = document.getElementById('invitar-chofer-existente').value;
    if (!usuario_id) { window.toast('Seleccioná un chofer'); return; }
    accion = 'invitar-existente';
    body = { usuario_id };
  }

  btn.disabled = true; btn.textContent = 'Generando...';
  try {
    const resp = await fetch(`/api/chofer-invitacion?accion=${accion}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'No se pudo generar la invitación');

    // El chofer nuevo ya quedó registrado y activo (rol chofer) en este mismo
    // paso — no hace falta esperar a que acepte la invitación para asignarle
    // una ruta. Se refresca el selector de "Armar ruta" para que aparezca
    // de inmediato, sin recargar la página.
    const textoEl = document.getElementById('invitar-resultado-texto');
    if (textoEl) {
      // Se reescribe el texto completo (incluye los días de validez inline),
      // por eso ya no se toca el <span id="invitar-dias"> por separado: ese
      // span vivía DENTRO de este mismo contenedor, así que pisarlo con
      // textContent lo elimina del DOM — escribirle después tiraba
      // "Cannot set properties of null (setting 'textContent')".
      textoEl.textContent = esNuevo
        ? `Chofer registrado y ya disponible para asignar rutas. Mandale este link para que active su acceso a la app — vence en ${data.dias_validez} días.`
        : `Invitación generada. Vence en ${data.dias_validez} días.`;
    }
    document.getElementById('invitar-link-wa').href = data.waLink;
    document.getElementById('invitar-resultado').style.display = 'block';
    window.toast(esNuevo ? 'Chofer registrado' : 'Invitación generada');

    if (esNuevo) await cargarChoferes();
  } catch (err) {
    window.toast(err.message || 'No se pudo generar la invitación', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Generar invitación';
  }
}

window.abrirModalInvitarChofer  = abrirModalInvitarChofer;
window.cerrarModalInvitarChofer = cerrarModalInvitarChofer;
window.cambiarTipoInvitacion    = cambiarTipoInvitacion;
window.generarInvitacionChofer  = generarInvitacionChofer;

// Exponer en window para llamadas desde HTML
window.agregarEntregaUrgente = agregarEntregaUrgente;
window.suscribirRutaEnVivo   = suscribirRutaEnVivo;


// ══════════════════════════════════════════════════════════════════════════
// TAB: Reporte de ruta — usa tabla reportes_ruta + entregas
// ══════════════════════════════════════════════════════════════════════════

let _reporteMapaLeaflet  = null;
let _reporteMapaMarkers  = [];
let _reportesCache       = [];   // cache de todos los reportes cargados

/**
 * Carga el listado de reportes_ruta para el período seleccionado
 * y puebla el selector de rutas + la tabla resumen.
 */
async function cargarReporteRuta() {
  const desde = document.getElementById('reporte-desde')?.value;
  const hasta = document.getElementById('reporte-hasta')?.value;
  const label = document.getElementById('label-reportes');
  const tbody = document.getElementById('tabla-reportes-ruta');

  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--color-text-light);">Cargando...</td></tr>';
  if (label) label.textContent = 'Cargando...';

  let query = sb
    .from('reportes_ruta')
    .select(`
      id, total_paradas, entregadas, no_entregadas, km_estimados,
      tiempo_total_min, pct_completitud, generado_en,
      rutas(id, fecha, estado, chofer_lat, chofer_lng),
      usuarios!chofer_id(nombre)
    `)
    .eq('empresa_id', empresaId)
    .order('generado_en', { ascending: false })
    .limit(100);

  if (desde) query = query.gte('generado_en', desde);
  if (hasta) query = query.lte('generado_en', hasta + 'T23:59:59');

  const { data, error } = await query;

  if (error) {
    console.error('[REPORTE-RUTA] Error:', error);
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--color-danger);">Error al cargar reportes: ${esc(error.message)}</td></tr>`;
    return;
  }

  _reportesCache = data || [];
  renderTablaReportes(_reportesCache);
  poblarSelectorReporte(_reportesCache);
}

function poblarSelectorReporte(reportes) {
  const sel = document.getElementById('sel-ruta-reporte');
  if (!sel) return;
  const valPrev = sel.value;
  sel.innerHTML = '<option value="">Seleccionar ruta completada...</option>';
  reportes.forEach(r => {
    const fecha  = r.rutas?.fecha ? window.formatFecha(r.rutas.fecha) : '—';
    const chofer = r.usuarios?.nombre || 'Sin chofer';
    const pct    = r.pct_completitud != null ? `${Number(r.pct_completitud).toFixed(0)}%` : '';
    const o      = document.createElement('option');
    o.value       = r.rutas?.id || '';
    o.dataset.rid = r.id;
    o.textContent = `${fecha} — ${chofer}${pct ? ` (${pct})` : ''}`;
    sel.appendChild(o);
  });
  if (valPrev) sel.value = valPrev;
}

function renderTablaReportes(reportes) {
  const tbody = document.getElementById('tabla-reportes-ruta');
  const label = document.getElementById('label-reportes');
  if (!tbody) return;

  if (label) label.textContent = `${reportes.length} reporte${reportes.length !== 1 ? 's' : ''}`;

  if (!reportes.length) {
    window.mostrarEstadoVacio('tabla-reportes-ruta', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
      titulo: 'Sin reportes generados',
      descripcion: 'Los reportes se generan al cerrar una ruta completada.',
    });
    return;
  }

  window.renderTbody(tbody, reportes, (r) => {
    const fecha     = r.rutas?.fecha ? window.formatFecha(r.rutas.fecha) : '—';
    const chofer    = esc(r.usuarios?.nombre || '—');
    const pct       = r.pct_completitud != null ? `${Number(r.pct_completitud).toFixed(0)}%` : '—';
    const kmStr     = r.km_estimados != null ? `${Number(r.km_estimados).toFixed(1)} km` : '—';
    const minStr    = r.tiempo_total_min != null
                        ? `${Math.floor(r.tiempo_total_min / 60)}h ${r.tiempo_total_min % 60}m`
                        : '—';
    const pctClass  = r.pct_completitud >= 90 ? 'color:var(--color-success);font-weight:700;'
                    : r.pct_completitud >= 70 ? 'color:var(--color-warning);font-weight:700;'
                    : 'color:var(--color-danger);font-weight:700;';
    const rutaId    = r.rutas?.id || '';

    return `<tr style="cursor:pointer;" onclick="verDetalleReportePorId('${rutaId}')">
      <td data-label="Fecha"><strong>${fecha}</strong></td>
      <td data-label="Chofer">${chofer}</td>
      <td data-label="Paradas">${r.total_paradas ?? '—'}</td>
      <td data-label="Entregadas" style="color:var(--color-success);font-weight:600;">${r.entregadas ?? '—'}</td>
      <td data-label="No entregadas" style="color:var(--color-danger);">${r.no_entregadas ?? '—'}</td>
      <td data-label="KM">${kmStr}</td>
      <td data-label="Tiempo">${minStr}</td>
      <td data-label="Completitud" style="${pctClass}">${pct}</td>
      <td data-label="">
        <button class="btn btn--ghost" style="padding:4px 10px;font-size:12px;" onclick="event.stopPropagation();verDetalleReportePorId('${rutaId}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Ver
        </button>
      </td>
    </tr>`;
  }, 9);
}

/**
 * Ver detalle de un reporte al hacer clic en la tabla.
 * Selecciona la ruta en el dropdown y carga el detalle.
 */
function verDetalleReportePorId(rutaId) {
  const sel = document.getElementById('sel-ruta-reporte');
  if (sel) { sel.value = rutaId; }
  cargarDetalleReporte();
  // Scroll al mapa
  const detalle = document.getElementById('reporte-detalle');
  if (detalle) detalle.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Carga el detalle completo de una ruta seleccionada:
 * KPI cards + mapa + tabla de entregas individuales.
 */
async function cargarDetalleReporte() {
  const sel    = document.getElementById('sel-ruta-reporte');
  const rutaId = sel?.value;

  const kpisEl   = document.getElementById('reporte-kpis');
  const detalle  = document.getElementById('reporte-detalle');

  if (!rutaId) {
    if (kpisEl)  kpisEl.classList.add('hidden');
    if (detalle) detalle.classList.add('hidden');
    return;
  }

  // Buscar el reporte en cache
  const reporte = _reportesCache.find(r => r.rutas?.id === rutaId);

  // Mostrar KPIs
  if (kpisEl && reporte) {
    kpisEl.classList.remove('hidden');
    const pct = reporte.pct_completitud != null ? `${Number(reporte.pct_completitud).toFixed(1)}%` : '—';
    const min = reporte.tiempo_total_min != null
                  ? `${Math.floor(reporte.tiempo_total_min / 60)}h ${reporte.tiempo_total_min % 60}m`
                  : '—';
    document.getElementById('kpi-completitud').textContent  = pct;
    document.getElementById('kpi-entregadas').textContent   = reporte.entregadas ?? '—';
    document.getElementById('kpi-no-entregadas').textContent = reporte.no_entregadas ?? '—';
    document.getElementById('kpi-tiempo').textContent       = min;
    document.getElementById('kpi-km').textContent           = reporte.km_estimados != null ? `${Number(reporte.km_estimados).toFixed(1)} km` : '—';
    document.getElementById('kpi-paradas').textContent      = reporte.total_paradas ?? '—';
  }

  // Cargar entregas de la ruta para mapa + tabla
  const { data: entregas, error } = await sb
    .from('entregas')
    .select(`
      id, orden, estado, receptor, notas_entrega, fecha_confirmacion,
      pedidos(id, total, ubicacion_entrega, clientes(razon_social, domicilio, localidad, telefono, lat, lng))
    `)
    .eq('ruta_id', rutaId)
    .order('orden');

  if (error) {
    console.error('[REPORTE-RUTA] Error cargando entregas:', error);
    return;
  }

  if (detalle) detalle.classList.remove('hidden');

  // Tabla de entregas
  renderTablaEntregasReporte(entregas || []);

  // Mapa con posición del chofer + puntos de entrega
  const rutaData = reporte?.rutas || null;
  inicializarMapaReporte(entregas || [], rutaData);
}

function renderTablaEntregasReporte(entregas) {
  const tbody = document.getElementById('tabla-reporte-entregas');
  const sub   = document.getElementById('reporte-entregas-sub');
  if (!tbody) return;

  const entregadas   = entregas.filter(e => e.estado === 'entregado').length;
  const noEntregadas = entregas.filter(e => e.estado === 'no_entregado').length;
  if (sub) sub.textContent = `${entregadas} entregadas · ${noEntregadas} no entregadas · ${entregas.length} total`;

  if (!entregas.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--color-text-light);">Sin entregas registradas para esta ruta</td></tr>';
    return;
  }

  window.renderTbody(tbody, entregas, (e) => {
    const estadoChip = e.estado === 'entregado'
      ? `<span class="chip chip-completada">Entregado</span>`
      : e.estado === 'no_entregado'
      ? `<span class="chip chip-cancelada">No entregado</span>`
      : e.estado === 'en_camino'
      ? `<span class="chip chip-en-camino">En camino</span>`
      : `<span class="chip chip-pendiente">Pendiente</span>`;

    const hora = e.fecha_confirmacion
      ? new Date(e.fecha_confirmacion).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : '—';

    return `<tr>
      <td data-label="#"><strong>${e.orden ?? '—'}</strong></td>
      <td data-label="Cliente">${esc(e.pedidos?.clientes?.razon_social || '—')}</td>
      <td data-label="Dirección" style="font-size:12px;color:var(--color-text-muted);">${esc(e.pedidos?.clientes?.domicilio || e.pedidos?.clientes?.localidad || '—')}</td>
      <td data-label="Estado">${estadoChip}</td>
      <td data-label="Hora" style="font-size:12px;color:var(--color-text-light);">${hora}</td>
      <td data-label="Recibió" style="font-size:12px;">${esc(e.receptor || '—')}</td>
    </tr>`;
  }, 6);
}

/**
 * Inicializa el mapa Leaflet del reporte con:
 * - Marcadores de cada entrega (coloreados por estado)
 * - Marcador del chofer (posición final guardada en rutas.chofer_lat/lng)
 */
function inicializarMapaReporte(entregas, rutaData) {
  const contenedor = document.getElementById('mapa-reporte');
  if (!contenedor) return;

  // Determinar puntos a mostrar: ubicacion_entrega o lat/lng de cliente
  const puntos = entregas.map(e => {
    const ub = e.pedidos?.ubicacion_entrega;
    const cl = e.pedidos?.clientes;
    const lat = ub?.lat || cl?.lat;
    const lng = ub?.lng || cl?.lng;
    return { ...e, _lat: lat, _lng: lng };
  }).filter(p => p._lat && p._lng);

  const choferLat = rutaData?.chofer_lat;
  const choferLng = rutaData?.chofer_lng;
  const tieneChofer = choferLat && choferLng;
  const sub = document.getElementById('reporte-mapa-sub');

  if (!puntos.length && !tieneChofer) {
    contenedor.innerHTML = `
      <div style="height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:var(--color-text-light);font-size:14px;padding:40px;">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <span>Sin ubicaciones GPS registradas para esta ruta</span>
        <span style="font-size:12px;max-width:280px;text-align:center;">Las ubicaciones se registran cuando el chofer confirma cada entrega desde la app</span>
      </div>`;
    if (sub) sub.textContent = 'Sin ubicaciones registradas';
    if (_reporteMapaLeaflet) { _reporteMapaLeaflet.remove(); _reporteMapaLeaflet = null; }
    return;
  }

  // Inicializar o reusar mapa
  if (_reporteMapaLeaflet) {
    _reporteMapaLeaflet.remove();
    _reporteMapaLeaflet = null;
  }
  contenedor.innerHTML = '';
  _reporteMapaLeaflet = L.map(contenedor, { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(_reporteMapaLeaflet);

  _reporteMapaMarkers.forEach(m => m.remove());
  _reporteMapaMarkers = [];

  const colores = { entregado: '#1F5B4A', no_entregado: '#B3261E', pendiente: '#8F5F00', en_camino: '#2E6088' };
  const bounds  = [];

  // Marcadores de entregas
  puntos.forEach((e) => {
    const color   = colores[e.estado] || colores.pendiente;
    const cliente = esc(e.pedidos?.clientes?.razon_social || 'Cliente');
    const dir     = esc(e.pedidos?.clientes?.domicilio || '');
    const hora    = e.fecha_confirmacion
      ? new Date(e.fecha_confirmacion).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' })
      : '';

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;">${e.orden ?? '•'}</div>`,
      iconSize:   [30, 30],
      iconAnchor: [15, 15],
    });

    const marker = L.marker([e._lat, e._lng], { icon })
      .bindPopup(`
        <div style="min-width:160px;">
          <strong>${cliente}</strong><br>
          ${dir ? `${dir}<br>` : ''}
          Estado: <b style="color:${color};">${capEstado(e.estado)}</b>
          ${hora ? `<br>Hora: ${hora}` : ''}
          ${e.receptor ? `<br>Recibió: ${esc(e.receptor)}` : ''}
        </div>
      `)
      .addTo(_reporteMapaLeaflet);

    _reporteMapaMarkers.push(marker);
    bounds.push([e._lat, e._lng]);
  });

  // Marcador del chofer (posición final)
  if (tieneChofer) {
    const choferIcon = L.divIcon({
      className: '',
      html: `<div style="width:34px;height:34px;border-radius:50%;background:var(--color-info-mid,#2E6088);border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3"/><rect x="9" y="11" width="14" height="10" rx="1"/></svg>
             </div>`,
      iconSize:   [34, 34],
      iconAnchor: [17, 17],
    });

    const choferMarker = L.marker([parseFloat(choferLat), parseFloat(choferLng)], { icon: choferIcon })
      .bindPopup('<strong>Última posición del chofer</strong><br>Registrada al cerrar la ruta.')
      .addTo(_reporteMapaLeaflet);

    _reporteMapaMarkers.push(choferMarker);
    bounds.push([parseFloat(choferLat), parseFloat(choferLng)]);
  }

  if (bounds.length > 0) {
    _reporteMapaLeaflet.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }

  if (sub) sub.textContent = `${puntos.length} punto${puntos.length !== 1 ? 's' : ''} de entrega${tieneChofer ? ' + posición del chofer' : ''}`;
}

// ── Exposición global requerida por type="module" ──────────────────────────
window.cargarSeguimiento   = cargarSeguimiento;
window.abrirModalEntrega   = abrirModalEntrega;
window.cerrarModalEntrega  = cerrarModalEntrega;
window.marcarCobroParcialResuelto = marcarCobroParcialResuelto;
window.confirmarRuta       = confirmarRuta;
window.guardarRutaBorrador = guardarRutaBorrador;
window.limpiarRuta         = limpiarRuta;
window.mostrarTab          = mostrarTab;
window.imprimirRemitoDesdeRuta = (typeof imprimirRemitoDesdeRuta !== 'undefined') ? imprimirRemitoDesdeRuta : function(){};
window.filtrarPendientes   = filtrarPendientes;
// Funciones usadas en onclick dinámico (renderPendientes / renderRuta)
window.agregarALaRuta      = agregarALaRuta;
window.quitarDeRuta        = quitarDeRuta;
window.cancelarRuta        = cancelarRuta;
window.cargarDatos         = cargarDatos;
window.cargarReporteRuta   = cargarReporteRuta;
window.cargarDetalleReporte = cargarDetalleReporte;
window.verDetalleReportePorId = verDetalleReportePorId;
// Drag & drop
window.onDragOver          = onDragOver;
window.onDragLeave         = onDragLeave;
window.onDrop              = onDrop;
window.onDragStart         = onDragStart;

