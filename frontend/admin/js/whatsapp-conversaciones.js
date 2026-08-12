// frontend/admin/js/whatsapp-conversaciones.js
// Panel admin de conversaciones de WhatsApp (Etapa 5 — asistente bidireccional).
//
// Lectura (listado + historial de mensajes): directo por Supabase client,
// RLS ya scopea todo por empresa_id (migración 247) — mismo criterio que
// notif-log.js con notif_log.
//
// Escritura (tomar/liberar una conversación derivada a un humano): pasa
// SIEMPRE por /api/notif/whatsapp-conversacion-accion, porque a propósito
// no hay policy de UPDATE para whatsapp_conversaciones (ver migración 271).
//
// v_whatsapp_conversaciones_activas expone:
//   id, empresa_id, cliente_id, cliente_nombre, telefono, estado,
//   pedido_borrador, motivo_derivacion, tomada_por, tomada_por_nombre,
//   tomada_en, ultima_interaccion, cant_mensajes

// ── Estado ────────────────────────────────────────────────────────────────
let sb          = null;
let empresaId   = null;
let perfil      = null;
let datos       = [];      // conversaciones cargadas
let datosVista  = [];      // después de aplicar filtros
let convActual  = null;    // conversación abierta en el modal
let pollingId   = null;
let waEstado    = 'desconocido'; // 'conectado' | 'no_conectado' | 'desconocido'
// 'desconocido' cubre roles sin permiso para leer empresa_whatsapp (solo
// dueño/admin tienen policy de SELECT ahí, ver migración de esa tabla) —
// en ese caso no mostramos ningún mensaje sobre conexión, solo "sin
// conversaciones", para no afirmar algo que no pudimos verificar.

const POLL_MS = 30_000;

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady.catch(() => {});
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }

  sb        = window.authCtx.sb;
  empresaId = window.authCtx.perfil.empresa_id;
  perfil    = window.authCtx.perfil;

  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  initFiltroTabsWhatsapp();
  await cargarEstadoWhatsapp();
  await cargarConversaciones();
  iniciarPolling();

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') cerrarModalConv();
  });
  document.getElementById('modal-conv').addEventListener('click', function (e) {
    if (e.target === this) cerrarModalConv();
  });
  window.addEventListener('beforeunload', () => { if (pollingId) clearInterval(pollingId); });
});

// ── Estado de conexión de WhatsApp (para diferenciar "no conectado" de
// "conectado pero sin conversaciones todavía" en la tabla vacía) ──────────
async function cargarEstadoWhatsapp() {
  const { data, error } = await sb
    .from('v_empresa_whatsapp_estado')
    .select('phone_number_id, desconectado_en, necesita_reconexion')
    .eq('empresa_id', empresaId)
    .maybeSingle();

  if (error) {
    // Rol sin policy de lectura (vendedor/chofer, etc.) u otro error —
    // no lo tratamos como "no conectado", simplemente no lo sabemos.
    waEstado = 'desconocido';
    return;
  }

  waEstado = (data && data.phone_number_id && !data.desconectado_en)
    ? 'conectado'
    : 'no_conectado';
}

// ── Carga del listado ──────────────────────────────────────────────────────
async function cargarConversaciones() {
  const { data, error } = await sb
    .from('v_whatsapp_conversaciones_activas')
    .select('*')
    .eq('empresa_id', empresaId)
    .order('ultima_interaccion', { ascending: false });

  if (error) {
    console.error('[WHATSAPP-CONV] Error cargando:', error);
    mostrarToast('Error al cargar las conversaciones');
    return;
  }

  datos = data || [];
  aplicarFiltros();
  actualizarStats();

  // Si hay un modal abierto, refrescar su fila (por si cambió tomada_por
  // desde otra sesión) sin cerrarlo ni interrumpir la lectura del chat.
  if (convActual) {
    const actualizada = datos.find(c => c.id === convActual.id);
    if (actualizada) {
      convActual = actualizada;
      renderAccionesModal();
      document.getElementById('modal-conv-meta').innerHTML = metaHtml(actualizada);
      document.getElementById('modal-conv-borrador').innerHTML = borradorHtml(actualizada);
      // FIX: este poll (cada 30s) actualizaba meta/estado pero nunca
      // volvía a traer los mensajes — si el cliente escribía de nuevo
      // mientras un vendedor tenía el modal abierto, el mensaje quedaba
      // guardado en la base pero invisible en el chat hasta cerrar y
      // volver a abrir el modal a mano.
      await refrescarChatModal(actualizada.id);
    }
  }
}

function iniciarPolling() {
  if (pollingId) clearInterval(pollingId);
  pollingId = setInterval(() => {
    cargarConversaciones().catch(() => { /* silencioso — no interrumpir el panel */ });
  }, POLL_MS);
}

// ── Filtros (cliente-side sobre datos ya cargados) ─────────────────────────
function aplicarFiltros() {
  const q         = (document.getElementById('buscar-conv').value || '').toLowerCase().trim();
  const estado    = document.getElementById('filtro-estado').value;
  const sinTomar  = document.getElementById('filtro-sin-tomar').checked;

  datosVista = datos.filter(c => {
    if (estado && c.estado !== estado) return false;
    if (sinTomar && !(c.estado === 'derivada_humano' && !c.tomada_por)) return false;
    if (q) {
      const nombre = (c.cliente_nombre || '').toLowerCase();
      const tel    = (c.telefono || '').toLowerCase();
      if (!nombre.includes(q) && !tel.includes(q)) return false;
    }
    return true;
  });

  renderTabla();
}

function limpiarFiltros() {
  document.getElementById('buscar-conv').value = '';
  document.getElementById('filtro-estado').value = '';
  document.getElementById('filtro-sin-tomar').checked = false;
  const cont = document.getElementById('filtro-tabs-whatsapp');
  cont.querySelectorAll('.filtro-tab').forEach(b => { b.classList.remove('activa'); b.setAttribute('aria-selected', 'false'); });
  const _tabTodas = cont.querySelector('[data-key="todas"]');
  if (_tabTodas) { _tabTodas.classList.add('activa'); _tabTodas.setAttribute('aria-selected', 'true'); }
  aplicarFiltros();
}

// ── Render tabla ────────────────────────────────────────────────────────────
function renderTabla() {
  const tbody = document.getElementById('tbody-conv');

  if (datosVista.length === 0) {
    // Sin filtros activos y sin ninguna conversación cargada: si además
    // sabemos que el WhatsApp de la empresa no está conectado, el mensaje
    // genérico de "sin conversaciones" confunde (parece que la página no
    // cargó datos, cuando en realidad nunca hubo nada que traer). Mostramos
    // un mensaje distinto con el link para conectarlo.
    const sinFiltros = datos.length === 0
      && !(document.getElementById('buscar-conv').value || '').trim()
      && !document.getElementById('filtro-estado').value
      && !document.getElementById('filtro-sin-tomar').checked;

    if (sinFiltros && waEstado === 'no_conectado') {
      tbody.innerHTML = `<tr><td colspan="7" class="sin-resultados">
        WhatsApp no está conectado todavía para esta empresa.
        <a href="/admin/whatsapp-onboarding">Conectar WhatsApp</a>
      </td></tr>`;
    } else {
      tbody.innerHTML = `<tr><td colspan="7" class="sin-resultados">Sin conversaciones para los filtros actuales</td></tr>`;
    }
    document.getElementById('lbl-count').textContent = '0 conversaciones';
    return;
  }

  tbody.innerHTML = datosVista.map((c, idx) => {
    const nombre  = esc(c.cliente_nombre || c.telefono || 'Sin nombre');
    const tel     = esc(c.telefono || '—');
    const estado  = badgeEstado(c.estado);
    const msjs    = c.cant_mensajes ?? 0;
    const fecha   = formatFechaHora(c.ultima_interaccion);
    const atencion = badgeAtencion(c);
    const accion  = botonAccion(c);

    return `<tr class="fila-conv" onclick="abrirDetallePorIndice(${idx})">
      <td class="cliente-cell" title="${nombre}">${nombre}</td>
      <td>${tel}</td>
      <td>${estado}</td>
      <td>${msjs}</td>
      <td style="white-space:nowrap;">${fecha}</td>
      <td>${atencion}</td>
      <td class="col-sticky-end">${accion}</td>
    </tr>`;
  }).join('');

  document.getElementById('lbl-count').textContent =
    `${datosVista.length} conversación${datosVista.length !== 1 ? 'es' : ''}${datos.length > datosVista.length ? ' (filtradas de ' + datos.length + ')' : ''}`;
}

function initFiltroTabsWhatsapp() {
  FiltroTabs.crear(document.getElementById('filtro-tabs-whatsapp'), [
    { key: 'todas',       label: 'Total activas' },
    { key: 'activa',      label: 'Bot conversando' },
    { key: 'esperando_confirmacion', label: 'Esperando confirmación' },
    { key: 'derivada_humano',        label: 'Derivadas' },
    { key: 'sin_tomar',   label: 'Derivadas sin tomar' },
  ], 'todas', (key) => {
    if (key === 'sin_tomar') {
      document.getElementById('filtro-estado').value = 'derivada_humano';
      document.getElementById('filtro-sin-tomar').checked = true;
    } else {
      document.getElementById('filtro-estado').value = key === 'todas' ? '' : key;
      document.getElementById('filtro-sin-tomar').checked = false;
    }
    aplicarFiltros();
  });
}

function actualizarStats() {
  const total      = datos.length;
  const activa     = datos.filter(c => c.estado === 'activa').length;
  const esperando  = datos.filter(c => c.estado === 'esperando_confirmacion').length;
  const derivadas  = datos.filter(c => c.estado === 'derivada_humano').length;
  const sinTomar   = datos.filter(c => c.estado === 'derivada_humano' && !c.tomada_por).length;

  FiltroTabs.actualizarContadores(document.getElementById('filtro-tabs-whatsapp'), {
    todas: total,
    activa: activa,
    esperando_confirmacion: esperando,
    derivada_humano: derivadas,
    sin_tomar: sinTomar,
  });
}

// ── Modal de detalle ────────────────────────────────────────────────────────
function abrirDetallePorIndice(idx) {
  const c = datosVista[idx];
  if (!c) return;
  abrirDetalle(c);
}

async function abrirDetalle(c) {
  convActual = c;
  document.getElementById('modal-conv-titulo').textContent = c.cliente_nombre || c.telefono || 'Conversación';
  document.getElementById('modal-conv-meta').innerHTML = metaHtml(c);
  document.getElementById('modal-conv-borrador').innerHTML = borradorHtml(c);
  document.getElementById('modal-conv-chat').innerHTML = `<span class="sin-resultados">Cargando mensajes...</span>`;
  renderAccionesModal();
  document.getElementById('modal-conv').classList.remove('hidden');
  await refrescarChatModal(c.id);
}

// Trae los mensajes de una conversación y repinta el chat del modal — usada
// tanto al abrir el modal como en cada ciclo de polling mientras sigue
// abierto, para que un mensaje nuevo del cliente aparezca solo sin tener
// que cerrar y volver a abrir (ver FIX en cargarConversaciones).
async function refrescarChatModal(conversacionId) {
  const cont = document.getElementById('modal-conv-chat');
  const scrolleadoAlFondo = cont.scrollHeight - cont.scrollTop - cont.clientHeight < 40;

  const { data, error } = await sb
    .from('whatsapp_mensajes')
    .select('id, direccion, texto, tipo, created_at')
    .eq('conversacion_id', conversacionId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[WHATSAPP-CONV] Error cargando mensajes:', error);
    cont.innerHTML = `<span class="sin-resultados">No se pudo cargar el historial</span>`;
    return;
  }

  // Si el vendedor ya se había subido a leer mensajes viejos, no lo
  // arrastramos al fondo con cada poll — solo auto-scrollea si ya estaba
  // mirando el final de la charla (mismo criterio para el primer render,
  // donde scrolleadoAlFondo da true por estar vacío el contenedor).
  renderChat(data || [], scrolleadoAlFondo);
}

function cerrarModalConv() {
  document.getElementById('modal-conv').classList.add('hidden');
  convActual = null;
}

function metaHtml(c) {
  const partes = [`<strong>Teléfono:</strong> ${esc(c.telefono || '—')}`];
  if (c.motivo_derivacion) partes.push(`<strong>Motivo de derivación:</strong> ${esc(c.motivo_derivacion)}`);
  if (c.tomada_por) {
    partes.push(`<strong>Atendida por:</strong> ${esc(c.tomada_por_nombre || 'un usuario')} desde ${formatFechaHora(c.tomada_en)}`);
  }
  return partes.join(' &nbsp;·&nbsp; ');
}

function borradorHtml(c) {
  const items = c.pedido_borrador?.items;
  if (!items || !items.length) return '';
  const filas = items.map(it =>
    `<li>${esc(String(it.cantidad ?? ''))} × ${esc(it.nombre || it.producto_id || 'producto')}</li>`
  ).join('');
  const notas = c.pedido_borrador?.notas ? `<div style="margin-top:6px;">${esc(c.pedido_borrador.notas)}</div>` : '';
  return `<div class="borrador-box">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
      <strong>Borrador de pedido en curso</strong>
      <button type="button" class="btn btn--sm btn--secondary" onclick="copiarResumenBorrador()">Copiar resumen</button>
    </div>
    <ul>${filas}</ul>
    ${notas}
  </div>`;
}

function formatMonto(n) {
  return Math.round(n || 0).toLocaleString('es-AR');
}

// Arma un texto plano (mismo formato que ya usan las plantillas de WhatsApp
// salientes, ver formatMonto en lib/handlers/notif.js) para pegar directo en
// el chat del cliente desde el celular al retomar la charla — evita tener
// que retipear a mano los productos y cantidades que ya había armado el bot.
async function copiarResumenBorrador() {
  const c = convActual;
  const items = c?.pedido_borrador?.items;
  if (!items || !items.length) return;

  const filas = items.map(it => {
    const cant   = it.cantidad ?? '';
    const nombre = it.nombre || it.producto_id || 'producto';
    const precio = typeof it.precio === 'number' ? ` — $${formatMonto(it.precio * (it.cantidad || 1))}` : '';
    return `• ${cant} x ${nombre}${precio}`;
  }).join('\n');

  const tieneTotales = items.every(it => typeof it.precio === 'number');
  const total = tieneTotales
    ? `\nTotal: $${formatMonto(items.reduce((acc, it) => acc + it.precio * (it.cantidad || 1), 0))}`
    : '';
  const notas = c.pedido_borrador?.notas ? `\nNotas: ${c.pedido_borrador.notas}` : '';

  const nombreCliente = c.cliente_nombre || c.telefono || 'el cliente';
  const texto = `Pedido de ${nombreCliente} (quedó sin confirmar):\n${filas}${total}${notas}`;

  try {
    await navigator.clipboard.writeText(texto);
    mostrarToast('Resumen copiado', 'success');
  } catch (err) {
    console.error('[WHATSAPP-CONV] No se pudo copiar al portapapeles:', err);
    mostrarToast('No se pudo copiar — copialo a mano del recuadro', 'error');
  }
}

function renderChat(mensajes, scrollearAlFondo = true) {
  const cont = document.getElementById('modal-conv-chat');
  if (!mensajes.length) {
    cont.innerHTML = `<span class="sin-resultados">Sin mensajes todavía</span>`;
    return;
  }
  cont.innerHTML = mensajes.map(m => {
    const clase = m.direccion === 'in' ? 'in' : 'out';
    const hora  = formatFechaHora(m.created_at);
    if (m.tipo && m.tipo !== 'text') {
      return `<div class="burbuja ${clase} no-soportado">[${esc(m.tipo)} no soportado en este panel]<span class="hora">${hora}</span></div>`;
    }
    return `<div class="burbuja ${clase}">${esc(m.texto || '')}<span class="hora">${hora}</span></div>`;
  }).join('');
  // FIX (quedó a medio hacer en el refactor de refrescarChatModal): este
  // parámetro venía siendo pasado desde el poll pero la función lo
  // ignoraba y siempre saltaba al fondo — así que cada 30s te sacaba de
  // donde estabas leyendo. Ahora solo autoscrollea si ya estabas al pie
  // de la charla (o es el primer render, que llama con el default true).
  if (scrollearAlFondo) cont.scrollTop = cont.scrollHeight;
}

function renderAccionesModal() {
  const cont = document.getElementById('modal-conv-acciones');
  const c = convActual;
  if (!c) { cont.innerHTML = ''; return; }

  const botones = [`<button type="button" class="btn btn--secondary" onclick="cerrarModalConv()">Cerrar</button>`];

  if (c.estado === 'derivada_humano') {
    if (!c.tomada_por) {
      botones.unshift(`<button type="button" class="btn btn--primary" onclick="accionConversacion('${c.id}', 'tomar')">Tomar conversación</button>`);
    } else if (c.tomada_por === perfil.id || perfil.rol === 'dueno' || perfil.rol === 'admin') {
      botones.unshift(`<button type="button" class="btn btn--secondary" onclick="accionConversacion('${c.id}', 'liberar')">Liberar</button>`);
    }
  }

  cont.innerHTML = botones.join('');
}

// ── Acción tomar/liberar ────────────────────────────────────────────────────
async function accionConversacion(conversacionId, accion) {
  try {
    const resp = await fetch('/api/notif/whatsapp-conversacion-accion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
      body: JSON.stringify({ conversacion_id: conversacionId, accion }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      mostrarToast(data.error || 'No se pudo completar la acción', 'danger');
      return;
    }
    mostrarToast(accion === 'tomar' ? 'Conversación tomada' : 'Conversación liberada', 'success');
    await cargarConversaciones();
  } catch (err) {
    console.error('[WHATSAPP-CONV] Error en acción:', err);
    mostrarToast('Error de conexión', 'danger');
  }
}

function _token() {
  return window.authCtx?.session?.access_token || '';
}

// ── Helpers visuales ─────────────────────────────────────────────────────────
const ESTADO_LABEL = {
  activa: 'Bot conversando',
  esperando_confirmacion: 'Esperando confirmación',
  derivada_humano: 'Derivada',
};

function badgeEstado(estado) {
  return `<span class="badge-estado ${esc(estado)}">${esc(ESTADO_LABEL[estado] || estado)}</span>`;
}

function badgeAtencion(c) {
  if (c.estado !== 'derivada_humano') return '<span class="badge-libre">—</span>';
  if (c.tomada_por) return `<span class="badge-tomada">${esc(c.tomada_por_nombre || 'Tomada')}</span>`;
  return `<span class="badge-libre">Sin tomar</span>`;
}

function botonAccion(c) {
  if (c.estado !== 'derivada_humano') {
    return `<button type="button" class="btn btn--sm btn--secondary" onclick="event.stopPropagation(); abrirDetallePorIndice(${datosVista.indexOf(c)})">Ver</button>`;
  }
  if (!c.tomada_por) {
    return `<button type="button" class="btn btn--sm btn--primary" onclick="event.stopPropagation(); accionConversacion('${c.id}', 'tomar')">Tomar</button>`;
  }
  if (c.tomada_por === perfil.id || perfil.rol === 'dueno' || perfil.rol === 'admin') {
    return `<button type="button" class="btn btn--sm btn--secondary" onclick="event.stopPropagation(); accionConversacion('${c.id}', 'liberar')">Liberar</button>`;
  }
  return `<button type="button" class="btn btn--sm btn--secondary" onclick="event.stopPropagation(); abrirDetallePorIndice(${datosVista.indexOf(c)})">Ver</button>`;
}

function formatFechaHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}
