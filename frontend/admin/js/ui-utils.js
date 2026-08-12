// frontend/admin/js/ui-utils.js
// Utilidades UI globales compartidas por todas las páginas del admin.

/**
 * Muestra filas skeleton en una tabla mientras cargan los datos.
 * @param {string} tbodyId  - id del <tbody> a poblar
 * @param {number} filas    - cantidad de filas skeleton (default 5)
 * @param {number} cols     - cantidad de columnas (default 4)
 */
window.mostrarSkeletonTabla = function (tbodyId, filas = 5, cols = 4) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = Array.from({ length: filas }, () => `
    <tr class="sk-row sk-row--${cols}">
      ${Array.from({ length: cols }, () => '<td><div class="sk-cell"></div></td>').join('')}
    </tr>
  `).join('');
};

// Alias para compatibilidad con dashboard-optimizado.js
window.renderSkeletonTabla = window.mostrarSkeletonTabla;

// ─── renderFragment / renderTbody ────────────────────────────────────────────
// Equivalente global de admin-utils.js (que usa ES module exports y no se carga
// como script clásico en ningún HTML).

window.renderFragment = function (container, items, templateFn, emptyHtml = '') {
  container.innerHTML = '';
  if (!items || items.length === 0) {
    if (emptyHtml) container.innerHTML = emptyHtml;
    return;
  }
  const frag = document.createDocumentFragment();
  const tmp  = document.createElement('template');
  items.forEach((item) => {
    tmp.innerHTML = templateFn(item).trim();
    frag.appendChild(tmp.content.cloneNode(true));
  });
  container.appendChild(frag);
};

window.renderTbody = function (tbody, rows, rowFn, emptyColspan = 8, emptyMessage = 'Todavía no cargaste nada acá') {
  const emptyHtml = `<tr><td colspan="${emptyColspan}" class="tabla-empty">${emptyMessage}</td></tr>`;
  window.renderFragment(tbody, rows, rowFn, emptyHtml);
};

// ─── Toast ───────────────────────────────────────────────────────────────────
(function () {
  let _toastEl, _toastTimer;

  // [Etapa 3 — hallazgo Alta] Distintos módulos llaman a toast/mostrarToast
  // con sinónimos de tipo ('err', 'error', 'ok', 'exito', 'warn', etc.).
  // Solo existen tres modificadores reales en tokens.css: --success/--danger/--warning.
  // Normalizamos acá para que cualquier variante caiga en la clase correcta.
  const TIPO_ALIAS = {
    error: 'danger', err: 'danger', danger: 'danger',
    exito: 'success', ok: 'success', success: 'success',
    warn: 'warning', warning: 'warning',
  };

  function toast(mensaje, tipo = 'default', duracionMs = 3000) {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.className = 'toast';
      document.body.appendChild(_toastEl);
    }
    const tipoNormalizado = TIPO_ALIAS[tipo] || (tipo === 'default' ? 'default' : tipo);
    clearTimeout(_toastTimer);
    _toastEl.className = 'toast';
    if (tipoNormalizado !== 'default') _toastEl.classList.add(`toast--${tipoNormalizado}`);
    _toastEl.textContent = mensaje;
    void _toastEl.offsetHeight;
    _toastEl.classList.add('toast--visible');
    _toastTimer = setTimeout(() => _toastEl.classList.remove('toast--visible'), duracionMs);
  }

  window.toast = toast;
  window.mostrarToast = toast; // alias usado en stock.js, pedidos.js, etc.
})();

// ─── Preloader único (Etapa 3 — hallazgo Media: 3 reimplementaciones) ────────
/**
 * Oculta un overlay de preloader con fade y failsafe por timeout.
 * Reemplaza las copias locales de dashboard.html y dashboard-optimizado.js
 * (también existió una copia en dashboard-control-tower.js, borrado en v273).
 * @param {string} selector   - selector CSS del elemento a ocultar (default '#app-preloader')
 * @param {number} timeoutMs  - ms antes de forzar remove() aunque no haya transición (default 300)
 */
window.ocultarPreloader = function (selector = '#app-preloader', timeoutMs = 300) {
  const el = document.querySelector(selector);
  if (!el || el.dataset.oculto === '1') return;
  el.dataset.oculto = '1';
  el.style.opacity = '0';
  el.classList.add('oculto');
  setTimeout(() => el.remove(), timeoutMs);
};

// ─── Formato moneda / fecha ───────────────────────────────────────────────────
const _FMT_ARS = new Intl.NumberFormat('es-AR', {
  style: 'currency', currency: 'ARS', minimumFractionDigits: 0,
});
window.formatARS   = (n) => _FMT_ARS.format(n ?? 0);
window.formatFecha = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
};
window.formatHora = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
};

// ─── Estado vacío ─────────────────────────────────────────────────────────────
/**
 * Muestra un estado vacío (empty state) en un contenedor.
 * @param {string} containerId  - id del elemento contenedor (tbody, div, etc.)
 * @param {object} opts
 * @param {string} opts.icono        - emoji o texto de ícono
 * @param {string} opts.titulo       - título principal
 * @param {string} opts.descripcion  - texto descriptivo
 * @param {string} [opts.ctaLabel]   - texto del botón/link opcional
 * @param {string} [opts.ctaHref]    - href del botón/link opcional (ignorado si se pasa ctaOnClick)
 * @param {string} [opts.ctaOnClick] - expresión JS a ejecutar al click (ej. 'abrirModalNuevo()'), para
 *                                     cuando la acción no es navegar sino abrir un modal/función local.
 * @param {number} [opts.colspan]    - colspan para celdas td (default 8)
 */
window.mostrarEstadoVacio = function (containerId, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const { icono = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>', titulo = 'Sin resultados', descripcion = '', ctaLabel, ctaHref, ctaOnClick, colspan = 8 } = opts;

  const cta = ctaLabel
    ? (ctaOnClick
        ? `<a href="javascript:void(0)" onclick="${ctaOnClick}" class="empty-state__cta">${ctaLabel}</a>`
        : `<a href="${ctaHref || '#'}" class="empty-state__cta">${ctaLabel}</a>`)
    : '';

  const html = `
    <div class="empty-state">
      <span class="empty-state__icon">${icono}</span>
      <p class="empty-state__titulo">${titulo}</p>
      ${descripcion ? `<p class="empty-state__sub">${descripcion}</p>` : ''}
      ${cta}
    </div>`;

  // Si el contenedor es un tbody, envolver en tr/td
  const tag = el.tagName.toLowerCase();
  if (tag === 'tbody') {
    el.innerHTML = `<tr><td colspan="${colspan}" class="empty-state-cell">${html}</td></tr>`;
  } else {
    el.innerHTML = html;
  }
};

// ─── Loading skeleton ─────────────────────────────────────────────────────────
window.loadingStart = function (container) {
  container.classList.add('sk-loading');
  container.setAttribute('aria-busy', 'true');
};
window.loadingEnd = function (container) {
  container.classList.remove('sk-loading');
  container.classList.add('sk-reveal');
  container.removeAttribute('aria-busy');
  container.addEventListener('animationend', () => container.classList.remove('sk-reveal'), { once: true });
};

// ─── Confirmar (modal liviano, reemplaza confirm() nativo) ────────────────────
/**
 * Reemplaza window.confirm() por un diálogo accesible con el estilo de la app
 * (mismas variables --color-surface/--radius-lg/--shadow-xl que el resto del admin).
 * Equivalente global de confirmar() en admin-utils.js — mismo contrato, mismo
 * markup, para que las páginas con script clásico y las que usan módulos ES6
 * se vean idénticas. No se consolidan en un solo archivo por el mismo motivo
 * que toast/memoGet/renderTbody: evitar romper páginas que ya cargan una u otra.
 * @param {string} mensaje
 * @param {object}  [opts]
 * @param {string}  [opts.labelOk='Confirmar']
 * @param {string}  [opts.labelCancel='Cancelar']
 * @param {'default'|'danger'} [opts.tipo='default']  - 'danger' resalta el botón
 *        de confirmación en rojo y suma un ícono de advertencia, para bajas,
 *        eliminaciones o acciones que no se pueden deshacer.
 * @returns {Promise<boolean>}
 */
const SVG_ALERTA = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom:.5rem;color:var(--color-danger,#7A1E19)"><path d="M12 9v4"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 17h.01"/></svg>';

window.confirmar = function (mensaje, opts = {}) {
  const { labelOk = 'Confirmar', labelCancel = 'Cancelar', tipo = 'default' } = opts;
  const esDanger = tipo === 'danger';

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-label="${mensaje}"
           style="position:fixed;inset:0;z-index:var(--z-modal,400);
                  display:flex;align-items:center;justify-content:center;
                  background:rgba(0,0,0,.45);padding:1rem">
        <div style="background:var(--color-surface);border-radius:var(--radius-lg);
                    padding:1.5rem;max-width:360px;width:100%;box-shadow:var(--shadow-xl)">
          ${esDanger ? SVG_ALERTA : ''}
          <p style="margin:0 0 1.25rem;font-size:.9375rem;color:var(--color-text);line-height:1.45">${mensaje}</p>
          <div style="display:flex;gap:.75rem;justify-content:flex-end">
            <button data-action="cancel" class="btn btn--ghost btn--sm">${labelCancel}</button>
            <button data-action="ok" class="btn ${esDanger ? 'btn--danger' : 'btn--primary'} btn--sm">${labelOk}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(false); };

    function cleanup(result) {
      document.removeEventListener('keydown', onKeydown);
      document.body.removeChild(overlay);
      resolve(result);
    }

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'ok')     cleanup(true);
      if (action === 'cancel') cleanup(false);
    });

    document.addEventListener('keydown', onKeydown);
  });
};

// ─── ConfirmarConTexto — como confirmar(), pero exige un motivo escrito ───────
// Uso: para bajas/anulaciones donde queremos dejar rastro de auditoría del
// por qué (ej. anular una venta POS). Devuelve el texto del motivo (string,
// ya trimeado) si el usuario confirma, o null si cancela. Con
// opts.requerido !== false, el botón de confirmar queda deshabilitado hasta
// que haya texto.
/**
 * @param {string} mensaje
 * @param {object} [opts]
 * @param {string} [opts.labelOk='Confirmar']
 * @param {string} [opts.labelCancel='Cancelar']
 * @param {string} [opts.placeholder='Motivo...']
 * @param {boolean} [opts.requerido=true]
 * @returns {Promise<string|null>}
 */
window.confirmarConTexto = function (mensaje, opts = {}) {
  const {
    labelOk = 'Confirmar', labelCancel = 'Cancelar',
    placeholder = 'Motivo...', requerido = true,
  } = opts;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-label="${mensaje}"
           style="position:fixed;inset:0;z-index:var(--z-modal,400);
                  display:flex;align-items:center;justify-content:center;
                  background:rgba(0,0,0,.45);padding:1rem">
        <div style="background:var(--color-surface);border-radius:var(--radius-lg);
                    padding:1.5rem;max-width:380px;width:100%;box-shadow:var(--shadow-xl)">
          ${SVG_ALERTA}
          <p style="margin:0 0 .75rem;font-size:.9375rem;color:var(--color-text);line-height:1.45">${mensaje}</p>
          <textarea data-role="motivo" rows="2" maxlength="200" placeholder="${placeholder}"
            style="width:100%;resize:vertical;margin-bottom:1.25rem;padding:.5rem;
                   border:1px solid var(--color-border,#C7BFA9);border-radius:var(--radius-sm);
                   font-family:inherit;font-size:.875rem;background:var(--color-bg);
                   color:var(--color-text)"></textarea>
          <div style="display:flex;gap:.75rem;justify-content:flex-end">
            <button data-action="cancel" class="btn btn--ghost btn--sm">${labelCancel}</button>
            <button data-action="ok" class="btn btn--danger btn--sm" ${requerido ? 'disabled' : ''}>${labelOk}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector('[data-role="motivo"]');
    const btnOk     = overlay.querySelector('[data-action="ok"]');

    if (requerido) {
      textarea.addEventListener('input', () => {
        btnOk.disabled = !textarea.value.trim();
      });
    }

    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(null); };

    function cleanup(result) {
      document.removeEventListener('keydown', onKeydown);
      document.body.removeChild(overlay);
      resolve(result);
    }

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'ok' && !btnOk.disabled) cleanup(textarea.value.trim());
      if (action === 'cancel') cleanup(null);
    });

    document.addEventListener('keydown', onKeydown);
    setTimeout(() => textarea.focus(), 60);
  });
};

// ─── btnAsyncClick — anti-doble-click universal ──────────────────────────────
// Uso: onclick="btnAsyncClick(this, miFuncion)"
// Con confirmación: onclick="btnAsyncClick(this, miFuncion, {confirm:true, confirmMsg:'¿Seguro?'})"
//
window.btnAsyncClick = async function (btn, fn, opts = {}) {
  if (!btn || btn.disabled || btn.classList.contains('btn--loading')) return;

  if (opts.confirm) {
    const msg = opts.confirmMsg || '¿Confirmar esta acción?';
    const ok = await window.confirmar(msg, { tipo: opts.confirmTipo || 'danger' });
    if (!ok) return;
  }

  btn.classList.add('btn--loading');
  btn.disabled = true;

  try {
    await fn();
  } catch (err) {
    console.error('[btnAsyncClick]', err);
    if (window.toast) window.toast('Ocurrió un error. Intentá de nuevo.', 'error');
  } finally {
    btn.classList.remove('btn--loading');
    btn.disabled = false;
  }
};

// ─── syncTabAria — sincroniza aria-selected en sistemas de tabs ──────────────
// Llamar desde selTab / cambiarTab / switchTab existentes:
//   syncTabAria('mi-tablist-id', 'id-del-tab-activo')
//
window.syncTabAria = function (tablistId, activeTabId) {
  const tablist = document.getElementById(tablistId);
  if (!tablist) return;
  tablist.querySelectorAll('[role="tab"]').forEach(tab => {
    const isActive = tab.id === activeTabId;
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.classList.toggle('activa',  isActive);
    tab.classList.toggle('activo',  isActive);
    tab.classList.toggle('active',  isActive);
  });
};

// ─── Modal focus trap ─────────────────────────────────────────────────────────
// window.modalFocusTrap.activate(modalEl) / .deactivate()
//
window.modalFocusTrap = (function () {
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let _modal = null;

  function onKeydown(e) {
    if (e.key !== 'Tab' || !_modal) return;
    const focusable = [..._modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  }

  return {
    activate(modal) {
      _modal = modal;
      document.addEventListener('keydown', onKeydown);
      const first = modal.querySelector(FOCUSABLE);
      if (first) setTimeout(() => first.focus(), 50);
    },
    deactivate() {
      document.removeEventListener('keydown', onKeydown);
      _modal = null;
    }
  };
})();

// ─── Escape key global para cerrar modales ───────────────────────────────────
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  // Buscar modal visible (overlay o backdrop)
  const visible = [...document.querySelectorAll('.modal-overlay, .modal')]
    .find(el => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    });
  if (!visible) return;
  const closeBtn = visible.querySelector('[aria-label="Cerrar"], .modal-close, .modal-box-close, .modal-cerrar');
  if (closeBtn) closeBtn.click();
});

// ─── XSS: sanitización de datos de usuario ──────────────────────────────────
// Usar siempre que se inserte un valor de usuario en innerHTML.
// Para texto plano puro, preferir el.textContent = valor directamente.
//
// Uso:
//   el.innerHTML = `<span>${sanitize(cliente.nombre)}</span>`;
//
window.sanitize = function (str) {
  if (str === null || str === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
};

// Alias corto para templates con muchos campos
window.s = window.sanitize;

// ─── Fecha de "hoy" en hora Argentina, no UTC ───────────────────────────────
// FIX (auditoría UX etapa 16, Hallazgo 1): `new Date().toISOString().split('T')[0]`
// da la fecha en UTC. Como Argentina es UTC-3 todo el año, entre las 21:00 y
// las 00:00 hora Argentina esa línea devuelve la fecha de MAÑANA, no la de
// hoy -- vaciaba rutas.js/rutas-resumen.js (dashboard) y corrompía la fecha
// precargada en cheques.js/cta-cte.js/notas.js. Mismo patrón que ya se usaba
// bien en el backend (lib/handlers/admin.js).
window.hoyLocalISO = function () {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
};

// ─── Redondeo automático de montos en pesos ─────────────────────────────────
// Los inputs de dinero (precios, costos, montos) llevan el atributo
// data-money para que, al salir del campo, se redondeen automáticamente
// al peso entero más cercano. Evita tener que tipear los centavos a mano.
// No afecta lo que se guarda: si el usuario tipea decimales a propósito,
// el valor solo se redondea recién al perder el foco.
window.redondearMonto = function (valor) {
  const n = parseFloat(valor);
  return isNaN(n) ? valor : Math.round(n);
};

document.addEventListener('blur', function (e) {
  const el = e.target;
  if (el && el.matches && el.matches('input[data-money]') && el.value !== '') {
    el.value = window.redondearMonto(el.value);
  }
}, true);

// ─── REQ-AGIL: filtro rápido para <select> con muchas opciones ──────────────
// Conecta un <input type="text"> a un <select> para filtrar sus <option>
// por coincidencia de texto (sin tocar el <select> original: sigue siendo
// la fuente de verdad para .value, así que no rompe ningún código que ya
// lea/escuche el select). Pensado para selects de cliente/producto que
// crecen con el tiempo y se vuelven lentos de recorrer a mano.
// Uso: window.habilitarFiltroSelect(document.getElementById('mi-select'),
//                                    document.getElementById('mi-filtro'));
window.habilitarFiltroSelect = function (selectEl, inputEl) {
  if (!selectEl || !inputEl || inputEl.__ppFiltroListo) return;
  inputEl.__ppFiltroListo = true;

  const opciones = () => Array.from(selectEl.options).filter(o => o.value !== '');

  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim().toLowerCase();
    let visibles = 0, unica = null;
    opciones().forEach(o => {
      const match = !q || o.textContent.toLowerCase().includes(q);
      o.hidden = !match;
      if (match) { visibles++; unica = o; }
    });
    inputEl.dataset.match = visibles === 1 ? unica.value : '';
  });

  // Enter con un único resultado visible: lo selecciona y dispara 'change'
  // (igual que si el usuario lo hubiera clickeado en el <select>).
  inputEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (inputEl.dataset.match) {
      selectEl.value = inputEl.dataset.match;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      const opt = opciones().find(o => o.value === inputEl.dataset.match);
      inputEl.value = opt ? opt.textContent : '';
      opciones().forEach(o => { o.hidden = false; });
    }
  });
};
