/**
 * echarts-gentelella-theme.js — Tema ECharts derivado de gentelella-tokens.css
 * ─────────────────────────────────────────────────────────────────────────────
 * Mismo criterio que el resto del reskin: gentelella-tokens.css es la ÚNICA
 * fuente de colores. Este archivo NO hardcodea hex — lee los valores en vivo
 * desde las CSS custom properties (getComputedStyle) y los traduce a un tema
 * de ECharts. Si el día de mañana cambia la paleta en gentelella-tokens.css,
 * los gráficos se actualizan solos, sin tocar este archivo.
 *
 * Requiere que gentelella-tokens.css ya esté cargado en el <head> antes de
 * llamar a inicializarTemaECharts(). Requiere también que la librería global
 * `echarts` ya esté cargada (script CDN) antes de llamar a esta función.
 *
 * Uso:
 *   <link rel="stylesheet" href="/frontend/shared/gentelella-tokens.css">
 *   <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
 *   <script src="/frontend/shared/echarts-gentelella-theme.js"></script>
 *   <script>
 *     inicializarTemaECharts(); // registra el tema 'gentelella' una sola vez
 *   </script>
 */

(function () {
  const NOMBRE_TEMA = 'gentelella';
  let _yaRegistrado = false;

  function leerToken(nombre, fallback) {
    const valor = getComputedStyle(document.documentElement)
      .getPropertyValue(nombre)
      .trim();
    return valor || fallback;
  }

  /**
   * Lee los tokens Gentelella vigentes y devuelve el objeto de tema de
   * ECharts. Se puede llamar más de una vez (ej. si en el futuro se agrega
   * un modo oscuro con otro set de tokens); por eso no cachea los valores.
   */
  function construirTemaECharts() {
    const ink       = leerToken('--ge-ink', '#2A3F54');
    const inkSoft   = leerToken('--ge-ink-soft', '#73879C');
    const muted     = leerToken('--ge-muted', '#AAB7B8');
    const border    = leerToken('--ge-border', '#E6E9ED');
    const panel     = leerToken('--ge-panel', '#ffffff');
    const teal      = leerToken('--ge-teal', '#26B99A');
    const tealDark  = leerToken('--ge-teal-dark', '#169F85');
    const blue      = leerToken('--ge-blue', '#3498DB');
    const orange    = leerToken('--ge-orange', '#F0AD4E');
    const red       = leerToken('--ge-red', '#e74c3c');
    const purple    = leerToken('--ge-purple', '#8E44AD');

    // Paleta de series en el orden que ya usan los gráficos existentes
    // (teal primero porque es el color de marca / acción principal).
    const paletaSeries = [teal, blue, orange, purple, red, tealDark];

    return {
      color: paletaSeries,
      backgroundColor: 'transparent',
      textStyle: {
        fontFamily:
          "'Helvetica Neue', Helvetica, Arial, sans-serif",
        color: inkSoft,
      },
      title: {
        textStyle: { color: ink, fontWeight: 600 },
      },
      grid: {
        left: 8,
        right: 8,
        top: 28,
        bottom: 8,
        containLabel: true,
        borderColor: border,
      },
      categoryAxis: {
        axisLine: { lineStyle: { color: border } },
        axisTick: { show: false },
        axisLabel: { color: inkSoft },
        splitLine: { show: false },
      },
      valueAxis: {
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: inkSoft },
        splitLine: { lineStyle: { color: border, type: 'dashed' } },
      },
      legend: {
        textStyle: { color: inkSoft },
        icon: 'circle',
      },
      tooltip: {
        backgroundColor: panel,
        borderColor: border,
        borderWidth: 1,
        textStyle: { color: ink },
        extraCssText: 'box-shadow: 0 4px 12px rgba(0,0,0,.13), 0 2px 4px rgba(0,0,0,.10); border-radius: 8px;',
      },
      line: {
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2 },
      },
      bar: {
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      },
      pie: {
        itemStyle: {
          borderColor: panel,
          borderWidth: 2,
        },
      },
      // Tokens de estado, expuestos por si algún gráfico puntual necesita
      // pintar una serie con el color semántico exacto (ej. "egresos" en
      // rojo) en vez de tomar el color por posición de la paleta.
      _tokens: { ink, inkSoft, muted, border, panel, teal, tealDark, blue, orange, red, purple },
    };
  }

  /**
   * Registra (o re-registra) el tema 'gentelella' en la instancia global de
   * ECharts. Idempotente: se puede llamar en cada pantalla sin duplicar
   * trabajo. Devuelve el objeto de tokens crudos por si se necesitan fuera
   * de la config de ECharts (ej. un color de fondo de una card contenedora).
   */
  window.inicializarTemaECharts = function inicializarTemaECharts() {
    if (typeof echarts === 'undefined') {
      console.warn('[echarts-gentelella-theme] ECharts todavía no está cargado.');
      return null;
    }
    const tema = construirTemaECharts();
    echarts.registerTheme(NOMBRE_TEMA, tema);
    _yaRegistrado = true;
    return tema._tokens;
  };

  window.GENTELELLA_ECHARTS_TEMA = NOMBRE_TEMA;
})();
