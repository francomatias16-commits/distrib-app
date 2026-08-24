// frontend/proveedor/portal.js
// Innovación #10 — Autogestión de Proveedores ("Vidriera Inversa")
// Pantalla pública, SIN login: el proveedor entra con el token de la URL
// (?t=...) y ve sus propias órdenes de compra y facturas. Además de la
// lectura, puede: confirmar/ajustar la fecha de entrega de una OC propia
// y autocargar una factura (con o sin OC asociada) — esas dos acciones
// quedan reflejadas en el panel admin para revisión (ver portal_proveedor.js).

const moneda = v => '$' + Number(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtFecha = s => s ? new Date(s).toLocaleDateString('es-AR') : '—';
const fmtFechaInput = s => s ? String(s).slice(0, 10) : '';

const ESTADOS_LABEL = {
  borrador: 'Borrador',
  pendiente_aprobacion: 'Pendiente de aprobación',
  enviada: 'Enviada',
  confirmada: 'Confirmada',
  recibida_parcial: 'Recibida parcial',
  recibida: 'Recibida',
  cancelada: 'Cancelada',
};

let tokenGlobal = null;

// Paginación client-side (Órdenes de compra y Facturas) — el backend ya
// limita cada lista a 50 registros (lib/repos/portal-proveedor.js), pero
// mostrarlas todas juntas en una pantalla pública pensada para celular
// generaba una lista interminable y mucho scroll. Se pagina en el cliente
// sobre esos mismos datos, sin tocar el fetch. El número de página se
// preserva entre re-renders (post guardarFecha/guardarFactura) y se
// clampea si la lista cambió de tamaño.
const PAGE_SIZE_OC = 5;
const PAGE_SIZE_FACTURAS = 5;
let ordenesData = [];
let facturasData = [];
let paginaOC = 1;
let paginaFacturas = 1;

async function init() {
  const params = new URLSearchParams(location.search);
  const token = params.get('t');

  if (!token) {
    mostrarError('Link incompleto', 'Falta el código de acceso en el link. Pedile a tu contacto que te lo reenvíe.');
    return;
  }

  tokenGlobal = token;

  // Plan offline, Etapa 3 (cierre) — window.ProveedorOffline puede no estar
  // presente si el <script> no cargó (ej. red muy mala en la primera
  // visita, antes de que el SW pueda servir el shell desde caché); en ese
  // caso guardarFecha/guardarFactura simplemente no tienen fallback offline
  // y se comportan como antes (solo red).
  if (window.ProveedorOffline) {
    await window.ProveedorOffline.init({ token });
  }

  await cargarDatos();
}

async function cargarDatos() {
  let data;
  try {
    const res = await fetch(`/api/proveedores?_svc=portal&t=${encodeURIComponent(tokenGlobal)}`);
    data = await res.json();

    if (!res.ok) {
      mostrarError('No se pudo abrir el portal', data.error || 'Ocurrió un error al validar el link.');
      return;
    }
  } catch (err) {
    mostrarError('Sin conexión', 'No se pudo contactar al servidor. Probá de nuevo en un momento.');
    return;
  }

  render(data);
}

function mostrarError(titulo, mensaje) {
  document.getElementById('portal-main').innerHTML = `
    <div class="portal-error-box">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <h2>${titulo}</h2>
      <p>${mensaje}</p>
    </div>
  `;
}

function render(data) {
  document.getElementById('ph-empresa').textContent = data.empresa || '—';

  // Defense-in-depth: el backend (lib/repos/portal-proveedor.js) ya excluye
  // OCs en 'borrador' / 'pendiente_aprobacion' de la consulta, pero esta
  // pantalla es pública (sin login, solo token de URL) — filtramos acá
  // también para que un futuro cambio de backend nunca exponga compromisos
  // que el admin todavía no confirmó ni envió.
  const ESTADOS_OCULTOS_PROVEEDOR = ['borrador', 'pendiente_aprobacion'];
  const ordenes  = (data.ordenes  || []).filter(o => !ESTADOS_OCULTOS_PROVEEDOR.includes(o.estado));
  const facturas = data.facturas || [];

  ordenesData = ordenes;
  facturasData = facturas;

  const pendientesEntrega = ordenes.filter(o => ['enviada', 'confirmada'].includes(o.estado));
  const totalAbierto = ordenes
    .filter(o => !['recibida', 'cancelada'].includes(o.estado))
    .reduce((s, o) => s + Number(o.total || 0), 0);

  const nombreProveedor = data.proveedor?.nombre_fantasia || data.proveedor?.razon_social || 'Proveedor';

  const html = `
    <div class="portal-saludo">
      <h1>Hola, ${esc(nombreProveedor)}</h1>
      <p>Estas son tus órdenes de compra con ${esc(data.empresa)}.</p>
    </div>

    <div class="portal-resumen">
      <div class="portal-resumen-card">
        <div class="portal-resumen-label">OCs totales</div>
        <div class="portal-resumen-valor">${ordenes.length}</div>
      </div>
      <div class="portal-resumen-card">
        <div class="portal-resumen-label">Por entregar</div>
        <div class="portal-resumen-valor">${pendientesEntrega.length}</div>
      </div>
      <div class="portal-resumen-card">
        <div class="portal-resumen-label">Monto abierto</div>
        <div class="portal-resumen-valor">${moneda(totalAbierto)}</div>
      </div>
    </div>

    <div class="portal-seccion-titulo">Órdenes de compra</div>
    <div id="portal-ordenes-lista"></div>
    <div id="portal-ordenes-paginacion"></div>

    <div class="portal-seccion-titulo">Tus facturas cargadas</div>
    <div id="portal-facturas-lista"></div>
    <div id="portal-facturas-paginacion"></div>
    <div class="portal-oc-card">
      <button type="button" class="portal-btn" data-toggle="factura-form-suelta">+ Cargar una factura</button>
      ${formFactura('suelta')}
    </div>

    <div class="portal-seccion-titulo">Notificaciones</div>
    <div id="portal-notificaciones"><div class="portal-vacio">Cargando...</div></div>
  `;

  document.getElementById('portal-main').innerHTML = html;
  renderOrdenesLista();
  renderFacturasLista();
  cargarNotificaciones();
}

/** Recorta ordenesData a la página actual y la pinta junto a sus controles. */
function renderOrdenesLista() {
  const cont = document.getElementById('portal-ordenes-lista');
  const pagCont = document.getElementById('portal-ordenes-paginacion');
  if (!cont) return;

  if (!ordenesData.length) {
    cont.innerHTML = '<div class="portal-vacio">Todavía no hay órdenes de compra registradas.</div>';
    pagCont.innerHTML = '';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(ordenesData.length / PAGE_SIZE_OC));
  if (paginaOC > totalPaginas) paginaOC = totalPaginas;
  const inicio = (paginaOC - 1) * PAGE_SIZE_OC;

  cont.innerHTML = ordenesData.slice(inicio, inicio + PAGE_SIZE_OC).map(renderOC).join('');
  pagCont.innerHTML = renderPaginacion('oc', paginaOC, totalPaginas);
}

/** Idem renderOrdenesLista() pero para facturasData. */
function renderFacturasLista() {
  const cont = document.getElementById('portal-facturas-lista');
  const pagCont = document.getElementById('portal-facturas-paginacion');
  if (!cont) return;

  if (!facturasData.length) {
    cont.innerHTML = '<div class="portal-vacio">Todavía no cargaste ninguna factura.</div>';
    pagCont.innerHTML = '';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(facturasData.length / PAGE_SIZE_FACTURAS));
  if (paginaFacturas > totalPaginas) paginaFacturas = totalPaginas;
  const inicio = (paginaFacturas - 1) * PAGE_SIZE_FACTURAS;

  cont.innerHTML = facturasData.slice(inicio, inicio + PAGE_SIZE_FACTURAS).map(renderFactura).join('');
  pagCont.innerHTML = renderPaginacion('facturas', paginaFacturas, totalPaginas);
}

function renderPaginacion(prefix, actual, total) {
  if (total <= 1) return '';
  return `
    <div class="portal-paginacion">
      <button type="button" class="portal-btn" data-pag="${prefix}" data-dir="prev" ${actual <= 1 ? 'disabled' : ''}>‹ Anterior</button>
      <span class="portal-paginacion-info">Página ${actual} de ${total}</span>
      <button type="button" class="portal-btn" data-pag="${prefix}" data-dir="next" ${actual >= total ? 'disabled' : ''}>Siguiente ›</button>
    </div>
  `;
}

// Fase 4 (plan ERP), generalización del centro de notificaciones: fetch
// aparte del de cargarDatos() — así una falla acá (o que tarde) no frena
// el render principal de OCs/facturas, que es lo que el proveedor vino a
// ver. Best-effort: si falla, la sección queda vacía sin romper la
// página (mismo criterio que notificarDeudaVencida en el backend).
async function cargarNotificaciones() {
  const cont = document.getElementById('portal-notificaciones');
  if (!cont) return;

  try {
    const res = await fetch(`/api/proveedores?_svc=portal&accion=notificaciones&t=${encodeURIComponent(tokenGlobal)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'error');

    const notifs = data.notificaciones || [];
    cont.innerHTML = notifs.length
      ? notifs.map(renderNotificacion).join('')
      : '<div class="portal-vacio">Todavía no hay notificaciones registradas.</div>';
  } catch (e) {
    cont.innerHTML = '<div class="portal-vacio">No se pudo cargar el historial de notificaciones.</div>';
  }
}

const TIPO_NOTIF_LABEL = {
  recepcion_proveedor: 'Recepción de mercadería',
};

function renderNotificacion(n) {
  const tipoLabel = TIPO_NOTIF_LABEL[n.tipo] || n.tipo;
  const estado = n.entregada
    ? '<span class="portal-confirmada"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Entregada</span>'
    : `<span class="portal-badge-estado estado-cancelada">No entregada${n.motivo ? ' — ' + esc(n.motivo) : ''}</span>`;

  return `
    <div class="portal-oc-card">
      <div class="portal-oc-top">
        <div>
          <div class="portal-oc-numero">${esc(tipoLabel)}</div>
          <div class="portal-oc-fecha">${fmtFecha(n.created_at)} · por ${esc(n.canal)}${n.email ? ' a ' + esc(n.email) : ''}</div>
        </div>
      </div>
      ${estado}
    </div>
  `;
}

function renderOC(o) {
  const items = o.ordenes_compra_items || [];
  const estadoClase = `estado-${o.estado}`;
  const estadoLabel = ESTADOS_LABEL[o.estado] || o.estado;

  const puedeConfirmarFecha = o.estado === 'enviada';
  const puedeAdjuntarFactura = ['enviada', 'recibida'].includes(o.estado);

  return `
    <div class="portal-oc-card">
      <div class="portal-oc-top">
        <div>
          <div class="portal-oc-numero">OC ${esc(o.numero) || '—'}</div>
          <div class="portal-oc-fecha">Pedida el ${fmtFecha(o.fecha_pedido)}${o.fecha_esperada ? ' · esperada ' + fmtFecha(o.fecha_esperada) : ''}</div>
        </div>
        <div>
          <div class="portal-oc-total">${moneda(o.total)}</div>
          <span class="portal-badge-estado ${estadoClase}">${estadoLabel}</span>
        </div>
      </div>
      ${items.length ? `
        <div class="portal-oc-items">
          ${items.map(i => `
            <div class="portal-oc-item-row">
              <span>${esc(i.descripcion || i.productos?.nombre || '—')} × ${Number(i.cantidad)}</span>
              <span>${moneda((i.precio_costo || i.precio_unitario || 0) * i.cantidad)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${o.confirmada_por_proveedor
        ? `<div class="portal-confirmada"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Fecha de entrega confirmada por vos</div>`
        : ''}

      ${(puedeConfirmarFecha || puedeAdjuntarFactura) ? `
        <div class="portal-oc-acciones">
          ${puedeConfirmarFecha ? `<button type="button" class="portal-btn" data-toggle="fecha-form-${o.id}">Confirmar fecha de entrega</button>` : ''}
          ${puedeAdjuntarFactura ? `<button type="button" class="portal-btn" data-toggle="factura-form-${o.id}">Adjuntar factura</button>` : ''}
        </div>
      ` : ''}

      ${puedeConfirmarFecha ? `
        <div class="portal-form hidden" id="fecha-form-${o.id}">
          <label for="input-fecha-${o.id}">Fecha de entrega</label>
          <input type="date" id="input-fecha-${o.id}" value="${fmtFechaInput(o.fecha_esperada)}">
          <button type="button" class="portal-btn portal-btn-primary" data-guardar-fecha="${o.id}">Confirmar</button>
          <span class="portal-form-status hidden" id="status-fecha-${o.id}"></span>
        </div>
      ` : ''}

      ${puedeAdjuntarFactura ? formFactura(o.id) : ''}
    </div>
  `;
}

function formFactura(ordenId) {
  return `
    <div class="portal-form hidden" id="factura-form-${ordenId}">
      <label for="input-numero-${ordenId}">Número de factura</label>
      <input type="text" id="input-numero-${ordenId}" placeholder="Ej: A-0001-00001234">
      <label for="input-fechafact-${ordenId}">Fecha de la factura</label>
      <input type="date" id="input-fechafact-${ordenId}" value="${fmtFechaInput(new Date().toISOString())}">
      <label for="input-total-${ordenId}">Total ($)</label>
      <input type="number" id="input-total-${ordenId}" min="0" step="0.01" placeholder="0.00">
      <label for="input-archivo-${ordenId}">Archivo (PDF o foto, opcional)</label>
      <input type="file" id="input-archivo-${ordenId}" accept="image/jpeg,image/png,image/webp,application/pdf">
      <button type="button" class="portal-btn portal-btn-primary" data-guardar-factura="${ordenId}">Subir factura</button>
      <span class="portal-form-status hidden" id="status-factura-${ordenId}"></span>
    </div>
  `;
}

function renderFactura(f) {
  const estadoClase = f.estado === 'pagada' ? 'estado-recibida'
                     : f.estado === 'anulada' ? 'estado-cancelada'
                     : f.estado === 'parcial' ? 'estado-recibida_parcial'
                     : 'estado-enviada';
  const estadoLabel = { pendiente: 'Pendiente', parcial: 'Pago parcial', pagada: 'Pagada', anulada: 'Anulada' }[f.estado] || f.estado;

  return `
    <div class="portal-oc-card">
      <div class="portal-oc-top">
        <div>
          <div class="portal-oc-numero">Factura ${esc(f.numero_factura)}</div>
          <div class="portal-oc-fecha">${fmtFecha(f.fecha_factura)}${f.fecha_vencimiento ? ' · vence ' + fmtFecha(f.fecha_vencimiento) : ''}</div>
        </div>
        <div>
          <div class="portal-oc-total">${moneda(f.total)}</div>
          <span class="portal-badge-estado ${estadoClase}">${estadoLabel}</span>
        </div>
      </div>
      ${f.total_pagado > 0 ? `<div class="portal-oc-meta" style="margin-top:8px">Pagado: ${moneda(f.total_pagado)} de ${moneda(f.total)}</div>` : ''}
      ${f.origen === 'proveedor' ? `<span class="portal-badge-origen">Cargada por vos · pendiente de revisión</span>` : ''}
      ${f.archivo_url ? `<br><a class="portal-link-archivo" href="${f.archivo_url}" target="_blank" rel="noopener">Ver archivo adjunto</a>` : ''}
    </div>
  `;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function mostrarEstadoForm(id, texto, tipo) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = texto;
  el.className = 'portal-form-status' + (tipo ? ' ' + tipo : '');
  if (texto) el.classList.remove('hidden'); else el.classList.add('hidden');
}

function leerArchivoBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

async function guardarFecha(ordenId) {
  const input = document.getElementById(`input-fecha-${ordenId}`);
  const statusId = `status-fecha-${ordenId}`;
  const boton = document.querySelector(`[data-guardar-fecha="${ordenId}"]`);

  const fecha = input.value;
  if (!fecha) {
    mostrarEstadoForm(statusId, 'Elegí una fecha', 'err');
    return;
  }

  boton.disabled = true;
  mostrarEstadoForm(statusId, 'Guardando...', '');

  // Plan offline, Etapa 3 (cierre) — sin red, ni siquiera se intenta el
  // fetch (evita esperar el timeout del navegador): se encola directo.
  if (window.ProveedorOffline && !navigator.onLine) {
    await encolarFecha(ordenId, fecha, statusId);
    return;
  }

  try {
    const r = await fetch(`/api/proveedores?_svc=portal&accion=confirmar-entrega&t=${encodeURIComponent(tokenGlobal)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orden_id: ordenId, fecha_esperada: fecha }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo confirmar la fecha');

    mostrarEstadoForm(statusId, 'Confirmada<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>', 'ok');
    setTimeout(cargarDatos, 900);
  } catch (e) {
    // TypeError de fetch = falla de red (no llegó a responder el servidor,
    // a diferencia de un !r.ok que sí es un rechazo real y no se encola).
    if (window.ProveedorOffline && e instanceof TypeError) {
      await encolarFecha(ordenId, fecha, statusId);
      return;
    }
    mostrarEstadoForm(statusId, e.message, 'err');
    boton.disabled = false;
  }
}

async function encolarFecha(ordenId, fecha, statusId) {
  await window.ProveedorOffline.encolarAccion('confirmar_entrega', {
    orden_id: ordenId,
    fecha_esperada: fecha,
  });
  mostrarEstadoForm(statusId, 'Guardada sin conexión — se envía sola al reconectar', 'ok');
}

async function guardarFactura(ordenId) {
  const statusId = `status-factura-${ordenId}`;
  const boton = document.querySelector(`[data-guardar-factura="${ordenId}"]`);

  const numero = document.getElementById(`input-numero-${ordenId}`).value.trim();
  const fechaFactura = document.getElementById(`input-fechafact-${ordenId}`).value;
  const total = document.getElementById(`input-total-${ordenId}`).value;
  const archivoInput = document.getElementById(`input-archivo-${ordenId}`);
  const archivo = archivoInput.files?.[0];

  if (!numero || !fechaFactura || !total) {
    mostrarEstadoForm(statusId, 'Completá número, fecha y total', 'err');
    return;
  }
  if (Number(total) <= 0) {
    mostrarEstadoForm(statusId, 'El total tiene que ser mayor a 0', 'err');
    return;
  }
  if (archivo && archivo.size > 8 * 1024 * 1024) {
    mostrarEstadoForm(statusId, 'El archivo no puede superar 8MB', 'err');
    return;
  }

  boton.disabled = true;
  mostrarEstadoForm(statusId, 'Subiendo...', '');

  let archivo_base64 = null;
  try {
    if (archivo) archivo_base64 = await leerArchivoBase64(archivo);
  } catch (e) {
    mostrarEstadoForm(statusId, e.message, 'err');
    boton.disabled = false;
    return;
  }

  const payloadFactura = {
    orden_id: ordenId === 'suelta' ? null : ordenId,
    numero_factura: numero,
    fecha_factura: fechaFactura,
    total: Number(total),
    archivo_base64,
  };

  // Plan offline, Etapa 3 (cierre) — mismo criterio que guardarFecha: sin
  // red, directo a la cola sin intentar el fetch primero.
  if (window.ProveedorOffline && !navigator.onLine) {
    await encolarFactura(payloadFactura, statusId);
    return;
  }

  try {
    const r = await fetch(`/api/proveedores?_svc=portal&accion=subir-factura&t=${encodeURIComponent(tokenGlobal)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadFactura),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo subir la factura');

    mostrarEstadoForm(statusId, 'Factura cargada<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>', 'ok');
    setTimeout(cargarDatos, 900);
  } catch (e) {
    if (window.ProveedorOffline && e instanceof TypeError) {
      await encolarFactura(payloadFactura, statusId);
      return;
    }
    mostrarEstadoForm(statusId, e.message, 'err');
    boton.disabled = false;
  }
}

async function encolarFactura(payload, statusId) {
  await window.ProveedorOffline.encolarAccion('subir_factura', payload);
  mostrarEstadoForm(statusId, 'Guardada sin conexión — se envía sola al reconectar', 'ok');
}

document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('portal-main').addEventListener('click', (e) => {
    const toggleId = e.target.dataset.toggle;
    if (toggleId) {
      document.getElementById(toggleId)?.classList.toggle('hidden');
      return;
    }

    const ordenFecha = e.target.dataset.guardarFecha;
    if (ordenFecha) { guardarFecha(ordenFecha); return; }

    const ordenFactura = e.target.dataset.guardarFactura;
    if (ordenFactura) { guardarFactura(ordenFactura); return; }

    const pagPrefix = e.target.dataset.pag;
    if (pagPrefix) {
      const delta = e.target.dataset.dir === 'next' ? 1 : -1;
      if (pagPrefix === 'oc') {
        paginaOC += delta;
        renderOrdenesLista();
        document.getElementById('portal-ordenes-lista')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (pagPrefix === 'facturas') {
        paginaFacturas += delta;
        renderFacturasLista();
        document.getElementById('portal-facturas-lista')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
  });
});
