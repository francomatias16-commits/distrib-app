# v955 — Fix hallazgos Crítico #0 y Alto #7 de AUDITORIA_BUGS_v954.md

## 1. `registrar_devolucion_pedido` (asistente de voz) ya no bypasea los controles de v805

**Antes:** `lib/asistente-tools.js` reimplementaba a mano el insert en
`devoluciones`/`devolucion_items` y la generación de notas de débito,
en vez de llamar a `crearDevolucionCore()` (la función que sí usan la app
del chofer y el alta manual del admin). Eso dejaba esta vía afuera de los
3 controles agregados a `crearDevolucionCore()` tras el incidente real
v805 (devolución aprobada de 4.555 u. de un producto con 42 u. compradas
en toda la historia del cliente, NC fantasma de ~$9.865.288,69, revertida
a mano):
1. cantidad ≤ comprado histórico − ya reservado en otras devoluciones no
   rechazadas del mismo producto+cliente,
2. si viene `pedido_id`, el producto tiene que pertenecer a ESE pedido,
3. `precio_unitario` recalculado server-side (nunca el que mande el
   body/modelo).

**Ahora:** `registrar_devolucion_pedido.execute()` llama directo a
`crearDevolucionCore()` (exportada desde `lib/handlers/pedidos.js`),
mismo patrón que ya usan `crear_pedido` (→ `crearPedidoParaCliente`) y
`anular_venta_pos` (→ RPC `anular_venta_pos`). `chofer_id` se pasa como
`usuarioId`, el usuario real de la conversación que confirmó la acción
(nunca un valor que pueda venir del texto del modelo).

**Efecto colateral (a favor):** `crearDevolucionCore()` dispara
`notifAuto()` al admin — la implementación vieja de esta tool
deliberadamente no lo hacía. Ahora el admin recibe el mismo aviso de
devolución pendiente sea cual sea la vía (chofer, alta manual o voz).

Archivos: `lib/handlers/pedidos.js` (export de `crearDevolucionCore`),
`lib/asistente-tools.js` (tool `registrar_devolucion_pedido`).

## 2. `GET /api/chofer/clientes` calculaba "hoy" en UTC

**Antes:** `new Date().toISOString().slice(0, 10)` — fecha en UTC. Como
Vercel corre en UTC y Argentina es UTC-3, de 21:00 a 23:59 hora ART esto
ya devolvía el día siguiente, y como casi nunca hay rutas creadas para
"mañana" a esa hora, la pantalla "Mis clientes" del chofer se veía vacía
aunque su ruta de hoy siguiera activa. Es el mismo bug que ya se había
corregido en la ruta hermana `GET /api/chofer/remitos`, pero con una
función local (`hoyArgentina()`) que no se compartía con el resto del
handler.

**Ahora:** `hoyArgentina()` se subió a scope de módulo en
`lib/handlers/pedidos.js` y la usan tanto `remitos` como `clientes`.

Archivo: `lib/handlers/pedidos.js`.

---
Ver `AUDITORIA_BUGS_v954.md` para el detalle completo de ambos hallazgos.
