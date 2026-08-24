/**
 * frontend/shared/topbar-widgets.js
 * ─────────────────────────────────────────────────────────────────────────
 * Módulo ÚNICO y compartido para el reloj en vivo (#topbar-fecha) y el chip
 * de usuario con avatar de iniciales (#topbar-usuario / #topbar-avatar-ini).
 *
 * Reemplaza la lógica que antes vivía duplicada/parcial:
 *   - dashboard-optimizado.js la tenía completa, pero SOLO corría en
 *     dashboard.html (Panel principal).
 *   - Las otras 13 páginas con topbar (anomalias, auditoria, automatizacion,
 *     cheques, cobranzas, devoluciones, fidelizacion, notas, notif-log,
 *     puntos, rentabilidad-zona, riesgo-cheques, rutas, vencimientos) tenían
 *     el <span id="topbar-fecha"> en el HTML pero ningún script lo activaba
 *     → reloj y avatar "fantasma".
 *
 * Fixes de Etapa 1 (Auditoría v232) aplicados acá:
 *   [Alta]  Reloj/avatar ausentes en 14 pantallas → centralizados en este
 *           módulo, incluido ahora en todas ellas + en dashboard.html.
 *   [Media] Chip de usuario 100% decorativo pese a "parecer" clickeable
 *           (patrón universal de menú de cuenta) → ahora abre un menú
 *           real con "Mi perfil" / "Cerrar sesión".
 *   [Media] Si window.authReady nunca resuelve (falla de red silenciosa),
 *           el chip quedaba vacío para siempre → fallback visible "Invitado"
 *           a los 12s, igual que el timeout que ya usan los KPIs.
 *   [Baja]  El reloj no aclaraba que la hora es la del dispositivo, no la
 *           del servidor → se agrega title explicativo.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

(function () {
  const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const MESES_ANIO = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];

  function _formatoRelojTopbar(d) {
    const dia = DIAS_SEMANA[d.getDay()];
    const mes = MESES_ANIO[d.getMonth()];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const diaCap = dia.charAt(0).toUpperCase() + dia.slice(1);
    return `${diaCap} ${d.getDate()} de ${mes} · ${hh}:${mm} hs`;
  }

  function iniciarRelojTopbar() {
    const el = document.getElementById('topbar-fecha');
    if (!el) return;
    // [Limpieza zocalo] Fecha/hora retiradas del topbar a pedido -- se
    // quita el elemento del DOM en vez de solo dejar de completarlo, para
    // que no quede un espacio vacio reservado en el layout.
    el.remove();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Chip de usuario: avatar de iniciales + menú de cuenta
  // ─────────────────────────────────────────────────────────────────────

  function _cerrarMenuChip(menu, chip) {
    menu.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  }

  function _armarMenuChip(chip) {
    if (chip.classList.contains('topbar-chip--clickeable')) return; // ya armado

    const menu = document.createElement('div');
    menu.className = 'topbar-chip-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.innerHTML =
      '<button type="button" class="topbar-chip-menu__item" data-accion="perfil" role="menuitem">Mi perfil</button>' +
      '<button type="button" class="topbar-chip-menu__item topbar-chip-menu__item--danger" data-accion="salir" role="menuitem">Cerrar sesión</button>';
    chip.appendChild(menu);

    chip.classList.add('topbar-chip--clickeable');
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-haspopup', 'true');
    chip.setAttribute('aria-expanded', 'false');

    const toggle = (ev) => {
      ev.stopPropagation();
      if (!menu.hidden) { _cerrarMenuChip(menu, chip); return; }
      menu.hidden = false;
      chip.setAttribute('aria-expanded', 'true');
    };

    chip.addEventListener('click', toggle);
    chip.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(ev); }
      if (ev.key === 'Escape') _cerrarMenuChip(menu, chip);
    });
    document.addEventListener('click', () => _cerrarMenuChip(menu, chip));

    menu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-accion]');
      if (!btn) return;
      ev.stopPropagation();
      _cerrarMenuChip(menu, chip);
      if (btn.dataset.accion === 'salir') {
        window.cerrarSesion?.();
      } else if (btn.dataset.accion === 'perfil') {
        window.location.href = '/admin/empresa-config';
      }
    });
  }

  // Arma las iniciales ("MT" para "Marina Torres") que se usan como avatar
  // de fallback cuando la empresa no tiene logo_url cargado (o la imagen
  // falla al cargar). Auditoría Etapa 2 (v232, hallazgo Bajo): antes se
  // tomaba p[0] crudo, así que un nombre que arrancaba con emoji/número/
  // símbolo generaba una inicial "basura" visualmente. Se normaliza a la
  // primera letra Unicode real de cada palabra; si una palabra no tiene
  // ninguna letra, se descarta en vez de mostrar el símbolo.
  function _inicialesDe(nombre) {
    const primeraLetra = (palabra) => {
      const m = palabra.match(/\p{L}/u);
      return m ? m[0] : '';
    };
    return nombre
      .split(/\s+/)
      .map(primeraLetra)
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
  }

  // Convierte el chip "Marina Torres" en un avatar circular delante del
  // nombre — auth.js ya deja el nombre + badge de rol en #topbar-usuario;
  // acá se agrega el círculo y se activa el menú de cuenta.
  //
  // v906: mismo criterio que #topbar-logo/#sidebar-logo (ver auth.js,
  // pintarLogoEn) — si la empresa tiene logo_url se muestra el logo en vez
  // de las iniciales, con fallback automático a iniciales si la imagen no
  // carga. Antes este avatar quedaba fijo en iniciales sin importar si
  // había logo, inconsistente con el resto de la topbar/menú.
  function mejorarChipUsuario() {
    const userEl = document.getElementById('topbar-usuario');
    if (!userEl || !userEl.textContent.trim()) return;

    const nombre = userEl.textContent.trim();
    const logoUrl = window.authCtx?.perfil?.empresas?.logo_url || null;

    let avatar = document.getElementById('topbar-avatar-ini');
    if (!avatar) {
      avatar = document.createElement('span');
      avatar.id = 'topbar-avatar-ini';
      avatar.className = 'topbar-avatar-ini';
      userEl.parentElement?.insertBefore(avatar, userEl);
    }

    if (logoUrl) {
      avatar.innerHTML = '';
      const img = document.createElement('img');
      img.src = logoUrl;
      img.alt = nombre;
      img.onerror = () => {
        avatar.innerHTML = '';
        avatar.textContent = _inicialesDe(nombre);
      };
      avatar.appendChild(img);
    } else if (!avatar.textContent.trim() && !avatar.querySelector('img')) {
      avatar.textContent = _inicialesDe(nombre);
    }

    if (userEl.parentElement) _armarMenuChip(userEl.parentElement);
  }

  // [Etapa 1 · Media] Si authReady nunca resuelve (ej. falla de red
  // silenciosa), el chip de usuario quedaba vacío para siempre, sin decirle
  // al usuario quién es ni con qué rol está logueado. A los 12s (mismo
  // timeout que usan los KPIs del panel) se muestra un fallback visible.
  function _fallbackUsuarioSiAuthFalla() {
    const userEl = document.getElementById('topbar-usuario');
    if (!userEl) return;
    setTimeout(() => {
      if (userEl.textContent.trim()) return; // auth ya resolvió, no hacer nada
      userEl.textContent = 'Invitado';
      userEl.title = 'No se pudo verificar tu sesión. Recargá la página o volvé a iniciar sesión.';
      if (!document.getElementById('topbar-avatar-ini')) {
        const avatar = document.createElement('span');
        avatar.id = 'topbar-avatar-ini';
        avatar.className = 'topbar-avatar-ini topbar-avatar-ini--error';
        avatar.textContent = '!';
        userEl.parentElement?.insertBefore(avatar, userEl);
      }
      const badge = document.createElement('span');
      badge.className = 'rol-badge rol-error';
      badge.textContent = 'sin conexión';
      userEl.parentElement?.appendChild(badge);
    }, 12000);
  }

  function iniciarTopbarWidgets() {
    iniciarRelojTopbar();
    _fallbackUsuarioSiAuthFalla();

    if (window.authCtx && window.authCtx.perfil) {
      mejorarChipUsuario();
      return;
    }
    if (window.authReady && typeof window.authReady.then === 'function') {
      window.authReady.then(() => mejorarChipUsuario()).catch(() => {});
      return;
    }
    // Red de seguridad si este script corre antes de que auth.js exponga
    // window.authReady: observar #topbar-usuario y reaccionar apenas tenga texto.
    const target = document.getElementById('topbar-usuario');
    if (target) {
      const obs = new MutationObserver(() => {
        if (target.textContent.trim()) { mejorarChipUsuario(); obs.disconnect(); }
      });
      obs.observe(target, { childList: true, characterData: true, subtree: true });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Campanita de notificaciones (control en la app para diferencias
  // OC↔factura, cheques vencidos, clientes en riesgo, etc. — ver
  // GET /api/admin/alertas en lib/handlers/admin.js).
  //
  // Antes existía sólo como referencia muerta (`window.NotifManager` usado
  // en dashboard-optimizado.js pero nunca definido — ver comentario en
  // adminlte-components.css) y sólo dashboard.html tenía panel lateral de
  // alertas. Se reconstruye acá, centralizado, para que la campanita
  // aparezca en las ~20 pantallas que ya cargan este módulo (y en
  // cualquier otra que lo sume), no sólo en el Panel principal.
  //
  // NOTA: las alertas de handleAlertas() son computadas al vuelo (no tienen
  // fila propia con estado leído/no-leído, salvo las de notificaciones_push).
  // El "visto" acá es sólo local (localStorage), por sesión de navegador:
  // alcanza para no mostrar de nuevo el badge de algo que el usuario ya
  // abrió, sin necesitar una tabla nueva.
  // ─────────────────────────────────────────────────────────────────────

  const LS_KEY_VISTAS = 'notif_bell_vistas_v1';

  function _idsVistos() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_KEY_VISTAS) || '[]')); }
    catch { return new Set(); }
  }
  function _marcarVisto(id) {
    const set = _idsVistos();
    set.add(id);
    // Tope de 200 ids guardados para no crecer sin límite.
    const arr = [...set].slice(-200);
    try { localStorage.setItem(LS_KEY_VISTAS, JSON.stringify(arr)); } catch { /* noop */ }
  }

  function _tiempoRelativo(fechaISO) {
    if (!fechaISO) return '';
    const ms = Date.now() - new Date(fechaISO).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const hs = Math.floor(min / 60);
    if (hs < 24) return `hace ${hs} h`;
    return `hace ${Math.floor(hs / 24)} d`;
  }

  let _bellBtn = null, _bellBadge = null, _bellDropdown = null;
  let _bellItems = [];

  function _construirBell() {
    if (_bellBtn) return _bellBtn; // ya armada (singleton)
    const userEl = document.getElementById('topbar-usuario');
    if (!userEl || !userEl.parentElement) return null;

    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-flex';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notif-btn';
    btn.setAttribute('aria-label', 'Avisos');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

    const badge = document.createElement('span');
    badge.className = 'notif-badge';
    badge.hidden = true;

    const dropdown = document.createElement('div');
    dropdown.className = 'notif-dropdown';
    dropdown.hidden = true;
    dropdown.setAttribute('role', 'menu');

    btn.appendChild(badge);
    wrap.appendChild(btn);
    wrap.appendChild(dropdown);
    userEl.parentElement.insertBefore(wrap, userEl);

    const cerrar = () => {
      dropdown.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!dropdown.hidden) { cerrar(); return; }
      dropdown.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      // Al abrir, se marcan como vistas (deja de sumar al badge, no borra
      // el historial: la próxima carga desde el servidor decide si el
      // ítem sigue vigente o no).
      _bellItems.forEach((it) => _marcarVisto(it.id));
      _actualizarBadge();
    });
    document.addEventListener('click', cerrar);
    dropdown.addEventListener('click', (ev) => ev.stopPropagation());
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') cerrar(); });

    _bellBtn = btn; _bellBadge = badge; _bellDropdown = dropdown;
    return btn;
  }

  function _actualizarBadge() {
    if (!_bellBadge) return;
    const vistos = _idsVistos();
    const sinVer = _bellItems.filter((it) => it.id && !vistos.has(it.id)).length;
    if (sinVer > 0) {
      _bellBadge.hidden = false;
      _bellBadge.textContent = sinVer > 9 ? '9+' : String(sinVer);
    } else {
      _bellBadge.hidden = true;
    }
  }

  // El server ya manda hasta 8 (`?limite=8` en _fetchAlertasBell), ordenadas
  // por created_at desc — pero mostrar las 8 en el dropdown lo convertía en
  // una lista larga con avisos de hace 250+ días mezclados con lo urgente
  // del día. El dropdown ahora solo muestra las últimas DISPLAY_LIMIT y
  // cierra con un link a /admin/avisos — _bellItems sigue guardando el
  // total fetcheado (no solo las que se muestran) para que el badge de
  // "sin ver" siga contando bien.
  //
  // OJO: el link va a /admin/avisos, NO a /admin/notif-log. Son dos páginas
  // distintas pese al nombre parecido — notif-log.html sólo lee la tabla
  // `notificaciones_push` (el log real de envíos push/email/WhatsApp, acá
  // suele haber muy pocas filas). avisos.js en cambio pega contra el MISMO
  // endpoint que arma esta campanita (`GET /api/admin/alertas`, ver
  // handleAlertas en lib/handlers/admin.js) con un límite más alto — ahí sí
  // aparecen pedidos sin despachar, cheques vencidos, migraciones con
  // error y facturas con diferencias, que es lo que efectivamente se ve en
  // el dropdown.
  const DISPLAY_LIMIT = 5;
  const HREF_VER_TODAS = '/admin/avisos';

  function _renderDropdown() {
    if (!_bellDropdown) return;
    if (!_bellItems.length) {
      _bellDropdown.innerHTML =
        '<div class="notif-header">Avisos</div>' +
        '<div class="notif-item" style="cursor:default"><div class="notif-texto" style="color:var(--color-text-muted)">Sin novedades por ahora.</div></div>';
      return;
    }
    const vistos = _idsVistos();
    const visibles = _bellItems.slice(0, DISPLAY_LIMIT);
    const filas = visibles.map((it) => {
      const sinVer = it.id && !vistos.has(it.id);
      return `<div class="notif-item" data-href="${it.href ? window.sanitize ? window.sanitize(it.href) : it.href : ''}">
        <span class="notif-dot" style="${sinVer ? '' : 'background:var(--color-border,#DDE1DC)'}"></span>
        <div>
          <div class="notif-texto"><strong>${it.titulo || 'Alerta'}</strong>${it.desc ? ' — ' + it.desc : ''}</div>
          <div class="notif-tiempo">${_tiempoRelativo(it.fecha)}</div>
        </div>
      </div>`;
    }).join('');
    const footer = `<div class="notif-footer" data-href="${HREF_VER_TODAS}">Ver más notificaciones</div>`;
    _bellDropdown.innerHTML = `<div class="notif-header">Avisos</div>${filas}${footer}`;
    _bellDropdown.querySelectorAll('[data-href]').forEach((el) => {
      const href = el.getAttribute('data-href');
      if (!href) return;
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => { window.location.href = href; });
    });
  }

  // API pública: acepta items ya en el shape de handleAlertas
  // ({titulo, cuerpo|desc, created_at|fecha, leido|leida, link|href, id})
  // para poder reusarse tal cual desde dashboard-optimizado.js.
  function _bellSetItems(items) {
    _construirBell();
    _bellItems = (items || []).map((it) => ({
      id:    it.id ?? `${it.tipo || 'alerta'}-${it.titulo || ''}-${it.fecha || it.created_at || ''}`,
      titulo: it.titulo || 'Alerta',
      desc:   it.desc ?? it.cuerpo ?? '',
      fecha:  it.fecha ?? it.created_at ?? null,
      href:   it.href ?? it.link ?? null,
    }));
    _renderDropdown();
    _actualizarBadge();
  }

  // Compatibilidad con el código ya existente en dashboard-optimizado.js
  // (`new window.NotifManager({items:[]})` + `.setItems(...)`), que hasta
  // ahora fallaba en silencio porque la clase no existía.
  window.NotifManager = class NotifManager {
    constructor({ items = [] } = {}) { this.setItems(items); }
    setItems(items) { _bellSetItems(items); }
  };

  async function _fetchAlertasBell() {
    try {
      const authCtx = window.authCtx || await window.authReady;
      const sb = authCtx?.sb;
      const sess = sb ? (await sb.auth.getSession()).data.session : null;
      if (!sess) return;
      const r = await fetch('/api/admin/alertas?limite=8', {
        headers: { Authorization: `Bearer ${sess.access_token}` },
      });
      if (!r.ok) return;
      const data = await r.json();
      _bellSetItems(data?.alertas || []);
    } catch (err) {
      console.warn('[topbar-widgets] alertas campanita:', err.message);
    }
  }

  function iniciarCampanita() {
    _construirBell();
    _fetchAlertasBell();
    // Poll suave: alcanza para que una diferencia OC↔factura recién
    // detectada, un cheque que venció, etc. aparezcan sin recargar la
    // página, sin generar tráfico excesivo.
    setInterval(_fetchAlertasBell, 120000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarTopbarWidgets);
  } else {
    iniciarTopbarWidgets();
  }

  if (window.authCtx && window.authCtx.perfil) {
    iniciarCampanita();
  } else if (window.authReady && typeof window.authReady.then === 'function') {
    window.authReady.then(iniciarCampanita).catch(() => {});
  }

  // Se exponen globalmente por compatibilidad con código existente que
  // pudiera llamarlas directamente (ninguno lo hacía al momento del fix,
  // pero evita romper integraciones futuras).
  window.iniciarRelojTopbar = iniciarRelojTopbar;
  window.mejorarChipUsuario = mejorarChipUsuario;
})();
