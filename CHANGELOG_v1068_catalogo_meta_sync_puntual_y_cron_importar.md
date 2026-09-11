# v1068 — catálogo Meta: cierre de los 2 pendientes (sync puntual + cron de importación)

Continuación de `CHANGELOG_catalogo_meta_sync.md`. Cierra los dos frentes
que habían quedado abiertos: enganchar `sincronizarProductoConMeta()` al
alta/edición de un producto, y sumar la corrida periódica de `importar`.

## Corrección de arquitectura encontrada al retomar

El plan original asumía `lib/handlers/productos.js` como punto de
enganche para el sync puntual. **Ese archivo no existe.** El alta/edición
de productos se hace directo desde el frontend contra Supabase
(`sb.rpc('fn_crear_producto', ...)` para alta, `sb.from('productos').update()`
para edición — `frontend/admin/js/productos.js`, `guardarProducto()`),
sin pasar por ningún handler Node. Esto cambia dónde corresponde
enganchar el sync: no hay backend al que sumarle una llamada in-process
después del guardado, porque el guardado en sí no pasa por el backend.

## 1) Sync puntual panel → Meta tras crear/editar un producto

- `sincronizarProductoConMeta()` ahora **devuelve** `'ok'` / `'omitido'` /
  `'error'` en vez de no devolver nada (antes no tenía ningún caller, así
  que no rompía nada cambiar el contrato).
- Nueva ruta `POST /api/catalogo-meta/sync-producto` (`handleSyncProducto`,
  `lib/handlers/catalogo-meta.js`): recibe `{ producto_id }`, busca el
  producto **scopeado a la empresa del token** (nunca confía en
  precio/nombre que mande el cliente), llama a
  `sincronizarProductoConMeta()` y **siempre responde 200** — un fallo de
  Meta no es un error del usuario que ya guardó bien su producto en el
  panel; se loguea server-side (`console.error`) y listo.
- Nuevo recurso en `lib/permisos-service.js`: `catalogo_meta_sync.disparar`
  = `['dueno', 'admin', 'depositero']` — mismos roles que pueden dar de
  alta/editar productos (a diferencia del resto de las rutas de este
  handler, que configuran la integración en sí y son admin-only vía
  `empresa_config`).
- Repo (`lib/repos/catalogo-meta.js`): `obtenerProductoParaSync(empresa_id,
  producto_id)`.
- Frontend (`frontend/admin/js/productos.js`): nueva
  `sincronizarProductoConCatalogoMeta(productoId)`, fire-and-forget (no
  se espera el fetch — no tiene que frenar el guardado si Meta está lento
  o caído), llamada una sola vez al final de `guardarProducto()` (cubre
  alta y edición), mismo patrón que `aportarBancoCodigos()` que ya vive
  ahí al lado.

## 2) Cron de importación periódica (Meta → panel)

- Se extrajo el núcleo de `handleImportarDesdeMeta` a
  `importarCatalogoDeEmpresa(empresa_id, cred)`, reusable y sin tocar
  `req`/`res` — el botón manual ahora es un wrapper fino sobre esa función.
- Nueva ruta `GET/POST /api/catalogo-meta/importar-cron`
  (`handleImportarCron`): mismo patrón de auth que los crons de
  `notif.js` (`Authorization: Bearer $CRON_SECRET` que Vercel adjunta
  solo; fail-closed con 503 si la env var no está seteada). Recorre
  **todas** las empresas con catálogo conectado
  (`listarEmpresaIdsConCatalogoConectado()`, nueva en el repo) — un error
  en una empresa no corta el resto, queda en el `detalle` de la respuesta.
- `vercel.json`: rewrite `/api/catalogo-meta/importar-cron` +
  entrada en `crons` (`0 10 * * *`, diaria — horario libre, no pisa
  ningún otro cron existente).

## Tests

Nuevo `tests/handlers/catalogo-meta-permisos.test.js` (13 tests, mismo
patrón que `auto-imagenes-permisos.test.js`/`importar-permisos.test.js`):
gate de roles de `sync-producto` (dueño/admin/depositero sí, vendedor/
contador/chofer no, sin token 401, sin `producto_id` 400, producto de
otra empresa 404, con catálogo conectado sincroniza y marca
`ultima_sync_push_at`), más el gate de `CRON_SECRET` de `importar-cron`
(sin configurar → 503, secret incorrecto → 401, correcto → 200).

## Verificación

- `npx vitest run tests/handlers/catalogo-meta-permisos.test.js`: 13/13 OK.
- Suite completa: **1966/1966 tests OK** en 136/137 archivos. El archivo
  que falla (`tests/handlers/cliente-en-mora-listener.test.js`) revienta
  al *cargar* el módulo (`lib/eventos-dispatcher.js:83`, `TypeError:
  Cannot read properties of undefined (reading 'length')`) — confirmado
  que es preexistente y sin relación con este cambio: falla igual
  corriéndolo solo, en un archivo que ni se tocó.
- `npm run check-wiring:all` (assets + API + dispatch interno): sin
  hallazgos. Dispatch interno subió de 100 a 101 combinaciones
  reconocidas (`sync-producto` nueva).
- `npm run check:migrations`: sin colisiones.
- `node -c` sobre los 3 archivos backend tocados: sintaxis OK.

## Archivos en este delta

- `lib/handlers/catalogo-meta.js`
- `lib/repos/catalogo-meta.js`
- `lib/permisos-service.js`
- `frontend/admin/js/productos.js`
- `vercel.json`
- `tests/handlers/catalogo-meta-permisos.test.js` (nuevo)

## Pendiente (fuera de alcance de esta entrega)

- Si en algún momento se sube manualmente al catálogo por otra vía (CSV,
  Commerce Manager directo), esos ítems necesitan el mismo `retailer_id`
  (= `productos.id`) para que la sincronización los reconozca — ya
  documentado en la entrega anterior, sigue vigente.
- El cron corre 1 vez por día a las 10:00 (hora del servidor); si algún
  cliente necesita reflejo más inmediato de cambios hechos directo en
  WhatsApp, ese intervalo es ajustable en `vercel.json` sin tocar código.
