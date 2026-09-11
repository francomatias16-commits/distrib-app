# Sincronización con el catálogo de WhatsApp Business (Meta Commerce Catalog)

Réplica, adaptada a la arquitectura multi-tenant de distrib/Fluxo, del
prototipo de un solo negocio que se armó para Distribuciones Trejo
(`README_INTEGRACION_META.md`, Supabase Edge Functions + tabla singleton).
Acá cada **empresa** conecta su propio catálogo — no hay tabla singleton,
sigue el mismo patrón que `empresa_whatsapp` (Embedded Signup, Etapa 7).

## Qué se agregó

- **Migración** `supabase/migrations/20260910000000_meta_catalog_sync.sql`
  — tabla `empresa_catalogo_meta` (1 fila por empresa), columna
  `productos.retailer_id` (= id del producto, autocompletada por trigger
  en altas nuevas), índice único `(empresa_id, retailer_id)`.
- **Repo** `lib/repos/catalogo-meta.js` — credenciales cifradas con
  `lib/crypto-secrets.js` (AES-256-GCM, reusa `ARCA_SECRETS_KEY`, no hace
  falta un secreto nuevo).
- **Handler** `lib/handlers/catalogo-meta.js`, 5 endpoints:
  - `GET /api/catalogo-meta/estado`
  - `POST /api/catalogo-meta/conectar` — recibe el token del login de
    Facebook y lo guarda
  - `DELETE /api/catalogo-meta/desconectar`
  - `POST /api/catalogo-meta/carga-inicial` — sube todos los productos
    del panel al catálogo de Meta (una vez, sin pisar lo que la empresa
    ya tenía cargado a mano)
  - `POST /api/catalogo-meta/importar` — espejo completo Meta → panel:
    trae TODO el catálogo (paginado), crea los productos que falten
    (descargando la imagen al bucket `productos-fotos`) y actualiza
    nombre/precio/descripción/disponibilidad/imagen de los que ya
    coinciden. Los nuevos quedan en la categoría "Importado de WhatsApp".
    Idempotente — se puede correr las veces que haga falta.
  - También exporta `sincronizarProductoConMeta(empresa_id, producto)`
    para enganchar la sync puntual panel → Meta después de crear/editar
    un producto (ver "Pendiente" más abajo) — sin depender de un
    Database Webhook aparte como en el prototipo de Trejo.
- **Frontend**: `frontend/admin/catalogo-meta.html` +
  `frontend/admin/js/catalogo-meta.js` — página nueva en
  Configuración → "Catálogo de WhatsApp" (nav agregado en
  `nav-data.js`), mismo layout que `whatsapp-onboarding.html`. Login de
  Facebook con flujo implícito (accessToken directo, sin `code`) — mismo
  fix que ya se usó en el prototipo para evitar el error de
  `redirect_uri` desalineado.
- **Wiring**: rutas en `vercel.json` (API + página `/admin/catalogo-meta`),
  loader en `api/index.js`, `META_CATALOG_LOGIN_CONFIG_ID` (vacío,
  pendiente) en `frontend/env-config.js`.
- Verificado con los checks propios del repo: `check-api-wiring.js`,
  `check-asset-wiring.js`, `check-handler-dispatch.js`,
  `smoke-test-frontend.js` — todos en verde. No se corrió la suite de
  Vitest completa en este entorno (mismatch de versión de Node ya
  conocido, ver auditorías previas).

## Diferencias a propósito frente al prototipo de Trejo

- **Multi-tenant**: `empresa_catalogo_meta` tiene `empresa_id`, no es
  singleton. `retailer_id` es único por `(empresa_id, retailer_id)`.
- **Sin Supabase Edge Functions / Deno**: todo vive como handler Node
  dentro del dispatcher único de Vercel (`api/index.js`), reusando
  `verificarToken`, `permisos-service` (gateado a dueño/admin, mismo
  recurso `empresa_config` que el resto de la config de empresa),
  `rate-limit` y `errorSeguro` ya existentes.
- **Sin Database Webhook**: la sync panel → Meta puntual (por producto)
  se resuelve llamando a `sincronizarProductoConMeta()` directo desde el
  código, no con un webhook de Supabase — coherente con el resto del
  proyecto (in-process en vez de infraestructura extra).
- **Reusa la misma app de Meta** (`WA_APP_ID` = `2765961223784707`, la
  app "fluxo" que ya usás para WhatsApp Embedded Signup) — no hace falta
  crear una app nueva, solo una Configuración de login distinta (ver
  pendiente #1).

## Pendiente — tareas manuales en developers.facebook.com

**1. Crear la Configuración de "Facebook Login for Business" para catálogo**

`catalog_management` y `business_management` no se pueden pedir con el
diálogo de login clásico (Meta devuelve "Invalid Scopes"). Hace falta,
en developers.facebook.com → tu app "fluxo" → Facebook Login for
Business → Configuraciones → crear una nueva pidiendo esos dos permisos.
Copiar el `config_id` que genera y pegarlo en
`frontend/env-config.js` → `META_CATALOG_LOGIN_CONFIG_ID` (hoy vacío).

**2. Agregar el caso de uso "Commerce/Catálogo" a la app**, si todavía no
lo tiene, y pedir `catalog_management` + `business_management` con
Advanced Access (o agregar como Tester a cada dueño de negocio mientras
la app esté en modo Desarrollo).

**3. Confirmar `ARCA_SECRETS_KEY` en Vercel** (production y preview) —
ya debería estar configurada porque `facturacion_config` la usa desde
antes; si no está, ninguna credencial de catálogo se puede cifrar.

**4. Aplicar la migración** contra Supabase (SQL Editor o `supabase db
push`).

## Pendiente — decisiones de producto

- **No hay columna de stock por cantidad** que alimente
  `availability` — igual que en el prototipo, hoy depende pura y
  exclusivamente de `productos.activo`. Si más adelante se quiere que
  "sin stock" en algún depósito marque el producto como agotado en el
  catálogo, hay que sumar esa lógica acá.
- **Enganchar `sincronizarProductoConMeta()`**: todavía no está
  llamada desde ningún lado — hay que decidir en qué punto exacto de
  `lib/handlers/productos.js` (alta y edición) se dispara, en
  background y sin bloquear la respuesta al usuario si Meta falla.
- **Corrida periódica de `importar`**: hoy es manual (botón en el
  panel). Si se quiere que los cambios hechos directo en WhatsApp se
  reflejen solos, hay que sumarla como cron — mismo patrón que
  `notif.js` (`*-cron`) ya usa para otras tareas periódicas.
- Si en algún momento se sube manualmente al catálogo por otra vía (CSV,
  Commerce Manager directo), esos ítems necesitan el mismo
  `retailer_id` (= `productos.id`) para que la sincronización los
  reconozca.

## Aparte, sin relación con este entregable

Al revisar `lib/handlers/auto-imagenes.js` para el patrón de subida a
`productos-fotos` encontré que ese archivo todavía hace
`await import('sharp')` en tiempo de ejecución, pero `sharp` se
desinstaló del todo en la auditoría DEP-01/02/03 (v983, 2026-08-24) por
"cero resultados" en un grep que no lo encontró. Ese `import()` dinámico
hoy tira en runtime si esa ruta se ejecuta — no lo toqué porque es un
frente aparte, pero convendría revisarlo pronto.
