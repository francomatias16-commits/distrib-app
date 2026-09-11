# v1071 — completado: config_id de Facebook Login for Business para el catálogo de Meta

Cierra el bloqueante que dejó pendiente `CHANGELOG_v1070_fix_duplicados_catalogo_meta.md`.

## Qué se hizo (manual, en developers.facebook.com)

Se creó la Configuración de "Facebook Login for Business" en la app
`WA_APP_ID = 2765961223784707`:

- Nombre: "Catalogo Meta - Panel"
- Variación: General
- Token: **Token de acceso de usuario** (no de sistema — cada empresa se
  conecta con su propia cuenta personal de Facebook, vía el popup de
  `FB.login`)
- Permiso solicitado: **`catalog_management`** únicamente

`config_id` generado: `28469338942706245`, pegado en
`frontend/env-config.js` → `META_CATALOG_LOGIN_CONFIG_ID`.

## Nota sobre `business_management`

`CHANGELOG_v1070` y los comentarios del código original asumían que
hacía falta pedir `catalog_management` + `business_management` juntos.
Al crear la configuración real, Meta no ofreció `business_management`
como opción disponible para una configuración con token de tipo "Token
de acceso de usuario" (no aparece en el buscador de permisos para esa
combinación variación/tipo de token).

Se revisó el código para confirmar si realmente hacía falta: el único
endpoint de la Graph API que se llama con este token es
`GET /me/owned_product_catalogs` (`lib/handlers/catalogo-meta.js`), que
está cubierto por `catalog_management` solo. No hay ninguna llamada a
`/businesses` ni a otro endpoint que requiera `business_management`. Se
actualizaron los comentarios en `frontend/admin/js/catalogo-meta.js`,
`frontend/env-config.js` y `lib/handlers/catalogo-meta.js` para reflejar
esto y no dejar el requisito viejo (incorrecto) documentado.

## Pendiente real: probar en producción

Falta la prueba end-to-end con una empresa real después de mergear esta
rama a `main` (deploy automático desde ahí, no `vercel --prod` manual):
Configuración → Catálogo de WhatsApp → "Conectar catálogo de WhatsApp",
confirmar que el popup de Facebook abre pidiendo solo el permiso de
catálogo y que `authResponse.accessToken` llega bien al backend
(`/api/catalogo-meta/conectar`). Si al probar aparece algún error de
permisos insuficientes al llamar `/me/owned_product_catalogs` (por
ejemplo si en algún caso real el catálogo pertenece a un Business Manager
al que el usuario no tiene rol de admin y `catalog_management` solo no
alcanza), ahí sí habría que revisar si hace falta pedir
`business_management` de otra forma (configuración con Token de sistema,
o Advanced Access vía App Review) — pero no se puede confirmar eso sin
probarlo con un caso real primero.

## Qué sigue en pie de v1070

Las limitaciones documentadas en `CHANGELOG_v1070_fix_duplicados_catalogo_meta.md`
no cambian: foto obligatoria para ítems genuinamente nuevos, matching por
nombre textual (no semántico), nombres ambiguos sin auto-vincular.
