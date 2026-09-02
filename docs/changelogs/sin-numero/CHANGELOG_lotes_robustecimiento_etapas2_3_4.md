# Robustecimiento de trazabilidad de lotes — Etapas 2, 3 y 4

Continuación de la Etapa 1 (`movimientos_stock_lotes`, migraciones 462-468).
Migraciones DB: **469, 470, 471** (aplicadas en vivo sobre `jgiquzjwoedmzwqgzubr`).

## Etapa 2 — Unificar transferencias (Problema 2, bug activo)

`transferir_stock()` (la función real conectada al botón "Transferir stock"
de `stock.js:1435`) creaba en destino un lote vacío `TRANSF-fecha` **sin**
vencimiento, costo ni fecha de fabricación — apagaba silenciosamente la
alerta de "por vencer" y perdía el costo.

- Migración **469**: `transferir_stock()` ahora reparte el origen en sus
  lotes reales (FEFO) y clona cada uno al depósito destino preservando
  `numero_lote`, `fecha_vencimiento`, `fecha_fabricacion` y
  `costo_unitario` — mismo criterio que `transferir_stock_entre_depositos`
  (la usada por POS, que ya lo hacía bien).
- Ambas funciones (`transferir_stock` y `transferir_stock_entre_depositos`)
  quedan además insertando el detalle en `movimientos_stock_lotes`
  (Etapa 1), con trazabilidad completa origen → destino.
- Se mantuvo intacto: dedup offline por `offline_local_id`, orden de
  locking determinístico, chequeos de autorización/empresa, y la forma de
  las filas de `movimientos_stock` que ya consume el frontend.

## Etapa 3 — Editar lote deja de ser silencioso (Problema 4)

El PATCH de "Editar lote" cambiaba `lotes.cantidad` directo, sin tocar
`cantidad_disponible`, sin sincronizar `stock`, y sin dejar ningún
`movimientos_stock`.

- Migración **470**: nueva función `fn_lotes_ajustar_cantidad(lote_id,
  cantidad_nueva, motivo, usuario_id)`, atómica:
  - Sincroniza `cantidad` **y** `cantidad_disponible` del lote.
  - Sincroniza la tabla `stock` agregada del depósito del lote (si tiene
    depósito asignado).
  - Inserta el `movimientos_stock` correspondiente (ingreso/egreso según
    el signo del delta) + su detalle en `movimientos_stock_lotes`.
  - Exige `motivo` (no vacío) — sin motivo, rechaza el ajuste.
- `lib/handlers/stock.js` (PATCH `/api/lotes`): si viene `cantidad`, exige
  `motivo` en el body y enruta por la RPC. El resto de los campos
  (`estado`, `fecha_vencimiento`, `costo_unitario`, `numero_lote`) se
  siguen editando directo porque no impactan stock.
- **Bug preexistente encontrado de paso**: el mismo PATCH ignoraba
  `deposito_id` y `fecha_fabricacion` aunque el frontend ya los mandaba —
  justo el flujo que la ayuda de "dar de baja" le pide al usuario para
  asignarle depósito a un lote legado nunca funcionaba. Corregido (con
  la misma validación de pertenencia a empresa que el alta).
- Frontend (`vencimientos.html` + `lotes.js`): el modal "Editar lote"
  ahora muestra un campo "Motivo del ajuste de cantidad" que aparece solo
  cuando la cantidad cambió respecto al valor original, y es obligatorio
  para guardar. Si la cantidad no cambió, ni se manda el campo (no genera
  movimiento de stock por una edición de, por ejemplo, la fecha de
  vencimiento).

## Etapa 4 — Soft-delete de lotes (Problema 3)

`DELETE /api/lotes` hacía un `DELETE FROM lotes` físico sobre lotes en 0,
perdiendo numero_lote, fechas y costo para siempre — y ese historial
quedaba huérfano porque `movimientos_stock` no lo referenciaba de forma
confiable (ya resuelto en Etapa 1).

- Migración **470**: se agregó `'eliminado'` como valor válido de
  `lotes.estado` (antes solo `activo/agotado/vencido`).
- `lib/repos/stock.js`: `eliminarLote()` ahora hace
  `UPDATE lotes SET estado='eliminado'` en vez de `DELETE`. El handler ya
  validaba `cantidad === 0` antes de llamarlo, así que no hace falta
  tocar stock/movimientos en este paso.
- `listarLotes()` excluye `estado = 'eliminado'` por defecto — no aparecen
  en la grilla de "Lotes y vencimientos", pero el registro sigue en la
  base para auditoría/historial.
- **Bug encontrado y corregido en el mismo movimiento** (migración
  **471**): `actualizar_estado_lotes()` se ejecuta automáticamente en
  cada `listarLotes()` para autocorregir vencido/agotado, y su segunda
  UPDATE marcaba `agotado` a **cualquier** lote con `cantidad = 0` y
  `estado <> 'agotado'` — eso incluía a los recién soft-deleteados,
  revirtiendo el borrado lógico en la siguiente lectura. Se excluyó
  `'eliminado'` de esa transición automática.

## Estado del plan completo

| # | Problema (diagnóstico original) | Estado |
|---|---|---|
| 1 | Sin vínculo lote ↔ movimiento | ✅ Etapa 1 (462-468) |
| 2 | Transferencia borra vencimiento/costo | ✅ Etapa 2 (469) |
| 3 | Se puede borrar un lote para siempre | ✅ Etapa 4 (470, 471) |
| 4 | Editar lote no deja rastro ni sincroniza | ✅ Etapa 3 (470) |
| 5 | `producir_con_insumos` no hereda costo | ✅ ya resuelto en Etapa 1 (466/467) |
| 6 | `confirmar_despacho_stock` huérfana | ✅ corregida igual en Etapa 1 (468), por las dudas |

Los 6 puntos del diagnóstico quedan contemplados. Recomiendo probar en un
entorno de prueba: crear un lote, editar su cantidad (con y sin motivo),
transferirlo entre depósitos y verificar que el lote destino conserva
vencimiento/costo, y darlo de baja/eliminarlo para confirmar que sigue
apareciendo en `movimientos_stock_lotes` pero no en el listado de
"Lotes y vencimientos".
