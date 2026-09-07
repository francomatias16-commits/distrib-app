# Migración de tools a faltaDato/bloqueado — séptimo lote (automatizacion.js, precios.js)

## Qué se migró (Fase 3, formato único de error)

Siguiendo el orden del plan (`automatizacion.js`, `precios.js`,
`liquidacion.js`, `logistica.js`), estos dos primeros tuvieron
candidatos — pero no en las tools en sí, sino un nivel más abajo, en
funciones compartidas de `_helpers.js` usadas solo por ellos:

- **`armarAccionRegla`** (usada por `crear_regla_automatizacion_asistente`
  y `editar_regla_automatizacion_asistente`, vía
  `armarCamposReglaAutomatizacion`/`armarCambiosReglaAutomatizacion`):
  "Falta indicar qué debe hacer la regla cuando se dispare..." →
  `faltaDato()` sobre `accion_tipo`; "La notificación necesita un
  título"/"...un mensaje" → `faltaDato()` por campo; "La tarea necesita
  un título" → `faltaDato()`.
- **`armarCondicionRegla`** (misma vía): "Falta el valor de la
  condición." → `faltaDato()` — se da `condicion_campo` pero no
  `condicion_valor`.
- **`armarCamposReglaAutomatizacion`** / **`buscarReglaAutomatizacionPorTexto`**:
  "Falta el nombre de la regla de automatización" (dos call sites, uno
  al crear y otro al resolver la referencia para editar) → `faltaDato()`.
- **`armarCamposReglaPrecio`** / **`buscarReglaPrecioPorTexto`**: mismo
  patrón exacto para `precios.js` — "Falta el nombre de la regla de
  precio" (crear y buscar por referencia) → `faltaDato()`.

## Qué NO se migró (a propósito)

- "No especificaste ningún dato para cambiar de la(s) regla(s)"
  (`automatizacion.js`, `precios.js`): mismo patrón ya excluido en
  `crear_producto`/`editar_producto` (lote de `stock.js`).
- Validaciones de un valor ya dado pero inválido: "El evento disparador
  debe ser uno de...", "El operador de la condición debe ser uno de...",
  "Motor inválido: X" (`automatizacion.js`); "El tipo de descuento debe
  ser...", "El valor del descuento es inválido.", "Un descuento
  porcentual no puede superar el 100%.", "La fecha 'desde' no puede ser
  posterior a 'hasta'" (`precios.js`) — mismo criterio que excluyó "el
  monto debe ser mayor a cero" en lotes anteriores.
- "Template de WhatsApp inválido (debe ser uno de: ...)"
  (`armarAccionRegla`): el check dispara tanto si falta el template como
  si es inválido, pero el mensaje se autodescribe como "inválido", no
  "falta" — se lo trató igual que los demás casos de enum excluidos.
- "Elegí producto o categoría para la regla, no las dos a la vez."
  (dos call sites en `precios.js`): combinación de argumentos inválida
  dada por el usuario, no "nunca lo dio" ni "acción bloqueada".
- "No se pudo leer la regla de precio/automatización actual.": chequeo
  de consistencia interna (la fila desapareció entre el resolve y el
  re-read), mismo criterio que en `facturacion.js`.
- Los wrappers de `${error.message}` que reenvían errores de
  `crearReglaAutomatizacion`/`actualizarReglaAutomatizacion`/
  `crearReglaPrecio`/`actualizarReglaPrecio`: no son de autoría de este
  archivo.

## `liquidacion.js` y `logistica.js`: sin candidatos

Revisados en este lote, siguiendo el orden acordado — ninguno tuvo un
call site que encaje en `faltaDato`/`bloqueado`:

- **`liquidacion.js`**: sus únicos throws propios son "No especificaste
  ningún dato para cambiar..." (ya excluido) y wrappers de RPC/repo. El
  único chequeo de valor real (`armarCambiosReglaLiquidacion`, "el
  descuento del nivel N tiene que estar entre 0 y 100") es validación de
  rango, mismo criterio de exclusión que en `precios.js`.
- **`logistica.js`**: sus cinco tools (`consultar_ruta_dia`,
  `consultar_invitaciones_chofer`, `invitar_chofer_nuevo`,
  `invitar_chofer_existente`, `revocar_invitacion_chofer`) solo
  reenvían `resultado.error` de `lib/handlers/chofer_invitacion.js` o
  `error.message` de una RPC — ninguno es de autoría de este archivo.

Mismo caso que `cobranzas.js` en el lote anterior: quedan revisados y
sin tocar por no tener nada que migrar, no por descuido.

## Test agregado

`tests/asistente/lote7-formato-error.test.js` (11 tests): 6 sobre
`crear_regla_automatizacion_asistente` (sin nombre, sin `accion_tipo`,
`notificar_push` sin título/mensaje, `crear_tarea` sin título,
`condicion_campo` sin `condicion_valor`, más un camino feliz), 1 sobre
`editar_regla_automatizacion_asistente` (sin referencia, `faltaDato`
antes de tocar la DB), 1 sobre `crear_regla_precio_asistente` (sin
nombre) y 2 sobre `editar_regla_precio_asistente` (sin referencia, y un
caso de regresión de ruta con referencia real pero regla inexistente,
para confirmar que no interfiere con el `faltaDato` del nombre).

## Verificación

Suite completa corrida después del cambio: **117 archivos / 1630 tests,
sin regresiones** (subió de 116/1619 tras el sexto lote).

## Pendiente

Con esto quedan migrados 5 archivos grandes (stock, clientes, pedidos,
proveedores, facturación) + 6 chicos del sexto lote + 2 del séptimo
(automatización, precios) = 13 de ~16 archivos de tools por dominio.
Quedan sin candidatos (revisados y descartados): `cobranzas.js`,
`liquidacion.js`, `logistica.js`. No queda ningún archivo de tools por
dominio sin revisar — la Fase 3 de "formato único de error" está
efectivamente completa en su alcance original (call sites que encajan
limpio en el contrato de 3 tipos).

Sigue pendiente, señalado en changelogs anteriores, revisar el descarte
de candidatos en el caso "la referencia sigue siendo ambigua" de
`anular_factura`/`emitir_factura` — cambio de comportamiento, no de
formato, fuera de alcance de esta migración.
