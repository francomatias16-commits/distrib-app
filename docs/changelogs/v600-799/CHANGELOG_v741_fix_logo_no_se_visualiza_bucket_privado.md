# CHANGELOG v741 — Fix: el logo se sube pero no se visualiza (bucket privado + getPublicUrl)

## Motivo

El dueño reportó que al subir un logo en "Datos de la empresa" el sistema
avisaba "Logo actualizado" pero la imagen nunca se veía (quedaba la
inicial). Sospecha inicial: tamaño del archivo. Se descartó — el archivo
de prueba (`fluxo.png`) pesa 964 KB, bien debajo del límite de 2MB, y es
un PNG válido.

## Causa real

`lib/handlers/empresa.js`, `POST /api/empresa/logo`, llamaba a
`getPublicUrl()` sobre el bucket `logos`. Ese bucket pasó a
`public = false` en la migración `140_apply_pending_fix_storage_listing_logos.sql`
(30/06/2026) — corrección de seguridad real: con `public = true` cualquiera
podía **listar** el bucket completo y enumerar `empresa_id` + nombres de
archivo de todas las empresas, no solo leer un logo puntual.

El problema: `getPublicUrl()` arma una URL con el shape "pública" sin
chequear si el bucket realmente lo es. Con el bucket ya privado, esa URL
no se sirve a pedidos anónimos — y tanto la vista previa del admin como
`frontend/admin/login.html` y `frontend/cliente/login.html` cargan el
logo con un `<img src="...">` sin sesión (confirmado: ambos login
consultan un endpoint público que devuelve `logo_url` y lo ponen directo
en un `<img>`, antes de que exista ningún token). El navegador pedía la
imagen, Supabase Storage la rechazaba, y `img.onerror` volvía en
silencio al ícono con la inicial (`pintarLogo()`, sin mostrar ningún
error) — de ahí que pareciera que "no pasaba nada".

## Fix

`lib/handlers/empresa.js` — se reemplazó `getPublicUrl()` por
`createSignedUrl(storagePath, 10 años en segundos)`. El cliente Supabase
de este proyecto (`lib/repos/_db.js`) usa `SERVICE_ROLE_KEY`, así que la
firma no depende de las policies de `storage.objects` — igual que
`getPublicUrl()`, pero la URL resultante sí funciona contra un bucket
privado. El bucket sigue sin listado público (no se reabre el hallazgo
de la migración 140): la URL firmada da acceso solo al archivo puntual
que se acaba de subir, no al bucket.

Vencimiento largo (10 años) a propósito: es un asset que cambia muy rara
vez (el logo de la empresa), no tiene sentido meter un cron de renovación
— cada re-upload ya regenera la URL sola.

## Alcance / pendiente

- El fix aplica a partir de la **próxima subida** de logo de cada
  empresa. Si en producción ya hay empresas con un `logo_url` guardado
  de antes de este fix (URL "pública" que ya no sirve), van a necesitar
  volver a subir su logo una vez una vez desplegado este cambio — no se
  hizo un backfill automático de URLs firmadas para logos existentes
  porque implica tocar la base de producción directamente y no estaba
  pedido; se puede armar un script aparte si hace falta.
- No se tocó la migración 140 ni las policies de `storage.objects`: el
  bucket sigue privado, la corrección de seguridad de esa migración
  queda intacta.
- No se tocó `GET /api/empresa/icon` (sigue haciendo `redirect` a lo que
  haya en `logo_url` — con el fix, eso ahora es una URL firmada
  funcional en vez de una URL pública rota).

## Logo de prueba

Se limpithere `fluxo.png` (era un mockup de presentación: tarjeta con
sombra, fondo degradado gris y el texto "Redes Conectadas" debajo, no un
logo listo para usar) → se recortó al ísotipo+wordmark real, se quitó el
fondo gris, y se generaron dos versiones cuadradas de 512×512:
`fluxo-logo-transparente.png` (109 KB, fondo transparente) y
`fluxo-logo-fondo-blanco.png` (82 KB, fondo blanco sólido), ambas muy por
debajo del límite de 2MB.
