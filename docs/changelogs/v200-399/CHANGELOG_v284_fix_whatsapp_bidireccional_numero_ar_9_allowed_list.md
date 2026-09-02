# v284 — Fix: respuesta de WhatsApp fallaba con (#131030) en números argentinos

## Contexto

Durante el primer test end-to-end real de la Etapa 6 (WhatsApp bidireccional,
2026-07-10/11), el flujo completo funcionó: el webhook recibió el mensaje real
("quiero dos azúcar") desde un celular argentino, matcheó al cliente de
prueba, corrió el asistente — pero la respuesta del bot nunca llegó al
teléfono. Vercel logueaba:

```
[whatsapp-webhook] Error enviando texto: (#131030) Recipient phone number not in allowed list
```

## Causa raíz

Bug de larga data de Meta, específico de números de Argentina (también
reportado para Brasil y México) cuando se usa el **número de prueba en modo
Desarrollo**:

- El mensaje entrante trae el teléfono con el "9" que WhatsApp antepone a
  los celulares argentinos (ej. `5493482313453`) — así es como queda (bien)
  guardado en `whatsapp_conversaciones.telefono` y así se matchea contra
  `clientes.telefono` vía `resolver_cliente_por_telefono()`.
- La "lista de destinatarios permitidos" del número de prueba, en cambio,
  puede quedar guardada internamente **con o sin** ese "9" — y no de forma
  estable: depende de cómo se haya escrito/re-verificado el número en la UI
  de Meta. En el primer intento de este piloto quedó sin "9"; al
  re-verificar el número escribiéndolo explícitamente con "9", quedó al
  revés. **No hay forma confiable de saber de antemano cuál de los dos
  formatos tiene Meta guardado en un momento dado.**

Confirmado en foros/issues públicos como comportamiento conocido de Meta
para estos países, exclusivo del modo Desarrollo con número de prueba. En
producción, con el número real y negocio verificado (Etapa 7 del plan), no
existe lista de destinatarios permitidos y este error no se presenta.

## Cambio

**Intento 1 (insuficiente):** una función `formatoEnvioMeta()` que siempre
sacaba el "9" antes de enviar. Funcionó como diagnóstico pero no como fix
definitivo — al re-verificar el número con "9" en Meta, la lista pasó a
tener el formato con "9", y sacarlo siempre pasó a producir el mismo error
en sentido contrario.

**Fix definitivo:** en vez de asumir un formato fijo, `enviarTextoWhatsApp`
(Etapa 6, respuestas de texto libre) y `whatsappHandler` (envío de
templates) ahora **reintentan automáticamente con el formato alterno**
(agregando o sacando el "9") únicamente cuando Meta responde con el error
puntual 131030. Cualquier otro error se sigue tratando como antes (se
loguea y se corta, sin reintentos que puedan ocultar problemas reales como
token vencido o número mal formado).

Nueva función `alternarNueveAr(telefono)` en `lib/handlers/notif.js`:
recibe el teléfono ya normalizado (`549...` o `54...`) y devuelve la otra
variante, o `null` si no matchea ningún patrón de celular argentino
conocido (en cuyo caso no hay reintento).

No se toca en ningún caso:
- Lo que se guarda en `whatsapp_conversaciones` / `whatsapp_mensajes`.
- El matching de cliente/empresa (`resolver_cliente_por_telefono`).
- El teléfono usado en cualquier otro lugar del código — el reintento vive
  encapsulado dentro de la llamada de envío, no se propaga.

Fuera del sandbox de número de prueba (producción con número real) el
error 131030 no ocurre nunca, así que el bloque de reintento queda inerte.

## Verificación

- `node --check lib/handlers/notif.js` — sintaxis OK.
- Pendiente (para hacer vos tras el deploy): repetir el mensaje real desde
  el celular argentino de prueba y confirmar en los logs de Vercel que,
  aunque aparezca el primer 131030, ahora sigue un reintento exitoso y la
  respuesta llega al teléfono. Confirmar también en
  `whatsapp_mensajes.wa_message_id` que la fila `out` ya no queda en null.

## Archivos tocados

- `lib/handlers/notif.js`

