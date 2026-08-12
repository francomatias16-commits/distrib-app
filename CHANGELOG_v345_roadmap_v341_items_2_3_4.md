# v345 — Roadmap v341: transferencia atómica, redirección de motivos, BOM y conteos históricos

Continuación directa del roadmap dejado en `CHANGELOG_v341...md`. El ítem 1
(selector de depósito en recepción de OC) ya había quedado resuelto en la
sesión anterior (`compras.js`/`compras.html`, migración 341/341b). Este pase
resuelve los ítems 2, 3 y 4.

## 2) `transferir_stock` — transferencia atómica entre depósitos

**Migración:** `342_transferir_stock_atomico.sql` (ya estaba aplicada en
producción; esta sesión la dejó registrada en el repo, que no la tenía).
**Frontend:** `frontend/admin/js/stock.js`, función `guardarAjuste()`.

Reemplaza el patrón de dos llamadas a `ajustar_stock` (débito + crédito) con
reversión manual del lado cliente por una única función SQL que hace ambos
lados dentro de la misma transacción de Postgres. Lockea las dos filas de
`stock` en orden determinístico (por id) para evitar deadlocks entre
transferencias cruzadas concurrentes. Ya no existe ventana donde el stock
pueda quedar débitado de origen sin acreditar en destino.

## 3) Redirección de "Compra a proveedor" y "Venta manual"

**Frontend:** `frontend/admin/stock.html`, `frontend/admin/css/stock-gentelella.css`,
`frontend/admin/js/stock.js`.

- **Compra a proveedor**: se **bloquea** en el modal de ajuste (el botón
  Guardar se deshabilita) con un aviso que linkea a Compras. Ya no hace
  falta el workaround: con el fix de `recepcionar_orden_compra` (v341) una
  compra real queda vinculada a lote/costo/proveedor, algo que el ajuste
  manual no puede replicar.
- **Venta manual → "Salida por venta no facturada"**: se renombra la opción
  del `<select>` para dejar claro que es solo para el caso legítimo de
  egreso ya cobrado sin factura en el momento. Se agrega un aviso
  (no bloqueante) que sugiere el POS cuando hay cliente y cobro de por
  medio.

Guardia defensiva del lado servidor: no aplica (el `ajustar_stock` sigue
aceptando el motivo `compra` si alguien lo llama directo por API/REST fuera
del panel — bloquear eso queda fuera de alcance de este pase, que se limita
al flujo del panel admin).

## 4) BOM de producción propia + conteos históricos

**Migraciones:** `343_bom_produccion_propia.sql`, `343b_fix_search_path...sql`,
`344_conteos_stock_historico.sql`.
**Frontend:** `frontend/admin/js/stock.js` (usa las nuevas RPCs),
`frontend/admin/js/productos.js` + `frontend/admin/productos.html` (modal
"Receta (BOM)" nuevo, accesible desde el modal de edición de producto).

### Producción propia (`producir_con_insumos`)
Tabla `producto_insumos` (producto terminado → insumo + cantidad por unidad).
Al producir N unidades desde el modal de ajuste (motivo "Producción propia"),
la función:
1. Valida que alcance el stock de cada insumo de la receta (todo o nada).
2. Descuenta cada insumo del mismo depósito, sincroniza FEFO y registra el
   movimiento (`produccion_consumo`).
3. Acredita el producto terminado y registra su movimiento (`produccion`).

Todo en una única transacción SQL. Si el producto no tiene receta cargada,
produce igual sin descontar nada (`tiene_receta:false`) — no bloquea a
empresas que todavía no cargaron el BOM.

La gestión de la receta es un modal nuevo en Productos ("Gestionar receta
(BOM)"), con alta/baja de insumos vía `producto_insumos` (RLS por empresa,
CRUD directo desde el cliente).

### Conteos históricos (`registrar_conteo_stock`)
Tabla `conteos_stock`: snapshot de cada conteo físico (cantidad que decía el
sistema vs. la contada, con la diferencia ya calculada). El "Ajuste directo"
del modal de stock (motivos "Corrección de inventario" / "Conteo físico") ya
no pasa por `ajustar_stock` con un delta calculado a mano en el cliente:
llama a `registrar_conteo_stock`, que hace el mismo ajuste atómico (lock +
sync de lotes/FEFO) y además deja el snapshot histórico en la misma
transacción. Permite auditar recuentos periódicos y detectar patrones de
diferencia recurrentes por producto/depósito a futuro (todavía no hay una
pantalla de reporte sobre `conteos_stock` — la tabla y la carga de datos
quedan listas para eso).

## Bug de signo corregido de paso

Al tocar el branch de "ajuste directo" en `guardarAjuste()` se encontró que
`delta = tipoActivo === 'egreso' ? -Math.abs(cantidad) : Math.abs(cantidad)`
forzaba el delta a positivo también para `tipoActivo === 'ajuste'`, incluso
cuando el conteo era menor al stock del sistema (`cantidad` negativa). Al
enrutar "ajuste directo" a `registrar_conteo_stock` con la cantidad contada
directa (no un delta), este bug queda evitado de raíz para ese caso — no se
tocó el branch de ingreso/egreso, que no lo tenía.

## Pendiente (no incluido en este pase)

- No hay pantalla de reporte sobre `conteos_stock` (solo se está grabando).
- El bloqueo de "Compra a proveedor" es solo de UI (panel admin); la RPC
  `ajustar_stock` sigue aceptando ese motivo si se la llama directo.
- La receta (BOM) no tiene validación de "recetas circulares" (A insumo de B,
  B insumo de A) — con una sola capa de insumos por ahora no genera loops de
  descuento real (el descuento es directo, no recursivo), pero si a futuro
  se anida producción de insumos que son a su vez productos con su propia
  receta, esto no se resuelve en cascada automáticamente.
