// frontend/admin/js/pos/cliente-rapido-alertas.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Alta rápida de cliente, alerta de stock vacío, modal facturar opcional.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// ── Alta rápida de cliente desde la caja ─────────────────────────────────
window.abrirModalClienteRapido = function () {
  document.getElementById('cr-razon-social').value = '';
  document.getElementById('cr-cuit').value = '';
  document.getElementById('cr-telefono').value = '';
  document.getElementById('cr-condicion-iva').value = 'consumidor_final';
  document.getElementById('cr-error').style.display = 'none';
  document.getElementById('modal-cliente-rapido-overlay').style.display = '';
  setTimeout(() => document.getElementById('cr-razon-social')?.focus(), 60);
};

window.cerrarModalClienteRapido = function () {
  document.getElementById('modal-cliente-rapido-overlay').style.display = 'none';
};

window.confirmarClienteRapido = async function () {
  const errEl = document.getElementById('cr-error');
  errEl.style.display = 'none';

  const razon_social  = document.getElementById('cr-razon-social').value.trim();
  const cuit          = document.getElementById('cr-cuit').value.trim();
  const telefono      = document.getElementById('cr-telefono').value.trim();
  const condicion_iva = document.getElementById('cr-condicion-iva').value;

  if (!razon_social) {
    errEl.textContent = 'El nombre / razón social es obligatorio.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('btn-confirmar-cliente-rapido');
  btn.disabled = true;

  try {
    const nuevo = await apiPost('/api/pos/cliente-rapido', {
      razon_social, cuit: cuit || null, telefono: telefono || null, condicion_iva,
    });
    seleccionarCliente({ id: nuevo.id, razon_social: nuevo.razon_social, lista_precio_id: nuevo.lista_precio_id || null });
    window.toast(`Cliente "${sanitize(nuevo.razon_social)}" creado y seleccionado`, 'exito');
    cerrarModalClienteRapido();
    // Cerrar también el buscador si estaba abierto
    document.getElementById('pos-buscador-cliente').style.display = 'none';
  } catch (e) {
    // Si el cliente ya existe, ofrecer seleccionarlo
    if (e.status === 409 && e.tipo !== undefined || (e.message || '').includes('Ya existe')) {
      errEl.innerHTML = escapeHtml(e.message || 'Ya existe un cliente con ese CUIT.');
      errEl.style.display = '';
    } else {
      errEl.textContent = e.message || 'No se pudo crear el cliente.';
      errEl.style.display = '';
    }
  } finally {
    btn.disabled = false;
  }
};

// Enter en razon_social avanza al siguiente campo
document.getElementById('cr-razon-social')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('cr-cuit')?.focus(); }
});
document.getElementById('cr-cuit')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('cr-telefono')?.focus(); }
});
document.getElementById('cr-telefono')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); window.confirmarClienteRapido(); }
});

// ── Verificar stock vacío en depósito de mostrador ───────────────────────
// FIX v477 (pedido: "no volver a ver este mensaje"): se agrega un dismiss
// por día + por caja (no permanente) — es un aviso de que ciertas ventas
// van a ser RECHAZADAS por falta de stock, así que ocultarlo para siempre
// podría tapar un problema operativo real. "No mostrar de nuevo hoy" alcanza
// para no repetirlo en cada apertura del POS durante el mismo turno/jornada,
// y vuelve a aparecer al día siguiente si el faltante sigue sin resolverse.
function claveDismissStock(caja_id) {
  return `pos_stock_alerta_dismiss_${caja_id}`;
}
function alertaStockDismissedHoy(caja_id) {
  try {
    return localStorage.getItem(claveDismissStock(caja_id)) === new Date().toISOString().slice(0, 10);
  } catch (_e) { return false; }
}

async function verificarStockMostrador(caja_id) {
  if (alertaStockDismissedHoy(caja_id)) return;
  try {
    const data = await apiGet(`/api/pos/stock-alerta?caja_id=${caja_id}`);
    if (data.sin_stock?.length > 0) {
      mostrarAlertaStockVacio(data.sin_stock, data.deposito, caja_id);
    }
  } catch (_e) {
    // no bloquear el flujo si falla
  }
}

let _cajaIdAlertaStockActual = null;

function mostrarAlertaStockVacio(productos, deposito, caja_id) {
  const overlay = document.getElementById('modal-stock-alerta-overlay');
  if (!overlay) return;

  _cajaIdAlertaStockActual = caja_id;
  const chk = document.getElementById('stock-alerta-no-mostrar-hoy');
  if (chk) chk.checked = false;

  const lista = document.getElementById('stock-alerta-lista');
  const dep   = document.getElementById('stock-alerta-deposito');

  dep.textContent = deposito ? `Depósito: ${deposito}` : '';

  const muestra  = productos.slice(0, 10);
  const resto    = productos.length - muestra.length;
  lista.innerHTML = muestra.map(p =>
    `<li>${escapeHtml(p.nombre)}${p.codigo ? ` <span style="color:var(--color-text-light)">[${escapeHtml(p.codigo)}]</span>` : ''}</li>`
  ).join('') + (resto > 0 ? `<li style="color:var(--color-text-light)">…y ${resto} más</li>` : '');

  overlay.style.display = '';
}

window.cerrarAlertaStock = function () {
  const chk = document.getElementById('stock-alerta-no-mostrar-hoy');
  if (chk?.checked && _cajaIdAlertaStockActual) {
    try {
      localStorage.setItem(claveDismissStock(_cajaIdAlertaStockActual), new Date().toISOString().slice(0, 10));
    } catch (_e) { /* localStorage no disponible: no bloquear el cierre del modal */ }
  }
  document.getElementById('modal-stock-alerta-overlay').style.display = 'none';
};

// ── Modal "¿Querés facturar esta venta?" post-cobro ──────────────────────
// Se invoca desde mostrarTicket() en el cierre del modal de cobro.
// Solo si el usuario es dueño/admin Y la empresa tiene AFIP configurado.
function mostrarModalFacturarOpcional(ventaId) {
  const overlay = document.getElementById('modal-facturar-opcional-overlay');
  if (!overlay) return;
  document.getElementById('fo-venta-numero').textContent = ultimaVenta?.numero || ventaId;
  document.getElementById('fo-error').style.display = 'none';
  document.getElementById('btn-fo-facturar').disabled = false;
  document.getElementById('btn-fo-facturar').textContent = 'Sí, facturar ahora';
  overlay.style.display = '';
}

window.cerrarModalFacturarOpcional = function () {
  document.getElementById('modal-facturar-opcional-overlay').style.display = 'none';
  // El modal de ticket queda como único activo detrás: foco a "Nueva
  // venta" para poder encadenar otra venta con un segundo Enter.
  setTimeout(() => document.getElementById('btn-ticket-nueva-venta')?.focus(), 60);
};

window.facturarDesdeModal = async function () {
  if (!ultimaVenta?.venta_id) return;
  const btn   = document.getElementById('btn-fo-facturar');
  const errEl = document.getElementById('fo-error');
  errEl.style.display = 'none';

  // Plan offline, Etapa 5: mismo criterio que window.facturarVenta — sin
  // conexión, se encola directo en vez de intentar el fetch.
  if (!navigator.onLine) {
    cerrarModalFacturarOpcional();
    const estadoEl = document.getElementById('pos-ticket-factura-estado');
    if (estadoEl) return _encolarFacturacionOffline(document.getElementById('btn-facturar-venta'), estadoEl);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Facturando...';

  try {
    const resp = await apiPost('/api/pos/facturar', { venta_pos_id: ultimaVenta.venta_id });
    cerrarModalFacturarOpcional();
    // Mostrar resultado en el ticket que ya está abierto
    const estadoEl = document.getElementById('pos-ticket-factura-estado');
    if (estadoEl) {
      estadoEl.className = 'pos-ticket-factura-estado ok';
      estadoEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Factura ${resp.factura?.tipo || ''} N° ${resp.factura?.numero || ''} emitida`;
      estadoEl.style.display = '';
    }
    const btnFact = document.getElementById('btn-facturar-venta');
    if (btnFact) { btnFact.textContent = 'Facturada'; btnFact.disabled = true; }
    window.toast('Factura emitida', 'exito');

    // PDF del comprobante
    if (resp.factura?.id) {
      try {
        const pdfResp = await apiGet(`/api/facturas?id=${resp.factura.id}&accion=pdf`);
        if (pdfResp?.url) {
          pdfUrlActual = pdfResp.url;
          const btnPdf = document.getElementById('btn-ver-comprobante');
          if (btnPdf) btnPdf.style.display = '';
        }
      } catch (_e) {}
    }
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo emitir la factura';
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = 'Reintentar';
  }
};

// ══════════════════════════════════════════════════════════════════════════
// FASE 4 — DEVOLUCIONES PARCIALES
// ══════════════════════════════════════════════════════════════════════════

let _devVentaSel = null; // { id, numero, items: [{id, producto_id, nombre, cantidad, precio_unitario, descuento_pct, subtotal}] }

