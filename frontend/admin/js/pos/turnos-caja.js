// frontend/admin/js/pos/turnos-caja.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Cajas/turnos: abrir, cerrar, movimientos de caja.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// ── Cajas / turnos ───────────────────────────────────────────────────────
async function cargarCajas() {
  cajas = await apiGet('/api/pos/cajas');
  const select = document.getElementById('pos-select-caja');
  select.innerHTML = cajas.length
    ? cajas.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('')
    : '<option value="">No hay cajas configuradas</option>';
}

async function revisarTurnosAbiertos() {
  const { turnos } = await apiGet('/api/pos/caja-estado');

  if (turnos && turnos.length) {
    const wrap = document.getElementById('pos-turnos-abiertos');
    const lista = document.getElementById('pos-turnos-abiertos-lista');
    wrap.style.display = '';
    lista.innerHTML = turnos.map(t => `
      <div class="pos-turno-item" onclick="usarTurno('${t.id}')">
        <div class="pos-turno-item-info">
          <span class="pos-turno-item-caja">${escapeHtml(t.cajas_pos?.nombre || 'Caja')}</span>
          <span class="pos-turno-item-meta">Abierto desde ${window.formatHora ? window.formatHora(t.abierto_at) : ''}</span>
        </div>
        <span>Continuar →</span>
      </div>
    `).join('');

    if (turnos.length === 1) {
      await usarTurno(turnos[0].id, turnos);
      return;
    }
    window.__turnosAbiertos = turnos;
  }

  mostrarPantallaTurno();
}

async function usarTurno(turnoId, turnosConocidos) {
  const turnos = turnosConocidos || window.__turnosAbiertos || [];
  const t = turnos.find(x => x.id === turnoId);
  if (!t) {
    window.toast('No se encontró el turno seleccionado', 'error');
    return mostrarPantallaTurno();
  }
  turnoActual = { id: t.id, caja_id: t.caja_id, monto_inicial: t.monto_inicial };
  cajaActual  = cajas.find(c => c.id === t.caja_id) || { id: t.caja_id, deposito_id: t.cajas_pos?.deposito_id, nombre: t.cajas_pos?.nombre };
  mostrarPantallaVenta();
  await cargarFavoritos();
  // AUDITORÍA 584 — recién acá se sabe con qué caja física va a operar este
  // cajero; hasta ahora PosPrinter/PosTerminal seguían en sus defaults
  // ('browser'/'manual') porque config-hardware ya no se puede resolver sin
  // caja_id. No se espera esta promesa (no debe trabar la pantalla de venta).
  window.aplicarHardwareDeCajaActiva?.(t.caja_id);
  // Si había un celular vinculado a esta caja de una visita anterior (antes
  // de recargar o navegar a otra pantalla), reconecta el canal en silencio
  // sin pedir un QR nuevo — ver pos-scanner-remoto.js.
  window.intentarResumirVinculoCelular?.(t.caja_id);
  // ── Fase 3: alerta de stock vacío (una sola vez por sesión) ──────────
  if (!_stockAlertaYaMostrada && cajaActual?.id) {
    _stockAlertaYaMostrada = true;
    verificarStockMostrador(cajaActual.id).catch(() => {});
  }
}

function mostrarPantallaTurno() {
  document.getElementById('pos-pantalla-turno').style.display = '';
  document.getElementById('pos-pantalla-venta').style.display = 'none';
  document.getElementById('pos-turno-chip').style.display = 'none';
}

function mostrarPantallaVenta() {
  document.getElementById('pos-pantalla-turno').style.display = 'none';
  document.getElementById('pos-pantalla-venta').style.display = '';
  const chip = document.getElementById('pos-turno-chip');
  chip.style.display = '';
  chip.textContent = `Caja: ${cajaActual?.nombre || '—'}`;
  document.getElementById('pos-input-producto')?.focus();
  actualizarInfoVenta();
}

// "Datos de la venta" (Paso: réplica visual del mostrador clásico) — solo datos reales
function actualizarInfoVenta() {
  const elFecha = document.getElementById('pos-info-fecha');
  if (elFecha) {
    elFecha.textContent = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  const elCaja = document.getElementById('pos-info-caja');
  if (elCaja) elCaja.textContent = cajaActual?.nombre || '—';
  actualizarInfoComprobante();
}

// El tipo de comprobante depende de la condición IVA real del cliente seleccionado
function actualizarInfoComprobante() {
  const elComp = document.getElementById('pos-info-comprobante');
  if (!elComp) return;
  const condicion = (clienteSel?.condicion_iva || '').toLowerCase();
  elComp.textContent = (condicion && condicion !== 'consumidor_final' && condicion !== 'consumidor final')
    ? 'Factura'
    : 'Ticket';
}

// ── Abrir turno ──────────────────────────────────────────────────────────
function formatearFechaHora(iso) {
  try {
    return new Date(iso).toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

// Renderiza la alerta de "otro usuario dejó esta caja abierta" con acción
// de un clic para quien tenga permisos, en vez de un mensaje de error plano.
function mostrarAlertaTurnoConflicto(errEl, data) {
  const conflicto = data.turno_conflicto;
  if (!conflicto) {
    errEl.className = 'pos-turno-error';
    errEl.textContent = data.error || 'Esta caja ya tiene un turno abierto';
    errEl.style.display = '';
    return;
  }

  const desde = formatearFechaHora(conflicto.abierto_at);
  const accionesHtml = data.puede_forzar_cierre
    ? `<div class="pos-alerta-conflicto-acciones">
         <button type="button" class="btn btn--sm btn--primary" id="btn-forzar-cierre-turno">
           Cerrar ese turno y abrir esta caja
         </button>
       </div>`
    : `<p class="pos-alerta-conflicto-detalle">Pedile a ${conflicto.usuario_nombre} que cierre su turno desde el POS, o avisale a un administrador para destrabarla.</p>`;

  errEl.className = 'pos-alerta-conflicto';
  errEl.innerHTML = `
    <p class="pos-alerta-conflicto-titulo">⚠ Esta caja está abierta desde el ${desde}</p>
    <p class="pos-alerta-conflicto-detalle">La abrió <strong>${conflicto.usuario_nombre}</strong> y nunca la cerró. Hay que cerrar ese turno antes de poder abrir uno nuevo.</p>
    ${accionesHtml}
  `;
  errEl.style.display = '';

  const btnForzar = document.getElementById('btn-forzar-cierre-turno');
  if (btnForzar) {
    btnForzar.addEventListener('click', () => forzarCierreYReintentar(conflicto.id));
  }
}

async function forzarCierreYReintentar(turnoId) {
  const btnForzar = document.getElementById('btn-forzar-cierre-turno');
  if (btnForzar) { btnForzar.disabled = true; btnForzar.textContent = 'Cerrando turno anterior...'; }
  try {
    await apiPost('/api/pos/forzar-cierre-turno', {
      turno_id: turnoId,
      motivo: 'Cierre administrativo desde alerta de caja bloqueada',
    });
    window.toast('Turno anterior cerrado', 'exito');
    await window.abrirTurno();
  } catch (e) {
    console.error(e);
    window.toast('No se pudo cerrar el turno anterior', 'error');
    if (btnForzar) { btnForzar.disabled = false; btnForzar.textContent = 'Cerrar ese turno y abrir esta caja'; }
  }
}

window.abrirTurno = async function () {
  const caja_id = document.getElementById('pos-select-caja').value;
  const monto_inicial = parseFloat(document.getElementById('pos-monto-inicial').value || '0');
  const errEl = document.getElementById('pos-turno-error');
  errEl.style.display = 'none';
  errEl.className = 'pos-turno-error';

  if (!caja_id) {
    errEl.textContent = 'Elegí una caja primero.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('btn-abrir-turno');
  btn.disabled = true;
  try {
    const data = await apiPost('/api/pos/abrir-turno', { caja_id, monto_inicial });
    turnoActual = { id: data.id, caja_id: data.caja_id, monto_inicial: data.monto_inicial };
    cajaActual  = cajas.find(c => c.id === caja_id);
    window.toast('Caja abierta', 'exito');
    mostrarPantallaVenta();
    await cargarFavoritos();
    // AUDITORÍA 584 — ver mismo comentario en usarTurno().
    window.aplicarHardwareDeCajaActiva?.(caja_id);
  } catch (e) {
    if (e.tipo === 'turno_abierto') {
      mostrarAlertaTurnoConflicto(errEl, e);
    } else {
      errEl.textContent = e.message || 'No se pudo abrir la caja';
      errEl.style.display = '';
    }
  } finally {
    btn.disabled = false;
  }
};

// ── Cerrar turno ──────────────────────────────────────────────────────────
window.abrirModalCierreTurno = async function () {
  if (carrito.length) {
    window.toast('Cobrá o vacía el carrito antes de cerrar la caja', 'error');
    return;
  }
  document.getElementById('pos-monto-final').value = '';
  document.getElementById('pos-cierre-error').style.display = 'none';

  const resumenEl = document.getElementById('pos-cierre-resumen');
  resumenEl.innerHTML = '<p class="pos-cierre-resumen-vacio">Cargando resumen...</p>';
  document.getElementById('modal-cierre-overlay').style.display = '';

  try {
    const resumen = await apiGet(`/api/pos/resumen-turno?turno_id=${turnoActual.id}`);
    renderResumenCierre(resumen);
  } catch (e) {
    resumenEl.innerHTML = '<p class="pos-cierre-resumen-vacio">No se pudo cargar el resumen del turno.</p>';
  }
};

function renderResumenCierre(resumen) {
  const resumenEl = document.getElementById('pos-cierre-resumen');
  const porMedio = resumen.por_medio || {};
  const movs = resumen.movimientos_caja || [];
  const medios = Object.keys(porMedio);

  let html = `<div class="pos-cierre-resumen-fila"><span>Monto inicial</span><span>${fmt(resumen.monto_inicial)}</span></div>`;

  medios.forEach(m => {
    html += `<div class="pos-cierre-resumen-fila"><span>${labelMedio(m)}</span><span>${fmt(porMedio[m])}</span></div>`;
  });

  if (movs.length) {
    html += `<div class="pos-cierre-resumen-fila" style="margin-top:6px;font-size:var(--font-size-xs);color:var(--color-text-light);font-weight:600;text-transform:uppercase;letter-spacing:.04em"><span colspan="2">Movimientos de caja</span></div>`;
    movs.forEach(m => {
      const esEgreso = m.tipo === 'sangria' || m.tipo === 'retiro_final';
      html += `<div class="pos-cierre-resumen-fila"><span>${labelMovCaja(m.tipo)}${m.concepto ? ` — ${escapeHtml(m.concepto)}` : ''}</span><span style="color:${esEgreso ? 'var(--color-danger,#7A2820)' : 'var(--nav-ventas,#487050)'}">${esEgreso ? '−' : '+'}${fmt(m.monto)}</span></div>`;
    });
  }

  if (!medios.length && !movs.length) {
    resumenEl.innerHTML = '<p class="pos-cierre-resumen-vacio">Sin ventas ni movimientos registrados en este turno.</p>';
    return;
  }

  html += `<div class="pos-cierre-resumen-fila total"><span>Efectivo esperado en caja</span><span>${fmt(resumen.monto_calculado)}</span></div>`;
  resumenEl.innerHTML = html;
}

window.cerrarModalCierreTurno = function () {
  document.getElementById('modal-cierre-overlay').style.display = 'none';
};

window.confirmarCierreTurno = async function () {
  const errEl = document.getElementById('pos-cierre-error');
  const monto = document.getElementById('pos-monto-final').value;
  if (monto === '' || isNaN(parseFloat(monto))) {
    errEl.textContent = 'Ingresá el monto final declarado.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('btn-confirmar-cierre');
  btn.disabled = true;
  try {
    const data = await apiPost('/api/pos/cerrar-turno', {
      turno_id: turnoActual.id,
      monto_final_declarado: parseFloat(monto),
    });
    const dif = data.diferencia;
    window.toast(
      dif === 0 ? 'Caja cerrada, arqueo correcto' : `Caja cerrada. Diferencia: ${fmt(dif)}`,
      dif === 0 ? 'exito' : 'error'
    );
    cerrarModalCierreTurno();
    // Cierra también el vínculo del celular si había uno — no tiene sentido
    // dejarlo vivo apuntando a una caja sin turno abierto.
    window.desvincularCelular?.();
    turnoActual = null; cajaActual = null;
    await revisarTurnosAbiertos();
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo cerrar la caja';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
};

// ══════════════════════════════════════════════════════════════════════════
// Fase 2 — ítem 10: Movimientos de caja (sangría / retiro / refuerzo)
// ══════════════════════════════════════════════════════════════════════════

function labelMovCaja(tipo) {
  return { sangria: 'Sangría', retiro_final: 'Retiro final', refuerzo: 'Refuerzo' }[tipo] || tipo;
}

window.abrirModalMovimiento = async function () {
  // Reset formulario
  document.getElementById('pos-mov-tipo').value = 'sangria';
  document.getElementById('pos-mov-monto').value = '';
  document.getElementById('pos-mov-concepto').value = '';
  document.getElementById('pos-mov-error').style.display = 'none';
  document.getElementById('modal-movimiento-overlay').style.display = '';

  // Cargar estado de caja
  await _cargarEstadoCaja();
  setTimeout(() => document.getElementById('pos-mov-monto')?.focus(), 80);
};

async function _cargarEstadoCaja() {
  const loading   = document.getElementById('pos-caja-saldo-loading');
  const contenido = document.getElementById('pos-caja-saldo-contenido');
  loading.style.display   = '';
  contenido.style.display = 'none';

  try {
    const data = await apiGet(`/api/pos/reporte-z?turno_id=${turnoActual.id}`);
    const fmt  = v => '$\u00a0' + Math.round(Number(v || 0)).toLocaleString('es-AR');

    document.getElementById('caja-kpi-apertura').textContent = fmt(data.monto_inicial);
    document.getElementById('caja-kpi-efectivo').textContent = fmt(data.efectivo_esperado);
    document.getElementById('caja-kpi-total').textContent    = fmt(data.total_ventas);

    // Historial de movimientos
    const lista = document.getElementById('pos-caja-mov-lista');
    if (!data.movimientos?.length) {
      lista.innerHTML = '<p class="pos-resultados-vacio">Sin movimientos en este turno.</p>';
    } else {
      const iconos = {
        sangria:      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        refuerzo:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        retiro_final: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 8 21 12 17 16"/><line x1="3" y1="12" x2="21" y2="12"/></svg>',
      };
      lista.innerHTML = data.movimientos.map(m => {
        const esPlus = m.tipo === 'refuerzo';
        const hora   = new Date(m.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        return `<div class="pos-caja-mov-item pos-caja-mov--${m.tipo}">
          <span class="pos-caja-mov-icono">${iconos[m.tipo] || ''}</span>
          <span class="pos-caja-mov-desc">
            <strong>${labelMovCaja(m.tipo)}</strong>${m.concepto ? ' · ' + m.concepto : ''}
            <small>${hora}</small>
          </span>
          <span class="pos-caja-mov-monto ${esPlus ? 'pos-caja-mov-monto--plus' : 'pos-caja-mov-monto--minus'}">
            ${esPlus ? '+' : '−'}${fmt(m.monto)}
          </span>
        </div>`;
      }).join('');
    }

    loading.style.display   = 'none';
    contenido.style.display = '';
  } catch {
    loading.innerHTML = '<span style="color:var(--color-text-light);font-size:var(--font-size-sm)">No se pudo cargar el estado de caja.</span>';
  }
}

window.cerrarModalMovimiento = function () {
  document.getElementById('modal-movimiento-overlay').style.display = 'none';
};

window.confirmarMovimiento = async function () {
  const errEl = document.getElementById('pos-mov-error');
  errEl.style.display = 'none';

  const tipo = document.getElementById('pos-mov-tipo').value;
  const monto = parseFloat(document.getElementById('pos-mov-monto').value || '0');
  const concepto = document.getElementById('pos-mov-concepto').value.trim();

  if (!monto || monto <= 0) {
    errEl.textContent = 'Ingresá un monto mayor a cero.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('btn-confirmar-movimiento');
  btn.disabled = true;
  try {
    await apiPost('/api/pos/movimiento-caja', { turno_id: turnoActual.id, tipo, monto, concepto: concepto || null });
    window.toast(`${labelMovCaja(tipo)} registrado`, 'exito');
    // Limpiar campos y refrescar panel
    document.getElementById('pos-mov-monto').value   = '';
    document.getElementById('pos-mov-concepto').value = '';
    await _cargarEstadoCaja();
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo registrar el movimiento';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
};

// ══════════════════════════════════════════════════════════════════════════
// Búsqueda de productos
// ══════════════════════════════════════════════════════════════════════════
const inputProducto = document.getElementById('pos-input-producto');
inputProducto?.addEventListener('input', () => {
  clearTimeout(buscarTimer);
  const q = inputProducto.value.trim();
  if (!q) { renderResultados([]); return; }
  buscarTimer = setTimeout(() => buscarProductos(q), 220);
});
inputProducto?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = inputProducto.value.trim();
    if (q) buscarProductos(q, true);
  }
});

