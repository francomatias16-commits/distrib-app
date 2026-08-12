// frontend/admin/js/productos-scanner-remoto.js
//
// v617 — "Escanear con celular" en el formulario de alta/edición de
// producto. Usa el widget genérico (frontend/shared/vincular-celular.js)
// con contexto `alta_producto` (sin entidad — ver CONTEXTOS en
// lib/handlers/pos-scanner.js: crear/editar productos no está atado a una
// caja ni a un depósito puntual).
//
// v619: usa ocultar() en lugar de desvincular() — el celular sigue
// activo entre escaneos, no hay que re-vincular para cada producto.
//
// v622: las consultas externas se movieron al servidor (banco-codigos.js);
// este archivo solo llama a /api/banco-codigos y ya no sale directamente
// a Open Food Facts ni Mercado Libre.
//
// v625b — "Imagen incorrecta" / fix imagen por ML:
// Se agrega un botón "Imagen incorrecta — intentar otra".
//
// v626 — Fix definitivo botón + refresco (dos bugs):
//   BUG 1 (botón invisible): botón insertado dentro de fp-foto-preview-wrap
//   (overflow:hidden 84×84px). Fix: insertAdjacentElement('afterend').
//   BUG 2 (refresco bloqueado): setFotoProductoDesdeUrl tiene un guard que
//   bloqueaba silenciosamente si fotoProductoFile ya estaba seteado.
//   Fix: window.forzarFotoProductoDesdeUrl() en productos.js v626.
//
// v628 — Escaneo directo con la cámara del dispositivo actual (celular O
// computadora con webcam), como alternativa más rápida a "Vincular celular"
// (que exige un segundo dispositivo). Usa frontend/shared/camera-scanner.js
// (ZXing sobre getUserMedia) y reutiliza tal cual el mismo onCodigoEscaneado
// que ya dispara la búsqueda en el banco de códigos — así el circuito de
// autocompletado de nombre/foto es idéntico venga el código de la cámara
// local o del celular vinculado.
//
// v627 — "Multi-candidata infalible" para casos difíciles:
//
//   PROBLEMA RAÍZ que v626 no resolvía: refrescar ejecuta la misma búsqueda
//   Serper con el mismo código → obtiene los mismos resultados → devuelve la
//   misma imagen incorrecta. El usuario queda en un loop.
//
//   SOLUCIÓN:
//     - El endpoint refrescar ahora acepta urls_rechazadas[] y los filtra de
//       los resultados Serper, GARANTIZANDO que la respuesta sea siempre
//       diferente a lo que el usuario ya vio.
//     - El endpoint devuelve candidatas[] (hasta 8 URLs alternativas raw de
//       Serper recolectadas en la misma llamada).
//     - El frontend cicla por candidatasLocales sin re-consultar al server;
//       solo vuelve al server cuando se agotaron, enviando las urls_rechazadas
//       acumuladas para que Serper tampoco repita esas.
//     - Si se agotan todas las opciones del servidor, quita la imagen y
//       deja al usuario cargar a mano.
//
//   Con esto cada clic en "intentar otra" siempre muestra algo distinto.

(function () {
  'use strict';

  // Código del último escaneo, para poder usar "refrescar imagen" después.
  let ultimoCodigoEscaneado = null;

  // Indica si la imagen actual en el form fue puesta por auto-scan
  // (y por tanto puede estar equivocada y refrescarse).
  let imagenAutoCompletada = false;

  // v627 — Estado de ciclo de candidatas:
  //   candidatasLocales  → pool de URLs alternativas ya descargadas del server,
  //                        listas para mostrar sin nueva llamada a la API.
  //   urlsRechazadas     → URLs que el usuario ya vio y rechazó; se envían al
  //                        server en el próximo refrescar para que Serper las
  //                        excluya de su respuesta.
  //   ultimaFotoUrl      → URL original (Supabase) de la imagen actualmente
  //                        mostrada, para poder registrarla como rechazada en
  //                        el próximo clic.
  let candidatasLocales = [];
  let urlsRechazadas    = [];
  let ultimaFotoUrl     = null;

  // ── Consulta al banco de códigos ───────────────────────────────────────

  async function obtenerToken() {
    const sb = window.authCtx?.sb;
    if (!sb) return null;
    const { data: { session } } = (await sb.auth.getSession()) || { data: {} };
    return session?.access_token || null;
  }

  async function consultarBancoPropio(codigo) {
    try {
      const token = await obtenerToken();
      if (!token) return null;

      const r = await fetch(`/api/banco-codigos?accion=consultar&codigo=${encodeURIComponent(codigo)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data?.encontrado) return null;
      return { nombre: data.nombre || '', imagenUrl: data.foto_url || null };
    } catch (err) {
      console.warn('[productos-scanner-remoto] falló la consulta al banco de códigos:', err?.message);
      return null;
    }
  }

  async function buscarInfoPorCodigo(codigo) {
    // Reset completo del estado de candidatas al buscar un código nuevo.
    candidatasLocales = [];
    urlsRechazadas    = [];
    ultimaFotoUrl     = null;

    const info = await consultarBancoPropio(codigo);
    if (!info) return;

    if (info.nombre) window.setNombreProductoSiVacio?.(info.nombre);
    if (info.imagenUrl) {
      window.setFotoProductoDesdeUrl?.(info.imagenUrl);
      ultimaFotoUrl     = info.imagenUrl;
      imagenAutoCompletada = true;
      mostrarBotonImagenIncorrecta(codigo);
    }
  }

  // ── Botón "Imagen incorrecta" ──────────────────────────────────────────
  // v626: insertar DESPUÉS del wrap (no dentro — overflow:hidden lo ocultaría).
  // v627: el texto del botón refleja si hay candidatas locales disponibles
  //       ("intentar otra" siempre disponible mientras haya alternativas).

  function mostrarBotonImagenIncorrecta(codigo) {
    quitarBotonImagenIncorrecta();

    const ancla = document.getElementById('fp-foto-quitar')
      || document.getElementById('fp-foto-input');
    if (!ancla) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id   = 'btn-imagen-incorrecta';
    btn.style.cssText = [
      'margin-top:2px', 'font-size:11px', 'color:#d97706', 'background:none',
      'border:none', 'cursor:pointer', 'padding:0', 'text-decoration:underline',
      'display:block', 'text-align:left',
    ].join(';');

    actualizarTextoBtnImagenIncorrecta(btn);
    btn.addEventListener('click', () => refrescarImagen(codigo));
    ancla.insertAdjacentElement('afterend', btn);
  }

  function actualizarTextoBtnImagenIncorrecta(btn) {
    if (!btn) return;
    if (candidatasLocales.length > 0) {
      btn.textContent = `⚠ Imagen incorrecta — intentar otra (${candidatasLocales.length} disponibles)`;
    } else {
      btn.textContent = '⚠ Imagen incorrecta — intentar otra';
    }
  }

  function quitarBotonImagenIncorrecta() {
    document.getElementById('btn-imagen-incorrecta')?.remove();
  }

  // ── Lógica de refresco multi-candidata ────────────────────────────────
  //
  // Flujo de cada clic en "intentar otra":
  //
  //   1. Registrar la URL actual como rechazada (para no repetirla).
  //   2. Si hay candidatasLocales → usar la siguiente SIN llamar al server.
  //      (Rápido, sin costo de API, sin latencia.)
  //   3. Si candidatasLocales vacías → llamar al server con urls_rechazadas[],
  //      para que Serper excluya todo lo ya visto y devuelva algo diferente.
  //   4. Server responde con { foto_url, candidatas[] }:
  //      - foto_url → mostrar; guardar candidatas para futuros clics.
  //      - si foto_url es null pero hay candidatas → usar la primera candidata.
  //      - si ambos vacíos → quitar imagen, pedir al usuario que cargue a mano.

  async function aplicarImagenLocalDesdeUrl(url, codigo) {
    await window.forzarFotoProductoDesdeUrl?.(url);
    ultimaFotoUrl     = url;
    imagenAutoCompletada = true;
    quitarBotonImagenIncorrecta();
    mostrarBotonImagenIncorrecta(codigo);
  }

  async function refrescarImagen(codigo) {
    const btn = document.getElementById('btn-imagen-incorrecta');

    // Registrar la imagen actual como rechazada.
    if (ultimaFotoUrl && !urlsRechazadas.includes(ultimaFotoUrl)) {
      urlsRechazadas.push(ultimaFotoUrl);
    }

    // ── Paso 2: consumir candidata local si existe ──
    if (candidatasLocales.length > 0) {
      const siguiente = candidatasLocales.shift();
      ultimaFotoUrl = siguiente; // anticipar para el próximo clic
      if (btn) { btn.textContent = '⏳ Probando alternativa…'; btn.disabled = true; }

      try {
        await aplicarImagenLocalDesdeUrl(siguiente, codigo);
        window.mostrarToast?.('Imagen alternativa aplicada.', 'ok', 2000);
      } catch {
        // Si falla la descarga directa (CORS, caída del host), pasar a la siguiente.
        urlsRechazadas.push(siguiente);
        if (btn) { btn.textContent = '⚠ Imagen incorrecta — intentar otra'; btn.disabled = false; }
        window.mostrarToast?.('No se pudo cargar esa imagen, probá de nuevo.', 'default', 2500);
      }
      return;
    }

    // ── Paso 3: consultar al server con las URLs ya rechazadas ──
    if (btn) { btn.textContent = '⏳ Buscando imagen…'; btn.disabled = true; }

    try {
      const token = await obtenerToken();
      if (!token) throw new Error('sin sesión');

      const r = await fetch('/api/banco-codigos?accion=refrescar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ codigo, urls_rechazadas: urlsRechazadas }),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || 'Error al refrescar');

      // Guardar nuevas candidatas (crudas de Serper, sin rehostear),
      // filtrando las que ya están en urlsRechazadas.
      if (Array.isArray(data.candidatas) && data.candidatas.length > 0) {
        const nuevas = data.candidatas.filter(u => u && !urlsRechazadas.includes(u));
        candidatasLocales = [...candidatasLocales, ...nuevas];
      }

      quitarBotonImagenIncorrecta();

      // ── Paso 4a: server encontró nueva imagen principal ──
      if (data.foto_url) {
        urlsRechazadas.push(data.foto_url);
        await aplicarImagenLocalDesdeUrl(data.foto_url, codigo);
        const extra = candidatasLocales.length > 0
          ? ` (${candidatasLocales.length} alternativa${candidatasLocales.length !== 1 ? 's' : ''} más disponible${candidatasLocales.length !== 1 ? 's' : ''})`
          : '';
        window.mostrarToast?.(`Imagen actualizada.${extra}`, 'ok', 3000);
        return;
      }

      // ── Paso 4b: server no tiene principal pero hay candidatas nuevas ──
      if (candidatasLocales.length > 0) {
        const siguiente = candidatasLocales.shift();
        urlsRechazadas.push(siguiente);
        await aplicarImagenLocalDesdeUrl(siguiente, codigo);
        window.mostrarToast?.(
          `Imagen alternativa aplicada${candidatasLocales.length > 0 ? ` (${candidatasLocales.length} más disponibles)` : ''}.`,
          'ok', 3000,
        );
        return;
      }

      // ── Paso 4c: se agotaron todas las opciones ──
      window.quitarFotoProducto?.();
      imagenAutoCompletada = false;
      ultimaFotoUrl = null;
      window.mostrarToast?.(
        'No se encontró otra imagen. Podés cargarla a mano.',
        'default',
        5000,
      );
    } catch (err) {
      console.warn('[productos-scanner-remoto] falló refrescarImagen:', err?.message);
      if (btn) {
        actualizarTextoBtnImagenIncorrecta(btn);
        btn.disabled = false;
      }
      window.mostrarToast?.('No se pudo refrescar la imagen. Intentá de nuevo.', 'error', 3000);
    }
  }

  // ── Flujo principal ───────────────────────────────────────────────────

  let primerCodigoDeEstaSesion = true;

  function onCodigoEscaneado(codigo) {
    ultimoCodigoEscaneado = codigo;
    imagenAutoCompletada  = false;
    candidatasLocales     = [];
    urlsRechazadas        = [];
    ultimaFotoUrl         = null;
    quitarBotonImagenIncorrecta();

    // v629 — FIX del bug "el escaneo mezcla el título/foto con un producto
    // anterior": antes de salir a buscar los datos del código nuevo, se
    // limpia cualquier nombre/foto que haya quedado de un escaneo previo
    // (nunca lo que el usuario haya tipeado/elegido a mano). Sin esta
    // llamada, el guard de productos.js interpretaba "el campo no está
    // vacío" como "es del usuario" y descartaba el resultado del código
    // recién leído, dejando pegado el dato del producto anterior.
    window.limpiarAutoCompletadoSiCorresponde?.();

    const input = document.getElementById('fp-codigo');
    if (input) {
      input.value = codigo;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (navigator.vibrate) navigator.vibrate(60);
    window.mostrarToast?.(`Código escaneado: ${codigo}`, 'ok', 2500);

    // v619: ocultar (no desvincular) — el celular sigue activo.
    window.VincularCelular.ocultar();
    if (primerCodigoDeEstaSesion) {
      primerCodigoDeEstaSesion = false;
      window.mostrarToast?.(
        'El celular sigue vinculado: podés escanear el próximo producto cuando quieras.',
        'default',
        4000,
      );
    }

    buscarInfoPorCodigo(codigo);
  }

  function abrirVincularCelularProducto() {
    if (!window.authCtx?.sb) return;
    primerCodigoDeEstaSesion = true;
    window.VincularCelular.abrir({
      contexto: 'alta_producto',
      entidad_id: null,
      sb: window.authCtx.sb,
      titulo: 'Escanear código de producto',
      onCodigo: onCodigoEscaneado,
    });
  }

  // v628 — Escanear con la cámara de ESTE dispositivo (sin vincular un
  // celular aparte). Mismo destino final (onCodigoEscaneado) que el flujo
  // de celular vinculado.
  function abrirEscanerCamaraProducto() {
    if (!window.CameraScanner) return;
    window.CameraScanner.abrir({
      titulo: 'Escanear código de producto',
      instrucciones: 'Apuntá la cámara al código de barras. Funciona con la webcam de la compu o la cámara del celular.',
      onCodigo: onCodigoEscaneado,
    });
  }

  window.abrirVincularCelularProducto = abrirVincularCelularProducto;
  window.abrirEscanerCamaraProducto   = abrirEscanerCamaraProducto;
})();
