# v719 — Reset de contraseña por WhatsApp (portal cliente)

## Contexto

Retomando lo pendiente de la sesión anterior: `frontend/cliente/login.html`
tenía un link "¿Olvidaste tu contraseña?" que solo mostraba un mensaje
estático ("contactá a tu distribuidora por WhatsApp") — no había ningún
flujo de self-service.

Investigación previa a este fix: ya existía `lib/handlers/auth.js` →
`POST /api/auth/reset-password`, completo (rate limit, `generateLink`
server-side, mail brandeado vía `lib/email.js`, logs con email ofuscado).
Pero:

1. **Ningún frontend lo llamaba** — quedó huérfano desde que se escribió.
2. **Bug de diseño**: busca el usuario por `usuarios.email`, que para
   cliente guarda el email **ficticio** del portal
   (`54911xxxxx@portal.distrib`), no un email real. El email real de
   contacto vive en `clientes.email`, tabla distinta. Aunque se hubiera
   conectado tal cual estaba, el mail no le habría llegado a nadie.

El cliente del portal ya se identifica 100% por su número de WhatsApp
(`frontend/cliente/login.html` arma el email ficticio de Supabase Auth a
partir del teléfono, nunca pide un email real). Por eso el reset natural
para este portal es un **código de 6 dígitos por WhatsApp**, no un link
por email — reaprovechando el canal de mensajería saliente que ya existe
(`lib/handlers/notif.js`, templates aprobados por Meta), en vez de armar
un sistema de emails paralelo que iba a tener el mismo problema de fondo.

El reset por email existente (`/api/auth/reset-password`) se deja como
está — sigue siendo válido para admin/chofer si algún día se decide
conectarlo, con el fix del email real pendiente para ese caso puntual.

## Qué se agregó

### Backend (`lib/handlers/auth.js`)

Dos rutas nuevas, mismo router consolidado de siempre:

- `POST /api/auth/reset-password-whatsapp` — recibe `{ telefono }`,
  normaliza el número (mismo algoritmo que el frontend y
  `clientes.js#normalizarTelefono`), resuelve el usuario por el email
  ficticio (`{telefono}@portal.distrib`), genera un código de 6 dígitos,
  lo guarda hasheado (SHA-256, `hashToken()` de `auth-helpers.js`, mismo
  criterio que `refresh_tokens.token_hash`) y lo manda por WhatsApp.
  Fire-and-forget + respuesta genérica, mismo patrón anti-enumeración que
  `procesarRecuperacion()` (el reset por email): nunca revela si un
  número está registrado.
- `POST /api/auth/confirmar-codigo-whatsapp` — recibe
  `{ telefono, codigo, password_nuevo }`, valida el código contra el hash
  guardado (máximo 5 intentos, vence a los 10 minutos) y si es correcto
  actualiza la contraseña con `supabaseAdmin.auth.admin.updateUserById()`
  — mismo mecanismo que ya usa `handleChangePassword`.

El envío de WhatsApp reutiliza el patrón ya establecido en `notif.js`
(`enviarNotifPedido` / `enviarAvisoDeudaVencida`): POST al propio
`/api/notif/whatsapp` (`WA_ENDPOINT`) en vez de importar la lógica de
envío directo, para no duplicar el corte de modo demo / costos por
empresa / reintentos que ya vive ahí.

### Template de WhatsApp (`lib/handlers/notif.js`)

Se agregó `codigo_recuperacion_password` a `TEMPLATES`. **Pendiente**:
como `pedido_por_llegar`, todavía no está dado de alta ni aprobado en
Meta Business Manager — hay que crearlo ahí (mismo nombre, idioma
`es_AR`, una variable de body) antes de que el envío deje de fallar con
"template inexistente". Idealmente se registra como categoría
`AUTHENTICATION` (no `UTILITY` como el resto), que en Meta trae su propio
botón de "copiar código" y el disclaimer de seguridad estándar — no
cambia nada del lado del código, solo cómo se lo da de alta.

### Migración `455_whatsapp_reset_password_clientes.sql`

Tabla `whatsapp_reset_codigos` (`empresa_id`, `cliente_id`, `usuario_id`,
`telefono`, `codigo_hash`, `intentos`, `usado`, `expira_at`). RLS
`solo_service_role`, mismo patrón que `refresh_tokens` (027). Incluye
`limpiar_whatsapp_reset_codigos_expirados()` lista para agendar (el
`cron.schedule()` queda comentado, igual que en 027 — no hay ningún cron
diario corriendo hoy en el proyecto).

### Frontend (`frontend/cliente/login.html`)

El link "¿Olvidaste tu contraseña?" ahora abre un modal de dos pasos:

1. Confirmar/editar el número de WhatsApp → `POST reset-password-whatsapp`.
2. Ingresar el código recibido + la contraseña nueva →
   `POST confirmar-codigo-whatsapp`. Al confirmar, cierra el modal y deja
   el teléfono precargado en el login para que el cliente entre directo.

### Tests

`tests/e2e/specs/cliente/reset-password-whatsapp.spec.js` (13 casos) +
locators/helpers nuevos en `tests/e2e/page-objects/cliente/login.page.js`.
Cubre: apertura del modal precargada, validaciones client-side (teléfono
vacío, código/contraseña vacíos, contraseña corta), el patrón
anti-enumeración (siempre avanza al paso 2), error de red, código
incorrecto (400), rate limit de intentos (429), éxito end-to-end
(incluido el cierre automático del modal y el precargado del teléfono en
el login), y los dos botones de navegación (cancelar / volver). Mismo
mecanismo de mocking que el resto de la suite (`mockApi` de
`mock-network.js` para `/api/*`, no Supabase REST). Como el resto de los
specs de esta tanda, **todavía no corrido contra Chromium real**.

## Pendiente para dar esto por cerrado

- Dar de alta y aprobar `codigo_recuperacion_password` en Meta Business
  Manager (ver comentario en `notif.js`) — sin esto, el envío falla en
  producción aunque el resto del flujo funcione.
- Confirmar si conviene agendar `limpiar_whatsapp_reset_codigos_expirados()`
  junto con `limpiar_refresh_tokens_expirados()` en un cron diario nuevo
  (ninguno de los dos corre hoy).
- Correr la nueva suite e2e contra Chromium real al menos una vez (no se
  pudo en esta sesión — Playwright no está instalado en el sandbox).
