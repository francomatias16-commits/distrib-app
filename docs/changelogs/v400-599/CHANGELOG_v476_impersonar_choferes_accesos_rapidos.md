# CHANGELOG v476 — Acceso rápido del dueño a Catálogo, Proveedores y Choferes

## 1. Botón "Ver catálogo" en Clientes

`frontend/admin/clientes.html` / `js/clientes.js`: botón visible en el
topbar que abre `/cliente/catalogo?empresa_id=<empresa>` en pestaña nueva.
El catálogo público no requiere sesión (ya funcionaba con `?empresa_id=`
sin login), así que no hizo falta tocar backend.

## 2. Botón "Abrir portal ahora" en Proveedores

`frontend/admin/js/proveedores.js`: el modal de "Portal de autogestión"
(que ya generaba un link de un solo uso, sin login, para que el proveedor
vea sus OCs) ahora tiene un botón primario que abre ese link directo en
pestaña nueva, además de copiarlo/mandarlo por WhatsApp. Sin cambios de
backend — reutiliza `generar-link` que ya existía.

## 3. Impersonar Choferes desde el panel admin

Nueva capacidad: el dueño/admin puede entrar al panel de un chofer real
elegido, sin conocer su contraseña — pensado para demos comerciales o
soporte.

- **Backend** (`lib/handlers/chofer_invitacion.js`): nueva acción
  `POST ?accion=impersonar` `body:{ usuario_id }`. Valida rol dueño/admin,
  valida que el chofer pertenezca a la empresa y esté activo, genera un
  magic link de un solo uso vía la Admin API de Supabase
  (`auth.admin.generateLink`) — no se manda ningún email real, el token
  lo consume quien abre el link. Rate limit propio y más estricto
  (10/min) que el resto del handler, por ser acceso a cuenta de un
  tercero. Queda auditado en `audit_log` (acción `IMPERSONAR_CHOFER`,
  quién y a qué chofer).
- **Frontend** (`frontend/admin/rutas.html` / `js/rutas.js`): botón
  "Ingresar como" al lado del selector de chofer en "Nueva ruta" —
  elegís el chofer, se abre su panel logueado en pestaña nueva.

### Prerequisito de seguridad — sesiones aisladas por portal

Antes de esto, admin/cliente/chofer compartían el mismo `localStorage`
de sesión de Supabase (mismo origen, mismo storageKey por defecto). Sin
aislar esto, entrar como chofer en una pestaña podía pisar la sesión de
admin en otra pestaña del mismo navegador. Se le dio un `storageKey`
propio a cada portal:

- Admin → `sb-admin-auth` (`js/auth.js`, `login.html`, `setup-wizard.html`, `sin-permiso.html`)
- Cliente → `sb-cliente-auth` (`inicio.html`, `login.html`, `carrito.html`, `cuenta.html`, `catalogo.html`, `pedidos.html`)
- Chofer → `sb-chofer-auth` (`login.html`, `index.html`, `remito.html`, `invitacion.html`, `gps-tracker.js`)

El proveedor no usa sesión de Supabase (portal 100% por token en la URL),
así que no necesitaba este cambio.

De paso se corrigió `frontend/shared/chat-widget.js` (el asistente de
ayuda flotante, presente en todos los portales): su cliente de fallback
creaba una sesión con storageKey por defecto, que tras este cambio ya no
hubiera coincidido con la sesión real de cliente/chofer. Ahora detecta el
portal por el path (`/admin`, `/cliente`, `/chofer`) y usa el storageKey
correspondiente.

## Archivos modificados
- `frontend/admin/clientes.html`, `frontend/admin/js/clientes.js`
- `frontend/admin/js/proveedores.js`
- `frontend/admin/rutas.html`, `frontend/admin/js/rutas.js`
- `lib/handlers/chofer_invitacion.js`
- `frontend/admin/js/auth.js`, `frontend/admin/login.html`, `frontend/admin/setup-wizard.html`, `frontend/admin/sin-permiso.html`
- `frontend/cliente/inicio.html`, `login.html`, `carrito.html`, `cuenta.html`, `catalogo.html`, `pedidos.html`
- `frontend/chofer/login.html`, `index.html`, `remito.html`, `invitacion.html`, `gps-tracker.js`
- `frontend/shared/chat-widget.js`

## Pendiente de tu parte
- Verificar que el proyecto de Supabase tenga habilitado `magiclink` como
  método de generación de links en el dashboard de Auth (suele estar
  activo por defecto, pero conviene confirmarlo antes de usar esto con un
  cliente real).
- Los dos pendientes de `AUDITORIA_UX_COMPLETA.md` (radios de `login.css`
  y manejo de errores en 9 JS) siguen abiertos.
