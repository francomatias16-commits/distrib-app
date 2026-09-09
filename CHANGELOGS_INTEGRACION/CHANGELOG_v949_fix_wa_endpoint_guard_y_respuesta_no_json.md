# FIX — WA_ENDPOINT sin guard + respuesta no-JSON en 5 emisores de WhatsApp

Retomando `PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md`: al revisar salud
de producción (24h) apareció `enviarAvisoDeudaVencida` recibiendo HTML en vez
de JSON. Investigando el código se encontraron dos problemas relacionados en
los 5 lugares que pegan a `WA_ENDPOINT` (el propio `/api/notif/whatsapp`):

1. **Sin guard si `WA_ENDPOINT` no está configurada.** Todos caían al
   fallback `http://localhost:3000/...`, que no existe en el runtime
   serverless de Vercel — salvo `enviarAvisoChequesPorVencer`, que ya hacía
   `if (process.env.WA_ENDPOINT)` antes de intentar el envío. Se generalizó
   ese mismo criterio a los otros 5.
2. **`.json()` sin chequear `content-type`.** Si la respuesta no es JSON
   (HTML de error 404, redirect, página de autenticación de Vercel, etc.),
   tiraba un `SyntaxError` genérico sin decir status/content-type real.

## Cambios

- **Nuevo** `lib/wa-endpoint-http.js`: `waEndpointConfigurado()` (el guard) y
  `leerRespuestaWa(waResp)` (parseo defensivo, devuelve `{ esJson, motivo }`
  en vez de tirar).
- `lib/handlers/notif.js`: `enviarAvisoDeudaVencida`, `enviarRecuperacionFuga`
  y `entregaHandler` (notif. de pedido/entrega) — guard + `leerRespuestaWa`.
- `lib/handlers/score.js`: `ofrecerPlanDePago` — guard + `leerRespuestaWa` +
  **se agregó el `try/catch` que faltaba** alrededor del `fetch` (antes un
  error de red quedaba sin capturar acá; el caller GET/POST no lo atrapaba
  tampoco, así que un error de red en el flujo manual `ofrecer-plan-pago`
  terminaba en un 500 genérico del dispatcher en vez de un 400 con motivo).
- `lib/handlers/auth.js`: reset de password por WhatsApp — solo guard (el
  parseo de respuesta ya toleraba no-JSON con `.catch(() => ({}))`).

Ningún contrato de retorno existente cambió (`{ ok, motivo }` /
`{ ok, razon, detalle }` según cada función) — solo se agregó un motivo más
específico para estos dos casos.

## Sin resolver

No se pudo confirmar la causa raíz exacta del HTML visto en el log original
(no había integración de Vercel disponible en esta sesión para ver el valor
real de `WA_ENDPOINT` ni el log completo). Este fix cubre el síntoma —el
`SyntaxError` genérico y el intento contra `localhost` cuando la env var
falta— para cualquiera de las dos causas. Si vuelve a aparecer, el nuevo
`motivo`/`detalle` va a traer el status y content-type real de la respuesta,
lo que debería alcanzar para diagnosticar sin necesidad de otra sesión de
investigación a ciegas.

## Tests

- Nuevo `tests/lib/wa-endpoint-http.test.js` (5 tests: guard on/off, JSON ok,
  HTML no-JSON, JSON content-type con body inválido).
- Suite completa verificada en verde: 138 archivos / 1969 tests (subió de
  137/1964).
