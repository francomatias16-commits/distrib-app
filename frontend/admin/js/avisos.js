/* admin/js/avisos.js — Historial de "Avisos operativos"
   Consume el mismo endpoint que la campanita del topbar (GET /api/admin/alertas,
   ver handleAlertas en lib/handlers/admin.js), pero pidiendo más resultados y
   mostrándolos como historial persistente en vez de sólo el dropdown de 8.

   "Marcar como revisado" sólo existe para los dos tipos que ya lo soportan en
   el resto de la app (diferencia_caja desde cajas.html, entrega_cobro_parcial
   desde rutas.js): ambos usan POST /api/auditoria?accion=resolver contra la
   tabla anomalias_revisadas. El resto de los tipos (cheque_vencido,
   factura_diferencia, pedido_demorado, migracion_pendiente, score_critico,
   notificaciones del log) se resuelven solos cuando cambia el estado real que
   los origina — igual que ya pasa hoy en la campanita — así que sólo se
   muestran con un link "Ver detalle →" hacia la pantalla correspondiente. */

const TIPO_META = {
  diferencia_caja:     { icono: 'ic-caja',      label: 'Caja' },
  entrega_cobro_parcial:{ icono: 'ic-entrega',  label: 'Entrega' },
  factura_diferencia:  { icono: 'ic-factura',   label: 'Factura' },
  cheque_vencido:      { icono: 'ic-cheque',    label: 'Cheque' },
  score_critico:       { icono: 'ic-cliente',   label: 'Cliente' },
  pedido_nuevo:        { icono: 'ic-pedido',    label: 'Pedido' },
  migracion_pendiente: { icono: 'ic-migracion', label: 'Migración' },
  evento_error_prolongado: { icono: 'ic-info',  label: 'Sistema' },
};

const ICONOS = {
  'ic-caja':      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3H8a2 2 0 0 0-2 2v2h12V5a2 2 0 0 0-2-2z"/></svg>',
  'ic-entrega':   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  'ic-factura':   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
  'ic-cheque':    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  'ic-cliente':   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="19.07" x2="19.07" y2="4.93"/></svg>',
  'ic-pedido':    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  'ic-migracion': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  'ic-info':      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
};

// tipos que soportan "Marcar como revisado" (ver comentario arriba)
const TIPOS_RESOLVIBLES = new Set(['diferencia_caja', 'entrega_cobro_parcial']);

// prefijos usados por handleAlertas para armar el id compuesto — necesarios
// para recuperar el entidad_id real al marcar como revisado.
const PREFIJOS_ID = {
  diferencia_caja:        'turno-diferencia-',
  entrega_cobro_parcial:  'entrega-cobro-parcial-',
};

function _tok() {
  return window.authCtx?.session?.access_token || '';
}

function _tiempoRelativo(fechaISO) {
  if (!fechaISO) return '';
  const ms = Date.now() - new Date(fechaISO).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const hs = Math.floor(min / 60);
  if (hs < 24) return `hace ${hs} h`;
  return `hace ${Math.floor(hs / 24)} d`;
}

window.authReady.then(async (ctx) => {
  const perfil = ctx?.perfil;
  if (!perfil || !['dueno', 'admin'].includes(perfil.rol)) {
    document.getElementById('sin-permiso').classList.remove('hidden');
    document.getElementById('contenido-avisos').style.display = 'none';
    return;
  }
  const usr = document.getElementById('topbar-usuario');
  if (usr) usr.textContent = perfil.nombre || perfil.email || '';
  cargarAvisos();
}).catch(err => console.error('[avisos] authReady falló:', err?.message));

let _avisosList = [];

async function cargarAvisos() {
  const limite = document.getElementById('cantidad-select')?.value || 50;
  document.getElementById('skeleton-list').style.display = 'flex';
  document.getElementById('avisos-lista').style.display = 'none';
  document.getElementById('avisos-vacio').classList.add('hidden');
  document.getElementById('resumen-pills').style.display = 'none';

  try {
    const resp = await fetch(`/api/admin/alertas?limite=${encodeURIComponent(limite)}`, {
      headers: { Authorization: `Bearer ${_tok()}` },
    });
    if (!resp.ok) throw new Error('No se pudo cargar los avisos.');
    const data = await resp.json();
    _avisosList = data?.alertas || [];
    renderResumen(_avisosList, data?.resumen_cheques_vencidos);
    renderLista(_avisosList);
  } catch (err) {
    console.error('[avisos] cargarAvisos falló:', err.message);
    if (window.toast) window.toast('No se pudieron cargar los avisos.', 'error');
    document.getElementById('skeleton-list').style.display = 'none';
    document.getElementById('avisos-vacio').classList.remove('hidden');
  }
}

function renderResumen(avisos, resumenCheques) {
  const cont = document.getElementById('resumen-pills');
  if (!avisos.length) { cont.style.display = 'none'; return; }

  const porTipo = {};
  avisos.forEach(a => { porTipo[a.tipo] = (porTipo[a.tipo] || 0) + 1; });

  const pills = [`<span class="sello sello--info">${avisos.length} aviso${avisos.length === 1 ? '' : 's'}</span>`];
  if (porTipo.diferencia_caja) pills.push(`<span class="sello sello--alerta">${porTipo.diferencia_caja} de caja</span>`);
  if (porTipo.entrega_cobro_parcial) pills.push(`<span class="sello sello--alerta">${porTipo.entrega_cobro_parcial} de entregas</span>`);
  if (porTipo.factura_diferencia) pills.push(`<span class="sello sello--anulado">${porTipo.factura_diferencia} de facturas</span>`);
  if (resumenCheques?.cantidad) pills.push(`<span class="sello sello--anulado">${resumenCheques.cantidad} cheque(s) vencidos</span>`);

  cont.innerHTML = pills.join('');
  cont.style.display = 'flex';
}

function renderLista(avisos) {
  document.getElementById('skeleton-list').style.display = 'none';
  const lista = document.getElementById('avisos-lista');

  if (!avisos.length) {
    lista.style.display = 'none';
    document.getElementById('avisos-vacio').classList.remove('hidden');
    return;
  }
  document.getElementById('avisos-vacio').classList.add('hidden');

  lista.innerHTML = avisos.map((a, idx) => {
    const meta   = TIPO_META[a.tipo] || { icono: 'ic-info', label: 'Aviso' };
    const svg    = ICONOS[meta.icono] || ICONOS['ic-info'];
    const puedeResolver = TIPOS_RESOLVIBLES.has(a.tipo);
    const href   = a.link || a.href || null;

    return `<div class="anomalia-card" id="aviso-${idx}">
      <div class="anomalia-card__header" ${href ? `onclick="window.location.href='${window.sanitize(href)}'"` : ''}>
        <span class="anomalia-icono ${meta.icono}">${svg}</span>
        <div style="flex:1;min-width:0;">
          <p class="anomalia-titulo">${window.sanitize(a.titulo || 'Aviso')}</p>
          ${a.cuerpo ? `<p class="anomalia-sub">${window.sanitize(a.cuerpo)}</p>` : ''}
        </div>
        <span class="anomalia-tiempo">${_tiempoRelativo(a.created_at)}</span>
      </div>
      <div class="anomalia-card__footer">
        ${href ? `<a class="link-ver" href="${window.sanitize(href)}">Ver detalle →</a>` : ''}
        ${puedeResolver ? `<button type="button" class="btn-revisar" id="btn-rev-${idx}" onclick="marcarAvisoRevisado(event, ${idx})">Marcar como revisado</button>` : ''}
      </div>
    </div>`;
  }).join('');

  lista.style.display = 'flex';
}

window.marcarAvisoRevisado = async function (ev, idx) {
  ev.stopPropagation();
  const aviso = _avisosList[idx];
  if (!aviso) return;
  const prefijo = PREFIJOS_ID[aviso.tipo];
  const entidadId = prefijo && aviso.id?.startsWith(prefijo) ? aviso.id.slice(prefijo.length) : null;
  if (!entidadId) return;

  const btn = document.getElementById(`btn-rev-${idx}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

  try {
    const resp = await fetch('/api/auditoria?accion=resolver', {
      method: 'POST',
      headers: { Authorization: `Bearer ${_tok()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo_anomalia: aviso.tipo, entidad_id: entidadId }),
    });
    if (!resp.ok) throw new Error('No se pudo marcar como revisado.');

    const card = document.getElementById(`aviso-${idx}`);
    if (card) {
      card.classList.add('saliendo');
      setTimeout(() => card.remove(), 200);
    }
    if (window.toast) window.toast('Aviso marcado como revisado.');
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Marcar como revisado'; }
    if (window.toast) window.toast(err.message || 'No se pudo marcar como revisado.', 'error');
  }
};
