# v499 — Asistente: acciones de escritura con confirmación explícita

## Qué cambia

Hasta ahora el asistente de ayuda (`lib/handlers/asistente.js`) solo tenía
tools de **lectura** (diagnóstico de pedidos, cheques, presupuestos, POS,
etc. — desde 203_asistente_tools_lectura.sql). Esta versión agrega la
infraestructura para que el asistente pueda además **hacer** cosas, pero
nunca en el mismo turno en que el modelo (Gemini) decide hacerlas: toda tool
marcada `requiereConfirmacion: true` queda guardada como propuesta pendiente
y solo se ejecuta cuando el usuario clickea "Confirmar" en el chat-widget.

Primera (y única, por ahora) tool de escritura: **anular_venta_pos**.

## Archivos modificados

- `supabase/migrations/419_asistente_acciones_pendientes.sql` (nuevo) — tabla
  `asistente_acciones_pendientes` (propuesta → pendiente/confirmada/cancelada/
  expirada/ejecutada/error), RLS de solo SELECT, `service_role` hace el
  INSERT/UPDATE desde el handler. **Ya estaba aplicada en producción**
  (jgiquzjwoedmzwqgzubr) vía `Supabase:apply_migration`; se agrega acá solo
  para que el repo quede consistente con lo corrido (mismo criterio que
  418). No se re-aplicó en esta sesión (sin permiso de acceso al proyecto
  desde este entorno) — verificar si hace falta correrla en algún otro
  ambiente (staging/otro tenant) que no sea el de producción ya mencionado.
- `lib/asistente-tools.js` — nueva tool `anular_venta_pos` (roles dueño/admin,
  bloqueada si la venta ya tiene factura con CAE, repone stock, requiere
  motivo); `ejecutarTool()` ahora deriva a guardar-como-pendiente cuando
  `requiereConfirmacion:true`; nueva `resolverAccionPendiente()` (confirma/
  cancela con UPDATE atómico anti doble-click, TTL de 10 minutos).
- `lib/asistente-providers.js` — guarda el `resultado` completo de cada tool
  usada (no solo el flag `ok`), necesario para que el handler pueda leer
  `pendiente_confirmacion` / `id_confirmacion` / `resumen`.
- `lib/handlers/asistente.js` — nueva rama de request (`accion_pendiente_id`
  en el body) que resuelve la confirmación sin pasar por Gemini ni por el
  límite de uso de IA; arma `accion_pendiente` en la respuesta normal cuando
  una tool quedó esperando confirmación.
- `frontend/shared/chat-widget.js` / `chat-widget.css` — burbuja con tono
  "warning" y botones Confirmar/Cancelar cuando la respuesta trae
  `accion_pendiente`; ambos botones se deshabilitan al click para evitar
  doble request.

## Seguridad / integridad ya contempladas en el código integrado

- `anular_venta_pos()` bajo `service_role` no filtra por `empresa_id` sola
  (ver 416) — `asistente-tools.js` valida tenant explícitamente antes de
  proponer y de nuevo antes de ejecutar.
- El resumen que ve el usuario se re-genera contra el estado actual de la
  venta recién al confirmar, no se reusa el de cuando se propuso.
- Reclamo atómico (`UPDATE ... WHERE estado='pendiente'`) evita ejecución
  doble por doble click o carrera entre pestañas.

## No incluido / a decidir después

- No se agregaron más tools de escritura — la infraestructura queda lista
  para sumar la próxima (ej. anular pedido, marcar cheque) siguiendo el
  mismo patrón (`requiereConfirmacion` + `resumen()` + `execute()`).
