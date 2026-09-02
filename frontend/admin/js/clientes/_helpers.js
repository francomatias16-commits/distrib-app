// frontend/admin/js/clientes/_helpers.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';


// ── Helpers ────────────────────────────────────────────────────────────────
export function iniciales(n) {
  return n.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
}
export function formatPeso(n) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
}
// XSS: helper para escapar de forma segura un valor de texto libre (nombre,
// teléfono, etc.) cuando se inserta como argumento dentro de un atributo
// onclick="funcion('...')". escHtml() sola no alcanza acá porque no escapa
// comillas — un nombre con un apóstrofo rompe el string de JS. JSON.stringify
// escapa comillas/backslashes correctamente para el string JS, y el resto
// escapa lo necesario para el atributo HTML que lo contiene.
export function escOnclickArg(valor) {
  return JSON.stringify(String(valor ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}
// mostrarToast ya definida arriba via admin-utils
