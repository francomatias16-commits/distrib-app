# CHANGELOG v199 — Gap 1/4: Precios especiales (vista global)

## Contexto
Retomando la auditoría de los 4 gaps de UI detectados en el changelog anterior
(precios especiales, ventas POS, comprobantes históricos, direcciones). Este
fix cubre el **gap 1 completo**: precios_clientes.

## Hallazgo confirmado
`precios_clientes` no tenía absolutamente ningún endpoint admin (ni lectura ni
escritura) fuera del wizard de migración, y cero referencias en el frontend
fuera de `migracion.js`. Constraints confirmados en vivo (Supabase
`jgiquzjwoedmzwqgzubr`): `UNIQUE(cliente_id, producto_id)`, FKs a `clientes` y
`productos` con `ON DELETE CASCADE`, `CHECK (precio >= 0)`.

## Backend
- `lib/repos/clientes.js`: `listarPreciosClientesGlobal`, `upsertPrecioCliente`
  (upsert por `cliente_id,producto_id`, respeta el unique constraint),
  `eliminarPrecioCliente`. Todas con filtro de tenant (`empresa_id`).
- `lib/handlers/clientes.js`: sub-ruta `/api/clientes/precios` (mismo patrón
  que `/acceso`: `req.url?.includes('/precios') || _svc === 'precios'`).
  - `GET` → lista global con joins a `clientes` y `productos`, filtros
    `cliente_id`, `producto_id`, `busqueda` (client-side sobre el resultado).
  - `POST` → upsert (crear o actualizar si ya existe el par cliente+producto).
  - `DELETE ?id=` → elimina con filtro de tenant.
  - No se tocó ninguna ruta ni rewrite de `vercel.json`: `/api/clientes(.*)`
    ya captura todo.

## Frontend
- `frontend/admin/clientes.html`: toggle de vista "Clientes" / "Precios
  especiales" debajo del breadcrumb (mismo patrón visual que las pills de
  estado). Nueva vista con tabla global (cliente, producto, precio, notas,
  fecha) y modal de alta.
- `frontend/admin/js/clientes.js`: módulo completo (`cambiarVista`,
  `cargarPreciosClientes`, `renderTablaPrecios`, `filtrarPrecios`,
  `abrirModalPrecio`/`guardarPrecioCliente`/`eliminarPrecioCliente`).
  - Select de clientes reutiliza `clientesData` ya cargado por la página
    (sin fetch extra).
  - Select de productos usa consulta directa a Supabase (mismo patrón que
    `compras.js::cargarProductos`), cacheada en `productosParaPrecios`.
  - Todas las funciones expuestas a `window.*` porque el script es
    `type="module"` (no hay scope global implícito) — mismo patrón que el
    resto del archivo.

## Verificado
- `node --check` sobre los 3 archivos JS tocados.
- Constraints de la tabla verificados contra el proyecto Supabase real antes
  de escribir el upsert.

## Pendiente (gaps 2, 3, 4 — próxima entrega)
1. **ventas_pos**: ampliar el tab "Ventas" existente en `pos.html`
   (`panel-admin-ventas`) con filtro de fecha/estado + export Excel
   (SheetJS, ya está cargado en `clientes.html`, confirmar si está en
   `pos.html`).
2. **comprobantes_historicos**: tab de solo lectura en `facturacion.html`
   con filtro por fecha y tipo.
3. **cliente_direcciones**: no existe NADA (ni repo ni handler ni UI). Hay
   que construir CRUD completo desde cero — es el gap más grande de los 4.
   El comentario en `migracion.js` que decía "ya existía via
   `lib/repos/cliente-direcciones.js`" es incorrecto, ese archivo no existe
   en el repo.
