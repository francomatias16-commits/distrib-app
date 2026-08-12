// frontend/admin/js/pos-scanner-remoto.js
//
// v617 — "Vincular celular": lado de la compu del vínculo de escaneo
// remoto. La cámara real vive en el teléfono (página pública /scan-pos,
// ver frontend/scan-pos/). Acá solo:
//
//   1. Pide un token de sesión de un solo uso a /api/pos-scanner
//      (?accion=generar) y arma con él el QR y el link de fallback.
//   2. Se suscribe, con el cliente Supabase ya autenticado del panel
//      (window.supabaseClient, creado por auth.js), a un canal de
//      Realtime Broadcast cuyo nombre se deriva del token — el mismo
//      canal al que el celular manda cada código que escanea.
//   3. Por cada código recibido, lo vuelca en el buscador y dispara
//      buscarProductos(codigo, true) — EXACTAMENTE el mismo camino que ya
//      usa el lector físico (Enter) y la cámara local (pos-scanner.js).
//      No se reinventa ninguna lógica de carrito/stock/beeps acá.
//
// El vínculo (token + canal) sigue vivo aunque se cierre el modal — cerrar
// el modal con la X, Escape o "Ocultar" NO desvincula el celular, solo
// esconde la ventana. Desvincular es una acción explícita ("Cerrar
// vínculo") o pasa solo por inactividad real (ver DURACION_MINUTOS /
// extenderVinculoSiCorresponde en el handler). El botón "Vincular celular"
// de la barra refleja ese estado (pendiente / conectado) todo el tiempo,
// esté el modal abierto o no, así el cajero ve de un vistazo si el
// celular sigue enganchado sin tener que reabrir el modal.

(function () {
  'use strict';

  let canal = null;
  let tokenActual = null;
  let expiraTimer = null;
  let ultimaExtension = 0;
  let reconexionTimer = null;
  let intentosReconexion = 0;
  let estadoBoton = null; // null | 'pendiente' | 'conectado'

  const EXTENDER_CADA_MS = 5 * 60_000; // no pegarle al backend en cada escaneo suelto

  // ── Persistencia entre recargas/navegaciones ──────────────────────────
  // El celular no se entera si la compu cierra la pestaña, navega a otra
  // pantalla o recarga: sigue mandando códigos al mismo canal Realtime
  // igual. El problema era nuestro: tokenActual vivía solo en memoria de
  // este script, así que al volver a /admin/pos se perdía la referencia
  // y tocaba generar un QR nuevo — aunque el token viejo siguiera vivo en
  // el server y el celular lo siguiera usando de verdad. Guardando
  // {token, caja_id, expira_at} en localStorage, al volver a abrir esta
  // pantalla (usarTurno() llama a intentarResumirVinculoCelular) se puede
  // re-suscribir al mismo canal en silencio, sin modal ni QR nuevo.
  // localStorage (no sessionStorage) a propósito: tiene que sobrevivir
  // también a cerrar la pestaña/navegador, no solo a cambiar de pantalla.
  const LS_KEY = 'dv_pos_vc_v1';

  function guardarEnStorage(cajaId, expiraAtIso) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ token: tokenActual, caja_id: cajaId, expira_at: expiraAtIso }));
    } catch (_e) { /* localStorage no disponible (modo privado, etc.) — no es fatal, solo no persiste */ }
  }

  function leerDeStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_e) {
      return null;
    }
  }

  function borrarDeStorage() {
    try { localStorage.removeItem(LS_KEY); } catch (_e) {}
  }

  // Cualquier código que sea, en realidad, el link de "Vincular celular"
  // (propio o de otra sesión) nunca es un código de producto real — se
  // descarta acá como última red de seguridad. Pasa cuando el celular
  // arranca la cámara todavía apuntando a la pantalla que muestra el QR
  // (el primer frame llega a leer el QR de vinculación en vez del
  // artículo), o cuando algún lector físico levanta el QR de la pantalla
  // por reflejo. Mismo patrón en pos-scanner.js y scan-pos/portal.js.
  const RE_LINK_PROPIO = /\/scan-pos(?:[/?]|$)/i;

  function nombreCanal(token) {
    return `pos-scan-${token}`;
  }

  function mostrarErrorVc(msg) {
    const el = document.getElementById('vc-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = '';
  }

  function setEstadoVc(estado) {
    ['generando', 'qr', 'conectado'].forEach((e) => {
      const el = document.getElementById(`vc-estado-${e}`);
      if (el) el.style.display = e === estado ? '' : 'none';
    });
    actualizarBotonBarra(estado === 'conectado' ? 'conectado' : 'pendiente');
    bloquearBuscadorLocal(estado === 'qr' || estado === 'generando');
  }

  // Mientras se muestra el QR en pantalla, el buscador de productos se
  // deshabilita un instante: es el campo con foco por defecto del POS (ahí
  // "escribe" el lector físico), y si algo lee el QR que está en pantalla
  // en ese momento (cámara del celular arrancando todavía apuntando al
  // monitor, o un lector físico que lo levanta de reflejo), sin esto el
  // link terminaba tipeado ahí y disparando una búsqueda de "producto no
  // encontrado". Se reactiva solo al pasar a "conectado" o cerrar/ocultar.
  function bloquearBuscadorLocal(bloquear) {
    const input = document.getElementById('pos-input-producto');
    if (!input) return;
    input.disabled = bloquear;
    if (!bloquear && document.activeElement === document.body) input.focus();
  }

  function actualizarBotonBarra(estado) {
    estadoBoton = estado;
    const btn = document.getElementById('pos-btn-vincular-celular');
    const label = document.getElementById('pos-btn-vincular-celular-label');
    if (!btn) return;
    btn.classList.remove('pos-btn-vinculado', 'pos-btn-vinculo-pendiente');
    if (estado === 'conectado') {
      btn.classList.add('pos-btn-vinculado');
      btn.title = 'Celular vinculado — click para ver el estado o desvincular';
      if (label) label.textContent = 'Celular vinculado';
    } else if (estado === 'pendiente') {
      btn.classList.add('pos-btn-vinculo-pendiente');
      btn.title = 'Vínculo generado, esperando que escaneen el QR';
      if (label) label.textContent = 'Vinculando…';
    } else {
      btn.title = 'Usar el celular como lector de código de barras';
      if (label) label.textContent = 'Vincular celular';
    }
  }

  async function abrirModalVincularCelular() {
    const overlay = document.getElementById('modal-vincular-celular-overlay');
    if (!overlay) return;

    // Ya hay un vínculo vivo (el cajero lo había ocultado, no cerrado):
    // reabrir mostrando su estado actual, sin pedir un token nuevo — el
    // teléfono ya conectado seguiría mandando códigos al canal viejo.
    if (tokenActual) {
      overlay.style.display = 'flex';
      setEstadoVc(estadoBoton === 'conectado' ? 'conectado' : 'qr');
      return;
    }

    if (!turnoActual || !turnoActual.caja_id) {
      mostrarToast('Abrí un turno de caja antes de vincular el celular.', 'error', 4000);
      return;
    }
    if (!window.supabaseClient) {
      mostrarToast('No se pudo iniciar el vínculo (sesión no disponible). Recargá la página.', 'error', 4000);
      return;
    }

    const errEl = document.getElementById('vc-error');
    if (errEl) errEl.style.display = 'none';
    const ultimoEl = document.getElementById('vc-ultimo-codigo');
    if (ultimoEl) ultimoEl.style.display = 'none';
    setEstadoVc('generando');
    overlay.style.display = 'flex';

    try {
      // v617: el endpoint pasó a ser genérico (pos/alta_producto/
      // ajuste_stock, ver CONTEXTOS en lib/handlers/pos-scanner.js) — el
      // POS sigue siendo el mismo caso de siempre, solo cambia la forma
      // del body que se manda.
      const data = await apiPost('/api/pos-scanner?accion=generar', { contexto: 'pos', entidad_id: turnoActual.caja_id });
      tokenActual = data.token;

      // QR + link de fallback
      const qrWrap = document.getElementById('vc-qr-canvas');
      if (qrWrap) {
        qrWrap.innerHTML = '';
        if (window.QRCode) {
          // eslint-disable-next-line no-new
          new QRCode(qrWrap, { text: data.url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
        }
      }
      const link = document.getElementById('vc-link-fallback');
      if (link) { link.href = data.url; link.textContent = data.url.replace(/^https?:\/\//, ''); }

      setEstadoVc('qr');
      suscribirCanal(tokenActual);
      programarExpiracion(data.expira_at);
      guardarEnStorage(turnoActual.caja_id, data.expira_at);
    } catch (err) {
      console.error('[pos-scanner-remoto] no se pudo generar el vínculo:', err);
      mostrarErrorVc(err?.error || 'No se pudo generar el vínculo con el celular. Probá de nuevo.');
      actualizarBotonBarra(null);
    }
  }

  function suscribirCanal(token) {
    limpiarCanal({ mantenerToken: true });
    canal = window.supabaseClient
      .channel(nombreCanal(token), { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'listo' }, () => {
        onCelularListo();
      })
      .on('broadcast', { event: 'codigo' }, ({ payload }) => {
        const codigo = payload?.codigo;
        if (!codigo) return;
        onCodigoRecibido(codigo);
      })
      .subscribe((estado) => {
        if (estado === 'SUBSCRIBED') {
          intentosReconexion = 0;
          // Pedimos que el celular (si sigue conectado) vuelva a avisar
          // que está listo. Sin esto, al RESUMIR un vínculo guardado tras
          // recargar/reingresar a la pantalla (intentarResumirVinculoCelular)
          // la compu se re-suscribe al mismo canal pero el 'listo' original
          // ya se mandó hace rato y no vuelve — el botón quedaba trabado
          // en "Vinculando…" para siempre aunque el celular siguiera activo
          // y el escaneo funcionara igual. El celular responde este ping
          // reenviando 'listo' (ver avisarListoSiCorresponde en portal.js).
          canal.send({ type: 'broadcast', event: 'ping', payload: {} }).catch(() => {});
          return;
        }
        if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT' || estado === 'CLOSED') {
          console.warn(`[pos-scanner-remoto] canal "${nombreCanal(token)}" en estado ${estado} — reintentando`);
          programarReconexion(token);
        }
      });
  }

  // El canal de Realtime se puede caer por una red inestable sin que el
  // vínculo en sí haya sido cerrado (ni por el usuario ni por expiración) —
  // en ese caso hay que reconectar solo, no dejar el vínculo "muerto" en
  // pantalla hasta que el cajero cierre y reabra el modal a mano.
  function programarReconexion(token) {
    if (!tokenActual || tokenActual !== token) return; // el vínculo ya se cerró de verdad
    if (reconexionTimer) return; // ya hay un reintento en camino
    const espera = Math.min(1000 * 2 ** intentosReconexion, 15_000);
    intentosReconexion += 1;
    reconexionTimer = setTimeout(() => {
      reconexionTimer = null;
      if (tokenActual === token) suscribirCanal(token);
    }, espera);
  }

  function onCelularListo() {
    // Señal explícita del celular (cámara + canal ya arriba) — independiente
    // de que todavía no haya escaneado ningún producto real.
    setEstadoVc('conectado');
    extenderVinculoSiCorresponde();
  }

  function onCodigoRecibido(codigo) {
    if (RE_LINK_PROPIO.test(codigo)) {
      console.warn('[pos-scanner-remoto] se ignoró un código que es el propio link de vinculación:', codigo);
      return;
    }

    setEstadoVc('conectado');
    const ultimoEl = document.getElementById('vc-ultimo-codigo');
    if (ultimoEl) {
      ultimoEl.textContent = `Último código: ${codigo}`;
      ultimoEl.style.display = '';
    }
    if (navigator.vibrate) navigator.vibrate(80);

    // Mismo camino que usa el lector físico al mandar Enter.
    const input = document.getElementById('pos-input-producto');
    if (input) input.value = codigo;
    if (typeof window.buscarProductos === 'function') {
      window.buscarProductos(codigo, true);
    }

    extenderVinculoSiCorresponde();
  }

  // Sliding expiration: mientras el vínculo se sigue usando, se empuja el
  // vencimiento hacia adelante — el TTL fijo (DURACION_MINUTOS) solo corta
  // una sesión abandonada, no una que está activa. Throttleado para no
  // pegarle al backend en cada código.
  async function extenderVinculoSiCorresponde() {
    if (!tokenActual) return;
    const ahora = Date.now();
    if (ahora - ultimaExtension < EXTENDER_CADA_MS) return;
    ultimaExtension = ahora;

    try {
      const data = await apiPost('/api/pos-scanner?accion=extender', { token: tokenActual });
      programarExpiracion(data.expira_at);
      if (turnoActual?.caja_id) guardarEnStorage(turnoActual.caja_id, data.expira_at);
    } catch (err) {
      // Si el vínculo ya no existe del lado del server (revocado por otra
      // pestaña, por ejemplo) no vale la pena seguir insistiendo acá — el
      // timer de expiración que ya está programado se va a encargar de
      // avisarle al cajero cuando corresponda.
      console.warn('[pos-scanner-remoto] no se pudo renovar el vínculo:', err);
    }
  }

  function programarExpiracion(expiraAtIso) {
    if (expiraTimer) clearTimeout(expiraTimer);
    const ms = new Date(expiraAtIso).getTime() - Date.now();
    if (!(ms > 0)) return;
    expiraTimer = setTimeout(() => {
      const overlay = document.getElementById('modal-vincular-celular-overlay');
      if (overlay) overlay.style.display = 'flex'; // reaparece para avisar, aunque estuviera oculto
      mostrarErrorVc('El vínculo venció por inactividad. Cerrá y generá uno nuevo si necesitás seguir usando el celular.');
      limpiarCanal();
      tokenActual = null;
      borrarDeStorage();
      actualizarBotonBarra(null);
      bloquearBuscadorLocal(false);
    }, ms);
  }

  // mantenerToken=true: se usa al resuscribir el mismo canal tras un
  // CHANNEL_ERROR — ahí no hay que tocar tokenActual/expiraTimer, solo el
  // socket del canal viejo.
  function limpiarCanal({ mantenerToken = false } = {}) {
    if (canal) {
      try { window.supabaseClient?.removeChannel(canal); } catch (_e) {}
      canal = null;
    }
    if (reconexionTimer) { clearTimeout(reconexionTimer); reconexionTimer = null; }
    if (mantenerToken) return;
    if (expiraTimer) { clearTimeout(expiraTimer); expiraTimer = null; }
  }

  // Ocultar: esconde el modal pero deja el vínculo (canal + token) vivo —
  // el celular sigue mandando códigos igual que si el modal estuviera
  // abierto. El botón de la barra sigue reflejando el estado.
  function ocultarModalVincularCelular() {
    const overlay = document.getElementById('modal-vincular-celular-overlay');
    if (overlay) overlay.style.display = 'none';
    bloquearBuscadorLocal(false);
    document.getElementById('pos-input-producto')?.focus();
  }

  // Desvincular: la única acción que corta el vínculo de verdad, aparte de
  // la expiración por inactividad. Revoca el token en el server.
  function desvincularCelular() {
    const overlay = document.getElementById('modal-vincular-celular-overlay');
    if (overlay) overlay.style.display = 'none';

    limpiarCanal();
    ultimaExtension = 0;
    intentosReconexion = 0;
    actualizarBotonBarra(null);
    bloquearBuscadorLocal(false);

    if (tokenActual) {
      // Best-effort — no bloquea el cierre del modal si falla.
      apiPost('/api/pos-scanner?accion=revocar', { token: tokenActual }).catch(() => {});
      tokenActual = null;
    }
    borrarDeStorage();

    document.getElementById('pos-input-producto')?.focus();
  }

  // Escape oculta (no desvincula) — mismo criterio que la X del modal,
  // distinto del resto de los modales del POS a propósito: acá cerrar la
  // ventana no debería significar "cortar el celular".
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('modal-vincular-celular-overlay');
    if (overlay && overlay.style.display !== 'none') ocultarModalVincularCelular();
  });

  // Nota: si el cajero cierra/recarga la pestaña con el vínculo abierto sin
  // tocar "Cerrar vínculo", no queda un canal Realtime huérfano (se cae solo
  // con la conexión del socket). Si nadie volvió a extenderlo, el token
  // expira solo en DURACION_MINUTOS desde el último uso — no hace falta un
  // revocar en beforeunload (y sendBeacon no podría llevar el header de
  // autenticación que ese endpoint requiere).
  //
  // Minimizar esta pestaña (la de la compu) NO corta nada acá a propósito:
  // el canal se queda suscripto igual, así que el vínculo se mantiene activo
  // aunque el cajero cambie de ventana. Ver portal.js para el manejo del
  // lado del celular, que sí necesita pausar la cámara al minimizar.

  // Se llama desde pos.js (usarTurno()) cada vez que se entra/vuelve a la
  // pantalla de venta de una caja — antes de eso tokenActual siempre
  // arranca en null porque es una carga de página nueva. Si hay un
  // vínculo guardado para ESTA caja y todavía no venció, se re-suscribe
  // al mismo canal sin mostrar el modal ni pedir un QR nuevo: el celular
  // nunca se enteró de que la compu había "recargado", así que sigue
  // mandando códigos al mismo canal igual. Se llama a extender (en vez de
  // solo confiar en el expira_at guardado) para: (a) confirmar contra el
  // server que nadie lo cerró desde otra pestaña mientras tanto, y
  // (b) empujar el vencimiento de nuevo, por si guardábamos una fecha ya
  // vieja de la última extensión.
  async function intentarResumirVinculoCelular(cajaId) {
    if (tokenActual) return; // ya hay uno vivo en esta misma carga de página
    const guardado = leerDeStorage();
    if (!guardado || !guardado.token) return;

    // Vínculo de otra caja (cambiaron de turno/caja): no corresponde acá.
    if (guardado.caja_id !== cajaId) { borrarDeStorage(); return; }

    if (!window.supabaseClient) return; // se reintentará la próxima vez que se abra el modal a mano

    try {
      const data = await apiPost('/api/pos-scanner?accion=extender', { token: guardado.token });
      tokenActual = guardado.token;
      programarExpiracion(data.expira_at);
      guardarEnStorage(cajaId, data.expira_at);

      // Reconstruye QR + link de fallback aunque el modal no esté abierto,
      // por si el cajero lo abre después a mirar el estado — si no, quedaría
      // vacío (nunca se generó de nuevo, es el mismo token de antes).
      const url = `${location.origin}/scan-pos?t=${encodeURIComponent(tokenActual)}`;
      const qrWrap = document.getElementById('vc-qr-canvas');
      if (qrWrap && window.QRCode) {
        qrWrap.innerHTML = '';
        // eslint-disable-next-line no-new
        new QRCode(qrWrap, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
      }
      const link = document.getElementById('vc-link-fallback');
      if (link) { link.href = url; link.textContent = url.replace(/^https?:\/\//, ''); }

      // Solo el botón de la barra, sin bloquear el buscador ni tocar el
      // modal (que ni siquiera está abierto acá) — se corrige a
      // 'conectado' solo si/cuando llega 'listo' o un código real.
      actualizarBotonBarra('pendiente');
      suscribirCanal(tokenActual);
    } catch (_err) {
      // 410 (ya no está activo) u otro error — no vale la pena insistir acá,
      // simplemente no queda nada que resumir.
      borrarDeStorage();
    }
  }

  window.abrirModalVincularCelular = abrirModalVincularCelular;
  window.ocultarModalVincularCelular = ocultarModalVincularCelular;
  window.desvincularCelular = desvincularCelular;
  window.intentarResumirVinculoCelular = intentarResumirVinculoCelular;
})();
