# Auditoría de integridad de datos — distrib-app
## Fase 3 — Flujo de negocio: pedido → factura → cta_cte → cobro

**Fecha:** 2026-07-03
**Alcance:** trazado completo del flujo pedido → factura → cta_cte → cobro,
incluyendo las variantes POS y proveedores que comparten las mismas tablas.
**Método:** revisión del código (`lib/handlers`, `lib`, `lib/arca`) +
verificación cruzada contra el estado real de la base de Supabase
(proyecto `jgiquzjwoedmzwqgzubr`) vía `pg_proc` / `information_schema`,
no solo contra `supabase/migrations/*.sql` ni `docs/schema-snapshots/*`.

---

## Nota metodológica importante

`supabase/migrations/*.sql` y `docs/schema-snapshots/*` **no reflejan el
estado real de producción**. Ejemplos concretos encontrados:

- `docs/schema-snapshots/public_schema_full.sql` incluye una tabla
  `movimientos_cta_cte` que **no existe** en la base real.
- Las definiciones reales de `registrar_cobro_completo` y
  `emitir_nota_cta_cte` (obtenidas de `pg_proc` en producción) no coinciden
  con las de `supabase/migrations/011_fase1_transacciones.sql` ni
  `038_fix_consistencia_v39.sql` — alguien las parchó directo en producción
  sin dejar una migración versionada.
- `cta_cte` en producción tiene columnas (`monto` NOT NULL, `importe`
  nullable) que no coinciden exactamente con ninguna migración del repo
  vista de forma aislada.

**Recomendación transversal:** antes de confiar en el repo para la Fase 1,
regenerar `docs/schema-snapshots/` desde la base real y reconciliar el
historial de migraciones (o al menos documentar los hotfixes aplicados
fuera de migración).

---

## Hallazgo 1 — CRÍTICO
**Cancelar un pedido "anula" facturas ya emitidas (con CAE) sin Nota de Crédito ni reversión de cta_cte**

- **Tablas:** `facturas`, `cta_cte`
- **Archivo/línea:** `lib/handlers/pedidos.js:249-252` (versión original)
- **Problema:** el `UPDATE facturas SET estado='anulada'` directo incluía
  facturas en estado `'emitida'` (ya con CAE real de ARCA). Para ARCA esa
  factura sigue vigente; para el sistema, no. Además, el débito que esa
  factura ya había asentado en `cta_cte` nunca se revertía.
- **Severidad:** crítico (riesgo fiscal + deuda fantasma en cta_cte).
- **Estado:** ✅ **Corregido** (ver sección "Fixes aplicados").

## Hallazgo 2 — CRÍTICO
**Débito/crédito en cta_cte no atómico con la emisión fiscal**

- **Tablas:** `facturas`, `cta_cte`
- **Archivo/línea:** `lib/facturas.js:104-113`, `lib/arca/wsfev1.js:776-793`
- **Problema:** tras la llamada externa a ARCA (WSFEv1) y el `UPDATE
  facturas`, el `INSERT` en `cta_cte` era una llamada JS suelta. Si fallaba,
  solo se logueaba por consola (`console.error`), sin cola de reintento ni
  alerta persistida — el saldo del cliente quedaba desincronizado en forma
  silenciosa y permanente.
- **Severidad:** crítico.
- **Estado:** ✅ **Corregido** (ver sección "Fixes aplicados").

## Hallazgo 3 — CRÍTICO
**El cobro online (Mercado Pago) nunca acredita en cta_cte; `desbloquearSiSaldado` es código muerto**

- **Tablas:** `cta_cte`, `clientes`, `bloqueos_cliente`
- **Archivo/línea:** `lib/handlers/pagos.js:591-693` (webhook), `703-719`
  (`desbloquearSiSaldado`, nunca invocada en todo el archivo)
- **Problema:** al aprobar un pago, el webhook solo hacía `UPDATE pedidos
  SET estado='confirmado'`. Nunca se registraba un `'cobro'` en `cta_cte`.
  Un cliente que pagaba por Mercado Pago un pedido ya facturado (con débito
  en cta_cte) quedaba con esa deuda para siempre, y la función pensada para
  desbloquearlo automáticamente no se llamaba desde ningún lugar.
- **Severidad:** crítico.
- **Estado:** ✅ **Corregido** (ver sección "Fixes aplicados").

## Hallazgo 4 — MEDIO (confirmado en vivo)
**Columnas duplicadas `monto`/`importe` en cta_cte, desincronizadas según quién escribe**

- **Tabla:** `cta_cte`
- **Confirmado por SQL directo contra producción** (no solo por archivos
  del repo): `monto` (NOT NULL) e `importe` (nullable) coexistían. Los RPC
  `registrar_cobro_completo` y `emitir_nota_cta_cte` completaban ambas; los
  inserts directos desde `lib/facturas.js` y `lib/arca/wsfev1.js` solo
  completaban `monto`.
- **Riesgo:** cualquier pantalla nueva que sume por `importe` (como ya hace
  `frontend/admin/js/notas.js:72`) subestimaría saldos si se mezclan tipos.
- **Severidad:** medio.
- **Estado:** ✅ **Corregido** (ver sección "Fixes aplicados").

## Hallazgo 5 — DESCARTADO tras verificación en vivo
**Tabla `movimientos_cta_cte` supuestamente huérfana**

- Planteada inicialmente en base a `docs/schema-snapshots/public_schema_full.sql`.
- **Verificado contra la base real: la tabla no existe.** El snapshot está
  desactualizado. No se tomó ninguna acción sobre la base por este punto,
  más allá de dejar la advertencia metodológica de arriba.

## Hallazgo 6 — CRÍTICO
**Anular una venta POS es una secuencia de llamadas sueltas, sin el RPC atómico que sí usa la creación**

- **Tablas:** `stock`, `movimientos_stock`, `cta_cte`, `ventas_pos`
- **Archivo/línea:** `lib/handlers/pos.js`, función `anularVentaHandler`
  (líneas 728-802)
- **Problema:** `registrarVentaHandler` (creación) usa una sola RPC
  transaccional (`registrar_venta_pos`). `anularVentaHandler` (anulación),
  en cambio, es un loop de llamadas sueltas: por ítem, `SELECT stock` →
  `UPDATE stock` (patrón leer-y-escribir, no atómico: dos anulaciones
  concurrentes pueden pisarse) → `INSERT movimientos_stock`; aparte, un
  `INSERT` en `cta_cte` si había pago en cuenta corriente; recién al final,
  `UPDATE ventas_pos SET estado='anulada'`. Un corte a mitad de camino deja
  stock parcialmente restaurado sin que la venta se marque como anulada,
  y un reintento duplica esa restauración de stock.
- **Verificado contra `pg_proc`:** no existe ningún `anular_venta_pos` en
  la base — nunca se construyó el equivalente atómico de `registrar_venta_pos`.
- **Severidad:** crítico.
- **Estado:** ✅ **Corregido en esta sesión** (ver sección "Fixes aplicados").

## Hallazgo 7 — MEDIO
**PATCH de factura de proveedor permite cambiar `estado` a cualquier valor sin pasar por la RPC de pago/conciliación**

- **Tabla:** `facturas_proveedor`
- **Archivo/línea:** `lib/handlers/cc_proveedores.js:255-278`
- **Problema:** `if (estado) upd.estado = estado;` sin whitelist. Cualquier
  usuario con rol `dueno/admin/contador` puede marcar una factura de
  proveedor como `'pagada'` (o cualquier string) sin pasar por
  `registrar_pago_proveedor` ni `conciliar_oc_factura`, desincronizando el
  saldo real de `cc_proveedores`/`cta_cte` de proveedores respecto al
  estado mostrado.
- **Severidad:** medio.
- **Estado:** ✅ **Corregido en esta sesión** (ver sección "Fixes aplicados").

---

## Fixes aplicados

### En la base de datos (ya en producción)

1. **Migración `unificar_monto_importe_cta_cte`** (Hallazgo 4): backfill de
   `monto`, reescritura de `registrar_cobro_completo` y
   `emitir_nota_cta_cte` para no depender de `importe`; columna `importe`
   marcada `DEPRECATED` (no se dropeó todavía por seguridad).
2. **Nueva función `asentar_movimiento_cta_cte_factura`** (Hallazgo 2):
   asienta el débito/crédito de `cta_cte` asociado a una factura en una
   sola transacción, con validación de tenant e idempotencia.
3. **Nueva función `anular_venta_pos`** (Hallazgo 6, esta sesión): revierte
   stock, registra movimientos, acredita `cta_cte` si corresponde, y marca
   la venta como anulada — todo en una sola transacción atómica.

### En el código (entregado como archivos completos + diffs)

| Archivo | Hallazgo | Cambio |
|---|---|---|
| `lib/facturas.js` | 2 | usa `asentar_movimiento_cta_cte_factura` en vez de INSERT suelto |
| `lib/arca/wsfev1.js` | 2 | ídem, para el crédito de Nota de Crédito |
| `lib/handlers/pagos.js` | 3 | el webhook de MP registra el cobro y desbloquea al cliente |
| `lib/handlers/pedidos.js` | 1 | cancelar pedido con factura emitida dispara Nota de Crédito real |
| `lib/handlers/pos.js` | 6 | `anularVentaHandler` ahora llama a la RPC `anular_venta_pos` |
| `lib/handlers/cc_proveedores.js` | 7 | whitelist de estados permitidos por PATCH |

---

## Pendiente / recomendado para continuar la auditoría

- Revisar si `proveedores.js` (recepción de OC, `recepcionar_orden_compra`)
  tiene el mismo patrón de "creación atómica vs. reversión suelta" que se
  encontró en `pos.js` (Hallazgo 6).
- Confirmar si algo lee la columna `cta_cte.importe` directo por REST antes
  de hacer el `DROP COLUMN` definitivo.
- Regenerar `docs/schema-snapshots/` desde la base real para que la Fase 1
  no arrastre falsos positivos/negativos.
