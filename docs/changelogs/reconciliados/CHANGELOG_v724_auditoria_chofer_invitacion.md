# v724 — Auditoría real (usuario_id): invitación de choferes

Cierra la lista de prioridad original (pedidos → pos → pagos → cc_proveedores →
chofer_invitacion). `migracion.js` se revisó y ya tenía cobertura completa: sus
2 audit calls existentes caen exactamente en los dos puntos que importan
—confirmar sesión (el commit real a tablas de negocio) y deshacer sesión (el
rollback)—; los pasos intermedios de mapeo solo tocan tablas de staging y no
necesitan auditoría propia. No se tocó ese archivo.

## `chofer_invitacion` (`lib/handlers/chofer_invitacion.js`)

El acceso "Ingresar como" (impersonar) ya tenía su propio audit dedicado
(`registrarAuditoriaImpersonacion`, con nota de un fix previo de un bug de
`.insert().catch()`). Faltaba el resto del ciclo de vida de la invitación:

- **Crear invitación** (`crearInvitacion`, compartida por alta nueva y
  reinvitación de un chofer existente) — INSERT sobre `chofer_invitaciones`,
  `usuario_id` = el admin que la generó.
- **Alta de chofer nuevo** (`invitarChoferNuevo`) — INSERT adicional sobre
  `usuarios` (se crea la cuenta real, ya activa, antes de generar el link) —
  write point más sensible del módulo: da de alta un usuario con acceso al
  sistema.
- **Revocar invitación** (`revocarInvitacionChofer`) — UPDATE. La función no
  recibía quién la revocaba; se agregó el parámetro `revocado_por` y se
  actualizaron los dos callers (`handleAdmin` y la tool del asistente
  `revocar_invitacion_chofer` en `lib/asistente-tools.js`, que tampoco
  capturaba `usuarioId` en su `execute()`).
- **Activación pública** (`handlePublico`, sin login — el chofer todavía no
  tiene sesión): reset de password de un chofer existente (UPDATE `usuarios`)
  o alta nueva vía token de invitación (INSERT `usuarios`). En los dos casos
  `usuario_id` = el propio chofer, no `null` — a diferencia de la confirmación
  de pedido por WhatsApp de `pedidos.js`, acá sí hay (o se está creando en ese
  mismo instante) un `usuarios.id` real con el que identificarlo: es su propia
  cuenta la que está activando, con el token como única prueba de identidad.
