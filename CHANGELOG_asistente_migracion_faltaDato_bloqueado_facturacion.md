# Migración de tools a faltaDato/bloqueado — quinto lote (facturacion.js) + fix de import roto

## Qué se migró (Fase 3, formato único de error)

`lib/asistente-tools/facturacion.js` y, de paso (mismo criterio que en los
lotes anteriores), los resolvers compartidos `buscarFacturaPorReferencia` /
`buscarPedidoFacturable` en `lib/asistente-tools/_helpers.js` — ambos
usados solo por las dos tools de este archivo:

- **`anular_factura`**: "Falta el motivo de la anulación" pasó a
  `faltaDato('el motivo de la anulación')`. El re-chequeo de estado en
  `execute()` ("la factura ya no está en estado emitida") pasó a
  `bloqueado()`.
- **`buscarFacturaPorReferencia`** (usada por `resolverFacturaParaAnular`,
  se dispara ya en `resumen()`): "ya está anulada" → `bloqueado()` sin
  salida; "está en estado X (sin CAE)" → `bloqueado(motivo, salida)`,
  partido en el punto para reproducir el string original carácter por
  carácter.
- **`buscarPedidoFacturable`** (usada por `resolverPedidoParaFacturar`,
  la resuelve `emitir_factura`): "está en estado X — todavía no se puede
  facturar" → `bloqueado()` sin salida; "ya tiene una factura emitida" →
  `bloqueado(motivo, salida)`, partido en el guión.
- **`emitir_factura`**: el caso `sin_configuracion_facturacion` en
  `execute()` pasó a `bloqueado(motivo, salida)`, partido en el guión
  ("—") del texto original para que la concatenación dé el mismo string.

## Qué NO se migró (a propósito)

- **"La referencia sigue siendo ambigua; pedile al usuario que elija una
  de las opciones mostradas."** (en `execute()`, ambas tools): a
  diferencia de `pedidos.js` (que hace `return resuelto.ambiguo` para
  preservar los candidatos con su lista real), acá se descarta el shape
  `{ambiguo:true, candidatos}` que ya devuelve el resolver y se tira un
  string genérico sin opciones. Es una inconsistencia real preexistente
  — el usuario pierde la lista de candidatos justo en el momento de
  confirmar — pero arreglarla implica cambiar comportamiento (reconstruir
  y devolver los candidatos), no solo formato de string. Queda señalado
  acá para una pasada futura, fuera del alcance de "formato único de
  error".
- "No se pudo releer la factura para anularla." / "No se pudo confirmar
  el pedido para facturar.": chequeos de consistencia interna (la fila
  desapareció entre el resolve y el re-read), no son "falta un dato" ni
  "bloqueado" de negocio.
- Los `resultado.error` / `resultado?.error` que reenvían
  `anularFactura()` / `emitirFactura()` (`lib/facturas.js`) y el wrapper
  de `listar_notas_credito`: mismo criterio de siempre, el string no es
  de autoría de este archivo.
- "Esa referencia coincide con más de una factura/uno un pedido. Pedile
  el UUID completo." (en ambos resolvers): mismo patrón repetido en ~8
  lugares más de `_helpers.js` (algunos ya tocados por lotes anteriores),
  ninguno migrado nunca — no hay candidatos con label distinguible para
  armar un `ambiguo()`, no encaja limpio en el contrato de 3 tipos.

## Regresión encontrada de paso (no es Fase 3)

El import dinámico `await import('./facturas.js')` en `anular_factura` y
`emitir_factura` apuntaba, desde `lib/asistente-tools/facturacion.js`, a
`lib/asistente-tools/facturas.js` — un archivo que **no existe**. El
resto del archivo importa con `'../'` (sube a `lib/`), pero estas dos
líneas se quedaron con la profundidad `'./'` de cuando el código vivía
directo en `lib/asistente-tools.js`, antes del split del 25/08/2026. En
la práctica, **ambas tools reventaban con `ERR_MODULE_NOT_FOUND` en
cuanto se ejecutaban de verdad** (nunca en `resumen()`, que no llega a
esa línea — por eso pasó desapercibido). Corregido a `'../facturas.js'`.

## Test agregado

`tests/asistente/facturacion-formato-error.test.js` (8 tests):

- `anular_factura`: sin motivo → `faltaDato` sin releer la factura;
  factura ya anulada → `bloqueado` sin salida; factura sin CAE →
  `bloqueado` con salida; la factura cambió de estado entre `resumen()` y
  `execute()` → `bloqueado` (y confirma que nunca llega a llamar
  `anularFactura`); camino feliz completo con `lib/facturas.js` mockeado
  (regresión directa del fix de import: si la ruta rota volviera, este
  test fallaría con `ERR_MODULE_NOT_FOUND` en vez de pasar).
- `emitir_factura`: pedido en borrador → `bloqueado` sin salida; pedido
  ya facturado → `bloqueado` con salida; `sin_configuracion_facturacion`
  con `lib/facturas.js` mockeado (misma regresión del import, del lado de
  `emitirFactura`).

Todos verifican `err.opciones === undefined` donde corresponde, y ninguno
pega contra la DB real ni contra ARCA/AFIP (`lib/facturas.js` mockeado
aparte porque es un import dinámico con efectos reales).

## Verificación

Suite completa corrida después del cambio: **115 archivos / 1609 tests,
sin regresiones** (subió de 114/1601 tras el lote de `proveedores.js`).

## Pendiente

Con esto quedan migrados 5 de ~16 archivos de tools por dominio (stock,
clientes, pedidos, proveedores, facturacion). El resto queda para migrar
al pasar, según el diseño de Fase 3. Candidatos con patrones evidentes
para la próxima pasada: `cobranzas.js` (2 call sites idénticos, "el monto
del cobro tiene que ser mayor a cero"), `pos.js`, `logistica.js`.

También queda pendiente, señalado arriba, revisar el descarte de
candidatos en el caso "la referencia sigue siendo ambigua" de
`anular_factura`/`emitir_factura` — no se tocó en este lote por ser un
cambio de comportamiento, no de formato.
