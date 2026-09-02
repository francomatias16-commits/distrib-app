# v796 — Stock: no ocultar más productos inactivos con stock real

## Problema
Jamón Cocido tenía un lote activo (40 u.) visible en "Lotes y vencimientos",
pero no aparecía en la pantalla de Stock. Causa: `fn_stock_lista_agrupada`
filtraba `p.activo = true`, ocultando productos desactivados aunque
tuvieran stock físico. Auditoría sobre producción: **59 productos
inactivos con 22.687 unidades totales** en la misma situación (stock
fantasma, invisible para reconciliar, transferir o dar de baja).

## Cambios (Supabase, aplicados directo — migración 494)
- `fn_stock_lista_agrupada`: ya no exige `p.activo = true`. Ahora un
  producto se muestra si está activo **o** si tiene stock != 0. Devuelve
  columna nueva `activo boolean`. Solo se ocultan inactivos ya en cero.
- Trigger nuevo `trg_guard_desactivar_producto_con_stock` (BEFORE UPDATE
  en `productos`): bloquea pasar `activo` de `true` a `false` si el
  producto todavía tiene stock != 0 en algún depósito. Obliga a ajustar
  el stock a cero antes de desactivar, para no repetir el caso.

## Frontend
- `stock.js`: fila de un producto inactivo con stock muestra tag
  "Producto inactivo" junto al nombre y badge de estado gris
  "Inactivo · <estado>" en vez del semáforo normal.
- `productos.js`: al guardar, si el guard de Supabase rechaza la
  desactivación (P0001), se muestra el mensaje real ("todavía tiene N
  unidades en stock...") en vez del toast genérico de error.
- CSS: `.badge-inactivo` y `.tag-producto-inactivo` agregados en
  `stock.css` y `stock-gentelella.css`.

## Pendiente / sugerido
Los 59 productos inactivos con stock detectados en la auditoría siguen
así — esta migración los hace visibles pero no los reconcilia. Conviene
revisarlos en una pasada aparte (¿reactivar? ¿ajustar a cero? ¿dar de
baja el remanente físico?) durante etapa 6 del plan de auditoría.
