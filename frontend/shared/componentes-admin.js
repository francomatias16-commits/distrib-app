// frontend/shared/componentes-admin.js
// ════════════════════════════════════════════════════════════════════════
// Helpers JS del componente canónico admin — Fase 0 de PLAN_UNIFICACION_UX_ADMIN.md
//
// Cada página deja de tener su propio HTML-en-template-string para
// badges/acciones/paginación repetidos; usa estas funciones en su lugar.
// Ver frontend/shared/componentes-admin.css para las clases que renderizan.
// ════════════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const VARIANTES_VALIDAS = ['ok', 'warning', 'bajo', 'critico', 'info', 'parcial', 'pendiente', 'inactivo'];

  /**
   * Renderiza un badge de estado canónico.
   * @param {string} texto    - Texto visible (ya traducido/formateado por el caller).
   * @param {string} variante - Una de VARIANTES_VALIDAS. Si no es reconocida, cae en 'inactivo'.
   * @param {object} [opts]
   * @param {boolean} [opts.dot=true] - Si muestra el punto de color junto al texto.
   */
  function renderBadgeEstado(texto, variante, opts) {
    opts = opts || {};
    const conDot = opts.dot !== false;
    const v = VARIANTES_VALIDAS.includes(variante) ? variante : 'inactivo';
    const txt = global.sanitize ? global.sanitize(String(texto)) : String(texto);
    return `<span class="badge-estado badge-${v}">${conDot ? '<span class="badge-dot"></span>' : ''}${txt}</span>`;
  }

  /**
   * Renderiza una fila de acciones: un botón de texto por acción primaria
   * (máx. 2 recomendado) + opcionalmente un botón kebab para el resto.
   * @param {Array<{label:string, attrs?:string, cls?:string}>} accionesPrimarias
   * @param {{attrs?:string}} [kebab] - Si se pasa, agrega el botón ⋮. attrs debe incluir
   *   los data-* que la página use para identificar la fila (data-id, etc.)
   */
  function renderFilaAcciones(accionesPrimarias, kebab) {
    const primarias = (accionesPrimarias || []).map(a =>
      `<button type="button" class="btn-tabla${a.cls ? ' ' + a.cls : ''}" ${a.attrs || ''}>${a.label}</button>`
    ).join('');
    const btnKebab = kebab
      ? `<button type="button" class="btn-kebab" ${kebab.attrs || ''} title="Más acciones" aria-label="Más acciones" aria-haspopup="menu" aria-expanded="false"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>`
      : '';
    return `<span class="fila-acciones">${primarias}${btnKebab}</span>`;
  }

  /**
   * Renderiza el bloque de paginación (Anterior / Siguiente + contador),
   * usando las clases ya compartidas en frontend/shared/pagination.css.
   * @param {number} pagina    - página actual (1-indexed)
   * @param {number} totalPaginas
   * @param {string} idPrefix  - prefijo para los ids de los botones (ej. "cc-prov")
   */
  function renderPaginacion(pagina, totalPaginas, idPrefix) {
    const prefix = idPrefix || 'pag';
    return `<div class="paginacion-container">
      <button type="button" class="btn-pag" id="${prefix}-btn-prev" ${pagina <= 1 ? 'disabled' : ''}>Anterior</button>
      <span class="info-pag">Página ${pagina} de ${Math.max(totalPaginas, 1)}</span>
      <button type="button" class="btn-pag" id="${prefix}-btn-next" ${pagina >= totalPaginas ? 'disabled' : ''}>Siguiente</button>
    </div>`;
  }

  global.ComponentesAdmin = {
    renderBadgeEstado,
    renderFilaAcciones,
    renderPaginacion,
    VARIANTES_VALIDAS,
  };
})(window);
