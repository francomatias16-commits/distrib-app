# CHANGELOG v1090 — Agregar stock rápido desde el carrito (mitad "agregar stock sin perder el comprobante" del punto 1 del audit)

## Reporte

Continuación del punto 1 de la auditoría del POS. La v1088 conectó
`permite_negativo` de punta a punta para los productos que **sí** pueden
venderse en negativo. Para los que **no** tienen ese flag, el cajero
seguía topando con un toast de error y tenía que abandonar el POS —
perdiendo el carrito armado hasta ese momento — para ir a cargar stock a
otra pantalla.

## Cambios

### Backend

- `lib/repos/stock.js` — `ajustarStockRpc()`, envoltorio compartido del
  RPC `ajustar_stock` (ya usado por `lib/handlers/stock.js`).
- `lib/handlers/pos.js` — `POST /api/pos/agregar-stock-rapido`. Roles
  `dueno`/`admin`/`depositero` ajustan directo; el resto requiere PIN de
  supervisor (`pin_supervisor` en el body), verificado con el mismo hash
  que ya usa `ticket-facturacion.js`. Sin PIN o con uno incorrecto, 403
  `{ requiere_pin: true }`. Valida caja/producto contra la empresa antes
  de tocar stock.
- `vercel.json` — rewrite para la ruta nueva.

### Frontend — POS

- `frontend/admin/js/pos/agregar-stock-rapido.js` (nuevo) —
  `abrirModalStockRapido()`, `cerrarModalStockRapido()` y
  `confirmarStockRapido()`. Llama al endpoint nuevo y, si sale bien,
  agrega el producto al carrito automáticamente para no obligar al
  cajero a volver a buscarlo. El campo de PIN se muestra de entrada
  según el rol logueado (mejor UX), pero la única fuente de verdad es
  el backend: si el 403 vuelve con `requiere_pin: true` (propaga bien
  porque `apiPost` en `nucleo.js` hace
  `Object.assign(new Error(...), data, { status })`), el campo se
  muestra igual junto con el error.
- `frontend/admin/pos.html` — modal `#modal-stock-rapido-overlay`
  (cantidad, notas, PIN condicional) y `<script>` nuevo registrado
  después de `hardware-config.js`.
- **`frontend/admin/js/pos/carrito.js`** — en `agregarAlCarrito()`,
  la rama `if (!producto.permite_negativo)` ya no corta la venta con
  un toast fijo: ahora abre el modal de carga rápida sobre el POS
  mismo (`window.abrirModalStockRapido(producto)`), sin perder el
  carrito en memoria. Si el script del modal no llegó a cargarse por
  algún motivo, cae al comportamiento anterior (toast de error) para
  no dejar al cajero sin feedback.

### Tests

- `tests/handlers/pos-agregar-stock-rapido.test.js` (nuevo) — 10 casos:
  roles directos, vendedor sin/con/con-mal PIN, sin PIN de supervisor
  configurado, cantidad inválida, producto ajeno, caja inactiva/ajena,
  rol sin permiso de vender.
- Suite completa (`tests/handlers` + `tests/repos`): **84 archivos,
  1012 tests, todos verdes** (verificado en la sesión donde se armó el
  backend; no se tocó nada de esa capa en este cierre, solo
  `carrito.js`).
- No hay tests de frontend (`tests/frontend*`) que cubran
  `agregarAlCarrito()` ni el toast viejo — no hace falta actualizar
  ninguno existente.

## Fuera de alcance

- Punto 2 del audit ("carrito en espera") sigue pendiente, es otro
  flujo.
- El monolito histórico `frontend/admin/js/pos.js` (reemplazado por el
  split de `js/pos/` desde el 25/08/2026 y ya no cargado por
  `pos.html`) no se tocó.

## Cómo probarlo

1. POS → buscar un producto **sin** `permite_negativo` y sin stock en
   el depósito de la caja actual.
2. Agregarlo al carrito: en vez del toast de error, se abre el modal
   "Agregar stock rápido".
3. Con rol `dueno`/`admin`: cargar cantidad y confirmar sin PIN → el
   producto se agrega solo al carrito con el stock ya actualizado.
4. Con otro rol (ej. `vendedor`): el campo PIN aparece de entrada;
   probar con PIN incorrecto (403, mensaje de error, campo PIN sigue
   visible) y luego con el correcto (ajusta y agrega al carrito).
5. Repetir el mismo producto ya con stock > 0: `agregarAlCarrito()`
   sigue su camino normal, sin abrir el modal.
