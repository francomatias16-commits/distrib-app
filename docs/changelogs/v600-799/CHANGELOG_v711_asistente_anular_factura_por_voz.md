# v711 — Nueva tool `anular_factura` (Fase A, ítem 3 — primera mitad)

## Reportado

Tercer ítem del backlog de `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`
(Fase A): `facturacion.html` no tiene ninguna tool de escritura — no se
puede anular una factura por voz, pese a ser una acción diaria y de
mayor riesgo que las ya cerradas (cobros v709, productos v710), por lo
que el plan la deja para después de esas dos a propósito.

## Investigación previa (retomada de la sesión anterior)

Antes de escribir código se relevó el flujo real completo de anulación
de facturas, sin asumir nada del plan original:

- `frontend/admin/js/facturacion.js` → `anular()`: hace `POST
  /api/facturas/anular` con `factura_id` + `motivo`, con un
  `AbortController` de 45s porque la emisión ARCA puede superar el
  límite de 30s reportado en producción — si el fetch aborta, el
  frontend no asume error: recarga y avisa que puede haber terminado
  igual en el backend.
- `vercel.json`: la ruta pasa por el dispatcher único `api/index.js`
  (`_mod=facturas`), que corre bajo `maxDuration: 60` — no hay un límite
  aparte para la sub-ruta de anulación.
- `lib/handlers/facturas.js` → `anularFacturaHandler`: valida rol
  (`['dueno','admin','contador']`), que la factura pertenezca a la
  empresa del usuario, y que `estado === 'emitida'` — rechaza cualquier
  otro estado con 400.
- `lib/facturas.js` → `anularFactura(factura, motivo)`: llama a
  `emitirNotaCreditoARCA(factura.id, motivo)` (Nota de Crédito real
  contra ARCA/AFIP), relee la factura NC resultante, dispara el PDF en
  background y emite el evento `factura_anulada`. **Nunca pisa
  `facturas.estado` a mano** — el estado nuevo lo deja la NC real.
- Ya existe un precedente exacto de este mismo llamado dentro de
  `lib/asistente-tools.js`: `cancelar_pedido_asistente` (paso 5) ya
  importa `anularFactura` de `./facturas.js` con `await
  import('./facturas.js')` cuando el pedido que cancela tiene una
  factura con CAE vinculada. Se reusa el mismo camino en vez de
  inventar uno nuevo.
- No existe una RPC `diagnosticar_factura` (a diferencia de pedido/
  presupuesto/venta_pos) ni una `anular_factura` a nivel de base — es
  lógica JS pura en `lib/facturas.js`, así que la tool no llama
  `db.rpc(...)` para la acción en sí (sí para nada de esto, en
  realidad: todo es `db.from('facturas')` + el import directo).

## Cambios

### `lib/asistente-tools.js`

- Nueva tool `anular_factura`:
  - `roles: ['dueno', 'admin', 'contador']` — calcado de
    `anularFacturaHandler`.
  - `requiereConfirmacion: true`, con `resumen()` que arma la frase con
    tipo, número, cliente, total y motivo, y aclara explícitamente que
    emite una Nota de Crédito real contra ARCA/AFIP y que no se puede
    deshacer (mismo nivel de confirmación reforzada que `anular_venta_pos`
    y `cancelar_pedido_asistente`, no una confirmación "liviana").
  - Solo actúa sobre facturas en estado `emitida` (con CAE real) — si la
    factura está `pendiente` o ya `anulada`, la tool corta con un mensaje
    explicando por qué (para `pendiente`, aclara que no hace falta
    anularla fiscalmente: alcanza con cancelar el pedido/venta que la
    generó).
  - `execute()` relee la factura completa desde `facturas` (scopeada por
    `empresa_id`) inmediatamente antes de llamar `anularFactura()` —
    mismo criterio de "reconfirmar en el momento de ejecutar, no solo al
    proponer" que ya usan `anular_venta_pos` y `cancelar_pedido_asistente`,
    por si el estado cambió entre la propuesta y la confirmación.
- Nuevos helpers, junto a `resolverReferenciaParaDiagnostico`:
  - `resolverFacturaParaAnular`: reusa `resolverReferenciaParaDiagnostico`
    tal cual (tabla `facturas`, columna `fecha_emision`) para resolver
    por ID corto o por nombre de cliente — no duplica ese mecanismo.
  - `buscarFacturaPorReferencia`: como no hay RPC `diagnosticar_factura`,
    resuelve el ID corto/UUID en JS contra las facturas de la empresa
    (mismo patrón que `buscarMovimientoBancarioPorReferencia`) y ahí
    mismo valida `estado === 'emitida'`, sea cual sea el origen de la
    referencia (directa o resuelta por cliente).

## Riesgo conocido, no resuelto en este cambio (documentado a propósito)

La emisión/anulación contra ARCA puede tardar más de 30s, y todo
`api/index.js` corre bajo un único `maxDuration: 60` compartido con el
resto del asistente (procesamiento del modelo, otras tools del mismo
turno). No se agregó ninguna mitigación nueva porque
`ejecutar_cierre_financiero_pendiente` y `ejecutar_motor_automatizacion`
(motor `cierre`) ya asumen exactamente el mismo riesgo sin mitigación
especial, llamando a ARCA desde el mismo dispatcher — se prioriza
consistencia con el resto del archivo antes que resolver esto de forma
aislada para una sola tool.

## Verificación

- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`
  (pasa limpio).
- **Pendiente, no se pudo hacer desde este entorno** (sin credenciales
  de Supabase ni acceso a ARCA homologación): prueba funcional
  end-to-end — anular por ID corto, anular por nombre de cliente (caso
  único y caso ambiguo), intentar anular una factura `pendiente` (debe
  rechazar con el mensaje esperado) y una ya `anulada`, y confirmar que
  el evento `factura_anulada` y el PDF de la NC se generan igual que
  cuando se anula desde el panel. Mismo pendiente que v709/v710 — falta
  antes de pasar a producción.

## Cómo queda

El asistente ahora puede anular una factura ya emitida (con Nota de
Crédito real contra ARCA/AFIP) por voz o texto, con el mismo botón
Confirmar reforzado que ya usan `anular_venta_pos` y
`cancelar_pedido_asistente`.

## Archivos modificados

- `lib/asistente-tools.js`

## Siguiente paso (Fase A, ítem 3 del plan — segunda mitad)

Falta **emitir factura** (`POST /api/facturas` sin `accion`, sobre
`emitirFactura(pedido_id)`) para cerrar el ítem 3 completo. A diferencia
de anular, emitir ya tiene un flujo de confirmación de por medio en el
propio pedido (`crear_pedido` → pedido confirmado → factura se dispara
por el cierre automático o a mano desde `pedidos.html`) — antes de
construir la tool conviene confirmar con el usuario si "emitir factura
por voz" es sobre un pedido puntual que todavía no se facturó (caso
más común) o replica el botón manual de `facturacion.html` tal cual.
