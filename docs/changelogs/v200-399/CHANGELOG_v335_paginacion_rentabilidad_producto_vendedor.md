# v335 — Paginación en "Qué producto y vendedor rinden más"

## Problema
La tabla de detalle (por producto / por vendedor) renderizaba TODAS las filas
agregadas de una sola vez en el DOM. Con el volumen real de datos (14.855
filas en v_rentabilidad_producto tras aplicar la migración 246) esto se
traducía en un scroll interminable, poco prolijo y pesado para el navegador.

## Solución
Paginación 100% client-side (no requiere cambios en el backend ni en las
vistas SQL, los datos ya vienen completos y se agregan en JS):

- `PAGINACION.porPagina = 20` filas por página, independiente para la vista
  "Por producto" y la vista "Por vendedor".
- Barra de paginación debajo de cada tabla: "Mostrando X-Y de Z (página N de M)"
  + botones Anterior/Siguiente + números de página (con "…" si hay muchas).
- La página vuelve a 1 automáticamente al:
  - recargar el reporte (cambiar fechas o tocar "Actualizar"),
  - cambiar el filtro de categoría (cambia el conjunto de filas).
- El export a CSV sigue exportando TODO el conjunto filtrado, no solo la
  página visible (no se tocó `exportarCSV`).

## Archivos modificados
- `frontend/admin/rentabilidad-producto-vendedor.html`
- `frontend/admin/js/rentabilidad-producto-vendedor.js`

## Cómo aplicar
Reemplazar esos dos archivos en el repo (mismo path) y desplegar. No requiere
tocar Supabase ni el handler `rutas-live.js`.
