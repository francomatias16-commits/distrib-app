// frontend/admin/js/pos/hardware-config.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Panel admin: hardware (impresora/terminal) y Config POS (PIN, umbral, log de movimientos).
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// ══════════════════════════════════════════════════════════════════════════
// Fase 5 — Panel Admin → Hardware (impresora térmica + terminal de pago)
// ══════════════════════════════════════════════════════════════════════════

window.toggleHardwareImpresoraFields = function () {
  const modo = document.getElementById('hw-imp-modo').value;
  document.getElementById('hw-imp-network-fields').style.display = modo === 'network' ? '' : 'none';
  document.getElementById('hw-imp-conectar-wrap').style.display  = (modo === 'webusb' || modo === 'bluetooth') ? '' : 'none';
};

window.toggleHardwareTerminalFields = function () {
  const driver = document.getElementById('hw-term-driver').value;
  ['mp_point', 'mp_qr', 'getnet', 'prisma', 'naranja'].forEach(d => {
    const el = document.getElementById(`hw-term-${d}-fields`);
    if (el) el.style.display = d === driver ? '' : 'none';
  });
  const lista = window.PosTerminal?.getTerminalesSoportadas?.() || [];
  const info  = lista.find(t => t.id === driver);
  document.getElementById('hw-term-desc').textContent = info?.descripcion || '';
};

window.cargarConfigHardware = async function () {
  try {
    const cfg = await apiGet('/api/pos/config-hardware');
    const imp  = cfg.impresora || {};
    const term = cfg.terminal  || {};

    document.getElementById('hw-imp-modo').value    = imp.modo || 'browser';
    document.getElementById('hw-imp-ip').value       = imp.red_ip || '';
    document.getElementById('hw-imp-puerto').value   = imp.red_puerto || 9100;
    document.getElementById('hw-imp-papel').value    = String(imp.papel_mm || 80);
    document.getElementById('hw-imp-corte').checked  = imp.corte !== false;
    document.getElementById('hw-imp-beep').checked   = !!imp.beep;

    document.getElementById('hw-term-driver').value        = term.driver || 'manual';
    document.getElementById('hw-term-mp-device').value     = term.mp_device_id || '';
    document.getElementById('hw-term-getnet-pos').value     = term.getnet_pos_id || '';
    document.getElementById('hw-term-prisma-terminal').value = term.prisma_terminal_id || '';
    document.getElementById('hw-term-naranja-token').value  = term.naranja_token || '';

    toggleHardwareImpresoraFields();
    toggleHardwareTerminalFields();
    cargarEstadoCuentaPrisma();
  } catch (e) {
    console.error(e);
    window.toast('No se pudo cargar la configuración de hardware', 'error');
  }
};

// Estado de la cuenta Prisma conectada (CUIT/CUIL), sin exponer el token —
// mismo criterio que _svc=config de Mercado Pago (obtenerConfigMP).
window.cargarEstadoCuentaPrisma = async function () {
  const statusEl = document.getElementById('hw-term-prisma-status');
  if (!statusEl) return;
  try {
    const cfg = await apiGet('/api/pagos?_svc=prisma-config');
    if (cfg.conectado) {
      statusEl.textContent = `✓ Cuenta conectada (CUIT/CUIL ${cfg.cuit_cuil})`;
      statusEl.style.color = 'var(--nav-ventas, #487050)';
      document.getElementById('hw-term-prisma-cuit').value = cfg.cuit_cuil || '';
    } else {
      statusEl.textContent = 'Sin cuenta conectada todavía.';
      statusEl.style.color = '';
    }
  } catch (e) {
    console.error(e);
    statusEl.textContent = '';
  }
};

// Conecta (o reconecta) la cuenta Prisma: valida cuit_cuil + token contra el
// sandbox y los guarda cifrados en el backend. El token de Prisma expira
// (~1h en sandbox) — hasta que tengamos el endpoint de autenticación real
// (client_credentials u otro) para refrescarlo solo, esto se repega a mano
// cuando venza. Ver CHANGELOG de esta versión.
window.conectarPrismaHardware = async function () {
  const cuit  = document.getElementById('hw-term-prisma-cuit').value.trim();
  const token = document.getElementById('hw-term-prisma-token').value.trim();
  if (!cuit || !token) {
    window.toast('Completá CUIT/CUIL y token para conectar la cuenta Prisma', 'error');
    return;
  }
  try {
    const r = await apiPut('/api/pagos?_svc=prisma-config', { cuit_cuil: cuit, bearer_token: token });
    window.toast(r.mensaje || 'Cuenta Prisma conectada.', 'exito');
    document.getElementById('hw-term-prisma-token').value = '';
    cargarEstadoCuentaPrisma();
  } catch (e) {
    window.toast(e.message || 'No se pudo conectar la cuenta Prisma', 'error');
  }
};

window.conectarImpresoraHardware = async function () {
  // Aplica el modo elegido en el select aunque todavía no se haya guardado,
  // para poder emparejar el dispositivo antes de confirmar.
  window.PosPrinter?.setConfig({ modo: document.getElementById('hw-imp-modo').value });
  try {
    await window.PosPrinter.conectarDispositivo();
  } catch (e) {
    console.error(e);
    window.toast('No se pudo conectar la impresora', 'error');
  }
};

window.probarImpresionHardware = async function () {
  window.PosPrinter?.setConfig({
    modo:       document.getElementById('hw-imp-modo').value,
    red_ip:     document.getElementById('hw-imp-ip').value.trim(),
    red_puerto: parseInt(document.getElementById('hw-imp-puerto').value, 10) || 9100,
    papel_mm:   parseInt(document.getElementById('hw-imp-papel').value, 10) || 80,
    corte:      document.getElementById('hw-imp-corte').checked,
    beep:       document.getElementById('hw-imp-beep').checked,
  });
  try {
    await window.PosPrinter.testImpresion(empresaData || {});
  } catch (e) {
    console.error(e);
    window.toast('Error en la prueba de impresión', 'error');
  }
};

window.guardarConfigHardware = async function () {
  const errEl = document.getElementById('hw-error');
  errEl.style.display = 'none';

  const impresora = {
    modo:       document.getElementById('hw-imp-modo').value,
    red_ip:     document.getElementById('hw-imp-ip').value.trim(),
    red_puerto: parseInt(document.getElementById('hw-imp-puerto').value, 10) || 9100,
    papel_mm:   parseInt(document.getElementById('hw-imp-papel').value, 10) || 80,
    corte:      document.getElementById('hw-imp-corte').checked,
    beep:       document.getElementById('hw-imp-beep').checked,
    // bt_deviceId / bt_nombre quedan guardados si ya se emparejó un dispositivo BT
    bt_deviceId: window.PosPrinter?.getConfig()?.bt_deviceId || null,
    bt_nombre:   window.PosPrinter?.getConfig()?.bt_nombre   || '',
  };

  const driver = document.getElementById('hw-term-driver').value;
  if (driver === 'mp_point' && !document.getElementById('hw-term-mp-device').value.trim()) {
    errEl.textContent = 'Para MP Point necesitás el device ID de la terminal.';
    errEl.style.display = '';
    return;
  }
  if (driver === 'prisma' && !document.getElementById('hw-term-prisma-terminal').value.trim()) {
    errEl.textContent = 'Para Prisma necesitás el ID de terminal de esta caja.';
    errEl.style.display = '';
    return;
  }

  const terminal = {
    driver,
    mp_device_id:       document.getElementById('hw-term-mp-device').value.trim(),
    getnet_pos_id:      document.getElementById('hw-term-getnet-pos').value.trim(),
    prisma_terminal_id: document.getElementById('hw-term-prisma-terminal').value.trim(),
    naranja_token:      document.getElementById('hw-term-naranja-token').value.trim(),
  };

  const btn = document.getElementById('btn-guardar-hardware');
  btn.disabled = true;
  try {
    await apiPost('/api/pos/config-hardware', { impresora, terminal });
    window.PosPrinter?.init(impresora);
    window.PosTerminal?.init(terminal);
    window.toast('Configuración de hardware guardada. Se aplica a todas las cajas de la empresa.', 'exito');
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo guardar la configuración';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
};

// v978: la config de etiquetas de precio/código de barras (config_etiquetas)
// se movió de acá a su propia pantalla — Menú → Configuración → Etiquetas
// de precio (frontend/admin/etiquetas-config.html) — porque es config de
// catálogo/empresa, no hardware físico de esta caja. Ver
// PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md y CHANGELOG_v978.

// ══════════════════════════════════════════════════════════════════════════
// ── Pestaña Config POS (PIN supervisor, umbral por cajero, log de caja) ────
// Audit v197: el HTML de este panel existía hace tiempo pero nunca se
// conectó — la pestaña no estaba en el switcher, y las funciones de PIN,
// umbral y log de movimientos no existían en este archivo.
// ══════════════════════════════════════════════════════════════════════════

let umbralesCache      = [];
let movimientosCache   = [];

function iniciarPanelConfigPos() {
  document.getElementById('cfg-supervisor-pin').value = '';
  document.getElementById('cfg-pin-status').textContent = '';
  cargarUmbralesCajero();
}

// ── PIN de supervisor ────────────────────────────────────────────────────
window.guardarSupervisorPin = async function () {
  const input  = document.getElementById('cfg-supervisor-pin');
  const status = document.getElementById('cfg-pin-status');
  const pin = input.value.trim();

  if (!/^\d{4,8}$/.test(pin)) {
    status.textContent = 'El PIN debe tener entre 4 y 8 dígitos numéricos';
    status.style.color = 'var(--color-danger, #7A2820)';
    return;
  }

  try {
    await apiPost('/api/pos/config-pin', { pin });
    status.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>PIN guardado';
    status.style.color = 'var(--color-success, #487050)';
    input.value = '';
    window.toast('PIN de supervisor guardado', 'exito');
  } catch (e) {
    status.textContent = e.message || 'No se pudo guardar el PIN';
    status.style.color = 'var(--color-danger, #7A2820)';
  }
};

window.borrarSupervisorPin = async function () {
  const status = document.getElementById('cfg-pin-status');
  const ok = await window.confirmar('¿Borrar el PIN de supervisor? Se deshabilita la función hasta configurar uno nuevo.', { tipo: 'danger', labelOk: 'Sí, borrar' });
  if (!ok) return;

  try {
    await apiPost('/api/pos/config-pin', { pin: null });
    document.getElementById('cfg-supervisor-pin').value = '';
    status.textContent = 'PIN eliminado — función deshabilitada';
    status.style.color = 'var(--color-text-muted)';
    window.toast('PIN de supervisor eliminado', 'exito');
  } catch (e) {
    status.textContent = e.message || 'No se pudo borrar el PIN';
    status.style.color = 'var(--color-danger, #7A2820)';
  }
};

// ── Umbral de descuento por cajero ───────────────────────────────────────
async function cargarUmbralesCajero() {
  const cont = document.getElementById('cfg-umbral-lista');
  cont.innerHTML = '<p class="pos-resultados-vacio">Cargando…</p>';
  try {
    const { usuarios } = await apiGet('/api/pos/umbral-cajero');
    umbralesCache = usuarios || [];
    renderUmbralesCajero();
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar los umbrales')}</p>`;
  }
}

function renderUmbralesCajero() {
  const cont = document.getElementById('cfg-umbral-lista');
  if (!umbralesCache.length) {
    cont.innerHTML = '<p class="pos-resultados-vacio">No hay cajeros/vendedores activos.</p>';
    return;
  }
  cont.innerHTML = umbralesCache.map(u => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--color-border);">
      <span style="flex:1;font-size:13px;">${escapeHtml(u.nombre || '—')} <span style="color:var(--color-text-muted);font-size:11px;">(${escapeHtml(u.rol || '')})</span></span>
      <input type="number" min="0" max="100" step="1" value="${u.supervisor_umbral_descuento_pct ?? ''}"
        placeholder="15 (default)" style="width:110px;padding:4px 8px;border:1px solid var(--color-border);border-radius:6px;font-size:13px;"
        id="umbral-input-${u.id}" aria-label="Umbral de ${escapeHtml(u.nombre || '')}" />
      <button type="button" class="btn-secundario" style="font-size:12px;padding:4px 10px;" onclick="guardarUmbralCajero('${u.id}')">Guardar</button>
    </div>
  `).join('');
}

window.guardarUmbralCajero = async function (usuarioId) {
  const input  = document.getElementById(`umbral-input-${usuarioId}`);
  const status = document.getElementById('cfg-umbral-status');
  const raw = input.value.trim();
  const umbral_pct = raw === '' ? null : Number(raw);

  if (umbral_pct !== null && (!Number.isFinite(umbral_pct) || umbral_pct < 0 || umbral_pct > 100)) {
    status.textContent = 'El umbral debe ser un número entre 0 y 100';
    status.style.color = 'var(--color-danger, #7A2820)';
    return;
  }

  try {
    await apiPost('/api/pos/umbral-cajero', { usuario_id: usuarioId, umbral_pct });
    status.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Umbral guardado';
    status.style.color = 'var(--color-success, #487050)';
    window.toast('Umbral actualizado', 'exito');
  } catch (e) {
    status.textContent = e.message || 'No se pudo guardar el umbral';
    status.style.color = 'var(--color-danger, #7A2820)';
  }
};

// ── Log de movimientos de caja ───────────────────────────────────────────
window.cargarMovimientosCajaLog = async function () {
  const cont = document.getElementById('cfg-movimientos-lista');
  const btnExportar = document.getElementById('btn-exportar-mov');
  const desde = document.getElementById('cfg-mov-desde').value;
  const hasta = document.getElementById('cfg-mov-hasta').value;

  cont.innerHTML = '<p class="pos-resultados-vacio">Cargando…</p>';
  btnExportar.style.display = 'none';

  try {
    const params = new URLSearchParams();
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
    const { movimientos } = await apiGet(`/api/pos/movimientos-caja-log${params.toString() ? '?' + params.toString() : ''}`);
    movimientosCache = movimientos || [];
    renderMovimientosCajaLog();
    if (movimientosCache.length) btnExportar.style.display = '';
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar el log')}</p>`;
  }
};

const LABEL_MOV_CAJA = { ingreso: 'Refuerzo', egreso: 'Sangría', retiro: 'Retiro' };

function renderMovimientosCajaLog() {
  const cont = document.getElementById('cfg-movimientos-lista');
  if (!movimientosCache.length) {
    cont.innerHTML = '<p class="pos-resultados-vacio">Sin movimientos en el rango seleccionado.</p>';
    return;
  }
  cont.innerHTML = movimientosCache.map(m => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--color-border);font-size:12px;">
      <span style="color:var(--color-text-muted);white-space:nowrap;">${window.formatHora ? window.formatHora(m.created_at) : new Date(m.created_at).toLocaleString('es-AR')}</span>
      <span style="min-width:70px;">${escapeHtml(LABEL_MOV_CAJA[m.tipo] || m.tipo)}</span>
      <span style="flex:1;">${escapeHtml(m.concepto || '—')}</span>
      <span style="color:var(--color-text-muted);">${escapeHtml(m.turnos_caja?.cajas_pos?.nombre || '')} · ${escapeHtml(m.usuarios?.nombre || '')}</span>
      <span style="font-weight:600;min-width:90px;text-align:right;">${fmt(m.monto)}</span>
    </div>
  `).join('');
}

window.exportarMovimientosExcel = function () {
  if (!movimientosCache.length) return;
  const fecha = new Date().toISOString().slice(0, 10);

  if (typeof XLSX !== 'undefined') {
    const rows = [['Fecha', 'Tipo', 'Concepto', 'Caja', 'Usuario', 'Monto']];
    movimientosCache.forEach(m => {
      rows.push([
        new Date(m.created_at).toLocaleString('es-AR'),
        LABEL_MOV_CAJA[m.tipo] || m.tipo,
        m.concepto || '',
        m.turnos_caja?.cajas_pos?.nombre || '',
        m.usuarios?.nombre || '',
        Number(m.monto || 0),
      ]);
    });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [22, 12, 35, 18, 20, 14].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, 'Movimientos de caja');
    XLSX.writeFile(wb, `movimientos-caja-${fecha}.xlsx`);
    window.toast(`${movimientosCache.length} movimientos exportados`);
  } else {
    let csv = 'Fecha,Tipo,Concepto,Caja,Usuario,Monto\n';
    movimientosCache.forEach(m => {
      csv += [
        new Date(m.created_at).toLocaleString('es-AR'),
        LABEL_MOV_CAJA[m.tipo] || m.tipo,
        m.concepto || '',
        m.turnos_caja?.cajas_pos?.nombre || '',
        m.usuarios?.nombre || '',
        m.monto || 0,
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `movimientos-caja-${fecha}.csv`;
    a.click();
    window.toast(`${movimientosCache.length} movimientos exportados (CSV)`);
  }
};
