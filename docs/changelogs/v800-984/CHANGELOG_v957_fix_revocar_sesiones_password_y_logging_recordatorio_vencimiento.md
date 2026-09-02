# v957 — Fix hallazgos Alto #10 y Medio #11 (Etapa 2b, resto de handlers)

Continúa la Etapa 2b más allá de `pedidos.js`: se revisaron `auth.js`,
`cierre.js`, `cc_proveedores.js`, `saas.js`, `conciliacion-bancaria.js` y
`score.js` (parcial). La mayoría estaban bien resueltos (varios ya traían
fixes de auditorías previas bien documentados inline); se encontraron y
corrigieron 2 hallazgos nuevos.

## 1. Cambiar/resetear la contraseña ahora invalida las sesiones existentes

**Antes:** `handleChangePassword` y `handleConfirmarCodigoWhatsapp`
actualizaban la contraseña en Supabase Auth pero nunca tocaban la tabla
`refresh_tokens` propia del proyecto (la que usa el login cookie-JWT del
portal admin/chofer). Si una sesión estaba comprometida — refresh token
robado por XSS, dispositivo perdido, log filtrado — la vía obvia para
cortar el acceso, cambiar la contraseña, no lograba nada: el atacante
seguía pudiendo pedir access tokens nuevos con el refresh que ya tenía
hasta que expirara solo (7 días).

**Ahora:** nueva función `revocarSesionesUsuario(usuarioId)` en `auth.js`
que marca `revocado = true` en todos los refresh tokens activos del
usuario. Se llama al final de `handleChangePassword` (cambio con sesión
propia) y `handleConfirmarCodigoWhatsapp` (reset del portal cliente vía
código WhatsApp), inmediatamente después de que Supabase confirma la
actualización de contraseña.

**Gap residual conocido, no cerrado en esta versión:** el reset por email
(`handleResetPassword` → link mágico de Supabase) completa la actualización
100% client-side (`restablecer-password.html` → `sb.auth.updateUser()`)
sin volver a pasar por este backend, así que no hay hook disponible para
revocar sesiones en ese camino sin agregar infraestructura nueva (webhook
de Supabase Auth o un endpoint de confirmación propio). Documentado en
`AUDITORIA_BUGS_v954.md` (hallazgo #10) para una vuelta futura.

Archivo: `lib/handlers/auth.js`.

## 2. El recordatorio de deuda por WhatsApp (`cierre.js`) ya no falla en silencio total

**Antes:** `procesarNotifVencimiento` tenía `.catch(() => {})` en el fetch
a `/api/notif/whatsapp` — ni siquiera un `console.error`. Si el envío
fallaba (token vencido, rate limit de Meta), no quedaba ningún rastro de
que el cliente nunca se enteró de su deuda próxima a vencer.

**Ahora:** chequea `resp.ok`, loguea el resultado (éxito o falla) vía
`NotifRepo.registrarLog` en `notif_log` (tipo `recordatorio_vencimiento`,
canal `whatsapp`) y hace `console.error` en caso de falla — mismo criterio
que el resto de los disparos de WhatsApp del repo desde v956
(`notificarEstado`).

Archivo: `lib/handlers/cierre.js`.

---
Verificado `node --check` en ambos archivos sin errores. Ver
`AUDITORIA_BUGS_v954.md` (hallazgos #10 y #11) para el detalle completo,
incluida la lista de handlers ya revisados sin hallazgos nuevos
(`cc_proveedores.js`, `saas.js`, `conciliacion-bancaria.js`, `score.js`).
