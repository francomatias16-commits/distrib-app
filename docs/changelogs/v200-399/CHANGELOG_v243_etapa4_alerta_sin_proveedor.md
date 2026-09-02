# v243 — Etapa 4 (Compras inteligentes): alerta cuando falta proveedor por defecto

## Contexto
Al auditar el loop stock predictivo → sugerencia de compra → OC automática
(ya implementado y corriendo en producción, cron diario `0 6 * * *`), se
detectó que `stock-auto.js` descartaba en silencio los productos con
`necesita_reponer=true` pero **sin `proveedor_id_default`**: no se generaba
OC (correcto, no hay a quién enviarla) pero tampoco quedaba ningún rastro.

Confirmado contra la base real: **"Yerba Mate 1kg" en quiebre total
(0 días de stock) sin ninguna alerta ni notificación**, por este motivo
exacto, en "Distribuidora Demo S.A.".

## Cambios

- **`lib/handlers/stock-auto.js`** — nueva función `alertarSinProveedor()`.
  Cuando un grupo de productos críticos no tiene proveedor asociado, en vez
  de `continue` silencioso: crea/actualiza `alertas_stock` (tipo
  `sin_proveedor`, sin `orden_compra_id`) y dispara push a admins/dueños
  (tipo `stock_sin_proveedor`) vía `notifAuto`.
- **`supabase/migrations/243_stock_auto_alerta_sin_proveedor.sql`** —
  agrega `notif_prefs_auto.stock_sin_proveedor` (BOOLEAN, default TRUE),
  siguiendo el mismo patrón que `stock_quiebre`/`stock_orden_auto` (037).
  **Ya aplicada en producción** vía Supabase MCP + registrada en
  `schema_migrations_registry` (id 15).
- **`frontend/admin/js/stock.js`** — nueva entrada en `STOCKAUTO_TIPOS` para
  que la alerta se muestre con label propio ("Sin proveedor asignado") en
  vez de caer en el fallback genérico.
- **`frontend/admin/css/stock-overview.css`** — color distintivo (violeta,
  `#6c5ce7`) para `.stockauto-row--sin_proveedor`, para diferenciarla
  visualmente de las alertas por urgencia de tiempo (quiebre/crítico/bajo,
  que usan rojo/naranja/amarillo).
- **`frontend/admin/automatizacion.html`** — nuevo toggle de preferencia
  "Reposición sin proveedor" (🧩) en el panel de notificaciones push.

## Estado en producción (Supabase)
- Migración 243 aplicada y registrada.
- Se sembraron manualmente (vía SQL, adelantándose al próximo cron) las
  2 alertas `sin_proveedor` pendientes hoy: Yerba Mate 1kg (0 días) y
  Aceite Girasol 900ml (60 días), ambas de Distribuidora Demo S.A.
- **Pendiente**: desplegar el código (`stock-auto.js`, `stock.js`,
  `stock-overview.css`, `automatizacion.html`) a Vercel para que el cron de
  mañana 6am use la lógica nueva en vez de la anterior. La migración SQL ya
  corre independiente del deploy; el fix de código todavía no.

## Verificación sugerida post-deploy
1. Asignar (o no) un `proveedor_id_default` a "Yerba Mate 1kg" — si se le
   asigna, la próxima corrida del cron debería generarle OC automática en
   vez de alerta `sin_proveedor`.
2. Confirmar que la alerta aparece en `/admin/stock` con la etiqueta y
   color nuevos.
3. Activar/desactivar el toggle "Reposición sin proveedor" en
   `/admin/automatizacion` y confirmar que persiste
   (`notif_prefs_auto.stock_sin_proveedor`).
