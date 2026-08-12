# v231 — Fix: sincronización de la sección Productos

## Problema

La pantalla `/admin/productos.html` mostraba siempre el mismo listado de
10 productos de ejemplo (Aceite Girasol, Arroz Largo Fino, Azúcar, etc.),
sin importar los datos reales de la empresa. Además, el botón de acciones
(⋮) por fila abría un `confirm()` nativo del navegador ("¿Desea editar
este producto?") que no editaba nada — solo hacía `console.info` — y el
botón "+" de agregar producto mostraba un `alert()` de "próximamente".

Esto la dejaba desincronizada respecto del resto del panel (Clientes,
Stock, Facturación), que sí leen y escriben contra Supabase con
formularios reales.

## Causa raíz

`cargarProductos()` en `productos.js` hacía:

```js
.from('productos').select('id, nombre, activo, updated_at, created_at,
  precio_base, costo, stock_actual, stock_minimo, categorias(nombre)')
```

Pero **`updated_at` y `stock_actual` no existen como columnas de la
tabla `productos`** (el stock real vive en la tabla `stock`, una fila
por depósito, y `updated_at` nunca se agregó). Esa query fallaba en
cada carga, el `catch` lo silenciaba con un toast de advertencia y la
pantalla caía siempre al dataset demo hardcodeado — por eso nunca se
veían los productos reales ni sus cambios.

## Cambios

1. **`supabase/migrations/231_productos_updated_at_sync.sql`**
   Agrega la columna `updated_at` a `productos` + trigger que la
   actualiza en cada `UPDATE`, para que "Última actualización" refleje
   ediciones reales (antes no existía la columna).

2. **`frontend/admin/js/productos.js`**
   - `cargarProductos()`: la query ahora trae `stock(cantidad,
     cantidad_reservada)` embebido y `categoria_id`, y ya no pide
     columnas inexistentes. `normalizar()` calcula el stock real sumando
     `cantidad - cantidad_reservada` de todos los depósitos del producto
     (misma lógica agregada que usa Stock).
   - Nuevo modal real "Nuevo/Editar producto" (`abrirModalProducto`,
     `cerrarModalProducto`, `guardarProducto`, `cargarCategorias`),
     reutilizando el mismo componente `.modal-backdrop`/`.modal` que
     Clientes, con `insert`/`update` reales contra Supabase.
   - `abrirMenuAcciones()` ahora abre ese modal en vez del `confirm()`
     nativo. `agregarProducto()` lo abre en modo alta en vez del
     `alert()` de "próximamente".

3. **`frontend/admin/productos.html`**
   Se agrega el markup del modal (`modal-producto`) y se sube el
   cache-busting (`?v=231`) de `productos.css`/`productos.js`.

4. **`frontend/admin/css/productos.css`**
   Se agregan las reglas del modal (`.modal`, `.modal-backdrop`,
   `.form-*`, `.btn-primario`, `.btn-secundario`, etc.), copiadas del
   mismo bloque que usa `clientes.css`, ya que Productos no las tenía.

## Pendiente / fuera de alcance

- El botón "Columnas" (`editarColumnas()`) sigue siendo un placeholder
  ("disponible próximamente"): es una función distinta (mostrar/ocultar
  columnas de la tabla), no relacionada con el bug de sincronización.
