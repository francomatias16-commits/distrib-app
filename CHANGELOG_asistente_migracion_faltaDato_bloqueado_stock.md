# Migración de tools a faltaDato/bloqueado — primer lote (stock.js)

## Qué se migró

`lib/asistente-tools/stock.js`, 5 call sites, en 3 tools:

- **`crear_categoria` / `crear_deposito` / `crear_zona`** (mismo patrón
  idéntico en las tres): el chequeo "falta el nombre" pasó de
  `throw new Error('Falta el nombre de la categoría.')` a
  `throw faltaDato('el nombre de la categoría')`; el chequeo "ya existe"
  pasó de un string armado a mano a
  `throw bloqueado(\`Ya existe una categoría llamada "${existente.nombre}".\`, 'No hace falta crearla de nuevo.')`.
  Los mensajes finales quedan idénticos a los de antes — no había ningún
  test que los cubriera, así que no hay wording a preservar, pero se
  mantuvo la misma redacción por consistencia con la UX ya conocida.

- **`transferir_stock_asistente`**: el chequeo de stock insuficiente en
  origen pasó a `bloqueado(motivo, salida)`. No tenía test propio hasta
  ahora.

- **`ajustar_stock_asistente`** (rama `egreso`): mismo chequeo migrado a
  `bloqueado()`, pero preservando la redacción EXACTA (mismo string,
  carácter por carácter) porque `tests/asistente/ajustar-stock-y-conteo.test.js`
  ya la asserta literal con `.rejects.toThrow(...)`. Se logró pasando
  `motivo` terminado en `":"` y `salida` en minúscula — `bloqueado()`
  concatena `motivo + ' ' + salida`, así que el resultado final es
  carácter por carácter el mismo que antes de migrar. Se dejó un
  comentario en el código explicando por qué el motivo termina en `:`
  (no es un typo).

## Qué NO se migró (a propósito)

- `crear_producto` / `editar_producto`: el caso "no indicaste ningún
  cambio para aplicar" no encaja bien en `faltaDato(campo, ejemplo)` sin
  degradar la redacción (el mensaje actual es más específico y natural
  que lo que produciría la plantilla fija de `faltaDato`). Se deja para
  cuando se toque esa tool por otro motivo, tal como indica el propio
  diseño de Fase 3 ("se migra al pasar").
- El resto de `stock.js` (24 call sites más) y los otros 15 archivos de
  tools por dominio (~85 `throw new Error(...)` sueltos entre todos):
  sin tocar. Migración deliberadamente incremental, no de una sola vez.

## Test agregado

`tests/asistente/stock-maestros-y-transferencia-formato-error.test.js`
(8 tests) — cubre:

- Las 3 tools de creación de maestros, parametrizadas con
  `describe.each`: caso sin nombre (`faltaDato`, sin `.opciones`) y caso
  "ya existe" (`bloqueado`, sin `.opciones`).
- `transferir_stock_asistente`: stock insuficiente, mensaje y ausencia de
  `.opciones`.
- `ajustar_stock_asistente`: mismo caso, verificando que la redacción
  exacta se preservó y que ahora tampoco cuelga `.opciones`.

Mismo patrón de mock que `ajustar-stock-y-conteo.test.js` (solo se
mockea `lib/repos/_db.js`, los resolvers reales de `_helpers.js` corren
sin mockear).

## Verificación

Suite completa corrida después del cambio: **111 archivos / 1582 tests,
sin regresiones** (incluye el archivo viejo que asserta el mensaje
exacto de `ajustar_stock_asistente`, que sigue pasando tal cual).

## Pendiente

Seguir migrando de a un archivo/tool por vez cuando se toquen por otro
motivo, según el propio diseño de Fase 3. Candidatos naturales para la
próxima pasada (mismo patrón "no hay suficiente stock/saldo/crédito" =
`bloqueado`, o "falta un dato concreto" = `faltaDato`): `clientes.js`
(24 call sites), `pedidos.js` (19), `proveedores.js` (20).
