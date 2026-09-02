// frontend/admin/js/pos/ticket-facturacion.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Ticket, facturar venta, PIN supervisor, reporte Z.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// ── Ticket ─────────────────────────────────────────────────────────────────
function mostrarTicket(venta) {
  document.getElementById('pos-ticket-numero').textContent = `N° ${venta.numero}`;
  const { subtotal, iva_total, descGlobalMonto, total } = calcularTotalesDe(venta.items, venta.descuentoGlobal || 0);

  // Encabezado/pie estilo comprobante de comercio — solo se ve en la vista
  // impresa (@media print, pos.css). Usa empresaData, ya cargado al iniciar
  // el POS (ver init()), igual que el ticket ESC/POS de pos-printer.js.
  const fechaTicket = new Date().toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const headerEl = document.getElementById('pos-ticket-print-header');
  if (headerEl) {
    headerEl.innerHTML = `
      <div class="pos-ticket-print-empresa">${escapeHtml(empresaData?.nombre || '')}</div>
      ${empresaData?.domicilio ? `<div>${escapeHtml(empresaData.domicilio)}</div>` : ''}
      ${empresaData?.cuit     ? `<div>CUIT: ${escapeHtml(empresaData.cuit)}</div>`     : ''}
      ${empresaData?.telefono ? `<div>Tel: ${escapeHtml(empresaData.telefono)}</div>`   : ''}
      <div class="pos-ticket-print-sep"></div>
      <div class="pos-ticket-print-meta"><span>Ticket N° ${escapeHtml(venta.numero || '')}</span><span>${fechaTicket}</span></div>
    `;
  }
  const footerEl = document.getElementById('pos-ticket-print-footer');
  if (footerEl) {
    footerEl.innerHTML = `
      <div class="pos-ticket-print-sep"></div>
      <div class="pos-ticket-print-gracias">¡Gracias por su compra!</div>
    `;
  }

  const pagosEfectivo = (venta.pagos || []).filter(p => p.medio === 'efectivo');
  const pagadoEfectivo = pagosEfectivo.reduce((s, p) => s + p.monto, 0);
  const vuelto = Math.max(0, Math.round(pagadoEfectivo - total));

  document.getElementById('pos-ticket-detalle').innerHTML = `
    <div class="pos-ticket-fila"><span>Cliente</span><span>${escapeHtml(venta.cliente?.razon_social || 'Consumidor final')}</span></div>
    ${venta.items.map(i => `
      <div class="pos-ticket-fila"><span>${i.cantidad} × ${escapeHtml(i.nombre)}${i.descuento_pct ? ` (−${i.descuento_pct}%)` : ''}</span><span>${fmt(i.precio * i.cantidad * (1 - (i.descuento_pct||0)/100))}</span></div>
    `).join('')}
    <div class="pos-ticket-fila"><span>Subtotal</span><span>${fmt(subtotal)}</span></div>
    <div class="pos-ticket-fila"><span>IVA</span><span>${fmt(iva_total)}</span></div>
    ${descGlobalMonto > 0 ? `<div class="pos-ticket-fila"><span>Descuento global (${venta.descuentoGlobal}%)</span><span>−${fmt(descGlobalMonto)}</span></div>` : ''}
    <div class="pos-ticket-fila" style="font-weight:700"><span>Total</span><span>${fmt(total)}</span></div>
    ${venta.pagos.map(p => `
      <div class="pos-ticket-fila"><span>Pago (${labelMedio(p.medio)})</span><span>${fmt(p.monto)}</span></div>
    `).join('')}
    ${vuelto > 0 ? `<div class="pos-ticket-fila" style="color:var(--nav-ventas,#487050);font-weight:600"><span>Vuelto</span><span>${fmt(vuelto)}</span></div>` : ''}
  `;

  const estadoEl = document.getElementById('pos-ticket-factura-estado');
  estadoEl.style.display = 'none';
  estadoEl.className = 'pos-ticket-factura-estado';
  estadoEl.textContent = '';

  pdfUrlActual = null;
  document.getElementById('btn-ver-comprobante').style.display = 'none';

  const btnFacturar = document.getElementById('btn-facturar-venta');
  if (window.tieneRol?.('dueno', 'admin')) {
    btnFacturar.style.display = '';
    btnFacturar.disabled = false;
    btnFacturar.textContent = 'Facturar';
  } else {
    btnFacturar.style.display = 'none';
  }

  document.getElementById('modal-ticket-overlay').style.display = '';

  // ── Fase 3: preguntar si quiere facturar (solo dueño/admin) ──────────
  // Se abre DESPUÉS de que el ticket ya sea visible, con 400ms de delay
  // para que el cajero vea primero el resumen de la venta.
  if (window.tieneRol?.('dueno', 'admin') && ultimaVenta?.venta_id) {
    setTimeout(() => mostrarModalFacturarOpcional(ultimaVenta.venta_id), 400);
  } else {
    // No hay modal de facturación opcional de por medio: el foco va
    // directo a "Nueva venta" para poder encadenar otra venta con un
    // segundo Enter.
    setTimeout(() => document.getElementById('btn-ticket-nueva-venta')?.focus(), 60);
  }
}

window.facturarVenta = async function () {
  if (!ultimaVenta?.venta_id) return;
  const btn = document.getElementById('btn-facturar-venta');
  const estadoEl = document.getElementById('pos-ticket-factura-estado');
  estadoEl.style.display = 'none';

  // Plan offline, Etapa 5: sin conexión, ni vale la pena intentar el
  // fetch — se encola directo (idempotente del lado del servidor, ver
  // nota en pos-offline.js) y se sincroniza sola cuando vuelva la señal.
  if (!navigator.onLine) {
    return _encolarFacturacionOffline(btn, estadoEl);
  }

  btn.disabled = true; btn.textContent = 'Facturando...';
  try {
    const resp = await apiPost('/api/pos/facturar', { venta_pos_id: ultimaVenta.venta_id });
    estadoEl.className = 'pos-ticket-factura-estado ok';
    estadoEl.textContent = `Factura ${resp.factura?.tipo || ''} N° ${resp.factura?.numero || ''} emitida`;
    estadoEl.style.display = '';
    btn.textContent = 'Facturada';

    // Pedir el PDF fiscal (CAE + código de barras) recién emitido. Este
    // endpoint ya existe (GET /api/facturas?accion=pdf) y genera el PDF
    // al toque — no depende de la generación en background de facturas.js,
    // así que está disponible apenas responde.
    if (resp.factura?.id) {
      try {
        const pdfResp = await apiGet(`/api/facturas?id=${resp.factura.id}&accion=pdf`);
        if (pdfResp?.url) {
          pdfUrlActual = pdfResp.url;
          document.getElementById('btn-ver-comprobante').style.display = '';
        }
      } catch (pdfErr) {
        // No crítico: la factura ya quedó emitida con CAE válido en ARCA.
        // Si falla solo la generación del PDF, no bloqueamos el flujo —
        // el usuario puede reabrir la factura desde "Facturas pendientes/emitidas".
        console.error('[pos] No se pudo generar el PDF del comprobante:', pdfErr.message);
      }
    }
  } catch (e) {
    // e.status viene de apiPost solo cuando el servidor SÍ respondió (ver
    // Object.assign en apiPost). Si no hay status, fetch nunca llegó a
    // responder — típicamente la red se cortó justo en el medio (el chequeo
    // de navigator.onLine de arriba ya cubre el caso "offline desde antes
    // de apretar el botón"). En ambos casos, mismo tratamiento: encolar en
    // vez de mostrar un error que invita a "Reintentar" a mano en loop.
    if (e.status === undefined) {
      return _encolarFacturacionOffline(btn, estadoEl);
    }
    estadoEl.className = 'pos-ticket-factura-estado error';
    estadoEl.textContent = e.message || 'No se pudo emitir la factura';
    estadoEl.style.display = '';
    btn.disabled = false; btn.textContent = 'Reintentar';
  }
};

// Plan offline, Etapa 5 — encola la facturación de ultimaVenta en el
// outbox de PosOffline (POST /api/pos/facturar diferido) y refleja el
// estado "en cola" en el modal de ticket. Ver pos-offline.js (TIPO_FACTURAR)
// para el procesamiento real cuando vuelve la conexión.
async function _encolarFacturacionOffline(btn, estadoEl) {
  try {
    await window.PosOffline?.encolarFacturar?.(ultimaVenta.venta_id);
  } catch (encolarErr) {
    console.error('[pos] No se pudo encolar la facturación offline:', encolarErr.message);
  }
  estadoEl.className = 'pos-ticket-factura-estado pendiente';
  estadoEl.textContent = 'Sin conexión: se facturará automáticamente en cuanto vuelva Internet.';
  estadoEl.style.display = '';
  btn.disabled = true;
  btn.textContent = 'En cola (sin conexión)';
}

function calcularTotalesDe(items, descGlobalPct = 0) {
  let subtotal = 0, iva_total = 0;
  for (const i of items) {
    const sub = i.precio * i.cantidad * (1 - (i.descuento_pct || 0) / 100);
    subtotal += sub;
    iva_total += sub * ((i.iva ?? 21) / 100);
  }
  const totalSin = subtotal + iva_total;
  const descGlobalMonto = totalSin * (descGlobalPct / 100);
  const total = Math.round(totalSin - descGlobalMonto); // ídem calcularTotales(): sin centavos
  return { subtotal, iva_total, descGlobalMonto, total };
}

function labelMedio(m) {
  return (MEDIOS_PAGO.find(x => x.value === m) || {}).label || m;
}

window.cerrarModalTicket = function () {
  document.getElementById('modal-ticket-overlay').style.display = 'none';
  inputProducto?.focus();
};

window.imprimirTicket = async function () {
  if (!window.PosPrinter) { window.print(); return; }
  try {
    await window.PosPrinter.imprimirTicket(ultimaVenta || {}, empresaData || {});
  } catch (e) {
    console.error(e);
    window.toast('Error al imprimir el ticket', 'error');
  }
};

// Abre el PDF fiscal real (CAE, código de barras, leyenda ARCA) generado por
// lib/arca/comprobante-pdf.js. Es el comprobante "profesional" para entregar
// o guardar — el ticket de arriba es solo un resumen visual de la venta.
window.verComprobante = function () {
  if (!pdfUrlActual) return;
  window.open(pdfUrlActual, '_blank', 'noopener');
};

// ══════════════════════════════════════════════════════════════════════════
// Fase 2 — ítem 14: PIN supervisor
// Flujo: el cliente pide PIN → modal compacto → verifica en backend →
// si ok, ejecuta el callback; si no, muestra error y deja reintentar.
// ══════════════════════════════════════════════════════════════════════════
let _pinCallback = null;
let _pinMensaje  = '';

function pedirPinSupervisor(mensaje, callback) {
  _pinCallback = callback;
  _pinMensaje  = mensaje;
  document.getElementById('pos-pin-mensaje').textContent = mensaje;
  document.getElementById('pos-pin-input').value = '';
  document.getElementById('pos-pin-error').style.display = 'none';
  document.getElementById('modal-pin-overlay').style.display = '';
  setTimeout(() => document.getElementById('pos-pin-input')?.focus(), 60);
}

window.cerrarModalPin = function () {
  document.getElementById('modal-pin-overlay').style.display = 'none';
  _pinCallback = null;
};

window.confirmarPin = async function () {
  const pin = document.getElementById('pos-pin-input').value.trim();
  const errEl = document.getElementById('pos-pin-error');
  errEl.style.display = 'none';

  if (!pin || pin.length < 4) {
    errEl.textContent = 'El PIN debe tener al menos 4 dígitos.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('btn-confirmar-pin');
  btn.disabled = true;
  try {
    await apiPost('/api/pos/verificar-pin', { pin });
    document.getElementById('modal-pin-overlay').style.display = 'none';
    if (_pinCallback) { _pinCallback(); _pinCallback = null; }
  } catch (e) {
    errEl.textContent = e.message || 'PIN incorrecto';
    errEl.style.display = '';
    document.getElementById('pos-pin-input').value = '';
    document.getElementById('pos-pin-input').focus();
  } finally {
    btn.disabled = false;
  }
};

// Enter en el input del PIN confirma
document.getElementById('pos-pin-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); window.confirmarPin(); }
});

// ══════════════════════════════════════════════════════════════════════════
// Fase 2 — ítem 15: Reporte Z
// ══════════════════════════════════════════════════════════════════════════
window.abrirModalReporteZ = async function () {
  document.getElementById('modal-z-overlay').style.display = '';
  document.getElementById('pos-z-contenido').innerHTML = '<p class="pos-cierre-resumen-vacio">Cargando reporte...</p>';
  try {
    const data = await apiGet(`/api/pos/reporte-z?turno_id=${turnoActual.id}`);
    renderReporteZ(data);
  } catch (e) {
    document.getElementById('pos-z-contenido').innerHTML = `<p class="pos-turno-error">${escapeHtml(e.message || 'Error al generar el reporte')}</p>`;
  }
};

window.cerrarModalReporteZ = function () {
  document.getElementById('modal-z-overlay').style.display = 'none';
};

window.imprimirReporteZ = async function () {
  if (!window.PosPrinter || window.PosPrinter.getConfig().modo === 'browser') {
    window.PosPrinter?.prepararPaginaNavegador?.();
    document.body.classList.add('imprimiendo-z');
    window.print();
    setTimeout(() => document.body.classList.remove('imprimiendo-z'), 1000);
    return;
  }
  try {
    await window.PosPrinter.imprimirReporteZ(ultimoReporteZ || {}, empresaData || {});
  } catch (e) {
    console.error(e);
    window.toast('Error al imprimir el reporte Z', 'error');
  }
};

function renderReporteZ(d) {
  ultimoReporteZ = d;
  const fmt2 = (n) => fmt(n ?? 0);
  const fmtHora = (iso) => window.formatHora ? window.formatHora(iso) : (iso ? new Date(iso).toLocaleString('es-AR') : '—');

  const medios = Object.entries(d.por_medio || {});
  const ventas  = (d.ventas || []);
  const movs    = (d.movimientos || []);

  let html = `
    <div class="pos-z-header">
      <div class="pos-z-empresa">${escapeHtml(d.empresa_nombre || '')}</div>
      <div class="pos-z-titulo">REPORTE DE CIERRE — CAJA Z</div>
      <div class="pos-z-meta">Caja: <b>${escapeHtml(d.caja_nombre || '')}</b> · Vendedor: <b>${escapeHtml(d.vendedor_nombre || '')}</b></div>
      <div class="pos-z-meta">Apertura: ${fmtHora(d.abierto_at)} · ${d.cerrado_at ? 'Cierre: ' + fmtHora(d.cerrado_at) : '<b>Turno aún abierto</b>'}</div>
    </div>

    <div class="pos-z-section">
      <div class="pos-z-row head"><span>Resumen de cobros</span><span></span></div>
      <div class="pos-z-row"><span>Monto inicial</span><span>${fmt2(d.monto_inicial)}</span></div>
      ${medios.map(([m, v]) => `<div class="pos-z-row"><span>${labelMedio(m)}</span><span>${fmt2(v)}</span></div>`).join('')}
      <div class="pos-z-row total"><span>Total vendido</span><span>${fmt2(d.total_ventas)}</span></div>
    </div>`;

  if (movs.length) {
    html += `
    <div class="pos-z-section">
      <div class="pos-z-row head"><span>Movimientos de caja</span><span></span></div>
      ${movs.map(m => {
        const es = m.tipo === 'sangria' || m.tipo === 'retiro_final';
        return `<div class="pos-z-row"><span>${labelMovCaja(m.tipo)}${m.concepto ? ' — ' + escapeHtml(m.concepto) : ''} (${fmtHora(m.hora)})</span><span style="color:${es ? 'var(--color-danger,#7A2820)' : 'var(--nav-ventas,#487050)'}">${es ? '−' : '+'}${fmt2(m.monto)}</span></div>`;
      }).join('')}
    </div>`;
  }

  html += `
    <div class="pos-z-section">
      <div class="pos-z-row total-grande"><span>Efectivo esperado en caja</span><span>${fmt2(d.efectivo_esperado)}</span></div>
      ${d.monto_final_declarado !== undefined && d.monto_final_declarado !== null ? `
        <div class="pos-z-row"><span>Monto declarado</span><span>${fmt2(d.monto_final_declarado)}</span></div>
        <div class="pos-z-row ${(d.diferencia_arqueo ?? 0) === 0 ? 'ok' : 'diferencia'}"><span>Diferencia</span><span>${fmt2(d.diferencia_arqueo)}</span></div>
      ` : ''}
    </div>`;

  if (ventas.length) {
    html += `
    <div class="pos-z-section pos-z-ventas">
      <div class="pos-z-row head"><span>Ventas del turno (${ventas.length})</span><span></span></div>
      ${ventas.map(v => `<div class="pos-z-row"><span>N° ${escapeHtml(v.numero)} · ${escapeHtml(v.cliente)}</span><span>${fmt2(v.total)}</span></div>`).join('')}
    </div>`;
  }

  document.getElementById('pos-z-contenido').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════════════════
// Etapa 4 — Panel "Administrar" (sin cambios respecto a la v anterior,
// solo se agrega la pestaña Favoritos)
// ══════════════════════════════════════════════════════════════════════════
let depositosAdmin        = [];
let productoTransfSel     = null;
let buscarVentaTimer      = null;
let buscarProdTransfTimer = null;

window.abrirModalAdmin = function (tab) {
  document.getElementById('modal-admin-overlay').style.display = '';
  cambiarTabAdmin(tab || 'ventas');
};
window.cerrarModalAdmin = function () {
  document.getElementById('modal-admin-overlay').style.display = 'none';
  // Si se tocaron favoritos, refrescar la grilla del POS
  cargarFavoritos();
};
// Cerrar al hacer clic fuera de la tarjeta del modal (mismo patrón que el resto de distrib)
document.getElementById('modal-admin-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'modal-admin-overlay') window.cerrarModalAdmin();
});

window.cambiarTabAdmin = function (tab) {
  ['ventas','stock','favoritos-tab','devoluciones','promociones','hardware','config-pos'].forEach(t => {
    document.getElementById(`tab-${t}`)?.classList.toggle('activo', t === tab);
    const panel = document.getElementById(`panel-admin-${t}`);
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'ventas') cargarVentas();
  else if (tab === 'stock') { cargarDepositosAdmin(); cargarTransferencias(); }
  else if (tab === 'favoritos-tab') cargarFavoritosAdmin();
  else if (tab === 'devoluciones') iniciarPanelDevoluciones();
  else if (tab === 'promociones') iniciarPanelPromociones();
  else if (tab === 'hardware') { cargarConfigHardware(); }
  else if (tab === 'config-pos') iniciarPanelConfigPos();
};

