# v775 — Auditoría funcional etapa 6: resto de admin (config, usuarios/roles, automatización, reportes, superadmin)

Sigue a `PLAN_AUDITORIA_FUNCIONAL_PRELANZAMIENTO_2026.md` (v768), etapa 6,
la última del plan original.

## Actualización: acceso a Supabase real habilitado a mitad de sesión

La primera pasada de esta etapa se hizo sin acceso de red a Supabase (solo
a npm/GitHub) — de ahí que el hallazgo de migraciones faltantes haya
quedado documentado pero sin resolver. El usuario autorizó después el
acceso directo a su proyecto real (`jgiquzjwoedmzwqgzubr`, Supabase) vía
conector — con eso se cerró el hallazgo de reconciliación (ver abajo, ya
no está pendiente). El resto de los hallazgos de este documento (usuarios,
automatización, permisos, config, reportes, superadmin) sigue siendo
auditoría estática de código, sin cambios.

## Checks estáticos — todos OK

`check-migraciones-registro` (352 archivos, 0 colisiones), `smoke-test-frontend`
(78 páginas, 0 fallos), `check-asset-wiring` (1666 referencias, 0 rotas),
`check-api-wiring` (190 fetch / 144 rewrites / 40 módulos, 0 rotos),
`check-handler-dispatch` (95 combinaciones, 0 sin manejar).

## Hallazgo RESUELTO — 3 migraciones de producción faltantes en el repo (482, 483, 484)

Mismo patrón que el reconciliado en la etapa 5 (489-492). Con el acceso a
Supabase habilitado a mitad de sesión, se confirmó y cerró contra la base
real (`jgiquzjwoedmzwqgzubr`).

**Confirmado contra `supabase_migrations.schema_migrations`:**
- `482_fix_devolucion_pos_kardex_movimientos_stock` — SÍ está registrada
  (versión `20260816031950`), con el `statements` completo disponible.
- `484_fix_direccion_invalida_kardex_devolucion_y_anulacion_pos` — SÍ está
  registrada (versión `20260816033238`), también con `statements`
  completo.
- **`483` nunca quedó registrada como migración separada.** No aparece
  con ningún nombre ni número en `schema_migrations` — todo indica que se
  aplicó a mano desde el editor SQL de Supabase (o similar) sin pasar por
  la CLI de migraciones, así que nunca generó su propia fila de historial.

**Por qué no hace falta reconstruir un archivo 483 aparte:** el `CREATE OR
REPLACE FUNCTION anular_venta_pos` completo (con el fix de depósito real
que introdujo 483 originalmente) está recreado íntegro dentro de los
`statements` de la migración **484**, junto con el fix de dirección
(`'alta'` en vez de `'ingreso'`) y el backfill de las 2 anulaciones viejas.
O sea: el trabajo de 483 está 100% capturado y trackeado, solo que bajo el
número/nombre de 484. Reconstruir un archivo 483 por separado implicaría
inventar el contenido intermedio (con el bug de dirección todavía sin
corregir) — no aporta nada real y viola el mismo principio que evitó
tocar esto la primera vez: no adivinar contenido de funciones.

**Verificado además:**
- `pg_get_functiondef()` de `anular_venta_pos` y
  `rpc_registrar_devolucion_pos` en la base real: ambas usan
  `direccion = 'alta'` en el insert a `movimientos_stock_lotes` — correcto,
  coincide con `movimientos_stock_lotes_direccion_check` (`CHECK
  (direccion = ANY (ARRAY['consumo','alta']))`).
- `anular_venta_pos` resuelve el depósito desde el movimiento de egreso
  original (`movimientos_stock` tipo `'egreso'`), con fallback a
  `cajas_pos.deposito_id` solo si no hay movimiento — tal cual describe el
  changelog v769.
- Ambas funciones aparecen en `audit_funciones_vivas()` (vivas en
  `public`), sin abrir un hallazgo nuevo de función fantasma.

**Fix aplicado (solo en el repo, sin tocar producción — la base ya estaba
correcta):**
- `supabase/migrations/482_fix_devolucion_pos_kardex_movimientos_stock.sql`
  — reconstruida byte a byte desde `schema_migrations.statements`.
- `supabase/migrations/484_fix_direccion_invalida_kardex_devolucion_y_anulacion_pos.sql`
  — reconstruida byte a byte desde `schema_migrations.statements`, incluye
  el backfill.
- `check-migraciones-registro` corrido de nuevo tras agregar los 2
  archivos: 354 archivos, 0 colisiones.

Gap cerrado. No quedó pendiente ningún trabajo adicional de este
hallazgo.

## Usuarios y roles (`lib/handlers/usuarios.js`) — revisado, sin hallazgos nuevos

Jerarquía dueño/admin, protección del último dueño activo de la empresa
(tanto en PATCH como en DELETE), rollback del usuario de Auth si falla el
insert en la tabla `usuarios`, baneo/desbaneo de Auth al activar/desactivar
para cortar sesiones. Ya tiene documentados y aplicados los fixes de la
etapa 11 de `AUDITORIA_2026` (protección de admin-contra-admin en PATCH y
en DELETE). No se encontró nada nuevo.

## Automatización (`lib/reglas-automatizacion.js` + `lib/handlers/automatizacion.js`) — revisado, sin hallazgos nuevos

Motor de reglas fail-closed (condición mal armada u operador desconocido
nunca dispara una acción), los 6 "motores" del panel (piloto, cierre,
rutas, stock, score, auditoría) consistentes contra los valores reales de
`estado`/`score_categoria` que usan sus funciones/tablas de origen. Ya
tiene documentados y aplicados los fixes AUTOMATIZACION-001/002 (no se
hacía pasar por el cron interno al ejecutar un motor a mano, y sí se
chequea `r.ok` del motor downstream) y el fix de seguridad v323
(whitelist de columna en `push-prefs`, que sin esto permitía a un
dueño/admin de cualquier empresa pisar su propio `empresa_id` hacia el de
otro tenant al usar el cliente `service_role`).

## `lib/permisos-service.js` — revisado, consistente

Tabla centralizada de permisos (Fase 7). Confirmé que los módulos que ya
migraron a este servicio (`reglas_automatizacion`, `tareas_automatizacion`,
`empresa_config`, entre otros) efectivamente importan `puede()` en vez de
mantener un array `ROLES_*` propio en paralelo — sin drift entre la tabla
y el handler real. Los que siguen con su propio array (`usuarios.js`,
`migracion.js`, `chofer_invitacion.js`, `portal_proveedor.js`,
`pagos.js`) están documentados a propósito como fuera de este servicio
(jerarquía rol-actor-vs-rol-objetivo en `usuarios.js`, o reexportados con
mayor blast radius) — no es un olvido, es una decisión ya explicada en el
comentario de cabecera del archivo.

## Config de empresa (`lib/handlers/empresa.js`) — revisado, sin hallazgos nuevos

Logo (subida + URL firmada, no pública, desde el fix del bucket privado
v741), ícono con fallback estático, datos editables (CUIT validado a 11
dígitos, email con formato, catálogo público como toggle sobre `config`
jsonb con read-modify-write). Gateado con `puede(perfil, 'acceder',
'empresa_config')` en los 4 endpoints. Sin hallazgos.

## Reportes (ventas/financieros/stock) — revisado, sin hallazgos nuevos

Comparé los valores de `estado` que usan `reportes-ventas.js` y
`reportes-financieros.js` (`'entregado'` para pedidos, `'completada'` para
`ventas_pos`) contra lo que realmente escriben `lib/facturas.js` y la
función `registrar_venta_pos` (migración 468) — coinciden. No apareció el
patrón de bug típico de esta auditoría (comparar contra un valor de
`estado`/constraint que ya no existe). Confirmé también que la nueva
terminal de pago Prisma (v762-763) es solo un método de cobro con tarjeta
— no cambia la tabla ni los valores de `estado` de `ventas_pos`, así que
no afecta a estos reportes.

## Superadmin (`lib/handlers/saas.js`) — revisado, sin hallazgos nuevos

Gate server-side de superadmin ya corregido desde v220 (antes aceptaba a
cualquier `dueno`, sin importar la empresa — incluida la demo pública).
`fn_reset_demo_v2` tiene guard explícito contra resetear cualquier empresa
que no tenga `es_demo = true`, incluso si se le pasa `empresa_id` a mano.
Sin hallazgos.

## Actualización — `reportes-stock.js` y rentabilidad (producto/vendedor, zona) cerrados (v776)

Con Supabase en vivo ya habilitado, se completó la revisión pendiente de
`reportes-stock.js` y de las dos páginas de rentabilidad. Detalle completo,
hallazgos y fixes en `CHANGELOG_v776_etapa6_cierre_reportes_stock.md`.
Resumen:

- **Rentabilidad por producto/vendedor y por zona**: revisadas
  (`v_rentabilidad_producto`/`v_rentabilidad_vendedor` de la 246,
  `v_rentabilidad_zona_ruta` de la 069) — consumidas correctamente solo
  desde `lib/handlers/rutas-live.js` + `lib/repos/rutas.js` con
  `service_role` y filtro por `empresa_id`, gateadas a
  `dueno/admin/contador`. Sin hallazgos.
- **`reportes-stock.js`**: 3 hallazgos, los 3 resueltos:
  1. `fn_reportes_stock_criticos_lista` (ya creada en la 441, nunca
     wireada) ahora sí la llama `cargarProductosCriticos()` — la tabla de
     críticos usaba antes un `cantidad < 10` fijo, desalineado del
     `stock_minimo` real que ya usa el KPI de la misma pantalla.
  2. Columna "Depósito" de Movimientos de Stock mostraba el texto literal
     `Depósito` en vez del nombre real — corregido resolviendo contra
     `_depositosList`.
  3. `cargarValorizacion()` traía toda la tabla `stock` sin paginar (mismo
     patrón ya corregido en Estado de Stock/Críticos, pero que había
     quedado afuera) — ahora usa la nueva RPC
     `fn_reportes_stock_valorizacion` (migración 494, aplicada contra
     `jgiquzjwoedmzwqgzubr`).

Con esto la etapa 6 queda cerrada por completo (config, usuarios,
automatización, permisos, empresa, reportes ventas/financieros/stock,
superadmin, rentabilidad producto/vendedor/zona). Quedan afuera —porque
nunca estuvieron dentro del alcance de esta etapa, no por pendientes—
`auditoria.html`/`anomalias.html` más allá del wiring ya chequeado, y el
resto de páginas admin (clientes, proveedores, cheques, lotes,
fidelización, etc.), que corresponden a otras etapas del plan.
