# v658 — Portal proveedor: escritura offline (Plan offline, Etapa 3, cierre)

Cierra el punto 4 de `PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md` (sección
0): se decidió meter el portal proveedor a Etapa 3 (escritura offline) en vez
de documentarlo como solo-lectura antes del rollout general.

## Alcance

El portal (`frontend/proveedor/portal.html`, sin login — acceso por token en
la URL) tiene exactamente dos escrituras, ambas ahora encolables sin
conexión:

- **`confirmar-entrega`** — el proveedor confirma/ajusta la fecha esperada
  de una OC propia.
- **`subir-factura`** — el proveedor autocarga una factura (con o sin OC
  asociada, con archivo opcional hasta 8MB).

## Idempotencia — asimetría a propósito

- `confirmar-entrega` es un **UPDATE** sobre `ordenes_compra` — reintentar
  la misma acción con el mismo payload es naturalmente idempotente. No
  necesitó ningún cambio de esquema.
- `subir-factura` es un **INSERT** sobre `facturas_proveedor` — sin
  protección, un reintento del outbox duplica la factura. Se agregó
  `offline_local_id` (migración 448) con el mismo patrón de dedup que ya
  usan `ajustar_stock`/`registrar_conteo_stock` (443) y las entregas del
  chofer (444): si ya existe una factura con ese `offline_local_id`, se
  devuelve la existente en vez de insertar de nuevo
  (`insertarFacturaProveedorPortal`, `lib/repos/portal-proveedor.js`).

## Aislamiento multi-tenant (Etapa 4) — el caso distinto de este portal

A diferencia de admin/chofer/cliente, `verPortal()` (`lib/handlers/
portal_proveedor.js`) nunca le devuelve al cliente el `proveedor_id` ni el
`empresa_id` — es deliberado, para no filtrar ids internos desde una
pantalla pública sin login. Sin ese dato, `getEmpresaId()` de OfflineCore no
tiene qué usar.

Se usa el **token de la URL** como clave de scoping en su lugar
(`frontend/proveedor/proveedor-offline.js`): identifica de forma única a
este proveedor+empresa en el dispositivo, y de hecho separa incluso dos
proveedores distintos de la misma empresa que compartan navegador — un
aislamiento más fino que el que da `empresa_id` en los otros portales.

## Conflictos (Etapa 4)

Mismo criterio que chofer-offline.js/stock-offline.js: cualquier rechazo
del servidor al sincronizar (OC ya `recibida`/`cancelada`, OC ya no
encontrada) es un **conflicto**, no un error transitorio — reintentar a
ciegas con el mismo payload nunca va a funcionar. El badge muestra un
título específico según el mensaje (`"la orden ya no admite cambios de
fecha"`, `"la orden ya no está disponible"`) y ofrece Reintentar/Descartar
vía el modal genérico de `offline-core.js`.

## Archivos

- **Nuevo** `supabase/migrations/448_offline_dedup_factura_proveedor.sql`
  — columna `offline_local_id` + índice único parcial en
  `facturas_proveedor`.
- **`lib/repos/portal-proveedor.js`** — `insertarFacturaProveedorPortal`
  dedup por `offline_local_id`.
- **`lib/handlers/portal_proveedor.js`** — `subirFactura` acepta y propaga
  `offline_local_id`.
- **Nuevo** `frontend/proveedor/proveedor-offline.js` — outbox sobre
  `OfflineCore` (mismo patrón que `chofer-offline.js`), expone
  `window.ProveedorOffline`.
- **`frontend/proveedor/portal.js`** — `guardarFecha`/`guardarFactura`
  encolan en vez de fallar cuando no hay red (`!navigator.onLine` antes del
  fetch, o `TypeError` del propio fetch); `init()` llama a
  `ProveedorOffline.init({ token })`.
- **`frontend/proveedor/portal.html`** — suma Dexie (CDN), `offline-core.js`
  y `proveedor-offline.js` antes de `portal.js`.
- **`frontend/proveedor/sw-proveedor.js`** (v1 → v2) — suma el listener
  `sync` (relevo de Background Sync a cualquier pestaña abierta, mismo
  patrón que `sw-chofer.js`/`sw-admin.js`); las mutaciones POST siguen sin
  interceptarse (Network-Only), que es justo lo que permite que el fetch
  falle solo sin red y dispare el encolado.
- **Nuevo** `tests/frontend-offline/proveedor-offline.test.js` — cubre
  `validarTipo`, `getContexto`/`getEmpresaId` (token), `procesarAccion` de
  ambos tipos (payload correcto, `offline_local_id` solo en
  `subir_factura`, conflicto en rechazo del servidor), `badge.
  formatoConflicto` y los hooks `onConflicto`/`onSincronizado`. Corrido a
  mano con un harness `vm` equivalente al helper del proyecto
  (`tests/helpers/cargar-modulo-offline.js`) porque el sandbox no tiene
  `node_modules` instalados — falta correrlo con `npm test` real antes de
  mergear.

## Nota para Etapa 6

Con esto, de los 4 huecos que `PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md`
marcaba en la sección 0, quedan **3 de 4 cerrados**. El único que sigue
abierto es el punto 3 (smoke end-to-end real contra `graph.facebook.com`),
que no se puede cerrar desde el repo — necesita ejecutarse a mano contra el
número de prueba de Meta. El resto de la Etapa 6 (matriz 1.2/1.3/1.4,
piloto, rollout) sigue sin arrancar.
