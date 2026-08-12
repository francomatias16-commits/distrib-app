# v402 — Stock: tabla agrupada por producto (no repite fila por depósito)

## Problema
En `stock.js`, con el filtro "Todos los depósitos" activo, la tabla mostraba
una fila por cada combinación producto+depósito. Un producto con stock en 3
depósitos ocupaba 3 filas idénticas salvo por la columna Depósito — y esto
empeora linealmente con cada depósito nuevo que se agregue (el pedido
concreto: "imaginate si llego a sumar diez depósitos nuevos, es redundante").

## Solución
- **Migración `396_fn_stock_lista_agrupada.sql`** (ya aplicada en producción,
  proyecto `jgiquzjwoedmzwqgzubr`):
  - `fn_stock_lista_agrupada(...)`: RPC paginada, mismo patrón que
    `fn_productos_lista` / `fn_pedidos_lista`. Agrupa por producto sumando
    disponible/reservado/total entre depósitos, con costo promedio ponderado
    por cantidad. Si se pasa `p_deposito_id`, se comporta igual que antes
    (1 fila = 1 depósito, porque solo ese depósito aporta a la suma).
    Respeta los mismos filtros que la tabla ya tenía: búsqueda, categoría,
    depósito, estado (crítico/bajo/ok) y una lista de IDs de producto (usada
    por el filtro "Bajo su mínimo", que sigue resolviéndose vía
    `/api/admin/stock/bajo` porque compara contra el `stock_minimo` propio
    de cada producto).
  - `fn_stock_depositos_producto(p_producto_id)`: breakdown por depósito de
    un producto puntual, para expandir el detalle sin tener que traer todo
    de antemano.
  - Ambas con `SECURITY DEFINER` + `get_empresa_id()` para el scoping por
    tenant, y `REVOKE ... FROM PUBLIC, anon` / `GRANT ... TO authenticated,
    service_role` — mismo patrón de permisos que el resto de las RPC que el
    frontend llama directo con la sesión del usuario.

- **`stock.js` (v42)**:
  - `cargarStock()` ahora llama a `fn_stock_lista_agrupada` en vez de hacer
    la query directa contra `stock` con join. Se simplificó también la
    búsqueda (antes resolvía IDs de producto con una query aparte; ahora la
    RPC filtra por nombre/código internamente).
  - `renderTabla()` reconoce filas con `n_depositos > 1` y en la columna
    Depósito muestra un botón "N depósitos" en vez del nombre. Al hacer
    clic expande una fila de detalle (`fn_stock_depositos_producto`, con
    cache en memoria por producto mientras dura la página) con el
    desglose real por depósito, cada uno con su propio botón "Ajustar".
  - El botón "Ajustar stock" de una fila agrupada abre el modal con el
    depósito principal preseleccionado (o el primero de la lista si no hay
    principal marcado); el selector de depósito del modal permite
    cambiarlo antes de guardar, igual que siempre.
  - `resaltarFilaActualizada()` ahora tiene un fallback: si no encuentra la
    fila por producto+depósito exacto (porque la fila visible es agrupada y
    no tiene un `data-dep-id` puntual), resalta por producto solamente.
  - Sin cambios en `cargarHistorial()` (ya mostraba movimientos de todos los
    depósitos del producto) ni en `exportarExcel()` (se mantiene el detalle
    fila-por-depósito en el Excel, que es lo más útil para un archivo que se
    puede filtrar/pivotear aparte).

- **CSS (`stock.css`, `stock-gentelella.css`)**: estilos para el botón de
  expandir, la fila de detalle y el desglose por depósito, incluyendo los
  overrides del reskin Gentelella para que no rompa el tema oscuro/claro ya
  aplicado a toda la pantalla.

## Resultado
Con "Todos los depósitos": 1 fila por producto, sin importar si tiene stock
en 2 o en 20 depósitos. Con un depósito puntual filtrado: comportamiento
idéntico al de antes (1 fila = 1 depósito).
