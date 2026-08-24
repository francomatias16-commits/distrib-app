# v805 — Auditoría completa del módulo de devoluciones (post-incidente)

Disparado por un caso real en producción: se aprobó una devolución de 4.555
unidades de Mayonesa 500g (cliente que compró 42 u. en TODA su historia),
vinculada a un pedido que ni siquiera tenía ese producto (tenía Coca Cola).
Generó +4.555 u. de stock fantasma y una nota de crédito pendiente de
$9.865.288,69.

## Datos corregidos en Supabase (2026-08-17)
- Stock "Mayonesa 500g" en Depósito Central: 4.573 → **18** (revertidos los
  4.555 fantasma; el movimiento de stock bogus se borró).
- Nota de crédito pendiente de $9.865.288,69: **borrada** (nunca se emitió en
  ARCA, no hubo impacto fiscal).
- La devolución de prueba (`113bd33b...`) se borró por completo — no tenía
  ningún movimiento real detrás una vez revertido lo anterior.

## 3 gaps críticos encontrados y corregidos en `crearDevolucionCore`

**Antes** (`FIX v800`) solo se validaba que el cliente hubiera comprado el
producto *alguna vez*, sin importar cantidad ni pedido:

```js
const comprados = await obtenerProductosCompradosPorCliente(empresa_id, cliente_id);
const noComprados = items.filter(it => !comprados.has(it.producto_id));
```

**Ahora** se valida:

1. **Cantidad con tope real.** `cantidad devuelta ≤ comprado histórico −
   ya reservado en otras devoluciones no rechazadas (pendiente/aprobada)`
   del mismo producto+cliente. Nuevas funciones en `lib/repos/pedidos.js`:
   `obtenerComprasPorProductoCliente` (Map producto→cantidad comprada) y
   `obtenerDevueltoPorProductoCliente` (Map producto→cantidad ya reservada).

2. **Pertenencia al pedido.** Si la devolución viene con `pedido_id`, cada
   producto tiene que estar efectivamente en ese pedido
   (`obtenerItemsDePedido`). Antes se podía vincular cualquier pedido del
   cliente a una devolución de un producto ajeno a esa venta.

3. **Precio server-side.** `precio_unitario` ya no se toma del body de la
   request (alimentaba directo el monto de la NC/nota de débito sin ningún
   cruce). Ahora se recalcula acá: el precio real del pedido vinculado si el
   producto está ahí, o el `precio_base` actual del producto si no hay
   pedido de referencia (`obtenerPreciosBaseProductos`).

## Constraint agregado en base (migración `v805_check_devolucion_items_cantidad_precio`)

```sql
ALTER TABLE devolucion_items
  ADD CONSTRAINT devolucion_items_cantidad_positiva CHECK (cantidad > 0),
  ADD CONSTRAINT devolucion_items_precio_no_negativo CHECK (precio_unitario >= 0);
```

Última línea de defensa a nivel de base, por si algún endpoint futuro se
olvida de validar en la app.

## Revisado y confirmado OK (sin cambios)
- Flujo de **rechazo**: no toca stock ni genera NC, solo anula notas de
  débito asociadas — correcto.
- **Borrado** de devolución: solo permite `estado = 'pendiente'` — correcto.
- `ajustar_stock` (RPC): bien guardado — permisos por rol, lock `FOR UPDATE`,
  guard contra stock negativo, atómico. No requirió cambios.
- Fixes v803 (thenable `.catch()`) y v804 (idempotencia en revisar) siguen
  sólidos.

## Pendiente / no bloqueante (nota para más adelante)
- `crear_nota_credito` (RPC) no valida el total contra la factura vinculada
  — con el fix de esta versión el monto ya no se puede inflar desde el
  cliente, pero en teoría una NC podría seguir superando lo facturado si el
  precio_base del producto cambió mucho desde la venta. No es urgente porque
  ahora el precio se deriva del pedido real cuando existe.
- `listarDevolucionesFiltradas` arma el filtro `busqueda` con interpolación
  directa de string en `.or()` de PostgREST — no es explotable para leak
  cross-tenant (el `empresa_id` va con `AND` aparte), pero conviene
  sanitizar el string en algún momento por prolijidad.

## Archivos modificados
- `lib/repos/pedidos.js`: reemplaza `obtenerProductosCompradosPorCliente` por
  `obtenerComprasPorProductoCliente`, `obtenerDevueltoPorProductoCliente`,
  `obtenerItemsDePedido`, `obtenerPreciosBaseProductos`.
- `lib/handlers/pedidos.js`: `crearDevolucionCore` con las 3 validaciones
  nuevas.
- Supabase: migración de constraints + corrección de datos del incidente.
