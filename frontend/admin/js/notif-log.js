// frontend/admin/js/notif-log.js
// Panel de historial de notificaciones (WhatsApp, Email, Push).
// Lee la tabla notif_log via Supabase (RLS garantiza que solo se ven
// los registros de la propia empresa).
//
// Columnas de notif_log:
//   id, empresa_id, cliente_id, pedido_id,
//   tipo, canal, telefono, email, message_id, payload, created_at
//   + JOIN clientes(razon_social), pedidos(numero)

// ── Estado ────────────────────────────────────────────────────────────────
let sb         = null;
let empresaId  = null;
let datos      = [];      // registros cargados hasta ahora
let datosVista = [];      // después del filtro de texto
let offset      = 0;
let offsetEmail = 0; // FIX (auditoría 2026, etapa 15, H2): paginación propia de email_log
const PAGE     = 50;

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady.catch(() => {});
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }

  sb        = window.authCtx.sb;
  empresaId = window.authCtx.perfil.empresa_id;

  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // Fecha por defecto: últimos 30 días
  const hoy   = new Date();
  const hace30 = new Date(hoy); hace30.setDate(hoy.getDate() - 30);
  document.getElementById('filtro-hasta').value = hoy.toISOString().split('T')[0];
  document.getElementById('filtro-desde').value = hace30.toISOString().split('T')[0];

  await cargarNotifLog();
});

// ── Carga con filtros desde la BD ─────────────────────────────────────────
// FIX (auditoría 2026, etapa 15, Hallazgo 2): este historial solo leía
// notif_log — los emails de factura emitida (enviados desde el handler de
// facturación, ~400 envíos reales) se registran en una tabla aparte,
// email_log, y nunca aparecían acá. Ahora se consultan ambas tablas, se
// normalizan al mismo formato de fila y se combinan ordenadas por fecha.
async function cargarNotifLog(resetear = true) {
  if (resetear) { datos = []; offset = 0; offsetEmail = 0; }

  const canal  = document.getElementById('filtro-canal').value;
  const tipo   = document.getElementById('filtro-tipo').value;
  const desde  = document.getElementById('filtro-desde').value;
  const hasta  = document.getElementById('filtro-hasta').value;

  // notif_log: se salta solo si el filtro de canal es explícitamente 'email'
  // (esos registros siempre están en email_log, no acá).
  let dataNotif = [];
  let huboMasNotif = false;
  if (canal !== 'email') {
    let q = sb
      .from('notif_log')
      .select(`
        id, tipo, canal, telefono, email, message_id, payload, created_at, entregada, motivo,
        clientes(razon_social),
        pedidos(id)
      `)
      .eq('empresa_id', empresaId)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1);

    if (canal)  q = q.eq('canal', canal);
    if (tipo)   q = q.eq('tipo', tipo);
    if (desde)  q = q.gte('created_at', desde + 'T00:00:00');
    if (hasta)  q = q.lte('created_at', hasta + 'T23:59:59');

    const { data, error } = await q;
    if (error) {
      console.error('[NOTIF-LOG] Error cargando notif_log:', error);
      mostrarToast('Error al cargar el historial');
      return;
    }
    dataNotif = data || [];
    huboMasNotif = dataNotif.length === PAGE;
    offset += PAGE;
  }

  // email_log: se salta si el filtro de canal es algo distinto de 'email',
  // o si el filtro de tipo es algo distinto de 'factura_emitida' (único
  // tipo que hoy se registra en esta tabla).
  let dataEmail = [];
  let huboMasEmail = false;
  const saltearEmail = (canal && canal !== 'email') || (tipo && tipo !== 'factura_emitida');
  if (!saltearEmail) {
    let qe = sb
      .from('email_log')
      .select(`id, tipo, destinatario, asunto, resend_id, created_at, cliente_id, clientes(razon_social)`)
      .eq('empresa_id', empresaId)
      .order('created_at', { ascending: false })
      .range(offsetEmail, offsetEmail + PAGE - 1);

    if (tipo)  qe = qe.eq('tipo', tipo);
    if (desde) qe = qe.gte('created_at', desde + 'T00:00:00');
    if (hasta) qe = qe.lte('created_at', hasta + 'T23:59:59');

    const { data, error } = await qe;
    if (error) {
      console.error('[NOTIF-LOG] Error cargando email_log:', error);
      // No cortamos el flujo — mostramos igual lo que se pudo traer de notif_log.
    } else {
      dataEmail = (data || []).map(normalizarFilaEmail);
      huboMasEmail = dataEmail.length === PAGE;
      offsetEmail += PAGE;
    }
  }

  const nuevos = [...dataNotif, ...dataEmail].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  if (resetear) datos = nuevos;
  else datos = [...datos, ...nuevos].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Mostrar u ocultar el botón "Cargar más": si cualquiera de las dos
  // fuentes todavía puede tener más filas, lo dejamos visible.
  document.getElementById('btn-cargar-mas').style.display =
    (huboMasNotif || huboMasEmail) ? '' : 'none';

  aplicarFiltros();
  actualizarStats();
}

// Normaliza una fila de email_log a la misma forma que usa el resto del
// panel (mismas claves que una fila de notif_log), para poder reusar
// renderTabla/exportarCSV/badges sin duplicar lógica de presentación.
function normalizarFilaEmail(r) {
  return {
    id: `email:${r.id}`,
    tipo: r.tipo,
    canal: 'email',
    telefono: null,
    email: r.destinatario,
    message_id: r.resend_id,
    // resend_id siempre está seteado en las filas actuales de email_log
    // (solo se inserta después de que Resend confirma el envío) — por eso
    // se muestran como "Enviado" igual que una fila de notif_log con
    // message_id.
    payload: r.asunto ? { asunto: r.asunto } : null,
    created_at: r.created_at,
    entregada: !!r.resend_id,
    motivo: null,
    clientes: r.clientes || null,
    pedidos: null,
  };
}

async function cargarMas() {
  await cargarNotifLog(false);
}

// Debe coincidir con TIPOS_REINTENTABLES en lib/handlers/notif.js
// (handleReintentarEmail) — son los únicos tipos que el backend hoy sabe
// reconstruir desde cero para un reintento.
const TIPOS_REINTENTABLES = ['confirmacion_pedido', 'pedido_despachado', 'estado_cuenta', 'recepcion_proveedor'];

// FIX (Hallazgo 2, auditoría notificaciones — "reenvío manual de emails"):
// llama a POST /api/notif/reintentar-email, que reconstruye el email desde
// datos frescos y lo reenvía. Recarga la fila (no toda la tabla) para no
// perder scroll/posición del usuario en historiales largos.
async function reintentarEmail(notifLogId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Reintentando…'; }

  try {
    const { data: { session } } = await sb.auth.getSession();

    const res = await fetch('/api/notif/reintentar-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ notif_log_id: notifLogId }),
    });

    const data = await res.json();

    if (!res.ok) {
      window.mostrarToast(data.error || 'No se pudo reintentar el envío');
      if (btn) { btn.disabled = false; btn.textContent = 'Reintentar'; }
      return;
    }

    window.mostrarToast('Email reenviado correctamente');
    await cargarNotifLog(true);
  } catch (err) {
    console.error('[NOTIF-LOG] Error al reintentar envío:', err);
    window.mostrarToast('Error de conexión al reintentar el envío');
    if (btn) { btn.disabled = false; btn.textContent = 'Reintentar'; }
  }
}

// ── Filtro de texto (cliente-side sobre datos ya cargados) ─────────────────
function aplicarFiltros() {
  const q = (document.getElementById('buscar-notif').value || '').toLowerCase().trim();

  datosVista = q
    ? datos.filter(r => {
        const dest = destinatarioStr(r).toLowerCase();
        return dest.includes(q) ||
               (r.tipo || '').includes(q) ||
               (r.canal || '').includes(q) ||
               // FIX: pedidos.numero no existe — usar id truncado
               (r.pedidos?.id ? r.pedidos.id.slice(-8).toUpperCase() : '').toLowerCase().includes(q);
      })
    : datos;

  renderTabla();
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderTabla() {
  const tbody = document.getElementById('tbody-notif');

  if (datosVista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--color-text-light);">
      Sin notificaciones para los filtros actuales
    </td></tr>`;
    document.getElementById('lbl-count').textContent = '0 registros';
    return;
  }

  tbody.innerHTML = datosVista.map((r, idx) => {
    const fecha    = formatFechaHora(r.created_at);
    const badgeCan = badgeCanal(r.canal);
    const badgeTip = badgeTipo(r.tipo);
    const dest     = esc(destinatarioStr(r));
    // FIX: pedidos.numero no existe — usar id truncado
    const pedidoN  = r.pedidos?.id ? `#${esc(r.pedidos.id.slice(-8).toUpperCase())}` : '—';
    // FIX (auditoría 2026, etapa 15, Hallazgo 3): "Sin ID" no decía nada
    // sobre POR QUÉ falló el envío. Ahora se distingue entre "entregada"
    // explícitamente false (motivo conocido: sin_dispositivos, todos los
    // tokens fallaron, etc.) y el caso legado sin message_id ni motivo
    // (filas previas a que se agregara esta columna).
    const ok = r.message_id
      ? `<span class="badge-ok" title="message_id: ${esc(r.message_id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Enviado</span>`
      : `<span class="badge-err" title="${esc(motivoLabel(r.motivo))}">${motivoCorto(r.motivo)}</span>`;

    // FIX (Hallazgo 2, auditoría notificaciones — "reenvío manual de
    // emails"): botón "Reintentar" solo para emails fallidos reales de
    // notif_log — se excluyen los que vienen de email_log (id prefijado
    // "email:...", ver normalizarFilaEmail) porque esa tabla no tiene
    // filas fallidas (nunca logueó fallas) y los tipos que el backend
    // todavía no sabe reconstruir.
    const esReintentable = r.canal === 'email' && !r.message_id &&
      !String(r.id).startsWith('email:') && TIPOS_REINTENTABLES.includes(r.tipo);
    const btnReintentar = esReintentable
      ? `<button class="btn btn-sm btn-secondary" id="btn-reintentar-${esc(r.id)}"
                 onclick="event.stopPropagation(); reintentarEmail('${esc(r.id)}', this)">
           Reintentar
         </button>`
      : '';

    return `<tr class="fila-notif" onclick="abrirModalPayloadPorIndice(${idx})">
      <td data-label="Fecha y hora" style="white-space:nowrap;">${fecha}</td>
      <td data-label="Canal">${badgeCan}</td>
      <td data-label="Tipo">${badgeTip}</td>
      <td class="destino-cell" data-label="Destinatario" title="${dest}">${dest}</td>
      <td data-label="Pedido">${pedidoN}</td>
      <td data-label="Estado">${ok}</td>
      <td class="celda-acciones col-sticky-end" data-label="Detalle">
        <button class="btn btn-sm btn-secondary"
                onclick="event.stopPropagation(); abrirModalPayloadPorIndice(${idx})">
          Ver
        </button>
        ${btnReintentar}
      </td>
    </tr>`;
  }).join('');

  document.getElementById('lbl-count').textContent =
    `${datosVista.length} registro${datosVista.length !== 1 ? 's' : ''}${datos.length > datosVista.length ? ' (filtrados de ' + datos.length + ')' : ''}`;
}

// ── Stats ──────────────────────────────────────────────────────────────────
function actualizarStats() {
  const total     = datos.length;
  const wa        = datos.filter(r => r.canal === 'whatsapp').length;
  const em        = datos.filter(r => r.canal === 'email').length;
  const push      = datos.filter(r => r.canal === 'push').length;
  const enviados  = datos.filter(r => r.message_id).length;
  const fallidos  = datos.filter(r => !r.message_id).length;

  document.getElementById('stat-total').textContent     = total;
  document.getElementById('stat-whatsapp').textContent  = wa;
  document.getElementById('stat-email').textContent     = em;
  document.getElementById('stat-push').textContent      = push;
  document.getElementById('stat-enviados').textContent  = enviados;
  document.getElementById('stat-fallidos').textContent  = fallidos;

  // Bento: mezcla de canales (barra dentro de la tarjeta Total) y tasa de
  // entrega (subtítulo de la tarjeta Enviados) — derivados de los mismos
  // conteos de arriba, no piden datos nuevos al backend.
  const pct = (n) => total ? Math.round((n / total) * 100) : 0;
  const mixWa    = document.getElementById('mix-wa');
  const mixEmail = document.getElementById('mix-email');
  const mixPush  = document.getElementById('mix-push');
  if (mixWa)    mixWa.style.width    = pct(wa) + '%';
  if (mixEmail) mixEmail.style.width = pct(em) + '%';
  if (mixPush)  mixPush.style.width  = pct(push) + '%';

  const tasaEl = document.getElementById('bento-tasa');
  if (tasaEl) tasaEl.textContent = pct(enviados) + '% de entrega';
}

// ── Modal payload ──────────────────────────────────────────────────────────
// Se accede por índice sobre datosVista (no se serializa el registro en el
// HTML): JSON.stringify(JSON.stringify(r)) dentro de un atributo onclick
// generaba comillas escapadas con \" que el parser de HTML no entiende,
// cortaba el atributo ahí mismo y el botón quedaba sin handler funcional.
function abrirModalPayloadPorIndice(idx) {
  const r = datosVista[idx];
  if (!r) return;
  abrirModalPayload(r);
}

function abrirModalPayload(r) {
  document.getElementById('modal-payload-titulo').textContent =
    `${labelTipo(r.tipo)} — ${formatFechaHora(r.created_at)}`;

  const dest = destinatarioStr(r);
  // FIX: pedidos.numero no existe — usar id truncado
  const pedN = r.pedidos?.id ? ` · Pedido #${r.pedidos.id.slice(-8).toUpperCase()}` : '';
  document.getElementById('modal-payload-meta').innerHTML =
    `<strong>Canal:</strong> ${r.canal || '—'} &nbsp;·&nbsp;
     <strong>Destinatario:</strong> ${esc(dest)}${pedN} &nbsp;·&nbsp;
     <strong>Estado:</strong> ${r.message_id ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Enviado (ID: ${r.message_id})` : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${esc(motivoLabel(r.motivo))}`}`;

  document.getElementById('modal-payload-legible').innerHTML = payloadLegible(r.payload);
  document.getElementById('modal-payload-pre').textContent =
    r.payload ? JSON.stringify(r.payload, null, 2) : '(sin payload)';

  document.getElementById('modal-payload').classList.remove('hidden');
}

// ── Traducción del payload técnico a texto legible ─────────────────────────
// El payload guardado en notif_log/email_log tiene forma distinta según el
// canal (push: {titulo,cuerpo,datos:{...}}; whatsapp: params de template;
// email: {asunto}), y no siempre las mismas claves. En vez de mostrar el
// JSON crudo (ilegible para dueños/admins sin perfil técnico), se arma una
// lista de "campo: valor" con etiquetas en español. El JSON completo sigue
// disponible en el desplegable "Ver datos técnicos" para diagnóstico.
const ETIQUETAS_CAMPO = {
  titulo:                   'Título',
  cuerpo:                   'Mensaje',
  asunto:                   'Asunto del email',
  dispositivos_alcanzados:  'Dispositivos alcanzados',
  datos:                    'Datos adicionales',
  link:                     'Enlace en la app',
  tipo:                     'Tipo de evento',
  ruta_id:                  'Ruta',
  pedido_id:                'Pedido',
  cliente_id:               'Cliente',
  usuario_id:               'Usuario destinatario',
  saldo_vencido:            'Saldo vencido',
  cantidad:                 'Cantidad',
  total:                    'Total',
  cheques:                  'Cheques',
};

function etiquetaCampo(clave) {
  if (ETIQUETAS_CAMPO[clave]) return ETIQUETAS_CAMPO[clave];
  // Fallback: "algo_asi" -> "Algo asi"
  const texto = clave.replace(/_/g, ' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function esUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function formatearValorPayload(clave, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (clave === 'tipo' && TIPOS_LABEL[v]) return TIPOS_LABEL[v];
  if (esUuid(v)) return `#${v.slice(-8).toUpperCase()}`;
  if (typeof v === 'number' && /(total|saldo|monto|importe)/i.test(clave)) {
    return v.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
  }
  if (Array.isArray(v)) {
    if (!v.length) return '(ninguno)';
    return `${v.length} elemento${v.length !== 1 ? 's' : ''}`;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    if (!isNaN(d)) return formatFechaHora(v);
  }
  return String(v);
}

function payloadLegible(payload) {
  if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) {
    return '<p class="payload-vacio">Este envío no guardó contenido adicional.</p>';
  }
  return renderObjetoLegible(payload);
}

function renderObjetoLegible(obj) {
  const filas = Object.entries(obj).map(([clave, valor]) => {
    const label = etiquetaCampo(clave);
    if (valor && typeof valor === 'object' && !Array.isArray(valor) && Object.keys(valor).length) {
      return `<div class="payload-grupo">
        <div class="payload-grupo-titulo">${esc(label)}</div>
        ${renderObjetoLegible(valor)}
      </div>`;
    }
    return `<div class="payload-fila">
      <span class="payload-clave">${esc(label)}</span>
      <span class="payload-valor">${esc(formatearValorPayload(clave, valor))}</span>
    </div>`;
  });
  return `<div class="payload-lista">${filas.join('')}</div>`;
}

function cerrarModalPayload() {
  document.getElementById('modal-payload').classList.add('hidden');
}

// ── Exportar CSV ───────────────────────────────────────────────────────────
function exportarCSV() {
  if (datosVista.length === 0) { mostrarToast('No hay datos para exportar'); return; }

  const cols = ['Fecha', 'Canal', 'Tipo', 'Destinatario', 'Pedido', 'Message ID', 'Estado', 'Motivo (si falló)'];
  const filas = datosVista.map(r => [
    formatFechaHora(r.created_at),
    r.canal || '',
    r.tipo  || '',
    destinatarioStr(r),
    // FIX: pedidos.numero no existe — usar id truncado
    r.pedidos?.id ? `#${r.pedidos.id.slice(-8).toUpperCase()}` : '',
    r.message_id || '',
    r.message_id ? 'Enviado' : 'Sin ID',
    r.message_id ? '' : motivoLabel(r.motivo),
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

  const csv = [cols.join(','), ...filas].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `notif-log-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  mostrarToast('CSV descargado');
}

// ── Limpiar filtros ────────────────────────────────────────────────────────
function limpiarFiltros() {
  document.getElementById('buscar-notif').value = '';
  document.getElementById('filtro-canal').value = '';
  document.getElementById('filtro-tipo').value  = '';

  const hoy    = new Date();
  const hace30 = new Date(hoy); hace30.setDate(hoy.getDate() - 30);
  document.getElementById('filtro-hasta').value = hoy.toISOString().split('T')[0];
  document.getElementById('filtro-desde').value = hace30.toISOString().split('T')[0];

  cargarNotifLog();
}

// ── Helpers visuales ───────────────────────────────────────────────────────
function badgeCanal(canal) {
  const labels = { whatsapp: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>WhatsApp', email: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></svg>Email', push: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Push' };
  return `<span class="badge-canal ${esc(canal || 'otro')}">${labels[canal] || esc(canal || 'Otro')}</span>`;
}

function badgeTipo(tipo) {
  return `<span class="badge-tipo">${esc(labelTipo(tipo))}</span>`;
}

const TIPOS_LABEL = {
  confirmacion_pedido:  'Conf. pedido',
  pedido_despachado:    'Despachado',
  pedido_entregado:     'Entregado',
  pedido_no_entregado:  'No entregado',
  pedido_cancelado:     'Cancelado',
  deuda_vencida:        'Deuda vencida',
  nuevo_pedido:         'Nuevo pedido',
  ruta_asignada:        'Ruta asignada',
  stock_critico:        'Stock crítico',
  factura_emitida:      'Factura emitida',
};

function labelTipo(tipo) {
  return TIPOS_LABEL[tipo] || (tipo || 'Desconocido');
}

// Motivos reales insertados por lib/handlers/_push.js al fallar un envío
// (ver _logPush). Si no hay motivo (filas anteriores a la migración que
// agregó esta columna, o canales sin ese detalle todavía), se muestra el
// genérico "Sin ID" de siempre.
const MOTIVOS_LABEL = {
  sin_dispositivos:               'El cliente no tiene dispositivos registrados para push',
  error_consultando_dispositivos: 'Error interno al buscar los dispositivos del cliente',
  todos_los_tokens_fallaron:      'Se intentó en todos los dispositivos pero ninguno lo recibió',
  rate_limit_interno:             'No se envió por límite interno de frecuencia',
};

function motivoLabel(motivo) {
  if (!motivo) return 'Sin ID de confirmación (motivo no registrado)';
  return MOTIVOS_LABEL[motivo] || `Motivo: ${motivo}`;
}

function motivoCorto(motivo) {
  const cortos = {
    sin_dispositivos:               'Sin dispositivos',
    error_consultando_dispositivos: 'Error interno',
    todos_los_tokens_fallaron:      'Todos fallaron',
    rate_limit_interno:             'Límite de envío',
  };
  return '— ' + (motivo ? (cortos[motivo] || 'Sin ID') : 'Sin ID');
}

function destinatarioStr(r) {
  if (r.clientes?.razon_social) return r.clientes.razon_social;
  if (r.telefono) return r.telefono;
  if (r.email)    return r.email;
  return '—';
}

function formatFechaHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// ── Cerrar modal con Escape ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') cerrarModalPayload();
});

// ── Cerrar modal al hacer clic fuera ──────────────────────────────────────
document.getElementById('modal-payload').addEventListener('click', function(e) {
  if (e.target === this) cerrarModalPayload();
});
