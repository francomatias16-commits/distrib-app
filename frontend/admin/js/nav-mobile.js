/**
 * nav-mobile.js — Menú de navegación mobile para el admin (≤ 768px).
 *
 * v223 — Botón hamburguesa (FAB fijo, arriba-izquierda) que abre un
 * drawer lateral con TODOS los workspaces y sus secciones (mismo patrón
 * de dos niveles que el desktop, pero colapsado en una sola lista
 * scrolleable). Reemplaza la barra inferior de 5 accesos anterior
 * (reporte: no se veía en celular real).
 *
 * Etapa 6 — Filtrado por rol:
 *   Los workspaces se filtran según window.authCtx.perfil.rol antes de
 *   renderizar, igual que nav.js (desktop).
 *
 * Requiere nav-data.js cargado antes (window.NAV_WORKSPACES).
 */

(function () {
  'use strict';

  /* ── Utilidad: rol tiene acceso al ítem ─────────────────────────── */
  function tieneAcceso(item, rol) {
    if (!item.roles || !item.roles.length) return true;
    return item.roles.includes(rol);
  }

  /* ── Filtrar workspaces por rol (igual que nav.js) ───────────────── */
  function workspacesParaRol(rol) {
    return (window.NAV_WORKSPACES || [])
      .filter(ws => tieneAcceso(ws, rol))
      .map(ws => {
        const secsFiltradas = ws.secciones.filter(sec => tieneAcceso(sec, rol));
        return { ...ws, secciones: secsFiltradas };
      })
      .filter(ws => {
        const esUnica = (window.NAV_WORKSPACES.find(w => w.id === ws.id) || {}).secciones?.length === 0;
        return esUnica || ws.secciones.length > 0;
      });
  }

  /* ── Detectar workspace / sección activos ────────────────────────── */
  function activos(workspaces) {
    const seg = window.location.pathname.replace(/\/$/, '').split('/').pop();
    for (const ws of workspaces) {
      if (!ws.secciones.length) {
        if (seg === 'dashboard' || window.location.pathname === ws.href) {
          return { wsId: ws.id, secSeccion: null };
        }
        continue;
      }
      for (const sec of ws.secciones) {
        if (sec.href && seg === sec.href.split('/').pop()) {
          return { wsId: ws.id, secSeccion: sec.seccion };
        }
      }
    }
    return { wsId: null, secSeccion: null };
  }

  /* ── Drawer open/close ───────────────────────────────────────────── */
  let drawerAbierto = false;

  function abrirDrawer() {
    drawerAbierto = true;
    document.getElementById('mnav-drawer')?.classList.add('open');
    document.getElementById('mnav-overlay')?.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function cerrarDrawer() {
    drawerAbierto = false;
    document.getElementById('mnav-drawer')?.classList.remove('open');
    document.getElementById('mnav-overlay')?.classList.remove('visible');
    document.body.style.overflow = '';
  }

  function toggleDrawer() {
    drawerAbierto ? cerrarDrawer() : abrirDrawer();
  }

  /* ── Render ──────────────────────────────────────────────────────── */
  function render(rol) {
    const workspaces = workspacesParaRol(rol);
    const { wsId: wsActivoId, secSeccion } = activos(workspaces);

    const grupos = workspaces.map(ws => {
      const isWsActive = ws.id === wsActivoId;
      const color = ws.color || 'var(--color-primary)';

      // Workspace "pantalla única" (sin secciones, ej. Hoy/Auto) → el
      // encabezado navega directo, como un link.
      if (!ws.secciones.length) {
        return `<div class="mnav-ws-group">
          <button
            class="mnav-ws-header mnav-ws-header--link${isWsActive ? ' active' : ''}"
            style="${isWsActive ? `--mnav-ws-color:${color}` : ''}"
            onclick="window._mnavIrHref('${ws.href}')"
          >${ws.icon}<span>${ws.label}</span></button>
        </div>`;
      }

      const links = ws.secciones.map(sec => {
        const isActive = isWsActive && secSeccion === sec.seccion;
        // FIX (404 en mobile): items con `accion` (hoy solo "Trabajar con
        // IA", ver nav-data.js) no tienen `href` — nav.js (desktop) ya
        // los trata aparte, pero acá se renderizaban igual que un link
        // normal con `href="${sec.href}"`, que con `sec.href` undefined
        // quedaba literalmente `href="undefined"`: al tocarlo en el
        // celular, el navegador navegaba a esa URL inexistente → 404.
        // Mismo patrón que el mega-menú desktop: href="#" + data-attr +
        // listener delegado más abajo que abre el asistente en vez de
        // navegar.
        if (sec.accion) {
          return `<a
            class="mnav-drawer-item"
            href="#"
            data-mnav-accion="${sec.accion}"
          >
            <span class="mnav-drawer-icon">${sec.icon}</span>
            <span class="mnav-drawer-label">${sec.label}</span>
          </a>`;
        }
        return `<a
          class="mnav-drawer-item${isActive ? ' active' : ''}"
          href="${sec.href}"
        >
          <span class="mnav-drawer-icon">${sec.icon}</span>
          <span class="mnav-drawer-label">${sec.label}</span>
          ${isActive ? '<span class="mnav-drawer-check"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg></span>' : ''}
        </a>`;
      }).join('');

      return `<div class="mnav-ws-group">
        <div class="mnav-ws-header${isWsActive ? ' active' : ''}" style="${isWsActive ? `--mnav-ws-color:${color}` : ''}">
          ${ws.icon}<span>${ws.label}</span>
        </div>
        ${links}
      </div>`;
    }).join('');

    let root = document.getElementById('mnav-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'mnav-root';
      document.body.appendChild(root);
    }

    root.innerHTML = `
      <button class="mnav-fab" aria-label="Abrir menú" onclick="window._mnavToggleDrawer()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      <div class="mnav-overlay" id="mnav-overlay" onclick="window._mnavCerrarDrawer()"></div>
      <aside class="mnav-drawer" id="mnav-drawer" role="dialog" aria-label="Menú de navegación">
        <div class="mnav-drawer-header">
          <div class="mnav-drawer-logo" id="mnav-logo">D</div>
          <span class="mnav-drawer-empresa" id="mnav-empresa">Empresa</span>
          <button class="mnav-drawer-close" onclick="window._mnavCerrarDrawer()" aria-label="Cerrar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="mnav-drawer-body">${grupos}</div>
        <div class="mnav-drawer-footer">
          <button class="mnav-drawer-salir" onclick="cerrarSesion()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            <span>Salir</span>
          </button>
        </div>
      </aside>`;

    // Sincronizar nombre de empresa / logo con el sidebar desktop si ya
    // fueron seteados por otro script (ej. auth.js / dashboard.js).
    const empresaDesktop = document.getElementById('sidebar-empresa');
    if (empresaDesktop && empresaDesktop.textContent.trim()) {
      const el = document.getElementById('mnav-empresa');
      if (el) el.textContent = empresaDesktop.textContent;
    }
    const logoDesktop = document.getElementById('sidebar-logo');
    if (logoDesktop && logoDesktop.innerHTML.trim()) {
      const el = document.getElementById('mnav-logo');
      if (el) el.innerHTML = logoDesktop.innerHTML;
    }

    // Etapa 7 — marcar el body con el workspace activo para reglas CSS de color
    if (wsActivoId) {
      document.body.dataset.ws = wsActivoId;
    } else {
      delete document.body.dataset.ws;
    }

    window._mnavWorkspaces = workspaces;
  }

  /* ── API global (accesible desde onclick) ────────────────────────── */
  window._mnavIrHref = function (href) {
    window.location.href = href;
  };
  window._mnavToggleDrawer  = toggleDrawer;
  window._mnavCerrarDrawer  = cerrarDrawer;

  // Ítems con `accion` (ver render(), rama `sec.accion`): no navegan,
  // disparan un comportamiento propio — hoy solo "asistente-ia", abre el
  // panel de chat-widget.js y cierra el drawer. Delegado en el body
  // porque #mnav-root se recrea en cada render().
  document.addEventListener('click', function (e) {
    const link = e.target.closest('[data-mnav-accion]');
    if (!link) return;
    e.preventDefault();
    cerrarDrawer();
    if (link.dataset.mnavAccion === 'asistente-ia' && typeof window.abrirAsistenteIA === 'function') {
      window.abrirAsistenteIA();
    }
  });

  /* ── Init con rol ────────────────────────────────────────────────── */
  function initConAuth() {
    if (window.authCtx) {
      render(window.authCtx.perfil?.rol || null);
      return;
    }

    // Render provisional (sin filtrar) para evitar pantalla en blanco
    render(null);

    window.addEventListener('authListo', function handler(e) {
      window.removeEventListener('authListo', handler);
      render(e.detail?.rol || null);
    });

    let intentos = 0;
    const iv = setInterval(() => {
      if (window.authCtx) {
        clearInterval(iv);
        render(window.authCtx.perfil?.rol || null);
        return;
      }
      if (++intentos > 50) clearInterval(iv);
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConAuth);
  } else {
    initConAuth();
  }

  // Si cambia el tamaño de ventana y se pasa a desktop con el drawer
  // abierto, lo cerramos para no dejar el overlay/scroll-lock colgado.
  window.addEventListener('resize', () => {
    if (drawerAbierto && window.innerWidth > 768) cerrarDrawer();
  });

})();
