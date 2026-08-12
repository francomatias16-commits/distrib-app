// frontend/admin/js/busqueda-global.js
// REQ-09: Búsqueda global en header admin.
// Incluir en cada página DESPUÉS de auth.js.
// Inyecta el input en .topbar-right y gestiona el dropdown de resultados.
// v3: Etapa 2 — usa window.authReady (puerta unificada).
//
// [Limpieza zócalo] Buscador retirado del topbar a pedido — se desactiva
// acá (early return) en vez de sacar el <script> de cada una de las ~40
// páginas que lo cargan, para mantener un solo punto de cambio. El resto
// del archivo (lógica de búsqueda/dropdown) queda sin usar pero intacto
// por si se reactiva más adelante.

(function () {
  return; // [Limpieza zócalo] buscador global deshabilitado en todas las páginas.

  // eslint-disable-next-line no-unreachable
  window.authReady
    .then(function (authCtx) {
      const sb = authCtx.sb;

    // ── Inyectar HTML ──────────────────────────────────────────────────────
    const topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight) return;

    const wrap = document.createElement('div');
    wrap.id        = 'busq-global-wrap';
    wrap.innerHTML = `
      <div class="busq-global-inner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          id="busq-global-input"
          type="text"
          placeholder="Buscar…"
          autocomplete="off"
          spellcheck="false"
        />
        <kbd class="busq-atajo">Ctrl+K</kbd>
      </div>
      <div id="busq-global-dropdown" class="busq-dropdown" hidden></div>
    `;

    const userSpan = topbarRight.querySelector('.topbar-usuario');
    topbarRight.insertBefore(wrap, userSpan || null);

    // ── Estilos ────────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
      #busq-global-wrap {
        position: relative;
        flex: 1;
        max-width: 300px;
      }
      .busq-global-inner {
        display: flex;
        align-items: center;
        gap: 6px;
        background: var(--color-surface, #FCFAF5);
        border: 1px solid var(--color-border, #C7BFA9);
        border-radius: var(--radius-md, 6px);
        padding: 5px 10px;
        transition: border-color .15s, background .15s;
      }
      .busq-global-inner svg { flex-shrink: 0; color: var(--color-text-muted, #4B4A45); }
      .busq-global-inner:focus-within {
        border-color: var(--color-primary, #B87A00);
        background: var(--color-bg, #F5F2EA);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary,#B87A00) 12%, transparent);
      }
      #busq-global-input {
        flex: 1;
        border: none;
        background: transparent;
        font-size: 13px;
        color: var(--color-text, #16181D);
        outline: none;
        min-width: 0;
      }
      #busq-global-input::placeholder { color: var(--color-text-muted, #4B4A45); }
      .busq-atajo {
        font-size: 11px;
        color: var(--color-text-muted, #4B4A45);
        background: var(--color-bg, #F5F2EA);
        border: 1px solid var(--color-border, #C7BFA9);
        border-radius: 4px;
        padding: 1px 5px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .busq-global-inner:focus-within .busq-atajo { display: none; }

      /* Dropdown */
      .busq-dropdown {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        min-width: 320px;
        background: var(--color-bg, #F5F2EA);
        border: 1px solid var(--color-border, #C7BFA9);
        border-radius: var(--radius-md, 6px);
        box-shadow: 0 8px 32px rgba(0,0,0,.14);
        z-index: 9999;
        max-height: 440px;
        overflow-y: auto;
      }
      .busq-section-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--color-text-muted, #4B4A45);
        text-transform: uppercase;
        letter-spacing: .06em;
        padding: 10px 14px 4px;
      }
      .busq-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        cursor: pointer;
        text-decoration: none;
        color: var(--color-text, #16181D);
        font-size: 13px;
        transition: background .1s;
      }
      .busq-item:hover, .busq-item.busq-focused {
        background: var(--color-surface, #FCFAF5);
      }
      .busq-item-icon {
        width: 28px;
        height: 28px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-size: 12px;
        font-weight: 700;
      }
      .busq-icon-cliente  { background: var(--color-info-bg,#DCE6EC); color: var(--color-info,#1E3A52); }
      .busq-icon-producto { background: var(--color-success-bg,#DCEDE3); color: var(--color-success,#17402F); }
      .busq-icon-pedido   { background: var(--color-warning-bg,#FBEBC7); color: var(--color-warning,#7A4A00); }
      .busq-icon-presup   { background: var(--pill-purple-bg,#EDE4F5); color: var(--pill-purple-text,#5B4A8F); }
      .busq-icon-factura  { background: var(--pill-pink-bg,#F5E4EC); color: var(--pill-pink-text,#8F3A5C); }
      .busq-icon-cheque   { background: var(--pill-orange-bg,#F0DCC0); color: var(--pill-orange-text,#8F5F00); }
      .busq-item-main { flex: 1; min-width: 0; }
      .busq-item-nombre {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .busq-item-sub {
        font-size: 11px;
        color: var(--color-text-muted, #4B4A45);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .busq-item-badge {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 10px;
        flex-shrink: 0;
        font-weight: 600;
      }
      .busq-badge-verde   { background: var(--color-success-bg,#DCEDE3); color: var(--color-success,#17402F); }
      .busq-badge-amarillo{ background: var(--color-warning-bg,#FBEBC7); color: var(--color-warning,#7A4A00); }
      .busq-badge-rojo    { background: var(--color-danger-bg,#F3DAD8); color: var(--color-danger,#7A1E19); }
      .busq-badge-gris    { background: var(--pill-neutral-bg,#EAE4D6); color: var(--pill-neutral-text,#4B4A45); }
      .busq-vacio {
        padding: 24px 14px;
        text-align: center;
        color: var(--color-text-muted, #4B4A45);
        font-size: 13px;
      }
      .busq-sep { border-top: 1px solid var(--color-border, #C7BFA9); margin: 4px 0; }
      .busq-highlight { background: var(--color-warning-bg,#FBEBC7); border-radius: 2px; padding: 0 1px; }
      .busq-footer {
        padding: 8px 14px;
        border-top: 1px solid var(--color-border, #C7BFA9);
        font-size: 11px;
        color: var(--color-text-muted, #4B4A45);
        display: flex;
        gap: 12px;
      }
      .busq-footer kbd {
        background: var(--color-surface, #FCFAF5);
        border: 1px solid var(--color-border, #C7BFA9);
        border-radius: 3px;
        padding: 1px 4px;
        font-size: 10px;
      }
    `;
    document.head.appendChild(style);

    // ── Estado ─────────────────────────────────────────────────────────────
    const input    = document.getElementById('busq-global-input');
    const dropdown = document.getElementById('busq-global-dropdown');
    let debounceTimer = null;
    let focusIdx = -1;

    // ── Atajos de teclado ──────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        input.focus();
        input.select();
      }
      if (e.key === 'Escape' && !dropdown.hidden) {
        cerrarDropdown();
        input.blur();
      }
    });

    // ── Navegación con flechas ─────────────────────────────────────────────
    input.addEventListener('keydown', e => {
      const items = dropdown.querySelectorAll('.busq-item');
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusIdx = Math.min(focusIdx + 1, items.length - 1);
        actualizarFocus(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusIdx = Math.max(focusIdx - 1, 0);
        actualizarFocus(items);
      } else if (e.key === 'Enter' && focusIdx >= 0) {
        items[focusIdx]?.click();
      }
    });

    function actualizarFocus(items) {
      items.forEach((el, i) => el.classList.toggle('busq-focused', i === focusIdx));
      if (items[focusIdx]) items[focusIdx].scrollIntoView({ block: 'nearest' });
    }

    // ── Input listener ─────────────────────────────────────────────────────
    input.addEventListener('input', () => {
      const q = input.value.trim();
      focusIdx = -1;
      clearTimeout(debounceTimer);
      if (q.length < 2) { cerrarDropdown(); return; }
      dropdown.hidden = false;
      dropdown.innerHTML = `<div class="busq-vacio">Buscando…</div>`;
      debounceTimer = setTimeout(() => buscar(q), 280);
    });

    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2) dropdown.hidden = false;
    });

    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) cerrarDropdown();
    });

    function cerrarDropdown() {
      dropdown.hidden = true;
      focusIdx = -1;
    }

    // ── Buscar ─────────────────────────────────────────────────────────────
    // Etapa 3 (hallazgo Media): antes 401/429/500 mostraban el mismo mensaje
    // genérico "Error al buscar. Intentá de nuevo." — en un 429 eso invita a
    // reintentar de inmediato, agravando el rate limit. Ahora diferenciamos
    // por código HTTP y aplicamos un cooldown breve tras un 429.
    let _cooldownHasta = 0;

    async function buscar(q) {
      if (Date.now() < _cooldownHasta) {
        const seg = Math.ceil((_cooldownHasta - Date.now()) / 1000);
        dropdown.innerHTML = `<div class="busq-vacio">Demasiadas búsquedas — esperá ${seg}s…</div>`;
        return;
      }

      try {
        const { data: { session } } = await sb.auth.getSession();
        const tok = session?.access_token;
        if (!tok) return;

        const r = await fetch(`/api/busqueda?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${tok}` },
        });

        if (r.status === 429) {
          _cooldownHasta = Date.now() + 8000; // 8s de backoff antes de permitir otro fetch
          dropdown.innerHTML = `<div class="busq-vacio">Demasiadas búsquedas, esperá unos segundos…</div>`;
          return;
        }
        if (r.status === 401) {
          dropdown.innerHTML = `<div class="busq-vacio">Tu sesión expiró — recargá la página.</div>`;
          return;
        }
        if (!r.ok) {
          console.error('[busqueda-global] respuesta no OK:', r.status);
          dropdown.innerHTML = `<div class="busq-vacio">Error al buscar (servidor). Intentá de nuevo.</div>`;
          return;
        }

        const res = await r.json();
        renderResultados(res, q);
      } catch (err) {
        console.error('[busqueda-global] error de red:', err?.message);
        dropdown.innerHTML = `<div class="busq-vacio">Error de conexión. Intentá de nuevo.</div>`;
      }
    }

    // ── Helpers ────────────────────────────────────────────────────────────
    function esc(s) {
      // Consolidado: delega a la única fuente de verdad (ui-utils.js).
      return window.sanitize(s);
    }
    function fmt(n) {
      return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0 });
    }
    function highlight(texto, q) {
      const safe = esc(texto);
      if (!q) return safe;
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      return safe.replace(re, '<mark class="busq-highlight">$1</mark>');
    }
    function badgeEstado(estado) {
      const mapa = {
        pendiente: 'amarillo', nuevo: 'amarillo', abierto: 'amarillo', parcial: 'amarillo',
        confirmado: 'verde', cobrado: 'verde', emitida: 'verde', en_cartera: 'verde', activo: 'verde',
        cancelado: 'rojo', rechazado: 'rojo', anulada: 'rojo',
        entregado: 'gris', depositado: 'gris', endosado: 'gris', cerrado: 'gris',
      };
      const color = mapa[(estado || '').toLowerCase()] || 'gris';
      const label = (estado || '').replace(/_/g,' ');
      return `<span class="busq-item-badge busq-badge-${color}">${esc(label)}</span>`;
    }

    // ── Render ─────────────────────────────────────────────────────────────
    function renderResultados({ clientes=[], productos=[], pedidos=[], presupuestos=[], facturas=[], cheques=[] }, q) {
      const total = clientes.length + productos.length + pedidos.length + presupuestos.length + facturas.length + cheques.length;

      if (total === 0) {
        dropdown.innerHTML = `<div class="busq-vacio">Sin resultados para "<strong>${esc(q)}</strong>"</div>`;
        return;
      }

      let html = '';
      let count = 0;

      if (clientes.length) {
        html += `<div class="busq-section-title">Clientes</div>`;
        clientes.forEach(c => {
          const nombre = c.nombre_fantasia || c.razon_social;
          html += `<a class="busq-item" href="/frontend/admin/clientes.html#${c.id}">
            <div class="busq-item-icon busq-icon-cliente">C</div>
            <div class="busq-item-main">
              <div class="busq-item-nombre">${highlight(nombre, q)}</div>
              ${c.cuit ? `<div class="busq-item-sub">CUIT ${esc(c.cuit)}</div>` : ''}
            </div>
          </a>`;
          count++;
        });
      }

      if (productos.length) {
        if (html) html += '<div class="busq-sep"></div>';
        html += `<div class="busq-section-title">Productos</div>`;
        productos.forEach(p => {
          html += `<a class="busq-item" href="/frontend/admin/productos.html#${p.id}">
            <div class="busq-item-icon busq-icon-producto">P</div>
            <div class="busq-item-main">
              <div class="busq-item-nombre">${highlight(p.nombre, q)}</div>
              <div class="busq-item-sub">${esc(p.codigo)}${p.unidad ? ' · ' + esc(p.unidad) : ''}</div>
            </div>
          </a>`;
          count++;
        });
      }

      if (pedidos.length) {
        if (html) html += '<div class="busq-sep"></div>';
        html += `<div class="busq-section-title">Pedidos</div>`;
        pedidos.forEach(p => {
          const cli = p.clientes?.nombre_fantasia || p.clientes?.razon_social || '';
          const nro = p.id.slice(-8).toUpperCase();
          html += `<a class="busq-item" href="/frontend/admin/pedidos.html#${p.id}">
            <div class="busq-item-icon busq-icon-pedido">O</div>
            <div class="busq-item-main">
              <div class="busq-item-nombre">${highlight(nro, q)}</div>
              <div class="busq-item-sub">${esc(cli)} · $${fmt(p.total)}</div>
            </div>
            ${badgeEstado(p.estado)}
          </a>`;
          count++;
        });
      }

      if (presupuestos.length) {
        if (html) html += '<div class="busq-sep"></div>';
        html += `<div class="busq-section-title">Presupuestos</div>`;
        presupuestos.forEach(p => {
          const cli = p.clientes?.nombre_fantasia || p.clientes?.razon_social || '';
          html += `<a class="busq-item" href="/frontend/admin/presupuestos.html#${p.id}">
            <div class="busq-item-icon busq-icon-presup">$</div>
            <div class="busq-item-main">
              <div class="busq-item-nombre">${highlight(p.numero, q)}</div>
              <div class="busq-item-sub">${esc(cli)}</div>
            </div>
            ${badgeEstado(p.estado)}
          </a>`;
          count++;
        });
      }

      if (facturas.length) {
        if (html) html += '<div class="busq-sep"></div>';
        html += `<div class="busq-section-title">Facturas</div>`;
        facturas.forEach(f => {
          const cli = f.clientes?.nombre_fantasia || f.clientes?.razon_social || '';
          html += `<a class="busq-item" href="/frontend/admin/facturacion.html#${f.id}">
            <div class="busq-item-icon busq-icon-factura">F</div>
            <div class="busq-item-main">
              <div class="busq-item-nombre">${highlight(f.numero || f.id.slice(-8), q)}</div>
              <div class="busq-item-sub">${esc(cli)} · $${fmt(f.total)}</div>
            </div>
            ${badgeEstado(f.estado)}
          </a>`;
          count++;
        });
      }

      if (cheques.length) {
        if (html) html += '<div class="busq-sep"></div>';
        html += `<div class="busq-section-title">Cheques</div>`;
        cheques.forEach(ch => {
          const cli = ch.clientes?.nombre_fantasia || ch.clientes?.razon_social || '';
          const vto = ch.vencimiento ? new Date(ch.vencimiento).toLocaleDateString('es-AR') : '';
          html += `<a class="busq-item" href="/frontend/admin/cheques.html#${ch.id}">
            <div class="busq-item-icon busq-icon-cheque">CH</div>
            <div class="busq-item-main">
              <div class="busq-item-nombre">#${highlight(ch.numero || '', q)}</div>
              <div class="busq-item-sub">${esc(cli)}${vto ? ' · vto. ' + vto : ''} · $${fmt(ch.monto)}</div>
            </div>
            ${badgeEstado(ch.estado)}
          </a>`;
          count++;
        });
      }

      // Footer con hints de teclado
      html += `<div class="busq-footer">
        <span><kbd>↑↓</kbd> navegar</span>
        <span><kbd>Enter</kbd> abrir</span>
        <span><kbd>Esc</kbd> cerrar</span>
        <span style="margin-left:auto">${count} resultado${count !== 1 ? 's' : ''}</span>
      </div>`;

      dropdown.innerHTML = html;

      dropdown.querySelectorAll('.busq-item').forEach(el => {
        el.addEventListener('click', () => {
          cerrarDropdown();
          input.value = '';
        });
      });
    }  // cierre de renderResultados
  })  // cierre del .then(function(authCtx) { ... })
  .catch(err => {
      console.error('[busqueda-global] Error de autenticación:', err.message);
      // La búsqueda no aparecerá si auth falla, pero no quebrantamos la página
    });
})();
