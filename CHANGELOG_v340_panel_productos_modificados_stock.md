# v340 — Panel "Productos modificados" en Stock (hoy / 7 días / 30 días)

**Fecha:** 2026-07-16
**Contexto:** siguiendo el fix del toast de ajustes de stock (que ya
muestra el cambio real y resalta la fila), se pidió evaluar si sumar una
zona con los productos modificados en un período, para no depender de
buscar producto por producto cuando alguien quiere revisar "qué cambió
hoy" en el depósito.

## Qué se agregó

Panel colapsable arriba de la barra de filtros en `stock.html`, con
tres pestañas de período (Hoy / Últimos 7 días / Últimos 30 días).
Para cada producto+depósito con movimientos en el período muestra:

- Delta neto (suma de `cantidad` de `movimientos_stock` en el rango)
- Cantidad de movimientos
- Fecha/hora del último movimiento
- Depósito

Clic en un ítem: busca ese producto en la tabla principal (mismo
mecanismo que ya usa `guardarAjuste()` — `resaltarFilaActualizada`),
en vez de abrir el modal directamente, porque `movimientos_stock` no
trae los datos de stock actual (disponible/reservado/costo) que el
modal de ajuste necesita.

## Implementación

- **Fuente de datos:** `movimientos_stock`, ya tiene todo lo necesario
  (`producto_id`, `deposito_id`, `cantidad`, `created_at`). No hizo
  falta ninguna tabla ni columna nueva.
- **Agregación:** se resuelve client-side (fetch de hasta 300 filas del
  período + `Map` por `producto_id|deposito_id`), no con una función
  agregada en Postgres. Es más simple y el volumen es bajo — igual que
  el resto de `stock.js`, que ya trae listas cortas y arma cosas en el
  cliente (ver `cargarDepositos`, `cargarCategorias`).
- **Seguridad:** delegación de eventos + `data-*` attrs, mismo patrón
  que las acciones de fila de la tabla (`btn-fila-accion`) — nunca se
  interpola texto de la base de datos dentro de un `onclick=""`.
- **No bloquea la carga principal:** se dispara en paralelo desde
  `init()`, igual que `cargarAlertasStockAuto()` y el overview.

## Por qué "hoy / 7 días / 30 días" y no rango libre

Se evaluó agregar un date-range picker, pero para el caso de uso
("¿qué cambió recientemente?") tres ventanas fijas cubren el 95% de
los casos con cero fricción. Si más adelante hace falta un rango
arbitrario, tiene más sentido resolverlo en `reportes-stock.html`
(que ya existe para análisis más profundos) que sumarle un date-picker
a esta vista operativa del día a día.

## Archivos tocados

- `frontend/admin/stock.html` — markup del panel
- `frontend/admin/css/stock.css` — estilos `.modif-*`
- `frontend/admin/js/stock.js` — `cargarProductosModificados`,
  `selPeriodoModificados`, `toggleModificados`, delegación de click
