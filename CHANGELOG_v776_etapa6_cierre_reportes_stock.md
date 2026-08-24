# v776 — Etapa 6: cierre de `reportes-stock.js` y verificación de rentabilidad (producto/vendedor/zona)

Sigue a `CHANGELOGS_INTEGRACION/CHANGELOG_v775_auditoria_etapa6_admin_config_usuarios_reportes.md`,
que dejó documentado como pendiente real (sin acceso a Supabase en ese
momento de la sesión) revisar en profundidad `reportes-stock.js` y las
páginas de rentabilidad. Con el conector a Supabase (`jgiquzjwoedmzwqgzubr`)
ya habilitado, se completó esa revisión.

## Rentabilidad por producto/vendedor (`rentabilidad-producto-vendedor.html`) — revisado, sin hallazgos

- Vistas `v_rentabilidad_producto` / `v_rentabilidad_vendedor` (migración
  246): combinan pedidos entregados (`estado='entregado'`, usando
  `cantidad_entregada` con fallback a `cantidad`) y ventas de mostrador POS
  (`ventas_pos.estado='completada'`) — cubre las dos fuentes de venta.
- Consumidas exclusivamente desde `lib/handlers/rutas-live.js`
  (`accion=rentabilidad-producto|rentabilidad-vendedor`) vía
  `lib/repos/rutas.js`, con cliente `service_role` y `.eq('empresa_id', ...)`
  aplicado en el repo — coherente con el patrón de seguridad ya usado por
  `v_rentabilidad_zona_ruta` (vistas `SECURITY DEFINER`-like sin RLS propio,
  nunca expuestas directo a PostgREST/browser).
- Gate de rol (`dueno`, `admin`, `contador`) aplicado tanto en el handler
  como en el frontend.
- Cálculo de `margen_pct` en frontend consistente en las 4 vistas
  (resumen, tabla, export) — división protegida contra `facturado === 0`.

## Rentabilidad por zona (`rentabilidad-zona.html`) — revisado, sin hallazgos

- Mismo patrón de seguridad que la de producto/vendedor
  (`v_rentabilidad_zona_ruta`, migración 069, consumida vía
  `listarRentabilidadZonaRuta` con `service_role` + filtro por
  `empresa_id`).
- Sin hallazgos nuevos.

## `reportes-stock.js` — 3 hallazgos, los 3 resueltos

### 1. `fn_reportes_stock_criticos_lista` existía en producción desde la migración 441 pero el frontend nunca la llamaba

La migración `441_fix_reportes_stock_criticos_activo_y_lista_real.sql`
(reconstruida retroactivamente en su momento, ver ese archivo) ya había
creado `fn_reportes_stock_criticos_lista()` específicamente para reemplazar
el query cliente `stock.cantidad < 10` y usar el criterio real
(`stock_minimo` por producto, con piso de 5 si no tiene uno configurado —
mismo patrón que `stock.js`/`lib/handlers/automatizacion.js`). Se confirmó
contra la base real (`jgiquzjwoedmzwqgzubr`) que la función existe con la
firma `(p_deposito_id uuid, p_categoria_id uuid, p_limit integer, p_offset
integer)`.

**Bug real que esto causaba:** la tabla "Productos con Stock Crítico" y el
KPI "Stock Crítico" de la misma pantalla (que sí usa el criterio real vía
`fn_reportes_stock_kpis`) podían mostrar números distintos — un producto
con `stock_minimo` configurado por encima de 10 no aparecía en la tabla
aunque el KPI sí lo contara como crítico.

**Fix:** `cargarProductosCriticos()` en `frontend/admin/js/reportes-stock.js`
ahora llama `fn_reportes_stock_criticos_lista` con los mismos filtros de
depósito/categoría que ya usa `cargarEstadoStock()`, paginado server-side
con `p_limit`/`p_offset`. La columna "Stock Mínimo" ya no muestra "10"
fijo — muestra el `stock_minimo` real devuelto por la RPC.

### 2. Columna "Depósito" de "Movimientos de Stock" mostraba el texto literal `Depósito`

En `cargarMovimientos()`, cada fila renderizaba `<td>Depósito</td>` — texto
fijo, no interpolado — en vez del nombre real del depósito. El dato
(`deposito_id`) ya venía en el `select()`, y `_depositosList` ya estaba
cacheada en memoria por `cargarDepositos()` (que corre antes en el
`DOMContentLoaded`).

**Fix:** se resuelve `deposito_id` contra `_depositosList`, mismo patrón
que ya se usaba dos líneas más arriba para `producto` y `usuario`.

### 3. `cargarValorizacion()` traía toda la tabla `stock` sin paginar

Mismo cuello de botella que ya se había identificado y corregido (según
los propios comentarios del archivo) para "Estado de Stock" y "Productos
Críticos" en este mismo archivo — pero había quedado afuera de esa pasada.
Traía `stock` completo (sin `.range()` ni límite) más todos los
`depositos`, para agrupar y sumar en JS.

**Fix:** nueva RPC `fn_reportes_stock_valorizacion()` (migración `494`,
mismo patrón que `fn_reportes_stock_distribucion` de la 200), que agrupa
por depósito y suma en SQL. Aplicada contra la base real
(`jgiquzjwoedmzwqgzubr`) con `apply_migration`, verificada su existencia
con `pg_proc`, y `REVOKE ALL ... FROM PUBLIC, anon` + `GRANT EXECUTE ...
TO authenticated, service_role` igual que sus pares. Registrada en
`supabase/migrations/494_fn_reportes_stock_valorizacion.sql` y en
`schema_migrations_registry`.

## Verificación post-cambio

- `node --check frontend/admin/js/reportes-stock.js` → sin errores de
  sintaxis.
- `check-migraciones-registro`: 355 archivos (354 + la nueva 494),
  0 colisiones.
- `check-api-wiring`: 190 fetch / 144 rewrites / 40 módulos, 0 rotos (sin
  cambios de endpoints — los 3 fixes son RPC/query dentro del mismo
  handler ya cableado).

## Checks de seguridad en vivo (etapa 5 — ahora re-corridos contra la base real)

Con el conector a Supabase ya habilitado, se volvieron a correr en vivo los
checks que en la etapa 5 se habían hecho a mano (por auditoría estática de
código, sin acceso a la base en ese momento):

### `audit_security_definer_grants()` — 6 `riesgo_potencial=true`, los 6 falsos positivos verificados

El heurístico de la función marca como riesgo toda `SECURITY DEFINER` con
`EXECUTE` a `anon`/`authenticated` que no detecta un filtro por
`empresa_id` en el cuerpo. Se inspeccionó `pg_get_functiondef()` de las 6:

- `auth_usuario_id`, `auth_usuario_rol`, `es_admin`, `es_chofer`: sin
  parámetros, solo devuelven datos del propio usuario autenticado
  (`WHERE id = auth.uid()`) — no cruzan tenants, no necesitan filtro de
  `empresa_id` porque están atadas a la sesión de quien llama.
- `chofer_clientes_ids`: mismo patrón, acotada a
  `r.chofer_id = auth.uid()` — el chofer solo ve sus propios clientes de
  ruta.
- `get_saas_panel_admin`: intencionalmente sin filtro de tenant (panel
  superadmin, ve todas las empresas), pero gateada con
  `IF NOT public.is_saas_owner() THEN RAISE EXCEPTION` — el heurístico no
  reconoce ese patrón de gate-con-excepción, solo busca filtro por
  `empresa_id` en el cuerpo.

Las 265 funciones restantes de `audit_security_definer_grants()`
(incluidas `fn_reportes_stock_criticos_lista` y
`fn_reportes_stock_valorizacion`, ambas `parece_filtrar_por_tenant=true`)
sin `riesgo_potencial`. Sin hallazgos nuevos de seguridad.

### `audit_views_security_invoker()` — 0 `riesgo_potencial=true`

18 vistas auditadas, ninguna marcada como riesgo. `v_rentabilidad_producto`
/ `v_rentabilidad_vendedor` / `v_rentabilidad_zona_ruta` aparecen con
`security_invoker=true` — dato informativo, no contradice lo documentado
en las migraciones 246/069 (que dicen "SIN security_invoker"): el flag de
la vista es `true`, pero como corren con `SECURITY DEFINER` heredado del
rol de conexión (`service_role` desde el backend, nunca expuestas directo
a PostgREST/browser), no hay RLS de por medio que security_invoker pudiera
activar — no es una discrepancia real, solo una precisión sobre qué
controla ese flag.

### `audit_funciones_vivas()` — 265 funciones vivas en `public`, sin fantasmas nuevos

Confirmado que `fn_reportes_stock_criticos_lista` y
`fn_reportes_stock_valorizacion` (la nueva de esta sesión) están
registradas como funciones vivas reales en el schema — no quedaron
huérfanas ni con nombre/firma inconsistente.

## Estado de la etapa 6

Con esto queda cerrado el único pendiente real que había dejado el v775.
La etapa 6 (config, usuarios/roles, automatización, permisos, empresa,
reportes ventas/financieros/stock, superadmin, rentabilidad
producto/vendedor/zona) queda completa. Fuera de alcance de esta etapa
(no pendiente, sino nunca incluido): `auditoria.html`/`anomalias.html` más
allá del wiring ya chequeado, y páginas admin de otras etapas (clientes,
proveedores, cheques, lotes, fidelización, etc.).
