# v289 — Fix "No se pudo obtener el número conectado"

## Problema
Con el `config_id` ya corregido (v288), el popup de Meta abre y se completa,
pero el botón termina mostrando "No se pudo obtener el número conectado.
Probá de nuevo."

## Causa
El listener de `postMessage` en `whatsapp-onboarding.js` solo reconocía el
evento `FINISH` de Meta. Pero el flujo de Embedded Signup puede terminar
mandando **`FINISH` o `FINISH_ONLY_WABA`** según el camino que siga el
usuario dentro del popup (por ejemplo, según si crea un número nuevo o
completa el paso de la cuenta de WhatsApp Business de otra forma). Como el
código ignoraba `FINISH_ONLY_WABA`, `_wabaId`/`_phoneNumberId` nunca se
guardaban y el chequeo posterior fallaba siempre en ese camino.

Además, la espera antes de chequear era un `setTimeout` fijo de 400ms — si el
postMessage llegaba un poco más tarde que eso, también fallaba por timing.

## Fix
- El listener ahora acepta tanto `FINISH` como `FINISH_ONLY_WABA`.
- Se agregó un `console.debug` que loguea el evento y el payload crudo que
  manda Meta, para poder diagnosticar rápido si vuelve a fallar (abrir la
  consola del navegador con F12 antes de tocar "Conectar mi WhatsApp").
- La espera fija de 400ms se cambió por un polling de hasta 2.4s (12
  intentos de 200ms), reintentando hasta que `_wabaId`/`_phoneNumberId`
  lleguen o se agote el tiempo.
- Si después de todo eso siguen sin llegar, se loguea con `console.warn` el
  estado final para facilitar el diagnóstico.

## Si vuelve a fallar
Abrir la consola del navegador (F12 → pestaña Console) antes de tocar
"Conectar mi WhatsApp", completar el flujo, y revisar la línea que empieza
con `[whatsapp-onboarding] WA_EMBEDDED_SIGNUP` — ahí se ve el evento exacto
y el `data` que mandó Meta, lo que dice si vino sin `phone_number_id` (habría
que agregar un número en ese paso del popup) o si directamente no llegó
ningún postMessage (posible bloqueo de popup o de cookies de terceros).
