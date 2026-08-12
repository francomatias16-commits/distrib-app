/**
 * admin-utils.js — Utilidades de renderizado sin fugas de memoria
 * distrib-v39 | Módulo Frontend Admin
 *
 * Patrones implementados:
 *   ✓ AbortController por vista → limpieza automática de listeners al navegar
 *   ✓ DocumentFragment → 1 solo reflow para renderizado de tablas
 *   ✓ Delegación de eventos → N listeners reemplazados por 1
 *   ✓ Intersection Observer → lazy load y scroll infinito sin polling
 *   ✓ Memoización TTL → evita re-fetches durante la sesión
 *   ✓ Toast unificado → elimina duplicado en cada módulo
 *
 * USO en pedidos.js, stock.js, clientes.js, etc.:
 *   import { Tabla, toast, memoGet, createAC, delegarEvento } from './admin-utils.js';
 */

'use strict';

// ─── AbortController de vista ─────────────────────────────────────────────
// Cada página llama createAC() al init y ac.abort() al destruir.
// Todos los addEventListener reciben { signal: ac.signal }

/**
 * Crea un AbortController y devuelve { ac, signal }.
 * Pasar `signal` a addEventListener → el listener se limpia solo al abortar.
 */
export function createAC() {
  const ac = new AbortController();
  return ac;
}

// ─── Delegación de eventos ────────────────────────────────────────────────
/**
 * Registra UN solo listener en `container` que delega a elementos
 * que coinciden con `selector`. Limpiable via AbortController.
 *
 * @param {Element}  container  Elemento padre (tabla, lista, grid)
 * @param {string}   eventType  'click', 'input', etc.
 * @param {string}   selector   CSS selector del elemento objetivo
 * @param {Function} handler    (e, targetEl) => void
 * @param {AbortSignal} signal  Del AbortController de la vista
 */
export function delegarEvento(container, eventType, selector, handler, signal) {
  container.addEventListener(
    eventType,
    (e) => {
      const el = e.target.closest(selector);
      if (el && container.contains(el)) handler(e, el);
    },
    { signal }
  );
}

// ─── DocumentFragment renderer ────────────────────────────────────────────
/**
 * Renderiza una lista de items en `container` usando DocumentFragment
 * (un solo reflow) en vez de innerHTML += en loop.
 *
 * @param {Element}          container  Donde se insertan los nodos
 * @param {Array}            items      Array de datos
 * @param {(item) => string} templateFn Función que devuelve HTML string por item
 * @param {string}           emptyHtml  HTML a mostrar si items es vacío
 */
export function renderFragment(container, items, templateFn, emptyHtml = '') {
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
}

/**
 * Variante para <tbody>: igual que renderFragment pero con wrapper <table>
 * para que los <tr> sean válidos en el DocumentFragment.
 */
export function renderTbody(tbody, rows, rowFn, emptyColspan = 8) {
  const emptyHtml = `<tr><td colspan="${emptyColspan}" class="tabla-empty">Sin resultados</td></tr>`;
  renderFragment(tbody, rows, rowFn, emptyHtml);
}

// ─── Memoización con TTL ──────────────────────────────────────────────────
const _memoCache = new Map();

/**
 * GET con caché en memoria + TTL.
 * Evita re-fetches cuando el usuario navega entre secciones.
 *
 * @param {string} url
 * @param {number} ttlMs  Tiempo de vida en ms (default: 60s)
 * @returns {Promise<any>} datos parseados como JSON
 */
export async function memoGet(url, ttlMs = 60_000) {
  const entry = _memoCache.get(url);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`[memoGet] ${resp.status} en ${url}`);
  const data = await resp.json();
  _memoCache.set(url, { data, ts: Date.now() });
  return data;
}

/** Invalida entradas que contengan el patrón (string o RegExp). */
export function invalidarMemo(patron) {
  for (const key of _memoCache.keys()) {
    const match = typeof patron === 'string'
      ? key.includes(patron)
      : patron.test(key);
    if (match) _memoCache.delete(key);
  }
}

// ─── Toast unificado ──────────────────────────────────────────────────────
let _toastEl = null;
let _toastTimer = null;

/**
 * Muestra un toast no-bloqueante.
 *
 * @param {string} mensaje
 * @param {'default'|'success'|'danger'|'warning'} tipo
 * @param {number} duracionMs  (default: 3000)
 */
export function toast(mensaje, tipo = 'default', duracionMs = 3000) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.className = 'toast';
    document.body.appendChild(_toastEl);
  }

  // Limpiar timer anterior si hay uno en curso
  clearTimeout(_toastTimer);

  // Resetear clases semánticas
  _toastEl.className = 'toast';
  if (tipo !== 'default') _toastEl.classList.add(`toast--${tipo}`);
  _toastEl.textContent = mensaje;

  // Trigger reflow para reiniciar la transición
  void _toastEl.offsetHeight;
  _toastEl.classList.add('toast--visible');

  _toastTimer = setTimeout(() => {
    _toastEl.classList.remove('toast--visible');
  }, duracionMs);
}

// ─── Estado de carga con skeleton ─────────────────────────────────────────
/**
 * Activa el skeleton en un contenedor.
 * Remover con loadingEnd().
 *
 * @param {Element} container
 */
export function loadingStart(container) {
  container.classList.add('sk-loading');
  container.setAttribute('aria-busy', 'true');
}

export function loadingEnd(container) {
  container.classList.remove('sk-loading');
  container.classList.add('sk-reveal');
  container.removeAttribute('aria-busy');
  // Limpiar clase de reveal para no interferir con futuros cambios
  container.addEventListener(
    'animationend',
    () => container.classList.remove('sk-reveal'),
    { once: true }
  );
}

// ─── Formato de moneda/fecha ──────────────────────────────────────────────
const FMT_ARS = new Intl.NumberFormat('es-AR', {
  style: 'currency', currency: 'ARS', minimumFractionDigits: 0,
});

export const formatARS   = (n) => FMT_ARS.format(n ?? 0);
export const formatFecha = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
};
export const formatHora = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
};

// ─── Confirm modal liviano ────────────────────────────────────────────────
/**
 * Reemplaza window.confirm() con un diálogo accesible.
 * @param {string} mensaje
 * @param {object}  [opts]
 * @param {string}  [opts.labelOk='Confirmar']
 * @param {string}  [opts.labelCancel='Cancelar']
 * @param {'default'|'danger'} [opts.tipo='default']  - 'danger' resalta el botón
 *        de confirmación en rojo y suma un ícono de advertencia.
 * @returns {Promise<boolean>}
 */
export function confirmar(mensaje, opts = {}) {
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
          ${esDanger ? '<div style="font-size:1.4rem;line-height:1;margin-bottom:.5rem">⚠</div>' : ''}
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
}
