/**
 * echarts-wrapper.js — Wrapper único para instanciar gráficos ECharts
 * ─────────────────────────────────────────────────────────────────────────────
 * Reemplaza el patrón repetido `new Chart(canvas, {...}); chart.destroy()`
 * de Chart.js. Con ECharts el equivalente correcto no es tan directo (no usa
 * <canvas> con un solo constructor, sino un <div> + echarts.init, y hay que
 * manejar resize a mano) — por eso se centraliza aquí una sola vez.
 *
 * Uso típico dentro de una pantalla:
 *
 *   let _miChart = null;
 *   function renderGrafico(datos) {
 *     _miChart = crearGraficoECharts(_miChart, 'id-del-div', {
 *       tooltip: { trigger: 'axis' },
 *       xAxis: { type: 'category', data: datos.labels },
 *       yAxis: { type: 'value' },
 *       series: [{ type: 'line', data: datos.valores }],
 *     });
 *   }
 *
 * Al recargar datos, pasar la instancia anterior como primer argumento —
 * la reusa (setOption) en vez de destruir y recrear, que es más eficiente
 * y evita parpadeos.
 */

(function () {
  // Registro de instancias + sus listeners de resize, para poder liberarlas
  // todas de una si una pantalla se desmonta (SPA) sin recargar la página.
  const _instancias = new Map(); // elementId -> { chart, resizeObserver }

  /**
   * Crea (o reutiliza) una instancia de ECharts sobre el elemento indicado.
   * @param {echarts.ECharts|null} instanciaPrevia - resultado de una llamada anterior, o null.
   * @param {string} elId - id del contenedor <div> (NO <canvas>).
   * @param {object} option - config estándar de ECharts (series, xAxis, etc.).
   * @param {object} [opts]
   * @param {boolean} [opts.notMerge=false] - pasar true si el nuevo option debe
   *        reemplazar por completo al anterior en vez de mezclarse (ej. cambió
   *        la cantidad de series).
   * @returns {echarts.ECharts|null} la instancia (para pasarla en la próxima llamada).
   */
  window.crearGraficoECharts = function crearGraficoECharts(instanciaPrevia, elId, option, opts) {
    opts = opts || {};
    if (typeof echarts === 'undefined') {
      console.warn('[echarts-wrapper] ECharts todavía no está cargado.');
      return null;
    }
    const el = document.getElementById(elId);
    if (!el) return null;

    // Estado vacío / sin datos: mostrar mensaje en vez de un canvas en blanco.
    // Cada pantalla puede pasar option === null para pedir esto explícitamente.
    if (option === null) {
      destruirGraficoECharts(instanciaPrevia, elId);
      el.innerHTML = opts.htmlVacio || '<div class="echarts-vacio">Sin datos para mostrar.</div>';
      return null;
    }

    let chart = instanciaPrevia;
    const yaExiste = chart && !chart.isDisposed();

    if (!yaExiste) {
      // El contenedor puede traer contenido ajeno a ECharts (skeleton de
      // carga, mensaje de "sin datos", error previo, etc.) — si no se limpia
      // acá, echarts.init() lo deja intacto y agrega su propio nodo al lado,
      // dando el efecto de un gráfico "que nunca termina de cargar" con un
      // placeholder pegado arriba. Se limpia siempre que se va a instanciar
      // desde cero, sin depender de quién haya puesto ese contenido.
      el.innerHTML = '';
      chart = echarts.init(el, window.GENTELELLA_ECHARTS_TEMA || null, {
        renderer: 'svg', // más liviano que canvas para gráficos simples y se ve nítido en cualquier DPI
      });
      _registrarResize(elId, chart, el);
    }

    chart.setOption(option, { notMerge: !!opts.notMerge });
    return chart;
  };

  /**
   * Libera una instancia y su observer de resize. Llamar al salir de una
   * pantalla (si aplica en el patrón de tu SPA) o antes de renderizar un
   * estado vacío sobre el mismo contenedor.
   */
  window.destruirGraficoECharts = function destruirGraficoECharts(instancia, elId) {
    const reg = _instancias.get(elId);
    if (reg && reg.resizeObserver) reg.resizeObserver.disconnect();
    _instancias.delete(elId);
    if (instancia && !instancia.isDisposed()) instancia.dispose();
  };

  function _registrarResize(elId, chart, el) {
    // Limpiar un registro previo del mismo id, por si quedó un observer
    // huérfano de una instancia anterior sobre el mismo contenedor.
    const previo = _instancias.get(elId);
    if (previo && previo.resizeObserver) previo.resizeObserver.disconnect();

    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(el);
    _instancias.set(elId, { chart, resizeObserver });
  }
})();
