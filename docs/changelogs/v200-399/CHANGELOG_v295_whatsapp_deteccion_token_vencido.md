# v295 — Detección de token vencido por empresa (necesita_reconexion)

## Problema
Ya existía `alertarTokenWhatsAppVencido()`, que manda un push cuando Meta
devuelve error 190 (token vencido/inválido). Pero tenía dos problemas:

1. **No quedaba nada registrado en la tabla** — el panel "Conectar
   WhatsApp" seguía mostrando "conectado" aunque el número ya no mandara
   nada. El único síntoma era el push (si alguien lo vio) o los logs.
2. **La alerta era global**: le avisaba a **todos** los admins de **todas**
   las empresas de la plataforma cada vez que el token de UNA empresa
   vencía — ruido para quienes no tenían nada que ver, y con un solo
   cooldown compartido (si dos empresas distintas tenían el problema
   dentro de la misma ventana de 6hs, la segunda no generaba alerta).

## Fix

**Migración 275**: nueva columna `empresa_whatsapp.necesita_reconexion`
(boolean, default `false`) + la vista `v_empresa_whatsapp_estado` (272) se
actualiza para exponerla.

**`lib/handlers/notif.js`**:
- Nuevo helper `marcarEstadoTokenWhatsapp(empresaId, bool)`.
- `alertarTokenWhatsAppVencido()` ahora recibe `empresaId` y `propia`:
  - Si es el número **propio** de una empresa: marca
    `necesita_reconexion = true`, y la alerta/cooldown quedan **acotados a
    esa empresa** (solo sus admins, cooldown de 6hs solo para ella).
  - Si es el número **compartido** de prueba: mismo comportamiento global
    de antes (afecta a todas las empresas que lo usan por igual).
- **Self-healing**: en `whatsappHandler` y `enviarTextoWhatsApp`, cada
  envío exitoso con número propio limpia `necesita_reconexion` a `false`
  automáticamente — si el corte fue transitorio del lado de Meta, no hace
  falta que nadie reconecte a mano.
- El `upsert` de `whatsappEmbeddedSignupHandler` resetea
  `necesita_reconexion: false` al reconectar manualmente.

**`frontend/admin/js/whatsapp-onboarding.js`**: `cargarEstadoActual()` ahora
distingue tres estados en el panel — no conectado / necesita reconexión
(con botón "Reconectar mi WhatsApp") / conectado y funcionando.

## Ojo
El mensaje de la alerta vieja decía "Regenerá un System User token sin
caducidad en business.facebook.com" — ya no aplica con el flujo de
Embedded Signup actual (v286+), lo cambié para que apunte a volver a tocar
"Conectar mi WhatsApp" en Configuración, que es el flujo real hoy.

## Archivos
- `lib/handlers/notif.js` — verificado con `node --check`.
- `frontend/admin/js/whatsapp-onboarding.js`
- `supabase/migrations/275_whatsapp_necesita_reconexion.sql`
