# v542 — `stock_minimo` pasa a entero

## Motivo
Hallazgo #6 de `AUDITORIA_BUGS_v954.md`: el input de stock mínimo del admin
(`frontend/admin/productos.html`, `input#fp-stock_minimo`) tiene `step="1"`
(sugiere entero) pero `frontend/admin/js/productos.js` parseaba con
`parseFloat`, y la columna real en DB era `numeric(12,3)`. No era un bug
funcional, pero era un cabo suelto de intención frente al criterio de
"cantidades solo enteras" ya aplicado en v690 (migraciones 449/450) para el
resto de las columnas de cantidad del sistema.

Se decide cerrar la inconsistencia con el mismo criterio que v690:
`stock_minimo` pasa a `integer`, no solo el input. Se verificó que no hay
forma de cargar un valor fraccionario desde ningún flujo actual (el único
formulario que lo escribe ya usa `step="1"`), así que la conversión de tipo
no trunca datos reales existentes.

## Base de datos
- `20260824040000_542_stock_minimo_entero.sql`:
  - `productos.stock_minimo`: `numeric(12,3)` → `integer` (`USING
    round(stock_minimo)::integer`), `DEFAULT 0`.
  - `fn_crear_producto`: `p_stock_minimo` `numeric` → `integer` (firma
    vigente desde 527, sin otros cambios).
  - `fn_productos_lista`: columna de salida `stock_minimo` `numeric` →
    `integer` (firma vigente desde 528, sin otros cambios). Usada por el
    admin de Productos.
  - `fn_reportes_stock_criticos_lista`: columna de salida `stock_minimo`
    `numeric` → `integer` (firma vigente desde 441, sin otros cambios).
  - Grants: como las tres funciones se recrean vía `DROP FUNCTION` +
    `CREATE OR REPLACE` (necesario porque cambia el tipo de un parámetro/
    columna de salida, no solo el cuerpo), se reaplican explícitamente los
    `REVOKE`/`GRANT` que ya tenían fijados por auditorías previas:
    `fn_productos_lista` (REVOKE de PUBLIC/anon, GRANT a authenticated +
    service_role, fijado en 258 — sin este paso el DROP lo revierte al
    default de Postgres y reabre EXECUTE a PUBLIC) y
    `fn_reportes_stock_criticos_lista` (mismo patrón, fijado en 441).
    `fn_crear_producto` no tenía grants explícitos en ninguna de sus
    migraciones de origen (351/527), así que no se le agregan acá.

## Frontend
- `frontend/admin/js/productos.js` (`guardarProducto`): parseo de
  `fp-stock_minimo` con `parseInt` en vez de `parseFloat`, mismo criterio
  que v690 aplicó a las cantidades del resto del sistema. El input ya tenía
  `min="0" step="1"` desde antes; no requirió cambios en el HTML.

## Fuera de alcance (revisado, no requiere cambios)
- `obtener_kpis_dashboard_v2` (076), `obtener_dashboard_ejecutivo_resumen`
  (243), `fn_reportes_stock_kpis` (441) y `analizar_stock_autonomo` (460)
  usan `stock_minimo` solo dentro de expresiones sin declararlo como columna
  de salida (`RETURNS JSONB` o solo parte de un cálculo `numeric`) — el cast
  de asignación de `integer` a `numeric` es implícito, siguen funcionando
  sin tocarlos.
- `trigger_push_stock_critico` (112) usa una variable local `v_minimo
  numeric` para leer `stock_minimo` — asignación implícita, no requiere
  cambio.
- `lib/asistente-tools.js` sigue usando `Number(args.stock_minimo)` sin
  forzar entero, mismo criterio que se dejó para `cantidad` en ese mismo
  archivo cuando se aplicó v690 (no se tocó en esa migración tampoco).

## Impacto para el usuario
Ninguno visible: el input del admin ya sugería enteros (`step="1"`) y no
había forma de cargar fracciones en producción. Este cambio solo hace
explícito en el tipo de dato lo que ya era el comportamiento real.
