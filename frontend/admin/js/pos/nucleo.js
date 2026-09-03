// frontend/admin/js/pos/nucleo.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Estado, feedback sonoro, helpers de API, init de auth.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// frontend/admin/js/pos.js
// Lógica del punto de venta (mostrador).
// Etapas 1-4: base de venta + panel admin (anular / transferir stock)
// Fase 2 (este archivo):
//   7.  Enter en modal cobro confirma si el pago ya cierra
//   8.  F2 abre modal cobro desde cualquier lugar
//   9.  Calculadora de vuelto grande al ingresar efectivo
//  10.  Sangría / retiro / refuerzo de caja (movimientos de caja)
//  11.  Descuento por línea (campo input en cada ítem del carrito)
//  12.  Descuento global a la venta completa
//  13.  Grilla de favoritos / más vendidos
//  14.  PIN de supervisor para descuentos grandes (≥ umbral) o anulaciones

const mostrarToast = (msg, tipo = 'default', duracionMs) => window.mostrarToast(msg, tipo, duracionMs);

// ── Estado ──────────────────────────────────────────────────────────────
let usuario      = null;
let cajas        = [];
let turnoActual  = null;
let cajaActual   = null;
let carrito      = [];          // [{ producto_id, nombre, codigo, cantidad, precio, iva, descuento_pct, stock_disponible }]
let descuentoGlobal = 0;        // % de descuento global sobre el total
let clienteSel   = null;
let buscarTimer  = null;
let ultimaVenta  = null;
let pdfUrlActual = null;       // URL del PDF del comprobante ya emitido para ultimaVenta (item nuevo: "Ver/imprimir comprobante")
let ultimoAgregadoId    = null;
let ultimoAgregadoTimer = null;
let supervisorUmbral    = 15;   // % por defecto; se actualiza al cargar perfil
let favoritosCargados   = false;
let empresaData      = null;   // { nombre, cuit, domicilio, telefono } — para encabezado de ticket
let ultimoReporteZ   = null;   // último reporte Z renderizado, para poder reimprimirlo
// ── Fase 3 ──────────────────────────────────────────────────────────────
let _stockAlertaYaMostrada = false; // evitar doble aviso si usarTurno() se llama varias veces

// ── Feedback sonoro ─────────────────────────────────────────────────────
let _audioCtx = null;
function _beep(frecuencia, duracionMs, volumen = 0.15) {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc  = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.frequency.value = frecuencia;
    osc.type = 'sine';
    gain.gain.value = volumen;
    osc.connect(gain).connect(_audioCtx.destination);
    osc.start();
    osc.stop(_audioCtx.currentTime + duracionMs / 1000);
  } catch (_e) {}
}
const pitarExito = () => _beep(880, 90);
const pitarError = () => { _beep(220, 160); setTimeout(() => _beep(220, 160), 180); };

// ── Helpers de API ───────────────────────────────────────────────────────
function authHeader() {
  const token = window.authCtx?.session?.access_token || '';
  return { Authorization: `Bearer ${token}` };
}

async function apiGet(url) {
  const resp = await fetch(url, { headers: authHeader() });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data?.error || 'Error de red'), { tipo: data?.tipo, status: resp.status });
  return data;
}

async function apiPost(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data?.error || 'Error de red'), data, { status: resp.status });
  return data;
}

async function apiPut(url, body) {
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data?.error || 'Error de red'), data, { status: resp.status });
  return data;
}

const fmt = (n) => window.formatARS ? window.formatARS(n) : `$ ${Math.round(Number(n || 0)).toLocaleString('es-AR')}`;

// ── Init ──────────────────────────────────────────────────────────────────
// FIX (bug funcional real, "Error al iniciar el POS"): antes esto era
// `window.authReady.then(async () => {...})` a secas. Si `authReady` ya
// estaba resuelto para cuando este script corre (camino de caché de
// auth.js: perfil servido desde sessionStorage, sin los await de red que
// tiene el camino sin caché), el callback se agenda como microtask y
// corre apenas termina ESTE <script> — antes de que `turnos-caja.js`
// (3er <script> de la lista, más abajo en pos.html) llegue a cargarse por
// red y defina `cargarCajas`/`revisarTurnosAbiertos`. Resultado: esas dos
// funciones son `undefined`, el `try/catch` de abajo atrapa el
// ReferenceError y muestra el toast de error — intermitente, más probable
// cuanto más rápido resuelva authReady (justo el caso de caché) y más
// lenta sea la red para los scripts siguientes. Reproducible recargando
// pos.html dentro de la ventana de 5 min de caché de sesión con la red
// throttled.
//
// Fix: esperar también a que el parser termine con TODO el HTML inicial
// (DOMContentLoaded), que solo dispara después de que el último <script>
// síncrono del documento —incluido turnos-caja.js— ya ejecutó. Así no
// importa qué tan rápido resuelva authReady.
function _domListo() {
  return document.readyState === 'loading'
    ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve();
}

Promise.all([window.authReady, _domListo()]).then(async () => {
  usuario = window.authCtx.perfil;
  if (window.tieneRol?.('dueno', 'admin')) {
    const grupoAdmin = document.getElementById('pos-quickbar-admin');
    if (grupoAdmin) grupoAdmin.style.display = '';
  }
  // Cargar umbral de supervisor si el perfil lo trae
  if (usuario?.supervisor_umbral_descuento_pct !== undefined) {
    supervisorUmbral = usuario.supervisor_umbral_descuento_pct;
  }
  try {
    await cargarCajas();
    await revisarTurnosAbiertos();
  } catch (e) {
    console.error(e);
    window.toast('Error al iniciar el POS', 'error');
  }
  // ── Hardware: impresora térmica + terminal de pago (Fase 5) ────────────
  // AUDITORÍA 584 — la config de impresora/terminal es por caja, no por
  // empresa, así que ya no se puede pedir acá (todavía no se sabe con qué
  // caja va a operar el cajero). Solo se pide sin caja_id para tener los
  // datos de encabezado de ticket (nombre/cuit/domicilio) disponibles cuanto
  // antes; PosPrinter/PosTerminal arrancan en 'browser'/'manual' hasta que
  // usarTurno()/abrirTurno() (turnos-caja.js) llaman a
  // window.aplicarHardwareDeCajaActiva(caja_id) con la caja real.
  // No bloquea el arranque del POS si falla.
  try {
    const cfg = await apiGet('/api/pos/config-hardware');
    empresaData = cfg.empresa || null;
  } catch (e) {
    console.warn('[POS] No se pudo cargar los datos de la empresa para el ticket:', e.message);
  }
}).catch(() => {});

