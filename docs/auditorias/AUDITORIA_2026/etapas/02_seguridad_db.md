# Etapa 2 — Seguridad de base de datos (Supabase)

**Estado:** 🟡 En progreso (funciones SECURITY DEFINER: todos los dominios de negocio cubiertos; falta cerrar RLS de tablas sensibles y grants) · **Última actualización:** 2026-07-11 (sesión 2)
**Fuente:** Supabase Advisors (linter oficial) + inspección manual de código fuente de funciones vía `pg_get_functiondef`.

## 2.1 Resultado del Security Advisor (linter automático de Supabase)

| Categoría | Cantidad | Severidad linter |
|-----------|----------|-------------------|
| RLS habilitado sin políticas | 3 tablas | INFO |
| `search_path` mutable en función | 1 función | WARN |
| Extensión instalada en `public` | 2 (`pg_trgm`, `vector`) | WARN |
| Funciones `SECURITY DEFINER` ejecutables por `anon` | ~45 | WARN |
| Funciones `SECURITY DEFINER` ejecutables por `authenticated` | ~45 | WARN |
| Protección de contraseñas filtradas deshabilitada | 1 (Auth) | WARN |

Evidencia cruda guardada en `AUDITORIA_2026/evidencia/advisors_security_resumen.json`.

## 2.2 RLS — cobertura general

✅ **Muy buena noticia:** las 103 tablas de `public` tienen RLS **habilitado**. Cobertura 100%. Esto es el punto de partida correcto — la mayoría de los SaaS multi-tenant fallan justo acá.

Distribución de políticas por tabla:
- 3 tablas con **0 políticas** → deniegan todo acceso vía API REST (solo `service_role` puede tocarlas): `asistente_articulos`, `asistente_uso`, `demo_snapshots`. **Por confirmar:** si esto es intencional (tablas de uso interno del backend) o un bug que rompe alguna función del asistente/demo.
- Resto: entre 1 y 5 políticas por tabla, según necesiten distinguir SELECT/INSERT/UPDATE/DELETE y roles (admin/vendedor/chofer/cliente).

**Pendiente:** revisar el *contenido* de las políticas (no solo que existan) para las tablas más sensibles: `cta_cte`, `facturas`, `usuarios`, `empresas`, `clientes`, `tokens_wsaa`, `internal_secrets`, `refresh_tokens`. Es decir, confirmar que el `USING`/`WITH CHECK` realmente aísla por `empresa_id` y no tiene agujeros (ej. `USING (true)`).

## 2.3 Funciones `SECURITY DEFINER` expuestas — verificación manual

El advisor marca como riesgo que cualquier función `SECURITY DEFINER` sea invocable directamente vía `/rest/v1/rpc/<nombre>`, incluso por `anon`. Esto **no es automáticamente una vulnerabilidad** si la función valida autorización en su primera línea — pero si no la valida, es un bypass total del control de acceso de la aplicación.

### Verificadas (9 de ~90) — con el código fuente real inspeccionado:

| Función | Chequeo interno encontrado | Veredicto |
|---------|------------------------------|-----------|
| `ajustar_stock` | `get_rol_usuario() IN ('admin','dueno','depositero') AND get_empresa_id() = v_empresa_id` | ✅ OK |
| `anular_venta_pos` | `auth.role() <> 'service_role' AND empresa_id = get_empresa_id()` | ✅ OK |
| `cancelar_pedido` (2 firmas) | filtra `WHERE ... AND empresa_id = get_empresa_id()` en el `SELECT FOR UPDATE` | ✅ OK |
| `crear_orden_compra` | `PERFORM assert_empresa_access(p_empresa_id)` | ✅ OK |
| `registrar_cobro` | delega a `registrar_cobro_completo` (no verificada aún) | 🟡 Verificar la delegada |
| `registrar_movimiento_cta_cte` | `PERFORM assert_empresa_access(p_empresa_id)` | ✅ OK |
| `registrar_venta_pos` | `auth.role() <> 'service_role' AND p_empresa_id = get_empresa_id()` | ✅ OK |
| `saas_confirmar_pago` | `auth.role() <> 'service_role' AND NOT is_saas_owner()` → `RAISE EXCEPTION` | ✅ OK |
| `saas_tenant_cambiar_plan` | usa `get_empresa_id()` interno (no confía en parámetro), valida `rol IN ('dueno','admin')` | ✅ OK |

**Nota de diseño observada:** el patrón `get_empresa_id()`/`get_rol_usuario()` son también `SECURITY DEFINER` y dependen de `auth.uid()`. Para un usuario anónimo (`anon`, sin JWT), `auth.uid()` es `NULL`, por lo que estas funciones devuelven `NULL`, y las comparaciones `NULL = uuid` son `false` → el flujo cae en "sin autorización". Es decir, el patrón **falla cerrado** correctamente en los casos revisados. Buena señal, pero falta confirmarlo en el resto.

### Segundo lote verificado (24 funciones más)

| Función | Chequeo interno | Veredicto |
|---------|------------------|-----------|
| `aplicar_nota_credito_cta_cte` | empresa_id == get_empresa_id() | ✅ OK |
| `asentar_movimiento_cta_cte_factura` | valida empresa después de obtener la factura | ✅ OK |
| `cliente_productos_disponibles` | **ninguno** — recibe `p_empresa_id` y lo usa sin validar que el caller pertenezca a esa empresa | 🟠 **Hallazgo MEDIO** (ver 2.5) |
| `confirmar_pedido`, `confirmar_pedido_sugerido`, `marcar_preparado` | filtran por `empresa_id = get_empresa_id()` | ✅ OK |
| `emitir_nota_cta_cte`, `generar_pedido_sugerido_cliente`, `generar_pedidos_sugeridos` | valida empresa | ✅ OK |
| `fn_cobranzas_facturas/kpis`, `fn_cta_cte_kpis/lista` | usan `get_empresa_id()` interno, ignoran cualquier parámetro externo | ✅ OK |
| `get_carrito_cliente` | valida que `auth.uid()` sea dueño del `cliente_id` vía tabla `usuarios` | ✅ OK |
| `registrar_cobro_completo` | valida empresa. Nota: `p_usuario_id` puede ser sobreescrito por el caller (ver 2.5, hallazgo bajo) | ✅ OK con nota |
| `acreditar_puntos`, `canjear_puntos`, `crear_nota_credito`, `desactivar_oferta_liquidacion` | validan empresa | ✅ OK |
| `fn_cheques_lista/contadores`, `fn_riesgo_cheques_lista` | usan `get_empresa_id()` interno | ✅ OK |
| `fn_facturas_lista`, `fn_notas_credito_lista`, `fn_notas_lista`, `fn_pedidos_lista`, `fn_productos_lista`, `fn_puntos_lista` | usan `get_empresa_id()` interno; `fn_productos_lista` además usa whitelist de columnas para el `ORDER BY` dinámico (buena práctica anti-inyección) | ✅ OK |
| `get_saas_panel_admin` | valida `is_saas_owner()` | ✅ OK |
| `onboarding_empresa(empresa_uuid)` | **ninguno** — cualquier usuario autenticado puede pasar el UUID de otra empresa | 🟠 **Hallazgo MEDIO** (ver 2.5) |
| `recepcionar_orden_compra` | valida empresa | ✅ OK |
| `registrar_empresa_saas` | valida explícitamente `p_usuario_id = auth.uid()` (comentario en el código indica que esto fue un fix de seguridad previo — bien documentado) | ✅ OK |
| `reservar_remito_nro` | valida empresa | ✅ OK |
| `rpc_registrar_devolucion_pos` | **ninguno** — obtiene `empresa_id` de la venta pero nunca lo compara contra `get_empresa_id()` del caller | 🔴 **Hallazgo ALTO** (ver 2.5) |
| `setup_inicial_empresa` | solo permite ejecutarse si `count(empresas) = 0` (bootstrap de instancia única) — probablemente código legado de antes del modelo multi-tenant, ver si sigue siendo necesario | 🟡 Revisar vigencia |
| `validar_token_portal_proveedor` | diseñada para ser pública — el control de acceso es el token (valida hash, `revocado_at`, `expira_at`) | ✅ OK por diseño |

## 2.5 Hallazgos nuevos de esta ronda

### ✅ CORREGIDO (2026-07-11) — `rpc_registrar_devolucion_pos` sin aislamiento por empresa
**Severidad original: ALTA.**
La función obtenía `v_empresa_id` a partir de la venta (`SELECT empresa_id FROM ventas_pos WHERE id = p_venta_pos_id`) pero **no validaba** que ese `empresa_id` coincidiera con el de quien llama.

**Impacto que tenía:** cualquier usuario autenticado del sistema (de cualquier empresa cliente del SaaS) podía invocar `POST /rest/v1/rpc/rpc_registrar_devolucion_pos` con el `id` de una venta POS de **otra empresa**, y el sistema procesaba la devolución: sumaba stock a un depósito ajeno y creaba un registro de devolución con montos, alterando datos financieros y de inventario de un tercero.

**Verificación previa a corregir:** se confirmó que `lib/handlers/pos.js` (backend) sí validaba la pertenencia de la venta a la empresa antes de llamar al RPC — pero esa protección vivía solo en la capa de aplicación. Se confirmó además que el frontend (`frontend/admin/js/pedidos.js`) llama RPCs de Supabase directamente en otros flujos, lo que demuestra que el patrón de bypasear el backend y pegarle directo a Supabase con la clave pública + JWT de sesión es viable en este proyecto. Por lo tanto la función en la base de datos necesitaba su propio control, independiente del backend.

**Corrección aplicada:** migración `fix_sec006_aislamiento_empresa_devolucion_pos`, agrega:
```sql
IF auth.role() <> 'service_role' AND v_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
  RAISE EXCEPTION 'No autorizado';
END IF;
```
mismo patrón que ya usa `anular_venta_pos`. Verificado post-aplicación que la función contiene el chequeo. No se modificó ninguna otra lógica de la función.

### 🟠 MEDIO (pendiente) — `onboarding_empresa(empresa_uuid)` sin validación de pertenencia
Solo valida que la empresa exista, no que el caller pertenezca a ella. Un usuario autenticado de la Empresa A podría invocarla con el UUID de la Empresa B. El impacto es acotado (crea depósito/lista de precios/zona/categoría "default" solo si no existen — no borra ni expone datos), pero **es una escritura no autorizada entre tenants** y debería corregirse con el mismo patrón (`assert_empresa_access(empresa_uuid)` ya existe en el código y se usa en otras funciones).

### 🟠 MEDIO — `cliente_productos_disponibles(p_empresa_id, ...)` sin validar el tenant del caller
Devuelve el catálogo completo (nombre, precio, stock disponible) de **cualquier `empresa_id` que se le pase**, sin verificar que el usuario (o `anon`) tenga relación con esa empresa. Si el modelo de negocio es que el catálogo de pedidos por WhatsApp/portal cliente es semi-público (el cliente final no necesariamente está autenticado como "usuario" del sistema), esto podría ser **intencional**. Pero tal como está, permite que cualquiera enumere UUIDs de empresa y extraiga el catálogo completo con precios y stock de cualquier cliente del SaaS — competidores podrían scrapear precios de otros distribuidores que usan la plataforma.
**Acción sugerida:** confirmar con el dueño del producto si el catálogo debe ser público por diseño (portal de pedidos sin login) — si sí, está bien así pero conviene documentarlo explícitamente como decisión de diseño; si no, agregar validación de token/sesión de cliente como hace `get_carrito_cliente`.

### 🟡 BAJO — patrón repetido de "usuario_id espejo" en varias funciones
`anular_venta_pos`, `registrar_cobro_completo`, `recepcionar_orden_compra` y `rpc_registrar_devolucion_pos` reciben `p_usuario_id`/`p_admin_user_id` como parámetro y lo usan tal cual para dejar constancia en la auditoría (`usuario_id` en movimientos, cobros, etc.) en lugar de forzar `auth.uid()`. Esto no permite escalar privilegios, pero sí **falsificar el registro de auditoría** (atribuir una acción a otro usuario). Sugerencia: reemplazar por `auth.uid()` directamente (como ya hace `ajustar_stock`), salvo en los casos donde `service_role` necesite especificar el usuario en nombre de quien actúa (webhooks, cron).

### Tercer lote verificado (2026-07-11, sesión 2) — todos los dominios pendientes

Se completó la verificación de los dominios que quedaban pendientes: cta. corriente/notas/cobros, pedidos/carrito/portal cliente, compras/proveedores, fidelización, cheques/riesgo, notas de crédito/débito, listados `fn_*_lista`, y — el hallazgo grande de esta sesión — **el módulo completo del wizard de migración**.

| Función | Chequeo interno | Veredicto |
|---------|------------------|-----------|
| `aplicar_nota_credito_cta_cte`, `asentar_movimiento_cta_cte_factura`, `emitir_nota_cta_cte`, `registrar_cobro_completo` | validan `empresa_id` contra `get_empresa_id()` | ✅ OK |
| `fn_cobranzas_facturas`, `fn_cobranzas_kpis`, `fn_cta_cte_kpis`, `fn_cta_cte_lista` | usan `get_empresa_id()` interno | ✅ OK |
| `confirmar_pedido`, `confirmar_pedido_sugerido`, `marcar_preparado` | filtran por `empresa_id = get_empresa_id()` | ✅ OK |
| `generar_pedido_sugerido_cliente`, `generar_pedidos_sugeridos` | validan `empresa_id` / usan `assert_empresa_access` | ✅ OK |
| `get_carrito_cliente` | valida que `auth.uid()` sea dueño del `cliente_id` | ✅ OK |
| `recepcionar_orden_compra` | valida empresa (nota: `p_usuario_id` espejo, ver SEC-009) | ✅ OK con nota |
| `validar_token_portal_proveedor` | pública por diseño, control por hash+expiración | ✅ OK por diseño |
| `acreditar_puntos`, `canjear_puntos` | validan empresa | ✅ OK |
| `fn_cheques_lista`, `fn_cheques_contadores`, `fn_riesgo_cheques_lista` | usan `get_empresa_id()` interno | ✅ OK |
| `crear_nota_credito`, `fn_notas_credito_lista`, `fn_notas_lista` | validan/usan `get_empresa_id()` | ✅ OK |
| `fn_pedidos_lista`, `fn_productos_lista`, `fn_facturas_lista`, `fn_puntos_lista` | usan `get_empresa_id()` interno | ✅ OK |
| `desactivar_oferta_liquidacion`, `reservar_remito_nro` | validan empresa | ✅ OK |
| `fn_cierre_financiero_entrega` | trigger, deriva `empresa_id` del join (no de parámetro) | ✅ OK |

### 🔴 SEC-010 (CORREGIDO 2026-07-11) — Módulo `migracion_*` sin aislamiento por empresa en 18 de 32 funciones

Este módulo (wizard de migración de datos para onboarding de clientes) **no había sido auditado en sesiones anteriores** — es la superficie más grande encontrada hasta ahora en una sola pasada.

**Patrón del bug:** a diferencia del resto del código (que consistentemente usa `IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM get_empresa_id() THEN RAISE EXCEPTION`), estas 18 funciones recibían `p_empresa_id` como parámetro y lo usaban directo en INSERT/UPDATE/DELETE sin comparar contra el `get_empresa_id()` del caller. Un usuario autenticado de la Empresa A podía invocarlas con el `empresa_id` de la Empresa B.

**Funciones afectadas y su impacto (todas corregidas):**
- `migracion_deshacer_sesion` — 🔴 la más grave: permite **DELETE** de clientes, productos, pedidos, cta_cte, proveedores, órdenes de compra, lotes, cheques, ventas POS, categorías, depósitos, listas de precios, zonas, etc. de otra empresa.
- `migracion_confirmar_cheques_lote`, `migracion_confirmar_pedidos_lote`, `migracion_confirmar_lotes_lote`, `migracion_confirmar_cta_cte_lote`, `migracion_confirmar_comprobantes_historicos_lote`, `migracion_confirmar_direcciones_lote`, `migracion_confirmar_ordenes_compra_lote`, `migracion_confirmar_pagos_proveedores_lote`, `migracion_confirmar_precios_cliente_lote`, `migracion_confirmar_proveedores_lote`, `migracion_confirmar_puntos_lote`, `migracion_confirmar_ventas_pos_lote`, `migracion_confirmar_maestro_lote` — 🔴 permiten INSERT/UPDATE de datos financieros y comerciales en otra empresa (cheques falsos, pedidos, movimientos de cta_cte, pagos a proveedores, puntos de fidelización, etc.)
- `migracion_resolver_zona`, `migracion_resolver_deposito`, `migracion_resolver_proveedor`, `migracion_resolver_lista_precio` — 🟠 permiten crear registros maestros (zonas/depósitos/proveedores/listas) en otra empresa vía el flujo de "resolver o crear si no existe".
- `migracion_mapear_bulk` — 🟠 permite sobreescribir `datos_mapeados`/`entidad_existente_id` de filas de staging de **cualquier sesión de cualquier empresa** sin validar dueño de la sesión; es la puerta de entrada que alimenta a los `confirmar_*_lote` de arriba.
- `migracion_precheck_advertencias` — 🟡 escritura de advertencias (campo informativo) sin validar caller, solo que `sesion_id` + `empresa_id` combinen.
- `migracion_resolver_vendedor` — 🟡 de solo lectura, pero permite enumerar UUIDs de vendedores de otra empresa por nombre/email.

**Corrección aplicada:** 4 migraciones (`fix_sec010_lote1` a `lote4`) agregan el chequeo estándar del proyecto a las 18 funciones, sin modificar ninguna otra lógica. `migracion_mapear_bulk` se convirtió de `LANGUAGE sql` a `plpgsql` porque el chequeo con `RAISE EXCEPTION` requiere control de flujo; ahora deriva el `empresa_id` de la sesión (`migracion_sesiones.empresa_id`) en vez de confiar en un parámetro — patrón más seguro aún que el resto del código, igual al que ya usaba `migracion_confirmar_sesion`. `migracion_purgar_staging_antiguo` (sin parámetro `empresa_id`, es un job de limpieza) se restringió a `auth.role() = 'service_role'` porque no tiene sentido que un usuario final la invoque por RPC.

**Verificación post-fix:** confirmado con `pg_get_functiondef` sobre las 32 funciones `migracion_*` que las 18 corregidas contienen el chequeo, y que los 4 helpers de puro formateo de texto (sin `empresa_id` ni acceso a tablas) no lo necesitan. `get_advisors` no reportó nada roto.

## Pendientes de verificar
Con esta sesión se completaron todos los dominios listados anteriormente (cta. corriente, pedidos/carrito, compras, fidelización, cheques, notas, listados `fn_*_lista`, administración/SaaS, y el módulo `migracion_*` completo). Quedan pendientes de una revisión explícita:
- `setup_inicial_empresa` — ya señalado como código legado del modelo de instancia única (antes de multi-tenant); confirmar si sigue siendo necesario o se puede retirar.
- Funciones auxiliares de negocio no cubiertas explícitamente en los lotes de arriba si aparecen nuevas en el schema (recomendable correr un query de `pg_proc` filtrando `prosecdef = true` y diff contra lo ya verificado antes de dar la Etapa 2 por 100% completa).

**Criterio de revisión para cada una:** ¿la función usa `get_empresa_id()`/`auth.uid()` internamente para determinar el tenant/usuario, o confía ciegamente en un parámetro `p_empresa_id`/`p_usuario_id` que el cliente puede falsificar? Ese es el único patrón de vulnerabilidad real acá — y es exactamente lo que causó SEC-006, SEC-007 y SEC-010.

## 2.4 Otros hallazgos del linter (menor severidad, fixes rápidos)

- **`fn_cheques_sync_vencimiento`**: sin `SET search_path`. Riesgo: si alguien pudiera crear objetos en un schema que precede a `public` en el `search_path` de la sesión, podría hacer que la función resuelva a un objeto malicioso. Fix: agregar `SET search_path = public` a la definición (mismo patrón que ya usan casi todas las demás funciones del sistema).
- **Extensiones `pg_trgm` y `vector` en `public`**: recomendación de Supabase es moverlas a un schema `extensions` dedicado. Riesgo real bajo, es más una buena práctica de higiene.
- **Leaked password protection deshabilitada**: Supabase Auth puede rechazar contraseñas que aparecen en brechas conocidas (HaveIBeenPwned). Está apagado. Es un toggle en el dashboard de Supabase Auth, sin costo de implementación.

## Pendiente en esta etapa
- [ ] Verificar las ~80 funciones restantes (listado arriba, agrupado por dominio)
- [ ] Revisar contenido real de políticas RLS en las 10 tablas más sensibles (no solo que existan)
- [ ] Confirmar intención de las 3 tablas sin políticas
- [ ] Revisar `grants` (permisos GRANT/REVOKE) — ya existe `scripts/audit-security-grants.js` en el repo, correrlo y cotejar
- [ ] Revisar `internal_secrets` y `tokens_wsaa` en detalle — son las tablas más sensibles del sistema (secretos de integración, certificados AFIP)
