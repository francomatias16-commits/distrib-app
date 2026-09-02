# Etapa 9 — Notas de crédito y débito / devoluciones

Alcance: `lib/handlers/facturas.js` (`handleNotasCredito`), `lib/handlers/
pedidos.js` (`handleDevolucionesAdmin`, `handleChofer` → ruta `devolucion`),
`frontend/admin/js/notas-credito.js`, `frontend/admin/js/devoluciones.js`,
`frontend/admin/devoluciones.html`, `frontend/chofer/remito.html`, RPCs
`crear_nota_credito`, `aplicar_nota_credito_cta_cte`, `fn_notas_credito_lista`.

## Resumen de hallazgos

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1. `aplicar_nota_credito_cta_cte` fallaba SIEMPRE (INSERT a `cta_cte` sin `empresa_id`/`monto`, ambas NOT NULL) — ninguna NC podía terminar de emitirse, en silencio | 🔴 Crítica | ✅ Corregido — migración `315` ya aplicada en Supabase, verificada en vivo |
| 2. Aprobar una devolución no reponía stock ni generaba crédito al cliente, pese a que la página lo prometía explícitamente | 🔴 Alta | ✅ Corregido en código — pendiente `git push`/deploy a Vercel |
| 3. RPC del panel de emisión de NC no revisaba errores — fallo de Hallazgo 1 era invisible para el admin | 🟡 Media (consecuencia directa del H1) | ✅ Corregido en código — pendiente `git push`/deploy a Vercel |

## Hallazgo 1 — `aplicar_nota_credito_cta_cte` rota (🔴 Crítica)

El RPC que aplica el crédito de una NC en la cuenta corriente del cliente
hacía:

```sql
INSERT INTO cta_cte (cliente_id, tipo, importe, factura_id, nro_comprobante, descripcion, fecha)
VALUES (...)
```

`cta_cte.empresa_id` y `cta_cte.monto` son `NOT NULL` sin default. El
INSERT usaba `importe` (columna legacy que el frontend de cta-cte no lee —
`cta-cte.js` solo usa `m.monto`) y omitía `empresa_id` directamente. El
INSERT fallaba el 100% de las veces con `23502 null value in column
"monto"/"empresa_id" violates not-null constraint`, lo que revertía toda
la función — incluida la `UPDATE` previa que marca la NC como `emitida`.

**Verificado en vivo antes del fix:** se llamó al RPC contra una NC
`pendiente` real (`5bd02535-...`); falló exactamente como se predijo. Al
ser una sola sentencia, el fallo se revirtió automáticamente sin dejar
efectos. Se confirmó además que en producción hay 42 `notas_credito` en
estado `emitida` pero **0 filas en `cta_cte`** con ese origen — esas 42 son
datos de demo cargados directo por SQL (comercialización, jul 5–6), no
productos de este flujo real.

**Impacto:** ni `lib/handlers/facturas.js` (modo manual sin ARCA) ni el
modo con ARCA revisaban el `error` devuelto por este RPC, así que el fallo
era invisible — el admin veía "NC emitida" en el toast, pero la NC seguía
`pendiente` y el cliente nunca recibía el crédito.

**Fix aplicado:**
- Migración `315_etapa9_fix_aplicar_nota_credito_cta_cte.sql`, ya aplicada
  en Supabase: el INSERT ahora incluye `empresa_id` y usa `monto` (magnitud
  positiva — es lo que espera `sync_saldo_deuda_cliente()` para
  `tipo='credito'`, que ya lo resta al calcular el saldo).
- Verificado de nuevo en vivo contra la misma NC real: esta vez el RPC
  aplicó el crédito correctamente. Ese efecto de la prueba (NC marcada
  `emitida` con número de prueba + fila en `cta_cte`) se revirtió
  manualmente antes de seguir, dejando la NC de nuevo en `pendiente` como
  estaba.
- Ver Hallazgo 3 para el chequeo de error agregado en el código, para que
  un fallo futuro de este tipo sea visible en vez de silencioso.

## Hallazgo 2 — Aprobar devolución no repone stock ni genera crédito (🔴 Alta)

`devoluciones.html` decía desde siempre: *"registrá mercadería que vuelve
de un pedido entregado, **decidí si repone stock o genera nota de
crédito**, y seguí el estado de cada devolución"* — pero ni el backend
(`handleDevolucionesAdmin`, acción `revisar`) ni el frontend tenían ningún
código para reponer stock o generar una NC. Aprobar una devolución solo
cambiaba `devoluciones.estado`; lo único automático en todo el flujo era
la nota de débito al proveedor cuando el motivo era `producto_defectuoso`
(y solo si el producto tenía `proveedor_id_default` cargado). El cliente
que devolvía mercadería (por el motivo que fuera: defecto, error de
pedido, arrepentimiento, vencimiento) no recibía nunca stock repuesto ni
crédito — había que hacerlo a mano desde paneles sin ningún vínculo con la
devolución de origen.

**Fix aplicado** — `handleDevolucionesAdmin` (`PATCH ?accion=revisar`)
ahora acepta `reponer_stock` y `generar_nc` (booleanos, solo aplican si
`estado='aprobada'`):

- `reponer_stock`: por cada `devolucion_items`, llama a `ajustar_stock()`
  (mismo RPC que ya usa `stock.js`, con lock atómico y validación de
  depósito propio) sumando la cantidad devuelta al depósito marcado
  `es_principal` de la empresa. Si no hay depósito principal configurado,
  no rompe la aprobación — reporta el error aparte.
- `generar_nc`: arma los ítems desde `devolucion_items` (descripción =
  nombre de producto, cantidad y precio real) y llama a
  `crear_nota_credito()` directo, con tipo A/B según la condición de IVA
  del cliente y, si existe, la factura del mismo pedido como referencia.
  La NC queda `pendiente` — la emisión real contra ARCA sigue siendo un
  paso manual desde Facturación → Notas de crédito, igual que cualquier
  otra NC (no se auto-emite, evita duplicar CAEs por error).
- Frontend (`devoluciones.js`): dos checkboxes nuevos en el panel de
  revisión (tildados por default), y el toast de confirmación ahora dice
  qué pasó realmente (`"Devolución aprobada, stock repuesto (2 ítem(s)),
  NC generada (pendiente de emisión)"`) en vez de solo "aprobada".

**Fuera de alcance de esta etapa:** no se agregó un selector de depósito
en la UI (siempre usa el principal) ni una forma de reponer solo parte de
los ítems seleccionados individualmente — si hace falta ese nivel de
control, es una vuelta futura sobre esta misma pantalla.

## Hallazgo 3 — RPC de emisión de NC sin chequeo de error (🟡 Media)

Consecuencia directa del Hallazgo 1: ni el modo manual (sin config ARCA)
ni el modo con ARCA revisaban `{ error }` al llamar a
`aplicar_nota_credito_cta_cte`. Ahora ambos caminos lo revisan:

- **Modo manual:** si falla, devuelve `500` con mensaje claro y la NC
  queda visiblemente `pendiente` (no se le miente al admin).
- **Modo ARCA:** acá la NC *ya* tiene CAE real (no se puede deshacer sin
  generar una anulación formal), así que un fallo del crédito en `cta_cte`
  no revierte la emisión — se registra en `notas_credito.notas_error` para
  que quede visible en el panel y alguien lo aplique a mano, en vez de
  devolver un 500 que sugeriría reintentar (lo que generaría una NC
  duplicada contra ARCA).

## Nota de metodología
Esta etapa cubrió backend y la interfaz real en la misma pasada, según lo
establecido en etapas anteriores. La revisión de RPCs se hizo contra la
base viva (`jgiquzjwoedmzwqgzubr`), incluyendo una verificación empírica
del bug del Hallazgo 1 antes y después del fix (con reversión inmediata
del efecto secundario que dejó la segunda prueba, ya que esa sí se aplicó
de verdad al no fallar).
