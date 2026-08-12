// frontend/scan-pos/portal.js
//
// v617 — página pública que abre el celular al escanear el QR de
// "Vincular celular" en el POS. Sin login: el token de la URL (?t=...)
// ya identifica caja/empresa (ver lib/handlers/pos-scanner.js).
//
// Lo único que hace esta página:
//   1. Valida el token contra /api/pos-scanner?accion=validar (para mostrar
//      un error claro si el vínculo ya venció o se cerró desde la caja,
//      en vez de abrir la cámara para nada).
//   2. Pide la cámara trasera y lee códigos de barra con @zxing/browser —
//      mismo motor que ya usa pos-scanner.js del lado de la compu.
//   3. Por cada código detectado, lo manda por un canal de Supabase
//      Realtime Broadcast cuyo nombre se deriva del token — el mismo canal
//      al que se suscribe pos-scanner-remoto.js en la compu. Esta página
//      NUNCA llama a nuestro backend por cada escaneo: el relay es
//      directo celular → compu vía Realtime.
//
// No se persiste nada acá (ni el token, ni los códigos escaneados).

(function () {
  'use strict';

  const COOLDOWN_MS = 1200;

  let token = null;
  let canal = null;
  let controls = null;
  let ultimoCodigo = null;
  let ultimoTs = 0;
  let flashTimer = null;
  let camaraLista = false;
  let canalListo = false;

  // La cámara puede arrancar todavía apuntando al monitor que muestra el QR
  // de vinculación (el celular acaba de escanearlo para llegar acá) — el
  // primer frame a veces vuelve a leer ESE mismo QR antes de que el cajero
  // reoriente la cámara hacia el producto. Si eso pasa, no hay que mandarlo:
  // no es un código de producto, es el propio link de esta página.
  const RE_LINK_PROPIO = /\/scan-pos(?:[/?]|$)/i;

  // v617 — el vínculo ya no es exclusivo del POS: la compu puede haberlo
  // generado desde "Vincular celular" (venta), "Escanear con celular" al
  // crear/editar un producto, o "Vincular celular" en el ajuste de stock.
  // El backend (ver handleValidar en lib/handlers/pos-scanner.js) resuelve
  // una `etiqueta` genérica (nombre de caja o de depósito, según
  // corresponda) — acá solo se le pone un título legible según el
  // `contexto`.
  const TITULOS_CONTEXTO = {
    pos: 'Caja',
    alta_producto: 'Alta de producto',
    ajuste_stock: 'Ajuste de stock',
  };

  function nombreCanal(t) {
    return `pos-scan-${t}`;
  }

  function armarBadge(data) {
    const base = TITULOS_CONTEXTO[data.contexto] || 'Vinculado';
    const detalle = data.etiqueta ? `${base}: ${data.etiqueta}` : base;
    return data.empresa ? `${detalle} — ${data.empresa}` : detalle;
  }

  function mostrarError(titulo, mensaje) {
    document.getElementById('scan-estado').style.display = 'none';
    document.getElementById('scan-camara').style.display = 'none';
    const errBox = document.getElementById('scan-error');
    document.getElementById('scan-error-tit').textContent = titulo;
    document.getElementById('scan-error-msg').textContent = mensaje;
    errBox.style.display = 'flex';
  }

  function mostrarErrorCamara(msg) {
    const el = document.getElementById('scan-camara-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = '';
  }

  async function init() {
    const params = new URLSearchParams(location.search);
    token = params.get('t');

    if (!token) {
      mostrarError('Link incompleto', 'Falta el código en el link. Volvé a escanear el QR desde la caja.');
      return;
    }

    let data;
    try {
      const res = await fetch(`/api/pos-scanner?accion=validar&t=${encodeURIComponent(token)}`);
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        mostrarError('No se pudo abrir', data.error || 'Este link no es válido.');
        return;
      }
    } catch (_e) {
      mostrarError('Sin conexión', 'No se pudo contactar al servidor. Revisá tu conexión e intentá de nuevo.');
      return;
    }

    document.getElementById('scan-estado').style.display = 'none';
    document.getElementById('scan-badge').textContent = armarBadge(data);
    document.getElementById('scan-camara').style.display = 'block';

    conectarCanal();
    await iniciarCamara();
  }

  function conectarCanal() {
    if (!window.supabase || !window.ENV?.SUPABASE_URL || !window.ENV?.SUPABASE_ANON_KEY) {
      mostrarErrorCamara('No se pudo iniciar el vínculo con la caja. Recargá la página.');
      return;
    }
    const sb = window.supabase.createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    canal = sb.channel(nombreCanal(token), { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'ping' }, () => avisarListoSiCorresponde())
      .subscribe((estado) => {
        if (estado === 'SUBSCRIBED') {
          canalListo = true;
          avisarListoSiCorresponde();
        }
      });
  }

  async function iniciarCamara() {
    const video = document.getElementById('scan-video');
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || !window.ZXingBrowser) {
      mostrarErrorCamara('Este navegador no soporta escanear con la cámara. Probá con Chrome o Safari actualizados.');
      return;
    }

    try {
      const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
      controls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        video,
        (result) => {
          if (!result) return;
          const codigo = result.getText();
          if (!codigo || RE_LINK_PROPIO.test(codigo)) return;

          const ahora = Date.now();
          if (codigo === ultimoCodigo && (ahora - ultimoTs) < COOLDOWN_MS) return;
          ultimoCodigo = codigo;
          ultimoTs = ahora;

          enviarCodigo(codigo);
        }
      );
      camaraLista = true;
      avisarListoSiCorresponde();
    } catch (e) {
      console.error('[scan-pos] no se pudo iniciar la cámara:', e);
      let msg = 'No se pudo iniciar la cámara.';
      if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
        msg = 'Se necesita permiso de cámara para escanear. Habilitalo en el navegador e intentá de nuevo.';
      } else if (e && e.name === 'NotFoundError') {
        msg = 'No se encontró ninguna cámara en este dispositivo.';
      } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        msg = 'El acceso a la cámara requiere una conexión segura (https).';
      }
      mostrarErrorCamara(msg);
    }
  }

  // Handshake explícito: recién cuando cámara Y canal están los dos listos
  // se avisa a la compu que el celular está conectado de verdad — separado
  // a propósito de "codigo" (que son productos escaneados). Antes esto se
  // inferría del primer código que llegaba, pero ese primer código muchas
  // veces era el reflejo del propio QR (ver RE_LINK_PROPIO más arriba), así
  // que ya no sirve como señal de conexión.
  // También se reusa como respuesta al 'ping' que manda la compu al
  // re-suscribirse (ver pos-scanner-remoto.js) — así, si la compu recarga
  // la página y resume un vínculo guardado, el celular puede confirmar que
  // sigue activo sin esperar a que alguien escanee algo.
  function avisarListoSiCorresponde() {
    if (!camaraLista || !canalListo || !canal) return;
    canal.send({ type: 'broadcast', event: 'listo', payload: {} })
      .catch((err) => console.error('[scan-pos] no se pudo avisar que el celular está listo:', err));
  }

  function enviarCodigo(codigo) {
    if (navigator.vibrate) navigator.vibrate(60);
    mostrarFlash(codigo);

    if (!canal) return;
    canal.send({ type: 'broadcast', event: 'codigo', payload: { codigo } })
      .catch((err) => console.error('[scan-pos] no se pudo mandar el código:', err));
  }

  function mostrarFlash(codigo) {
    const el = document.getElementById('scan-flash');
    if (!el) return;
    el.textContent = `Enviado: ${codigo}`;
    el.classList.add('visible');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('visible'), 900);
  }

  document.addEventListener('DOMContentLoaded', init);

  // ── Manejo de segundo plano ──────────────────────────────────────────
  // Al minimizar el navegador (cambiar de app, ir a WhatsApp, etc.), el
  // sistema operativo le corta la cámara a la pestaña — y en iOS a veces
  // hasta descarga la página de memoria mientras está oculta. No hay forma
  // de evitarlo desde acá, así que en vez de pelear contra eso, se detecta
  // y se reconecta solo (cámara + canal Realtime) apenas la pestaña vuelve
  // a estar visible. Antes esto se resolvía en 'pagehide' cortando todo
  // sin reconectar — quedaba el vínculo roto hasta recargar la página a mano.
  // Al volver de segundo plano, reconectar() primero re-valida el token
  // contra el backend (ver más abajo) antes de tocar cámara/canal — así
  // se distingue "estaba minimizado" (se reconecta solo) de "cerraron el
  // vínculo mientras estaba minimizado" (se avisa, no se reconecta).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pausar();
    } else if (token) {
      reconectar();
    }
  });

  function pausar() {
    camaraLista = false;
    if (controls) { try { controls.stop(); } catch (_e) {} controls = null; }
    const video = document.getElementById('scan-video');
    if (video && video.srcObject) {
      try { video.srcObject.getTracks().forEach((t) => t.stop()); } catch (_e) {}
      video.srcObject = null;
    }
  }

  async function reconectar() {
    // Antes de prender cámara y canal de nuevo, hay que confirmar que el
    // vínculo sigue vivo del lado de la compu — si se cerró (botón "Cerrar
    // vínculo", o expiró) mientras el celular estaba minimizado, reconectar
    // a ciegas dejaría al celular "escaneando al vacío" sin que el cajero
    // se entere. Reusa el mismo chequeo que hace init() al abrir la página.
    let data;
    try {
      const res = await fetch(`/api/pos-scanner?accion=validar&t=${encodeURIComponent(token)}`);
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        mostrarError('Vínculo cerrado', data.error || 'Este vínculo ya no está activo.');
        return;
      }
    } catch (_e) {
      // Sin conexión momentánea al volver del background — no es un cierre
      // real del vínculo, así que se reintenta con cámara+canal como venía
      // haciendo antes; si el vínculo de verdad está muerto, el próximo
      // código enviado simplemente no llega a ningún lado y no rompe nada.
    }

    if (data) document.getElementById('scan-badge').textContent = armarBadge(data);

    // Idempotente: no asume qué quedó vivo y qué no tras el segundo plano
    // (varía según el navegador) — limpia y vuelve a levantar todo.
    canalListo = false; // camaraLista ya la puso en false pausar()
    if (canal) { try { canal.unsubscribe(); } catch (_e) {} canal = null; }
    const errEl = document.getElementById('scan-camara-error');
    if (errEl) errEl.style.display = 'none';
    conectarCanal();
    await iniciarCamara();
  }

  // Cierre real de la pestaña (no backgrounding): ahí sí no tiene sentido
  // dejar nada colgado.
  window.addEventListener('pagehide', (e) => {
    if (e.persisted) return; // la página puede volver desde bfcache — no cortar el vínculo
    pausar();
    if (canal) { try { canal.unsubscribe(); } catch (_e) {} }
  });
})();
