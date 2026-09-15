# CHANGELOG v1088 — Vender sin stock: se conecta `productos.permite_negativo` de punta a punta (migración 631)

## Reporte

Punto 1 de la auditoría del POS: *"hay productos que quiero poder cobrar
aunque el depósito esté en cero, y el sistema no me deja"*.

## Causa raíz

El dato existía y la base lo respetaba, pero **ninguna capa por encima lo
leía ni lo escribía**:

- `productos.permite_negativo` existe desde la migración **001**.
- La migración **438** ya había reemplazado el `CHECK stock_no_negativo`
  por el trigger `fn_stock_valida_negativo()`, que deja el stock en
  negativo **solo** para los productos con ese flag en `true`.
- Pero `registrar_venta_pos` cortaba **siempre** con
  `stock_insuficiente` antes de llegar al `UPDATE stock` — el flag nunca
  entraba en juego.
- `fn_productos_lista` no devolvía la columna, así que el ABM de
  Productos no podía mostrarla; `fn_crear_producto` tampoco la aceptaba.
  Resultado: el flag quedaba en `false` para el 100% del catálogo y solo
  se podía tocar por SQL directo.

### Nota sobre el nombre de la columna

En el trabajo previo se asumió una columna nueva llamada
`permite_stock_negativo`, creada por una supuesta migración 630. Se
verificó contra la base real (proyecto `jgiquzjwoedmzwqgzubr`):

- La migración **630** es `sync_entregas_rutas_desde_estado_pedido`
  (v1087), nada que ver con stock.
- En `information_schema.columns` de `productos` **no existe**
  `permite_stock_negativo`. El nombre real es **`permite_negativo`**.

No se renombra nada en la base: se usa el nombre real y el frontend se
alinea a él. Renombrar habría obligado a tocar la 001, la 025, la 438,
la 492 y el importador, sin ningún beneficio.

## Cambios

### Base de datos — `20260915130000_631_permite_negativo_pos_y_abm.sql`

1. **`registrar_venta_pos`** — el chequeo de stock ahora mira
   `productos.permite_negativo`. Si está en `true`, la venta sigue y el
   stock queda en negativo; si el producto ni siquiera tenía fila de
   stock en ese depósito, se crea en 0 para que el descuento tenga sobre
   qué operar. Sin el flag, el comportamiento es **idéntico** al
   anterior: mismo mensaje, mismo `tipo: 'stock_insuficiente'`, mismo
   409 en el handler.
2. **`fn_productos_lista`** — suma `permite_negativo` a la salida.
3. **`fn_crear_producto`** — suma `p_permite_negativo` (default `false`).
   Se dropean las firmas viejas antes de recrear: con dos sobrecargas
   conviviendo, una llamada por nombre de parámetro desde PostgREST se
   vuelve ambigua.

**Bug encontrado de paso:** `fn_productos_lista` tampoco devolvía
`stock_objetivo`, aunque el modal de producto lo lee
(`normalizarRpc → p.stock_objetivo`) y lo escribe desde la 547. Al
editar cualquier producto el campo aparecía en 0 y guardaba 0, pisando
en silencio el valor cargado. Se suma a la salida.

`stock_minimo` se castea explícitamente a `numeric` en la salida: la
migración 542 lo declaraba `integer` asumiendo que la columna ya había
migrado, pero en la base real la columna sigue siendo `numeric`. Con el
cast, la función queda correcta con cualquiera de los dos tipos.

### Backend

- `lib/repos/productos.js` — `buscarProductosPos` y
  `obtenerProductosParaVentaPos` traen `permite_negativo`.
- `lib/repos/pos.js` — el embed de `productos` en `listarFavoritosPos`
  también.
- `lib/handlers/pos.js` — `GET /api/pos/productos` y
  `GET /api/pos/favoritos` exponen el flag de forma explícita (el botón
  de favorito arma el producto a mano, sin pasar por la búsqueda: sin
  esto el carrito lo veía `undefined` y bloqueaba igual).

### POS

- `frontend/admin/js/pos/carrito.js` — `agregarAlCarrito()` con stock
  ≤ 0 ya no corta siempre: si el producto tiene el flag, agrega con un
  toast de advertencia (*"no tiene stock — se agrega igual (quedará en
  negativo)"*). El flag viaja en el ítem del carrito.
- `frontend/admin/js/pos/busqueda-favoritos.js` — el badge de stock
  muestra **"Sin stock (autorizado)"** en naranja (paleta de *stock
  bajo*) en vez de rojo, y la tarjeta deja de marcarse como
  `.sin-stock` (que es lo que la atenuaba visualmente).

El catálogo offline (`pos-offline.js`) cachea el objeto de producto
completo, así que el flag viaja solo — sin cambios ahí.

### ABM de Productos

- `frontend/admin/productos.html` — checkbox
  **"Permitir vender sin stock"** en la sección de stock del modal, con
  ayuda contextual.
- `modal-producto.js` — carga/limpieza del checkbox en alta, edición y
  reset.
- `guardar-eliminar-producto.js` — se envía en el `UPDATE` de edición y
  como `p_permite_negativo` en el alta vía `fn_crear_producto`.
- `carga-datos.js` — `normalizarRpc` mapea `permite_negativo` →
  `permiteNegativo`.

### Tests

`tests/repos/productos.test.js` — test nuevo que verifica que
`buscarProductosPos` incluye `permite_negativo` en el `select` en las
tres estrategias de búsqueda (balanza, código exacto, texto libre). Sin
esa columna el POS vuelve a bloquear la venta en silencio, y era el tipo
de regresión que ningún test cubría.

Suite completa de `tests/repos` + `tests/handlers`: **1000 tests en
verde**.

## Fuera de alcance

- **Punto 2 del audit ("carrito en espera")**: sigue pendiente, es otro
  flujo.
- **Alertas de stock negativo**: un producto que queda en negativo no
  dispara hoy ningún aviso propio (cae en el mismo "stock crítico" de
  siempre, vía `GREATEST(stock_minimo, 5)` de la 547). Queda anotado
  como mejora.
- El monolito histórico `frontend/admin/js/pos.js` (reemplazado por el
  split de `js/pos/` desde el 25/08/2026 y ya no cargado por
  `pos.html`) no se tocó.

## Cómo probarlo

1. Aplicar la migración 631.
2. Productos → editar un producto → tildar **"Permitir vender sin
   stock"** → Guardar.
3. Dejar ese producto en 0 en el depósito de la caja.
4. POS → buscarlo: el badge dice *"Sin stock (autorizado)"* en naranja y
   la tarjeta ya no está atenuada.
5. Agregarlo: entra al carrito con un toast de advertencia.
6. Cobrar: la venta se registra y el stock del depósito queda en
   negativo.
7. Repetir con un producto **sin** el flag: debe seguir bloqueando con
   *"Ese producto no tiene stock en el depósito de esta caja"*.
