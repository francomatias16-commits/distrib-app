# v1081 — Notificación clara de empresa suspendida/dada de baja en todos los portales

## Contexto

En la sesión anterior se resolvió la causa raíz de que la demo (Distribuidora
del Litoral) apareciera "vacía" intermitentemente: un cron de facturación
(`saas_cron_trial_check`) suspendía la empresa demo a diario porque su trial
vencido nunca se renueva. Ese fix (migración
`excluir_demo_de_suspension_saas_automatica`) ya está en producción.

Quedó anotado como bug real de UX, separado del incidente puntual: **cuando
una empresa está suspendida o dada de baja, ningún portal salvo el admin
avisaba con claridad — el usuario veía tablas vacías sin explicación**.

## Causa raíz (dos capas, cada una se arregla distinto)

1. **Admin**: la policy de SELECT sobre `empresas` depende de
   `get_empresa_id()`, que exige explícitamente `activa=true AND
   saas_suspendida=false`. Una empresa suspendida no puede ver ni su propia
   fila en `empresas` → el `.single()` en `auth.js` recibe 0 filas (406) →
   cae en el fallback "objeto mínimo" en vez de llegar a las ramas de
   redirect que **ya existían** (`/admin/login?error=empresa_inactiva`,
   `/admin/suspendida`). El frontend siempre supo mostrar el mensaje
   correcto; RLS le escondía el dato.
2. **Cliente / chofer / proveedor**: no existía NINGÚN chequeo. Las tablas
   de negocio (pedidos, stock, órdenes de compra, etc.) usan RLS basada en
   la misma `get_empresa_id()`, así que para una empresa suspendida
   devuelven 0 filas silenciosamente (sin error, a diferencia del caso
   admin) — indistinguible de "no hay pedidos hoy".

## Fix — capa 1: DB (ya aplicado en producción, Supabase)

- Función nueva `get_empresa_id_propia()`: solo exige usuario activo y
  vinculado a la empresa, sin filtrar por `activa`/`saas_suspendida`.
- Policy nueva `empresas_select_propia_aunque_suspendida` (SELECT) usando
  esa función — agregada, no reemplaza la policy existente.
- **`get_empresa_id()` no se tocó**: las +100 tablas/RPCs que dependen de
  ella para aislar tenants siguen bloqueando por completo a empresas
  suspendidas/dadas de baja. Solo se amplió la visibilidad de la fila
  propia en `empresas`, el dato mínimo que el admin ya sabía usar para
  redirigir con el mensaje correcto.

## Fix — capa 2: portales cliente y chofer

- **Nuevo** `frontend/shared/estado-empresa.js`: módulo autoejecutable que,
  en cualquier página de `/cliente` o `/chofer`, lee la sesión persistida
  (mismo `storageKey` que usa cada portal) y llama a `GET /api/auth/me`
  (que resuelve la empresa con `service_role`, sin pasar por RLS — por eso
  funciona incluso sin la capa 1). Si la empresa está suspendida o dada de
  baja, muestra un overlay claro y bloqueante: *"La distribuidora está
  [suspendida/dada de baja] — contactá directamente a tu distribuidora"*.
- Agregado como `<script>` justo después de `supabase-js` en las páginas
  con sesión de usuario:
  - Cliente: `carrito.html`, `catalogo.html`, `checkout.html`,
    `cuenta.html`, `inicio.html`, `notificaciones.html`, `pedidos.html`.
  - Chofer: `index.html`, `notificaciones.html`, `remito.html`.
  - (No se tocaron `login.html`, `invitacion.html`,
    `restablecer-password.html` — son pre-sesión.)
- No modifica el `sb` propio de cada página: crea un cliente Supabase
  aparte, de solo lectura de sesión, apuntando al mismo `storageKey`.

## Fix — capa 3: portal de proveedores (token-based, sin sesión de Supabase)

Este portal usa `service_role` directo y token de URL, no pasa por RLS ni
por `/api/auth/me`, así que necesitaba su propio chequeo backend:

- `lib/repos/portal-proveedor.js`: nueva función
  `obtenerEstadoEmpresaPortal(empresa_id)` (no se tocó
  `obtenerNombreEmpresa`, que tiene tests propios con otro contrato).
- `lib/handlers/portal_proveedor.js` → `verPortal()`: corta temprano (antes
  de pedir órdenes/facturas) si la empresa está suspendida/dada de baja, y
  responde `{ ok: true, empresa_suspendida: true, empresa }`.
- `frontend/proveedor/portal.js`: si la respuesta trae
  `empresa_suspendida`, reutiliza el `mostrarError()` ya existente en vez
  de caer en `render()` con listas vacías.

## Alcance / lo que NO cambia

- Ninguna tabla de negocio queda más expuesta para una empresa suspendida:
  el acceso a datos sigue bloqueado en los tres portales; lo único nuevo es
  que ahora se explica por qué, en vez de mostrar vacíos silenciosos.
- No se tocó la lógica de facturación/crons (ya resuelta en la sesión
  anterior).

## Archivos tocados

- `frontend/shared/estado-empresa.js` (nuevo)
- `frontend/cliente/{carrito,catalogo,checkout,cuenta,inicio,notificaciones,pedidos}.html`
- `frontend/chofer/{index,notificaciones,remito}.html`
- `lib/repos/portal-proveedor.js`
- `lib/handlers/portal_proveedor.js`
- `frontend/proveedor/portal.js`

## DB (ya aplicado, no requiere acción)

- Migración `fix_empresas_select_visible_para_propio_usuario_incluso_suspendida`
  (proyecto `jgiquzjwoedmzwqgzubr`), aplicada en la sesión anterior.
