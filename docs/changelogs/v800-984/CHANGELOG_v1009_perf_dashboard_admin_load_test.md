# v1009 — Fixes de performance en dashboard admin, a partir de load test contra prod (2026-08-29)

## Contexto

`scripts/load-test.js` corrido contra producción con 30 conexiones concurrentes
detectó tres endpoints del panel admin degradándose bajo carga:

| Endpoint | Síntoma bajo 30 conexiones |
|---|---|
| `/api/admin/dashboard-ejecutivo` | 0.6 req/s, 100% timeouts |
| `/api/admin/stock/bajo` | 8.1 req/s, p99 9582ms |
| `/api/admin/resumen-arranque` | p99 9760ms |
| `/api/admin/comparativa-mensual` | p99 8881ms (umbral: 5000ms) |

## Cambios

**`lib/repos/admin.js` / `lib/handlers/admin.js`** — sin cambio de contrato de
respuesta en ningún endpoint; se movió trabajo de JS a SQL y se agregaron
índices.

**Migraciones nuevas (4):**

1. **`460_perf_indices_ventas_pos_pedidos.sql`** — `ventas_pos` solo tenía
   índice por `empresa_id`; `obtener_comparativa_mensual()` filtra además
   por `estado` + `created_at`, sin índice que cubra ese patrón. Agrega
   `idx_ventas_pos_empresa_estado_created` con `CREATE INDEX CONCURRENTLY`
   (evita lock exclusivo sobre tabla con escritura constante en prod).

2. **`461_perf_scope_empresa_dashboard_ejecutivo.sql`** — causa raíz del
   100% de timeouts: `obtener_dashboard_ejecutivo_resumen()` filtraba por
   `empresa_id` recién en el SELECT final; las CTEs internas de
   `v_cobranza_priorizada` y `v_rentabilidad_zona_ruta` agregaban datos de
   **todas** las empresas del SaaS antes de poder filtrar. Cada llamada
   recalculaba a escala de toda la plataforma, no de la empresa que abrió
   el panel — empeoraba con el crecimiento de otras empresas, no de la
   propia. Fix: reescribe solo `obtener_dashboard_ejecutivo_resumen()` para
   empujar el filtro de `empresa_id` adentro de cada CTE desde el arranque.
   No toca las vistas compartidas (las usan `/api/score` y otras pantallas
   sin el mismo problema en este load test).

3. **`462_perf_stock_agregado_en_sql.sql`** — `handleStockBajo` y
   `handleResumenArranque` traían TODAS las filas de `stock`×`productos`
   de la empresa vía `.select()` y agrupaban/filtraban en JS
   (`obtenerStockConProductos`/`obtenerStockValorizado` en
   `lib/repos/admin.js`). Nueva función SQL `obtener_stock_bajo()` agrega y
   filtra en la base, devuelve el JSON ya armado con las mismas claves que
   esperaba el handler — sin tocar el contrato del frontend.

4. **`463_fix_null_distancia_km_rentabilidad.sql`** — hallado validando el
   aislamiento por empresa de la migración 461 contra datos reales
   (Litoral): `entregas.distancia_km` puede ser `NULL` (entregas viejas).
   `v_rentabilidad_zona_ruta` (069/450) y la nueva
   `obtener_dashboard_ejecutivo_resumen` (461) hacían
   `SUM(me.distancia_km)` sin `COALESCE` — una sola fila `NULL` volvía
   `NULL` toda la suma del grupo, y con eso `margen_neto_estimado` y
   `margen_neto_por_km`, aunque hubiera margen bruto real facturado. Bug
   preexistente desde 069, no regresión de 461. Fix:
   `COALESCE(e.distancia_km, 0)` en el CTE `margen_entrega`, en las dos
   definiciones a la vez. Verificado contra Litoral (margen_neto_total pasó
   de 0 enmascarado a 3890, facturado_total sin cambios) y Maribel (se
   mantuvo en cero absoluto — el aislamiento por empresa no se vio
   afectado).

## Deploy

- Suite completa corrida en local antes del deploy: 76 archivos / 1208
  tests, sin fallas relacionadas al cambio.
- Deploy vía `vercel --prod` (deploy directo, no pasó por GitHub — branch
  protection + CI ["predeploy + test", 1192 tests] no se disparó; los
  tests se corrieron a mano para cubrir ese hueco).
- Sanity check post-deploy contra los 3 endpoints, dos llamadas seguidas
  por endpoint para confirmar el caché de 30s:

| Endpoint | 1ra llamada | 2da llamada |
|---|---|---|
| `resumen-arranque` | 9.33s | 0.16s |
| `dashboard-ejecutivo` | 0.17s | 0.18s |
| `comparativa-mensual` | 0.17s | 0.17s |

  `resumen-arranque` mostró la mejora esperada por caché (57x). Los otros
  dos ya respondían rápido desde la primera llamada — no hay salto visible
  porque el fix de las migraciones 461/462 bajó el tiempo sin caché a un
  rango donde la diferencia con caché no se nota, pero el caché sigue
  activo y sigue evitando la carga repetida a Supabase.

## Pendiente

- `git add -A && git commit -m "..." && git push` — el deploy fue directo
  por CLI, el fix todavía no está en el repo.
