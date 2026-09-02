# v307 — Cierre de los 4 hallazgos pendientes reales (auditoría UX, etapas 13-18)

Después de reverificar contra el código y la base real qué de los ~20
hallazgos de las etapas 13-18 seguía sin aplicarse, quedaban 4 pendientes
genuinos (ver charla previa). Este release cierra los 4.

Resumen rápido:

| # | Hallazgo | Estado |
|---|----------|--------|
| 1 | Etapa 13, H1 — catálogo de recompensas no canjeable | ✅ Cerrado |
| 2 | Etapa 15, H2 — emails de factura invisibles en el historial | ✅ Cerrado |
| 3 | Etapa 15, H1 — push no llega (3 causas) | ✅ Cerrado (con 1 pendiente externo) |
| 4 | Etapa 17, H4 — "+ Nueva Empresa" en superadmin roto | ✅ Cerrado (retiro del panel) |

---

## 1. Etapa 13, H1 — El catálogo de recompensas ahora es canjeable

**Antes:** existía la administración del catálogo (`/admin/fidelizacion.html`:
crear/editar recompensas, ver saldo de puntos por cliente) pero **ningún**
portal tenía forma de canjear una recompensa puntual. Ni handler backend, ni
pantalla cliente. El catálogo era enteramente decorativo.

**Ahora:**

- **Migración SQL** (`fix_etapa13_h1_canjear_recompensa`, aplicada directo
  sobre la base vía Supabase): nueva función
  `canjear_recompensa(p_empresa_id, p_cliente_id, p_recompensa_id)`,
  `SECURITY DEFINER`, con el mismo patrón de bloqueo/validación que ya usaba
  `canjear_puntos()`:
  - Lockea la fila de `recompensas` (`FOR UPDATE`) — evita doble canje
    concurrente sobre el último stock disponible.
  - Valida que esté activa, dentro de rango de fechas, y con stock
    (`cantidad_disponible - cantidad_canjeada > 0`, si tiene límite).
  - Lockea el `saldo_puntos` del cliente y valida saldo suficiente.
  - Descuenta puntos, incrementa `cantidad_canjeada`, inserta en
    `canjes_recompensas` (estado `pendiente`, para que el admin lo marque
    como entregado) y en `movimientos_puntos` (auditoría del movimiento).
  - **Solo la puede ejecutar `service_role`** (revocada de
    `PUBLIC`/`anon`/`authenticated`) — a diferencia de `canjear_puntos()`
    (que el admin llama directo con su JWT), esta la llama *siempre* el
    backend, porque el `cliente_id` tiene que derivarse server-side de la
    sesión — nunca confiar en un `cliente_id` que mande el navegador (evita
    que un cliente canjee puntos de otro cliente de la misma empresa).

- **Nuevo handler backend** `lib/handlers/fidelizacion.js`, registrado como
  módulo `fidelizacion` en `api/index.js` y ruteado en `vercel.json`
  (`/api/fidelizacion(.*)` → `/api/index?_mod=fidelizacion`):
  - `GET /api/fidelizacion` — catálogo de recompensas activas y vigentes +
    saldo de puntos del cliente autenticado.
  - `POST /api/fidelizacion?accion=canjear` (body `{ recompensa_id }`) —
    canjea, con rate limit de 10 req/min (operación sensible, mueve puntos
    reales).
  - El `cliente_id` se deriva de la sesión con el **mismo patrón** que
    `confirmarPedidoHandler` en `pedidos.js` (token → `usuarios` →
    `clientes`, valida `activo`) — nunca se confía en un valor del body.

- **Nueva UI en el portal cliente** (`/cliente/cuenta.html`): sección
  "Canjear recompensas" con el catálogo vigente, puntos requeridos por
  recompensa, y botón "Canjear" (deshabilitado si no alcanza el saldo).
  Al canjear, actualiza el saldo mostrado en pantalla y refresca el
  catálogo (por si la recompensa se agotó o ya no alcanza para otra).

**Pendiente para una futura sesión (no bloqueante):** el canje queda en
estado `pendiente` en `canjes_recompensas` — falta una pantalla en el admin
para marcarlo como "entregado"/"cancelado". Hoy el admin puede verlo/
actualizarlo directo en Supabase o vía una futura vista en
`fidelizacion.html`.

---

## 2. Etapa 15, H2 — Los emails de factura ahora aparecen en el historial

**Antes:** `notif-log.js` solo leía `notif_log`. Los emails de factura
emitida se registran en una tabla aparte, `email_log` (~400 envíos reales en
la base), y nunca aparecían en `/admin/notif-log.html` — el admin no tenía
forma de confirmar que un cliente había recibido su factura por mail.

**Ahora:** `cargarNotifLog()` en `frontend/admin/js/notif-log.js` consulta
**ambas** tablas y las combina:

- Filas de `email_log` se normalizan a la misma forma que las de
  `notif_log` (`canal: 'email'`, `message_id` ← `resend_id`, `payload` ←
  `{ asunto }`, `pedidos: null` — `email_log` no tiene columna `pedido_id`)
  para reusar toda la lógica de render/badges/CSV sin duplicar código.
- Paginación independiente por tabla (`offset` / `offsetEmail`) — el botón
  "Cargar más" queda visible mientras cualquiera de las dos fuentes pueda
  tener más filas.
- Los filtros de canal/tipo/fecha se aplican también sobre `email_log`
  cuando corresponde (si el filtro de canal es distinto de `'email'`, o el
  de tipo distinto de `'factura_emitida'`, directamente no se consulta esa
  tabla — no tiene sentido).
- Se agregó la opción **"Factura emitida"** al filtro de tipo en
  `notif-log.html` (antes no existía ninguna forma de filtrar solo estos
  envíos).

**Nota de investigación:** no se encontró en el código actual (v306) ningún
call site que inserte en `email_log` con `tipo='factura_emitida'` — el único
insert real en `lib/repos/notif.js` (`registrarEmail()`) nunca se llama
desde ningún handler. Las 400 filas existentes en la base tienen todas
`resend_id` seteado y `enviado_por` nulo, con fechas parejas entre abril y
julio — el patrón es consistente con los datos sintéticos del wizard de
migración/seed (mencionado en sesiones previas), no con una integración real
en producción todavía activa. Esto no cambia el fix (la UI tiene que mostrar
lo que hay en la tabla, venga de donde venga), pero si en algún momento se
espera ver facturas *reales* enviadas por email ahí, hay que confirmar que el
handler de facturación realmente llame a `registrarEmail()` (hoy no lo hace)
— quedó anotado para revisar aparte, no es parte de este hallazgo.

---

## 3. Etapa 15, H1 — Push: las 3 causas

### Causa 1 — Cliente y chofer nunca registraban dispositivo

Más profundo de lo que parecía: no era solo que faltara el botón. `push-init.js`
busca la sesión vía `window.authCtx.sb` (una convención propia del panel
admin), y **ni el portal cliente ni el portal chofer seteaban ese global**.
Aunque el navegador concediera el permiso, `registrarDispositivo()`
encontraba `session` `undefined` y abortaba en silencio — cero tokens
guardados en `dispositivos_push` para esos dos roles, siempre.

Fix: ambos portales (`frontend/cliente/cuenta.html`,
`frontend/chofer/index.html`) ahora setean `window.authCtx = { sb }` justo
después de crear el cliente de Supabase, y cargan `push-init.js` como
módulo.

### Causa 2 — Nadie invocaba el flujo, en ningún portal (ni admin)

Se confirmó que **`initPushNotifications()` no se llamaba desde ningún
lado** — ni siquiera en el dashboard admin, que es la única página que
cargaba el script. El módulo se importaba pero quedaba inerte.

Fix: se agregó un botón explícito **"Activar notificaciones"** en:
- `admin/dashboard.html` (topbar, con ícono de campana),
- `cliente/cuenta.html` (sección "Notificaciones"),
- `chofer/index.html` (topbar, junto al botón de salir),

que llaman a `solicitarPermisoNotificaciones()`. El botón se oculta solo si
el navegador no soporta notificaciones, y se auto-oculta después de que el
permiso ya fue concedido o denegado (no tiene sentido seguir mostrándolo).

De paso se corrigió un bug real en `solicitarPermisoNotificaciones()`
(`frontend/js/push-init.js`): dependía de que `initPushNotifications()` ya
se hubiera ejecutado antes en esa misma carga de página (para tener
`messaging` inicializado); si no, `registrarDispositivo()` no hacía nada de
forma silenciosa aunque el permiso quedara "granted". Ahora, si `messaging`
todavía no está inicializado, corre el flujo completo (`initPushNotifications()`)
antes de pedir el permiso.

### Causa 3 — VAPID sin configurar en el motor de automatización

Esto es un sistema **separado** del de arriba: `lib/handlers/_auto-push.js`
usa `web-push` "crudo" (no Firebase) para el motor de automatización, y
solo se activa si están seteadas `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` en
las variables de entorno de Vercel — hoy no lo están, así que ese canal
queda inactivo (no roto, simplemente apagado).

No lo puedo configurar yo directamente (no tengo acceso al panel de Vercel),
pero generé el par de claves reales con la librería `web-push` (ya es
dependencia del proyecto) para que las cargues vos:

```
VAPID_PUBLIC_KEY=BJmLLDddOXGOsERe65oi7vz07C-wr5xENuYUx__nXq_euVd2t7qeeJ9LMxTal6bLuGKa7X0PLGI-XvEMyiQguHE
VAPID_PRIVATE_KEY=acG90PdUAR50eXS4zGgVJSibULW9bWJHUhFlcgAlUyk
VAPID_MAILTO=admin@distrib.app
```

**Importante:** guardá estas dos claves ahora — no quedan en ningún otro
lado y no se pueden regenerar (regenerarlas invalidaría cualquier
suscripción push que ya se haya creado bajo estas). Pasos:

1. Vercel → tu proyecto → *Settings → Environment Variables*.
2. Cargar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y (opcional)
   `VAPID_MAILTO` con los valores de arriba, en Production (y Preview si
   corresponde).
3. Redeploy para que tomen efecto (las env vars no se aplican en caliente).

Esto es lo único de los 4 hallazgos que queda con una acción manual tuya
pendiente — todo lo demás ya está aplicado.

---

## 4. Etapa 17, H4 — "+ Nueva Empresa" en superadmin: retirado

**Antes:** confirmado en la base real que la tabla `empresas` no tiene
policy de `INSERT` — el alta desde `/admin/superadmin.html` siempre fallaba,
y aunque no fallara, el alta quedaba sin ningún usuario que pudiera
ingresar a esa empresa nueva (onboarding incompleto).

**Decisión (siguiendo la recomendación de la propia auditoría):** en vez de
agregar una policy de INSERT nueva (mayor superficie de riesgo para un panel
legado, no linkeado desde ningún lado del nav, y cuyo reemplazo real ya
existe y funciona), se **retiró** `superadmin.html`. La página ahora muestra
un aviso claro y redirige automáticamente a `/admin/saas-billing` (el panel
real y vigente para gestión de empresas/planes SaaS). El original queda
respaldado por las dudas, fuera del deploy.

La ruta `/admin/superadmin` sigue existiendo (por si hay algún bookmark
viejo) pero ya no ejecuta ninguna lógica de alta.

---

## Archivos tocados

- `supabase/migrations` — nueva función `canjear_recompensa` (aplicada
  directo en la base vía Supabase; agregar el archivo de migración
  correspondiente a este repo si tu flujo lo requiere).
- `lib/handlers/fidelizacion.js` — nuevo.
- `api/index.js` — registra el módulo `fidelizacion`.
- `vercel.json` — rewrite `/api/fidelizacion(.*)`.
- `frontend/cliente/cuenta.html` — sección de canje de recompensas +
  sección de activar notificaciones + `window.authCtx`.
- `frontend/admin/js/notif-log.js` — merge de `email_log`.
- `frontend/admin/notif-log.html` — opción de filtro "Factura emitida".
- `frontend/admin/dashboard.html` — botón "Activar notificaciones".
- `frontend/chofer/index.html` — botón "Activar notificaciones" +
  `window.authCtx`.
- `frontend/js/push-init.js` — fix de `solicitarPermisoNotificaciones()`.
- `frontend/admin/superadmin.html` — reemplazado por página de retiro.
- `package.json` — bump a 1.48.0.

## Único pendiente que depende de vos

Cargar las 3 variables VAPID en Vercel (paso 2 de la Causa 3) y hacer
redeploy. Todo lo demás ya está aplicado en la base y en el código de este
paquete.
