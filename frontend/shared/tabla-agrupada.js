/**
 * tabla-agrupada.js — Extiende las líneas divisorias de columnas (.thead-sep)
 * del encabezado hacia todas las filas de datos de la tabla.
 * ─────────────────────────────────────────────────────────────────────────
 * No agrega ninguna fila ni texto nuevo: solo toma las columnas marcadas
 * con class="thead-sep" en el <th> real y les agrega la misma línea
 * divisoria a los <td> correspondientes de cada fila, para que el separador
 * baje por toda la tabla en vez de quedar solo en el encabezado.
 *
 * Funciona con tablas cargadas por JS/AJAX: usa MutationObserver sobre cada
 * <tbody> para reaplicar los separadores cada vez que el contenido cambia
 * (carga inicial, filtros, paginación, etc.).
 *
 * Uso: agregar <script src="/frontend/shared/tabla-agrupada.js"></script>
 * en cualquier página que use el componente tabla-agrupada.css.
 */
(function () {
  function indicesSeparador(headRow) {
    var indices = [];
    Array.prototype.forEach.call(headRow.children, function (th, i) {
      if (th.classList.contains('thead-sep')) indices.push(i);
    });
    return indices;
  }

  function aplicarSeparadores(table) {
    var headRow = table.querySelector('thead tr');
    var tbody = table.querySelector('tbody');
    if (!headRow || !tbody) return;

    var totalCols = headRow.children.length;
    var seps = indicesSeparador(headRow);
    if (!seps.length) return;

    Array.prototype.forEach.call(tbody.rows, function (row) {
      // Saltar filas de carga / vacío (normalmente un solo <td colspan="N">)
      if (row.cells.length !== totalCols) return;
      seps.forEach(function (i) {
        var celda = row.cells[i];
        if (celda) celda.classList.add('thead-sep');
      });
    });
  }

  function procesarTodas() {
    document.querySelectorAll('table').forEach(aplicarSeparadores);
  }

  function observarTbodies() {
    document.querySelectorAll('table').forEach(function (table) {
      var tbody = table.querySelector('tbody');
      if (!tbody) return;
      var obs = new MutationObserver(function () {
        aplicarSeparadores(table);
      });
      obs.observe(tbody, { childList: true, subtree: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      procesarTodas();
      observarTbodies();
    });
  } else {
    procesarTodas();
    observarTbodies();
  }
})();
