# v500 — Asistente: "cargar un pedido" por chat (tool `crear_pedido`)

## Qué cambia

Segunda tool de escritura del asistente de ayuda (misma infraestructura de
confirmación de v499): ahora se le puede pedir por chat que arme un pedido
para un cliente ("cargale 10 cajas de coca a Pérez"), y propone un resumen
con el total real (precio de servidor, no inventado) para que el usuario
confirme antes de que se cree nada.

## Archivos modificados

- `lib/handlers/pedidos.js` — se extrajo toda la lógica de negocio de
  `crearPedidoAdminHandler` (antes: ~160 líneas mezcladas con el manejo de
  request/response) a una función pura exportada `crearPedidoParaCliente()`,
  con un modo `preview:true` que valida todo (cliente activo, stock,
  precios vía `resolver_precios_cliente`, límite de crédito, límite de
  plan) y calcula los totales reales sin tocar la base. El handler HTTP
  original (`crearPedidoAdminHandler`) quedó como wrapper fino sobre esa
  función — mismos códigos de estado (400/404/409/500) y mismo body de
  respuesta que antes del refactor, verificado línea por línea contra el
  original. También se exportó `ROLES_ADMIN`.
  Motivo de extraerlo en vez de reimplementar en el asistente: esta misma
  lógica ya se había duplicado antes entre el portal cliente y el admin
  (ver comentario "CONS-01/02/03" en `lib/calc/pedido-totales.js`) — no
  quería sumar una tercera copia divergente.
- `lib/asistente-tools.js` — tool nueva `crear_pedido` (roles: los mismos
  que ya tenía habilitados `crearPedidoAdminHandler`); dos helpers nuevos
  `buscarClientePorTexto()` / `buscarProductoPorTexto()` que resuelven
  texto libre del usuario a `cliente_id`/`producto_id` (mismo escapado de
  `.or(...ilike...)` que ya usa `lib/handlers/busqueda.js`, reusado tal
  cual); `resumen()` corre `crearPedidoParaCliente(preview:true)`,
  `execute()` vuelve a resolver todo de cero contra el estado actual antes
  de confirmar en firme.
- `lib/handlers/asistente.js` — el bloque de tools del system prompt
  (`armarSystemPrompt`) solo mencionaba las de lectura y se había quedado
  desactualizado desde que se agregó `anular_venta_pos` en v499; se agregó
  el párrafo que explica que el asistente también puede proponer acciones
  de escritura y que nunca debe decir que ya las hizo antes de la
  confirmación.

## Fix de consistencia sobre v499

`anular_venta_pos.resumen()` devolvía el mensaje de error (venta ya
anulada / con factura / no encontrada) como si fuera el resumen normal a
confirmar — el usuario terminaba viendo un botón "Confirmar" sobre un
error que en realidad no se podía confirmar. Se cambió `return
venta.error` por `throw new Error(venta.error)`, igual que ya hace
`crear_pedido` desde el vamos: un resumen que falla ahora se le explica al
modelo como error de la función (sin botón), no como una propuesta
inválida esperando click.

## Verificado antes de armar el zip

- `node --check` en los 3 archivos tocados
- Import real (con dependencias instaladas) de los 4 módulos afectados —
  sin ciclos, sin referencias rotas
- Serialización del schema de `crear_pedido` para Gemini (`esquemaParaGemini`)
- Que `resolver_precios_cliente` y las columnas de `clientes`/`productos`
  usadas por los helpers nuevos existen tal cual en `001_schema.sql` y
  `243_etapa2_motor_reglas_precio.sql`
- Que los códigos de estado HTTP de `crearPedidoAdminHandler` no cambiaron
  tras el refactor (comparación campo a campo contra el handler original)

## Nota pendiente (no nueva, ya conocida del proyecto)

La RPC `crear_pedido_cliente` (la que efectivamente crea el pedido) no
tiene su definición en `supabase/migrations/` — mismo "gap de disaster
recovery" ya señalado en auditorías anteriores del proyecto. No se tocó
la RPC en este cambio (solo se la sigue llamando igual que ya hacía
`crearPedidoAdminHandler`), pero conviene en algún momento rescatar su
definición real desde producción y sumarla al repo.
