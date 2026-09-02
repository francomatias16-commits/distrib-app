// frontend/admin/js/pos/carrito.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Carrito de la venta actual.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// ── Carrito ───────────────────────────────────────────────────────────────
function agregarAlCarrito(producto) {
  if (producto.stock_disponible === null || producto.stock_disponible === undefined) {
    pitarError();
    window.toast('No se pudo verificar el stock de este producto en esta caja. Probá de nuevo.', 'error');
    return;
  }
  if (producto.stock_disponible <= 0) {
    pitarError();
    window.toast('Ese producto no tiene stock en el depósito de esta caja', 'error');
    return;
  }

  // ── Producto por peso (balanza) ─────────────────────────────────────────
  // Cada escaneo de balanza es una línea nueva (peso distinto cada vez)
  if (producto.es_balanza && producto.cantidad_sugerida) {
    carrito.push({
      producto_id:      producto.id,
      nombre:           producto.nombre,
      codigo:           producto.codigo,
      cantidad:         producto.cantidad_sugerida,
      precio:           producto.precio,
      iva:              producto.iva ?? 21,
      descuento_pct:    0,
      stock_disponible: producto.stock_disponible,
      vendido_por_peso: true,
      promocion:        producto.promocion || null,
      promocion_id:     producto.promocion?.id || null,
      promocion_descripcion: producto.promocion ? _descPromo(producto.promocion) : null,
    });
    // Aplicar descuento automático de promo tipo descuento si corresponde
    const ultimo = carrito[carrito.length - 1];
    if (producto.promocion?.tipo === 'descuento_producto' || producto.promocion?.tipo === 'descuento_categoria') {
      ultimo.descuento_pct = producto.promocion.descuento_pct || 0;
    }
    pitarExito();
    ultimoAgregadoId = producto.id + '_' + Date.now(); // ID único para animar
    renderCarrito();
    inputProducto.value = '';
    renderResultados([]);
    inputProducto.focus();
    return;
  }

  // ── Producto normal ─────────────────────────────────────────────────────
  const existente = carrito.find(i => i.producto_id === producto.id && !i.vendido_por_peso);
  if (existente) {
    existente.cantidad += 1;
  } else {
    const item = {
      producto_id:      producto.id,
      nombre:           producto.nombre,
      codigo:           producto.codigo,
      cantidad:         1,
      precio:           producto.precio,
      iva:              producto.iva ?? 21,
      descuento_pct:    0,
      stock_disponible: producto.stock_disponible,
      vendido_por_peso: false,
      promocion:        producto.promocion || null,
      promocion_id:     producto.promocion?.id || null,
      promocion_descripcion: producto.promocion ? _descPromo(producto.promocion) : null,
    };
    // Aplicar descuento automático de promo tipo descuento
    if (producto.promocion?.tipo === 'descuento_producto' || producto.promocion?.tipo === 'descuento_categoria') {
      item.descuento_pct = producto.promocion.descuento_pct || 0;
    }
    carrito.push(item);
  }
  pitarExito();
  ultimoAgregadoId = producto.id;
  clearTimeout(ultimoAgregadoTimer);
  ultimoAgregadoTimer = setTimeout(() => { ultimoAgregadoId = null; renderCarrito(); }, 900);
  renderCarrito();
  inputProducto.value = '';
  renderResultados([]);
  inputProducto.focus();
}

// Genera texto descriptivo de la promo para auditoría
function _descPromo(promo) {
  if (!promo) return null;
  if (promo.tipo === 'nxm') return `${promo.n_cantidad}x${promo.m_paga} — ${sanitize(promo.nombre)}`;
  if (promo.tipo === 'descuento_producto' || promo.tipo === 'descuento_categoria') {
    return `Desc. ${promo.descuento_pct}% — ${sanitize(promo.nombre)}`;
  }
  return promo.nombre;
}

window.cambiarCantidad = function (producto_id, valor, idx) {
  const item = idx !== undefined ? carrito[idx] : carrito.find(i => i.producto_id === producto_id);
  if (!item) return;
  const cant = parseFloat(valor);
  if (isNaN(cant) || cant <= 0) { quitarDelCarrito(producto_id, idx); return; }
  item.cantidad = cant;
  renderCarrito();
};

// Fase 2 — ítem 11: descuento por línea
window.cambiarDescuentoLinea = function (producto_id, valor, idx) {
  const item = idx !== undefined ? carrito[idx] : carrito.find(i => i.producto_id === producto_id);
  if (!item) return;
  const pct = parseFloat(valor);
  if (isNaN(pct) || pct < 0) { item.descuento_pct = 0; renderCarrito(); return; }
  if (pct > 100) { item.descuento_pct = 100; renderCarrito(); return; }

  // Si el descuento supera el umbral, pedir PIN de supervisor
  if (pct >= supervisorUmbral) {
    pedirPinSupervisor(`Descuento de ${pct}% en "${sanitize(item.nombre)}" requiere autorización de supervisor.`, () => {
      item.descuento_pct = pct;
      renderCarrito();
    });
    return;
  }

  item.descuento_pct = pct;
  renderCarrito();
};

window.quitarDelCarrito = function (producto_id, idx) {
  if (idx !== undefined) {
    carrito.splice(idx, 1);
  } else {
    carrito = carrito.filter(i => i.producto_id !== producto_id);
  }
  renderCarrito();
};

window.vaciarCarrito = async function () {
  if (!carrito.length) return;
  const ok = await window.confirmar('¿Vaciar todo el carrito?', { tipo: 'danger', labelOk: 'Sí, vaciar' });
  if (ok) { carrito = []; descuentoGlobal = 0; renderCarrito(); }
};

function calcularTotales() {
  let subtotal = 0, iva_total = 0;

  // Agrupar items por producto_id+promo para calcular nxm
  // Construir mapa: producto_id → { promo, totalCantidad, items[] }
  const nxmMap = {};
  for (const i of carrito) {
    if (i.promocion?.tipo === 'nxm') {
      const key = i.producto_id + '_' + i.promocion.id;
      if (!nxmMap[key]) nxmMap[key] = { promo: i.promocion, cantidad: 0 };
      nxmMap[key].cantidad += i.cantidad;
    }
  }

  for (const i of carrito) {
    const subBase = i.precio * i.cantidad * (1 - (i.descuento_pct || 0) / 100);

    // Descuento nxm: por cada n_cantidad unidades, el cliente paga m_paga
    // Ej. 2x1: cada 2 unidades paga 1 → descuento = floor(cant/2) * precio_unitario
    let descNxm = 0;
    if (i.promocion?.tipo === 'nxm') {
      const key = i.producto_id + '_' + i.promocion.id;
      const totalCant = nxmMap[key]?.cantidad || i.cantidad;
      const { n_cantidad, m_paga } = i.promocion;
      // Unidades gratuitas proporcional a esta línea
      const gratisTotal = Math.floor(totalCant / n_cantidad) * (n_cantidad - m_paga);
      // Prorratea proporcionalmente si hay varias líneas del mismo producto
      const proporcion = i.cantidad / totalCant;
      const gratisLinea = gratisTotal * proporcion;
      descNxm = gratisLinea * i.precio * (1 - (i.descuento_pct || 0) / 100);
    }

    const sub = subBase - descNxm;
    subtotal  += sub;
    iva_total += sub * ((i.iva ?? 21) / 100);

    // Guardar descuento nxm calculado para render y envío al backend
    i._descNxm = descNxm;
  }

  const totalSinDescGlobal = subtotal + iva_total;
  const descGlobalMonto = totalSinDescGlobal * (descuentoGlobal / 100);
  // Redondeo a peso entero: hoy no circulan fracciones de peso (el billete/
  // moneda más chico es $10), así que no tiene sentido arrastrar centavos
  // de IVA/descuentos hasta el total. Se redondea una sola vez acá.
  const total = Math.round(totalSinDescGlobal - descGlobalMonto);
  return { subtotal, iva_total, descGlobalMonto, total };
}

function renderCarrito() {
  const cont = document.getElementById('pos-carrito-items');
  const btnVaciar = document.getElementById('btn-vaciar-carrito');
  const btnCobrar = document.getElementById('btn-cobrar');

  if (!carrito.length) {
    cont.innerHTML = '<p class="pos-carrito-vacio">El carrito está vacío.</p>';
    btnVaciar.style.display = 'none';
    btnCobrar.disabled = true;
    descuentoGlobal = 0;
  } else {
    // Calcular totales primero para tener _descNxm actualizado
    calcularTotales();

    cont.innerHTML = carrito.map((i, idx) => {
      const subtotalLinea = i.precio * i.cantidad * (1 - (i.descuento_pct || 0) / 100) - (i._descNxm || 0);

      // Badge de promo
      let badgePromo = '';
      if (i.promocion) {
        let textoPromo = '';
        if (i.promocion.tipo === 'nxm') {
          textoPromo = `${i.promocion.n_cantidad}x${i.promocion.m_paga}`;
        } else if (i.descuento_pct > 0) {
          textoPromo = `−${i.descuento_pct}%`;
        }
        badgePromo = textoPromo ? `<span class="pos-badge-promo" title="${escapeHtml(i.promocion.nombre)}">${textoPromo}</span>` : '';
      }

      // Badge de peso
      const badgePeso = i.vendido_por_peso
        ? `<span class="pos-badge-peso" title="Producto por peso">${i.cantidad.toFixed(3)} kg</span>`
        : '';

      // ID único para items de balanza (para animación)
      const itemKey = i.vendido_por_peso ? `balanza_${idx}` : i.producto_id;

      return `
        <div class="pos-item-fila${itemKey === ultimoAgregadoId ? ' pos-item-recien-agregado' : ''}" data-testid="pos-carrito-fila" data-id="${i.producto_id}">
          <span class="pos-item-num">${idx + 1}</span>
          <span class="pos-item-codigo">${escapeHtml(i.codigo || '—')}</span>
          <div class="pos-item-desc-col">
            <div class="pos-item-nombre">${escapeHtml(i.nombre)} ${badgePeso}${badgePromo}</div>
          </div>
          <div class="pos-item-cant-stepper">
            <button type="button" class="pos-item-cant-btn" tabindex="-1"
                    onclick="cambiarCantidad('${i.producto_id}', ${(i.cantidad - (i.vendido_por_peso ? 0.1 : 1)).toFixed(3)}, ${idx})"
                    aria-label="Restar cantidad">−</button>
            <input type="number" class="pos-item-cant" min="0.001" step="${i.vendido_por_peso ? '0.001' : '1'}" value="${i.cantidad}"
                   onchange="cambiarCantidad('${i.producto_id}', this.value, ${idx})" />
            <button type="button" class="pos-item-cant-btn" tabindex="-1"
                    onclick="cambiarCantidad('${i.producto_id}', ${(i.cantidad + (i.vendido_por_peso ? 0.1 : 1)).toFixed(3)}, ${idx})"
                    aria-label="Sumar cantidad">+</button>
          </div>
          <div class="pos-item-desc-wrap">
            <input type="number" class="pos-item-desc" min="0" max="100" step="1"
                   value="${i.descuento_pct || ''}" placeholder="% desc"
                   onchange="cambiarDescuentoLinea('${i.producto_id}', this.value, ${idx})"
                   title="Descuento %" />
          </div>
          <span class="pos-item-unitario">${fmt(i.precio)}${i.vendido_por_peso ? '/kg' : ''}</span>
          <span class="pos-item-subtotal">${fmt(subtotalLinea)}</span>
          <button class="pos-item-quitar" onclick="quitarDelCarrito('${i.producto_id}', ${idx})" title="Quitar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
    }).join('');
    btnVaciar.style.display = '';
    btnCobrar.disabled = false;
  }

  const { subtotal, iva_total, descGlobalMonto, total } = calcularTotales();
  document.getElementById('pos-tot-subtotal').textContent = fmt(subtotal);
  document.getElementById('pos-tot-iva').textContent = fmt(iva_total);

  // Fila descuento global (solo visible cuando aplica)
  const filaDesc = document.getElementById('pos-tot-descuento-global-fila');
  if (filaDesc) {
    filaDesc.style.display = descuentoGlobal > 0 ? '' : 'none';
    document.getElementById('pos-tot-descuento-global').textContent = `−${fmt(descGlobalMonto)} (${descuentoGlobal}%)`;
  }

  document.getElementById('pos-tot-total').textContent = fmt(total);

  // Input descuento global
  const inpDesc = document.getElementById('pos-input-descuento-global');
  if (inpDesc && parseFloat(inpDesc.value) !== descuentoGlobal) inpDesc.value = descuentoGlobal || '';
}

// Fase 2 — ítem 12: descuento global
window.aplicarDescuentoGlobal = function (valor) {
  const pct = parseFloat(valor);
  if (isNaN(pct) || pct < 0 || pct > 100) { descuentoGlobal = 0; renderCarrito(); return; }
  if (!carrito.length) return;

  if (pct >= supervisorUmbral) {
    pedirPinSupervisor(`Descuento global de ${pct}% requiere autorización de supervisor.`, () => {
      descuentoGlobal = pct;
      renderCarrito();
    });
    return;
  }

  descuentoGlobal = pct;
  renderCarrito();
};

