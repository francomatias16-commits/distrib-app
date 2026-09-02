# v956 — Fix hallazgos Medio #8 y #9 de AUDITORIA_BUGS_v954.md

Cierra la Etapa 2b de auditoría para `lib/handlers/pedidos.js`: con estos
dos fixes el archivo (3.4k+ líneas, el handler más grande del repo) queda
sin hallazgos abiertos.

## 1. `notificarEstado` (aviso WhatsApp de "pedido despachado") ahora chequea la respuesta y loguea en `notif_log`

**Antes:** hacía `await fetch(...)` sin capturar el resultado, sin
`try/catch` y sin `_logNotif`. Si `/api/notif/whatsapp` devolvía un error
(token vencido, template inválido, rate limit de Meta), la promesa igual
resolvía — `fetch` solo rechaza por falla de red, no por status HTTP — y
el `.catch(console.error)` del caller nunca se disparaba. El aviso de
despacho por WhatsApp podía fallar en silencio total: sin log, sin
entrada en `notif_log`, sin nada que un futuro botón de "reintentar"
pudiera usar. El propio archivo ya tenía el patrón correcto en 2 lugares
(`notificarPedidoConfirmado` y su función hermana `notificarDespachoPorEmail`,
la versión email de este mismo aviso), pero `notificarEstado` nunca lo
había recibido.

**Ahora:** mismo patrón que `notificarPedidoConfirmado` — chequea
`resp.ok`, loguea éxito o falla vía `_logNotif` (tipo `pedido_despachado`,
canal `whatsapp`, motivos `sin_telefono`/`error_envio`/`excepcion`), y
todo el fetch queda envuelto en `try/catch`. El caller (línea ~426, fire
-and-forget con `.catch(console.error)`) no cambió — ahora simplemente
hay un rastro real en `notif_log` antes de que ese `.catch` pudiera
necesitar dispararse.

Archivo: `lib/handlers/pedidos.js`.

## 2. `confirmar_pedido_sugerido` (RPC) ya no tiene condición de carrera check-then-update

**Antes:** `SELECT ... WHERE estado = 'sugerido'` y, si existía, un
`UPDATE` aparte sin `WHERE estado = 'sugerido'` ni `SELECT ... FOR
UPDATE`. Dos requests concurrentes al link público de confirmación (sin
login — doble tap del cliente o reintento de red del WhatsApp bot) podían
pasar ambas el chequeo antes de que la primera actualizara, y las dos
ejecutaban el `UPDATE`. El estado final era idempotente (no se duplicaba
el pedido), pero quedaba una segunda fila de auditoría para la misma
transición, y cualquier efecto secundario que se agregara a futuro dentro
de esta RPC heredaría la misma condición de carrera.

**Ahora:** reescrita como un único `UPDATE ... WHERE id = $1 AND
empresa_id = $2 AND cliente_id = $3 AND estado = 'sugerido' RETURNING
numero_pedido` — el UPDATE mismo es el lock optimista, mismo criterio que
`bloquearPresupuestoAceptado()` (`lib/repos/pedidos.js`) para el caso
gemelo en Presupuestos. Solo una ejecución concurrente puede afectar la
fila; la que pierde la carrera recibe `ok:false` sin haber tocado nada.

De paso, `confirmarPedidoSugeridoHandler` ya no llama a
`registrarAuditoriaSilenciosa` cuando `data.ok` es `false` — antes esto
generaba una fila de auditoría "fantasma" (UPDATE sin cambio real) para
el request perdedor de la carrera.

Archivos: `lib/handlers/pedidos.js`,
`supabase/migrations/20260824000000_537_fix_race_confirmar_pedido_sugerido.sql`.

---
Verificado `node --check lib/handlers/pedidos.js` sin errores. Ver
`AUDITORIA_BUGS_v954.md` para el detalle completo de ambos hallazgos.
