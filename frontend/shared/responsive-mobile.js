/**
 * responsive-mobile.js — Refuerzo runtime de responsividad mobile.
 *
 * v699 — Complementa responsive-mobile.css con dos correcciones que no se
 * pueden resolver solo con CSS porque dependen del HTML/JS de cada página:
 *
 *   1. wrapOrphanTables(): algunas páginas tienen <table> sin ningún
 *      contenedor con scroll horizontal propio (.tabla-wrap, .tabla-main,
 *      .tabla-base, etc.) — en mobile esas tablas desbordan el body.
 *      Este script envuelve en runtime cualquier <table> "huérfana" con un
 *      <div class="rmw-tabla-auto"> (ver responsive-mobile.css §"safety
 *      net" para el overflow-x:auto de esa clase). También re-escanea el
 *      DOM ante cambios (MutationObserver) para cubrir tablas que se
 *      renderizan después de un fetch.
 *
 *   2. fixInlineGrids(): algunos módulos arman `grid-template-columns`
 *      como estilo inline (3+ columnas fijas) que no puede sobreescribirse
 *      con CSS externo. En mobile (≤640px) se colapsan a 1 o 2 columnas y
 *      se restauran al valor original al volver a desktop. Mismo patrón
 *      que fixMobileGrids() de dashboard.html (v637) pero genérico para
 *      cualquier página.
 *
 * No modifica el layout desktop en ningún caso — todo lo que hace es
 * condicional a `window.innerWidth <= 640`.
 */
(function () {
  'use strict';

  var MOBILE_BQ = 640;
  var GRID_ORIG_ATTR = 'data-rmw-grid-orig';
  var WRAP_SELECTORS = [
    '.tabla-wrap', '.tabla-container', '.tabla-wrapper', '.table-responsive',
    '.rmw-tabla-auto', '.mig-preview-tabla-wrap'
  ];

  /* ── 1. Envolver tablas sin wrapper de scroll ──────────────────────── */
  function wrapOrphanTables(root) {
    (root || document).querySelectorAll('table').forEach(function (table) {
      var yaEnvuelta = WRAP_SELECTORS.some(function (sel) {
        return !!table.closest(sel);
      });
      if (yaEnvuelta || !table.parentNode) return;

      var wrapper = document.createElement('div');
      wrapper.className = 'rmw-tabla-auto';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }

  /* ── 2. Colapsar grids inline de 3+ columnas en mobile ─────────────── */
  function contarColumnas(valor) {
    var repeatMatch = valor.match(/repeat\(\s*(\d+)/);
    if (repeatMatch) return parseInt(repeatMatch[1], 10);
    return valor.trim().split(/\s+/).filter(Boolean).length;
  }

  function fixInlineGrids() {
    var isMobile = window.innerWidth <= MOBILE_BQ;

    document.querySelectorAll('[style*="grid-template-columns"]').forEach(function (el) {
      if (!el.hasAttribute(GRID_ORIG_ATTR)) {
        var actual = el.style.gridTemplateColumns;
        if (!actual || /auto-fit|auto-fill/.test(actual)) return; // ya responsive
        if (contarColumnas(actual) < 3) return; // 1-2 cols ya suelen andar bien
        el.setAttribute(GRID_ORIG_ATTR, actual);
      }

      var original = el.getAttribute(GRID_ORIG_ATTR);
      if (!original) return;

      if (isMobile) {
        el.style.gridTemplateColumns = contarColumnas(original) >= 4 ? 'repeat(2,1fr)' : '1fr';
      } else {
        el.style.gridTemplateColumns = original;
      }
    });
  }

  /* ── 3. Orquestación ───────────────────────────────────────────────── */
  function runAll() {
    wrapOrphanTables();
    fixInlineGrids();
  }

  var resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fixInlineGrids, 120);
  }

  var observer = null;
  function iniciarObserver() {
    if (!window.MutationObserver || !document.body) return;
    observer = new MutationObserver(function (mutaciones) {
      var hayTablaNueva = mutaciones.some(function (m) {
        return Array.prototype.some.call(m.addedNodes, function (n) {
          return n.nodeType === 1 && (n.tagName === 'TABLE' || (n.querySelector && n.querySelector('table')));
        });
      });
      if (!hayTablaNueva) return;
      observer.disconnect();
      wrapOrphanTables();
      observer.observe(document.body, { childList: true, subtree: true });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      runAll();
      iniciarObserver();
    });
  } else {
    runAll();
    iniciarObserver();
  }

  window.addEventListener('resize', onResize);
})();
