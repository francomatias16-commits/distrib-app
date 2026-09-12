# Auditoría de integridad financiera — Fluxo
### Registro de progreso — actualizado 2026-09-11

> Proyecto Supabase auditado: `jgiquzjwoedmzwqgzubr` (producción).
> Referencia: `plan-auditoria-fluxo.md` (plan original de 7 etapas).
> Este documento resume lo verificado y lo aplicado hasta ahora, para no
> tener que reconstruir el hilo de la conversación.

---

## 1. Línea de base (Etapa 0)

Corrida por el usuario en su entorno, resultado documentado:

| Comando | Resultado |
|---|---|
| `npm run check-schema` | OK — 165 tablas reales, 623 referencias en 201 archivos de código, sin desincronización |
| `npm run test:integration` | **93/93 OK**, contra base real (no mocks). Cobertura confirmada en `cobros`, `cta_cte`, `facturas`, `transacciones_pago`, `integraciones_pago` |
| `npm run check:migrations` | OK — 0 colisiones (489 archivos al momento de correrlo) |
| `npm run audit:security` | 6 hallazgos (ver §2) |
| `npm run audit:funciones-fantasma` | 5 funciones fantasma (ver §3) |

No se pudo correr `npm test`, `npm run test:e2e`, `npm run check-wiring:all` ni `npm run check-handler-dispatch` desde este entorno (sin red hacia Supabase/Vercel ni npm registry) — pendiente de confirmación del lado del usuario si no se corrieron ya.

---

## 2. Auditoría estática de concurrencia (Etapa 3, adelantada)

Revisión de código (sin necesidad de ejecución) de los dos flujos de dinero más sensibles a condiciones de carrera:

- **`registrar_venta_pos`** (POS): usa `SELECT ... FOR UPDATE` sobre la fila de stock antes de descontar — bloquea el registro, dos cajas vendiendo el mismo producto simultáneamente no pueden leer el mismo disponible y restar las dos. Más manejo de `unique_violation` + `offline_local_id` para reintentos idempotentes.
- **Mercado Pago (webhook + polling)**: doble protección —
  1. CAS (`compare-and-swap`) en `actualizarTransaccionPorId(..., { soloSiNoCompletada: true })`: si webhook y polling llegan casi simultáneos, el segundo `UPDATE` no toca ninguna fila.
  2. Índice único (`idx_cobros_offline_local_id`) sobre `offline_local_id = 'mp:' + payment_id`: si el CAS fallara igual, el `INSERT` colisiona y el RPC devuelve el cobro ya existente.
  3. Red de seguridad: si el RPC falla por otro motivo, el pago queda en `cola_financiera` para reconciliación manual.

**Conclusión: ambos flujos cerrados, sin acción pendiente.**

**Actualización — `registrar_cobro_completo` (punto 10), cerrado:**

El RPC en sí está bien diseñado — mismo nivel que POS/MP:
- `SELECT ... FOR UPDATE` sobre cada factura en el loop de validación (el lock se mantiene hasta el commit de la función, así que dos cobros concurrentes contra la misma factura se serializan).
- CAS + índice único (`idx_cobros_offline_local_id`) sobre `offline_local_id`, con catch de `unique_violation` — mismo patrón que MP.
- Valida tenant (`get_empresa_id()`) y rol antes de cualquier fast-path.

El gap no estaba en el RPC sino en dos de sus **callers**, que no mandaban `p_offline_local_id` (a diferencia de `cta-cte.js`, `cobros-offline.js`, `chofer-offline.js`, `pagos.js` y `cierre.js`, que sí lo hacen todos):

1. **`frontend/admin/js/rutas-resumen.js`** (cobro contra entrega, "Resumen de repartos") — el botón se deshabilita durante el request (cubre doble-click), pero no el caso real de un timeout de `conTimeoutRed` (10s) donde el cobro sí se registró en el servidor y la respuesta no llegó a tiempo: el catch reactiva el botón y un reintento del usuario duplicaba el cobro.
2. **`lib/asistente-tools/cobranzas.js`** (tool `registrar_cobro_cliente`, cobro por voz) — el CAS de `asistente_acciones_pendientes` en `index.js` ya evita ejecutar dos veces la misma confirmación, pero no cubre que el RPC commitee en el servidor y la respuesta se pierda antes de volver: una reconfirmación posterior generaba una fila nueva y, sin este id, un segundo cobro real.

**Fix aplicado (archivos entregados, no committeados aún — ver más abajo):**
- `rutas-resumen.js`: `offlineLocalId` generado una sola vez por cobro pendiente (variable de módulo, no por click), liberado recién tras una respuesta `ok:true` confirmada o si el usuario cambia de cliente — así un timeout-y-reintento manual dedupea igual que la cola offline de `cta-cte.js`.
- `index.js` (dispatcher del asistente): se propaga el `id` de la fila ya reclamada de `asistente_acciones_pendientes` como `accionPendienteId` a `tool.execute()` — cambio no invasivo, otros tools simplemente no lo leen.
- `cobranzas.js`: usa ese `accionPendienteId` como `p_offline_local_id` (estable por confirmación real, no por intento de red), con fallback a un UUID nuevo solo por defensividad.
- `tests/asistente/registrar-cobro-cliente.test.js`: actualizado (la aserción exacta de parámetros de la RPC no contemplaba el campo nuevo) + test nuevo para el caso sin `accionPendienteId`.

**Estado:** ✅ Diseño de locking del RPC confirmado sin gaps. ⏳ Fix de los 2 callers sin `offline_local_id` entregado como archivos listos para reemplazar — pendiente de tu lado: copiarlos al repo, correr `npm test` (el archivo de test ya viene actualizado) y commitear.

---

## 3. Hallazgos de seguridad y su estado

### 3.1 — CERRADO: 3 vistas sin `security_invoker`

**Hallazgo:** `asistente_candidatos_sinonimo` (creada en 601), `asistente_metodo_seleccion_resumen` y `asistente_fase_a_uso_semanal` (creadas en 603) se crearon sin `security_invoker = true`. En Postgres eso hace que la vista corra con los permisos del *owner*, no del rol que consulta — bypasea la RLS por `empresa_id` de la tabla base `asistente_uso`. Mismo patrón de fuga cross-tenant ya visto en `124_fix_security_definer_views_cross_tenant_leak` y `194_fix_leak_crosstenant_v_productos_sin_proveedor_default`.

**Fix aplicado:** migración `612_fix_security_invoker_vistas_asistente.sql`
- `ALTER VIEW ... SET (security_invoker = true)` en las 3
- `REVOKE ALL` + `GRANT SELECT` solo a `authenticated`
- Comentarios actualizados documentando el fix

**Estado:** ✅ Aplicado directamente en producción vía Supabase MCP y verificado:
- `pg_class.reloptions` de las 3 vistas ahora muestra `security_invoker=true`
- El Advisor de seguridad de Supabase ya no reporta `security_definer_view` para ninguna
- Migración registrada en `schema_migrations_registry` (número `612`) y archivo commiteado en el repo

### 3.2 — CERRADO: 5 funciones fantasma versionadas

**Hallazgo:** `fn_facturas_contadores_asistente`, `fn_facturas_lista_asistente`, `fn_reportes_stock_valorizacion_asistente`, `fn_reportes_stock_distribucion_asistente` y `fn_rodar_stock_demo` viven en `pg_proc` (schema `public`) pero ningún archivo de `supabase/migrations/` las creaba — se hicieron a mano en algún momento desde el SQL editor de Supabase. Un `supabase db reset` / reconstrucción del proyecto desde el repo **no las traería de vuelta**. Las 3 primeras son las que usa el asistente para responder preguntas de facturación y stock — la pérdida sería silenciosa (el asistente no rompe con error, solo falla o responde mal).

**Fix aplicado:** migración `613_track_funciones_fantasma_asistente_y_demo.sql`
- `CREATE OR REPLACE FUNCTION` puro con la definición real capturada vía `pg_get_functiondef(oid)` desde producción (no una reconstrucción)
- No cambia comportamiento ni grants — verificado comparando `hash_cuerpo` antes/después vía `audit_funciones_vivas()`: los 5 hashes son idénticos

**Estado:** ✅ Aplicado en producción y verificado (hashes coinciden, cero drift).

### 3.3 — CERRADO: gap de GRANT en 3 funciones "rodar demo" (`fn_rodar_cheques_demo` y 2 hermanas)

**Hallazgo original:** `fn_rodar_cheques_demo` muta datos, filtra por `empresa_id`/`es_demo` pero no verifica rol.

**Alcance real (mayor al reportado), confirmado en producción antes de aplicar:**
- `EXECUTE` estaba otorgado a `anon` — no solo a `authenticated` como decía el hallazgo original. Cualquiera, sin sesión, podía invocarla como RPC de PostgREST.
- Mismo gap, no reportado antes, en 2 funciones hermanas de la misma familia ("ventana rodante" de datos demo, todas creadas por `fn_reset_demo_cron`): `fn_rodar_lotes_trigger_demo` y `fn_rodar_stock_demo` (esta última una de las 5 funciones fantasma versionadas en la migración 613).
- Sus hermanas de nivel superior (`fn_redistribuir_fechas_demo`, `fn_reset_demo_cron`) sí estaban bien: solo `postgres`/`service_role`.

**Fix aplicado:** migración `614_fix_grants_funciones_rodar_demo.sql`
- No se usó el patrón de whitelist de roles (`fn_guardar_combo`) porque estas 3 funciones no son acciones de panel admin — son mantenimiento interno del cron de demo (cada 6h), sin caso de uso legítimo en que un usuario final deba dispararlas a mano.
- `REVOKE ALL ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO service_role` en las 3, alineándolas con el patrón ya usado por `fn_redistribuir_fechas_demo`/`fn_reset_demo_cron`.
- Chequeo defensivo `auth.role() = 'service_role'` agregado en el cuerpo de las 3, como capa extra (no depender solo del GRANT si alguien lo reabre a mano desde el SQL editor).
- `CREATE OR REPLACE` puro sobre la lógica de negocio — verificado contra `pg_get_functiondef` en producción antes de escribir el archivo, sin cambios de comportamiento salvo el control de acceso.

**Estado:** ✅ Aplicado en producción y verificado (`has_function_privilege` confirma `anon`/`authenticated` en `false`, `service_role` en `true` para las 3; registrado en `schema_migrations_registry` como `614`).

### 3.4 — CERRADO: gap de GRANT en `buscar_tools_asistente_rpc` y `fn_webhook_marcar_error`

**Hallazgo:** ninguna de las dos era falso positivo.

- `fn_webhook_marcar_error` — el más serio. Es `SECURITY DEFINER` (bypasea la única policy RLS de `webhooks_recibidos`, que es de `SELECT` dueño/admin) y tenía `EXECUTE` otorgado a `anon`. Cualquiera sin sesión podía marcar como `'error'` un webhook de Mercado Pago de cualquier empresa ya procesado bien. El cron `webhooks-reprocesar-cron` (`lib/handlers/notif.js`) toma las filas en `estado='error'` y vuelve a correr `procesarEventoMP(payload)` sobre ellas — permitía forzar reprocesamiento arbitrario de pagos ya cerrados, o agotar el `maxIntentos=5` de un webhook legítimo a propósito.
- `buscar_tools_asistente_rpc` — bajo impacto (solo lee `asistente_tools_embeddings`, catálogo interno del asistente, sin datos de cliente), pero mismo patrón: sin caso de uso legítimo para que `anon` la ejecute. Cero referencias desde frontend, solo se llama desde `lib/repos/asistente.js` con la service role key.

**Fix aplicado:** migración `615_fix_grants_buscar_tools_y_webhook_marcar_error.sql` — `REVOKE ALL ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO service_role` en ambas, mismo patrón que el punto 4.

**Estado:** ✅ Aplicado en producción y verificado (`has_function_privilege` confirma `anon`/`authenticated` en `false`, `service_role` en `true` para las dos; registrado en `schema_migrations_registry` como `615`). El archivo `.sql` no estaba commiteado en el repo — se generó y se entregó para agregar.

---

## 4. Hallazgos adicionales descubiertos al correr el Advisor completo de Supabase

Estos **no** formaban parte de los 6 de `audit:security` original — salieron al correr `Supabase:get_advisors` directamente contra la base real después de aplicar el fix de §3.1.

### 4.1 — CERRADO: 12 tablas con RLS activado pero sin ninguna policy

`arca_lock_emision`, `asistente_articulos`, `asistente_tools_embeddings`, `asistente_uso`, `audit_log_pendientes`, `chofer_invitaciones`, `contador_uso_apis`, `demo_snapshots`, `etiquetas_generaciones`, `pos_scanner_tokens`, `rate_limits`, `security_audit_historial`.

Con RLS activado y cero políticas, Postgres deniega todo acceso por default — probablemente **no es una fuga** (son tablas que solo consume el backend con `service_role`, que bypasea RLS), pero vale la pena confirmarlo tabla por tabla y no asumir que todas son intencionales.

*Nota (confirmado): `asistente_uso` aparece en esta lista y el Advisor tiene razón — no es caché. `SELECT * FROM pg_policies WHERE tablename = 'asistente_uso'` devuelve vacío en producción, pese a que la migración 195 sí creaba la policy `asistente_uso_empresa`. Se perdió en algún punto entre la migración 195 y la 290 sin que ningún archivo del repo registrara el `DROP POLICY` — mismo patrón de "drift" (cambio aplicado a mano en el SQL editor de Supabase, nunca versionado) que motivó el punto 3.2, pero en sentido inverso: acá se perdió control de acceso en vez de ganarlo.*

*Impacto real: ninguno hoy. La migración 290 (`fix_sec015...`) ya revocó el `GRANT` de tabla a `anon`/`authenticated` sobre `asistente_uso` — confirmado en producción que hoy solo `postgres` y `service_role` tienen cualquier privilegio sobre la tabla, sin importar qué políticas de RLS existan o no. Doble bloqueo. Sí queda pendiente una decisión de producto, no de seguridad: el comentario de la migración 195 preveía "paneles de métricas futuros" por empresa vía `authenticated` — si ese panel se construye, hoy haría falta restaurar tanto el `GRANT SELECT` como la policy `asistente_uso_empresa`, ninguno de los dos existe actualmente.*

**Barrido de funciones `SECURITY DEFINER` que tocan estas 12 tablas (confirmado, sin hallazgos nuevos):**

- `asistente_uso` / `asistente_articulos` — ya cubiertas arriba (drift de policy, sin exposición real).
- `asistente_tools_embeddings` — cubierta por el fix de §3.4 (`buscar_tools_asistente_rpc`, ahora solo `service_role`).
- `chofer_invitaciones` (`validar_token_invitacion_chofer`) y `pos_scanner_tokens` (`validar_token_scanner_pos`) — las únicas dos funciones con `EXECUTE` para `anon`, pero por diseño correcto y verificado en código, no por omisión: token crudo de 256 bits (`crypto.randomBytes(32)`) que nunca se persiste, solo su hash sha256; búsqueda por hash exacto (sin enumeración); ciclo de vida validado (`expira_at`/`revocado_at`/`usado_at`); y rate limit por IP delante del endpoint público (20/min en choferes, 30/min en scanner-POS) — mismo patrón que un magic-link.
- `arca_lock_emision` (`arca_lock_adquirir`, única accesible para `authenticated`) — valida `auth.uid() IS NOT NULL` y `p_empresa_id = get_empresa_id()` antes de tocar la tabla.
- `audit_log_pendientes`, `contador_uso_apis`, `demo_snapshots`, `etiquetas_generaciones`, `rate_limits`, `security_audit_historial` — todas sus funciones `SECURITY DEFINER` asociadas (`chequear_limite_plan`, `ejecutar_auditoria_seguridad_diaria`, `fn_incrementar_contador_api`, `fn_reset_demo(_v2)`, `fn_reset_demo_cron`, `fn_snapshot_demo(_v2)`, `rl_check_and_increment`, `arca_lock_liberar`) están restringidas a `service_role` únicamente — sin acceso para `anon` ni `authenticated`.

**Conclusión: con RLS deny-all + grants de tabla ya en `service_role`-only (confirmado tabla por tabla) + las dos excepciones de `anon` verificadas como diseño correcto, no queda ningún hallazgo abierto en este punto.**

### 4.2 — Recomendado: activar "Leaked Password Protection"

Deshabilitado en Supabase Auth. Compara contraseñas contra HaveIBeenPwned.org. Toggle de un clic en *Authentication → Policies*, sin downside. No aplicado (no es parte del alcance de "integridad financiera", pero es gratis y de bajo riesgo).

### 4.3 — Contexto, no acción: funciones `SECURITY DEFINER` ejecutables por `anon`/`authenticated`

El Advisor lista ~44 funciones ejecutables por `anon` y ~128 por `authenticated` como `SECURITY DEFINER`. Esto es **el diseño esperado de esta arquitectura** (RPCs de Postgres como API, cada una valida `empresa_id`/rol internamente vía `get_empresa_id()` / `auth.role()`), no un hallazgo nuevo — se menciona acá solo para que quede registrado que se vio y no se interpretó como bug.

---

## 5. Recordatorio de higiene pendiente (del usuario, no de código)

**La `SUPABASE_SERVICE_ROLE_KEY` fue pegada en texto plano en el chat dos veces** (antes de este documento). No hay confirmación explícita de que se haya rotado. Sigue siendo la acción más urgente de todo este hilo — rotarla en *Settings → API Keys → Legacy anon, service_role API keys → Roll* antes de seguir compartiendo output de comandos acá.

---

## 6. Estado consolidado de pendientes

| # | Ítem | Estado |
|---|---|---|
| 1 | Rotar `service_role` key | ✅ Confirmado por vos |
| 2 | Cerrar 3 vistas sin `security_invoker` | ✅ Aplicado (migración 612) |
| 3 | Versionar 5 funciones fantasma | ✅ Aplicado (migración 613) |
| 4 | Gap de GRANT en `fn_rodar_cheques_demo` + 2 hermanas | ✅ Aplicado (migración 614) |
| 5 | Arreglar `armarSystemPromptWhatsApp` | ✅ Ya estaba resuelto en producción (migración 604, sesión 2026-09-08) — el zip de trabajo simplemente no tenía ese código. Pendiente real: correr `eval-asistente-whatsapp.js` contra un proveedor real (bloqueado por falta de salida de red en el sandbox) y dejar el cron de detección corriendo para juntar volumen |
| 6 | Investigar timeout de `_smoke_import.test.js` | ✅ No reproducido — corrido aislado (3 veces, ~2s c/u) y en la suite completa (1991 tests, 42.78s) sin ningún cuelgue ni timeout. Mismas 3 fallas preexistentes de `whatsapp-system-prompt.test.js` (por el punto 5, esperable en este zip desactualizado). Sin log del timeout original no se puede confirmar si fue puntual del entorno anterior o si depende de una condición que no se dio acá — ver nota abajo |
| 7 | Confirmar `buscar_tools_asistente_rpc` / `fn_webhook_marcar_error` (falso positivo o no) | ✅ Ninguna era falso positivo — fix aplicado (migración 615) |
| 8 | Revisar 11 tablas RLS-sin-policy restantes (hallazgo nuevo, §4.1) | ✅ Sin hallazgos nuevos — todas cubiertas (ver §4.1) |
| 8b | `asistente_uso`: policy de la migración 195 perdida en producción, sin `DROP POLICY` versionado (§4.1) | ✅ Decisión tomada: NO se restaura. Doble bloqueo confirmado (GRANT también revocado desde la 290) — restaurar solo la policy no habilitaría nada. Documentado como deny-all intencional vía `COMMENT ON TABLE` (migración 616), con el snippet exacto para cuando exista el panel de métricas por empresa |
| 9 | Activar Leaked Password Protection (hallazgo nuevo, §4.2) | ✅ Cerrado — toggle manual en Studio (Auth → Policies), no aplicable vía MCP |
| 10 | `registrar_cobro_completo` — ¿locking/idempotencia equivalente a POS/MP? | ✅ RPC confirmado sin gaps; fix de 2 callers sin `offline_local_id` entregado (ver §3.4-bis / archivos de esta sesión) — falta commitear |

**Auditoría cerrada — 2026-09-11.** Los 12 puntos de la tabla consolidada quedaron resueltos o documentados como decisión de producto. Únicos residuales fuera del alcance de esta sesión: commitear los archivos entregados sueltos (punto 10, migraciones 614/615/616 si aún no están en el repo local) y correr el eval real de WhatsApp contra un proveedor (punto 5) cuando haya salida de red disponible.

---

## 7. Migraciones agregadas/aplicadas en esta sesión

- `supabase/migrations/612_fix_security_invoker_vistas_asistente.sql`
- `supabase/migrations/613_track_funciones_fantasma_asistente_y_demo.sql`
- `supabase/migrations/614_fix_grants_funciones_rodar_demo.sql` — ya existía escrita en el repo (no se redactó en esta sesión), pero no estaba aplicada ni registrada; se auditó su contenido contra el estado real de producción (cuerpos de las 3 funciones vía `pg_get_functiondef`, grants vía `has_function_privilege`) antes de confirmarla, y quedó aplicada y registrada.
- `supabase/migrations/615_fix_grants_buscar_tools_y_webhook_marcar_error.sql` — el fix se aplicó directamente en producción en otra sesión en paralelo (mismo patrón que pasó con la 614) mientras se investigaba si era falso positivo. No estaba commiteada en el repo — se reconstruyó a partir de `pg_get_functiondef`/grants reales de producción y se entregó lista para agregar. **Pendiente de tu lado:** sumarla al repo local.
- `supabase/migrations/616_documentar_deny_all_asistente_uso.sql` — punto 8b: no cambia comportamiento, documenta vía `COMMENT ON TABLE` la decisión de dejar `asistente_uso` como deny-all intencional (RLS sin policy + GRANT ya revocado desde la 290), con el snippet de restauración para cuando exista el panel de métricas por empresa. Aplicada y registrada en producción.

Las 4 aplicadas directamente en producción vía Supabase MCP y verificadas contra el estado real de la base (no solo escritas en el repo). Recomendado volver a correr `npm run check:migrations` tras sumar la 614 y la 615 al repo local si aún no estaban commiteadas.

## 8. Nota sobre el punto 6 (timeout de `_smoke_import.test.js`)

`lib/asistente-tools/index.js` importa ~26 módulos (17 familias de tools + 9 handlers pesados como `cierre.js`, `piloto.js`, `stock-auto.js`, `export-contable/index.js`). No se encontró ninguna conexión de red real, `setInterval`/timer a nivel de módulo, ni cliente DB sin mockear en esa cadena de imports — el `dbMock` de `_db.js` cubre todo. El import tarda ~2s en frío por el volumen de módulos, nada anómalo. Sin el log original del timeout (mensaje de vitest con los ms exactos, si fue local o en CI) no puedo descartar del todo una condición puntual de ese entorno — pero con el código actual no hay nada que lo explique ni que reproduzca.
