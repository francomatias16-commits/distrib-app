/**
 * frontend/shared/chat-widget.js
 * Botón flotante del asistente de ayuda interno (RAG + tools sobre
 * docs/ayuda/*.md y datos en vivo, ver lib/handlers/asistente.js +
 * lib/asistente-providers.js + lib/asistente-tools.js).
 *
 * Se auto-monta al cargar: no requiere HTML previo, solo este <script> más
 * el <link rel="stylesheet" href="/frontend/shared/chat-widget.css">.
 *
 * Requiere que la página ya tenga cargados (igual que el resto del panel):
 *   - /frontend/env-config.js            (window.ENV.SUPABASE_URL / ANON_KEY)
 *   - https://cdn.jsdelivr.net/.../supabase.js  (window.supabase, el UMD)
 *
 * Reutiliza window.supabaseClient o window.authCtx.sb si ya existen (panel
 * admin/chofer, ver auth.js); si no, crea un cliente propio con el mismo
 * storageKey que usa el portal donde está montado (admin/cliente/chofer
 * namespacean su sesión por separado — ver comentario de
 * storageKeyDelPortal() más abajo), para seguir leyendo la sesión activa
 * de esa página sin pisar la de otro portal abierto en otra pestaña.
 *
 * Si no hay sesión activa (ej: login.html), el widget simplemente no se
 * muestra — no tiene sentido en pantallas públicas.
 */

(function () {
  'use strict';

  if (window.__chatAsistenteMontado) return; // evita doble montaje si el script se incluye 2 veces
  window.__chatAsistenteMontado = true;

  // API pública para que cualquier otro botón/link de la página (píldora
  // de la topbar, menciones "preguntale al asistente" dentro de una
  // sección, etc.) pueda abrir el panel sin conocer los detalles del
  // widget. iniciar() es async (espera la sesión), así que si se llama
  // antes de que termine de montar, queda pendiente y se resuelve sola
  // apenas abrirPanel() esté disponible (ver el final de iniciar() más
  // abajo). Si nunca llega a montarse (ej: sin sesión), no pasa nada.
  window.__asistenteAperturaPendiente = false;
  // Prefill opcional: si se llama a abrirAsistenteIA('¿Cómo funciona X?')
  // desde cualquier botón/card de la página, el panel se abre con esa
  // pregunta ya escrita en el input (el usuario la puede editar antes de
  // mandarla — no se auto-envía). Sin argumento, se comporta como antes.
  window.__asistentePrefillPendiente = null;
  window.abrirAsistenteIA = function (textoPrefill) {
    if (typeof window.__asistenteAbrirPanel === 'function') {
      window.__asistenteAbrirPanel(textoPrefill);
    } else {
      window.__asistenteAperturaPendiente = true;
      window.__asistentePrefillPendiente = textoPrefill || null;
    }
  };

  // Igual que MAX_LARGO_PREGUNTA en lib/handlers/asistente.js — antes 500,
  // pensado para una consulta corta. Se sube para poder pegar texto largo
  // (lista de stock, pedido dictado, remito copiado de un WhatsApp).
  const MAX_LARGO_PREGUNTA = 8000;

  // Mismos límites que IMAGEN_MIME_TYPES_PERMITIDOS / MAX_IMAGEN_BASE64_CHARS
  // en lib/handlers/asistente.js — se validan acá también para avisar al
  // toque en vez de esperar el rechazo del servidor.
  const IMAGEN_MIME_TYPES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_IMAGEN_BASE64_CHARS = 5_600_000;

  // Cada portal (admin/cliente/chofer) ahora persiste su sesión bajo un
  // storageKey propio (ver auth.js / login.html de cada portal) para que
  // abrir un portal ajeno en otra pestaña del mismo origen no pise la
  // sesión activa. Este cliente de fallback necesita el mismo storageKey
  // que la página donde vive, o dejaría de encontrar la sesión ahí.
  function storageKeyDelPortal() {
    const p = window.location.pathname;
    if (p.startsWith('/chofer'))  return 'sb-chofer-auth';
    if (p.startsWith('/cliente')) return 'sb-cliente-auth';
    return 'sb-admin-auth';
  }

  function obtenerClienteSupabase() {
    if (window.supabaseClient) return window.supabaseClient;
    if (window.authCtx?.sb) return window.authCtx.sb;
    if (!window.supabase || !window.ENV?.SUPABASE_URL || !window.ENV?.SUPABASE_ANON_KEY) return null;
    if (!window.__chatAsistenteSb) {
      window.__chatAsistenteSb = window.supabase.createClient(
        window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY,
        { auth: { storageKey: storageKeyDelPortal() } }
      );
    }
    return window.__chatAsistenteSb;
  }

  function crearDom() {
    const boton = document.createElement('button');
    boton.className = 'chat-asistente-boton';
    boton.type = 'button';
    boton.setAttribute('aria-label', 'Trabajar con el asistente de IA');
    boton.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
      '</svg>' +
      '<span class="chat-asistente-boton-label">Trabajar con IA</span>';

    const panel = document.createElement('div');
    panel.className = 'chat-asistente-panel';
    panel.innerHTML =
      '<div class="chat-asistente-header">' +
      '  <span>Asistente de ayuda</span>' +
      '  <div class="chat-asistente-header-acciones">' +
      '    <button type="button" class="chat-asistente-manoslibres" aria-label="Activar manos libres" aria-pressed="false" hidden>' +
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>' +
      '    </button>' +
      '    <button type="button" class="chat-asistente-cerrar" aria-label="Cerrar">&times;</button>' +
      '  </div>' +
      '</div>' +
      '<div class="chat-asistente-mensajes"></div>' +
      '<div class="chat-asistente-adjunto" hidden>' +
      '  <img class="chat-asistente-adjunto-miniatura" alt="Imagen adjunta" />' +
      '  <span class="chat-asistente-adjunto-nombre"></span>' +
      '  <button type="button" class="chat-asistente-adjunto-quitar" aria-label="Quitar imagen adjunta">&times;</button>' +
      '</div>' +
      '<form class="chat-asistente-form">' +
      '  <button type="button" class="chat-asistente-adjuntar" aria-label="Adjuntar imagen (foto o captura de un pedido/lista)">' +
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.19 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48"/></svg>' +
      '  </button>' +
      '  <input type="file" class="chat-asistente-adjuntar-input" accept="image/jpeg,image/png,image/webp" hidden />' +
      // textarea en vez de input de una línea: se puede pegar texto largo
      // (lista de stock, pedido dictado) y crece hasta un máximo (ver CSS).
      // Enter envía (como antes); Shift+Enter inserta un salto de línea
      // (ver el keydown que se agrega más abajo, junto al resto de los
      // listeners del form).
      '  <textarea class="chat-asistente-input" placeholder="Escribí tu consulta, pegá un texto largo o adjuntá una imagen..." maxlength="' + MAX_LARGO_PREGUNTA + '" rows="1"></textarea>' +
      '  <button type="button" class="chat-asistente-mic" aria-label="Dictar por voz" hidden>' +
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
      '  </button>' +
      '  <button type="submit" class="chat-asistente-enviar" aria-label="Enviar">' +
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
      '  </button>' +
      '</form>';

    document.body.appendChild(boton);
    document.body.appendChild(panel);
    return { boton, panel };
  }

  // accionPendiente: { id, resumen } (ver accion_pendiente en la respuesta
  // de /api/asistente, armado en lib/handlers/asistente.js a partir de una
  // tool con requiereConfirmacion:true — ver asistente-tools.js). Cuando
  // viene, la burbuja se dibuja con el tono de advertencia del sistema de
  // diseño y con botones Confirmar/Cancelar debajo (ver chat-widget.css).
  // onResolverAccion(id, confirmar) lo define iniciar() más abajo, donde sí
  // tiene a mano el cliente de supabase y el conversacionId de la sesión.
  function agregarMensaje(cont, { texto, propio, fuentes, accionPendiente, onResolverAccion, imagenPreviewUrl }) {
    const fila = document.createElement('div');
    fila.className = 'chat-asistente-mensaje' + (propio ? ' chat-asistente-mensaje--propio' : '');

    const burbuja = document.createElement('div');
    burbuja.className = 'chat-asistente-burbuja';

    // La imagen que el usuario adjuntó (si la hubo) se muestra arriba del
    // texto, dentro de la misma burbuja — solo aplica a mensajes propios
    // (ver imagenPreviewUrl en el submit handler de iniciar()).
    if (imagenPreviewUrl) {
      const miniatura = document.createElement('img');
      miniatura.className = 'chat-asistente-burbuja-imagen';
      miniatura.src = imagenPreviewUrl;
      miniatura.alt = 'Imagen adjunta';
      burbuja.appendChild(miniatura);
    }

    if (texto) {
      const textoEl = document.createElement('div');
      textoEl.textContent = texto; // textContent: nunca inyectamos HTML de la respuesta del modelo
      burbuja.appendChild(textoEl);
    }

    fila.appendChild(burbuja);

    if (fuentes && fuentes.length) {
      const fuentesEl = document.createElement('div');
      fuentesEl.className = 'chat-asistente-fuentes';
      fuentesEl.textContent = 'Fuente: ' + fuentes.map((f) => f.titulo).join(', ');
      fila.appendChild(fuentesEl);
    }

    if (accionPendiente && accionPendiente.id && typeof onResolverAccion === 'function') {
      burbuja.classList.add('chat-asistente-burbuja--confirmacion');

      const acciones = document.createElement('div');
      acciones.className = 'chat-asistente-confirmacion-acciones';

      const btnConfirmar = document.createElement('button');
      btnConfirmar.type = 'button';
      btnConfirmar.className = 'chat-asistente-confirmar';
      btnConfirmar.textContent = 'Confirmar';

      const btnCancelar = document.createElement('button');
      btnCancelar.type = 'button';
      btnCancelar.className = 'chat-asistente-cancelar';
      btnCancelar.textContent = 'Cancelar';

      const resolver = async (confirmar) => {
        // Se deshabilitan los dos (no solo el clickeado) para que un doble
        // click no dispare dos requests — el backend igual lo protegería
        // con el UPDATE atómico de resolverAccionPendiente(), pero evita
        // el request de más.
        btnConfirmar.disabled = true;
        btnCancelar.disabled = true;
        try {
          await onResolverAccion(accionPendiente.id, confirmar);
        } finally {
          acciones.remove(); // ya se resolvió (o se mostró su propio error abajo): no dejar botones reusables
        }
      };

      btnConfirmar.addEventListener('click', () => resolver(true));
      btnCancelar.addEventListener('click', () => resolver(false));

      acciones.appendChild(btnConfirmar);
      acciones.appendChild(btnCancelar);
      fila.appendChild(acciones);
    }

    cont.appendChild(fila);
    cont.scrollTop = cont.scrollHeight;
    return fila;
  }

  function agregarTyping(cont) {
    const fila = document.createElement('div');
    fila.className = 'chat-asistente-mensaje chat-asistente-mensaje--typing';
    fila.innerHTML = '<div class="chat-asistente-burbuja chat-asistente-typing"><span></span><span></span><span></span></div>';
    cont.appendChild(fila);
    cont.scrollTop = cont.scrollHeight;
    return fila;
  }

  async function enviarPregunta(sb, pregunta, conversacionId, adjunto) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw Object.assign(new Error('Tu sesión expiró. Recargá la página e iniciá sesión de nuevo.'), { code: 'sin_sesion' });

    const reqBody = { pregunta };
    if (conversacionId) reqBody.conversacion_id = conversacionId;
    // adjunto: { mimeType, base64 } — ver mostrarAdjunto()/procesarArchivoImagen()
    // en iniciar(). Nombres de campo iguales a los que espera el handler
    // (imagen_base64/imagen_mime_type, ver lib/handlers/asistente.js).
    if (adjunto) {
      reqBody.imagen_base64 = adjunto.base64;
      reqBody.imagen_mime_type = adjunto.mimeType;
    }

    const resp = await fetch('/api/asistente', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
      },
      body: JSON.stringify(reqBody),
    });

    let body = null;
    try { body = await resp.json(); } catch (e) { /* respuesta no-JSON, se maneja abajo */ }

    if (!resp.ok) {
      const msg = body?.error || ('Error ' + resp.status + ' al consultar el asistente.');
      throw Object.assign(new Error(msg), { status: resp.status });
    }

    return body;
  }

  // Resuelve (confirma o cancela) una acción de escritura que el asistente
  // había dejado pendiente — ver accion_pendiente en la respuesta de
  // enviarPregunta() y resolverAccionPendiente() en lib/asistente-tools.js.
  // Mismo endpoint que enviarPregunta, pero body distinto: la presencia de
  // accion_pendiente_id es lo que el handler usa para distinguir esta rama.
  async function confirmarAccionPendiente(sb, accionPendienteId, conversacionId, confirmar) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw Object.assign(new Error('Tu sesión expiró. Recargá la página e iniciá sesión de nuevo.'), { code: 'sin_sesion' });

    const resp = await fetch('/api/asistente', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({
        accion_pendiente_id: accionPendienteId,
        conversacion_id: conversacionId,
        confirmar,
      }),
    });

    let body = null;
    try { body = await resp.json(); } catch (e) { /* respuesta no-JSON, se maneja abajo */ }

    if (!resp.ok) {
      const msg = body?.error || ('Error ' + resp.status + ' al confirmar la acción.');
      throw Object.assign(new Error(msg), { status: resp.status });
    }

    return body;
  }

  async function iniciar() {
    const sb = obtenerClienteSupabase();
    if (!sb) return; // página sin supabase-js/env-config cargado (ej: landing pública)

    const { data: { session } } = await sb.auth.getSession();
    if (!session) return; // páginas de login/públicas: no mostrar el widget

    const { boton, panel } = crearDom();
    const cont = panel.querySelector('.chat-asistente-mensajes');
    const form = panel.querySelector('.chat-asistente-form');
    const input = panel.querySelector('.chat-asistente-input');
    const btnCerrar = panel.querySelector('.chat-asistente-cerrar');
    const btnEnviar = panel.querySelector('.chat-asistente-enviar');
    const btnMic = panel.querySelector('.chat-asistente-mic');
    const btnManosLibres = panel.querySelector('.chat-asistente-manoslibres');
    const btnAdjuntar = panel.querySelector('.chat-asistente-adjuntar');
    const inputArchivo = panel.querySelector('.chat-asistente-adjuntar-input');
    const cajaAdjunto = panel.querySelector('.chat-asistente-adjunto');
    const miniaturaAdjunto = panel.querySelector('.chat-asistente-adjunto-miniatura');
    const nombreAdjunto = panel.querySelector('.chat-asistente-adjunto-nombre');
    const btnQuitarAdjunto = panel.querySelector('.chat-asistente-adjunto-quitar');

    let abierto = false;
    let enviando = false;
    let saludoMostrado = false;
    // Imagen elegida/pegada, pendiente de mandar en el próximo submit:
    // { mimeType, base64 (sin el prefijo data:...;base64,), previewUrl }.
    // Se limpia al enviar o al tocar la "x" del chip.
    let adjuntoPendiente = null;

    function limpiarAdjunto() {
      if (adjuntoPendiente?.previewUrl) URL.revokeObjectURL(adjuntoPendiente.previewUrl);
      adjuntoPendiente = null;
      cajaAdjunto.hidden = true;
      miniaturaAdjunto.src = '';
      nombreAdjunto.textContent = '';
      inputArchivo.value = '';
    }

    function mostrarAdjunto(archivo, base64) {
      if (adjuntoPendiente?.previewUrl) URL.revokeObjectURL(adjuntoPendiente.previewUrl);
      const previewUrl = URL.createObjectURL(archivo);
      adjuntoPendiente = { mimeType: archivo.type, base64, previewUrl };
      miniaturaAdjunto.src = previewUrl;
      nombreAdjunto.textContent = archivo.name || 'Imagen adjunta';
      cajaAdjunto.hidden = false;
    }

    // Valida tipo/tamaño (mismos límites que el backend, ver constantes al
    // inicio del archivo) y arma el base64 sin el prefijo data:... — lo que
    // espera lib/handlers/asistente.js en imagen_base64.
    function procesarArchivoImagen(archivo) {
      if (!archivo) return;
      if (IMAGEN_MIME_TYPES_PERMITIDOS.indexOf(archivo.type) === -1) {
        agregarMensaje(cont, { texto: 'Ese tipo de imagen no está soportado. Usá JPG, PNG o WEBP.', propio: false });
        return;
      }
      const lector = new FileReader();
      lector.onload = () => {
        const resultado = String(lector.result || '');
        const base64 = resultado.slice(resultado.indexOf(',') + 1);
        if (base64.length > MAX_IMAGEN_BASE64_CHARS) {
          agregarMensaje(cont, { texto: 'La imagen es demasiado pesada. Probá con una más chica o comprimida.', propio: false });
          return;
        }
        mostrarAdjunto(archivo, base64);
      };
      lector.onerror = () => {
        agregarMensaje(cont, { texto: 'No se pudo leer la imagen. Probá de nuevo.', propio: false });
      };
      lector.readAsDataURL(archivo);
    }
    // Vive solo en memoria de esta pestaña: al recargar la página se
    // arranca una charla nueva (server igual la reabriría sola pasadas
    // 24hs de inactividad, ver CONVERSACION_MAX_INACTIVIDAD_MS en el handler).
    let conversacionId = null;

    function abrirPanel(textoPrefill) {
      abierto = true;
      panel.classList.add('chat-asistente-panel--abierto');
      boton.classList.add('chat-asistente-boton--activo');
      if (!saludoMostrado) {
        saludoMostrado = true;
        agregarMensaje(cont, { texto: '¡Hola! Preguntame lo que necesites sobre el sistema — POS, pedidos, cobranzas, stock, lo que sea.', propio: false });
      }
      // input se declara más abajo en esta misma función (iniciar()), pero
      // como abrirPanel también es una function declaration, ambas quedan
      // hoisteadas al mismo scope — para cuando esto se ejecuta (click del
      // usuario) input ya existe sin importar el orden de lectura del archivo.
      if (textoPrefill) {
        input.value = textoPrefill;
        autoAjustarAltoInput();
      }
      setTimeout(() => input.focus(), 50);
    }

    // A partir de acá, window.abrirAsistenteIA(texto?) de cualquier parte
    // de la página abre este panel, opcionalmente con una pregunta
    // pre-cargada. Si alguien llamó a abrirAsistenteIA() antes de que
    // termináramos de montar (ej: click muy rápido apenas cargó la
    // página), se resuelve ahora mismo con el prefill que haya quedado
    // pendiente.
    window.__asistenteAbrirPanel = abrirPanel;
    if (window.__asistenteAperturaPendiente) {
      window.__asistenteAperturaPendiente = false;
      abrirPanel(window.__asistentePrefillPendiente);
      window.__asistentePrefillPendiente = null;
    }

    function cerrarPanel() {
      abierto = false;
      panel.classList.remove('chat-asistente-panel--abierto');
      boton.classList.remove('chat-asistente-boton--activo');
      detenerDictado();
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      confirmacionPendienteVoz = null;
    }

    // Se llama desde el click de Confirmar/Cancelar dibujado por
    // agregarMensaje() sobre una burbuja con accionPendiente. Muestra su
    // propio "escribiendo..." mientras se resuelve (la ejecución real —
    // ej. anular una venta — puede tardar un instante) y agrega la
    // respuesta del backend como un mensaje normal del asistente.
    async function resolverAccionPendiente(accionPendienteId, confirmar) {
      const typingEl = agregarTyping(cont);
      try {
        const data = await confirmarAccionPendiente(sb, accionPendienteId, conversacionId, confirmar);
        conversacionId = data.conversacion_id || conversacionId;
        typingEl.remove();
        procesarRespuestaAsistente(data);
      } catch (err) {
        typingEl.remove();
        const msg = err.message || 'No pude procesar la confirmación en este momento.';
        agregarMensaje(cont, { texto: msg, propio: false });
        if (manosLibres) hablar(msg, reescucharSiCorresponde);
      }
    }

    // --- Voz: dictado (entrada) + lectura (salida) -------------------
    // Dictado: Web Speech API para reconocimiento. No todos los navegadores
    // lo soportan (ej: Firefox de escritorio no trae reconocimiento
    // nativo), así que el botón arranca oculto (ver hidden en crearDom())
    // y solo se muestra si el navegador realmente lo tiene disponible.
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Lectura: SpeechSynthesis, soportada en casi todos los navegadores
    // modernos (Chrome/Edge/Safari, incluidos los de celular — que es el
    // caso de uso real acá: caminando por la calle con el teléfono).
    const ttsDisponible = 'speechSynthesis' in window;

    let reconocimiento = null;
    let grabando = false;
    let manosLibres = false;
    // Cuánto silencio real hace falta para asumir que terminaste de
    // hablar y cortar/enviar solo. Pedido explícito: al menos 5-6s, para
    // no cortar a mitad de una idea por una pausa para pensar.
    const ESPERA_SILENCIO_MS = 5500;
    let timeoutSilencio = null;
    // Se pone en true justo antes de cortar el dictado "desde afuera"
    // (cerrar el panel, apagar manos libres) para que el 'end' que eso
    // dispara no interprete el corte como "terminé de hablar, mandalo".
    let descartarSiguienteFinal = false;
    // Cuando el asistente propuso una acción que escribe datos (crear
    // pedido, anular algo, etc.) y estamos en manos libres, en vez de
    // obligar a tocar Confirmar/Cancelar en pantalla, se puede resolver
    // diciendo esas mismas palabras en voz alta. Este objeto guarda el id
    // de esa acción mientras se espera la respuesta hablada; null el resto
    // del tiempo (flujo normal de pregunta/respuesta).
    let confirmacionPendienteVoz = null;
    let reintentosConfirmacionVoz = 0;
    const MAX_REINTENTOS_CONFIRMACION_VOZ = 2;

    function detenerDictado() {
      clearTimeout(timeoutSilencio);
      if (reconocimiento && grabando) {
        descartarSiguienteFinal = true;
        reconocimiento.stop(); // dispara onend, que hace la limpieza visual (sin enviar nada)
      }
    }

    function normalizarTexto(s) {
      return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    }

    // Lee un texto en voz alta. cb() se llama siempre al terminar (incluso
    // si tts no está disponible o falla), para poder encadenar "y ahora
    // volvé a escuchar" sin duplicar esa lógica en cada llamado.
    function hablar(texto, cb) {
      if (!ttsDisponible) { if (cb) cb(); return; }
      window.speechSynthesis.cancel(); // corta cualquier lectura anterior que siguiera sonando
      const utterance = new SpeechSynthesisUtterance(texto);
      utterance.lang = 'es-AR';
      const voces = window.speechSynthesis.getVoices();
      const vozEs = voces.find((v) => v.lang === 'es-AR') || voces.find((v) => v.lang && v.lang.startsWith('es'));
      if (vozEs) utterance.voice = vozEs;
      let terminado = false;
      const finalizar = () => { if (!terminado) { terminado = true; if (cb) cb(); } };
      utterance.addEventListener('end', finalizar);
      utterance.addEventListener('error', finalizar);
      window.speechSynthesis.speak(utterance);
    }

    function reescucharSiCorresponde() {
      if (manosLibres && SpeechRecognitionCtor && abierto && !grabando) {
        input.value = '';
        try { reconocimiento.start(); } catch (e) { /* ya arrancada o el panel se cerró justo ahora */ }
      }
    }

    function desactivarManosLibres() {
      manosLibres = false;
      confirmacionPendienteVoz = null;
      reintentosConfirmacionVoz = 0;
      if (btnManosLibres) {
        btnManosLibres.classList.remove('chat-asistente-manoslibres--activo');
        btnManosLibres.setAttribute('aria-pressed', 'false');
        btnManosLibres.setAttribute('aria-label', 'Activar manos libres');
      }
      window.speechSynthesis && window.speechSynthesis.cancel();
    }

    // Punto único donde se muestra Y (si corresponde) se lee en voz alta
    // cualquier respuesta del asistente — tanto la de una pregunta nueva
    // como la que sigue a resolver una acción pendiente. Si la respuesta
    // trae una acción pendiente y estamos en manos libres, en vez de solo
    // re-escuchar la próxima pregunta, queda esperando "confirmar" o
    // "cancelar" dicho en voz alta (los botones en pantalla siguen
    // funcionando igual, por si preferís tocarlos).
    function procesarRespuestaAsistente(data) {
      agregarMensaje(cont, {
        texto: data.respuesta,
        propio: false,
        fuentes: data.articulos_consultados,
        accionPendiente: data.accion_pendiente,
        onResolverAccion: resolverAccionPendiente,
      });

      if (!manosLibres) return;

      const accion = data.accion_pendiente;
      if (accion && accion.id) {
        reintentosConfirmacionVoz = 0;
        hablar(data.respuesta + '. Decí "confirmar" para continuar, o "cancelar" para no hacerlo.', () => {
          confirmacionPendienteVoz = { id: accion.id };
          reescucharSiCorresponde();
        });
      } else {
        hablar(data.respuesta, reescucharSiCorresponde);
      }
    }

    function manejarRespuestaConfirmacionVoz(dicho) {
      const pendiente = confirmacionPendienteVoz;
      if (!pendiente) return;
      const texto = normalizarTexto(dicho);
      const dijoConfirmar = /\bconfirmar\b/.test(texto);
      const dijoCancelar = /\bcancelar\b/.test(texto);

      if (dijoConfirmar && !dijoCancelar) {
        confirmacionPendienteVoz = null;
        reintentosConfirmacionVoz = 0;
        resolverAccionPendiente(pendiente.id, true);
        return;
      }
      if (dijoCancelar && !dijoConfirmar) {
        confirmacionPendienteVoz = null;
        reintentosConfirmacionVoz = 0;
        resolverAccionPendiente(pendiente.id, false);
        return;
      }

      // No se entendió con claridad: reintenta un par de veces y si sigue
      // sin quedar claro, deja de insistir por voz — la burbuja con los
      // botones Confirmar/Cancelar sigue ahí esperando un toque.
      reintentosConfirmacionVoz++;
      if (reintentosConfirmacionVoz > MAX_REINTENTOS_CONFIRMACION_VOZ) {
        confirmacionPendienteVoz = null;
        reintentosConfirmacionVoz = 0;
        hablar('No quedó claro. Podés confirmar o cancelar tocando los botones en la pantalla.', reescucharSiCorresponde);
        return;
      }
      hablar('No te escuché bien. Decí "confirmar" para continuar, o "cancelar" para no hacerlo.', () => {
        if (manosLibres && SpeechRecognitionCtor) { input.value = ''; try { reconocimiento.start(); } catch (e) {} }
      });
    }

    if (SpeechRecognitionCtor) {
      btnMic.hidden = false;
      reconocimiento = new SpeechRecognitionCtor();
      reconocimiento.lang = 'es-AR';
      // continuous:true — sigue escuchando durante pausas cortas (pensar
      // la frase, respirar) en vez de cortar apenas detecta el primer
      // silencio. El corte real lo maneja ESPERA_SILENCIO_MS más abajo.
      reconocimiento.continuous = true;
      reconocimiento.interimResults = true;
      reconocimiento.maxAlternatives = 1;

      reconocimiento.addEventListener('start', () => {
        grabando = true;
        btnMic.classList.add('chat-asistente-mic--grabando');
        btnMic.setAttribute('aria-label', 'Detener dictado');
        input.placeholder = confirmacionPendienteVoz ? 'Escuchando: decí confirmar o cancelar...' : 'Escuchando...';
      });

      reconocimiento.addEventListener('result', (ev) => {
        // Reconstruye la transcripción completa acumulando todo lo que ya
        // llegó (final e interino) desde el arranque de esta grabación,
        // así el input muestra el texto completo y no solo el último tramo.
        let transcripcion = '';
        for (let i = 0; i < ev.results.length; i++) {
          transcripcion += ev.results[i][0].transcript;
        }
        input.value = transcripcion.trim().slice(0, MAX_LARGO_PREGUNTA);

        // No cortamos apenas el navegador marca un tramo como "final": eso
        // pasa con cualquier pausa breve (respirar, pensar la frase) y
        // cortaba a la gente a mitad de la idea. En cambio, reiniciamos
        // esta cuenta regresiva cada vez que llega actividad nueva —
        // recién si pasan ESPERA_SILENCIO_MS sin más resultados asumimos
        // que terminaste de hablar y ahí se corta y se envía solo.
        clearTimeout(timeoutSilencio);
        timeoutSilencio = setTimeout(() => {
          if (grabando) reconocimiento.stop();
        }, ESPERA_SILENCIO_MS);
      });

      reconocimiento.addEventListener('error', (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          agregarMensaje(cont, { texto: 'No tengo permiso para usar el micrófono. Habilitalo en la configuración del navegador para dictar por voz.', propio: false });
          desactivarManosLibres();
        } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
          // 'no-speech' y 'aborted' no necesitan mensaje propio: el 'end'
          // que dispara justo después ya resuelve qué hacer (o no hacer
          // nada, si no se llegó a transcribir una palabra).
          agregarMensaje(cont, { texto: 'No pude escuchar bien. Probá de nuevo o escribí tu consulta.', propio: false });
        }
      });

      // Punto único de cierre de una grabación, sin importar el motivo:
      // se cumplieron los ESPERA_SILENCIO_MS de silencio, tocaste el mic
      // de nuevo para cortar antes, tocaste enviar mientras dictabas, o el
      // navegador cortó solo (ej: límite interno de duración).
      reconocimiento.addEventListener('end', () => {
        clearTimeout(timeoutSilencio);
        grabando = false;
        btnMic.classList.remove('chat-asistente-mic--grabando');
        btnMic.setAttribute('aria-label', 'Dictar por voz');
        input.placeholder = 'Escribí tu consulta...';

        if (descartarSiguienteFinal) {
          descartarSiguienteFinal = false;
          return; // corte "desde afuera" (cerrar panel / apagar manos libres): no se envía nada
        }

        const dicho = input.value.trim();
        if (confirmacionPendienteVoz) {
          // '' cuenta como "no te escuché", dispara el reintento/aviso
          // correspondiente en vez de quedarse sin hacer nada.
          manejarRespuestaConfirmacionVoz(dicho);
          return;
        }
        if (dicho) {
          // Se envía sola, como pediste: la respuesta ya viene protegida
          // por la confirmación explícita para cualquier acción que
          // escriba datos (ver accion_pendiente / resolverAccionPendiente).
          form.requestSubmit();
        }
      });

      btnMic.addEventListener('click', () => {
        if (grabando) {
          reconocimiento.stop(); // corta ya, sin esperar el silencio — tu forma de "confirmar enviar" con el mic
          return;
        }
        window.speechSynthesis && window.speechSynthesis.cancel(); // "barge-in": tocar el mic corta la lectura en curso
        input.value = '';
        try {
          reconocimiento.start();
        } catch (e) {
          // start() puede tirar si se llama dos veces seguidas muy rápido
          // (doble click); no hay nada que mostrarle al usuario por esto.
        }
      });
    }

    if (ttsDisponible && btnManosLibres) {
      btnManosLibres.hidden = false;
      btnManosLibres.addEventListener('click', () => {
        if (manosLibres) {
          desactivarManosLibres();
          detenerDictado();
          return;
        }
        manosLibres = true;
        btnManosLibres.classList.add('chat-asistente-manoslibres--activo');
        btnManosLibres.setAttribute('aria-pressed', 'true');
        btnManosLibres.setAttribute('aria-label', 'Desactivar manos libres');
        const explicacion = SpeechRecognitionCtor
          ? 'Modo manos libres activado. Te leo las respuestas y vuelvo a escuchar sola después de cada una. Para confirmar una acción, decí "confirmar" o "cancelar".'
          : 'Modo manos libres activado. Te leo las respuestas en voz alta (este navegador no tiene reconocimiento de voz, así que seguís escribiendo o dictando con el botón del micrófono si aparece).';
        hablar(explicacion, reescucharSiCorresponde);
      });
    }

    boton.addEventListener('click', () => (abierto ? cerrarPanel() : abrirPanel()));
    btnCerrar.addEventListener('click', cerrarPanel);

    // ── Adjuntar imagen: botón (abre el selector de archivos) ──────────
    btnAdjuntar.addEventListener('click', () => inputArchivo.click());
    inputArchivo.addEventListener('change', () => procesarArchivoImagen(inputArchivo.files?.[0]));
    btnQuitarAdjunto.addEventListener('click', limpiarAdjunto);

    // ── Pegar imagen (Ctrl+V de una captura, ej. de WhatsApp Web) ───────
    input.addEventListener('paste', (ev) => {
      const items = ev.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          ev.preventDefault(); // no pegar el archivo como texto/binario en el textarea
          procesarArchivoImagen(item.getAsFile());
          break;
        }
      }
    });

    // ── Textarea auto-expandible + Enter envía / Shift+Enter salto de línea ──
    const ALTO_MAX_INPUT_PX = 120;
    function autoAjustarAltoInput() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, ALTO_MAX_INPUT_PX) + 'px';
    }
    input.addEventListener('input', autoAjustarAltoInput);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();

      if (grabando) {
        // Tocaste enviar mientras seguías dictando: es tu forma explícita
        // de decir "ya terminé, mandalo" sin esperar los 5-6s de silencio.
        // reconocimiento.stop() dispara 'end', que toma lo transcrito
        // hasta ahora y llama a form.requestSubmit() por su cuenta.
        reconocimiento.stop();
        return;
      }

      const pregunta = input.value.trim();
      const adjunto = adjuntoPendiente; // se guarda antes de limpiar el estado
      // Ahora se puede enviar solo con una imagen (sin texto) — antes
      // hacía falta sí o sí una pregunta.
      if ((!pregunta && !adjunto) || enviando) return;

      enviando = true;
      btnEnviar.disabled = true;
      if (btnMic) btnMic.disabled = true;
      input.value = '';
      autoAjustarAltoInput(); // vuelve el textarea a su alto mínimo
      // No se usa limpiarAdjunto() acá: esa función revoca el previewUrl,
      // y todavía lo necesitamos para la miniatura de la burbuja propia
      // que se agrega a continuación. Solo se resetea el chip/estado.
      adjuntoPendiente = null;
      cajaAdjunto.hidden = true;
      miniaturaAdjunto.src = '';
      nombreAdjunto.textContent = '';
      inputArchivo.value = '';
      agregarMensaje(cont, {
        texto: pregunta || '(imagen adjunta)',
        propio: true,
        imagenPreviewUrl: adjunto?.previewUrl,
      });
      const typingEl = agregarTyping(cont);

      try {
        const data = await enviarPregunta(sb, pregunta, conversacionId, adjunto);
        conversacionId = data.conversacion_id || conversacionId;
        typingEl.remove();
        procesarRespuestaAsistente(data);
      } catch (err) {
        typingEl.remove();
        const msg = err.message || 'No pude responder en este momento. Probá de nuevo en unos segundos.';
        agregarMensaje(cont, { texto: msg, propio: false });
        if (manosLibres) hablar(msg, reescucharSiCorresponde);
      } finally {
        enviando = false;
        btnEnviar.disabled = false;
        if (btnMic) btnMic.disabled = false;
        input.focus();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
