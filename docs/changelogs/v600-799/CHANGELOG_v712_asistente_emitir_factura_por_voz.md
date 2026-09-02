# v712 — Nueva tool `emitir_factura` (Fase A, ítem 3 — cierre)

## Reportado

Cierre del ítem 3 del backlog de `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`
(Fase A): faltaba la otra mitad de "emitir/anular factura" — con
`anular_factura` (v711) ya cerrada, quedaba emitir un comprobante nuevo
por voz.

## Decisión de alcance (confirmada con el usuario antes de escribir código)

Se preguntó explícitamente qué caso de uso tenía que cubrir: **replicar
el botón manual tal cual existe hoy**, no acotarlo a "un pedido puntual
mencionado de entrada". Antes de diseñar la tool se ubicó ese botón real:
**no vive en `facturacion.html`** (se había confirmado en la sesión
anterior, al investigar `anular_factura`, que ese grep no encontró nada) —
vive en `pedidos.html`, como botón por-pedido dentro del modal de detalle
(`generarFactura(pedidoId)` en `frontend/admin/js/pedidos.js`), habilitado
según una condición de elegibilidad puntual (`puedeFacturar`), no como un
selector de lista de pedidos facturables.

"Elegir cualquier pedido facturable" se tradujo entonces a: la tool
resuelve el pedido por ID corto o por nombre de cliente (mismo mecanismo
que el resto del archivo, reusando `resolverReferenciaParaDiagnostico`),
en vez de construir una tool de listado nueva — `listar_pedidos_pendientes`
y `diagnosticar_pedido` ya existen para que el usuario ubique cuál quiere
facturar antes de pedir la acción.

## Investigación previa

- `frontend/admin/js/pedidos.js` → `generarFactura(pedidoId)`: hace `POST
  /api/facturas` con `{ pedido_id }` (mismo endpoint que ya usa
  `anular_factura` para la rama `?accion=anular`, pero sin ese query
  param). Llama al mismo `lib/facturas.js`.
- Condición de elegibilidad real (`pedidos.js:802`, `puedeFacturar`):
  `facturaSinEmitir && p.estado !== 'borrador' && p.estado !== 'pendiente'
  && p.estado !== 'cancelado'`, donde `facturaSinEmitir = !p.factura_id ||
  ['pendiente','error_afip'].includes(p.factura_estado)`. Un pedido con
  una factura en `pendiente`/`error_afip` SÍ es elegible — el botón
  cambia el texto a "Reintentar Comprobante de Venta" en ese caso, y la
  nueva tool replica esa misma distinción en su `resumen()`.
- `lib/facturas.js` → `emitirFactura(pedidoId)`: acepta un pedido o una
  venta POS; si el origen ya tiene una factura `pendiente`/`error_afip`
  la reutiliza (reintento), si no crea una nueva; valida
  `facturacion_config` de la empresa antes de intentar (si falta,
  devuelve `codigo: 'sin_configuracion_facturacion'`, no un error
  genérico); llama a ARCA vía `emitirComprobanteARCA`; asienta el débito
  en cuenta corriente; emite el evento `pedido_facturado`.
- `lib/handlers/facturas.js` (rama POST sin `accion`): antes de llamar
  `emitirFactura`, valida explícitamente que el pedido pertenezca a la
  empresa del usuario autenticado — comentario `FIX (FACTURAS-002,
  auditoría 2026-07-26)` documenta que sin ese chequeo, `traerOrigenPedido`
  (llamado con service_role) no filtra por empresa por sí solo, así que
  cualquier rol facturador de una empresa podía emitir una factura ARCA
  real para un pedido de OTRA empresa. La tool nueva repite exactamente
  ese mismo chequeo antes de llamar `emitirFactura()`.
- Permisos: `puede(perfil, 'acceder', 'facturas')` → `['dueno', 'admin',
  'contador']` (`lib/permisos-service.js`), mismo gate que ya usa
  `anular_factura`.

## Cambios

### `lib/asistente-tools.js`

- Nueva tool `emitir_factura`:
  - `roles: ['dueno', 'admin', 'contador']`, `requiereConfirmacion: true`.
  - `resumen()` distingue "Generar" de "Reintentar" según si el pedido ya
    tiene una factura sin emitir, y muestra el error del intento anterior
    si lo hay.
  - `execute()` reconfirma referencia + elegibilidad en el momento de
    ejecutar (mismo criterio que `anular_factura`/`anular_venta_pos`), y
    repite el chequeo de pertenencia a empresa (FIX FACTURAS-002) justo
    antes de llamar `emitirFactura()` vía `import('./facturas.js')` —
    mismo import relativo que ya usa `anular_factura`.
  - Maneja el caso `codigo === 'sin_configuracion_facturacion'` con un
    mensaje específico (igual que hace el botón real), en vez de un error
    genérico.
- Nuevos helpers, junto a `buscarFacturaPorReferencia`:
  - `resolverPedidoParaFacturar`: reusa `resolverReferenciaParaDiagnostico`
    tal cual (tabla `pedidos`, columna `fecha_pedido`).
  - `buscarPedidoFacturable`: resuelve el ID corto/UUID en JS contra los
    pedidos de la empresa (mismo patrón que `buscarFacturaPorReferencia`)
    y ahí mismo aplica la condición `puedeFacturar` calcada del frontend.

## Riesgo conocido, no resuelto (mismo criterio que v711)

Misma limitación de `maxDuration: 60` compartido documentada en
`anular_factura` — la emisión contra ARCA puede tardar >30s. No se agregó
mitigación nueva, por consistencia con el resto del archivo.

## Verificación

- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`
  (pasa limpio).
- **Pendiente, no se pudo hacer desde este entorno**: prueba funcional
  end-to-end — generar por ID corto y por nombre de cliente, reintentar
  un pedido con factura en `error_afip`, intentar facturar un pedido
  `borrador`/`cancelado` (debe rechazar), intentar facturar uno con
  factura ya `emitida` (debe rechazar y sugerir `anular_factura`), y el
  caso de empresa sin `facturacion_config` (debe dar el mensaje
  específico, no un error genérico). Mismo pendiente que v709-v711.

## Cómo queda

El ítem 3 de la Fase A queda cerrado: el asistente puede emitir (o
reintentar) y anular facturas por voz, con el mismo nivel de
confirmación reforzada que el resto de las acciones de mayor riesgo del
archivo. La fila `facturacion.html` del inventario de §2 del plan pasa
de 🟠 a 🟢.

## Archivos modificados

- `lib/asistente-tools.js`

## Siguiente paso (Fase A, ítem 4 del plan)

Ajuste manual de stock (`ajustar_stock`) y orden de compra — cierre de
`compras.html`. Mismo criterio que emitir_factura: antes de tocarlo,
confirmar con el usuario si "ajustar stock por voz" cubre cualquier
ajuste (alta/baja/corrección) o solo un subconjunto, y revisar si
`ajustar_stock` ya es una RPC apta para service_role (con `p_empresa_id`
explícito) o si va a hacer falta el mismo rodeo que usaron
`crear_producto`/`editar_producto` en v710.
