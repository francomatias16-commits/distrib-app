# Etapa 1 — Pedidos (carrito → confirmación → stock → notificaciones)

**Flujo auditado:** `frontend/cliente/carrito.html` → `POST /api/pedidos?accion=confirmar`
→ `confirmarPedidoHandler` (`lib/handlers/pedidos.js:566`) → RPC
`crear_pedido_cliente` → efectos secundarios (factura, WhatsApp, email, push,
puntos) → `frontend/admin/pedidos.html`.

**Método:** lectura de código real (handler, RPC en Supabase vía
`pg_get_functiondef`, frontend) + consultas directas contra la base de
producción para confirmar o descartar cada hipótesis con datos reales.

---

## 🔴 Hallazgo 1 — Pedido factura con error de ARCA queda invisible en el panel de Pedidos

**Hipótesis:** si `emitirFactura()` falla (ARCA caído, certificado vencido,
etc.), ¿el admin se entera desde la pantalla donde vive normalmente
(Pedidos), o queda escondido?

**Verificado con datos reales de tu Supabase:**
```sql
select count(*) from pedidos p join facturas f on f.id = p.factura_id
where f.estado in ('pendiente','error_afip');
-- resultado: 375
```
**Hoy tenés 375 pedidos con una factura que nunca se emitió correctamente.**

**Por qué la UI no lo muestra:**
- El filtro "Sin facturar" de `pedidos.html` (botón `btn-sin-facturar`) usa
  la condición `p.factura_id IS NULL` (`fn_pedidos_lista`, `p_sin_facturar`).
- Pero `pedidos.factura_id` se completa **en cuanto se crea el registro en
  `facturas`**, aunque quede en estado `pendiente` o `error_afip` — no
  cuando se emite con éxito. Así que un pedido con factura fallida **no
  aparece** al filtrar "sin facturar" (factura_id ya no es null).
- Además, `pedidos.js:639` calcula `puedeFacturar = !p.factura_id && ...`
  para decidir si mostrar el botón "Generar factura". Como `factura_id` ya
  está seteado, **el botón para reintentar tampoco aparece** en esa
  pantalla.
- Sí existe una pantalla separada (`facturacion.html`) que sí filtra por
  `estado = 'error_afip'` — pero nada en el flujo natural de "revisar
  pedidos" lleva al admin ahí. Tiene que saber que existe y pensar en
  entrar por su cuenta.

**Severidad:** alta. Es dinero y obligación fiscal que queda oculta detrás
de una pantalla que dice "todo facturado" cuando no lo está.

**Fix propuesto:**
1. Cambiar `p_sin_facturar` en `fn_pedidos_lista` para que también capture
   facturas en `pendiente`/`error_afip` (join contra `facturas.estado`, no
   solo `factura_id IS NULL`).
2. Cambiar `puedeFacturar` en `pedidos.js` para permitir reintentar cuando
   la factura asociada esté en `error_afip` (hoy solo mira si existe el id).
3. Agregar un badge visual en la fila del pedido (🔴 "Factura con error")
   cuando corresponda, sin obligar a entrar a `facturacion.html` para
   enterarse.

---

## 🔴 Hallazgo 2 — Notificaciones de confirmación (WhatsApp, email, push) fallan en silencio

**Hipótesis:** el mensaje de éxito le dice al cliente *"Recibirás un
WhatsApp con la confirmación"* — ¿qué pasa si ese envío falla?

**Verificado en código** (`notificarPedidoConfirmado`, `notificarPushPedidoConfirmado`,
`notificarPushAdmin`, todas en `pedidos.js`, líneas 845–1102):
- Las 4 notificaciones (WhatsApp cliente, email cliente, push cliente, push
  admin) se llaman con `.catch(console.error)` desde el handler principal —
  **fire-and-forget puro**.
- El envío exitoso de WhatsApp sí escribe en `notif_log`. **El fallo no
  escribe nada en ningún lado** — ni en `notif_log`, ni en otra tabla. Solo
  queda en los logs de Vercel, que nadie del negocio revisa.
- Mismo patrón en push cliente/admin: éxito = `console.log`, fallo =
  `console.warn`/`console.error`, sin persistencia.
- Consecuencia real: un cliente puede no recibir jamás la confirmación de
  su pedido (número de WhatsApp vencido en Meta, error transitorio, etc.) y
  **ni el cliente ni el admin tienen forma de saberlo** desde la interfaz —
  el pedido en `pedidos.html` se ve idéntico a uno donde todo funcionó.

**Severidad:** media-alta. No es plata directamente, pero genera el patrón
más caro de un sistema de pedidos: el cliente cree que no se registró nada
("nunca me llegó nada") y llama a reclamar o hace el pedido de nuevo por
otro canal, mientras el pedido ya existe.

**Fix propuesto:**
1. Insertar siempre en `notif_log` (o una tabla equivalente), también en el
   camino de error, con `estado: 'fallido'` y el motivo.
2. En `pedidos.html`/detalle del pedido, mostrar un ícono de estado de
   notificación (✅ enviada / ⚠️ falló / — sin teléfono) leyendo esa tabla.
3. Opcional pero recomendado: un reintento automático simple (1 retry) antes
   de marcar como fallido, dado que buena parte de estos fallos son
   transitorios (timeouts de red hacia Meta).

---

## 🔴 Hallazgo 3 — Pedido duplicado si la respuesta no llega al cliente (sin idempotencia)

**Hipótesis:** el cliente confirma desde el celu con mala señal (caso muy
real para tu base: reparto/zona rural), el pedido se crea bien en el
servidor, pero la respuesta HTTP no llega al navegador (timeout, se corta
el 4G, Vercel tarda). ¿Qué pasa?

**Verificado en código:**
- `crear_pedido_cliente` (RPC en Supabase) **no recibe ni verifica ningún
  identificador de idempotencia** — cada llamada crea un pedido nuevo, sin
  excepción.
- En `carrito.html:298-353`, el botón se deshabilita mientras espera la
  respuesta (`btn.disabled = true`), lo cual previene el doble-click
  accidental **dentro de la misma carga de página**. Pero si el `fetch`
  falla por red (`catch (e)` línea 349), el botón **se vuelve a habilitar**
  y el carrito local no se vació (sigue en `carrito_items` en DB) —
  invitando exactamente al reintento que generaría el duplicado, si el
  primer intento sí había llegado a buen puerto del lado del servidor.

**Severidad:** media. Baja probabilidad por evento individual, pero con
2500+ clientes y el patrón de "mala señal mientras se confirma" es
cuestión de tiempo. Un pedido duplicado consume stock reservado de más y
genera un despacho de más si nadie lo nota a tiempo.

**Fix propuesto:**
1. Generar un `idempotency_key` (UUID) en el cliente al abrir el carrito,
   mandarlo en el body de `confirmar`, y que `crear_pedido_cliente`
   devuelva el pedido ya creado si ese key ya existe en vez de crear uno
   nuevo (columna nueva + índice único en `pedidos`).
2. Mientras tanto (fix rápido sin tocar el RPC): en el frontend, si el
   `fetch` falla por red, antes de re-habilitar el botón, hacer una
   consulta de verificación ("¿existe ya un pedido reciente de este
   cliente con estos items?") antes de dejar reintentar.

---

## 🟡 Hallazgo 4 — Sesión vencida a mitad de la compra da un mensaje poco accionable

**Hipótesis:** el cliente arma el carrito, tarda en decidir, el token
expira, y recién ahí aprieta "Confirmar".

**Verificado:** el backend devuelve `401 { error: 'Token inválido' }`
correctamente (línea 572). Pero en el frontend (`carrito.html:328-338`),
la respuesta `401` se trata igual que cualquier otro error de negocio: se
muestra el texto crudo (`"Token inválido"`) en un `alert()`, sin indicar
que la solución es volver a iniciar sesión ni redirigir al login.

**Severidad:** baja-media (frecuente pero no destructivo — el usuario no
pierde nada, solo se confunde).

**Fix propuesto:** detectar `resp.status === 401` específicamente y
mostrar "Tu sesión expiró, iniciá sesión de nuevo" + redirect a login,
conservando el carrito (ya vive en `carrito_items`, sobrevive el re-login).

---

## 🟢 Lo que sí está bien resuelto (para que quede el contraste)

- **Condición de carrera de stock entre dos clientes**: hay doble chequeo
  — uno optimista en el handler (para dar un mensaje rápido y claro) y uno
  atómico dentro de la transacción SQL de `crear_pedido_cliente` (con
  `RAISE EXCEPTION 'stock_insuficiente...'`), que es el que realmente
  previene la venta doble. El handler mapea esto a **409** con mensaje
  específico ("El stock de uno o más productos cambió mientras
  confirmabas..."). Esto es exactamente cómo se debe resolver.
- **Manipulación de precio desde el navegador**: el precio nunca se toma
  del cliente — siempre se resuelve server-side vía
  `resolver_precios_cliente`. Bien cerrado, con comentario explícito en el
  código sobre el bug viejo que corrigió (v85/v176).
- **Límite de crédito y cliente bloqueado**: mensajes específicos y claros
  (`"Superás tu límite de crédito..."`, `"cliente_bloqueado"` con motivo),
  no un error genérico.
- **Carrito vacío / item inválido / producto inexistente**: validado y con
  mensaje específico por caso, no un 500 genérico.
- **Vaciado del carrito**: se hace server-side primero (fire-and-forget,
  pero con fallback: el frontend también lo vacía después de la
  respuesta), así que aunque falle uno de los dos caminos, el carrito
  igual se limpia para el usuario.

---

## Resumen de la etapa

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1. Factura con error de ARCA invisible en `pedidos.html` (375 casos reales confirmados en producción hoy) | 🔴 Alta | ✅ Corregido |
| 2. Notificaciones de confirmación (WhatsApp/email/push) fallan en silencio, sin registro | 🔴 Alta-media | ✅ Corregido |
| 3. Pedido duplicado por reintento tras timeout de red (sin idempotencia) | 🟡 Media | ✅ Corregido |
| 4. Mensaje de sesión vencida poco accionable en el carrito | 🟡 Baja-media | ✅ Corregido |

Los 4 son fixes de código, ninguno requirió decisión de costo/plan.

---

## Estado de implementación (actualizado 2026-07-12)

### ✅ Hallazgo 1 — Corregido
- **Backend (Supabase, ya aplicado en producción):** `fn_pedidos_lista`
  reescrita — hace `LEFT JOIN facturas`, expone `factura_estado` y
  `factura_error_detalle`, y `p_sin_facturar` ahora también captura
  facturas en `pendiente`/`error_afip` (antes solo miraba
  `factura_id IS NULL`). Migraciones:
  `294_fix_pedidos_sinfacturar_incluye_factura_error.sql` +
  revocación de `EXECUTE` de `anon` (default privilege residual sin
  caller legítimo). Verificado post-fix: el filtro "sin facturar" pasa de
  1139 a 1514 casos (1139 nunca facturados + 375 con error, el número
  exacto detectado en la auditoría).
- **Frontend (código, pendiente de deploy):** `frontend/admin/js/pedidos.js`
  — badge "Factura con error" en la fila de la tabla, botón del modal pasa
  a "Reintentar Comprobante de Venta" cuando corresponde (antes solo
  mostraba/ocultaba según `!factura_id`), y se muestra el último error de
  ARCA (`notas_error`) debajo del botón cuando existe. `obtenerPedidoPorId`
  (deep-links) también trae el estado de factura para que el modal se
  comporte igual sin importar de dónde vino el pedido.

### ⏳ Hallazgos 2, 3 y 4 — Pendientes
Sin tocar todavía (notificaciones silenciosas, idempotencia de
confirmación, mensaje de sesión vencida).

### ✅ Hallazgo 2 — Corregido (sesión siguiente)
Ver `CHANGELOG_v305_etapa1_hallazgo2_notif_log.md`. WhatsApp/email/push de
confirmación ahora escriben siempre en `notif_log` (éxito y fallo, con
motivo), WhatsApp y email quedaron desacoplados (antes, sin teléfono, el
email tampoco se mandaba), y se corrigió de paso un bug no documentado en
el hallazgo original: el push de "pedido confirmado" al cliente le pegaba
al endpoint equivocado (`/api/notif/push` es de alta de dispositivo, no de
envío) y nunca se entregó desde que existe la función. Nueva sección
"Notificaciones de confirmación" en el modal de detalle del admin, leyendo
`notif_log`. Código listo, **pendiente de `git push`/deploy**.

### ✅ Hallazgo 3 — Corregido
Se implementó el fix propuesto #1 (el de fondo, no el parche rápido de
verificación):
- **Backend (Supabase, ya aplicado en producción):** columna
  `pedidos.idempotency_key` (uuid, nullable) + índice único parcial
  `(empresa_id, cliente_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.
  `crear_pedido_cliente()` acepta `p_idempotency_key`: si ya existe un
  pedido con esa key para ese cliente, lo devuelve tal cual
  (`ya_existia: true`) en vez de crear uno nuevo; si dos requests con la
  misma key llegan casi al mismo tiempo (race real), el que pierde la
  carrera contra el índice único cae en el handler de `unique_violation` y
  también devuelve el pedido que sí se creó, en vez de fallar.
  Migraciones: `fix_hallazgo3_pedidos_idempotency_key`,
  `fix_hallazgo3_revoke_default_grants_nuevo_overload`,
  `fix_hallazgo3_revoke_public_grant_residual` — las últimas dos porque el
  `CREATE OR REPLACE` con un parámetro nuevo generó un *overload* separado
  de la función (11 args) que nació con los grants por defecto del schema
  (`EXECUTE` a `anon`/`authenticated`), pisando el hardening de SEC-012;
  se revocó explícitamente (incluyendo el grant residual heredado de
  `PUBLIC`, mismo patrón que `fix_sec012_parte2`) y se eliminó la función
  vieja de 10 args para no dejar dos versiones activas del mismo RPC.
- **Backend (código, pendiente de deploy):** `lib/handlers/pedidos.js`
  valida `idempotency_key` del body (UUID o `null`, nunca rompe si falta —
  compat con clientes viejos) y la pasa al RPC. Cuando el RPC devuelve
  `ya_existia: true`, se **omiten** los efectos secundarios (WhatsApp,
  email, push, factura, puntos) — ya habían corrido para el intento
  original; repetirlos hubiera cambiado un bug de pedidos duplicados por
  uno de notificaciones/puntos duplicados.
- **Frontend (código, pendiente de deploy):** `frontend/cliente/carrito.html`
  genera un `crypto.randomUUID()` al entrar al carrito (`sessionStorage`,
  no `localStorage` — no debe sobrevivir entre pestañas/dispositivos
  distintos), lo manda en cada intento de confirmar, y **recién lo limpia
  cuando el pedido se confirma con éxito** — si el `fetch` falla por red
  antes de eso, el próximo click reintenta con la misma key a propósito.

### ✅ Hallazgo 4 — Corregido
`frontend/cliente/carrito.html`: la respuesta `401` ahora se detecta antes
de intentar parsear el body como error de negocio, muestra "Tu sesión
expiró..." y redirige a `/cliente/login` — el carrito no se pierde porque
vive en `carrito_items` en la base, sobrevive el re-login. De paso, el
mensaje del `catch` de error de red también se mejoró para explicitar que
reintentar es seguro (ya no duplica, por el Hallazgo 3).

## Estado final de la etapa: 4/4 hallazgos corregidos en código.
**Todo pendiente de `git push`/deploy a Vercel para tener efecto real.**
Las migraciones SQL del Hallazgo 3 sí están aplicadas y activas en
producción ahora mismo (columna, índice, función RPC nueva) — no rompen
nada porque `idempotency_key` es opcional y el código viejo en producción
simplemente no la manda todavía (sigue funcionando exactamente igual que
antes hasta que se despliegue el frontend/backend nuevos).
