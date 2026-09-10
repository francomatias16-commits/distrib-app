# Sincronización de catálogo de WhatsApp (Commerce Manager) — distrib

## Qué se armó
Integración para sincronizar `productos` de distrib con el catálogo de
WhatsApp/Commerce Manager de cada empresa (pedido de CLAY). Mecanismo
adaptado del que ya funciona en producción en el proyecto Trejo
(Edge Functions de Supabase), portado al patrón handler/repo + Vercel
Cron de distrib y a multi-tenant.

## ⚠️ Historial de renumeración de migraciones (dos vueltas)
El SQL original vino numerado como `606_whatsapp_catalog_sync.sql`, pero
en el primer zip de distrib-app usado como base esos números (606 y 607)
ya estaban tomados por otro cambio aplicado ese mismo día
(`..._606_fn_rodar_cheques_demo...` / `..._607_fn_rodar_presupuestos...`).
Se renumeró a **608 y 609** en esa primera integración (armado del zip
`distrib-app-v955-whatsapp-catalog-integrado.zip`, sin aplicar en
Supabase todavía).

Al ingresar a la base real de Supabase para aplicar las migraciones, se
detectó que **608 y 609 también estaban tomados en producción**
(`608_fn_rodar_stock_demo`, `609_seed_stock_386_productos_demo`,
aplicadas el mismo día, más recientes que el zip). Se renumeró por
segunda vez a **610 y 611**, se actualizaron todas las referencias
cruzadas (nombre de archivo, comentarios en el código, `INSERT` al
registro) y se aplicaron ambas contra el proyecto real
(`jgiquzjwoedmzwqgzubr`) con `Supabase:apply_migration`.

**Verificado tras aplicar** (sesión 2026-09-10, continuación): `list_migrations`
confirma `610_whatsapp_catalog_sync` y `611_whatsapp_catalog_sin_mensajeria`
en la base real; `producto_whatsapp_catalog_map` existe con las columnas
esperadas; `empresa_whatsapp.catalog_*` existen; `waba_id`/`phone_number_id`/
`access_token` quedaron `NULLABLE`; `schema_migrations_registry` tiene las
dos filas con `aplicada_por='claude-session'`. También se validó el insert
de `crearProductoImportadoDeCatalogo` (lib/repos/whatsapp-catalog.js) contra
el schema real de `productos`: las únicas columnas `NOT NULL` sin default son
`empresa_id` y `nombre`, ambas cubiertas — no hace falta tocar el repo.

## Archivos (numeración final aplicada: 610/611)
- `supabase/migrations/610_whatsapp_catalog_sync.sql` — SQL original:
  `catalog_id`/`catalog_access_token` (cifrado) en `empresa_whatsapp`,
  tabla `producto_whatsapp_catalog_map` (estado ok/conflicto/pendiente/error
  por producto), vistas de estado no sensibles para el panel.
- `supabase/migrations/611_whatsapp_catalog_sin_mensajeria.sql` — relaja
  `waba_id`/`phone_number_id`/`access_token` de `empresa_whatsapp` a
  `NULLABLE`. Sin esto, una empresa que solo quiere catálogo (sin conectar
  el bot de WhatsApp vía Embedded Signup) no podía insertar su fila.
- `lib/repos/whatsapp-catalog.js` — credenciales del catálogo, estado de
  sync por producto (`producto_whatsapp_catalog_map`), listado de
  productos activos, alta/lookup de la categoría "Importado de WhatsApp".
- `lib/handlers/whatsapp-catalog.js` — endpoints y motor de sync:
  - `GET  ?_svc=estado` — conectado/no, catalog_id, última sync, resumen.
  - `POST ?_svc=conectar` — Facebook Login for Business (scope
    `catalog_management,business_management`) → intercambio de code por
    token de larga duración → valida acceso al `catalog_id` → guarda
    cifrado (`lib/crypto-secrets.js`, mismo criterio que el resto del
    proyecto).
  - `POST ?_svc=desconectar`
  - `POST ?_svc=sincronizar` — botón "Sincronizar ahora" del panel.
  - `GET|POST ?_svc=cron` — recorre todas las empresas con catálogo
    conectado (mismo criterio de auth `CRON_SECRET` que el resto de los
    crons del proyecto).
- `frontend/admin/js/whatsapp-catalog.js` + tarjeta nueva en
  `whatsapp-onboarding.html` — conectar, sincronizar y ver el resumen
  (ok / importados / conflictos / errores) desde el panel.
- `lib/permisos-service.js` — gate `whatsapp_catalog` (dueño/admin).
- `api/index.js` — registro del handler en el dispatcher (`_mod=whatsapp-catalog`).
- `vercel.json` — rewrite `/api/whatsapp-catalog(.*)` + cron diario
  (`_svc=cron`, 12:00 UTC).

## Decisión de diseño (repetida a propósito, es la que más importa)
`productos` sigue siendo la fuente de verdad de precio y stock (gobernados
por el ERP). El catálogo de WhatsApp es una vidriera:
- **Push** (distrib → Meta): título/descripción/imagen/disponibilidad de
  cada producto matcheado, y alta de los que falten en Meta (con precio
  solo en el momento de la creación inicial).
- **Import** (Meta → distrib): items del catálogo de Meta sin match local
  se crean como producto nuevo en distrib, categoría "Importado de
  WhatsApp", para que se les asigne la categoría real a mano.
- **Nunca se pisa** el precio de un producto que ya existe en ambos
  lados. Si el precio de Meta difiere del de distrib (tolerancia
  $0.01), se marca `conflicto` en `producto_whatsapp_catalog_map` — el
  panel lo muestra para revisión manual.

## Corrección de formato real de la Catalog Batch API (de la sesión anterior)
La primera versión del handler usaba un formato de request inventado. Se
corrigió contra el formato que ya corre en producción en Trejo: un único
`method: "UPDATE"` + `allow_upsert: true` a nivel del POST (no existe un
method "CREATE" separado), identificador en `data.id`, campos `title`/
`image_link` para escribir (`name`/`image_url` son los que devuelve Meta
al leer), y `price` como string en centavos.

## Pendiente / a decidir con vos
1. **`link` del item** (URL "ver más" que exige Meta al crear un
   producto): por ahora se manda un placeholder
   (`WA_CATALOGO_LINK_DEFAULT` o `https://distrib.app` si no está
   configurada esa env var).
2. **`WA_APP_ID`/`WA_APP_SECRET`**: se reutilizan las mismas variables
   de entorno que ya usa Embedded Signup de mensajería (misma app "fluxo"),
   pero el login de catálogo pide scope distinto
   (`catalog_management,business_management`) — confirmar que la app
   tenga el caso de uso "Commerce/Catálogo" agregado con ese permiso.
3. **`CRON_SECRET`** ya debería estar configurada en Vercel (la usan
   todos los demás crons) — no hace falta ninguna env var nueva.
4. **Deploy a Vercel**: las migraciones ya están en Supabase, pero el
   código (handler/repo/frontend/dispatcher) todavía necesita el
   `vercel --prod` para quedar activo en producción.

## No se tocó
- El bot conversacional de WhatsApp (`lib/repos/whatsapp-bot.js`,
  Embedded Signup de mensajería) — integración separada, comparte solo
  la fila de `empresa_whatsapp`.
- El schema de `productos` — no se agregó ninguna columna ahí; todo el
  estado de sync vive en `producto_whatsapp_catalog_map`.
