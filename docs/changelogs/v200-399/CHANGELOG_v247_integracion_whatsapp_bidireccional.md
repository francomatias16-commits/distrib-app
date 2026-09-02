# v247 — Integración de la rama WhatsApp bidireccional sobre v246_integrado

## Contexto

Llegaron dos entregas por separado, ambas basadas en v246:

- `distrib_v246_integrado_completo.zip`: base completa del proyecto, ya con
  Etapa 2 (reglas de precio + rentabilidad producto/vendedor) y Etapa 6
  (export contable) fusionadas (ver `CHANGELOG_v246_integracion_ramas_etapa2_y_etapa6.md`).
- `distrib_v246_whatsapp_bidireccional.zip`: segunda parte de la Etapa 6
  ("Integraciones externas"), el WhatsApp Business API bidireccional
  (recibir pedidos por chat vía el asistente IA). Esta rama partió de un
  v246 **anterior** a la fusión de reglas-precio/rentabilidad, así que su
  `vercel.json` no tenía esas rutas.

Ambas ramas tocan los mismos dos archivos (`lib/handlers/notif.js` y
`vercel.json`) pero de forma puramente aditiva — no hay conflicto real de
contenido, solo de base de partida distinta.

## Qué se hizo

1. Base: `distrib_v246_integrado_completo` completo (528 archivos).
2. Se sumaron de la rama WhatsApp:
   - `lib/whatsapp-pedido-tools.js` (nuevo, sin equivalente previo).
   - `lib/handlers/notif.js` reemplazado por la versión de la rama WhatsApp:
     se verificó línea por línea que es un **superset** exacto del `notif.js`
     de la base (todas las líneas "quitadas" en el diff son solo
     realineación de espacios en comentarios/switch, ninguna lógica se
     pierde) más el bloque nuevo `whatsappWebhookHandler` y el ruteo
     `_svc==='whatsapp-webhook'`.
   - `vercel.json`: **no** se reemplazó entero (la versión de la rama
     WhatsApp era más vieja y le faltaban las rutas de reglas-precio /
     rentabilidad-producto-vendedor). Se tomó el `vercel.json` de la base
     y se le agregó a mano solo la entrada nueva:
     ```json
     {
       "source": "/api/notif/whatsapp-webhook",
       "destination": "/api/index?_mod=notif&_svc=whatsapp-webhook"
     }
     ```
3. **Renumerada** la migración `246_etapa6_whatsapp_bidireccional.sql` →
   **`247_etapa6_whatsapp_bidireccional.sql`**, porque el número 246 ya
   estaba tomado en la base por `246_etapa2_rentabilidad_producto_vendedor.sql`.
   Actualizada la referencia interna (nombre de archivo y número en el
   INSERT a `schema_migrations_registry`).

## Pendiente antes de aplicar en Supabase

- Ejecutar `247_etapa6_whatsapp_bidireccional.sql` (creación de
  `whatsapp_conversaciones`, `whatsapp_mensajes`,
  `resolver_cliente_por_telefono()`, `v_whatsapp_conversaciones_activas`,
  RLS) — no se llegó a aplicar todavía bajo ningún número.
- Confirmar que `246_etapa2_rentabilidad_producto_vendedor.sql` sí esté
  aplicada en la base antes de correr la 247 (no hay dependencia real
  entre ambas, pero mantiene el orden numérico consistente).
- Variable de entorno nueva a cargar en Vercel: `WA_VERIFY_TOKEN`.
- Pasos manuales en Meta for Developers (webhook URL + verify token +
  suscripción al campo `messages`) — ver detalle en
  `CHANGELOG_v246_etapa6_whatsapp_bidireccional.md`.
- Nada de esto se corrió contra la base de Supabase en esta sesión; es
  solo la integración de código/migración a nivel de ZIP.
