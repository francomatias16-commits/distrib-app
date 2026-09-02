# v353 — Subida de foto de producto desde el modal

## Problema

`productos.foto_url` existe desde el schema original y ya se mostraba en
catálogo, carrito, product-picker y compras — pero el modal de alta/edición
de Productos no tenía ninguna forma de cargar o cambiar esa foto. También
había un bucket de Storage (`productos-fotos`, público, con policies de
insert/update/delete para `authenticated`) ya aplicado directo en
producción, sin migración versionada que lo documente.

## Cambios

### Base de datos (migración `353_foto_producto_upload.sql`)

- Se documenta en migración versionada el bucket `productos-fotos` y sus
  policies (`productos_fotos_auth_insert/update/delete`), que ya estaban
  aplicados directo en producción. Todo con `ON CONFLICT DO NOTHING` /
  `IF NOT EXISTS`, así no rompe si ya existían.
- `fn_productos_lista`: se agrega `foto_url` a la salida, para que el modal
  de edición pueda precargar la imagen actual sin un segundo round-trip.
- `fn_crear_producto`: se agrega `p_foto_url` (opcional, al final de la
  firma) para poder guardar en la misma alta la foto ya subida a Storage.

### Frontend (`frontend/admin/productos.html` y `frontend/admin/js/productos.js`)

- Nueva sección **"Foto"** en el modal (entre Identificación y Precios y
  stock): preview circular/cuadrado 84×84, input de archivo, botón
  "Quitar imagen" (solo visible si hay foto) y validación de formato
  (JPG/PNG/WEBP/GIF) y tamaño (máx. 5 MB) client-side antes de subir.
- La subida a Storage ocurre recién al apretar "Guardar producto" (no al
  elegir el archivo), usando el cliente Supabase logueado del admin
  (`sb.storage.from('productos-fotos').upload(...)`) — no pasa por
  backend, a diferencia del flujo de fotos de devoluciones del chofer
  (que no tiene sesión Supabase con RLS y por eso usa un endpoint propio).
- Convención de path: `${empresa_id}/${uuid-random}.${ext}`. Las policies
  del bucket no aíslan por empresa a nivel de Storage (cualquier usuario
  autenticado puede insertar/actualizar/borrar en el bucket), así que la
  separación multi-tenant queda a nivel de aplicación por convención de
  nombre de archivo, igual que otros usos de Storage en el proyecto.
- **Alta**: si se subió una foto, se pasa como `p_foto_url` al RPC
  `fn_crear_producto`.
- **Edición**: `guardarProducto()` agrega `foto_url` al payload del
  `update` directo — la nueva URL si se subió una, `null` si se apretó
  "Quitar imagen", o la que ya tenía si no se tocó nada.
- `normalizarRpc()` mapea `foto_url` → `fotoUrl` para que `abrirModalProducto()`
  pueda precargar el preview en edición.
- Si falla la subida de la imagen, se avisa con un toast y el producto se
  guarda igual (sin foto), en vez de bloquear todo el guardado.

## Verificación

- Se confirmó que `productos.foto_url`, el bucket `productos-fotos` y sus
  policies ya existían en la base antes de esta migración (investigación
  de sesión previa).
- Se aplicó la migración 353 contra el proyecto `jgiquzjwoedmzwqgzubr` y se
  verificó con `pg_get_function_identity_arguments` que ambas funciones
  quedaron con la firma esperada (`foto_url` en la salida de
  `fn_productos_lista`, `p_foto_url` al final de `fn_crear_producto`).
- Se corrió `node --check` sobre `productos.js` para confirmar que no hay
  errores de sintaxis.

## Pendiente / a probar manualmente

- Probar en el navegador el flujo completo de alta con foto, edición con
  cambio de foto y "Quitar imagen", para confirmar que el preview y el
  guardado se comportan como se espera con datos reales.
