# v986 — WhatsApp: prefill de `business_id` para saltear la pantalla de negocio en reconexiones

**Fecha:** 25/08/2026

## Qué se hizo

Se cierra el circuito completo del `business_id` (ID del Business Portfolio
de Meta) que ya se venía capturando del postMessage
`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` pero que no se enviaba al backend
ni se guardaba en base:

- **Migración 544** (`empresa_whatsapp.business_id`, columna nueva +
  `v_empresa_whatsapp_estado` actualizada + GRANT de columnas): aplicada
  directo contra producción (`jgiquzjwoedmzwqgzubr`). Al aplicarla apareció
  el error `42P16` (`cannot change name of view column`) porque
  `CREATE OR REPLACE VIEW` no permite insertar una columna nueva en medio
  del `SELECT` existente — se corrigió moviendo `business_id` al final del
  `SELECT` (mismo lugar donde ya iba en el `GRANT`, criterio de 275/436).
- **`frontend/admin/js/whatsapp-onboarding.js`**: `enviarAlBackend()` ahora
  manda `business_id` (capturado en `_businessId`) en el body del POST a
  `/api/notif/whatsapp-embedded-signup`. Antes se capturaba pero se
  descartaba.
- **`lib/handlers/notif.js`** (`whatsappEmbeddedSignupHandler`): acepta
  `business_id` del body y lo agrega al payload de
  `guardarCredencialesWhatsapp()` **solo si vino** — si esta reconexión
  Meta no lo mandó (porque el frontend ya lo prefilleó y saltó la pantalla
  de negocio), no se pisa el valor bueno que ya está guardado, ya que el
  upsert de Supabase solo toca las columnas presentes en el payload.

Con esto el flujo completo queda: primera conexión → Meta manda
`business_id` → se guarda → próxima reconexión → el frontend lo lee de
`v_empresa_whatsapp_estado` y lo reinyecta en
`extras.setup.business.id` → Embedded Signup salta la pantalla de negocio.

## Por qué

Sin este último tramo, la migración 544 y la lógica de reinyección del
frontend no tenían ningún dato real que guardar la primera vez — quedaban
"conectadas" pero mudas.

## Archivos

- `supabase/migrations/20260825000000_544_whatsapp_business_id_prefill_reconexion.sql`
- `frontend/admin/js/whatsapp-onboarding.js`
- `lib/handlers/notif.js`

## Testing

- `node --check` sobre los dos archivos JS — sintaxis OK.
- Migración verificada en producción: columna `business_id` (`text`) en
  `empresa_whatsapp`, vista `v_empresa_whatsapp_estado` expone la columna,
  fila `544` presente en `schema_migrations_registry`.
- Pendiente (browser): completar una conexión real de Coexistencia y
  confirmar que `business_id` queda no-nulo en la fila de la empresa, y que
  una reconexión posterior lo reinyecta y salta la pantalla de negocio.
