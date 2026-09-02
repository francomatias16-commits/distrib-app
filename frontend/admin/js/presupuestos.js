// frontend/admin/js/presupuestos.js
// REQ-05: Módulo de presupuestos — cargado condicionalmente desde pedidos.html
// Todas las funciones usan prefijo pres_ para evitar colisiones con pedidos.js

(function () {

let _sb        = null;
let _usuario   = null;
let _empresa   = null;
let _presData  = [];
let _filtrados = [];
let _estadoAct = '';
let _clientes  = [];
let _productos = [];   // mantenido para render de filas confirmadas
let _picker     = null; // ProductoPicker — lazy-init al abrir modal
let _itemsModal = [];
// UI-004: mapa producto_id → precio resuelto para el cliente activo en el modal.
// Se puebla al elegir cliente y se usa como precio sugerido al agregar productos.
let _preciosCliente = {};

// ── Init (llamado desde pedidos.html cuando cambia al tab presupuestos) ───
// FIX: memoizado con _initPromise. Antes, cambiarTab() disparaba esto sin
// esperarlo ("fire and forget"), así que si el usuario abría "Nuevo
// presupuesto" apenas cambiaba de pestaña, el modal se abría con la carga
// de clientes todavía en vuelo y el <select> quedaba vacío. Ahora
// pres_abrirModalNuevo() puede hacer `await window.presupuestos_init()` y,
// si ya se estaba ejecutando (o ya terminó), reutiliza la misma promesa en
// vez de disparar una carga nueva.
let _initPromise = null;
window.presupuestos_init = function () {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    _sb      = window.authCtx.sb;
    _usuario = window.authCtx.perfil;
    _empresa = window.authCtx.perfil?.empresas || { id: window.authCtx.perfil?.empresa_id };

    initFiltroTabsPresEstado();
    if (!_clientes.length)  await pres_cargarClientes();
    // _productos ya no se pre-carga; el ProductoPicker los obtiene al abrir el modal
    await pres_cargarPresupuestos();
  })();
  return _initPromise;
};

// ── Carga auxiliar ────────────────────────────────────────────────────────
async function pres_cargarClientes() {
  const { data } = await window.conTimeoutRed(_sb.from('clientes')
    .select('id, razon_social, nombre_fantasia, direccion, zona_id, zonas(nombre), saldo_deuda, limite_credito')
    .eq('empresa_id', _empresa.id)
    .eq('activo', true)
    .order('razon_social'), 10000);
  _clientes = data || [];

  const sel = document.getElementById('pres-f-cliente');
  if (!sel) return;
  sel.innerHTML = '<option value="">Seleccionar cliente...</option>';
  _clientes.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.nombre_fantasia || c.razon_social;
    sel.appendChild(o);
  });
  sel.addEventListener('change', pres_mostrarInfoClienteAuto);
  window.habilitarFiltroSelect?.(sel, document.getElementById('pres-f-cliente-filtro'));
}

async function pres_mostrarInfoClienteAuto() {
  const sel = document.getElementById('pres-f-cliente');
  const box = document.getElementById('pres-info-cliente-auto');
  const txt = document.getElementById('pres-info-cliente-auto-texto');
  if (!sel || !box || !txt) return;
  const cliente = _clientes.find(c => c.id === sel.value);
  if (!cliente) { box.style.display = 'none'; _preciosCliente = {}; return; }
  const direccion = cliente.direccion || 'sin dirección registrada';
  const zona      = cliente.zonas?.nombre || 'sin zona asignada';
  const saldo     = Number(cliente.saldo_deuda || 0);
  const ctaCte    = saldo > 0
    ? `tiene un saldo pendiente de $${saldo.toLocaleString('es-AR')}`
    : 'su cuenta corriente está al día';
  txt.innerHTML = `<strong>¡Datos auto-completados!</strong> Dirección: <strong>${pres_esc(direccion)}</strong>, zona <strong>${pres_esc(zona)}</strong>, ${ctaCte}.`;
  box.style.display = 'flex';

  // UI-004: resolver precios reales del cliente para que el modal muestre el
  // precio correcto (lista especial / zona / descuento) como valor por defecto,
  // en vez del precio_base crudo. El vendedor puede editarlo a mano igual.
  await pres_actualizarPreciosParaCliente(cliente.id);
}

/**
 * Llama al endpoint GET /api/presupuestos?accion=precios-cliente y actualiza
 * _preciosCliente + los ítems ya cargados en el modal.
 */
async function pres_actualizarPreciosParaCliente(clienteId) {
  _preciosCliente = {};
  if (!clienteId) return;

  // Recolectar todos los producto_ids activos en el modal
  const ids = _itemsModal.map(it => it.producto_id).filter(Boolean);

  try {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) return;

    const qs = `accion=precios-cliente&cliente_id=${encodeURIComponent(clienteId)}` +
               (ids.length ? `&producto_ids=${ids.join(',')}` : '');
    const r = await fetch(`/api/presupuestos?${qs}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!r.ok) return;
    const precios = await r.json();
    // precios = [{ producto_id, precio }, ...]
    _preciosCliente = Object.fromEntries((precios || []).map(p => [p.producto_id, p.precio]));

    // Actualizar precio sugerido en ítems ya cargados y re-renderizar
    let cambio = false;
    _itemsModal.forEach(it => {
      if (it.producto_id && _preciosCliente[it.producto_id] != null) {
        it.precio_unitario = _preciosCliente[it.producto_id];
        cambio = true;
      }
    });
    if (cambio) pres_renderItemsModal();
  } catch (_) {
    // silencioso — el fallback es precio_base que ya tenía el item
  }
}

async function pres_cargarProductos() {
  const { data } = await window.conTimeoutRed(_sb.from('productos')
    .select('id, codigo, nombre, precio_base, unidad')
    .eq('empresa_id', _empresa.id)
    .eq('activo', true)
    .order('nombre'), 10000);
  _productos = data || [];
}

// ── Cargar presupuestos ───────────────────────────────────────────────────
async function pres_cargarPresupuestos() {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/admin/login'; return; }

  let url = '/api/presupuestos';
  if (_estadoAct) url += `?estado=${_estadoAct}`;

  window.mostrarSkeletonTabla?.('pres-tbody', 7);

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    _presData = Array.isArray(json) ? json : (json.data ?? []);
    pres_aplicarFiltros();
  } catch (err) {
    const tbody = document.getElementById('pres-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="tabla-empty">Error al cargar. Recargá la página.</td></tr>';
  }
}

// ── Filtros ───────────────────────────────────────────────────────────────
function pres_aplicarFiltros() {
  const q = (document.getElementById('pres-busqueda')?.value || '').toLowerCase().trim();
  _filtrados = _presData.filter(p => {
    if (_estadoAct && p.estado !== _estadoAct) return false;
    if (q) {
      const num = (p.numero || '').toLowerCase();
      const cli = (p.clientes?.nombre_fantasia || p.clientes?.razon_social || '').toLowerCase();
      if (!num.includes(q) && !cli.includes(q)) return false;
    }
    return true;
  });
  pres_renderTabla();
  const cont = document.getElementById('pres-contador');
  if (cont) cont.textContent = `${_filtrados.length} presupuesto${_filtrados.length !== 1 ? 's' : ''}`;
}

// FiltroTabs (frontend/shared/filtro-tabs.js) — mismo patrón que en
// pedidos.js/cta-cte.js. `/api/presupuestos` ya filtra server-side por
// ?estado=, así que _presData nunca tiene el conjunto completo para sacar
// un conteo confiable por estado: los badges quedan sin número.
function initFiltroTabsPresEstado() {
  const cont = document.getElementById('filtro-tabs-pres-estado');
  if (!cont || typeof FiltroTabs === 'undefined') return;
  FiltroTabs.crear(cont, [
    { key: '',          label: 'Todos' },
    { key: 'borrador',  label: 'Borrador' },
    { key: 'enviado',   label: 'Enviados' },
    { key: 'aceptado',  label: 'Aceptados' },
    { key: 'rechazado', label: 'Rechazados' },
    { key: 'vencido',   label: 'Vencidos' },
  ], _estadoAct, (key) => window.pres_selEstado(key));
}

window.pres_selEstado = function(estado) {
  _estadoAct = estado;
  pres_cargarPresupuestos();
};

window.pres_aplicarFiltros = pres_aplicarFiltros;

// ── Render tabla ──────────────────────────────────────────────────────────
function pres_renderTabla() {
  const tbody = document.getElementById('pres-tbody');
  if (!tbody) return;

  if (!_filtrados.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--color-text-muted)">
      <div style="font-size:32px;margin-bottom:8px"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:0px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg></div>
      <strong>Sin presupuestos</strong><br>
      <span style="font-size:13px">No se encontraron presupuestos con los filtros aplicados.</span>
    </td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();
  _filtrados.forEach(p => {
    const cli    = p.clientes?.nombre_fantasia || p.clientes?.razon_social || '—';
    const vend   = p.usuarios?.nombre || '—';
    const total  = pres_fmt(p.total);
    const venc   = p.fecha_vencimiento ? pres_fmtFecha(p.fecha_vencimiento) : '—';
    const estado = pres_badgeEstado(p.estado);
    const esAdmin = ['dueno','admin','vendedor','contador'].includes(_usuario?.rol);

    let acciones = `<button class="btn-acc" onclick="pres_verDetalle('${p.id}')">Ver</button>`;
    if (esAdmin && p.estado === 'borrador')
      acciones += ` <button class="btn-acc btn-primary btn--primary" onclick="pres_enviarYNotificar('${p.id}')">Enviar por WhatsApp</button>`;
    if (esAdmin && p.estado === 'enviado')
      acciones += ` <button class="btn-acc" onclick="pres_enviarWhatsApp('${p.id}')">Reenviar WhatsApp</button>`;
    if (esAdmin && p.estado === 'borrador')
      acciones += ` <button class="btn-acc btn-danger btn--danger" onclick="pres_eliminarPresupuesto('${p.id}')">Eliminar</button>`;
    if (p.estado === 'aceptado')
      acciones += ` <span class="badge badge-ok" style="font-size:11px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Pedido generado</span>`;

    const tr = document.createElement('tr');
    tr.dataset.testid = 'presupuestos-fila';
    tr.dataset.id = p.id;
    tr.innerHTML = `
      <td data-label="Número"><strong>${p.numero}</strong></td>
      <td data-label="Cliente">${pres_esc(cli)}</td>
      <td data-label="Vendedor">${pres_esc(vend)}</td>
      <td data-label="Total">$${total}</td>
      <td data-label="Vencimiento">${venc}</td>
      <td data-label="Estado">${estado}</td>
      <td class="acciones col-sticky-end" data-label="Acciones" style="white-space:nowrap">${acciones}</td>`;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

function pres_badgeEstado(e) {
  const m = {
    borrador:  { cls: 'badge-muted', txt: 'Borrador'  },
    enviado:   { cls: 'badge-info',  txt: 'Enviado'   },
    aceptado:  { cls: 'badge-ok',    txt: 'Aceptado'  },
    rechazado: { cls: 'badge-danger',txt: 'Rechazado' },
    vencido:   { cls: 'badge-warn',  txt: 'Vencido'   },
  };
  const b = m[e] || { cls: 'badge-muted', txt: e };
  return `<span class="badge ${b.cls}">${b.txt}</span>`;
}

// ── Ver detalle ───────────────────────────────────────────────────────────
window.pres_verDetalle = async function(id) {
  const panel = document.getElementById('pres-panel-detalle');
  const body  = document.getElementById('pres-panel-body');
  const nom   = document.getElementById('pres-panel-nombre');
  body.innerHTML = '<p style="padding:20px;color:var(--color-text-muted)">Cargando…</p>';
  panel.classList.add('abierto');

  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/admin/login'; return; }

  try {
    const r = await fetch(`/api/presupuestos?id=${id}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    const p = await r.json();
    if (!r.ok) { body.innerHTML = `<p style="padding:20px;color:red">${sanitize(p.error)}</p>`; return; }

    nom.textContent = p.numero;
    const cli   = p.clientes?.nombre_fantasia || p.clientes?.razon_social || '—';
    const vend  = p.usuarios?.nombre || '—';
    const venc  = p.fecha_vencimiento ? pres_fmtFecha(p.fecha_vencimiento) : '—';
    const items = p.presupuesto_items || [];

    const itemsHtml = items.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:10px">
          <thead><tr style="border-bottom:1px solid var(--color-border)">
            <th style="text-align:left;padding:4px 8px">Producto</th>
            <th style="text-align:left;padding:4px 8px">Cant.</th>
            <th style="text-align:left;padding:4px 8px">Precio</th>
            <th style="text-align:left;padding:4px 8px">Dto%</th>
            <th style="text-align:left;padding:4px 8px">Subtotal</th>
          </tr></thead>
          <tbody>${items.map(it => `
            <tr style="border-bottom:1px solid var(--color-border)">
              <td style="padding:4px 8px">${pres_esc(it.descripcion || it.productos?.nombre || '—')}</td>
              <td style="text-align:left;padding:4px 8px">${it.cantidad}</td>
              <td style="text-align:left;padding:4px 8px">$${pres_fmt(it.precio_unitario)}</td>
              <td style="text-align:left;padding:4px 8px">${it.descuento_pct ?? it.descuento ?? 0}%</td>
              <td style="text-align:left;padding:4px 8px">$${pres_fmt(it.subtotal)}</td>
            </tr>`).join('')}
          </tbody>
        </table>`
      : '<p style="color:var(--color-text-muted);font-size:13px">Sin ítems.</p>';

    const botonesAccion = p.estado === 'borrador'
      ? `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
           <button class="btn-acc btn-primary btn--primary" onclick="pres_enviarYNotificar('${p.id}')">Enviar por WhatsApp</button>
           <button class="btn-acc btn-danger btn--danger" onclick="pres_eliminarPresupuesto('${p.id}');pres_cerrarPanel()">Eliminar</button>
         </div>`
      : (p.estado === 'enviado'
          ? `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
               <button class="btn-acc" onclick="pres_enviarWhatsApp('${p.id}')">Reenviar WhatsApp</button>
               <button class="btn-acc btn-danger btn--danger" onclick="pres_rechazar('${p.id}')">Rechazar</button>
               <button class="btn-acc btn-primary btn--primary" onclick="pres_aceptarYGenerarPedido('${p.id}')">Aceptar y generar pedido</button>
             </div>`
          : '');

    const pedidoLink = p.pedido_id
      ? `<div style="font-size:12px;color:var(--color-success);margin-top:8px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Pedido generado: ${p.pedido_id.slice(-8).toUpperCase()}</div>`
      : (p.estado === 'aceptado'
          ? '<div style="font-size:12px;color:var(--color-text-muted);margin-top:8px">Aceptado — sin pedido vinculado todavía.</div>'
          : '');

    body.innerHTML = `
      <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
          <div><span style="color:var(--color-text-muted)">Cliente:</span> <strong>${pres_esc(cli)}</strong></div>
          <div><span style="color:var(--color-text-muted)">Vendedor:</span> ${pres_esc(vend)}</div>
          <div><span style="color:var(--color-text-muted)">Estado:</span> ${pres_badgeEstado(p.estado)}</div>
          <div><span style="color:var(--color-text-muted)">Vence:</span> ${venc}</div>
        </div>
        ${p.notas ? `<div style="font-size:13px;background:var(--color-bg);padding:8px 12px;border-radius:6px">${pres_esc(p.notas)}</div>` : ''}
        ${itemsHtml}
        <div style="text-align:right;font-size:16px;font-weight:700;color:var(--color-primary)">Total: $${pres_fmt(p.total)}</div>
        ${pedidoLink}
        ${botonesAccion}
      </div>`;
  } catch (err) {
    body.innerHTML = `<p style="padding:20px;color:red">Error: ${sanitize(err.message)}</p>`;
  }
};

window.pres_aceptarYGenerarPedido = async function(id) {
  const btn = document.querySelector(`button[onclick="pres_aceptarYGenerarPedido('${id}')"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Generando…'; }

  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/admin/login'; return; }

  try {
    const r = await fetch('/api/presupuestos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ id, estado: 'aceptado' })
    });
    const json = await r.json();

    if (!r.ok) {
      if (json.codigo === 'presupuesto_ya_convertido') {
        window.toast('Este presupuesto ya fue procesado por otro usuario. Recargá la lista.', 'error');
        pres_cerrarPanel();
        await pres_cargarPresupuestos();
        return;
      }
      window.toast(json.error || 'Error al aceptar el presupuesto.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Aceptar y generar pedido'; }
      return;
    }

    window.toast('Presupuesto aceptado. Pedido generado.', 'exito');
    pres_cerrarPanel();
    await pres_cargarPresupuestos();

    // REQ-05: saltar a la pestaña Pedidos y resaltar el pedido recién generado
    if (json.pedido_id && typeof window.cambiarTab === 'function') {
      window.cambiarTab('pedidos');
      if (typeof window.cargarPedidos === 'function') await window.cargarPedidos();
      setTimeout(() => {
        const tr = document.querySelector(`#tabla-body tr[data-id="${json.pedido_id}"]`);
        if (tr) {
          tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
          tr.style.transition = 'background-color .4s';
          tr.style.backgroundColor = 'var(--color-primary-bg, rgba(106,152,115,.14))';
          setTimeout(() => { tr.style.backgroundColor = ''; }, 2500);
        }
      }, 400);
    }
  } catch (err) {
    window.toast('Error de conexión.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Aceptar y generar pedido'; }
  }
};

window.pres_rechazar = async function(id) {
  if (!confirm('¿Rechazar este presupuesto? El cliente no podrá generar un pedido a partir de él.')) return;
  await pres_cambiarEstado(id, 'rechazado');
  pres_cerrarPanel();
};

window.pres_cerrarPanel = function() {
  document.getElementById('pres-panel-detalle')?.classList.remove('abierto');
};

// ── Cambiar estado ────────────────────────────────────────────────────────
window.pres_cambiarEstado = async function(id, estado) {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) return;
  try {
    const r = await fetch('/api/presupuestos', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body:    JSON.stringify({ id, estado }),
    });
    const json = await r.json();
    if (!r.ok) { window.toast(json.error || 'Error al actualizar.', 'error'); return; }
    window.toast(`Estado actualizado a "${estado}".`, 'exito');
    await pres_cargarPresupuestos();
  } catch (err) {
    window.toast('Error de conexión.', 'error');
  }
};

// ── Enviar por WhatsApp ───────────────────────────────────────────────────
function pres_normalizarTelefono(tel) {
  let digits = String(tel || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('54')) return digits;
  if (digits.startsWith('0')) digits = digits.slice(1);
  return '54' + digits;
}

function pres_construirMensajeWA(p) {
  const cli = p.clientes?.nombre_fantasia || p.clientes?.razon_social || '';
  const nombreEmpresa = _empresa?.nombre || 'tu distribuidora';
  const items = p.presupuesto_items || [];
  const venc = p.fecha_vencimiento ? pres_fmtFecha(p.fecha_vencimiento) : null;

  const lineasItems = items.map(it => {
    const nombre = it.descripcion || it.productos?.nombre || 'Producto';
    const cant   = it.cantidad;
    const sub    = pres_fmt(it.subtotal);
    const dto    = (it.descuento_pct ?? it.descuento ?? 0) > 0 ? ` (-${it.descuento_pct ?? it.descuento}%)` : '';
    return `• ${nombre} x${cant}${dto} — $${sub}`;
  }).join('\n');

  let msg = `Hola ${cli}\n\nTe compartimos el presupuesto *${p.numero}* de *${nombreEmpresa}*:\n\n${lineasItems}\n\n*Total: $${pres_fmt(p.total)}*`;
  if (venc) msg += `\n\nVálido hasta el ${venc}.`;
  msg += `\n\nCualquier consulta avisanos. ¡Gracias!`;
  return msg;
}

window.pres_enviarWhatsApp = async function(id) {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/admin/login'; return; }

  try {
    const r = await fetch(`/api/presupuestos?id=${id}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    const p = await r.json();
    if (!r.ok) { window.toast(p.error || 'Error al cargar el presupuesto.', 'error'); return; }

    const telNorm = pres_normalizarTelefono(p.clientes?.telefono);
    if (!telNorm) {
      window.toast('El cliente no tiene teléfono registrado. Agregalo en Clientes primero.', 'error');
      return;
    }

    const mensaje = pres_construirMensajeWA(p);
    const url = `https://wa.me/${telNorm}?text=${encodeURIComponent(mensaje)}`;
    window.open(url, '_blank');
  } catch (err) {
    window.toast('Error de conexión.', 'error');
  }
};

// Marca el presupuesto como "enviado" y abre WhatsApp con el detalle en un solo paso
window.pres_enviarYNotificar = async function(id) {
  await window.pres_cambiarEstado(id, 'enviado');
  await window.pres_enviarWhatsApp(id);
  pres_cerrarPanel();
};


window.pres_eliminarPresupuesto = async function(id) {
  const ok = await window.confirmar(
    '¿Eliminar este presupuesto? Esta acción no se puede deshacer.',
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) return;
  try {
    const r = await fetch(`/api/presupuestos?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const json = await r.json();
    if (!r.ok) { window.toast(json.error || 'Error al eliminar.', 'error'); return; }
    window.toast('Presupuesto eliminado.', 'exito');
    await pres_cargarPresupuestos();
  } catch (err) {
    window.toast('Error de conexión.', 'error');
  }
};

// ── Modal nuevo presupuesto ───────────────────────────────────────────────
window.pres_abrirModalNuevo = async function() {
  // FIX: garantiza que _clientes (y el <select>) ya estén cargados antes de
  // mostrar el modal, sin importar si el usuario lo abrió apenas cambió de
  // pestaña. Ver comentario en presupuestos_init().
  await window.authReady;
  await window.presupuestos_init();

  _itemsModal = [];
  const fc = document.getElementById('pres-f-cliente');
  const fv = document.getElementById('pres-f-vigencia');
  const fn = document.getElementById('pres-f-notas');
  const ff = document.getElementById('pres-f-cliente-filtro');
  const ia = document.getElementById('pres-info-cliente-auto');
  if (fc) fc.value = '';
  if (fv) fv.value = '48';
  if (fn) fn.value = '';
  if (ff) ff.value = '';
  fc?.querySelectorAll('option').forEach(o => { o.hidden = false; });
  if (ia) ia.style.display = 'none';
  pres_renderItemsModal();

  // Inicializar el ProductoPicker la primera vez; resetearlo en re-aperturas
  const pickerEl = document.getElementById('pres-picker-container');
  if (pickerEl) {
    if (!_picker) {
      _picker = new window.ProductoPicker(pickerEl, {
        onAgregar(item) {
          // v(combos): renglón de combo — nunca se fusiona con otro (cada
          // "Agregar" es una fila propia) ni pasa por _preciosCliente (esa
          // tabla es de precios por producto/cliente; el combo siempre usa
          // su precio propio, resuelto server-side igual que en pedidos).
          if (item.combo_id) {
            _itemsModal.push({
              combo_id:        item.combo_id,
              descripcion:     item.descripcion,
              cantidad:        item.cantidad,
              precio_unitario: item.precio_unitario,
              descuento:       0,
              es_combo:        true,
            });
            pres_renderItemsModal();
            return;
          }
          // REQ-AGIL: si el producto ya está en la lista, suma cantidad
          // en vez de crear una fila duplicada.
          const existente = item.producto_id &&
            _itemsModal.find(it => it.producto_id === item.producto_id);
          // UI-004: usar precio resuelto por cliente si está disponible;
          // de lo contrario, caer al precio_base que trae el picker.
          const precioSugerido = (item.producto_id && _preciosCliente[item.producto_id] != null)
            ? _preciosCliente[item.producto_id]
            : item.precio_unitario;
          if (existente) {
            existente.cantidad = (Number(existente.cantidad) || 0) + (Number(item.cantidad) || 0);
          } else {
            _itemsModal.push({
              producto_id:     item.producto_id,
              descripcion:     item.descripcion,
              cantidad:        item.cantidad,
              precio_unitario: precioSugerido,
              descuento:       0,
            });
          }
          pres_renderItemsModal();
        }
      });
      await _picker.init(_sb, _empresa.id);
    } else {
      _picker.reset();
    }
  }

  document.getElementById('pres-modal-nuevo')?.classList.remove('hidden');
  _picker?.focus();
};

window.pres_cerrarModalNuevo = function() {
  document.getElementById('pres-modal-nuevo')?.classList.add('hidden');
};

window.pres_agregarItemModal = function() {
  // Fila manual en blanco (para quien prefiera tipear directo)
  _itemsModal.push({ producto_id: '', descripcion: '', cantidad: 1, precio_unitario: 0, descuento: 0 });
  pres_renderItemsModal();
};

window.pres_quitarItem = function(idx) {
  _itemsModal.splice(idx, 1);
  pres_renderItemsModal();
};

function pres_renderItemsModal() {
  const cont = document.getElementById('pres-items-container');
  if (!cont) return;
  if (!_itemsModal.length) {
    cont.innerHTML = '<div class="empty-items" style="font-size:12px;color:var(--color-text-muted);padding:8px 0">Sin ítems. Usá el buscador de arriba para agregar productos.</div>';
    pres_recalcTotal();
    return;
  }
  // Opciones para el select (ítems ya cargados en el picker, fallback vacío)
  const opts = (_picker?._productos || _productos).map(p =>
    `<option value="${p.id}" data-precio="${p.precio_base || 0}">${p.codigo ? p.codigo + ' — ' : ''}${sanitize(p.nombre)}</option>`
  ).join('');
  cont.innerHTML = _itemsModal.map((it, i) => `
    <div class="item-row pres-item-row" id="pres-item-row-${i}">
      <select class="item-prod" onchange="pres_selProd(${i},this)">
        <option value="">Seleccionar...</option>${opts}
      </select>
      <input class="item-desc"   type="text"   placeholder="Descripción" value="${pres_esc(it.descripcion)}"
             oninput="pres_updItem(${i},'descripcion',this.value)" />
      <input class="item-cant"   type="number" min="1" step="1" value="${it.cantidad}"
             oninput="pres_updItem(${i},'cantidad',parseInt(this.value,10)||0);pres_recalcTotal()" />
      <input class="item-precio" type="number" min="0" step="1" data-money value="${Math.round(it.precio_unitario)}"
             oninput="pres_updItem(${i},'precio_unitario',+this.value);pres_recalcTotal()" />
      <input class="item-dto"    type="number" min="0" max="100" step="1" value="${it.descuento}"
             oninput="pres_updItem(${i},'descuento',+this.value);pres_recalcTotal()" />
      <button class="btn-quitar" onclick="pres_quitarItem(${i})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>`).join('');
  _itemsModal.forEach((it, i) => {
    if (it.producto_id) {
      const sel = cont.querySelector(`#pres-item-row-${i} .item-prod`);
      if (sel) sel.value = it.producto_id;
    }
  });
  pres_recalcTotal();
}

window.pres_selProd = function(idx, sel) {
  const opt = sel.options[sel.selectedIndex];
  _itemsModal[idx].producto_id     = sel.value;
  _itemsModal[idx].descripcion     = opt.textContent.split(' — ')[1] || '';
  _itemsModal[idx].precio_unitario = parseFloat(opt.dataset.precio || 0);
  pres_renderItemsModal();
};

window.pres_updItem = function(idx, campo, valor) {
  _itemsModal[idx][campo] = valor;
};

function pres_recalcTotal() {
  const total = _itemsModal.reduce((acc, it) =>
    acc + (it.cantidad || 0) * (it.precio_unitario || 0) * (1 - (it.descuento || 0) / 100), 0);
  const el = document.getElementById('pres-total-modal');
  if (el) el.textContent = `$${pres_fmt(total)}`;
}

window.pres_guardarPresupuesto = async function() {
  const cliente_id    = document.getElementById('pres-f-cliente')?.value;
  const dias_vigencia = parseInt(document.getElementById('pres-f-vigencia')?.value) || 48;
  const notas         = document.getElementById('pres-f-notas')?.value.trim() || null;

  if (!cliente_id)         { window.toast('Seleccioná un cliente.', 'error'); return; }
  if (!_itemsModal.length) { window.toast('Agregá al menos un ítem.', 'error'); return; }
  const items = _itemsModal.filter(it => it.cantidad > 0 && it.precio_unitario >= 0);
  if (!items.length)       { window.toast('Los ítems deben tener cantidad > 0.', 'error'); return; }

  const clienteTxt = document.getElementById('pres-f-cliente')
    ?.selectedOptions?.[0]?.textContent?.trim() || 'el cliente seleccionado';
  const ok = await window.confirmar(
    `¿Confirmás crear este presupuesto para ${clienteTxt} (${items.length} ítem${items.length === 1 ? '' : 's'})?`,
    { labelOk: 'Crear presupuesto', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  const btn = document.getElementById('pres-btn-guardar');
  if (btn) btn.disabled = true;

  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/admin/login'; return; }

  try {
    // FIX: mapear 'descuento' (nombre interno del modal) → 'descuento_pct' (columna DB)
    const itemsApi = items.map(it => ({ ...it, descuento_pct: it.descuento || 0 }));
    const r = await fetch('/api/presupuestos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ cliente_id, items: itemsApi, notas, dias_vigencia }),
    });
    const json = await r.json();
    if (!r.ok) { window.toast(json.error || 'Error al guardar.', 'error'); return; }
    window.toast(`Presupuesto ${json.numero} creado.`, 'exito');
    window.pres_cerrarModalNuevo();
    await pres_cargarPresupuestos();
  } catch (err) {
    window.toast('Error de conexión.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────
function pres_fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pres_fmtFecha(s) { const d = new Date(s); return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' }); }
function pres_esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

})(); // fin IIFE
