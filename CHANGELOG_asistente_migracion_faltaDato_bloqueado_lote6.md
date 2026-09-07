# Migración de tools a faltaDato/bloqueado — sexto lote (6 archivos chicos)

## Qué se migró (Fase 3, formato único de error)

A diferencia de los lotes anteriores (un archivo por vez), este lote
agrupa seis archivos de tools por dominio que solo tenían 1-2 call
sites migrables cada uno. Mismo criterio de siempre.

- **`pos.js` — `anular_venta_pos`**: "Falta el motivo de la anulación" →
  `faltaDato('el motivo de la anulación')` (mismo patrón que
  `anular_factura`). De paso, en `buscarVentaPosPropia` (`_helpers.js`,
  usada solo por esta tool): "Falta la referencia de la venta" →
  `faltaDato()`; "ya está anulada" y "ya tiene una factura generada" →
  `bloqueado()`. Esta función devuelve `{ error: <string> }` en vez de
  tirar (igual que `buscarPedidoSugeridoPropio` en el lote de
  `pedidos.js`), así que se migró extrayendo `.message` de
  `faltaDato()`/`bloqueado()`.
- **`cheques-bcra.js` — `consultar_cheque_denunciado_bcra`**: "Faltan
  codigo_entidad y numero_cheque..." → `faltaDato('el código de entidad
  y el número de cheque')` (un solo campo compuesto, cubre ambos casos).
- **`admin.js` — `actualizar_datos_empresa`**: el CUIT duplicado
  (constraint `23505` de Postgres) → `bloqueado()`, en vez del mensaje
  crudo de la constraint.
- **`conciliacion-bancaria.js` — `conciliar_lote_automatico`**: "El lote
  X no tiene movimientos pendientes de conciliar" (en `resumen()`, no se
  re-chequea en `execute()` — preexistente, fuera de alcance) →
  `bloqueado()`.
- **`export-contable.js` — `generar_export_contable`**: "Falta
  configurar el plan de cuentas..." → `bloqueado()` sin salida. "El
  formato X todavía no está implementado..." → `bloqueado(motivo,
  salida)`, partido en el punto para reproducir el string original.
- **`notificaciones.js` — `consultar_preferencias_notificaciones`**:
  "Esta empresa todavía no tiene preferencias configuradas" →
  `bloqueado()` (no es "falta un dato del usuario": es un estado de la
  empresa que bloquea poder responder la consulta).

## Qué NO se migró (a propósito)

- Los wrappers de error de DB/RPC (`${error.message}`) en los seis
  archivos: no son de autoría de este código.
- "'desde' no puede ser posterior a 'hasta'" (`export-contable.js`) y
  "Motor inválido: X" (`automatizacion.js`, no tocado en este lote):
  validación de un valor inválido dado por el usuario, no "nunca lo
  dio" ni "acción bloqueada" — mismo criterio que excluyó "el monto debe
  ser mayor a cero" en `clientes.js`/`cobranzas.js` y "cantidad recibida
  debe ser mayor a cero" en `proveedores.js`.
- "No especificaste ningún dato para cambiar" (`automatizacion.js`,
  `precios.js`, `liquidacion.js`): mismo patrón ya excluido a propósito
  en `crear_producto`/`editar_producto` (lote de `stock.js`).
- "Esa referencia coincide con más de un/a X" (`conciliacion-bancaria.js`
  y `buscarVentaPosPropia`): mismo patrón repetido en ~9 lugares de
  `_helpers.js`, ninguno migrado nunca — no hay candidatos con label
  distinguible, no encaja limpio en `ambiguo()`.
- **`cobranzas.js` no se tocó en este lote**: sus únicos 2 call sites
  ("el monto del cobro tiene que ser mayor a cero") son exactamente el
  patrón de validación de valor excluido arriba — no hay nada más en ese
  archivo que encaje en `faltaDato`/`bloqueado`.

## Test agregado

`tests/asistente/lote6-formato-error.test.js` (10 tests) cubre los seis
archivos de arriba: `anular_venta_pos` (4 casos, incluyendo el camino
`faltaDato` que se dispara desde `buscarVentaPosPropia` antes de llamar
al RPC), `consultar_cheque_denunciado_bcra`, `actualizar_datos_empresa`,
`conciliar_lote_automatico`, `generar_export_contable` (2 casos: plan de
cuentas sin configurar, y formato no implementado con
`lib/export-contable/index.js` mockeado) y
`consultar_preferencias_notificaciones`. Todos verifican
`err.opciones === undefined` donde corresponde.

## Verificación

Suite completa corrida después del cambio: **116 archivos / 1619 tests,
sin regresiones** (subió de 115/1609 tras el lote de `facturacion.js`).

## Pendiente

Con esto quedan migrados 5 archivos "grandes" (stock, clientes, pedidos,
proveedores, facturacion) + 6 archivos chicos de este lote (pos,
cheques-bcra, admin, conciliacion-bancaria, export-contable,
notificaciones) = 11 de ~16 archivos de tools por dominio. Quedan sin
tocar: `automatizacion.js`, `precios.js`, `liquidacion.js`,
`logistica.js`, `cobranzas.js` (revisado en este lote, sin candidatos
limpios).

Sigue pendiente, señalado en el changelog anterior, revisar el descarte
de candidatos en el caso "la referencia sigue siendo ambigua" de
`anular_factura`/`emitir_factura` — no es alcance de esta migración de
formato.
