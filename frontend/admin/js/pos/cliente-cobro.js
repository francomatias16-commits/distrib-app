// frontend/admin/js/pos/cliente-cobro.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Selección de cliente + modal de cobro.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// ── Cliente ───────────────────────────────────────────────────────────────
window.abrirBuscadorCliente = function () {
  const wrap = document.getElementById('pos-buscador-cliente');
  wrap.style.display = wrap.style.display === 'none' ? '' : 'none';
  if (wrap.style.display !== 'none') document.getElementById('pos-input-cliente')?.focus();
};

let clienteBuscarTimer = null;
document.getElementById('pos-input-cliente')?.addEventListener('input', (e) => {
  clearTimeout(clienteBuscarTimer);
  const q = e.target.value.trim();
  const cont = document.getElementById('pos-resultados-cliente');
  if (!q) { cont.innerHTML = ''; return; }
  clienteBuscarTimer = setTimeout(async () => {
    try {
      const resultados = await apiGet(`/api/clientes?busqueda=${encodeURIComponent(q)}&activo=true`);
      cont.innerHTML = (resultados || []).slice(0, 10).map(c => `
        <div class="pos-cliente-resultado" data-id="${c.id}">${escapeHtml(c.razon_social)}</div>
      `).join('') || '<div class="pos-cliente-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      cont.querySelectorAll('.pos-cliente-resultado[data-id]').forEach(el => {
        el.addEventListener('click', () => {
          const c = resultados.find(r => r.id === el.dataset.id);
          if (c) seleccionarCliente(c);
        });
      });
    } catch (e) {
      console.error(e);
    window.toast('Error al buscar clientes', 'error');
    }
  }, 220);
});

function seleccionarCliente(cliente) {
  clienteSel = {
    id: cliente.id,
    razon_social: cliente.razon_social,
    lista_precio_id: cliente.lista_precio_id || null,
    condicion_iva: cliente.condicion_iva || null,
  };
  document.getElementById('pos-cliente-nombre').textContent = cliente.razon_social;
  document.getElementById('btn-quitar-cliente').style.display = '';
  document.getElementById('pos-buscador-cliente').style.display = 'none';
  document.getElementById('pos-input-cliente').value = '';
  document.getElementById('pos-resultados-cliente').innerHTML = '';
  actualizarInfoComprobante();
}

window.quitarCliente = function () {
  clienteSel = null;
  document.getElementById('pos-cliente-nombre').textContent = 'Consumidor final';
  document.getElementById('btn-quitar-cliente').style.display = 'none';
  actualizarInfoComprobante();
};

// ══════════════════════════════════════════════════════════════════════════
// Cobro
// ══════════════════════════════════════════════════════════════════════════
const MEDIOS_PAGO = [
  { value: 'efectivo',         label: 'Efectivo' },
  { value: 'transferencia',    label: 'Transferencia' },
  { value: 'tarjeta',          label: 'Tarjeta' },
  { value: 'qr',               label: 'MP QR' },
  { value: 'cuenta_corriente', label: 'Cuenta corriente' },
];

// Dentro del cobro se usan letras mnemotécnicas para no pisar los atajos
// globales 1-0/F1-F10 del POS.
const ATAJOS_MEDIO_PAGO = {
  e: 'efectivo',
  t: 'transferencia',
  q: 'qr',
  k: 'tarjeta',
  c: 'cuenta_corriente',
};

function modalCobroVisible() {
  const overlay = document.getElementById('modal-cobro-overlay');
  return !!overlay && getComputedStyle(overlay).display !== 'none';
}

function filaPagoActiva() {
  const activa = document.querySelector('#pos-pagos-lista .pos-pago-fila.pos-pago-fila--activa');
  if (activa) return activa;
  const enfocada = document.activeElement?.closest?.('#pos-pagos-lista .pos-pago-fila');
  return enfocada || document.querySelector('#pos-pagos-lista .pos-pago-fila:last-child');
}

function activarFilaPago(fila, enfocar = false) {
  if (!fila) return;
  document.querySelectorAll('#pos-pagos-lista .pos-pago-fila').forEach((otra) => {
    otra.classList.toggle('pos-pago-fila--activa', otra === fila);
    otra.setAttribute('aria-current', otra === fila ? 'true' : 'false');
  });
  if (enfocar) fila.querySelector('.pos-pago-monto')?.focus();
}

function actualizarBotonesMedio(fila) {
  if (!fila) return;
  const medio = fila.querySelector('.pos-pago-medio')?.value;
  fila.querySelectorAll('.pos-pago-metodo').forEach((boton) => {
    const seleccionado = boton.dataset.medio === medio;
    boton.classList.toggle('pos-pago-metodo--activo', seleccionado);
    boton.setAttribute('aria-checked', seleccionado ? 'true' : 'false');
  });
}

function seleccionarMedioPago(medio, fila = filaPagoActiva()) {
  if (!fila || !MEDIOS_PAGO.some((opcion) => opcion.value === medio)) return;
  const select = fila.querySelector('.pos-pago-medio');
  if (select) select.value = medio;
  activarFilaPago(fila);
  actualizarBotonesMedio(fila);
  recalcularPagos();
}

function quitarLineaPago(fila) {
  if (!fila) return;
  const filas = [...document.querySelectorAll('#pos-pagos-lista .pos-pago-fila')];
  if (filas.length === 1) {
    // Nunca dejamos el modal sin línea: el cajero puede vaciarla y elegir
    // otro medio, pero la estructura sigue lista para confirmar.
    const monto = fila.querySelector('.pos-pago-monto');
    if (monto) monto.value = '';
    activarFilaPago(fila, true);
    recalcularPagos();
    return;
  }
  const indice = filas.indexOf(fila);
  const siguiente = filas[indice + 1] || filas[indice - 1];
  fila.remove();
  if (siguiente) activarFilaPago(siguiente, true);
  recalcularPagos();
}

function manejarAtajoModalCobro(e) {
  if (!modalCobroVisible() || e.ctrlKey || e.altKey || e.metaKey) return false;

  if (e.key === 'Escape') {
    e.preventDefault();
    window.cerrarModalCobro?.();
    return true;
  }

  const medio = ATAJOS_MEDIO_PAGO[e.key.toLowerCase()];
  if (medio) {
    e.preventDefault();
    seleccionarMedioPago(medio);
    filaPagoActiva()?.querySelector('.pos-pago-monto')?.focus();
    return true;
  }

  if (e.key.toLowerCase() === 'a') {
    e.preventDefault();
    window.agregarLineaPago?.();
    return true;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    quitarLineaPago(filaPagoActiva());
    return true;
  }

  // Permite moverse entre líneas sin abandonar el modal cuando se divide un
  // cobro en varios medios.
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
      document.querySelectorAll('#pos-pagos-lista .pos-pago-fila').length > 1) {
    e.preventDefault();
    const filas = [...document.querySelectorAll('#pos-pagos-lista .pos-pago-fila')];
    const actual = Math.max(0, filas.indexOf(filaPagoActiva()));
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const destino = filas[(actual + delta + filas.length) % filas.length];
    activarFilaPago(destino, true);
    destino.querySelector('.pos-pago-monto')?.select();
    return true;
  }

  return false;
}

window.abrirModalCobro = function () {
  const { total } = calcularTotales();
  document.getElementById('pos-modal-total-monto').textContent = fmt(total);
  document.getElementById('pos-pagos-lista').innerHTML = '';
  document.getElementById('pos-cobro-error').style.display = 'none';
  document.getElementById('pos-vuelto-wrap').style.display = 'none';
  // QR queda seleccionado como en la operación actual del mostrador; el
  // cajero puede cambiarlo con E/T/Q/K/C sin tocar el mouse.
  agregarLineaPago(total, 'qr');
  document.getElementById('modal-cobro-overlay').style.display = '';
  // Foco al monto de la primera línea
  setTimeout(() => document.querySelector('#pos-pagos-lista .pos-pago-monto')?.select(), 60);
};

window.cerrarModalCobro = function () {
  document.getElementById('modal-cobro-overlay').style.display = 'none';
};

window.agregarLineaPago = function (montoPrecargado, medioPrecargado) {
  const cont = document.getElementById('pos-pagos-lista');
  const id = 'pago_' + Math.random().toString(36).slice(2, 9);
  const medioInicial = medioPrecargado || (cont.children.length ? 'efectivo' : 'qr');
  const div = document.createElement('div');
  div.className = 'pos-pago-fila';
  div.dataset.id = id;
  div.setAttribute('aria-current', 'false');
  div.innerHTML = `
    <div class="pos-pago-fila-top">
      <span class="pos-pago-numero">Pago ${cont.children.length + 1}</span>
      <button type="button" class="pos-item-quitar pos-pago-quitar" title="Quitar esta línea (Supr)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        <span class="sr-only">Quitar línea</span>
      </button>
    </div>
    <div class="pos-pago-metodos" role="radiogroup" aria-label="Medio del pago ${cont.children.length + 1}">
      ${MEDIOS_PAGO.map((m) => `
        <button type="button" class="pos-pago-metodo" data-medio="${m.value}" role="radio" aria-checked="${m.value === medioInicial ? 'true' : 'false'}">
          <kbd>${m.value === 'tarjeta' ? 'K' : m.value[0].toUpperCase()}</kbd>
          <span>${m.label}</span>
        </button>
      `).join('')}
    </div>
    <label class="pos-pago-importe">
      <span>Importe</span>
      <span class="pos-pago-input-wrap">
        <span aria-hidden="true">$</span>
        <input type="number" class="input-base pos-pago-monto" min="0" step="1" data-money
               value="${Number.isFinite(Number(montoPrecargado)) && Number(montoPrecargado) > 0 ? Math.round(montoPrecargado) : ''}" placeholder="0" inputmode="numeric" />
      </span>
    </label>
    <select class="input-base pos-pago-medio pos-pago-medio-fallback" tabindex="-1" aria-hidden="true">
      ${MEDIOS_PAGO.map(m => `<option value="${m.value}" ${m.value === medioInicial ? 'selected' : ''}>${m.label}</option>`).join('')}
    </select>
  `;
  cont.appendChild(div);
  const inpMonto = div.querySelector('.pos-pago-monto');
  inpMonto.addEventListener('input', recalcularPagos);
  inpMonto.addEventListener('focus', () => activarFilaPago(div));
  div.addEventListener('click', () => activarFilaPago(div));
  div.querySelector('.pos-pago-quitar').addEventListener('click', () => quitarLineaPago(div));
  div.querySelectorAll('.pos-pago-metodo').forEach((boton) => {
    boton.addEventListener('click', () => seleccionarMedioPago(boton.dataset.medio, div));
  });
  div.querySelector('.pos-pago-medio').addEventListener('change', () => {
    activarFilaPago(div);
    actualizarBotonesMedio(div);
    recalcularPagos();
  });
  activarFilaPago(div);
  actualizarBotonesMedio(div);
  recalcularPagos();
  if (!Number.isFinite(Number(montoPrecargado)) || Number(montoPrecargado) <= 0) {
    setTimeout(() => inpMonto.focus(), 0);
  }
};

function leerPagos() {
  return [...document.querySelectorAll('#pos-pagos-lista .pos-pago-fila')].map(fila => ({
    medio: fila.querySelector('.pos-pago-medio').value,
    monto: parseFloat(fila.querySelector('.pos-pago-monto').value || '0'),
  })).filter(p => p.monto > 0);
}

// Fase 2 — ítem 9: calculadora de vuelto en grande
function recalcularPagos() {
  const { total } = calcularTotales();
  const pagos = leerPagos();
  const pagado = pagos.reduce((s, p) => s + p.monto, 0);
  // Total y pagos son siempre pesos enteros, así que la diferencia también
  // sale entera — no hace falta tolerancia de redondeo de centavos.
  const diferencia = Math.round(total - pagado);

  document.getElementById('pos-pagado-total').textContent = fmt(pagado);
  const difEl = document.getElementById('pos-pagado-diferencia');
  difEl.textContent = fmt(Math.abs(diferencia));
  difEl.style.color = diferencia <= 0 ? 'var(--nav-ventas, #487050)' : 'var(--color-danger, #7A2820)';

  // Mostrar vuelto grande solo si hay efectivo y el cliente pagó de más
  const hayEfectivo = pagos.some(p => p.medio === 'efectivo');
  const vueltoWrap = document.getElementById('pos-vuelto-wrap');
  if (hayEfectivo && diferencia < 0) {
    const vuelto = Math.abs(diferencia);
    document.getElementById('pos-vuelto-monto').textContent = fmt(vuelto);
    vueltoWrap.style.display = '';
  } else {
    vueltoWrap.style.display = 'none';
  }
}

window.confirmarCobro = async function () {
  const errEl = document.getElementById('pos-cobro-error');
  errEl.style.display = 'none';
  const { total } = calcularTotales();
  const pagos = leerPagos();

  if (!pagos.length) {
    errEl.textContent = 'Agregá al menos un medio de pago.';
    errEl.style.display = '';
    return;
  }
  // Cuenta corriente es crédito, no un pago que deba "cuadrar" contra el
  // total como efectivo/tarjeta. Si es el único medio, se carga el total
  // exacto a la cuenta del cliente sin pedirle al cajero que ajuste centavos.
  const soloCuentaCorriente = pagos.length === 1 && pagos[0].medio === 'cuenta_corriente';
  if (soloCuentaCorriente) {
    pagos[0].monto = total;
  }

  const pagado = pagos.reduce((s, p) => s + p.monto, 0);
  if (!soloCuentaCorriente && pagado < total) {
    errEl.textContent = 'El monto pagado no alcanza el total.';
    errEl.style.display = '';
    return;
  }
  if (pagos.some(p => p.medio === 'cuenta_corriente') && !clienteSel) {
    errEl.textContent = 'Para pagar a cuenta corriente primero elegí un cliente.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('btn-confirmar-cobro');
  const btnTextoOriginal = btn.textContent;
  btn.disabled = true;

  // ── Terminal de pago (Fase 5): autorizar tarjeta/QR antes de registrar ──
  // Si hay más de un pago con tarjeta/QR se autorizan uno por uno, en orden.
  const driverTerminal = window.PosTerminal?.getDriverActivo?.() || 'manual';
  const pagosTerminal   = pagos.filter(p => p.medio === 'tarjeta' || p.medio === 'qr');
  if (pagosTerminal.length) {
    if (driverTerminal !== 'manual' && window.PosOffline && !window.PosOffline.estaOnline()) {
      errEl.textContent = 'Sin conexión: no se puede cobrar con la terminal configurada. Cambiá a "Manual" en Admin → Hardware o esperá a tener internet.';
      errEl.style.display = '';
      btn.disabled = false;
      return;
    }
    try {
      for (const pago of pagosTerminal) {
        btn.textContent = `Esperando terminal (${labelMedio(pago.medio)})...`;
        const resultado = await window.PosTerminal.cobrarConTerminal(pago.monto, pago.medio);
        pago.referencia = resultado.referencia || null;
        pago.codigo     = resultado.codigo || null;
      }
    } catch (e) {
      errEl.textContent = e.message || 'El cobro en la terminal fue rechazado o cancelado.';
      errEl.style.display = '';
      btn.disabled = false;
      btn.textContent = btnTextoOriginal;
      pitarError();
      return;
    }
    btn.textContent = btnTextoOriginal;
  }

  // Función interna que ejecuta el POST — puede llamarse con pin si el backend lo pide
  async function ejecutarVenta(pinSupervisor = null) {
    const body = {
      caja_id: cajaActual.id,
      turno_id: turnoActual.id,
      cliente_id: clienteSel?.id || null,
      descuento_global_pct: descuentoGlobal || 0,
      items: carrito.map(i => {
        // Descuento efectivo: combina manual + nxm, convertido a % para el backend
        const base = i.precio * i.cantidad;
        const descNxm = i._descNxm || 0;
        const descManualMonto = base * (i.descuento_pct || 0) / 100;
        const descTotalMonto  = descManualMonto + descNxm;
        const descEfectivoPct = base > 0 ? Math.min(100, Math.round((descTotalMonto / base) * 10000) / 100) : 0;

        return {
          producto_id:           i.producto_id,
          cantidad:              i.cantidad,
          descuento_pct:         descEfectivoPct,
          promocion_id:          i.promocion_id          || null,
          promocion_descripcion: i.promocion_descripcion || null,
        };
      }),
      // Si el cliente pagó más en efectivo, los pagos suman más que el total.
      // Enviamos los pagos tal cual — el backend usa el total recalculado
      // para el chequeo. El vuelto es solo visual.
      pagos: pagos.map(p => ({
        medio:      p.medio,
        monto:      p.medio === 'efectivo' ? p.monto : Math.min(p.monto, total),
        referencia: p.referencia || null,
      })),
    };
    if (pinSupervisor) body.pin_supervisor = pinSupervisor;

    // ── Modo offline: encolar en IndexedDB si no hay red ─────────────────
    if (window.PosOffline && !window.PosOffline.estaOnline()) {
      // Pagos a cuenta corriente requieren red (registran deuda en DB)
      if (pagos.some(p => p.medio === 'cuenta_corriente')) {
        throw new Error('Los pagos a cuenta corriente requieren conexión a internet.');
      }
      const local_id = await window.PosOffline.encolarVenta(body);
      // Simular respuesta para mostrar ticket offline
      const fakeNumero = `OFFLINE-${local_id}`;
      const { subtotal, iva_total } = calcularTotales();
      ultimaVenta = {
        venta_id:   null,
        numero:     fakeNumero,
        offline:    true,
        local_id,
        items:      [...carrito],
        pagos,
        cliente:    clienteSel,
        descuentoGlobal,
        subtotal,
        iva_total,
        total,
      };
      cerrarModalCobro();
      mostrarTicketOffline(ultimaVenta);
      carrito = [];
      descuentoGlobal = 0;
      clienteSel = null;
      window.quitarCliente();
      renderCarrito();
      return;
    }

    let resp;
    try {
      resp = await fetch('/api/pos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      // Error de red inesperado — intentar encolar si PosOffline disponible
      if (window.PosOffline && pagos.every(p => p.medio !== 'cuenta_corriente')) {
        const local_id = await window.PosOffline.encolarVenta(body);
        const { subtotal, iva_total } = calcularTotales();
        ultimaVenta = {
          venta_id: null, numero: `OFFLINE-${local_id}`, offline: true,
          local_id, items: [...carrito], pagos, cliente: clienteSel,
          descuentoGlobal, subtotal, iva_total, total,
        };
        cerrarModalCobro();
        mostrarTicketOffline(ultimaVenta);
        carrito = []; descuentoGlobal = 0; clienteSel = null;
        window.quitarCliente(); renderCarrito();
        return;
      }
      throw new Error('Error de red. Verificá la conexión.');
    }

    const data = await resp.json().catch(() => ({}));

    // El backend pide PIN de supervisor (descuento supera umbral)
    if (resp.status === 403 && data.requiere_pin) {
      pedirPinSupervisor(
        data.error || 'Se requiere autorización de supervisor.',
        async () => {
          const pinIngresado = document.getElementById('pos-pin-input').value.trim();
          btn.disabled = true;
          try {
            await ejecutarVenta(pinIngresado);
          } catch (e2) {
            errEl.textContent = e2.message || 'No se pudo registrar la venta';
            errEl.style.display = '';
          } finally {
            btn.disabled = false;
          }
        }
      );
      return; // esperar que el usuario ingrese PIN
    }

    if (!resp.ok) throw new Error(data.error || 'No se pudo registrar la venta');

    // Facturación automática (venta a cuenta corriente) — la venta ya está
    // confirmada y el stock descontado; si falló solo la emisión del
    // comprobante, avisamos para que se facture a mano después.
    if (data.factura_automatica && !data.factura_automatica.ok) {
      window.toast(
        `Venta registrada, pero no se pudo facturar automáticamente: ${data.factura_automatica.error}. Facturala manualmente desde el ticket.`,
        'error'
      );
    }

    ultimaVenta = { ...data, items: [...carrito], pagos, cliente: clienteSel, descuentoGlobal };
    cerrarModalCobro();
    mostrarTicket(ultimaVenta);
    carrito = [];
    descuentoGlobal = 0;
    clienteSel = null;
    window.quitarCliente();
    renderCarrito();
  }

  try {
    await ejecutarVenta();
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo registrar la venta';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
};

