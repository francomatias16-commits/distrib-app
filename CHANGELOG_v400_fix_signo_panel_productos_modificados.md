# v400 — Fix definitivo: panel "Productos modificados" sumaba sin signo

**Contexto:** continuación del diagnóstico de la sesión anterior (250
unidades de devolución de cliente + 250 de corrección de inventario debían
netear a 0, pero el panel mostraba +500).

## Diagnóstico confirmado con datos reales de producción

```
jabon liquido / Depósito Principal:
  egreso   250.000  (referencia: inventario)
  ingreso  250.000  (referencia: devolucion_cliente)
```

`ajustar_stock()` guarda `ABS(delta)` en `movimientos_stock.cantidad` y
codifica la dirección en `tipo` ('ingreso' | 'egreso'). El panel sumaba
`cantidad` cruda sin mirar `tipo`, por eso 250 + 250 = 500 en vez de 0.

## Cambios

1. **`frontend/admin/js/stock.js` → `cargarProductosModificados()`**
   Ahora aplica un signo según `tipo` antes de sumar:
   `{ ingreso: +1, egreso: -1, ajuste: +1, transferencia: +1 }`.
   `ajuste` y `transferencia` ya guardan la diferencia con signo en
   `cantidad` (ver puntos 2 y 3), así que se suman tal cual.
   También se excluyen `reserva` / `liberacion` de la consulta: esos tipos
   solo tocan `stock.cantidad_reservada`, no el stock físico, y no
   pertenecen a este panel.

2. **Migración 399** (`registrar_conteo_stock`, aplicada en la sesión
   anterior, ahora versionada en el repo) — guarda la diferencia del conteo
   CON SIGNO en vez de `ABS()`.

3. **Migración 400** (`transferir_stock`) — mismo bug que el de `ajuste`:
   guardaba `p_cantidad` positivo en ambos lados de la transferencia
   (origen y destino), y como `tipo='transferencia'` es igual en las dos
   filas, no había forma de saber cuál depósito perdió stock y cuál ganó a
   partir de una sola fila. Se corrigió para guardar negativo en origen,
   positivo en destino. No requirió backfill (no había filas
   `tipo='transferencia'` en producción).

## Verificado

Con los datos reales de "jabon liquido": Depósito Principal ahora da
neto **0** (antes +500); Sucursal Norte sigue en **+150** (ya estaba bien,
un solo movimiento de ingreso).

## Archivos tocados

- `frontend/admin/js/stock.js`
- `supabase/migrations/399_fix_signo_movimientos_ajuste.sql` (versionado,
  ya estaba aplicado en producción)
- `supabase/migrations/400_fix_signo_movimientos_transferencia.sql`
  (nuevo, aplicado en producción)
