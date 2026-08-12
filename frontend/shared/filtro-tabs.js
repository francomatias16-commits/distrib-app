/**
 * filtro-tabs.js — Barra de pestañas de filtro con contador (reemplazo de
 * las tarjetas KPI de gentelella-fkpi.css / kpi-line.css en las pantallas
 * donde cada indicador es una categoría real y filtrable de la tabla de
 * abajo). Ver también frontend/shared/filtro-tabs.css.
 * ─────────────────────────────────────────────────────────────────────────
 * RECONSTRUIDO el 2026-08-09: el archivo no estaba ni en el zip recuperado
 * ni entre los archivos sueltos, pese a que devoluciones.js y
 * whatsapp-conversaciones.js ya lo llamaban activamente (páginas
 * "terminadas" que sin este archivo tiran 404 + "FiltroTabs is not
 * defined"). Reconstruido a partir del uso real observado, idéntico en las
 * 8 pantallas migradas con este patrón (devoluciones, whatsapp-
 * conversaciones, riesgo-cheques, cheques, cobranzas/cta-cte):
 *
 *   FiltroTabs.crear(contenedor, tabs, keyActiva, onChange)
 *   FiltroTabs.actualizarContadores(contenedor, { key: valor, ... })
 *
 * Markup generado por crear():
 *   <div class="barra-filtros filtro-tabs" role="tablist">
 *     <button class="filtro-tab activa" data-key="todas" role="tab" aria-selected="true">
 *       <span class="filtro-tab-lbl">Todas</span>
 *       <span class="filtro-tab-count" data-key-count="todas">123</span>
 *     </button>
 *     ...
 *   </div>
 *
 * Notas del contrato (confirmado contra los usos reales):
 *  - `key` puede ser '' (string vacío) para representar "todos / sin
 *    filtro" — usado así en cheques.js y cta-cte.js.
 *  - El badge de contador se identifica por [data-key-count="<key>"], no
 *    solo por clase, porque algunas pantallas (cta-cte.js) necesitan
 *    escribir ahí directamente con un formato propio (ej. formatPeso())
 *    en vez del número plano que pone actualizarContadores().
 *  - Si una pestaña nunca recibe contador vía actualizarContadores(), su
 *    badge queda oculto en vez de mostrar "0" o vacío (ver cheques.js:
 *    "Todos" no tiene un total parcial fiable y se deja sin número).
 */
(function () {
  function formatNumero(n) {
    const num = Number(n);
    if (!isFinite(num)) return '0';
    return num.toLocaleString('es-AR');
  }

  function crear(contenedor, tabs, keyActiva, onChange) {
    if (!contenedor || !Array.isArray(tabs)) return;

    contenedor.classList.add('filtro-tabs');
    contenedor.setAttribute('role', 'tablist');
    contenedor.innerHTML = tabs.map((t) => {
      const activa = t.key === keyActiva;
      return `<button type="button" class="filtro-tab${activa ? ' activa' : ''}" data-key="${t.key}" role="tab" aria-selected="${activa ? 'true' : 'false'}">
        <span class="filtro-tab-lbl">${t.label}</span>
        <span class="filtro-tab-count" data-key-count="${t.key}" style="display:none"></span>
      </button>`;
    }).join('');

    contenedor.querySelectorAll('.filtro-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        contenedor.querySelectorAll('.filtro-tab').forEach((b) => {
          b.classList.remove('activa');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('activa');
        btn.setAttribute('aria-selected', 'true');
        if (typeof onChange === 'function') onChange(btn.dataset.key);
      });
    });
  }

  function actualizarContadores(contenedor, valores) {
    if (!contenedor || !valores) return;
    Object.keys(valores).forEach((key) => {
      const span = contenedor.querySelector(`.filtro-tab-count[data-key-count="${key}"]`);
      if (!span) return;
      span.textContent = formatNumero(valores[key]);
      span.style.display = '';
    });
  }

  window.FiltroTabs = { crear, actualizarContadores };
})();
