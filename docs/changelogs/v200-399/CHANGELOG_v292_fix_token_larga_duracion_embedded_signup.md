# v292 — Token de larga duración en WhatsApp Embedded Signup (Etapa 7)

## Problema
`whatsappEmbeddedSignupHandler` (`lib/handlers/notif.js`) guardaba en
`empresa_whatsapp.access_token` el token que devuelve el primer intercambio
del `code` de Facebook Login for Business (`/oauth/access_token` con
`client_id` + `client_secret` + `code`). Ese token es de **corta duración**
(del orden de 1-2hs) — Meta lo documenta así para todo login de Facebook que
no pide explícitamente el canje a token de larga duración.

Efecto real: una empresa se conecta, todo funciona en el momento (registro
del número + suscripción a webhooks + primeros mensajes), y unas horas
después el token vence. Meta no manda ningún aviso de "token vencido" — el
próximo envío simplemente empieza a fallar con error 190, en silencio, hasta
que alguien nota que un cliente no recibió un mensaje.

## Fix
Se agregó un paso intermedio (Paso 1bis) entre el intercambio del `code` y
el registro del número: un segundo llamado a `/oauth/access_token`, esta vez
con `grant_type=fb_exchange_token`, que canjea el token corto por uno de
**larga duración (~60 días)**. Ese es el que se usa para registrar el
número, suscribir los webhooks, y el que finalmente se guarda en
`empresa_whatsapp.access_token`.

Si el canje falla por algún motivo, no se corta el alta — se guarda el
token corto (mejor eso que nada) pero queda un `console.error` bien visible
en los logs de Vercel, porque implica que esa empresa puntual se va a
desconectar sola en un par de horas.

## Qué NO resuelve todavía (queda para otra vuelta si hace falta)
- El token de larga duración **también vence, a los ~60 días**. No es una
  solución permanente — para eso hace falta un token de System User (no
  expira), que requiere un paso adicional contra la Business Management API
  después del alta. Lo dejamos para más adelante si el volumen de empresas
  lo justifica.
- No hay todavía ninguna alerta ni chequeo automático de "este token está
  por vencer" — hoy el primer síntoma sigue siendo un mensaje que no sale.
  Si querés, se puede armar un chequeo simple (al loguearse el admin, o un
  cron liviano) que marque en `v_empresa_whatsapp_estado` cuándo conviene
  reconectar.
- El `access_token` sigue guardado en texto plano en `empresa_whatsapp`
  (mismo pendiente ya anotado en la migración 272).

## Archivo modificado
- `lib/handlers/notif.js` — sin cambios de esquema, no requiere migración.
  Verificado con `node --check`.
