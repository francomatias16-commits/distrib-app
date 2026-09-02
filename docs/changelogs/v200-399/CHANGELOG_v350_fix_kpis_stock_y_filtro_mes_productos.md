# v348–v350 — Fix: KPIs de Stock inflados/desactualizados y filtro de mes en Productos

## Problema

Tres bugs detectados en auditoría, sobre `Reportes de Stock` y `Productos`:

1. La tarjeta **"Productos en Stock"** mostraba el doble en empresas con
   2+ depósitos (ej. 2000 en vez de 1000).
2. La tarjeta **"Críticos"** usaba un umbral fijo `cantidad < 10` para
   todos los productos, ignorando `stock_minimo` (el umbral real que ya
   usa el resto del sistema — alertas de stock, punto de pedido
   predictivo).
3. El selector de mes (Ene…Dic) en `/admin/productos.html` **no filtraba
   nada**: cambiar de mes repintaba el botón activo pero nunca se
   enviaba al backend.

## Causa raíz

1. `fn_reportes_stock_kpis` contaba `COUNT(*)` sobre filas de la tabla
   `stock` (una fila por producto × depósito) en vez de
   `COUNT(DISTINCT producto_id)`.
2. La misma función comparaba `cantidad < 10` (fila por fila) en vez de
   agrupar por producto y comparar el disponible total contra su
   `stock_minimo` real.
3. `fn_productos_lista` no tenía parámetros de mes/año, y
   `frontend/admin/js/productos.js` nunca los mandaba — `mesActivo` /
   `yearActivo` quedaban solo en el estado del cliente.

## Cambios

1. **`supabase/migrations/348_fix_doble_conteo_productos_en_stock.sql`**
   `productos_en_stock` / `productos_en_stock_global` ahora usan
   `COUNT(DISTINCT producto_id)`.

2. **`supabase/migrations/349_fix_criticos_usa_stock_minimo_real.sql`**
   `productos_criticos` agrupa por producto (disponible total = suma de
   `cantidad - cantidad_reservada` entre depósitos) y compara contra
   `GREATEST(stock_minimo, 5)`, igual criterio que `fn_kpis_dashboard`.

3. **`supabase/migrations/350_fix_filtro_mes_productos_lista.sql`**
   Se agregan `p_mes` / `p_anio` (nullable, retrocompatible) a
   `fn_productos_lista`, filtrando por
   `EXTRACT(MONTH/YEAR FROM created_at)`.

4. **`frontend/admin/js/productos.js`**
   `cargarProductos()` ahora envía `p_mes: mesActivo + 1` y
   `p_anio: yearActivo` en cada llamada al RPC.

## Verificación

Todo se verificó con datos reales de una empresa (Distribuidora del
Litoral, 1001–1002 productos):

- Productos en Stock: 2000 → **1000** (recalculado a mano, sin depender
  de la función, antes y después del fix).
- Críticos: 1 (umbral fijo) → **3–4** (umbral real por producto,
  variando según los datos verificados en distintos momentos de la
  sesión).
- Filtro de mes: se confirmó que el 100% del catálogo fue creado en
  julio 2026 (carga inicial); tras el fix, filtrar por julio 2026
  devuelve el total real y cualquier otro mes devuelve 0 — comportamiento
  esperado dado que no hay productos creados en otros meses todavía.

## Nota

Las migraciones 348 y 349 ya estaban aplicadas en el proyecto Supabase
(`jgiquzjwoedmzwqgzubr`) desde una sesión anterior vía `apply_migration`;
sus archivos `.sql` se agregan acá para sincronizar el historial del
repo con lo que ya está vigente en la base (mismo criterio que la
migración 256). La migración 350 se aplicó y se agrega en esta misma
sesión.
