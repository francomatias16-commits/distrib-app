# v550 — Fix RLS de `notif_log` + generalización del centro de notificaciones

Continúa la Fase 4 (`CHANGELOG_v549...md`). Esta entrega ataca el primer
punto del "Próximo paso": *"Generalizar un centro de notificaciones
(historial tipo notif-log.html) a los portales cliente, chofer y
proveedor"*. Antes de tocar el frontend se encontró un problema de
seguridad real que había que resolver primero.

## Hallazgo de seguridad: `notif_log` sin scoping por rol (SEC)

Al revisar cómo el admin lee `notif_log` (Supabase client-side + RLS)
para replicar el patrón en cliente, se encontró que la política de
`SELECT` de esa tabla (`ver notif_log propia empresa`) solo filtraba por
`empresa_id`, sin ningún chequeo de rol — a diferencia de tablas
comparables como `pedidos` (`pedidos_select_unificada`) o `cta_cte`
(`cta_cte_select`), que si el rol es `cliente` exigen además que el
`cliente_id` sea el propio.

Como `cliente` y `chofer` son roles dentro de la misma tabla `usuarios`
(`rol_usuario`: `dueno, admin, vendedor, depositero, chofer, contador,
cliente`) y las páginas de esos portales **ya cargan `supabase-js` con
la sesión logueada** (confirmado por código: `cuenta.html`,
`pedidos.html`, `carrito.html`, `catalogo.html`, `chofer/index.html`,
todas cargan el SDK), esto significa que, antes de este fix, **cualquier
cliente o chofer logueado podía leer con una sola consulta desde la
consola del navegador el `notif_log` completo de toda la empresa** —
teléfonos y montos de deuda vencida de todos los demás clientes
incluidos. El agujero estaba en la política, no en la UI: no hacía
falta que existiera ninguna página para que fuera explotable.

De paso se encontró que `INSERT`/`UPDATE`/`DELETE` tenían el mismo
problema (cualquier usuario de la empresa, sin chequeo de rol, podía
escribir o borrar cualquier fila). Se confirmó por código que ningún
frontend (admin/cliente/chofer) escribe `notif_log` de forma directa —
todos los inserts/updates reales pasan por el backend con
`service_role`, que bypassea RLS — así que restringir esas tres a staff
no rompe nada existente.

### Fix aplicado (migración `fix_rls_notif_log_scope_por_rol`, project `jgiquzjwoedmzwqgzubr`)

- `SELECT`: staff (`dueno/admin/vendedor/depositero/contador`) sigue
  viendo todo lo de su empresa (`auth_empresa_id()`, mismo helper que ya
  usa `pedidos`). `cliente` solo ve sus propias filas
  (`cliente_id = ` el cliente resuelto vía `usuarios.cliente_id`, mismo
  patrón que `pedidos_select_unificada`). **`chofer` queda afuera por
  ahora** — no hay ningún push logueado hacia chofer en todo el código
  (`_push.js` solo tiene `notificarOfertaRelampago`,
  `notificarDeudaVencida`, `notificarPedidoEntregado`,
  `notificarPuntosGanados`, `notificarPedidoEnCamino` — los cinco
  apuntan al cliente, ninguno al chofer), así que no había ningún caso
  de uso legítimo que estuviera pidiendo acceso; se agrega cuando exista.
- `INSERT`/`UPDATE`/`DELETE`: restringidas a staff (+ `service_role`).
- Verificado contra la base real después de aplicar: las 4 políticas
  quedaron con la definición esperada (`pg_policies`).

Esto no cambia nada de lo que ya funcionaba (admin sigue viendo todo lo
de su empresa) — solo cierra el acceso que nunca debió estar abierto.

## Centro de notificaciones — cliente

- **`frontend/cliente/notificaciones.html`** (nuevo): historial de
  notificaciones del cliente logueado — mismo esqueleto que
  `pedidos.html` (topbar con volver, `supabase-js` + `sb-cliente-auth`,
  chips de filtro). A diferencia del admin (que sí pasa
  `.eq('empresa_id', empresaId)` porque como staff puede ver todo),
  **esta página no manda ningún filtro por cliente — depende
  enteramente de la política `notif_log_select_unificada`** para acotar
  a lo propio. Es deliberado: así, si el día de mañana cambia cómo se
  resuelve el `cliente_id` de un usuario, la página sigue siendo segura
  porque la seguridad la garantiza la base, no un `.eq()` que este
  script podría omitir por error.
- Filtros por tipo (`deuda_vencida`, `pedido_entregado`,
  `pedido_en_camino`, `puntos_ganados`), paginado igual que
  `notif-log.js` del admin (`range` + "Ver más").
- Se agregó el botón "Activar notificaciones de mis pedidos" también en
  esta página (mismo wiring que `cuenta.html`) — un cliente puede llegar
  acá sin haber pasado por Cuenta.
- **`frontend/cliente/cuenta.html`**: se agregó el link "Ver historial
  de notificaciones" al lado del botón de activar push existente.
- **`vercel.json`**: rewrite `/cliente/notificaciones` (el catch-all
  `/cliente/(.*\.html)` ya la habría servido, se agrega la ruta limpia
  por consistencia con el resto de páginas nombradas del portal).

## Centro de notificaciones — proveedor

El portal de proveedor es público y sin sesión de Supabase — se
autentica solo con el token de la URL (`?t=...`, resuelto por
`validarTokenPublico`) y habla con el backend vía
`/api/proveedores?_svc=portal`. No hay RLS que aplique acá (no hay
`auth.uid()`), así que el filtrado tiene que ser server-side.

- `notif_log` no tiene columna `proveedor_id` — las notificaciones a
  proveedor (`accion=notificar-proveedor`, `lib/handlers/proveedores.js`)
  ya guardaban el id dentro de `payload` jsonb desde antes de esta
  entrega. Se filtra ahí (`payload->>proveedor_id`).
- **`lib/handlers/portal_proveedor.js`**: nueva acción
  `GET ?accion=notificaciones&t=<token>` → `verNotificaciones()`. Usa el
  `proveedor_id`/`empresa_id` ya resueltos y validados por
  `validarTokenPublico` (no un parámetro nuevo — no hay forma de que el
  caller pida notificaciones de otro proveedor). La respuesta expone
  solo `tipo/canal/email/entregada/motivo/created_at` — **no** los ids
  internos que trae el payload completo (`recepcion_id`, `orden_id`,
  `enviado_por`), que el proveedor no tiene por qué ver.
- **`frontend/proveedor/portal.js`**: sección "Notificaciones" al final
  de `render()`, con un `fetch` propio (`cargarNotificaciones()`) que no
  bloquea el render principal de OCs/facturas — si falla, la sección
  queda con un mensaje de error sin romper el resto de la página.
- No se tocó `portal.html` (el contenedor ya es un único `#portal-main`
  donde todo se inyecta vía JS, no hace falta agregar markup estático).
- Sin test unitario para `verNotificaciones` — mismo criterio que el
  resto de `portal_proveedor.js`, que hoy no tiene tests (`verPortal`,
  `confirmarEntrega`, `subirFactura` tampoco los tienen). Se verificó
  manualmente la forma del `payload` contra `notif_log` en la base real
  (`jgiquzjwoedmzwqgzubr`): la columna existe, el tipo
  `recepcion_proveedor` todavía no tiene filas en producción (la función
  que las genera existe desde antes de esta entrega pero, según lo que
  se pudo ver, no se usó todavía) — el filtro `payload->>proveedor_id`
  no se pudo probar contra datos reales por falta de filas, solo se
  verificó la sintaxis contra la documentación de PostgREST y el resto
  del archivo (`node --check` OK).

## Qué NO se hizo en esta entrega (a propósito)

- **Chofer**: no se agregó ninguna página. `notif_log` no registra hoy
  ninguna notificación dirigida a chofer (ver hallazgo de RLS arriba) —
  construir un "historial" que muestre una lista vacía no es generalizar
  nada, es fingir una feature. Para que tenga sentido, primero habría
  que decidir qué notificaciones querés que reciba un chofer (¿asignación
  de ruta? ¿cambio de entrega?) y agregar el logueo correspondiente en
  `_push.js` — eso es una decisión de producto, no algo para inventar en
  esta entrega. Lo dejo como pregunta abierta para la próxima.
- No se generalizó ningún otro aspecto del admin `notif-log.html` (como
  el combinado con `email_log`) a cliente/proveedor — ninguno de los dos
  portales tiene emails de facturación en su propio historial hoy
  (`email_log` es 100% admin/facturación), así que no aplicaba.

## Verificación

- Migración aplicada y verificada contra `jgiquzjwoedmzwqgzubr`
  (`pg_policies` muestra las 4 políticas nuevas con la definición
  esperada).
- `node --check` sobre todo lo tocado (`portal_proveedor.js`,
  `portal.js`), JSON válido en `vercel.json` (228 rewrites, antes 227),
  tags balanceados en el HTML nuevo/tocado.
- **Suite completa: sigue en 53/53** (esta entrega no tocó ningún
  archivo con tests — se corrió igual para confirmar que nada se rompió).

## Próximo paso

- Decidir (con el dueño del producto) qué notificaciones recibe un
  chofer y agregar el logueo correspondiente antes de construirle un
  historial.
- Emitir `pedido_facturado`/`factura_anulada` desde `lib/facturas.js`
  (sigue pendiente de la Fase 4 anterior).
- Migrar `handleChequesCron` al patrón evento+listener.
- Fase 5 del plan (auditoría de negocio centralizada).
