# v370 — Migración completa de Chart.js a ECharts

Continuación del piloto hecho en `stock.js` (overview de movimientos). Se
migraron los 5 archivos que quedaban en Chart.js, usando siempre el wrapper
compartido (`frontend/shared/echarts-wrapper.js`) y el tema Gentelella
(`frontend/shared/echarts-gentelella-theme.js`) — cero hex hardcodeado,
los colores salen de `--ge-teal`, `--ge-red`, etc.

## Páginas migradas (9 gráficos en total)

- **reportes-ventas.html**: Ventas Diarias (línea+área) y Ventas por
  Categoría (dona).
- **reportes-financieros.html**: Flujo de Caja Diario (barras, color por
  signo) e Ingresos vs Costos (líneas con área en gradiente).
- **reportes-stock.html**: Distribución de Stock (dona), Rotación de Stock
  (barras) y Top Productos con Diferencia (barras horizontales, color por
  signo).
- **rentabilidad-zona.html**: Margen neto por zona (barras, color por signo).
- **rentabilidad-producto-vendedor.html**: Margen por producto/vendedor
  (barras, color por signo).

## Qué cambió técnicamente

- `<canvas>` → `<div>` dentro de un wrapper `position:relative` con
  `min-height`, y el div del gráfico en `position:absolute; inset:0`
  (mismo patrón que `stock-ov-chart-wrap/-el`). ECharts necesita un
  contenedor con dimensiones explícitas, no un `<canvas>`.
- `<script src=".../chart.js"></script>` → stack de 3 scripts (CDN
  `echarts@5` + tema + wrapper), mismo orden que `stock.html`.
- `new Chart(ctx, {...}); chart.destroy()` → `crearGraficoECharts(instanciaPrevia, elId, option)`,
  que reutiliza la instancia (`setOption`) en vez de destruir/recrear, y
  registra su propio `ResizeObserver` (ya no hace falta manejar resize a mano).
- Estados vacíos: se usa el soporte nativo del wrapper (`option === null` →
  mensaje `.echarts-vacio`) en vez de manipular el DOM a mano como hacía
  `reportes-stock.js` en el gráfico de top productos.

## Funcionalidad de ECharts aprovechada que Chart.js no ofrecía

- **dataZoom** (slider + zoom con rueda) en los gráficos de series
  temporales cuando el rango supera 14 puntos — permite explorar meses
  completos sin perder detalle diario.
- **Color condicional por valor** (`itemStyle.color` como función) para
  pintar cada barra según si el valor es positivo o negativo, sin tener
  que precalcular un array de colores en JS.
- Áreas con **gradiente lineal real** (`colorStops`) en vez de un
  `rgba` plano.
- Gráficos de dona con **radio interior/exterior configurable** y
  etiquetas con porcentaje automático (`{d}%`).

## CSS agregado

- `.chart-section-wrap` / `.chart-section-el` en `reportes.css` (compartido
  por ventas/financieros/stock).
- `.chart-wrap-el-holder` / `.chart-wrap-el` en los `<style>` inline de
  `rentabilidad-zona.html` y `rentabilidad-producto-vendedor.html` (esas
  dos páginas no usan `reportes.css`, tienen su propio bloque de estilos).
- `.echarts-vacio` en ambos lugares, para el estado sin datos.

## Verificación

- `node --check` sobre los 5 `.js` modificados: OK.
- Balance de `<div>`/`</div>` en los 5 `.html` modificados: OK.
- `grep` de `chart.js` / `new Chart(` en todo `frontend/`: sin resultados
  (fuera del comentario histórico en `echarts-wrapper.js`).

## Pendiente (no incluido en esta tanda)

Páginas con visualizaciones **hechas a mano en SVG/HTML** (no Chart.js, así
que no entraban en este barrido de "migrar Chart.js → ECharts"), candidatas
a una futura migración si se quiere unificar todo bajo ECharts:

- `dashboard.html` (donut de arranque, mini-gráficos de KPIs).
- `rutas.html` (gauge de capacidad, mini-barras de resumen, timeline).
- `stock.html` (gráfico de proyección — el overview de movimientos ya está
  en ECharts, pero el bloque de proyección todavía es SVG a mano).

Son un trabajo más grande (hay que diseñar la migración de gauge/timeline/
sankey, no solo line/bar/pie), así que quedan para una tanda aparte si
querés seguir.
