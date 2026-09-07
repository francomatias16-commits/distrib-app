# Migración de tools a faltaDato/bloqueado — cuarto lote (proveedores.js)

## Qué se migró

`lib/asistente-tools/proveedores.js` y, de paso, `resolverRecepcionOrdenCompra`
en `lib/asistente-tools/_helpers.js` (mismo criterio de "se migra al pasar" que
llevó a tocar `_helpers.js` en el lote de `pedidos.js`):

- **`crear_proveedor`**: mismo patrón exacto que `crear_cliente` (segundo
  lote) — "falta la razón social" pasó a
  `faltaDato('la razón social del proveedor')`; "ya existe un proveedor
  con ese CUIT/esa razón social" pasó a `bloqueado(motivo, salida)`.
  Mismo bug de concordancia preexistente que en `crear_cliente`
  ("esea razón social" en vez de "esa razón social") — se preservó tal
  cual, no se tocó redacción fuera del alcance de esta migración. No
  tenía test propio hasta ahora.

- **`recepcionar_orden_compra_asistente`**: "la orden no tiene renglones
  pendientes de recepción" (2 call sites idénticos, en `resumen()` y
  `execute()`) pasó a `bloqueado()`.

- **`resolverRecepcionOrdenCompra`** (`_helpers.js`, resolver compartido
  de la tool anterior): "la orden está cancelada" y "la orden ya fue
  recibida por completo" pasaron a `bloqueado()`. Los 3 casos de este
  lote (incluido el de arriba) ya tenían test cubriendo la redacción
  exacta en `tests/asistente/orden-compra.test.js` — se migraron
  preservando el string carácter por carácter, mismo truco que
  `ajustar_stock_asistente` en el primer lote (motivo cortado justo
  antes de la coma/punto para que `motivo + ' ' + salida` reproduzca el
  original).

## Qué NO se migró (a propósito)

- **"Falta indicar el número de la orden de compra."** (mismo resolver
  `resolverRecepcionOrdenCompra`): el test existente lo asserta literal
  y `faltaDato()` no puede reproducir esa redacción exacta — su
  plantilla fija es siempre "Me falta ... para seguir.". Se dejó sin
  migrar en vez de cambiarle la redacción a un test que no se pidió
  tocar (a diferencia de los casos de `bloqueado()`, acá no hay forma de
  preservar el string con la función tal como está).
- Los wrappers de error de DB/RPC del resto del archivo
  (`consultar_deuda_proveedor`, `listar_facturas_proveedor_por_vencer`,
  etc.), y los `data.error` que reenvían `crear_orden_compra_asistente` /
  `recepcionar_orden_compra_asistente` cuando la RPC de SQL devuelve
  `{ ok: false }`: igual que `crear_pedido` en el lote de `pedidos.js`,
  el string viene de una RPC, no es de autoría de este archivo.
- `consultar_links_portal_proveedor` / `generar_link_portal_proveedor` /
  `revocar_link_portal_proveedor`: reenvían `resultado.error` de
  `lib/handlers/portal_proveedor.js`, compartido con el panel admin —
  mismo criterio que `crear-pedido.js` en el lote de `pedidos.js`.
- Otros casos de `resolverRecepcionOrdenCompra`/`resolverOrdenCompraDesdeArgs`
  que tampoco encajan limpio en el contrato de 3 tipos ("no encontré
  ninguna orden de compra con número...", "\"X\" no está en la orden...",
  "la cantidad recibida de X debe ser mayor a cero"): ninguno es
  puramente "falta un dato" ni "bloqueado", mismo criterio de restricción
  de siempre.

## Test agregado / extendido

- **Nuevo**: `tests/asistente/proveedores-formato-error.test.js` (3
  tests) — `crear_proveedor`: sin razón social → `faltaDato`, sin tocar
  la DB; ya existe por razón social y por CUIT → `bloqueado`,
  verificando que el mensaje distingue ambos motivos y no cuelga
  `.opciones`.
- **Extendido** (no duplicado): `tests/asistente/orden-compra.test.js`
  ya cubría la redacción exacta de "orden cancelada", "orden ya
  recibida" y "sin renglones pendientes" — se agregó a esos 3 tests el
  check de `expect(err.opciones).toBeUndefined()` para confirmar que
  ahora también cumplen el contrato de `bloqueado()`, sin tocar la
  redacción ya asertada.

## Verificación

Suite completa corrida después del cambio: **114 archivos / 1601 tests,
sin regresiones** (subió de 113/1598 tras el lote de `pedidos.js`).

## Pendiente

Con esto quedan migrados los 4 archivos de tools con casos "falta un
dato"/"acción bloqueada" más evidentes (stock.js, clientes.js, pedidos.js,
proveedores.js). El resto de los ~15 archivos de tools por dominio queda
para migrar al pasar, según el propio diseño de Fase 3. Sigue pendiente
también el checklist de verificación manual de Fase 1.
