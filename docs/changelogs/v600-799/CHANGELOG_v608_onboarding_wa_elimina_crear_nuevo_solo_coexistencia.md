# v608 — Onboarding WhatsApp: se elimina por completo "Crear WhatsApp Business nuevo"

## Motivo

Probando el onboarding en vivo (`/admin/whatsapp-onboarding`) con dos números
personales, cualquier número que se ingresaba en el flujo **"Crear un
WhatsApp Business nuevo"** rebotaba con el error de Meta:

> Este número de teléfono ya está registrado en una cuenta de WhatsApp.
> Para usar este número, desconéctalo de la cuenta actual...

Es esperable, no un bug: ese flujo (crear un WABA desde cero) solo acepta un
número que **no tenga ninguna cuenta de WhatsApp activa en absoluto** —
Meta exige eliminar la cuenta personal de WhatsApp de ese número y esperar
~3 minutos antes de poder tomarlo. Para un dueño usando su número personal
de siempre, eso implica perder los chats existentes, algo que casi nadie
va a querer hacer solo para conectar el bot. En la práctica, esa opción
llevaba a la mayoría de los dueños a un callejón sin salida en el primer
intento.

**Decisión:** sacar la opción por completo. Coexistencia ("Usar mi
WhatsApp Business existente") queda como el único camino — no pisa la
cuenta ni borra chats, solo requiere tener instalada la app **WhatsApp
Business** (no la app de WhatsApp normal) en ese número.

## Cambios

- **`frontend/admin/whatsapp-onboarding.html`**: se quita el botón "Crear
  un WhatsApp Business nuevo" y el texto de ayuda que explicaba las dos
  opciones (queda un solo párrafo explicando el requisito de Coexistencia).
- **`frontend/admin/js/whatsapp-onboarding.js`**: reescrito para un único
  flujo. Se saca `_featureType`/`_phoneNumberId` como estado de frontend
  (el `phone_number_id` siempre lo resuelve el backend), el listener del
  botón eliminado, y la rama `FINISH`/`FINISH_ONLY_WABA` del postMessage
  (era la del flujo "crear nuevo"; solo queda
  `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`). De paso, se corrigió un bug
  chico: en el flujo exitoso, `restaurarBoton()` se llamaba después de
  `cargarEstadoActual()` y pisaba la etiqueta "Reconectar / cambiar
  número" que esa función ya había puesto — ahora `restaurarBoton()` va
  primero.
- **`lib/handlers/notif.js`** (`whatsappEmbeddedSignupHandler`): se saca
  toda la rama condicionada a `!esCoexistencia` — ya no se exige
  `phone_number_id` desde el frontend (siempre se resuelve server-to-server
  listando los números del WABA), se elimina el paso de `/register` con
  PIN (solo aplicaba al WABA nuevo; Coexistencia ya llega registrado por
  Meta) y `generarPinRegistro()` queda sin uso, se borra. `es_coexistencia`
  se guarda siempre en `true` y la sincronización de contactos/historial
  pasa a dispararse incondicionalmente (antes solo si `esCoexistencia`).

## Archivos

- `frontend/admin/whatsapp-onboarding.html`
- `frontend/admin/js/whatsapp-onboarding.js`
- `lib/handlers/notif.js`

## Testing

- `node --check` sobre los dos archivos JS modificados — sintaxis OK.
- Pendiente (para hacer en el navegador): instalar WhatsApp Business en
  uno de los dos números personales y completar el flujo de Coexistencia
  desde `/admin/whatsapp-onboarding` con el único botón que queda.
