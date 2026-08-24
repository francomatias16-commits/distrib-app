/**
 * nav.js — Renderiza el menú principal del admin (mega-menú overlay).
 *
 * Requiere:
 *   - nav-data.js cargado antes (define window.NAV_WORKSPACES)
 *   - Un <div id="nav-root"></div> en el HTML (aloja backdrop+panel)
 *   - Un elemento .topbar-left en el HTML (aloja logo+botón disparador)
 *   - La clase .layout en el contenedor principal de la página
 *
 * v520 — Reemplaza al riel+panel oscuro por el mismo mega-menú overlay
 * que ya usaba dashboard.html (botón → panel modal centrado con todas las
 * secciones agrupadas por espacio de trabajo). Se extrae acá como
 * componente compartido para no duplicar el markup/JS en cada pantalla —
 * todas las páginas admin (salvo dashboard, que ya lo trae inline)
 * ahora comparten esta misma implementación.
 *
 * v542 — FIX botón invisible en producción: el disparador (logo+botón)
 * era un FAB fixed flotando en la esquina superior izquierda (top:14px;
 * left:14px), fuera del flujo normal del documento e independiente del
 * topbar de cada pantalla. En vivo quedaba invisible sin ningún error en
 * consola — cualquier elemento con más z-index encima lo tapaba en
 * silencio, y no había forma simple de auditarlo pantalla por pantalla.
 * Ahora el disparador se inyecta DENTRO de .topbar-left (mismo lugar
 * donde dashboard.html ya lo tenía a mano, junto al logo), en el flujo
 * normal del layout — ya no depende de z-index ni de posición fija.
 * #nav-root sigue existiendo solo para backdrop+panel, que tienen su
 * propio position:fixed independiente.
 *
 * Etapa 6 — Filtrado por rol:
 *   Espera a window.authCtx para filtrar workspaces y secciones según el
 *   rol del usuario antes de renderizar. Si authCtx no está disponible aún,
 *   suscribe un evento + polling liviano y renderiza en cuanto llega.
 *   Si tras 5 segundos no llega (error de red), renderiza sin filtrar para
 *   no dejar la navegación en blanco (auth.js se encargará de redirigir).
 */

(function () {
  'use strict';

  /* ── Filtrado por rol ─────────────────────────────────────────────── */

  function tieneAcceso(item, rol) {
    if (!item.roles || !item.roles.length) return true;
    return item.roles.includes(rol);
  }

  function workspacesParaRol(rol) {
    return window.NAV_WORKSPACES
      .filter(ws => tieneAcceso(ws, rol))
      .map(ws => ({ ...ws, secciones: ws.secciones.filter(sec => tieneAcceso(sec, rol)) }))
      .filter(ws => {
        const esUnica = window.NAV_WORKSPACES.find(w => w.id === ws.id).secciones.length === 0;
        return esUnica || ws.secciones.length > 0;
      });
  }

  /* ── Detectar workspace activo (para marcar body[data-ws]) ───────── */
  function esActivo(href) {
    const path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    return path === href || path.startsWith(href + '/');
  }

  function workspaceActivo(workspaces) {
    for (const ws of workspaces) {
      if (!ws.secciones.length) { if (esActivo(ws.href)) return ws; continue; }
      if (ws.secciones.some(sec => esActivo(sec.href))) return ws;
    }
    return null;
  }

  /* ── Render del mega-menú ─────────────────────────────────────────── */
  function renderMenuNavegacion(panel, rol) {
    const workspaces = rol ? workspacesParaRol(rol) : window.NAV_WORKSPACES;

    // el acceso único (Panel principal) va aparte, destacado en el header
    const home = document.getElementById('nav-menu-home');
    const inicio = workspaces.find(ws => ws.secciones.length === 0);
    if (home && inicio) {
      const activo = esActivo(inicio.href);
      home.innerHTML = `<a class="nav-menu-home${activo ? ' is-current' : ''}" href="${inicio.href}">
        ${inicio.icon}<span class="nav-menu-home-label">${inicio.label}</span>
      </a>`;
    }

    const conSecciones = workspaces.filter(ws => ws.secciones.length > 0);

    // arma el bloque HTML de cada grupo y estima su altura para repartir columnas
    const grupos = conSecciones.map(ws => {
      const links = ws.secciones.map(sec => {
        // `accion` (en vez de `href`): ítem que dispara un comportamiento
        // JS en vez de navegar (hoy solo "Trabajar con IA", ver nav-data.js
        // y el listener delegado en inicializarMenuNavegacion()). Nunca
        // puede quedar marcado "activo" (no es una pantalla propia) y su
        // href es "#" solo para que siga siendo un <a> tabulable/accesible.
        if (sec.accion) {
          return `<a class="nav-ws-link" href="#" data-menu-accion="${sec.accion}"><span>${sec.label}</span></a>`;
        }
        const activo = esActivo(sec.href);
        return `<a class="nav-ws-link${activo ? ' is-current' : ''}" href="${sec.href}"><span>${sec.label}</span></a>`;
      }).join('');
      const html = `<div class="nav-ws${ws.destacado ? ' nav-ws--destacado' : ''}">
        <div class="nav-ws-label" style="--nav-ws-color:${ws.textColor}">${ws.icon}${ws.label}</div>
        <div class="nav-ws-links">${links}</div>
      </div>`;
      // alto aproximado en px: encabezado de grupo (~35) + una línea por sección (~21)
      const altura = 35 + ws.secciones.length * 21;
      return { html, altura };
    });

    const grid = panel.querySelector('#nav-menu-grid');
    if (!grid) return;

    const w = window.innerWidth;
    const numCols = w <= 640 ? 1 : (w <= 900 ? 2 : 4);

    // bin-packing goloso (LPT): ordena los grupos más altos primero y cada uno
    // va a la columna que hasta ahora acumula menos altura -- evita que una
    // columna quede mucho más corta o más larga que las demás.
    const columnas = Array.from({ length: numCols }, () => ({ html: '', altura: 0 }));
    [...grupos].sort((a, b) => b.altura - a.altura).forEach(g => {
      const destino = columnas.reduce((min, c) => c.altura < min.altura ? c : min, columnas[0]);
      destino.html += g.html;
      destino.altura += g.altura;
    });

    grid.innerHTML = columnas.map(c => `<div class="nav-menu-col">${c.html}</div>`).join('');

    // Etapa 7 — marcar el body con el workspace activo para reglas CSS de color
    const wsActivo = workspaceActivo(workspaces);
    if (wsActivo) document.body.dataset.ws = wsActivo.id;
    else delete document.body.dataset.ws;

    window._NAV_WS_VISIBLES = workspaces;
  }

  /* ── Markup del disparador: separador + botón ──────────────────────────
   * Se inyecta al inicio de .topbar-left de cada pantalla, en el flujo
   * normal del documento — igual patrón que ya usaba dashboard.html a
   * mano. Ya no es un FAB fixed en la esquina (ver comentario en nav.css).
   *
   * v744 había agregado acá un #topbar-logo (logo de empresa junto al
   * botón "Menú principal"). v907 — Pedido directo: se saca de esta zona
   * por quedar redundante con el logo que ya se ve en el chip de usuario
   * (#topbar-avatar-ini, ver v906/topbar-widgets.js) — dos logos en la
   * misma barra superior de cada pantalla. */
  function buildMenuTrigger() {
    return `
      <button class="nav-back-btn" id="nav-back-btn" aria-label="Volver a la pantalla anterior" title="Volver" hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <span class="topbar-divider"></span>
      <button class="nav-menu-btn" id="nav-menu-btn" aria-label="Menú principal" aria-expanded="false" title="Menú principal">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        <span class="nav-menu-btn-label">Menú principal</span>
      </button>`;
  }

  /* ── Flecha "Volver" en el topbar ─────────────────────────────────────
   * v611 — Pedido directo: volver a la pantalla anterior obligaba a abrir
   * el mega-menú y buscar la sección de nuevo, aunque se hubiera entrado
   * un solo paso antes. Como cada pantalla del admin es una carga de
   * página completa (no es un SPA), el historial real del navegador ya
   * tiene la secuencia exacta de páginas visitadas -- se reutiliza ese
   * historial (window.history.back()) en vez de mantener una pila propia
   * (ej. en localStorage) que habría que sincronizar a mano con pestañas
   * nuevas, recargas y el botón atrás nativo.
   *
   * sessionStorage (clave nav-back-profundidad) lleva la cuenta de
   * cuántas pantallas del admin se cargaron en esta pestaña. En la
   * primera pantalla del admin abierta en la pestaña (favorito, link
   * externo, pestaña nueva) la profundidad es 0 y el botón queda oculto
   * -- no hay "atrás" útil todavía, no es un bug. Desde la segunda
   * pantalla en adelante se muestra y el click hace history.back().
   * Es por pestaña: duplicar la pestaña o abrir el admin en dos pestañas
   * distintas arranca un contador propio en cada una. */
  function inicializarBotonVolver() {
    const KEY = 'nav-back-profundidad';
    const profundidad = (parseInt(sessionStorage.getItem(KEY), 10) || 0) + 1;
    sessionStorage.setItem(KEY, String(profundidad));

    const btn = document.getElementById('nav-back-btn');
    if (!btn) return;

    if (profundidad > 1) {
      btn.hidden = false;
      btn.addEventListener('click', () => window.history.back());
    }
  }

  /* ── Markup del overlay: backdrop + panel (van dentro de #nav-root) ── */
  function buildMenuOverlay() {
    return `
      <div class="nav-menu-backdrop" id="nav-menu-backdrop"></div>
      <nav class="nav-menu-panel" id="nav-menu-panel" role="dialog" aria-modal="true" aria-labelledby="nav-menu-title" tabindex="-1">
        <div class="nav-menu-header">
          <div class="nav-menu-header-left">
            <div>
              <div class="nav-menu-title" id="nav-menu-title">Menú principal</div>
              <div class="nav-menu-subtitle">Todas las secciones de tu panel, por área</div>
            </div>
          </div>
          <div class="nav-menu-home" id="nav-menu-home"></div>
          <button class="nav-menu-close" id="nav-menu-close" aria-label="Cerrar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="nav-menu-grid" id="nav-menu-grid"></div>
        <div class="nav-menu-footer">
          <div class="nav-menu-footer-empresa">
            <div id="sidebar-logo">D</div>
            <span id="sidebar-empresa">Empresa</span>
          </div>
          <button class="nav-menu-salir" onclick="cerrarSesion()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            <span>Salir</span>
          </button>
        </div>
      </nav>`;
  }

  /* ── Apertura/cierre + foco + columnas responsivas ───────────────── */
  // Se llama una sola vez (primer render, aunque sea provisional sin rol):
  // arma listeners de click/teclado/resize sobre nodos que persisten porque
  // el skeleton no se vuelve a reconstruir en renders posteriores — solo se
  // actualiza el contenido interno (grid/home) vía renderMenuNavegacion.
  let rolActual = null;

  function inicializarMenuNavegacion(rol) {
    rolActual = rol;
    const btn      = document.getElementById('nav-menu-btn');
    const backdrop = document.getElementById('nav-menu-backdrop');
    const panel    = document.getElementById('nav-menu-panel');
    const closeBtn = document.getElementById('nav-menu-close');
    if (!btn || !panel || !window.NAV_WORKSPACES) return;

    let focoPrevio = null;
    let ultimasColumnas = null;

    renderMenuNavegacion(panel, rol);

    function columnasSegunAncho() {
      const w = window.innerWidth;
      if (w <= 640) return 1;
      if (w <= 900) return 2;
      return 4;
    }

    function abrir() {
      focoPrevio = document.activeElement;
      btn.classList.add('is-active'); btn.setAttribute('aria-expanded', 'true');
      backdrop.classList.add('open'); panel.classList.add('open');
      panel.focus();
    }
    function cerrar() {
      btn.classList.remove('is-active'); btn.setAttribute('aria-expanded', 'false');
      backdrop.classList.remove('open'); panel.classList.remove('open');
      (focoPrevio || btn).focus();
    }
    btn.addEventListener('click', () => panel.classList.contains('open') ? cerrar() : abrir());
    closeBtn.addEventListener('click', cerrar);

    // Ítems con `accion` (ver renderMenuNavegacion): no navegan, disparan
    // un comportamiento propio. Hoy solo "asistente-ia" — abre el panel de
    // chat-widget.js (ver window.abrirAsistenteIA, definida ahí) y cierra
    // este mega-menú para no dejar dos overlays superpuestos.
    panel.addEventListener('click', e => {
      const link = e.target.closest('[data-menu-accion]');
      if (!link) return;
      e.preventDefault();
      cerrar();
      if (link.dataset.menuAccion === 'asistente-ia' && typeof window.abrirAsistenteIA === 'function') {
        window.abrirAsistenteIA();
      }
    });

    backdrop.addEventListener('click', cerrar);
    document.addEventListener('keydown', e => {
      if (!panel.classList.contains('open')) return;
      if (e.key === 'Escape') { cerrar(); return; }
      // trampa de foco simple: Tab no debe escaparse del panel mientras está abierto
      if (e.key === 'Tab') {
        const focables = panel.querySelectorAll('a[href], button:not([disabled])');
        if (!focables.length) return;
        const primero = focables[0], ultimo = focables[focables.length - 1];
        if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
        else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
      }
    });

    ultimasColumnas = columnasSegunAncho();
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const n = columnasSegunAncho();
        if (n !== ultimasColumnas) { ultimasColumnas = n; renderMenuNavegacion(panel, rolActual); }
      }, 150);
    });
  }

  /* ── Datos de empresa en el pie del menú (logo + nombre) ─────────────
   * v903 — FIX: antes esto lo pintaba únicamente auth.js (ver auth.js,
   * pintarLogoEn), apuntando a #sidebar-logo/#sidebar-empresa por id. El
   * problema es de orden de carga, no de datos: cuando el primer render
   * de este menú es el "provisional sin rol" (auth todavía no resolvió,
   * ver comentario de renderConRol más abajo), auth.js corre su pintado
   * ANTES de que exista ese primer render, y la 2ª vez que renderConRol
   * corre (ya con el rol real, vía el evento authListo) cae en la rama
   * "else" que solo actualiza el grid — nunca vuelve a tocar el pie. El
   * nombre/logo por default ("Empresa"/"D") quedaba pegado para siempre
   * en ese caso, aunque perfil.empresas sí tuviera los datos correctos.
   * Fix: nav.js pasa a pintarlo él mismo, siempre que renderConRol corre
   * (las dos ramas, ver el final de esa función), leyendo directo de
   * window.authCtx en ese momento — no depende de que auth.js le haya
   * ganado o perdido la carrera al primer render del menú. */
  function pintarEmpresaSidebar() {
    const empresa = window.authCtx?.perfil?.empresas;
    if (!empresa) return;

    const empresaEl = document.getElementById('sidebar-empresa');
    if (empresaEl) empresaEl.textContent = empresa.nombre || '';

    const logoEl = document.getElementById('sidebar-logo');
    if (!logoEl) return;
    if (empresa.logo_url) {
      logoEl.innerHTML = '';
      const img = document.createElement('img');
      img.src = empresa.logo_url;
      img.alt = empresa.nombre || 'Logo';
      img.onerror = () => {
        logoEl.innerHTML = '';
        logoEl.textContent = empresa.nombre?.charAt(0)?.toUpperCase() || 'D';
      };
      logoEl.appendChild(img);
    } else {
      logoEl.textContent = empresa.nombre?.charAt(0)?.toUpperCase() || 'D';
    }
  }

  /* ── Render con rol ya resuelto ───────────────────────────────────── */
  // Primera vez: arma el skeleton completo (button+backdrop+panel) y
  // engancha los listeners. Llamadas siguientes (ej. cuando llega el rol
  // real por authListo tras un render provisional sin rol): solo actualiza
  // el contenido interno del panel, sin reconstruir ni re-enganchar nada.
  let inicializado = false;

  function renderConRol(rol) {
    const root = document.getElementById('nav-root');
    if (!root || !window.NAV_WORKSPACES) return;

    if (!inicializado) {
      root.innerHTML = buildMenuOverlay();

      // El disparador va dentro de .topbar-left (flujo normal del documento,
      // igual que dashboard.html). Fallback a #nav-root solo por seguridad,
      // por si alguna pantalla no tuviera .topbar-left en su HTML.
      const topbarLeft = document.querySelector('.topbar-left');
      if (topbarLeft) {
        topbarLeft.insertAdjacentHTML('afterbegin', buildMenuTrigger());
      } else {
        root.insertAdjacentHTML('afterbegin', buildMenuTrigger());
      }

      inicializarMenuNavegacion(rol);
      inicializarBotonVolver();
      inicializado = true;
    } else {
      rolActual = rol;
      const panel = document.getElementById('nav-menu-panel');
      if (panel) renderMenuNavegacion(panel, rol);
    }

    // Se llama siempre (las dos ramas), no solo en el primer build: es la
    // única forma de garantizar que quede pintado sin importar en qué
    // momento exacto llegaron los datos de la empresa (ver comentario de
    // pintarEmpresaSidebar arriba).
    pintarEmpresaSidebar();
  }

  /* ── Esperar authCtx y renderizar ────────────────────────────────── */
  function initConAuth() {
    // Ya disponible (auth.js corrió antes que nav.js, o carga síncrona)
    if (window.authCtx) {
      renderConRol(window.authCtx.perfil?.rol || null);
      return;
    }

    // Render provisional sin filtrar (evita pantalla en blanco)
    renderConRol(null);

    // Escuchar el evento que auth.js puede disparar al terminar
    window.addEventListener('authListo', function handler(e) {
      window.removeEventListener('authListo', handler);
      renderConRol(e.detail?.rol || null);
    });

    // Polling de respaldo por si auth.js no dispara el evento
    let intentos = 0;
    const intervalo = setInterval(() => {
      if (window.authCtx) {
        clearInterval(intervalo);
        renderConRol(window.authCtx.perfil?.rol || null);
        return;
      }
      if (++intentos > 50) clearInterval(intervalo); // 5 s máx
    }, 100);
  }

  /* ── API global ──────────────────────────────────────────────────── */
  // Se mantiene por compatibilidad: nada más la invoca hoy (el nombre de
  // usuario en topbar lo maneja topbar-widgets.js), pero queda disponible
  // por si algún módulo viejo la sigue llamando.
  window.navActualizarUsuario = function (nombre) {
    const el = document.getElementById('nav-usuario');
    if (el) el.textContent = nombre;
  };

  /* ── Init ────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConAuth);
  } else {
    initConAuth();
  }

  /* ── Asistente de ayuda (panel de chat) ───────────────────────────────
   * Se inyecta acá para aparecer en las ~27 pantallas del admin de una
   * sola vez, sin tocar cada .html — ver Checklist de implementación,
   * punto 19. Requiere sesión activa (chat-widget.js se auto-oculta si
   * no la hay, ej. login.html no carga nav.js de todas formas).
   *
   * v960 — Ya no monta el botón flotante (FAB): se abre desde el ítem
   * "Trabajar con IA" del mega-menú (ver nav-data.js + el listener
   * data-menu-accion en inicializarMenuNavegacion()). El flag se pone
   * ANTES de cargar el script porque chat-widget.js lo lee recién dentro
   * de su iniciar() async, que corre después — el orden de estas dos
   * líneas no es crítico, pero mantenerlo así deja la intención clara.
   * Los portales cliente/chofer cargan chat-widget.js directo desde su
   * propio HTML (sin pasar por acá) y no tocan este flag, así que siguen
   * viendo el botón de siempre — sin cambios para ellos.
   */
  window.__CHAT_ASISTENTE_SIN_BOTON__ = true;
  if (!document.getElementById('chat-asistente-css')) {
    const link = document.createElement('link');
    link.id = 'chat-asistente-css';
    link.rel = 'stylesheet';
    link.href = '/frontend/shared/chat-widget.css';
    document.head.appendChild(link);
  }
  if (!document.querySelector('script[data-chat-asistente]')) {
    const script = document.createElement('script');
    script.src = '/frontend/shared/chat-widget.js';
    script.defer = true;
    script.setAttribute('data-chat-asistente', '1');
    document.body.appendChild(script);
  }

})();
