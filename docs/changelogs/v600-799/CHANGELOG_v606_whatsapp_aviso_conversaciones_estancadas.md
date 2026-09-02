# v606 — Aviso automático de pedidos de WhatsApp que quedan sin cerrar

## Problema

El bot de pedidos por WhatsApp (Etapa 6) ya avisa por push a dueño/admin/
vendedor en cuatro casos: mensaje no soportado, más de 20 turnos sin
confirmar, falla de los proveedores de IA, y cliente que pide hablar con
una persona. Los cuatro comparten el mismo defecto de diseño: sólo se
disparan cuando llega un **mensaje nuevo** del cliente al webhook.

Si el cliente arma un pedido con el bot, el bot manda el resumen con el
total (`estado = 'esperando_confirmacion'`) y el cliente simplemente
**deja de responder**, no hay ningún mensaje entrante que dispare nada.
La conversación queda colgada sin que nadie se entere hasta que un
vendedor entra a mirar el panel a mano. Es, probablemente, el caso más
común de "pedido que no se llega a cerrar por WhatsApp".

## Solución

Nueva función `public.whatsapp_avisar_conversaciones_estancadas()`
programada con `pg_cron` cada 10 minutos (migración 437):

1. Busca conversaciones en `estado IN ('activa', 'esperando_confirmacion')`
   **con un borrador de pedido armado** (`pedido_borrador IS NOT NULL` —
   si nunca llegó a armar nada no hay "pedido sin cerrar" real que
   seguir) con más de 40 minutos sin `ultima_interaccion`.
2. Las pasa a `estado = 'derivada_humano'` con motivo
   `"Cliente dejó de responder sin confirmar el pedido"` — mismo estado
   que usan los otros 4 casos, así que aparecen igual en el panel
   `/admin/whatsapp-conversaciones` sin tocar una línea del frontend.
3. Dispara un push por Postgres (mismo patrón que
   `trigger_push_nuevo_pedido` / `trigger_push_stock_critico`, migración
   112: `net.http_post` a `/api/notif/push-interno` con `x-push-secret`).

Se eligió `pg_cron` en vez de un cron job de Vercel porque el plan
Hobby limita los cron jobs de Vercel a 1 corrida por día (ver comentario
en `handleDeudaCron`, `lib/handlers/notif.js`) — insuficiente para un
"seguimiento rápido". `pg_cron` corre dentro de Supabase, sin esa
limitación.

Peor caso: ~50 minutos desde que el cliente se queda callado hasta que
un vendedor recibe el push (40 min de umbral + hasta 10 min hasta la
próxima corrida del cron).

**Update (mismo día):** umbral subido de 20 a 40 min a pedido — ya
aplicado en producción vía `CREATE OR REPLACE FUNCTION` (no hizo falta
migración nueva, se pisó la función existente).

## Archivos

- `supabase/migrations/437_whatsapp_aviso_conversaciones_estancadas.sql`
  (**aplicada en producción**, `jgiquzjwoedmzwqgzubr`): índice de soporte,
  función del cron, `cron.schedule`.
- `lib/handlers/notif.js`: nueva entrada `whatsapp_estancado: ['dueno',
  'admin', 'vendedor']` en `ROLES_POR_TIPO` (el mapa que usa
  `pushInternoHandler` para resolver a quién avisar).

## Testing

- Corrida manual de la función contra un registro temporal en
  `esperando_confirmacion` con `ultima_interaccion` de hace 25 min:
  pasó a `derivada_humano` con el motivo correcto. Registro de prueba
  eliminado después.
- `cron.job` confirmado activo: `whatsapp_avisar_conversaciones_estancadas`,
  `*/10 * * * *`.
- `node --check lib/handlers/notif.js` OK.

## Pendiente (lo hacés vos)

- [ ] Commitear `lib/handlers/notif.js` y redeployar en Vercel — la
      migración SQL ya corre sola en Supabase, pero el push no va a
      resolver destinatarios para `tipo: 'whatsapp_estancado'` hasta que
      el `ROLES_POR_TIPO` actualizado esté en producción.

## v606b — Botón "Copiar resumen" en el panel

Agregado en el modal de detalle (`frontend/admin/js/whatsapp-conversaciones.js`,
`whatsapp-conversaciones.html`): junto al borrador de pedido en curso, un
botón "Copiar resumen" que arma un texto plano (productos, cantidades,
subtotales, total y notas) y lo copia al portapapeles vía
`navigator.clipboard`. Pensado para pegarlo directo en el chat de
WhatsApp del celular al retomar la conversación, sin tener que
retipear a mano lo que ya había armado el bot.

- `node --check` no aplica (es JS de browser, sin build) — se verificó
  el armado del texto con un caso de prueba (2 productos + notas) antes
  de empaquetar.
- Cache-busting bump: `whatsapp-conversaciones.js?v283` → `?v284`.
