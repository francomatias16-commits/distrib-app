# v690 — Cantidades solo enteras en todo el sistema

## Motivo
El input "Cantidad por unidad" del modal Receta (BOM) — `producto_insumos.cantidad_por_unidad`
— tenía `min="0.001" step="any"` sin ningún límite razonable. Al auditar el resto del
sistema para aplicar la regla de "solo enteros", se encontró una excepción de negocio
deliberada y en uso real: la migración 165 permitía decimales para productos vendidos
por peso (`unidad='kg'`: fiambres, pan, queso), con stock cargado en fracciones de kilo.

Se decidió eliminar esa excepción: a partir de esta versión **todas** las cantidades del
sistema son enteras, sin distinción por unidad de venta. Se verificó contra la base de
producción que no había ningún dato fraccionario cargado en ninguna columna de cantidad
antes de aplicar el cambio de tipo, por lo que la conversión no truncó ni redondeó
información real.

## Base de datos (ya aplicado en producción — incluido en el repo por trazabilidad)
- `449_cantidades_solo_enteros_paso2_stock.sql` — `stock.cantidad` / `cantidad_reservada`
  a `integer`; `cantidad_disponible` (generada) y triggers de auditoría/stock crítico
  recreados idénticos; se elimina `trg_stock_cantidad_entera` (obsoleto, reemplazado por
  el tipo de columna).
- `450_cantidades_solo_enteros_paso3_resto_tablas_final.sql` — resto de columnas de
  cantidad (`lotes`, `movimientos_stock`, `producto_insumos.cantidad_por_unidad`,
  `ordenes_compra_items`, `pedido_items`, `presupuesto_items`, `venta_pos_items`,
  `carrito_items`, `devolucion_items`, `devoluciones_pos_items.cantidad_devuelta`,
  `facturas_proveedor_items` -incl. recreación de `subtotal` generada-, `conteos_stock`,
  `ofertas_liquidacion.cantidad_snapshot`, `reglas_precio.cantidad_minima`) a `integer`;
  se eliminan los triggers/funciones de validación "cantidad entera" ahora redundantes;
  se recrean idénticas las vistas `v_rentabilidad_producto`, `v_rentabilidad_vendedor` y
  `v_rentabilidad_zona_ruta` (dependían de columnas alteradas).

## Frontend
- `frontend/admin/productos.html` — input de cantidad del modal Receta (BOM):
  `min="1" step="1"`.
- `frontend/admin/js/productos.js` — parseo de esa cantidad con `parseInt` en vez de
  `parseFloat`; mensaje de validación actualizado.
- `frontend/admin/js/pos.js` — input de cantidad a devolver: `step="1"`; parseo con
  `parseInt`.
- `frontend/admin/js/presupuestos.js` — input de cantidad de ítem: `min="1" step="1"`;
  `oninput` usa `parseInt` en vez de conversión implícita (`+this.value`).
- `frontend/admin/css/productos-modal-fix.css` — sumado el fix de z-index del modal de
  Receta (BOM) (`#modal-backdrop-receta` / `#modal-receta`) por encima del panel de
  producto, que no estaba incluido en la versión anterior del archivo.

## Impacto para el usuario
- ⚠️ Los productos vendidos por peso (fiambres, pan, queso, etc.) ya **no** admiten carga
  ni venta en fracciones de kilo — toda cantidad se redondea/valida a entero. Si en algún
  momento se necesita volver a vender por fracción de kilo, hay que revertir explícitamente
  esta regla (no es un descuido, fue una decisión consciente de este cambio).
