# CHANGELOG v770-771 — Auditoría funcional Etapa 2 (Pedidos + Facturación AFIP/ARCA + Cobros/cta-cte): 5 hallazgos

**Fecha:** 2026-08-16
**Contexto:** Etapa 2 del plan de auditoría funcional pre-lanzamiento
(`PLAN_AUDITORIA_FUNCIONAL_PRELANZAMIENTO_2026.md`), arrancada tras el
cierre de la etapa 1 (POS, v769). Documenta 3 migraciones que ya estaban
aplicadas en Supabase sin changelog.

## PEDIDOS-AUDIT-01 — `cancelar_pedido` (migración 485)

Al cancelar un pedido confirmado, la función liberaba el stock reservado
buscando el depósito con `ORDER BY es_principal DESC LIMIT 1` — es decir,
siempre prefería el depósito principal si tenía stock del producto — en
vez de usar el depósito real donde `confirmar_pedido()` había hecho la
reserva.

**Por qué importa:** `confirmar_pedido()` prueba primero el depósito
principal y, si no alcanza, cae a un depósito secundario. Con al menos una
empresa ya operando con más de un depósito activo, cancelar un pedido
reservado en el secundario dejaba esa reserva huérfana para siempre — el
disponible de ese depósito quedaba reducido de forma permanente. Además,
`liberar_stock_reservado` usa `GREATEST(0, ...)` sin validar, así que
podía descontar sin avisar la reserva del depósito principal si tenía
otras reservas activas de otros pedidos.

**Fix:** el depósito de liberación ahora se toma del movimiento de reserva
original (`movimientos_stock` tipo `'reserva'`, `referencia_id` = pedido),
mismo patrón usado en la migración 483 (POS). Fallback a la heurística
vieja solo para pedidos legado sin movimiento de reserva registrado.

## FACTURACION-AUDIT-01 — `registrar_cobro_completo` (migración 486)

Una factura que pasó por estado `'parcial'` en algún momento quedaba
trabada en `'parcial'` para siempre, aunque un cobro posterior la saldara
por completo. La lógica original era "si con este pago se termina de
saldar, no tocar el estado" — pero si el estado ya era `'parcial'` antes
de ese pago, "no tocar" significaba que nunca volvía a `'emitida'`.

**Impacto:** no corrompía los totales de deuda (todo lo que calcula
`pendiente = total - total_cobrado` seguía bien), pero el badge de estado
en Facturación mostraba "parcial" en una factura 100% cobrada, y las
queries `estado IN (emitida, parcial)` seguían trayendo facturas ya
saldadas indefinidamente. Se confirmó contra producción que ninguna
factura existente estaba afectada (`estado='parcial' AND total_cobrado >=
total` no dio resultados) — no hizo falta backfill, el fix solo previene
el problema hacia adelante.

**Fix:** cuando el pago salda la factura y el estado actual era
`'parcial'`, se la vuelve a `'emitida'`.

## ARCA-AUDIT-01 — `emitirComprobanteARCA` / `emitirNotaCreditoARCA` (migración 487)

Ambas funciones calculan el próximo número de comprobante
(`nroCbte = ultimoNro + 1`) consultando `FECompUltimoAutorizado` a la
AFIP — una llamada externa, sin lock en la base. Si dos facturas (o dos
notas de crédito) del mismo punto de venta + tipo de comprobante se
emiten casi en simultáneo (dos pedidos confirmándose a la vez, ambos
disparando el listener `pedido_creado`, o un doble-click), ambas podían
leer el mismo `ultimoNro` y pedir CAE con el mismo número.

**Fix:** se implementó un lock por fila (`arca_lock_emision`) con clave
`(empresa_id, punto_venta, tipo_cbte)` — mismo criterio que usa AFIP para
numerar, así que facturas y notas de crédito nunca se bloquean entre sí
innecesariamente, pero dos facturas del mismo tipo sí se serializan. El
cliente Supabase acá es supabase-js sobre PostgREST (sin conexión
persistente por request), por lo que un `pg_advisory_lock` de sesión no
serviría de forma confiable — de ahí el lock por fila con detección de
lock "stale" (de un proceso que crasheó a mitad de camino y nunca lo
liberó).

## CTACTE-AUDIT-01 — `obtenerUltimoSaldo` en `lib/repos/cta-cte.js`

Leía la columna por-fila `cta_cte.saldo` (fila más reciente por `fecha`),
asumiendo un modelo de "saldo corrido" que ningún flujo real mantiene:
`registrar_venta_pos` (mig. 468), `registrar_cobro_completo` (mig. 486) y
`aplicar_nota_credito_cta_cte` (mig. 315) insertan sin completar esa
columna, que queda NULL. Solo `insertarEnCtaCte()` (cierre.js) la
completaba a mano. Como POS/cobros/NC son mucho más frecuentes que el
cierre de pedidos sin facturación electrónica, en la práctica la fila más
reciente de casi cualquier cliente tenía `saldo = NULL` → la función
devolvía 0.

**Impacto:** `procesarNotifVencimiento()` en `cierre.js` usa este valor
para decidir si manda el recordatorio de vencimiento (`if (deuda <= 0)
return`) — el recordatorio se salteaba en silencio para la mayoría de los
clientes con deuda real. No afectaba el límite de crédito en POS/pedidos
ni el saldo mostrado en admin/portal cliente, porque esos leen
`clientes.saldo_deuda` — columna aparte, mantenida por el trigger
`sync_saldo_deuda_cliente` (mig. 078/409/452), que suma todos los
movimientos por tipo en cada insert/update/delete de `cta_cte` sin
depender de la columna `saldo`.

**Fix:** `obtenerUltimoSaldo` ahora lee `clientes.saldo_deuda` directo, la
fuente ya correcta y siempre sincronizada, en vez de reconstruir un
"saldo corrido" que ningún flujo mantiene. Cambio en código de aplicación
(`lib/repos/cta-cte.js`), sin migración de base necesaria.

## NOTASCTACTE-AUDIT-01 — `fn_notas_lista` (migración 488)

La pantalla "Notas" (crédito/débito, `frontend/admin/js/notas.js`)
llama a `fn_notas_lista`, que devolvía `cc.importe` — columna de
`cta_cte` **deprecada desde 2026-07-03** ("ningún RPC la escribe más",
según el comment de la propia columna en Supabase). `emitir_nota_cta_cte`
sí inserta correctamente en `monto`, pero la lista mostraba el importe en
blanco/null para toda nota de crédito/débito emitida desde esa fecha.

Verificado en vivo contra la única nota de crédito real en producción:
`monto=2400.00`, `importe=NULL` antes del fix; después del fix,
`fn_notas_lista` devuelve `importe=2400.00` correctamente.

**Fix:** `fn_notas_lista` ahora selecciona `cc.monto AS importe` — se
mantiene el nombre de columna de salida `importe` para no romper el
contrato con `notas.js`, que ya lee `n.importe`.

## Verificado sin hallazgos
- **`emitir_nota_cta_cte`** — inserta correctamente en `monto` (no en la
  columna deprecada); permisos EXECUTE confirmados en vivo: `authenticated`
  puede ejecutarlo, `anon` no, `service_role` sí (el `REVOKE` de la
  migración 142 fue revertido en algún punto posterior).
- **`anular_nota_cta_cte`** (migración 452) — chequeo de rol
  (dueno/admin/contador) y de tenant correctos, patrón de anulación
  lógica (soft-delete con `anulado`) consistente con `anular_venta_pos`,
  trigger `sync_saldo_deuda_cliente` excluye filas anuladas del cálculo.

## Migraciones aplicadas
- `485_fix_cancelar_pedido_deposito_real_reserva`
- `486_fix_registrar_cobro_completo_estado_parcial_stuck`
- `487_arca_lock_emision_concurrencia`
- `488_fix_fn_notas_lista_columna_importe_deprecada`

## Cierre de la etapa 2
Con pedidos, facturación/ARCA (numeración y cobro) y cta-cte/notas de
crédito-débito revisados, la etapa 2 del plan de auditoría queda cerrada.
5 hallazgos reales corregidos y aplicados en Supabase (485-488, más el fix
de código en `cta-cte.js`). Sigue la etapa 3: Mercado Pago + conciliación
bancaria + gastos generales.
