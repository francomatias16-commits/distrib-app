# v355 — Invitar chofer desde Repartos (link de auto-activación)

## Problema

Sumar un chofer a la app `/chofer` requería que el admin le asignara
email+password a mano desde `/admin/usuarios.html`, con emails ficticios
inventados (`telefono@algo`) — un paso manual, propenso a error, y
desconectado de la pantalla donde en la práctica se necesita (Repartos, al
armar la ruta y no encontrar al chofer en el selector).

## Cambios

### Base de datos (migración `355_invitacion_choferes.sql`)

- Tabla `chofer_invitaciones`: token de invitación de un solo uso, mismo
  patrón de seguridad que `proveedor_portal_tokens` (migración 099) — el
  token crudo nunca se persiste (solo su `sha256`), RLS deny-all, toda la
  autorización vive en el handler serverless con `SERVICE_ROLE_KEY`.
- `usuario_id` NULL = alta nueva (nombre/teléfono quedan en borrador hasta
  que el chofer acepta); `usuario_id` NOT NULL = reset de acceso de un
  chofer ya cargado en `usuarios`.
- RPC `validar_token_invitacion_chofer(p_token_hash)`: valida sin consumir
  (existe / no vencido / no revocado / no usado ya). El handler recién
  marca `usado_at` una vez confirmada la creación o el reset del usuario en
  Supabase Auth — no antes, para no invalidar el token si algo falla a
  mitad de camino.

### Backend (`lib/handlers/chofer_invitacion.js`, nuevo módulo `_mod=chofer-invitacion`)

- **Admin** (dueño/admin, requiere sesión): `invitar-nuevo` (nombre +
  teléfono), `invitar-existente` (reenviar/resetear acceso de un chofer ya
  cargado), `listar` (historial con estado activo/aceptada/expirado/
  revocado) y `revocar`.
- **Público** (sin login, mismo trato que el portal de proveedores): `ver`
  (datos para prellenar el form) y `activar` (crea o resetea el password).
  Las escrituras siempre resuelven `empresa_id`/`usuario_id` desde el token
  validado en el servidor, nunca desde el body.
- Alta nueva: se reusa el esquema de "email ficticio derivado del
  teléfono" que ya usa el portal cliente (`clientes.js`), pero con dominio
  propio `@chofer.distrib` para no compartir espacio de nombres con los
  emails ficticios de clientes (`@portal.distrib`).
- El link se entrega vía `wa.me` con el mensaje precargado (mismo patrón
  que el acceso al portal cliente) — sin depender de un template de
  WhatsApp Business API aprobado por Meta.
- Registrado en `api/index.js` como módulo `chofer-invitacion` (no suma
  Serverless Functions — todo pasa por el dispatcher único de `api/index.js`).

### Rutas (`vercel.json`)

- `POST/GET /api/chofer-invitacion` → dispatcher, `_mod=chofer-invitacion`.
  Path separado de `/api/chofer/(.*)` (que ya es un catch-all hacia
  `pedidos&_svc=chofer` para la app del chofer logueado) para no colisionar.
- `/chofer/invitacion` → `frontend/chofer/invitacion.html` (página pública).

### Frontend

- `frontend/chofer/invitacion.html`: página pública (mismo estilo que
  `login.html`) donde el chofer ve su nombre, elige contraseña, y al
  activarse inicia sesión ahí mismo (`signInWithPassword` con el email que
  devuelve el backend) y pasa directo a `/chofer`.
- `frontend/admin/rutas.html` + `js/rutas.js`: botón "Invitar chofer" junto
  al selector de chofer en Armar ruta, con modal para elegir entre alta
  nueva o reenviar acceso a uno ya cargado, y link directo de WhatsApp con
  el resultado.

## Pendiente / no incluido en esta versión

- No hay pantalla de historial de invitaciones en el admin todavía (el
  endpoint `listar` ya existe en el backend, listo para engancharlo).
- No se agregó reenvío automático al vencer — el admin tiene que volver a
  generar el link manualmente desde el mismo modal.
