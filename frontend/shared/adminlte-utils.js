// frontend/shared/adminlte-utils.js
//
// NOTA (limpieza post-Etapa 2 lenguaje): este archivo llegó a tener copias
// muertas de renderTbody/memoGet/invalidarMemo/mostrarSkeletonTabla —
// duplicaban ui-utils.js con implementaciones y textos distintos (ej.
// "No hay datos para mostrar." en vez de "Sin resultados", colspan default
// 1 en vez de 8). Nunca se llamaban desde ningún lado (facturacion.html es
// el único archivo que importa de acá, y solo usa `toast`), así que no
// generaban un bug visible hoy, pero sí un riesgo latente: alguien podía
// importarlas pensando que eran "las de siempre" y pisar en silencio el
// comportamiento de ui-utils.js. Se sacaron. Si en el futuro hace falta
// alguna de esas utilidades acá, importar/reusar la de ui-utils.js en vez
// de reimplementarla.

// Implementación real (antes era un placeholder de solo console.log —
// ver auditoría v65 — que dejaba sin feedback visual a facturacion.html,
// ya que su módulo inline reasigna window.toast a este toast importado,
// pisando el toast funcional que ya había seteado ui-utils.js).
// Mismo contrato y mismas clases CSS (.toast / .toast--visible / .toast--{tipo})
// que ui-utils.js y admin-utils.js, definidas en /shared/tokens.css.
let _toastEl;
let _toastTimer;
function toast(msg, tipo = 'default', duracionMs = 3000) {
window.toast = toast;
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.className = 'toast';
    document.body.appendChild(_toastEl);
  }
  clearTimeout(_toastTimer);
  _toastEl.className = 'toast';
  if (tipo !== 'default') _toastEl.classList.add(`toast--${tipo}`);
  _toastEl.textContent = msg;
  void _toastEl.offsetHeight;
  _toastEl.classList.add('toast--visible');
  _toastTimer = setTimeout(() => _toastEl.classList.remove('toast--visible'), duracionMs);
}

export { toast };
