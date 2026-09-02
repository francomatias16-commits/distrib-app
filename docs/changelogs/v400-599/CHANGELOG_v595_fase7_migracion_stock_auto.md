# v595 — Fase 7, orden de migración pedido por el usuario: `stock-auto` — CERRADO

Cuarto módulo del lote: `stock-auto.js` (14 `.from()`/`.rpc()` directos —
un poco más que la estimación de 13). Es el handler de REQ-4, Stock Vivo
con Reposición Autónoma: análisis de stock (manual, cron, y vía RPC
`analizar_stock_autonomo`), generación automática de órdenes de compra
agrupadas por proveedor, alertas de stock (crítico/quiebre/sin proveedor)
y envío de la orden por email al proveedor.

## Qué se hizo

**`lib/repos/stock-auto.js` (nuevo)** — 12 funciones:

- `listarEmpresasActivas` (para el batch del cron).
- `analizarStockAutonomoRpc` (envuelve la única RPC del handler; se llama
  desde dos puntos con política de error distinta — vista previa la
  propaga, `analizarYGenerarOrdenes` no — así que la función devuelve
  `{ data, error }` tal cual y cada caller decide).
- `listarAlertasStockActivas`, `resolverAlertaStock`.
- `buscarOrdenRecienteProveedor` (chequeo de idempotencia — no duplicar
  una OC auto-generada si ya hay una reciente en curso).
- `insertarOrdenCompraAuto` (devuelve `{ data, error }` — el handler
  original valida `errOC || !orden` explícitamente, se mantuvo igual).
- `insertarItemsOrdenCompra`, `upsertAlertasStock` (compartida entre el
  flujo con proveedor y `alertarSinProveedor` — mismo upsert idempotente
  por `producto_id,tipo,resuelta` en los dos lugares del original).
- `obtenerOrdenParaEnviar`, `listarItemsOrdenCompra`, `marcarOrdenEnviada`,
  `marcarAlertasResueltasPorOrden` (usadas por `aprobarYEnviarOrden`).

**`lib/repos/index.js`** — se agregó `StockAutoRepo` al barrel.

**`lib/handlers/stock-auto.js`** — los 14 `.from()`/`.rpc()` directos
originales pasan por el repo de arriba, sin cambio de comportamiento
observable. Política de error replicada tal cual: silenciosa en la
mayoría (el original solo controlaba error explícitamente en
`vista-previa` y en `alertas`, y chequeaba `errOC` al insertar la orden
auto-generada); el resto se mantiene igual que antes — confía en los
defaults/`if (!x)` del handler.

`sb` (el cliente Supabase directo) sigue vivo en el handler solo para
`verificarToken(req, sb)` y para pasárselo a `notifAuto(sb, ...)`
(`lib/handlers/_auto-push.js`) — es un helper de push compartido por
~10 handlers de automatización, no propio de `stock-auto.js`; migrarlo
queda fuera de alcance de este paso, mismo criterio que el bucket de
Storage en `portal_proveedor.js`.

No hubo hallazgo de seguridad para corregir en este módulo — las queries
que necesitaban `empresa_id` ya lo filtraban de forma consistente en el
original.

## Verificación

- `grep -c "\.from(\|\.rpc("` en `lib/handlers/stock-auto.js`: 0. Cero
  accesos directos a tablas/RPCs de negocio.
- Sintaxis válida (`node --check`) en handler y repo.
- Tests nuevos: `tests/repos/stock-auto.test.js` (15 casos — no existía
  cobertura de repo para este módulo). Foco en los filtros de aislamiento,
  la idempotencia (orden reciente, upsert con `onConflict`), y la columna
  correcta (`orden_id` con FK real, no la huérfana `orden_compra_id`, en
  `listarItemsOrdenCompra` — el comentario `FIX` del handler original se
  preservó).
- Suite completa corrida de verdad en este entorno (con `node_modules`
  instalado): **779/785 OK**. Las 6 fallas restantes son las mismas
  preexistentes y no relacionadas de siempre
  (`tests/handlers/admin-permisos.test.js`, falta de credenciales reales
  de Supabase en este sandbox) — sin regresión.

## Próximo paso

Sigue `maestros` (13 usos), según el orden pedido. Después: `chofer_invitacion`
(12), `usuarios` (9), y el puñado chico.
