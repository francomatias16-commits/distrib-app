// frontend/admin/js/pos/offline-hooks.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Ticket offline + hooks de inicialización de PosOffline.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

function mostrarTicketOffline(venta) {
  const overlay = document.getElementById('modal-ticket-overlay');
  if (!overlay) return;

  document.getElementById('pos-ticket-numero').textContent = `N° ${venta.numero} (pendiente de sincronización)`;

  const fmt2 = (n) => fmt(n || 0);
  const itemsHtml = (venta.items || []).map(i => {
    const sub = (i.precio || 0) * (i.cantidad || 1);
    return `<div class="pos-ticket-item">
      <span>${escapeHtml(i.nombre)}</span>
      <span>${i.cantidad} × ${fmt2(i.precio)} = ${fmt2(sub)}</span>
    </div>`;
  }).join('');

  const pagosHtml = (venta.pagos || []).map(p =>
    `<div class="pos-ticket-item"><span>${p.medio}</span><span>${fmt2(p.monto)}</span></div>`
  ).join('');

  const detalle = document.getElementById('pos-ticket-detalle');
  detalle.innerHTML = `
    <div class="pos-ticket-offline-aviso" style="background:var(--color-warning-bg,#FBE8C9);border:1px solid var(--color-warning-mid,#E0A53E);border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:13px;color:var(--color-warning,#8A5F13)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Venta guardada sin internet. Se sincronizará automáticamente cuando se restablezca la conexión.
    </div>
    ${itemsHtml}
    <hr style="margin:8px 0;border:none;border-top:1px solid var(--color-border-soft,#E7E9E4)">
    <div class="pos-ticket-item"><strong>Total</strong><strong>${fmt2(venta.total)}</strong></div>
    ${pagosHtml}
  `;

  // Ocultar botones que requieren conexión
  const btnFacturar = document.getElementById('btn-facturar-venta');
  const btnComprobante = document.getElementById('btn-ver-comprobante');
  if (btnFacturar) btnFacturar.style.display = 'none';
  if (btnComprobante) btnComprobante.style.display = 'none';

  const estadoEl = document.getElementById('pos-ticket-factura-estado');
  if (estadoEl) {
    estadoEl.textContent = 'Esta venta se facturará una vez que se sincronice con el servidor.';
    estadoEl.style.display = '';
  }

  // Encabezado/pie de impresión (mismo criterio que mostrarTicket()).
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

  overlay.style.display = '';
  pitarExito();
}

// Inicializar PosOffline cuando el auth esté listo
window.authReady?.then(async () => {
  if (window.PosOffline) {
    await window.PosOffline.init();

    // Pre-cargar catálogo al abrir la caja para tenerlo disponible offline
    // Se hace después de que el usuario abre turno (usarTurno lo llama)
    const _usarTurnoOrig = window._usarTurnoOrig || null;
  }
}).catch(() => {});

// Hook para cachear productos cuando se carga el catálogo inicial del turno
// Se registra acá para no tocar el init principal de pos.js
(function hookCacheoProductos() {
  const origApiGet = window._posApiGet || null;

  // Interceptar la carga de favoritos/productos para poblar la caché
  const _observarCarrito = () => {
    // Cachear productos cuando se buscan (ya manejado en buscarProductos)
    // Cachear favoritos cuando se cargan
    const grilla = document.getElementById('pos-grilla-favoritos');
    if (!grilla || !window.PosOffline) return;

    const obs = new MutationObserver(() => {
      const cards = grilla.querySelectorAll('[data-producto]');
      if (!cards.length) return;
      const productos = Array.from(cards).map(c => {
        try { return JSON.parse(c.dataset.producto); } catch { return null; }
      }).filter(Boolean);
      if (productos.length > 0) {
        window.PosOffline.cachearProductos(productos).catch(() => {});
      }
    });
    obs.observe(grilla, { childList: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _observarCarrito);
  } else {
    _observarCarrito();
  }
})();

