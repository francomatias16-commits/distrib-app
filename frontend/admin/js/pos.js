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
window.authReady.then(async () => {
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
  // No bloquea el arranque del POS si falla: degrada a 'browser'/'manual'.
  try {
    const cfg = await apiGet('/api/pos/config-hardware');
    empresaData = cfg.empresa || null;
    window.PosPrinter?.init(cfg.impresora || { modo: 'browser' });
    window.PosTerminal?.init(cfg.terminal  || { driver: 'manual' });
  } catch (e) {
    console.warn('[POS] No se pudo cargar config de hardware, uso defaults:', e.message);
  }
}).catch(() => {});

// ── Atajos de teclado profesionales de POS/caja (Fase 2 — ítem 7 y 8, + set
// ampliado tipo caja registradora real) ─────────────────────────────────
//   F1  / 1       Ayuda — mostrar este listado de atajos en pantalla
//   F2  / 2       Cobrar
//   F3  / 3       Ir al descuento global (solo si hay ítems en el carrito)
//   F4  / 4       Nueva venta (vaciar carrito)
//   F5  / 5       Ir al buscador de productos / código de barras
//   F6  / 6       Elegir cliente
//   F7  / 7       Movimiento de caja (sangría / refuerzo)
//   F8  / 8       Cerrar caja (cierre de turno)
//   F9  / 9       Reporte Z
//   F10 / 0       Escanear con la cámara
//   + / -         Sumar/restar una unidad al último producto del carrito
//   Supr / ⌫      Quitar el último producto agregado al carrito
//   Enter         Agregar producto (buscador) / confirmar (modal de cobro)
//   Esc           Cerrar cualquier modal abierto
//
// Por qué cada acción tiene DOS teclas: en varias notebooks la fila F1-F12
// viene mapeada de fábrica a funciones de hardware (touchpad, brillo,
// volumen, captura de pantalla) y el navegador nunca recibe el evento de
// tecla de función — no hay forma de detectarlo desde JS, porque el evento
// no llega. El dígito 1-0 (mismo número que la F-key, en la fila superior,
// sin Fn) es el respaldo de una sola tecla que sí llega siempre. Los dos
// caminos llaman a la misma función, así que no hay lógica duplicada ni
// riesgo de que un atajo haga algo distinto según cuál tecla se usó.
//
// Se registran en document (no en un input puntual) para que respondan
// sin importar dónde esté el foco — igual que en una caja real, donde el
// cajero no tiene por qué clickear antes de usar el atajo. Los F-keys no
// escriben texto, así que no hace falta excluir los inputs ahí; los
// dígitos 1-0 SÍ se excluyen cuando el foco está en un campo de texto
// (buscador, cantidad, % de descuento, etc.) para no interrumpir lo que
// el cajero esté tipeando — mismo criterio que ya usaban Supr/Backspace
// y +/-.
// Detecta si hay algún modal del POS visible. Usa getComputedStyle en vez de
// comparar el string de overlay.style.display a mano: los modales de este
// archivo se abren con style.display='' (vacío, cae al display:flex del CSS)
// y cierran con 'none' — comparar contra '' como "cerrado" hacía que esta
// función (y el check de cobroYaAbierto de más abajo) nunca detectaran un
// modal realmente abierto, porque ninguno usa otro valor que no sea '' o
// 'none'. getComputedStyle no depende de qué string puso el JS, lee el
// resultado final aplicado (CSS + inline) y por eso es la forma correcta
// de preguntar "¿esto se está mostrando en pantalla ahora mismo?".
function hayModalAbierto() {
  return Array.from(document.querySelectorAll('.pos-modal-overlay'))
    .some(el => getComputedStyle(el).display !== 'none');
}

// Foco actual en un campo donde el dígito 1-0 tiene que escribirse como
// texto en vez de disparar un atajo (buscador, cantidad, descuento, PIN,
// alta rápida de cliente, etc.). Mismo chequeo que ya usaban +/- y
// Supr/Backspace, factorizado acá para reutilizarlo en los atajos F1-F10.
function enCampoDeTexto() {
  const activo = document.activeElement;
  return !!(activo && (activo.tagName === 'INPUT' || activo.tagName === 'TEXTAREA' || activo.isContentEditable));
}

// true si `e` corresponde a la F-key indicada o a su dígito de respaldo
// (mismo número, 1-0, sin Fn) — pero el dígito solo cuenta como atajo si
// el foco no está sobre un campo de texto en ese momento.
function esAtajo(e, teclaF, digito) {
  if (e.key === teclaF) return true;
  return e.key === digito && !enCampoDeTexto();
}

// Intenta abrir el modal de cobro (acción de F2/2 y, si el carrito tiene
// ítems, también del Enter "suelto" — ver más abajo). Devuelve true si lo
// abrió, false si no correspondía (ya hay un modal abierto, el carrito
// está vacío, etc.) — así el que llama sabe si tiene que avisar algo más
// o no.
function intentarAbrirCobro() {
  if (hayModalAbierto()) return false; // no interrumpir otro modal en curso (PIN, movimiento, etc.)
  const overlay = document.getElementById('modal-cobro-overlay');
  const cobroYaAbierto = getComputedStyle(overlay).display !== 'none';
  if (cobroYaAbierto) return false;
  const btnCobrar = document.getElementById('btn-cobrar');
  if (btnCobrar.disabled) {
    mostrarToast('Agregá al menos un producto para cobrar', 'default', 2500);
    return false;
  }
  window.abrirModalCobro();
  return true;
}

document.addEventListener('keydown', (e) => {
  // El modal de cobro tiene su propio mapa de teclas. Se procesa antes de
  // F1-F10 para que las letras no se pierdan y para que Supr quite la línea
  // activa, no el último producto del carrito.
  if (manejarAtajoModalCobro(e)) return;

  // F1 — ayuda: listado de atajos en pantalla. Va primero porque no toca
  // nada del carrito ni de la venta en curso, así que no hace falta
  // encadenar los mismos chequeos de modal que el resto.
  if (esAtajo(e, 'F1', '1')) {
    e.preventDefault();
    window.abrirModalAtajos?.();
    return;
  }

  // F2 / 2 — abrir cobro (ítem 8)
  if (esAtajo(e, 'F2', '2')) {
    e.preventDefault();
    intentarAbrirCobro();
    return;
  }

  // F3 — foco directo en el % de descuento global. El campo solo está
  // visible cuando el carrito tiene ítems (lo muestra/oculta el
  // MutationObserver de pos.html); si está oculto no hay nada que
  // enfocar, así que avisamos en vez de fallar en silencio.
  if (esAtajo(e, 'F3', '3')) {
    e.preventDefault();
    if (hayModalAbierto()) return;
    const inputDesc = document.getElementById('pos-input-descuento-global');
    if (!inputDesc || inputDesc.closest('#pos-descuento-global-wrap')?.offsetParent === null) {
      mostrarToast('Agregá al menos un producto para aplicar un descuento', 'default', 2500);
      return;
    }
    inputDesc.focus();
    inputDesc.select();
    return;
  }

  // F4 — nueva venta (vaciar carrito). vaciarCarrito() ya pide confirmación
  // si hay ítems y no hace nada si el carrito ya está vacío.
  if (esAtajo(e, 'F4', '4')) {
    e.preventDefault();
    if (hayModalAbierto()) return;
    window.vaciarCarrito();
    return;
  }

  // F5 — ir al buscador de productos (mismo destino que tenía el botón
  // "Buscar artículo", sacado por redundante: el input ya está a la vista
  // y con foco automático). preventDefault() acá es clave:
  // sin esto, el navegador refresca la página entera (atajo nativo de F5).
  if (esAtajo(e, 'F5', '5')) {
    e.preventDefault();
    if (hayModalAbierto()) return;
    inputProducto?.focus();
    inputProducto?.select();
    return;
  }

  // F6 — elegir cliente
  if (esAtajo(e, 'F6', '6')) {
    e.preventDefault();
    if (hayModalAbierto()) return;
    window.abrirBuscadorCliente?.();
    return;
  }

  // F7 — movimiento de caja (sangría / refuerzo). Solo si el botón está
  // visible (hay un turno abierto — ver #pos-quickbar-turno).
  if (esAtajo(e, 'F7', '7')) {
    e.preventDefault();
    if (hayModalAbierto()) return;
    const btnMov = document.getElementById('btn-movimiento-caja');
    if (btnMov && btnMov.offsetParent !== null) window.abrirModalMovimiento?.();
    return;
  }

  // F8 — cerrar caja (cierre de turno). abrirModalCierreTurno() ya valida
  // que el carrito esté vacío antes de abrir el modal, así que acá solo
  // hace falta confirmar que el botón esté en pantalla (turno abierto).
  if (esAtajo(e, 'F8', '8')) {
    e.preventDefault();
    if (hayModalAbierto()) return;
    const btnCierre = document.getElementById('btn-abrir-cierre-turno');
    if (btnCierre && btnCierre.offsetParent !== null) window.abrirModalCierreTurno?.();
    return;
  }

  // F9 — reporte Z. Mismo criterio de visibilidad que F7: el botón vive en
  // el grupo #pos-quickbar-turno, que solo se muestra con turno abierto.
  if (esAtajo(e, 'F9', '9')) {
    e.preventDefault();
    if (hayModalAbierto()) return;
    const btnZ = document.getElementById('btn-reporte-z');
    if (btnZ && btnZ.offsetParent !== null) window.abrirModalReporteZ?.();
    return;
  }

  // F10 — escanear con la cámara de esta pantalla (alternativa de teclado
  // al botón "Cámara" junto al buscador).
  if (esAtajo(e, 'F10', '0')) {
    e.preventDefault();
    if (hayModalAbierto()) return;
    const btnCamara = document.getElementById('pos-btn-camara');
    if (btnCamara && btnCamara.offsetParent !== null) window.abrirModalScanner?.();
    return;
  }

  // "+" / "-" (fuera de un campo de texto) — sumar/restar una unidad al
  // último producto agregado al carrito. Mismo criterio que Supr/Backspace
  // de acá abajo: se excluye cuando el foco está en un campo de texto para
  // no interferir con lo que el cajero esté tipeando ahí (ej. un % de
  // descuento). Para productos por peso ajusta de a 0.1 kg, igual que los
  // botones +/- de cada fila del carrito.
  if (e.key === '+' || e.key === '-') {
    if (enCampoDeTexto() || hayModalAbierto() || !carrito.length) return;
    e.preventDefault();
    const idx = carrito.length - 1;
    const item = carrito[idx];
    const paso = item.vendido_por_peso ? 0.1 : 1;
    const nuevaCantidad = e.key === '+' ? item.cantidad + paso : item.cantidad - paso;
    window.cambiarCantidad(item.producto_id, nuevaCantidad.toFixed(3), idx);
    return;
  }

  // Supr / Backspace (fuera de un campo de texto) — quitar el último
  // producto agregado al carrito. Se excluye explícitamente cuando el
  // foco está en un input/textarea/contenteditable: ahí esas teclas
  // tienen que seguir borrando caracteres, no tocar el carrito. Se
  // escuchan las dos variantes porque en teclados Mac la tecla rotulada
  // "delete" reporta e.key === 'Backspace'.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (enCampoDeTexto() || hayModalAbierto() || !carrito.length) return;
    e.preventDefault();
    const idx = carrito.length - 1;
    const nombreQuitado = carrito[idx].nombre;
    quitarDelCarrito(carrito[idx].producto_id, idx);
    mostrarToast(`Se quitó "${nombreQuitado}" del carrito`, 'default', 2200);
    return;
  }

  // Escape → cerrar cualquier modal abierto (todos, no solo un listado fijo
  // — antes se armaba a mano y se desactualizaba cada vez que se sumaba un
  // modal nuevo; ahora barre por clase, así ningún modal futuro se queda
  // afuera).
  if (e.key === 'Escape') {
    document.querySelectorAll('.pos-modal-overlay').forEach(el => {
      if (el.style.display !== 'none') el.style.display = 'none';
    });
    return;
  }

  // Enter dentro del modal de cobro → confirmar si pago cierra (ítem 7).
  // Enter dentro de "¿Emitir factura?" → "Sí, facturar ahora" (a menos que
  // el foco esté en "No, solo ticket"). Enter dentro del modal de ticket
  // (post-venta) → "Nueva venta", su acción primaria. En los tres casos,
  // si el foco ya está sobre un <button>, se deja pasar sin preventDefault
  // para que el Enter dispare el click nativo de *ese* botón puntual (así
  // Tab + Enter para elegir la opción secundaria sigue funcionando).
  // Enter "suelto" (ningún modal abierto, buscador vacío) → mismo destino
  // que F2/2: abrir cobro. Así Enter deja de ser una tecla muerta en la
  // pantalla de venta en reposo — antes solo hacía algo si el foco estaba
  // en el buscador con texto adentro (buscar producto) o dentro del modal
  // de cobro ya abierto; si ninguna de las dos aplicaba, no pasaba nada,
  // aunque el cartel de atajos de abajo la mostrara como "Confirmar".
  if (e.key === 'Enter') {
    const activo = document.activeElement;
    const focoEnBoton = activo?.tagName === 'BUTTON';

    // "¿Emitir factura?" se abre por encima del modal de ticket, así que
    // se chequea primero.
    const overlayFo = document.getElementById('modal-facturar-opcional-overlay');
    if (overlayFo && getComputedStyle(overlayFo).display !== 'none') {
      if (focoEnBoton) return; // dejar que el botón enfocado maneje su propio Enter
      e.preventDefault();
      document.getElementById('btn-fo-facturar')?.click();
      return;
    }

    const overlayCobro = document.getElementById('modal-cobro-overlay');
    if (overlayCobro && getComputedStyle(overlayCobro).display !== 'none') {
      // Solo si el foco no está en un <select> o en el botón cancelar
      const esCancelar = activo?.classList.contains('btn-secundario');
      if (!esCancelar) {
        e.preventDefault();
        _intentarConfirmarCobroPorEnter();
      }
      return;
    }

    const overlayTicket = document.getElementById('modal-ticket-overlay');
    if (overlayTicket && getComputedStyle(overlayTicket).display !== 'none') {
      if (focoEnBoton) return;
      e.preventDefault();
      window.cerrarModalTicket();
      return;
    }

    // Sin modal abierto: si el buscador tiene texto, es un código de barras
    // o nombre en curso — ese Enter lo maneja el listener propio de
    // inputProducto (agregar producto), no corresponde tocar el carrito acá.
    if (inputProducto && inputProducto.value.trim()) return;
    if (hayModalAbierto()) return; // otro modal (PIN, movimiento, etc.) en curso
    e.preventDefault();
    intentarAbrirCobro();
  }
});

// F1 — modal de ayuda con el listado de atajos (ver comentario más arriba
// para la lista completa). Es un modal simple, sin datos del servidor, así
// que no necesita estado propio más allá de mostrar/ocultar el overlay.
window.abrirModalAtajos = function () {
  if (hayModalAbierto()) return;
  const overlay = document.getElementById('modal-atajos-overlay');
  if (overlay) overlay.style.display = '';
};
window.cerrarModalAtajos = function () {
  const overlay = document.getElementById('modal-atajos-overlay');
  if (overlay) overlay.style.display = 'none';
};

// Enter dentro del modal de cobro llama exactamente al mismo camino que el
// botón "Confirmar venta" (mismo wrapper anti-doble-click, mismos mensajes
// de error) — antes tenía una validación propia
// (`Math.abs(pagado - total) < 0.01`) que exigía centavo exacto y no
// contemplaba pago de más (vuelto) ni cuenta corriente, así que un cobro
// con centavos de diferencia el botón sí lo dejaba pasar pero Enter no
// hacía nada, en silencio.
function _intentarConfirmarCobroPorEnter() {
  const btn = document.getElementById('btn-confirmar-cobro');
  if (btn) window.btnAsyncClick(btn, confirmarCobro);
}

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

// ── "Sacar" el cursor del buscador cuando queda ocioso y vacío ─────────────
// El buscador se auto-enfoca (autofocus + refocus tras cada producto
// agregado) para que un lector de código de barras físico pueda escanear
// sin que el cajero tenga que clickear antes — eso hay que mantenerlo, si
// no un escaneo con el foco en otro lado se pierde. El problema es que
// mientras ese foco está puesto, los atajos de dígito (1-0, el respaldo de
// F1-F10 en notebooks donde la fila F no llega al navegador — ver v752)
// quedan bloqueados, porque un dígito ahí tiene que poder escribirse como
// parte de un código, no disparar una acción.
// Solución: si el campo queda vacío (nada escaneado ni tipeado) durante
// más de este tiempo, se le saca el foco solo. Un escaneo real llena el
// campo casi al instante y dispara 'input' en cada tecla, así que
// reinicia el timer constantemente mientras está en curso — nunca llega a
// dispararse en medio de un escaneo. Con el campo vacío y quieto (recién
// terminó de vender, o todavía no arrancó) el cursor sale solo y los
// dígitos quedan libres para actuar como atajo. Si el campo tiene texto
// (el cajero está buscando por nombre y se detuvo a pensar/leer
// resultados) no se toca — solo aplica con el campo vacío.
const _POS_BLUR_BUSCADOR_OCIOSO_MS = 1500;
let _blurBuscadorTimer = null;
function _programarBlurBuscadorSiOcioso() {
  clearTimeout(_blurBuscadorTimer);
  if (inputProducto.value.trim()) return; // hay texto: no se toca el foco
  _blurBuscadorTimer = setTimeout(() => {
    if (document.activeElement === inputProducto && !inputProducto.value.trim()) {
      inputProducto.blur();
    }
  }, _POS_BLUR_BUSCADOR_OCIOSO_MS);
}
inputProducto?.addEventListener('focus', _programarBlurBuscadorSiOcioso);
inputProducto?.addEventListener('input', _programarBlurBuscadorSiOcioso);
inputProducto?.addEventListener('blur', () => clearTimeout(_blurBuscadorTimer));

// Red de seguridad final: si por lo que sea (lector físico levantando el QR
// de la pantalla, pegado manual, etc.) llega acá el propio link de
// "Vincular celular" en vez de un código de producto, se corta antes de
// pegarle a la API — nunca va a existir un producto con ese "código".
const RE_LINK_VINCULAR_CELULAR = /\/scan-pos(?:[/?]|$)/i;

async function buscarProductos(q, porEnter) {
  if (RE_LINK_VINCULAR_CELULAR.test(q)) {
    if (porEnter) {
      inputProducto.value = '';
      renderResultados([]);
      window.mostrarToast?.('Ese es el link de "Vincular celular", no un código de producto.', 'default', 3500);
    }
    return;
  }

  // ── Offline: usar caché local si no hay red ───────────────────────────────
  if (window.PosOffline && !window.PosOffline.estaOnline()) {
    try {
      const resultados = await window.PosOffline.buscarProductosLocal(q);
      if (porEnter && resultados.length === 1) {
        agregarAlCarrito(resultados[0]);
        inputProducto.value = '';
        renderResultados([]);
        return;
      }
      if (porEnter && resultados.length === 0) {
        pitarError();
        window.mostrarToast(`No se encontró "${q}" en el catálogo local`, 'error', 4000);
      } else if (porEnter && resultados.length > 1) {
        window.mostrarToast('Hay varias coincidencias — elegí una de la lista', 'default');
      }
      renderResultados(resultados);
    } catch (e) {
      pitarError();
      window.mostrarToast('Error al buscar en caché local', 'error');
    }
    return;
  }

  // ── Online: búsqueda normal en la API ────────────────────────────────────
  try {
    const params = new URLSearchParams({ q });
    if (cajaActual?.id) params.set('caja_id', cajaActual.id);
    if (clienteSel?.lista_precio_id) params.set('lista_precio_id', clienteSel.lista_precio_id);

    const resultados = await apiGet(`/api/pos/productos?${params.toString()}`);

    // Aprovechar la búsqueda para refrescar el caché local con los resultados
    if (window.PosOffline && resultados.length > 0) {
      window.PosOffline.cachearProductos(resultados).catch(() => {});
    }

    if (porEnter && resultados.length === 1) {
      agregarAlCarrito(resultados[0]);
      inputProducto.value = '';
      renderResultados([]);
      return;
    }
    if (porEnter && resultados.length === 0) {
      pitarError();
      window.mostrarToast(`No se encontró ningún producto con el código "${q}"`, 'error', 4000);
    } else if (porEnter && resultados.length > 1) {
      window.mostrarToast('Hay varias coincidencias — elegí una de la lista', 'default');
    }

    renderResultados(resultados);
  } catch (e) {
    // Si hay error de red, intentar con caché local como fallback
    if (window.PosOffline) {
      try {
        const resultados = await window.PosOffline.buscarProductosLocal(q);
        if (resultados.length > 0) {
          window.mostrarToast('Usando catálogo local (sin conexión)', 'warning', 3000);
          renderResultados(resultados);
          return;
        }
      } catch (_) {}
    }
    pitarError();
    console.error(e);
    window.mostrarToast('Error al buscar productos', 'error');
  }
}

function renderResultados(items) {
  const cont = document.getElementById('pos-resultados');
  if (!items.length) {
    cont.innerHTML = '<p class="pos-resultados-vacio">Escaneá un código de barras o escribí para buscar productos.</p>';
    return;
  }
  cont.innerHTML = items.map(p => {
    const stock = p.stock_disponible;
    let badge = '';
    if (stock !== null && stock !== undefined) {
      const cls = stock <= 0 ? 'sin' : (stock < 5 ? 'bajo' : 'ok');
      badge = `<span class="pos-producto-stock ${cls}">${stock <= 0 ? 'Sin stock' : `Stock: ${stock}`}</span>`;
    }
    const sinStock = stock !== null && stock !== undefined && stock <= 0;
    return `
      <div class="pos-producto-card ${sinStock ? 'sin-stock' : ''}" data-id="${p.id}">
        <div class="pos-producto-info">
          <span class="pos-producto-nombre">${escapeHtml(p.nombre)}</span>
          <span class="pos-producto-meta">${escapeHtml(p.codigo || '')} · ${escapeHtml(p.unidad || 'un')}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${badge}
          <span class="pos-producto-precio">${fmt(p.precio)}</span>
        </div>
      </div>`;
  }).join('');

  cont.querySelectorAll('.pos-producto-card').forEach(el => {
    el.addEventListener('click', () => {
      const item = items.find(p => p.id === el.dataset.id);
      if (item) agregarAlCarrito(item);
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Fase 2 — ítem 13: Grilla de favoritos
// ══════════════════════════════════════════════════════════════════════════
async function cargarFavoritos() {
  try {
    const qs = cajaActual?.id ? `?caja_id=${cajaActual.id}` : '';
    const favs = await apiGet(`/api/pos/favoritos${qs}`);
    renderGrillaFavoritos(favs);
    favoritosCargados = true;
  } catch (_e) {
    // favoritos es opcional — si falla no interrumpe el flujo
  }
}

function renderGrillaFavoritos(favs) {
  const cont = document.getElementById('pos-grilla-favoritos');
  if (!cont) return;

  if (!favs || !favs.length) {
    cont.innerHTML = '<p class="pos-fav-vacio">Sin favoritos configurados. Podés agregar productos frecuentes desde Administrar → Favoritos.</p>';
    return;
  }

  cont.innerHTML = favs.map(f => {
    const color = f.color || 'var(--nav-ventas, #487050)';
    const etiqueta = f.etiqueta || f.nombre || 'Producto';
    return `
      <button class="pos-fav-btn" data-id="${f.producto_id}" data-fav='${JSON.stringify(f)}'
              style="--fav-color:${escapeHtml(color)}" title="${escapeHtml(etiqueta)}">
        <span class="pos-fav-nombre">${escapeHtml(etiqueta)}</span>
        <span class="pos-fav-precio">${fmt(f.precio)}</span>
      </button>`;
  }).join('');

  cont.querySelectorAll('.pos-fav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = JSON.parse(btn.dataset.fav);
      agregarAlCarrito({
        id: f.producto_id,
        nombre: f.etiqueta || f.nombre,
        codigo: f.codigo || '',
        precio: f.precio,
        iva: f.iva ?? 21,
        unidad: f.unidad || 'un',
        stock_disponible: f.stock_disponible ?? 9999, // favorito: si no hay dato, se permite (avisa RPC)
      });
    });
  });
}

// Gestión de favoritos — panel Admin → pestaña Favoritos
async function cargarFavoritosAdmin() {
  const cont = document.getElementById('pos-fav-admin-lista');
  if (!cont) return;
  cont.innerHTML = '<p class="pos-resultados-vacio">Cargando...</p>';
  try {
    const favs = await apiGet('/api/pos/favoritos');
    renderFavoritosAdmin(favs);
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar')}</p>`;
  }
}

function renderFavoritosAdmin(favs) {
  const cont = document.getElementById('pos-fav-admin-lista');
  if (!favs.length) {
    cont.innerHTML = '<p class="pos-resultados-vacio">Todavía no hay favoritos. Buscá un producto abajo para agregar.</p>';
    return;
  }
  cont.innerHTML = favs.map((f, idx) => `
    <div class="pos-fav-admin-fila" data-id="${f.id}" data-producto-id="${f.producto_id}">
      <span class="pos-fav-admin-pos">${idx + 1}</span>
      <span class="pos-fav-admin-nombre">${escapeHtml(f.nombre)}</span>
      <input type="text" class="input-base pos-fav-admin-etiqueta" value="${escapeHtml(f.etiqueta || '')}" placeholder="Nombre corto (opcional)" maxlength="30" />
      <input type="color" class="pos-fav-admin-color" value="${f.color || '#487050'}" title="Color del botón" />
      <button class="btn btn--sm" onclick="guardarFavorito('${f.id}', '${f.producto_id}', this)" title="Guardar cambios"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg></button>
      <button class="pos-venta-btn-anular" onclick="quitarFavorito('${f.id}')">Quitar</button>
    </div>
  `).join('');
}

window.guardarFavorito = async function (favId, productoId, btn) {
  const fila = btn.closest('[data-id]');
  const etiqueta = fila.querySelector('.pos-fav-admin-etiqueta')?.value?.trim() || null;
  const color    = fila.querySelector('.pos-fav-admin-color')?.value || '#487050';
  try {
    btn.disabled = true;
    await apiPost('/api/pos/favoritos', { producto_id: productoId, etiqueta: etiqueta || null, color });
    window.toast('Favorito actualizado', 'exito');
    await cargarFavoritos(); // refrescar grilla principal
  } catch (e) {
    console.error(e);
    window.toast('No se pudo guardar', 'error');
  } finally {
    btn.disabled = false;
  }
};

// Búsqueda para agregar favorito
let favBuscarTimer = null;
document.getElementById('pos-fav-buscar')?.addEventListener('input', (e) => {
  clearTimeout(favBuscarTimer);
  const q = e.target.value.trim();
  const cont = document.getElementById('pos-fav-buscar-resultados');
  if (!q) { cont.innerHTML = ''; return; }
  favBuscarTimer = setTimeout(async () => {
    try {
      const res = await apiGet(`/api/pos/productos?q=${encodeURIComponent(q)}`);
      cont.innerHTML = (res || []).slice(0, 8).map(p => `
        <div class="pos-cliente-resultado" data-id="${p.id}" data-fav='${JSON.stringify(p)}'>
          ${escapeHtml(p.nombre)} <span style="color:var(--color-text-light)">${escapeHtml(p.codigo || '')}</span>
        </div>
      `).join('') || '<div class="pos-cliente-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      cont.querySelectorAll('[data-id]').forEach(el => {
        el.addEventListener('click', () => agregarFavorito(JSON.parse(el.dataset.fav)));
      });
    } catch (_e) {}
  }, 220);
});

async function agregarFavorito(producto) {
  try {
    await apiPost('/api/pos/favoritos', { producto_id: producto.id });
    window.toast('Favorito agregado', 'exito');
    document.getElementById('pos-fav-buscar').value = '';
    document.getElementById('pos-fav-buscar-resultados').innerHTML = '';
    const favs = await apiGet('/api/pos/favoritos');
    renderFavoritosAdmin(favs);
  } catch (e) {
    console.error(e);
    window.toast('No se pudo agregar el favorito', 'error');
  }
}

window.quitarFavorito = async function (favId) {
  try {
    await apiPost('/api/pos/favoritos-quitar', { id: favId });
    window.toast('Favorito eliminado', 'default');
    const favs = await apiGet('/api/pos/favoritos');
    renderFavoritosAdmin(favs);
  } catch (e) {
    console.error(e);
    window.toast('No se pudo quitar el favorito', 'error');
  }
};

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

// ── Pestaña Ventas (anular) ──────────────────────────────────────────────
async function cargarVentas(q) {
  const cont = document.getElementById('pos-admin-ventas-lista');
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    const desde  = document.getElementById('pos-admin-ventas-desde')?.value;
    const hasta  = document.getElementById('pos-admin-ventas-hasta')?.value;
    const estado = document.getElementById('pos-admin-ventas-estado')?.value;
    if (desde)  params.set('desde', desde);
    if (hasta)  params.set('hasta', hasta);
    if (estado) params.set('estado', estado);
    params.set('limit', '500');
    const ventas = await apiGet(`/api/pos/ventas${params.toString() ? '?' + params.toString() : ''}`);
    ventasAdminCache = ventas;
    ventasPaginaActual = 1; // nuevo filtro/búsqueda/día → siempre arranca en la página 1
    renderResumenVentas(ventas);
    renderVentas(ventas);
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar las ventas')}</p>`;
  }
}

let ventasAdminCache = [];

window.exportarVentasExcel = function () {
  if (!ventasAdminCache.length) { window.toast('No hay ventas para exportar', 'error'); return; }
  const filas = ventasAdminCache.map(v => ({
    'Número':        v.numero || '',
    'Fecha':         v.created_at ? new Date(v.created_at).toLocaleString('es-AR') : '',
    'Cliente':       v.clientes?.razon_social || 'Consumidor final',
    'Caja':          v.cajas_pos?.nombre || '',
    'Total':         Number(v.total) || 0,
    'Descuento (%)': v.descuento_global_pct || 0,
    'Estado':        v.estado || '',
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ventas POS');
  XLSX.writeFile(wb, `ventas-pos-${new Date().toISOString().slice(0,10)}.xlsx`);
};

document.getElementById('pos-admin-buscar-venta')?.addEventListener('input', (e) => {
  clearTimeout(buscarVentaTimer);
  const q = e.target.value.trim();
  buscarVentaTimer = setTimeout(() => cargarVentas(q), 250);
});

// FIX: no había ninguna vista agregada de "cuánto vendí por día" — solo la
// lista plana de ventas (una por una) o el historial de arqueo por turno en
// Cajas. Este resumen agrupa por día lo que ya está cargado y filtrado en
// pantalla (respeta buscador, rango de fechas y estado), sin pegarle otra
// vez al backend. Clic en un día → filtra la lista a ese día.
function fechaLocalKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

window.filtrarPorDia = function (fechaKey) {
  document.getElementById('pos-admin-ventas-desde').value = fechaKey;
  document.getElementById('pos-admin-ventas-hasta').value = fechaKey;
  cargarVentas(document.getElementById('pos-admin-buscar-venta')?.value.trim());
};

function renderResumenVentas(ventas) {
  const cont = document.getElementById('pos-admin-ventas-resumen');
  if (!cont) return;
  if (!ventas.length) { cont.innerHTML = ''; return; }

  const porDia = new Map(); // fechaKey -> { fechaKey, cantidad, total, anuladas }
  for (const v of ventas) {
    const key = fechaLocalKey(v.created_at);
    if (!porDia.has(key)) porDia.set(key, { fechaKey: key, cantidad: 0, total: 0, anuladas: 0 });
    const d = porDia.get(key);
    if (v.estado === 'anulada') {
      d.anuladas++;
    } else {
      d.cantidad++;
      d.total += Number(v.total) || 0;
    }
  }

  const dias = [...porDia.values()].sort((a, b) => b.fechaKey.localeCompare(a.fechaKey));
  const totalGeneral = dias.reduce((acc, d) => acc + d.total, 0);
  const cantidadGeneral = dias.reduce((acc, d) => acc + d.cantidad, 0);

  cont.innerHTML = `
    <div class="pos-ventas-resumen-tabla">
      <div class="pos-ventas-resumen-fila pos-ventas-resumen-header">
        <span>Día</span><span>Ventas</span><span>Anuladas</span><span>Total</span>
      </div>
      ${dias.map(d => `
        <div class="pos-ventas-resumen-fila" onclick="filtrarPorDia('${d.fechaKey}')" title="Ver el detalle de este día">
          <span>${escapeHtml(new Date(d.fechaKey + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' }))}</span>
          <span>${d.cantidad}</span>
          <span>${d.anuladas ? d.anuladas : '—'}</span>
          <span>${fmt(d.total)}</span>
        </div>
      `).join('')}
      <div class="pos-ventas-resumen-fila pos-ventas-resumen-total">
        <span>Total del período</span><span>${cantidadGeneral}</span><span></span><span>${fmt(totalGeneral)}</span>
      </div>
    </div>`;
}

// FIX: la lista de ventas volcaba las hasta 500 filas que trae el backend
// en un solo bloque scrolleable, sin paginar — con la caja abierta un rato,
// eso son cientos de filas apiladas y sin ninguna referencia de "dónde estoy".
// Paginamos en el cliente (ya tenemos todo el período cargado en memoria
// para el resumen por día, así que no hace falta pegarle de nuevo al
// backend por cada página) y dejamos el resumen intacto viendo el período
// completo, como antes.
const VENTAS_POR_PAGINA = 20;
let ventasPaginaActual = 1;

function renderVentas(ventas) {
  const cont = document.getElementById('pos-admin-ventas-lista');
  const contPag = document.getElementById('pos-admin-ventas-paginacion');
  if (!ventas.length) {
    cont.innerHTML = '<p class="pos-resultados-vacio">Sin ventas para mostrar.</p>';
    if (contPag) contPag.innerHTML = '';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(ventas.length / VENTAS_POR_PAGINA));
  if (ventasPaginaActual > totalPaginas) ventasPaginaActual = totalPaginas;
  if (ventasPaginaActual < 1) ventasPaginaActual = 1;

  const desdeIdx = (ventasPaginaActual - 1) * VENTAS_POR_PAGINA;
  const pagina = ventas.slice(desdeIdx, desdeIdx + VENTAS_POR_PAGINA);

  cont.innerHTML = pagina.map(v => `
    <div class="pos-venta-fila ${v.estado === 'anulada' ? 'anulada' : ''}">
      <div class="pos-venta-fila-info">
        <span class="pos-venta-fila-num">N° ${escapeHtml(v.numero || '—')}${v.descuento_global_pct ? ` <span style="font-size:11px;font-weight:600;color:var(--color-warning,#8A5F13);">−${v.descuento_global_pct}%</span>` : ''}</span>
        <span class="pos-venta-fila-meta">${escapeHtml(v.clientes?.razon_social || 'Consumidor final')} · ${escapeHtml(v.cajas_pos?.nombre || '')} · ${window.formatHora ? window.formatHora(v.created_at) : ''}</span>
      </div>
      <span class="pos-venta-fila-total">${fmt(v.total)}</span>
      ${v.estado === 'anulada'
        ? '<span class="pos-venta-badge-anulada">Anulada</span>'
        : v.factura_id
          ? '<span class="pos-venta-badge-facturada" title="Ya tiene factura con CAE emitida. Para anularla, emití antes una Nota de Crédito.">Facturada</span>'
          : `<button class="pos-venta-btn-anular" onclick="anularVenta('${v.id}', '${escapeHtml(v.numero || '')}')">Anular</button>`}
    </div>
  `).join('');

  if (contPag) {
    contPag.innerHTML = `
      <button type="button" class="pos-pag-btn" ${ventasPaginaActual <= 1 ? 'disabled' : ''} onclick="irAPaginaVentas(-1)">‹ Anterior</button>
      <span class="pos-pag-info">Página ${ventasPaginaActual} de ${totalPaginas} · ${ventas.length} ventas</span>
      <button type="button" class="pos-pag-btn" ${ventasPaginaActual >= totalPaginas ? 'disabled' : ''} onclick="irAPaginaVentas(1)">Siguiente ›</button>
    `;
  }
}

window.irAPaginaVentas = function (delta) {
  ventasPaginaActual += delta;
  renderVentas(ventasAdminCache);
  document.getElementById('pos-admin-ventas-lista')?.scrollTo({ top: 0, behavior: 'smooth' });
};

window.anularVenta = async function (venta_pos_id, numero) {
  const venta = ventasAdminCache.find(v => v.id === venta_pos_id);

  // Si ya tiene factura con CAE emitida, no dejamos ni abrir el diálogo:
  // anularla acá dejaría la factura viva ante AFIP sin la venta que la
  // respalda. Hay que emitir una Nota de Crédito primero (fuera de este
  // flujo por ahora).
  if (venta?.factura_id) {
    window.toast(`La venta N° ${numero} ya tiene una factura con CAE emitida. Para anularla, emití antes una Nota de Crédito.`, 'error');
    return;
  }

  const cliente  = venta?.clientes?.razon_social || 'Consumidor final';
  const importe  = venta ? fmt(venta.total) : '';
  const mensaje  = `¿Anular la venta N° ${numero}${importe ? ` (${importe})` : ''}${cliente ? ` — ${escapeHtml(cliente)}` : ''}?<br>Se repone el stock vendido. Esta acción no se puede deshacer.`;

  const doAnular = async () => {
    const motivo = await window.confirmarConTexto(mensaje, {
      labelOk: 'Sí, anular', placeholder: 'Motivo de la anulación (obligatorio)...', requerido: true,
    });
    if (!motivo) return;
    try {
      await apiPost('/api/pos/anular', { venta_pos_id, motivo });
      window.toast('Venta anulada', 'exito');
      cargarVentas(document.getElementById('pos-admin-buscar-venta')?.value.trim());
    } catch (e) {
      console.error(e);
      window.toast(e.message || 'No se pudo anular la venta', 'error');
    }
  };

  if (window.tieneRol?.('dueno', 'admin')) {
    doAnular();
  } else {
    pedirPinSupervisor(`Anular la venta N° ${numero} requiere autorización de supervisor.`, doAnular);
  }
};

// ── Pestaña Stock ──────────────────────────────────────────────────────────
async function cargarDepositosAdmin() {
  if (depositosAdmin.length) return;
  try {
    depositosAdmin = await apiGet('/api/pos/depositos');
    const opciones = depositosAdmin.map(d => `<option value="${d.id}">${escapeHtml(d.nombre)}</option>`).join('');
    document.getElementById('pos-transf-origen').innerHTML  = opciones || '<option value="">Sin depósitos</option>';
    document.getElementById('pos-transf-destino').innerHTML = opciones || '<option value="">Sin depósitos</option>';
  } catch (e) {
    console.error(e);
    window.toast('Error al cargar depósitos', 'error');
  }
}

document.getElementById('pos-transf-producto')?.addEventListener('input', (e) => {
  clearTimeout(buscarProdTransfTimer);
  const q = e.target.value.trim();
  const cont = document.getElementById('pos-transf-producto-resultados');
  if (!q) { cont.innerHTML = ''; return; }
  buscarProdTransfTimer = setTimeout(async () => {
    try {
      const resultados = await apiGet(`/api/pos/productos?q=${encodeURIComponent(q)}`);
      cont.innerHTML = (resultados || []).slice(0, 10).map(p => `
        <div class="pos-cliente-resultado" data-id="${p.id}">${escapeHtml(p.nombre)} <span style="color:var(--color-text-light)">${escapeHtml(p.codigo || '')}</span></div>
      `).join('') || '<div class="pos-cliente-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      cont.querySelectorAll('.pos-cliente-resultado[data-id]').forEach(el => {
        el.addEventListener('click', () => {
          const p = resultados.find(r => r.id === el.dataset.id);
          if (p) seleccionarProductoTransf(p);
        });
      });
    } catch (e) { console.error(e);
    window.toast('Error al buscar productos', 'error'); }
  }, 220);
});

function seleccionarProductoTransf(producto) {
  productoTransfSel = producto;
  const cont = document.getElementById('pos-transf-producto-sel');
  cont.style.display = '';
  cont.innerHTML = `<span>${escapeHtml(producto.nombre)}</span><button onclick="quitarProductoTransf()">Quitar</button>`;
  document.getElementById('pos-transf-producto').value = '';
  document.getElementById('pos-transf-producto-resultados').innerHTML = '';
}
window.quitarProductoTransf = function () {
  productoTransfSel = null;
  document.getElementById('pos-transf-producto-sel').style.display = 'none';
};

window.confirmarTransferencia = async function () {
  const errEl = document.getElementById('pos-transf-error');
  errEl.style.display = 'none';
  if (!productoTransfSel) { errEl.textContent = 'Elegí un producto primero.'; errEl.style.display = ''; return; }
  const origen   = document.getElementById('pos-transf-origen').value;
  const destino  = document.getElementById('pos-transf-destino').value;
  const cantidad = parseFloat(document.getElementById('pos-transf-cantidad').value || '0');
  const notas    = document.getElementById('pos-transf-notas').value.trim();
  if (!origen || !destino) { errEl.textContent = 'Elegí depósito de origen y de destino.'; errEl.style.display = ''; return; }
  if (origen === destino)  { errEl.textContent = 'El depósito de origen y destino no pueden ser el mismo.'; errEl.style.display = ''; return; }
  if (!cantidad || cantidad <= 0) { errEl.textContent = 'Ingresá una cantidad válida.'; errEl.style.display = ''; return; }
  const btn = document.getElementById('btn-confirmar-transferencia');
  btn.disabled = true;
  try {
    await apiPost('/api/pos/transferir-stock', { producto_id: productoTransfSel.id, deposito_origen: origen, deposito_destino: destino, cantidad, notas: notas || null });
    window.toast('Stock transferido', 'exito');
    quitarProductoTransf();
    document.getElementById('pos-transf-cantidad').value = '';
    document.getElementById('pos-transf-notas').value = '';
    cargarTransferencias();
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo transferir el stock'; errEl.style.display = '';
  } finally { btn.disabled = false; }
};

async function cargarTransferencias() {
  const cont = document.getElementById('pos-admin-transferencias-lista');
  try {
    const data = await apiGet('/api/pos/transferencias-stock');
    renderTransferencias(data);
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar el historial')}</p>`;
  }
}

function renderTransferencias(items) {
  const cont = document.getElementById('pos-admin-transferencias-lista');
  if (!items.length) { cont.innerHTML = '<p class="pos-resultados-vacio">Todavía no hay transferencias registradas.</p>'; return; }
  cont.innerHTML = items.map(t => `
    <div class="pos-transf-fila">
      <div class="pos-transf-fila-info">
        <span class="pos-venta-fila-num">${escapeHtml(t.productos?.nombre || 'Producto')}</span>
        <span class="pos-transf-fila-meta">→ ${escapeHtml(t.depositos?.nombre || '')} · ${window.formatHora ? window.formatHora(t.created_at) : ''}</span>
      </div>
      <span class="pos-venta-fila-total">+${t.cantidad}</span>
    </div>
  `).join('');
}

// ── Util ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(str);
}

// ══════════════════════════════════════════════════════════════════════════
// FASE 3 (v142) — Alta rápida de cliente, alerta stock, preguntar factura
// ══════════════════════════════════════════════════════════════════════════

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

function iniciarPanelDevoluciones() {
  _devVentaSel = null;
  document.getElementById('dev-venta-buscar').value = '';
  document.getElementById('dev-venta-resultado').innerHTML = '';
  document.getElementById('dev-items-panel').style.display = 'none';
  document.getElementById('dev-historial-lista').innerHTML = '';
}

window.buscarVentaDevolucion = async function () {
  const q = document.getElementById('dev-venta-buscar').value.trim();
  const resEl = document.getElementById('dev-venta-resultado');
  if (!q) { resEl.innerHTML = ''; return; }
  resEl.innerHTML = '<p class="pos-resultados-vacio">Buscando...</p>';
  try {
    const ventas = await apiGet(`/api/pos/ventas?q=${encodeURIComponent(q)}`);
    if (!ventas.length) { resEl.innerHTML = '<p class="pos-resultados-vacio">No se encontró ninguna venta con ese número.</p>'; return; }
    resEl.innerHTML = ventas.slice(0, 5).map(v => `
      <div class="pos-cliente-resultado" onclick="seleccionarVentaDevolucion('${v.id}')">
        <strong>N° ${escapeHtml(v.numero || '—')}</strong> · ${escapeHtml(v.clientes?.razon_social || 'Consumidor final')} · ${fmt(v.total)}
        ${v.estado === 'anulada' ? ' <span style="color:var(--color-danger,#7A2820)">[Anulada]</span>' : ''}
      </div>
    `).join('');
  } catch (e) {
    resEl.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al buscar')}</p>`;
  }
};

window.seleccionarVentaDevolucion = async function (ventaId) {
  document.getElementById('dev-venta-resultado').innerHTML = '<p class="pos-resultados-vacio">Cargando detalle...</p>';
  try {
    const venta = await apiGet(`/api/pos/ticket?venta_id=${ventaId}`);
    _devVentaSel = {
      id:     venta.id,
      numero: venta.numero,
      items:  (venta.venta_pos_items || []).map(i => ({
        id:            i.id,
        nombre:        i.productos?.nombre || 'Producto',
        cantidad:      parseFloat(i.cantidad),
        precio_unit:   parseFloat(i.precio_unitario),
        descuento_pct: parseFloat(i.descuento_pct || 0),
        subtotal:      parseFloat(i.subtotal),
      })),
    };

    document.getElementById('dev-venta-resultado').innerHTML =
      `<div style="padding:6px 0;font-size:13px;color:var(--color-text)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Venta N° <strong>${escapeHtml(venta.numero)}</strong> seleccionada</div>`;

    // Renderizar items con input de cantidad a devolver
    document.getElementById('dev-items-lista').innerHTML = _devVentaSel.items.map((it, idx) => `
      <div class="pos-dev-item-fila">
        <span class="pos-dev-item-nombre">${escapeHtml(it.nombre)}</span>
        <span class="pos-dev-item-cant-orig">Vendido: ${it.cantidad}</span>
        <input type="number" class="input-base pos-dev-item-input" id="dev-cant-${idx}"
               min="0" max="${it.cantidad}" step="1" placeholder="0" value="0" />
      </div>
    `).join('');

    document.getElementById('dev-items-panel').style.display = '';
    document.getElementById('dev-motivo').value = '';
    document.getElementById('dev-error').style.display = 'none';

    // Cargar historial de devoluciones previas
    const devs = await apiGet(`/api/pos/devoluciones?venta_id=${ventaId}`);
    renderHistorialDevoluciones(devs);
  } catch (e) {
    document.getElementById('dev-venta-resultado').innerHTML =
      `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar la venta')}</p>`;
  }
};

function renderHistorialDevoluciones(devs) {
  const cont = document.getElementById('dev-historial-lista');
  if (!devs.length) { cont.innerHTML = ''; return; }
  cont.innerHTML = `<p class="pos-sec-label" style="margin-top:10px">Devoluciones registradas</p>` +
    devs.map(d => `
      <div class="pos-dev-historial-fila">
        <div class="pos-dev-historial-header">
          <span>${window.formatHora ? window.formatHora(d.created_at) : d.created_at} · ${escapeHtml(d.usuarios?.nombre || 'Usuario')}</span>
          <span class="pos-dev-monto">${fmt(d.monto_total)}</span>
        </div>
        ${d.motivo ? `<div style="font-size:11px;margin-bottom:3px;color:var(--color-text-light)">${escapeHtml(d.motivo)}</div>` : ''}
        <div class="pos-dev-historial-items">
          ${(d.devoluciones_pos_items || []).map(i =>
            `${i.cantidad_devuelta} × ${escapeHtml(i.productos?.nombre || 'Producto')} — ${fmt(i.monto)}`
          ).join('<br>')}
        </div>
      </div>
    `).join('');
}

window.confirmarDevolucion = async function () {
  const errEl = document.getElementById('dev-error');
  errEl.style.display = 'none';

  if (!_devVentaSel) { errEl.textContent = 'No hay venta seleccionada.'; errEl.style.display = ''; return; }

  const items = [];
  _devVentaSel.items.forEach((it, idx) => {
    const cant = parseInt(document.getElementById(`dev-cant-${idx}`)?.value || '0', 10);
    if (cant > 0) {
      items.push({ venta_pos_item_id: it.id, cantidad_devuelta: cant });
    }
  });

  if (!items.length) {
    errEl.textContent = 'Indicá al menos una cantidad a devolver mayor a cero.';
    errEl.style.display = '';
    return;
  }

  const motivo = document.getElementById('dev-motivo').value.trim();
  const btn = document.getElementById('btn-confirmar-devolucion');
  btn.disabled = true;

  try {
    await apiPost('/api/pos/devolucion', {
      venta_pos_id: _devVentaSel.id,
      items,
      motivo: motivo || null,
    });
    window.toast('Devolución registrada', 'exito');
    // Recargar historial
    const devs = await apiGet(`/api/pos/devoluciones?venta_id=${_devVentaSel.id}`);
    renderHistorialDevoluciones(devs);
    // Limpiar cantidades
    _devVentaSel.items.forEach((_, idx) => {
      const inp = document.getElementById(`dev-cant-${idx}`);
      if (inp) inp.value = '0';
    });
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo registrar la devolución';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
};

// ══════════════════════════════════════════════════════════════════════════
// FASE 4 — GESTIÓN DE PROMOCIONES
// ══════════════════════════════════════════════════════════════════════════

let _promoProdSel = null; // producto seleccionado para promo

async function iniciarPanelPromociones() {
  _promoProdSel = null;
  await Promise.all([cargarPromocionesAdmin(), cargarCategoriasParaPromo()]);
  renderPromoFormExtra();
}

async function cargarPromocionesAdmin() {
  const cont = document.getElementById('pos-promos-lista');
  try {
    const promos = await apiGet('/api/pos/promociones');
    if (!promos.length) {
      cont.innerHTML = '<p class="pos-resultados-vacio">No hay promociones configuradas.</p>';
      return;
    }
    cont.innerHTML = promos.map(p => {
      const desc = p.tipo === 'nxm'
        ? `${p.n_cantidad}x${p.m_paga}`
        : `${p.descuento_pct}% de descuento`;
      const objetivo = p.productos?.nombre || p.categorias?.nombre || '(todos)';
      return `
        <div class="pos-promo-fila">
          <div class="pos-promo-info">
            <div class="pos-promo-nombre">${escapeHtml(p.nombre)}</div>
            <div class="pos-promo-meta">${desc} · ${escapeHtml(objetivo)}</div>
          </div>
          <span class="pos-promo-badge ${p.activa ? 'activa' : 'inactiva'}">${p.activa ? 'Activa' : 'Inactiva'}</span>
          <button class="btn btn--sm" onclick="togglePromo('${p.id}')">${p.activa ? 'Pausar' : 'Activar'}</button>
          <button class="pos-venta-btn-anular" onclick="eliminarPromo('${p.id}')">Eliminar</button>
        </div>
      `;
    }).join('');
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar')}</p>`;
  }
}

async function cargarCategoriasParaPromo() {
  try {
    const cats = await apiGet('/api/categorias');
    const sel = document.getElementById('promo-cat-select');
    if (!sel) return;
    sel.innerHTML = (cats || []).map(c => `<option value="${sanitize(c.id)}">${escapeHtml(c.nombre)}</option>`).join('')
      || '<option value="">Sin categorías</option>';
  } catch (_e) {}
}

window.renderPromoFormExtra = function () {
  const tipo = document.getElementById('promo-tipo')?.value;
  document.getElementById('promo-extra-nxm').style.display         = tipo === 'nxm' ? '' : 'none';
  document.getElementById('promo-extra-descuento').style.display   = tipo !== 'nxm' ? '' : 'none';
  document.getElementById('promo-extra-producto').style.display    = tipo === 'descuento_producto' ? '' : 'none';
  document.getElementById('promo-extra-categoria').style.display   = tipo === 'descuento_categoria' ? '' : 'none';
};

// Búsqueda de producto para promo
let _promoBuscarTimer = null;
document.getElementById('promo-prod-buscar')?.addEventListener('input', (e) => {
  clearTimeout(_promoBuscarTimer);
  const q = e.target.value.trim();
  const cont = document.getElementById('promo-prod-resultados');
  if (!q) { cont.innerHTML = ''; return; }
  _promoBuscarTimer = setTimeout(async () => {
    try {
      const res = await apiGet(`/api/pos/productos?q=${encodeURIComponent(q)}`);
      cont.innerHTML = (res || []).slice(0, 8).map(p => `
        <div class="pos-cliente-resultado" data-id="${p.id}" data-nombre="${escapeHtml(p.nombre)}">
          ${escapeHtml(p.nombre)} <span style="color:var(--color-text-light)">${escapeHtml(p.codigo || '')}</span>
        </div>
      `).join('') || '<div class="pos-cliente-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      cont.querySelectorAll('[data-id]').forEach(el => {
        el.addEventListener('click', () => {
          _promoProdSel = el.dataset.id;
          document.getElementById('promo-prod-sel').style.display = '';
          document.getElementById('promo-prod-sel').textContent = el.dataset.nombre;
          document.getElementById('promo-prod-buscar').value = '';
          cont.innerHTML = '';
        });
      });
    } catch (_e) {}
  }, 220);
});

window.crearPromocion = async function () {
  const errEl = document.getElementById('promo-error');
  errEl.style.display = 'none';

  const nombre = document.getElementById('promo-nombre').value.trim();
  const tipo   = document.getElementById('promo-tipo').value;
  const desde  = document.getElementById('promo-desde').value || null;
  const hasta  = document.getElementById('promo-hasta').value || null;

  const body = { accion: 'crear', nombre, tipo, fecha_desde: desde, fecha_hasta: hasta };

  if (tipo === 'nxm') {
    body.n_cantidad = parseInt(document.getElementById('promo-n').value);
    body.m_paga     = parseInt(document.getElementById('promo-m').value);
  } else {
    body.descuento_pct = parseFloat(document.getElementById('promo-pct').value);
    if (tipo === 'descuento_producto') body.producto_id   = _promoProdSel;
    if (tipo === 'descuento_categoria') body.categoria_id = document.getElementById('promo-cat-select').value;
  }

  const btn = document.getElementById('btn-crear-promo');
  btn.disabled = true;
  try {
    await apiPost('/api/pos/promociones', body);
    window.toast('Promoción creada', 'exito');
    document.getElementById('promo-nombre').value = '';
    document.getElementById('promo-pct').value = '';
    document.getElementById('promo-n').value = '2';
    document.getElementById('promo-m').value = '1';
    document.getElementById('promo-desde').value = '';
    document.getElementById('promo-hasta').value = '';
    _promoProdSel = null;
    document.getElementById('promo-prod-sel').style.display = 'none';
    await cargarPromocionesAdmin();
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo crear la promoción';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
};

window.togglePromo = async function (id) {
  try {
    const res = await apiPost('/api/pos/promociones', { accion: 'toggle', id });
    window.toast(res.activa ? 'Promoción activada' : 'Promoción pausada', 'default');
    await cargarPromocionesAdmin();
  } catch (e) {
    console.error(e);
    window.toast('Error al cambiar estado', 'error');
  }
};

window.eliminarPromo = async function (id) {
  const ok = await window.confirmar('¿Eliminar esta promoción? Esta acción no se puede deshacer.', { tipo: 'danger', labelOk: 'Eliminar' });
  if (!ok) return;
  try {
    await apiPost('/api/pos/promociones', { accion: 'eliminar', id });
    window.toast('Promoción eliminada', 'default');
    await cargarPromocionesAdmin();
  } catch (e) {
    console.error(e);
    window.toast('Error al eliminar', 'error');
  }
};

// ══════════════════════════════════════════════════════════════════════════
// OFFLINE MODE — Feature #3 Grupo B
// ══════════════════════════════════════════════════════════════════════════

// Ticket para ventas que quedaron encoladas offline
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
