// frontend/admin/js/pos/atajos-teclado.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Atajos de teclado profesionales de POS/caja.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

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

