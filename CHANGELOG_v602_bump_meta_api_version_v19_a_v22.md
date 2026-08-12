# v602 — Bump META_API_VERSION de v19.0 a v22.0

## Motivo

`v19.0` de la Graph API de Meta venció el **21 de mayo de 2026** (Meta sostiene cada
versión ~2 años desde su lanzamiento; v19.0 salió en enero 2024). Al estar vencida,
cualquier llamada a `graph.facebook.com/v19.0/...` en producción puede estar
devolviendo error de versión de Meta — no solo en los endpoints nuevos de
Coexistencia (`/phone_numbers`, `/smb_app_data`), sino en **todos** los envíos de
WhatsApp existentes (notificaciones, cron de pedidos sugeridos).

## Cambios

- `lib/handlers/notif.js`: `META_API_VERSION` de `'v19.0'` → `'v22.0'`.
- `lib/handlers/piloto.js`: `META_BASE` (whatsapp-cron) de `v19.0` → `v22.0`.

Se eligió `v22.0` porque es la versión que ya usa el JS SDK del frontend
(`frontend/admin/js/whatsapp-onboarding.js`, `FB.init({..., version: 'v22.0'})`),
para mantener consistencia entre lo que usa el navegador y lo que usa el backend.
No se subió a la última versión disponible (v25.0+) para minimizar el salto y el
riesgo de breaking changes no revisados.

## Tests

`npx vitest run tests/handlers/ tests/webhooks/` — los 5 suites de WhatsApp
(`whatsapp-embedded-signup`, `whatsapp-pedido-tools`, `whatsapp-pedido-borrador`,
`whatsapp-motor-conversacion`, `whatsapp-firma`) pasan OK. Las 6 suites que fallan
(`export-contable-permisos`, `importar-permisos`, etc.) fallan por falta de
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` en este entorno de sandbox — no están
relacionadas con este cambio ni con WhatsApp.

## Pendiente real para producción (no bloqueante, config manual — no código)

En el **App Dashboard de Meta** (developers.facebook.com → la app con el
`WA_APP_ID` configurado en las variables de entorno) hay que suscribir manualmente
la app a los campos de webhook:

- `history`
- `smb_app_state_sync`
- `smb_message_echoes`

Esto es configuración en el panel de Meta (Webhooks → editar suscripción del
producto WhatsApp Business Account), no requiere cambios de código.
