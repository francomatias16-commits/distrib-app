/* admin/js/anomalias.js — Visor de anomalías / alertas de auditoría
   Extraído de anomalias.html (inline → archivo separado) en v125
   Tablas: anomalias_revisadas (migración 079)
   FIX v125: usa window.authCtx.sb, patrón authReady unificado */

// ── Estado de revisadas: persiste en DB (tabla anomalias_revisadas, migración 079).
// Clave local: "tipo__usuarioId__entidadId" — misma que usa el backend para UPSERT.
const _revisadas = new Set();  // se puebla en cargarRevisadas() al iniciar

const TIPO_LABELS = {
  descuento_repetido_vendedor:            { titulo: 'Descuentos repetidos por vendedor',            icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>', desc: 'Un vendedor aplicó descuentos en múltiples pedidos distintos en poco tiempo.' },
  descuento_repetido_vendedor_cliente:    { titulo: 'Descuento repetido al mismo cliente',          icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M8 12l3 3 8-8"/><path d="M2 12l4-4 4 4-4 4z"/><path d="M14 8l4-4 4 4-3 3"/></svg>', desc: 'Un vendedor le dio descuento reiterado al mismo cliente. Puede ser un acuerdo informal no registrado.' },
  ajuste_stock_sin_respaldo:              { titulo: 'Ajuste de stock sin orden de compra',          icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>', desc: 'Se registraron ajustes o ingresos de stock sin una orden de compra que los respalde.' },
  movimiento_stock_alterado:              { titulo: 'Movimiento de stock modificado o eliminado',   icono: '⚠', desc: 'Se editaron o borraron movimientos de stock ya asentados. Esto puede indicar corrección de error o manipulación.' },
  pedido_anulado_repetido:                { titulo: 'Anulaciones repetidas por vendedor',           icono: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:3px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>', desc: 'Un vendedor canceló varios pedidos distintos en poco tiempo.' },
  descuento_excede_maximo:                { titulo: 'Descuento fuera de rango',                     icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>', desc: 'Se aplicó un descuento muy por encima del máximo razonable en un pedido, sin importar la frecuencia.' },
  precio_manual_bajo_lista:               { titulo: 'Precio manual por debajo de lista',            icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M20.59 13.41L11 3.83A2 2 0 0 0 9.59 3.17L4 3v5.59a2 2 0 0 0 .66 1.41l9.59 9.59a2 2 0 0 0 2.83 0l3.51-3.51a2 2 0 0 0 0-2.83z"/><circle cx="7.5" cy="7.5" r="1"/></svg>', desc: 'Un vendedor cargó precios manuales significativamente por debajo del precio de lista del producto, de forma repetida.' },
  nota_credito_veloz_post_factura:        { titulo: 'Nota de crédito emitida muy rápido',           icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>', desc: 'Se emitió una nota de crédito muy poco después de la factura original. Puede ser un error genuino o un ajuste indebido.' },
  cheque_rechazado_con_cobro_vinculado:   { titulo: 'Cheque rechazado con cobro vinculado',         icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>', desc: 'Un cheque marcado como rechazado sigue vinculado a un cobro registrado — inconsistencia a revisar.' },
  cobro_sin_respaldo_cta_cte:             { titulo: 'Cobro sin respaldo contable',                  icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 2v3"/><path d="M8 5h8l3 6c1.5 3-1 11-7 11S3.5 14 5 11z"/><line x1="9" y1="12" x2="15" y2="12"/></svg>', desc: 'Se registraron cobros sin el movimiento correspondiente en la cuenta corriente del cliente.' },
  cliente_bloqueado_con_pedido_posterior: { titulo: 'Pedido a cliente bloqueado',                   icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="19.07" x2="19.07" y2="4.93"/></svg>', desc: 'Se cargó un pedido a un cliente después de que fuera bloqueado por deuda o riesgo.' },
  ajuste_puntos_manual_sin_pedido:        { titulo: 'Puntos de fidelización ajustados manualmente', icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>', desc: 'Se sumaron puntos de fidelización manualmente, sin un pedido que los respalde.' },
  entrega_secuencia_veloz:                { titulo: 'Entregas confirmadas demasiado rápido',        icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/><path d="M8 18.5h8M5.5 16L9 6h3l1 4h4l2 6"/></svg>', desc: 'Varias entregas de la misma ruta se confirmaron con una diferencia de tiempo mínima entre sí — posible marcado en bloque sin visita real.' },
  actividad_stock_fuera_horario:          { titulo: 'Actividad de stock fuera de horario',          icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>', desc: 'Se cargaron movimientos de stock de madrugada, fuera del horario operativo habitual.' },
  volumen_pedidos_anomalo_vendedor:       { titulo: 'Pico de volumen de pedidos',                   icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>', desc: 'Un vendedor generó muchos más pedidos de lo habitual para él en esta ventana, comparado con su propio promedio reciente.' },
  turno_caja_abierto_prolongado:          { titulo: 'Turno de caja abierto hace demasiado tiempo',  icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', desc: 'Una caja sigue con el turno abierto más allá del umbral esperado. Bloquea la venta del turno siguiente hasta que se cierre.' },
};

function _tok() {
  return window.authCtx?.session?.access_token || '';
}

// ── Traducción de claves técnicas del "detalle" de cada anomalía a texto
// legible. Si una clave no está en el diccionario, se genera un label a
// partir del nombre (snake_case → "Palabras Capitalizadas") en vez de
// mostrar el nombre de campo de la base de datos tal cual.
const DETALLE_LABELS = {
  usuario_id: 'Usuario', usuario_nombre: 'Usuario', vendedor_id: 'Vendedor', vendedor_nombre: 'Vendedor',
  cliente_id: 'Cliente', cliente_nombre: 'Cliente', entidad_id: 'Registro', entidad_tipo: 'Tipo de registro',
  pedido_id: 'Pedido', factura_id: 'Factura', cheque_id: 'Cheque', producto_id: 'Producto', producto_nombre: 'Producto',
  fecha: 'Fecha', fecha_hora: 'Fecha y hora', creado_en: 'Creado', monto: 'Monto', monto_estimado: 'Monto estimado',
  porcentaje: 'Porcentaje', descuento: 'Descuento', descuento_pct: 'Descuento (%)', precio: 'Precio',
  precio_lista: 'Precio de lista', precio_manual: 'Precio cargado', cantidad: 'Cantidad', caja_id: 'Caja',
  deposito_id: 'Depósito', zona_id: 'Zona', ruta_id: 'Ruta', motivo: 'Motivo', observacion: 'Observación', nota: 'Nota',
};

function humanizarClave(clave) {
  if (DETALLE_LABELS[clave]) return DETALLE_LABELS[clave];
  return String(clave)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizarValor(valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (typeof valor === 'number') return valor.toLocaleString('es-AR');
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}/.test(valor)) {
    const d = new Date(valor);
    if (!isNaN(d)) return d.toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  }
  return escapeHtml(String(valor));
}

// Convierte el objeto `detalle` (o un arreglo de eventos) en una lista de
// HTML legible, en vez de un volcado de JSON crudo con nombres de campo
// de la base de datos.
function formatearDetalleHumano(detalle) {
  if (Array.isArray(detalle)) {
    return detalle.map((item, i) => `<div class="anomalia-detalle-evento"><strong>Evento ${i + 1}</strong>${formatearDetalleHumano(item)}</div>`).join('');
  }
  if (detalle && typeof detalle === 'object') {
    const filas = Object.entries(detalle)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => {
        const valor = (v && typeof v === 'object') ? formatearDetalleHumano(v) : humanizarValor(v);
        return `<div class="anomalia-detalle-fila"><span class="anomalia-detalle-lbl">${humanizarClave(k)}</span><span>${valor}</span></div>`;
      });
    return filas.join('') || '<div class="anomalia-detalle-fila">Sin datos adicionales.</div>';
  }
  return humanizarValor(detalle);
}

window.authReady.then(async (ctx) => {
  const perfil = ctx?.perfil;
  if (!perfil || !['dueno', 'admin'].includes(perfil.rol)) {
    document.getElementById('sin-permiso').classList.remove('hidden');
    document.getElementById('contenido-anomalias').style.display = 'none';
    return;
  }
  const usr = document.getElementById('topbar-usuario');
  if (usr) usr.textContent = perfil.nombre || perfil.email || '';
  await cargarRevisadas();   // primero: cargar estado persistido
  cargarAnomalias();
}).catch(err => console.error('[anomalias] authReady falló:', err?.message));

// ── Carga las revisadas desde la DB para inicializar _revisadas ─────────────
async function cargarRevisadas() {
  try {
    const resp = await fetch('/api/auditoria?accion=revisadas', {
      headers: { Authorization: `Bearer ${_tok()}` },
    });
    if (!resp.ok) return;
    const d = await resp.json();
    (d.revisadas || []).forEach(r => {
      _revisadas.add(revisadaKey(r.tipo_anomalia, r.usuario_id, r.entidad_id));
    });
  } catch (_) { /* silencioso — la UI sigue funcionando */ }
}

function revisadaKey(tipo, uid, eid) {
  return `${tipo}__${uid || ''}__${eid || ''}`;
}

// ── CARGA ───────────────────────────────────────────────────────────────────
async function cargarAnomalias() {
  const dias = document.getElementById('dias-select')?.value || 7;
  document.getElementById('skeleton-list').style.display = 'flex';
  document.getElementById('anomalias-lista').style.display = 'none';
  document.getElementById('anomalias-vacio').classList.add('hidden');
  document.getElementById('resumen-pills').style.display = 'none';

  try {
    const resp = await fetch(`/api/auditoria?accion=analizar&dias=${dias}`, {
      headers: { Authorization: `Bearer ${_tok()}` },
    });
    const d = await resp.json();
    if (!resp.ok) throw new Error(d.error || resp.statusText);

    const anomalias = d.resultados?.[0]?.anomalias || [];
    renderAnomalias(anomalias);
  } catch (err) {
    document.getElementById('skeleton-list').style.display = 'none';
    document.getElementById('anomalias-vacio').classList.remove('hidden');
    console.error('[anomalias] cargar:', err);
    toast('No se pudieron cargar los movimientos raros', 'error');
  }
}

function renderAnomalias(lista) {
  document.getElementById('skeleton-list').style.display = 'none';

  const container = document.getElementById('anomalias-lista');
  const pills     = document.getElementById('resumen-pills');

  if (!lista.length) {
    container.style.display = 'none';
    pills.style.display = 'none';
    document.getElementById('anomalias-vacio').classList.remove('hidden');
    return;
  }

  // Resumen pills
  const altas  = lista.filter(a => a.severidad === 'alta').length;
  const medias = lista.filter(a => a.severidad === 'media').length;
  pills.innerHTML = `
    <span class="sello sello--info">${lista.length} patrón${lista.length !== 1 ? 'es' : ''} detectado${lista.length !== 1 ? 's' : ''}</span>
    ${altas  ? `<span class="sello sello--anulado">${altas} crítico${altas  > 1 ? 's' : ''}</span>` : ''}
    ${medias ? `<span class="sello sello--alerta">${medias} a revisar</span>` : ''}
  `;
  pills.style.display = 'flex';

  // Guardar lista para referencia por índice desde onclick
  window._anomaliasList = lista;
  // Cards
  container.innerHTML = lista.map((a, idx) => buildCard(a, idx)).join('');
  container.style.display = 'flex';
}

function buildCard(a, idx) {
  const key  = cardKey(a, idx);
  const info = TIPO_LABELS[a.tipo_anomalia] || { titulo: a.tipo_anomalia, icono: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', desc: '' };
  const rev  = _revisadas.has(key);

  const montoStr = a.monto_estimado
    ? `$${Number(a.monto_estimado).toLocaleString('es-AR', { minimumFractionDigits: 0 })}`
    : '—';

  const desde = a.primer_evento ? formatTs(a.primer_evento) : '—';
  const hasta  = a.ultimo_evento ? formatTs(a.ultimo_evento) : '—';

  const detalleHumano = a.detalle ? formatearDetalleHumano(a.detalle) : null;

  return `<div class="anomalia-card${rev ? ' revisada' : ''}" id="card-${idx}">
    <div class="anomalia-card__header">
      <span class="anomalia-icono">${info.icono}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
          <p class="anomalia-titulo">${sanitize(info.titulo)}</p>
          <span class="anomalia-badge badge-${a.severidad}">${a.severidad === 'alta' ? '<svg width="10" height="10" viewBox="0 0 8 8" style="vertical-align:0px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>Alta' : '<svg width="10" height="10" viewBox="0 0 8 8" style="vertical-align:0px;margin-right:3px"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>Media'}</span>
        </div>
        <p class="anomalia-sub">${info.desc}</p>
      </div>
    </div>
    <div class="anomalia-card__body">
      <div class="anomalia-meta-grid">
        <div class="anomalia-meta-item">
          <div class="anomalia-meta-item__lbl">Quién</div>
          <div class="anomalia-meta-item__val">${window.sanitize(a.usuario_nombre || '—')}</div>
        </div>
        <div class="anomalia-meta-item">
          <div class="anomalia-meta-item__lbl">Entidad afectada</div>
          <div class="anomalia-meta-item__val" style="font-size:13px">${window.sanitize(a.entidad_nombre || a.entidad_tipo || '—')}</div>
        </div>
        <div class="anomalia-meta-item">
          <div class="anomalia-meta-item__lbl">Eventos</div>
          <div class="anomalia-meta-item__val">${a.cantidad_eventos}</div>
        </div>
        <div class="anomalia-meta-item">
          <div class="anomalia-meta-item__lbl">Monto estimado</div>
          <div class="anomalia-meta-item__val">${montoStr}</div>
        </div>
        <div class="anomalia-meta-item">
          <div class="anomalia-meta-item__lbl">Primer evento</div>
          <div class="anomalia-meta-item__val" style="font-size:12px">${desde}</div>
        </div>
        <div class="anomalia-meta-item">
          <div class="anomalia-meta-item__lbl">Último evento</div>
          <div class="anomalia-meta-item__val" style="font-size:12px">${hasta}</div>
        </div>
      </div>
      ${detalleHumano ? `<button type="button" class="anomalia-detalle-toggle" aria-expanded="false" aria-controls="json-${idx}" onclick="verDetalle(${idx}, this)">Ver eventos detallados <span aria-hidden="true">▾</span></button>
        <div class="anomalia-detalle-json hidden" id="json-${idx}">${detalleHumano}</div>` : ''}
    </div>
    <div class="anomalia-card__footer">
      <span style="font-size:11px;color:var(--color-text-muted)">${rev ? rev ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Revisado' : '' : ''}</span>
      <button type="button" class="btn-revisar${rev ? ' ya-revisada' : ''}" id="btn-rev-${idx}" ${rev ? 'disabled' : ''} onclick="marcarRevisada('${key}', ${idx})">${rev ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Revisado' : 'Marcar como revisado'}</button>
    </div>
  </div>`;
}

function cardKey(a, idx) {
  // Usa '' para null (igual que revisadaKey) para que coincida con lo persistido en DB
  return revisadaKey(a.tipo_anomalia, a.usuario_id || '', a.entidad_id || '');
}

// ── ACCIONES ─────────────────────────────────────────────────────────────────
window.marcarRevisada = async function(key, idx) {
  const anomalia = window._anomaliasList?.[idx] || {};
  if (_revisadas.has(key)) return;
  _revisadas.add(key);

  // Optimista: actualizar UI de inmediato
  const card = document.getElementById(`card-${idx}`);
  const btn  = document.getElementById(`btn-rev-${idx}`);
  if (card) card.classList.add('revisada');
  if (btn)  { btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Revisado'; btn.classList.add('ya-revisada'); btn.disabled = true; }
  const footer = card?.querySelector('.anomalia-card__footer span');
  if (footer) footer.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Revisado ahora';

  // Leer notas del input si existe
  const notasInput = document.getElementById(`notas-rev-${idx}`);
  const notas = notasInput?.value?.trim() || null;
  // Ocultar el input
  if (notasInput) notasInput.style.display = 'none';
  // Mostrar notas en el footer si las hay
  const notaEl = document.getElementById(`nota-rev-${idx}`);
  if (notaEl) notaEl.innerHTML = notas ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Revisado — "${window.sanitize(notas)}"` : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Revisado';

  // Persistir en DB
  try {
    await fetch('/api/auditoria?accion=resolver', {
      method: 'POST',
      headers: { Authorization: `Bearer ${_tok()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo_anomalia: anomalia.tipo_anomalia,
        usuario_id:    anomalia.usuario_id  || null,
        entidad_id:    anomalia.entidad_id  || null,
        notas,
      }),
    });
  } catch (_) { /* silencioso — estado local ya actualizado */ }
};

window.verDetalle = function(idx, btn) {
  const json = document.getElementById(`json-${idx}`);
  if (!json) return;
  const abierto = !json.classList.contains('hidden');
  json.classList.toggle('hidden', abierto);
  btn.textContent = abierto ? 'Ver eventos detallados ▾' : 'Ocultar detalle ▴';
};

window.ejecutarAnalisis = async function() {
  const btn  = document.getElementById('btn-analizar');
  const dias = document.getElementById('dias-select')?.value || 7;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analizando…'; }
  try {
    const resp = await fetch(`/api/auditoria?accion=analizar&dias=${dias}`, {
      headers: { Authorization: `Bearer ${_tok()}` },
    });
    const d = await resp.json();
    if (!resp.ok) throw new Error(d.error || resp.statusText);
    const total = d.resultados?.[0]?.anomalias_detectadas ?? 0;
    toast(total > 0 ? `${total} patrón${total > 1 ? 'es' : ''} detectado${total > 1 ? 's' : ''}` : 'Sin anomalías detectadas', total > 0 ? 'warn' : 'ok');
    // Renderizar la lista fresca con los datos devueltos
    const anomalias = d.resultados?.[0]?.anomalias || [];
    renderAnomalias(anomalias);
  } catch (err) {
    console.error('[anomalias] analizar:', err);
    toast('No se pudo completar el análisis', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Analizar ahora'; }
  }
};

// ── MODAL ─────────────────────────────────────────────────────────────────────
window.cerrarModal = function() {
  document.getElementById('modal-detalle').classList.add('hidden');
};

// ── UTILS ─────────────────────────────────────────────────────────────────────
function formatTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function escapeHtml(str) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js). Antes
  // esta copia no escapaba comillas y podía lanzar TypeError con valores
  // no-string (sanitize() maneja null/undefined y castea con String()).
  return window.sanitize(str);
}


// Fecha topbar
const fechaEl = document.getElementById('topbar-fecha');
if (fechaEl) fechaEl.textContent = new Date().toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
