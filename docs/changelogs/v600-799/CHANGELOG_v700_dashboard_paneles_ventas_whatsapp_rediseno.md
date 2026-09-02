# v700 — Rediseño paneles A (Ventas) y B (WhatsApp) del dashboard admin

## Panel A — "Hoy en tu negocio" (ventas)
Reemplaza el sparkline de barras horarias por un gráfico de área SVG suavizado:
- Curva cuadrática (Q) entre puntos medios, path de área con gradiente `#B87A00`.
- Línea punteada de promedio del período con etiqueta `prom. $X`.
- Punto final animado (pulso) cuando el período es "Hoy" (`periodo === '1d'`).
- Eje de etiquetas: todas si hay ≤6 puntos, si no primera/mitad/última — formato hora (hoy) o dd/mm (semana/mes).
- Círculos invisibles (r=9) sobre cada punto real para mantener el tooltip `data-tip` con hit-area cómoda.
- Mismo dato real (`/api/admin/reportes/ventas-diarias`), solo cambia la representación visual.
- `#hourly-chart` pasa de `height:28px` fijo a `min-height:90px` en mobile para que la curva se lea bien.

## Panel B — WhatsApp Business
- Las 4 métricas (mensajes hoy, pedidos vía WA, derivadas a humano, última interacción) pasan de `data-row` verticales a chips horizontales (`wa-stats-strip` / `wa-pill`), liberando espacio vertical.
- El chat (`chat-box`) pasa a ocupar el ancho completo de la card en vez de compartir un grid 1fr/1fr con el panel de stats.
- `wa-draft-box` (pedido borrador) queda debajo del chat, ancho completo.

## Notas
- Sin cambios de backend ni de IDs consumidos por `dashboard.js` — `cargarKPIs`/`renderChat` siguen escribiendo en los mismos `id`, solo cambió el markup/CSS contenedor.
- Verificado: el único `<script>` inline del archivo parsea sin errores (`new Function`, 77997 chars).
