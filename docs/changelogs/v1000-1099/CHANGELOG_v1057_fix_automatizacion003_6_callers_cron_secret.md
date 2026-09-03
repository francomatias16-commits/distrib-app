# v1057 — Completa FIX AUTOMATIZACION-003: los 6 callers server-to-server ahora mandan Authorization

## Contexto

El fix del lado servidor (`lib/handlers/notif.js`, `whatsappHandler`) ya
aceptaba un segundo camino de auth server-to-server via `CRON_SECRET`
(Bearer) con `empresa_id` explícito en el body, fail-closed si la variable
no está configurada — documentado en el propio archivo. Ese cambio llegó
en esta sesión ya aplicado.

Lo que faltaba: de los 6 callers internos que el propio comentario de
`notif.js` nombra, solo la llamada de `auth.js` (reset de contraseña) ya
mandaba `Authorization`. Las otras 5 seguían pegándole al endpoint sin el
header — es decir, seguirían recibiendo 401 en silencio pese al fix del
lado servidor:

- `lib/handlers/pedidos/notificaciones.js` → `notificarEstado` (aviso de
  despacho) y `notificarPedidoConfirmado` (confirmación de pedido) — 2
  llamadas en este archivo.
- `lib/handlers/cierre.js` → `procesarNotifVencimiento` (recordatorio de
  deuda).
- `lib/handlers/score.js` → `ofrecerPlanDePago` (oferta de plan de pago a
  clientes en riesgo).
- `lib/reglas-automatizacion.js` → `ejecutarAccionEnviarWhatsapp` (acción
  `enviar_whatsapp` de reglas personalizadas — el hallazgo original de la
  etapa 6).

## Fix

En cada uno de los 5 call sites de arriba se agrega el mismo header que ya
usa `auth.js`:

```js
headers: {
  'Content-Type': 'application/json',
  ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
},
```

y se asegura `empresa_id` en el body (ya estaba presente en `cierre.js`,
`score.js` y `reglas-automatizacion.js`; se agregó en las 2 llamadas de
`pedidos/notificaciones.js`, que tienen `empresaId` disponible como
parámetro de función).

Sin `CRON_SECRET` configurada en el entorno, el header simplemente no se
manda — mismo comportamiento fail-closed que ya tenía `notif.js` (cae al
chequeo de usuario logueado y rechaza).

## Verificación

- `node --check` OK en los 5 archivos modificados.
- Suite completa (`tests/handlers/` + `tests/repos/`, 73 archivos / 944
  tests) corrida con vitest tras el cambio: **944/944 OK**, sin
  regresiones.
- No se agregó un test de regresión nuevo específico para estos 5 call
  sites en esta pasada (los tests existentes de `whatsapp-notif-permisos.test.js`
  cubren el guard del lado servidor, no estas 5 llamadas puntuales) —
  queda como pendiente razonable para una pasada de tests dedicada.
