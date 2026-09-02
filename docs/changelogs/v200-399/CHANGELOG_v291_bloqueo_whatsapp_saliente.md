# v291 — Bloqueo temporal de WhatsApp saliente (control de costos)

## Motivo
Una vez conectados números reales por Embedded Signup, los templates que
dispara el propio sistema (pedido_despachado, pedido_entregado,
pedido_por_llegar, pedido_no_entregado, cheques_por_vencer, deuda_vencida)
generan costo por mensaje entregado en la API de Meta (categoría "utility"),
independientemente de si el negocio ya definió cómo trasladarle ese costo a
sus clientes. Se pidió bloquear esos envíos hasta tener un esquema de precios
propio.

## Fix
Se agregó un interruptor global en `whatsappHandler` (`lib/handlers/notif.js`),
el único punto por el que pasan los 6 templates (confirmado: pedidos,
proximidad, cheques y deuda vencida usan todos el mismo `WA_ENDPOINT` →
`/api/notif/whatsapp`).

- **Por defecto (sin configurar nada) el envío real queda bloqueado.** La
  llamada responde `200 OK` con `{ ok: true, bloqueado: true, message_id }`
  simulado (mismo patrón que el modo demo existente), así el resto del
  sistema (notif_log, flujo de pedidos, etc.) sigue funcionando sin romperse,
  solo que no sale nada real hacia Meta.
- Para reactivar los envíos reales cuando esté decidido el modelo de costos,
  configurar en Vercel la env var:

  ```
  WA_NOTIF_SALIENTES_HABILITADAS=true
  ```

## Qué NO se bloquea (sigue funcionando igual, y sigue siendo gratis)
- La conversación bidireccional del bot cuando el cliente escribe primero
  (usa `enviarTextoWhatsApp`, un camino de código aparte — texto libre dentro
  de la ventana de servicio de 24h, que Meta no cobra).
- Las alertas y notificaciones puramente internas del dashboard admin (nunca
  salieron por WhatsApp).

## Nota
Este es un corte global (todas las empresas), no por empresa individual. Si
más adelante se necesita habilitar el envío real solo para algunas empresas
(por ejemplo, las que ya pagan un plan que lo incluye), avisar para armar un
flag por `empresa_id` en vez del global actual.
