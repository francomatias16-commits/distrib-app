// frontend/shared/vincular-celular.js
//
// v617 — Widget genérico de "Vincular celular" (el celular como lector
// remoto de código de barras) para pantallas que no son el POS. El POS
// tiene su propio modal en pos.html + frontend/admin/js/pos-scanner-remoto.js
// (ya existía antes y sigue funcionando igual); este widget es la versión
// reusable para las pantallas nuevas que se suman con el mismo circuito
// (alta/edición de producto, ajuste de stock) — así no hay que copiar el
// modal + la lógica de canal Realtime en cada pantalla nueva.
//
// Mismo protocolo que el POS contra /api/pos-scanner (ver CONTEXTOS en
// lib/handlers/pos-scanner.js): generar token → mostrar QR → suscribirse a
// un canal de Supabase Realtime Broadcast derivado del token → por cada
// código que llega, avisarle al caller (onCodigo) — este widget nunca
// interpreta el código, solo lo transporta.
//
// Uso:
//   window.VincularCelular.abrir({
//     contexto:  'ajuste_stock',       // ver CONTEXTOS en el handler
//     entidad_id: depositoId,          // null si el contexto no lo requiere
//     sb: window.authCtx.sb,           // cliente Supabase ya autenticado de la página
//     titulo: 'Ajuste de stock',       // encabezado del modal
//     onCodigo: (codigo) => { ... },   // se llama por cada código escaneado
//   });
//
// Un solo vínculo activo a la vez por página. Si se llama abrir() con un
// contexto/entidad distinto al que ya está vivo, el vínculo anterior se
// cierra solo antes de pedir uno nuevo (evita códigos de una sesión vieja
// llegando a un lugar que ya no corresponde).
//
// FIX (v625, "tengo que vincular el celular en cada escaneo de producto"):
// Cuando el celular dormía la pantalla o cambiaba de pestaña, camaraConectada
// pasaba a false pero el token seguía vivo. Al reabrir el modal, el widget
// mostraba el QR pasivamente — el usuario tenía que re-escanearlo a mano
// aunque el celular seguía en la URL del scanner y listo para reconectar.
//
// Fix: cuando abrir() detecta un token vivo pero camaraConectada=false,
// envía un "ping" inmediato al canal. El celular (portal.js) ya escucha
// ese evento y responde con "listo" — así la conexión se recupera sola en
// 1-2 segundos sin que el usuario haga nada. Si el celular no responde en
// PING_TIMEOUT_MS (el teléfono se fue de la pestaña o se desconectó de
// internet), recién ahí se genera un nuevo QR automáticamente — sin que el
// usuario tenga que "Cerrar vínculo" y volver a empezar.

(function () {
  'use strict';

  if (window.VincularCelular) return; // ya cargado (dos pantallas no deberían incluirlo dos veces, pero por las dudas)

  const EXTENDER_CADA_MS = 5 * 60_000;
  // v625: tiempo máximo esperando respuesta del ping antes de regenerar QR.
  // 6 segundos es suficiente para una latencia alta sin que el usuario note
  // una espera larga en la mayoría de los casos.
  const PING_TIMEOUT_MS = 6000;

  let overlay = null;
  let canal = null;
  let sbActual = null;
  let tokenActual = null;
  let claveActual = null; // `${contexto}:${entidad_id}` — identifica la sesión vigente
  let onCodigoCb = null;
  let expiraTimer = null;
  let reconexionTimer = null;
  let intentosReconexion = 0;
  let ultimaExtension = 0;
  let camaraConectada = false;
  // v625: timer del ping de reconexión automática
  let pingTimer = null;
  // v625: contexto/entidad del último abrir() — para poder regenerar el token
  let contextoActual = null;
  let entidadActual = null;

  const RE_LINK_PROPIO = /\/scan-pos(?:[/?]|$)/i;

  function nombreCanal(token) {
    return `pos-scan-${token}`;
  }

  function claveDe(contexto, entidad_id) {
    return `${contexto}:${entidad_id || ''}`;
  }

  function authHeader() {
    const token = window.authCtx?.session?.access_token || '';
    return { Authorization: `Bearer ${token}` };
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

  // ── Estilos + markup, inyectados una sola vez ─────────────────────────
  function inyectarEstilos() {
    if (document.getElementById('vc2-estilos')) return;
    const style = document.createElement('style');
    style.id = 'vc2-estilos';
    style.textContent = `
      .vc2-overlay { position:fixed; inset:0; background:rgba(22,24,29,.55); display:none;
        align-items:center; justify-content:center; z-index:1400; padding:16px; }
      .vc2-overlay.vc2-visible { display:flex; }
      .vc2-modal { background:var(--color-surface); border-radius:12px; width:100%; max-width:380px;
        box-shadow:0 20px 60px rgba(22,24,29,.25); overflow:hidden; }
      .vc2-header { display:flex; align-items:center; justify-content:space-between;
        padding:16px 20px; border-bottom:1px solid var(--color-border-soft); }
      .vc2-titulo { font-size:15px; font-weight:600; color:var(--color-text); margin:0; }
      .vc2-cerrar { background:none; border:none; cursor:pointer; color:var(--color-text-muted); padding:4px; border-radius:6px; }
      .vc2-cerrar:hover { background:var(--color-surface-2); }
      .vc2-body { padding:24px 20px; text-align:center; }
      .vc2-spinner { width:32px; height:32px; margin:0 auto 14px; border-radius:50%;
        border:3px solid var(--color-border); border-top-color:var(--color-primary); animation:vc2-girar .8s linear infinite; }
      @keyframes vc2-girar { to { transform:rotate(360deg); } }
      .vc2-qr { display:inline-block; padding:12px; background:var(--color-surface); border:1px solid var(--color-border-soft); border-radius:10px; margin-bottom:14px; }
      .vc2-esperando { font-size:13px; color:var(--color-text-muted); display:flex; align-items:center;
        justify-content:center; gap:6px; margin:0 0 6px; }
      .vc2-punto { width:7px; height:7px; border-radius:50%; background:var(--color-warning-mid); animation:vc2-parpadeo 1.2s ease-in-out infinite; }
      @keyframes vc2-parpadeo { 0%,100%{opacity:1} 50%{opacity:.25} }
      .vc2-nota { font-size:12px; color:var(--color-text-light); margin:0; line-height:1.5; }
      .vc2-nota a { color:var(--color-primary); word-break:break-all; }
      .vc2-check { width:44px; height:44px; margin:0 auto 12px; border-radius:50%; background:var(--color-success-bg);
        color:var(--color-success); display:flex; align-items:center; justify-content:center; }
      .vc2-titulo-estado { font-size:14px; font-weight:600; color:var(--color-text); margin:0 0 4px; }
      .vc2-ultimo-codigo { font-size:12px; color:var(--color-primary); margin:8px 0 0; font-family:monospace; }
      .vc2-error { font-size:13px; color:var(--color-danger); margin:12px 0 0; }
      .vc2-footer { display:flex; gap:8px; padding:14px 20px; border-top:1px solid var(--color-border-soft); }
      .vc2-btn { flex:1; font-size:13px; font-weight:600; padding:9px 12px; border-radius:8px;
        border:1px solid transparent; cursor:pointer; }
      .vc2-btn--sec { background:var(--color-surface-2); color:var(--color-text); }
      .vc2-btn--sec:hover { background:var(--color-border); }
      .vc2-btn--danger { background:var(--color-danger-bg); color:var(--color-danger); }
      .vc2-btn--danger:hover { background:color-mix(in srgb, var(--color-danger-bg) 92%, black); }
    `;
    document.head.appendChild(style);
  }

  function inyectarModal() {
    if (overlay) return;
    inyectarEstilos();
    overlay = document.createElement('div');
    overlay.className = 'vc2-overlay';
    overlay.innerHTML = `
      <div class="vc2-modal" role="dialog" aria-modal="true">
        <div class="vc2-header">
          <p class="vc2-titulo" id="vc2-titulo">Vincular celular</p>
          <button type="button" class="vc2-cerrar" id="vc2-btn-ocultar-x" title="Ocultar — el vínculo sigue activo">✕</button>
        </div>
        <div class="vc2-body">
          <div id="vc2-estado-generando">
            <div class="vc2-spinner"></div>
            <p class="vc2-nota">Generando vínculo…</p>
          </div>
          <div id="vc2-estado-qr" style="display:none">
            <div class="vc2-qr" id="vc2-qr-canvas"></div>
            <p class="vc2-esperando"><span class="vc2-punto"></span>Esperando que escanees el QR…</p>
            <p class="vc2-nota">Abrí la cámara del celular y apuntá al código. Si no podés escanearlo, entrá manualmente a
              <a id="vc2-link-fallback" href="#" target="_blank" rel="noopener"></a>.</p>
          </div>
          <div id="vc2-estado-reconectando" style="display:none">
            <div class="vc2-spinner"></div>
            <p class="vc2-nota">Reconectando con el celular…</p>
          </div>
          <div id="vc2-estado-conectado" style="display:none">
            <div class="vc2-check"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg></div>
            <p class="vc2-titulo-estado">Celular conectado</p>
            <p class="vc2-nota">Escaneá desde el teléfono — cada código se procesa solo, acá mismo.</p>
            <p class="vc2-ultimo-codigo" id="vc2-ultimo-codigo" style="display:none"></p>
          </div>
          <p class="vc2-error" id="vc2-error" style="display:none"></p>
        </div>
        <div class="vc2-footer">
          <button type="button" class="vc2-btn vc2-btn--sec" id="vc2-btn-ocultar">Ocultar</button>
          <button type="button" class="vc2-btn vc2-btn--danger" id="vc2-btn-desvincular">Cerrar vínculo</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#vc2-btn-ocultar-x').addEventListener('click', ocultar);
    overlay.querySelector('#vc2-btn-ocultar').addEventListener('click', ocultar);
    overlay.querySelector('#vc2-btn-desvincular').addEventListener('click', desvincular);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) ocultar(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('vc2-visible')) ocultar();
    });
  }

  function setEstado(estado) {
    ['generando', 'qr', 'reconectando', 'conectado'].forEach((e) => {
      const el = document.getElementById(`vc2-estado-${e}`);
      if (el) el.style.display = e === estado ? '' : 'none';
    });
  }

  function mostrarErrorVc(msg) {
    const el = document.getElementById('vc2-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  // ── v625: intentar reconexión automática cuando el celular está desconectado ──
  // Cuando el modal reabre con un token vivo pero camaraConectada=false:
  // 1. Muestra "Reconectando…" y manda ping al canal.
  // 2. Si el celular responde "listo" dentro de PING_TIMEOUT_MS → todo bien.
  // 3. Si no responde → genera un nuevo token y muestra QR fresco, sin
  //    necesidad de que el usuario toque "Cerrar vínculo" manualmente.
  function intentarReconexionAutomatica() {
    cancelarPingTimer();
    setEstado('reconectando');
    mostrarErrorVc(null);

    // Enviar ping — el celular (portal.js) ya escucha 'ping' y responde 'listo'.
    if (canal) {
      canal.send({ type: 'broadcast', event: 'ping', payload: {} }).catch(() => {});
    }

    // Si no hay respuesta en PING_TIMEOUT_MS, regenerar el QR automáticamente.
    pingTimer = setTimeout(async () => {
      pingTimer = null;
      if (camaraConectada) return; // el ping llegó mientras esperábamos
      // El celular no respondió — regenerar token y mostrar QR fresco.
      await regenerarToken();
    }, PING_TIMEOUT_MS);
  }

  function cancelarPingTimer() {
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
  }

  // Genera un token nuevo (revoca el anterior si sigue vivo) y muestra el QR.
  async function regenerarToken() {
    if (!contextoActual) return;
    // Revocar el token viejo si lo hay (best-effort).
    if (tokenActual) {
      apiPost('/api/pos-scanner?accion=revocar', { token: tokenActual }).catch(() => {});
      limpiarCanal();
      tokenActual = null;
    }
    mostrarErrorVc(null);
    setEstado('generando');
    try {
      const data = await apiPost('/api/pos-scanner?accion=generar', {
        contexto: contextoActual,
        entidad_id: entidadActual,
      });
      tokenActual = data.token;

      const qrWrap = document.getElementById('vc2-qr-canvas');
      if (qrWrap) {
        qrWrap.innerHTML = '';
        if (window.QRCode) {
          // eslint-disable-next-line no-new
          new QRCode(qrWrap, { text: data.url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
        }
      }
      const link = document.getElementById('vc2-link-fallback');
      if (link) {
        link.href = data.url;
        link.textContent = data.url.replace(/^https?:\/\//, '');
      }

      setEstado('qr');
      suscribirCanal(tokenActual);
      programarExpiracion(data.expira_at);
    } catch (err) {
      console.error('[vincular-celular] no se pudo regenerar el vínculo:', err);
      mostrarErrorVc(err?.error || 'No se pudo generar un vínculo nuevo. Probá de nuevo.');
    }
  }

  // ── API pública ────────────────────────────────────────────────────────

  async function abrir({ contexto, entidad_id = null, sb, titulo, onCodigo }) {
    if (!contexto) throw new Error('VincularCelular.abrir: falta contexto');
    if (!sb) throw new Error('VincularCelular.abrir: falta el cliente Supabase (sb)');

    inyectarModal();
    document.getElementById('vc2-titulo').textContent = titulo || 'Vincular celular';
    onCodigoCb = typeof onCodigo === 'function' ? onCodigo : null;
    sbActual = sb;

    // v625: guardar contexto/entidad para poder regenerar token si hace falta.
    contextoActual = contexto;
    entidadActual = entidad_id;

    const clave = claveDe(contexto, entidad_id);

    // Vínculo vivo con el mismo contexto/entidad: reabrir sin pedir un
    // token nuevo ni resetear el canal.
    if (tokenActual && claveActual === clave) {
      overlay.classList.add('vc2-visible');
      if (camaraConectada) {
        // El celular está activo — simplemente mostrar estado conectado.
        setEstado('conectado');
      } else {
        // v625: celular desconectado (durmió pantalla, cambió de pestaña).
        // En lugar de mostrar el QR viejo estáticamente, intentar reconexión
        // automática — si el celular sigue en la URL responderá el ping en
        // ~1 segundo; si no, se genera un QR nuevo en PING_TIMEOUT_MS.
        intentarReconexionAutomatica();
      }
      return;
    }

    // Vínculo vivo de otro contexto/entidad (p. ej. cambiaron el depósito
    // del filtro): cortarlo antes de pedir uno nuevo.
    if (tokenActual) desvincular({ silencioso: true });

    claveActual = clave;
    mostrarErrorVc(null);
    setEstado('generando');
    overlay.classList.add('vc2-visible');

    try {
      const data = await apiPost('/api/pos-scanner?accion=generar', { contexto, entidad_id });
      tokenActual = data.token;

      const qrWrap = document.getElementById('vc2-qr-canvas');
      qrWrap.innerHTML = '';
      if (window.QRCode) {
        // eslint-disable-next-line no-new
        new QRCode(qrWrap, { text: data.url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
      }
      const link = document.getElementById('vc2-link-fallback');
      link.href = data.url;
      link.textContent = data.url.replace(/^https?:\/\//, '');

      setEstado('qr');
      suscribirCanal(tokenActual);
      programarExpiracion(data.expira_at);
    } catch (err) {
      console.error('[vincular-celular] no se pudo generar el vínculo:', err);
      mostrarErrorVc(err?.error || 'No se pudo generar el vínculo con el celular. Probá de nuevo.');
      claveActual = null;
    }
  }

  function ocultar() {
    cancelarPingTimer(); // si estaba esperando ping, cancelar — el modal ya no está visible
    if (overlay) overlay.classList.remove('vc2-visible');
  }

  function desvincular({ silencioso = false } = {}) {
    cancelarPingTimer();
    if (overlay) overlay.classList.remove('vc2-visible');
    limpiarCanal();
    ultimaExtension = 0;
    intentosReconexion = 0;
    camaraConectada = false;

    // Best-effort en ambos casos — "silencioso" solo evita relanzar la UI
    // de error si falla, no cambia que haya que revocar en el server.
    if (tokenActual) {
      apiPost('/api/pos-scanner?accion=revocar', { token: tokenActual }).catch(() => {});
    }
    tokenActual = null;
    claveActual = null;
    contextoActual = null;
    entidadActual = null;
  }

  // ── Canal Realtime ────────────────────────────────────────────────────

  function suscribirCanal(token) {
    limpiarCanal({ mantenerToken: true });
    canal = sbActual
      .channel(nombreCanal(token), { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'listo' }, () => {
        // v625: cancelar el ping timer — el celular respondió, conexión restaurada.
        cancelarPingTimer();
        camaraConectada = true;
        setEstado('conectado');
        extenderVinculoSiCorresponde();
      })
      .on('broadcast', { event: 'codigo' }, ({ payload }) => {
        const codigo = payload?.codigo;
        if (!codigo || RE_LINK_PROPIO.test(codigo)) return;
        cancelarPingTimer();
        camaraConectada = true;
        setEstado('conectado');
        const el = document.getElementById('vc2-ultimo-codigo');
        if (el) { el.textContent = `Último código: ${codigo}`; el.style.display = ''; }
        if (navigator.vibrate) navigator.vibrate(80);
        extenderVinculoSiCorresponde();
        if (onCodigoCb) onCodigoCb(codigo);
      })
      .subscribe((estado) => {
        if (estado === 'SUBSCRIBED') {
          intentosReconexion = 0;
          // Mismo motivo que en pos-scanner-remoto.js: le pedimos al
          // celular que reconfirme que sigue conectado, en vez de esperar
          // pasivamente el 'listo' original (que en una reconexión ya no
          // vuelve a llegar).
          canal.send({ type: 'broadcast', event: 'ping', payload: {} }).catch(() => {});
          return;
        }
        if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT' || estado === 'CLOSED') {
          programarReconexion(token);
        }
      });
  }

  function programarReconexion(token) {
    if (!tokenActual || tokenActual !== token) return;
    if (reconexionTimer) return;
    const espera = Math.min(1000 * 2 ** intentosReconexion, 15_000);
    intentosReconexion += 1;
    reconexionTimer = setTimeout(() => {
      reconexionTimer = null;
      if (tokenActual === token) suscribirCanal(token);
    }, espera);
  }

  async function extenderVinculoSiCorresponde() {
    if (!tokenActual) return;
    const ahora = Date.now();
    if (ahora - ultimaExtension < EXTENDER_CADA_MS) return;
    ultimaExtension = ahora;
    try {
      const data = await apiPost('/api/pos-scanner?accion=extender', { token: tokenActual });
      programarExpiracion(data.expira_at);
    } catch (err) {
      console.warn('[vincular-celular] no se pudo renovar el vínculo:', err);
    }
  }

  function programarExpiracion(expiraAtIso) {
    if (expiraTimer) clearTimeout(expiraTimer);
    const ms = new Date(expiraAtIso).getTime() - Date.now();
    if (!(ms > 0)) return;
    expiraTimer = setTimeout(() => {
      cancelarPingTimer();
      if (overlay) overlay.classList.add('vc2-visible');
      mostrarErrorVc('El vínculo venció por inactividad. Cerrá y generá uno nuevo si necesitás seguir usando el celular.');
      limpiarCanal();
      tokenActual = null;
      claveActual = null;
      camaraConectada = false;
    }, ms);
  }

  function limpiarCanal({ mantenerToken = false } = {}) {
    if (canal) {
      try { sbActual?.removeChannel(canal); } catch (_e) {}
      canal = null;
    }
    if (reconexionTimer) { clearTimeout(reconexionTimer); reconexionTimer = null; }
    if (mantenerToken) return;
    if (expiraTimer) { clearTimeout(expiraTimer); expiraTimer = null; }
  }

  window.VincularCelular = { abrir, ocultar, desvincular };
})();
