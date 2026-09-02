# CHANGELOG v816 — Auditoría Integral 2026: SEC-04, SEC-09, SYNC-06, SYNC-07, SYNC-08

**Migración:** `supabase/migrations/20260818_sync06_eventos_negocio_claim_atomico_outbox.sql`
**Alcance:** 5 de los hallazgos ALTA pendientes tras v815 (SEC-01/02). Quedan pendientes: SEC-03, SEC-06 a SEC-14, BUG-01 a BUG-11, SYNC-01 a 05, SYNC-09.

## SEC-04 — API key de Gemini filtrable en logs de error

**Antes:** `lib/asistente-providers.js:fetchConTimeout` armaba el mensaje de error de un HTTP no-ok con la URL completa (`HTTP ${res.status} de ${url}: ...`). Para Gemini, `url` incluye `?key=${apiKey}` en texto plano. Ese `error.message` se propaga sin modificar hasta `lib/handlers/asistente.js:670` (`console.error('[asistente] Error:', error?.message ?? error)`), así que cualquier falla HTTP de Gemini (cuota agotada, 4xx, 5xx) dejaba la API key en logs/telemetría.

**Ahora:** el mensaje de error solo incluye origen + path (`u.origin + u.pathname`), nunca el query string. Aplica parejo a los 3 proveedores (Groq/OpenRouter no llevan secretos en la URL, pero se sanea igual). El resto de la cadena (`retry.js`, `responderConFallback`, el catch de `asistente.js`) ya quedaba cubierta porque todos reenvían `error.message`, no reconstruyen su propio mensaje.

## SEC-09 — Refresh de sesión: carrera no atómica y sin revalidar usuario activo

**Antes:** `handleRefresh` (`lib/handlers/auth.js`) hacía `SELECT` del refresh token, chequeaba `revocado` en memoria, y recién después un `UPDATE` separado para marcarlo usado. Dos refresh concurrentes con la misma cookie podían pasar el chequeo los dos antes de que cualquiera alcanzara a marcarlo, y emitir dos pares de tokens válidos. Tampoco se revisaba `usuarios.activo` ni `empresas.activa/saas_suspendida` antes de emitir el par nuevo — un usuario desactivado (o empresa suspendida) después del login podía seguir renovando indefinidamente mientras tuviera un refresh token vigente. El payload del nuevo JWT además arrastraba el `rol` viejo del token, no el vigente en base.

**Ahora:**
- Consumo atómico: `UPDATE refresh_tokens SET revocado=true WHERE token_hash=... AND revocado=false RETURNING id, usuario_id`. Solo una request puede "ganar" esa fila.
- Si no matchea ninguna fila (ya usado/replay o carrera perdida), se revoca el resto de la sesión de ese usuario por las dudas — mismo criterio de seguridad que ya existía para el caso "token revocado".
- Antes de emitir el par nuevo: se relee `usuarios.activo` y, si tiene `empresa_id`, `empresas.activa`/`saas_suspendida`. Si el usuario está inactivo o la empresa suspendida, se limpian cookies y se responde 403.
- El nuevo JWT usa el `rol` vigente en base (`usuarioActual.rol`), no el que traía el token viejo.

## SYNC-06 — Despachador de eventos sin claim atómico ni reintento durable

**Antes:** `despacharPendientes` (`lib/eventos-dispatcher.js`) leía eventos `pendiente`/`error` con un `SELECT` y los procesaba en un loop, sin ningún claim. Dos barridos concurrentes (dos requests que disparan el despacho inmediato casi al mismo tiempo) podían leer y ejecutar el mismo evento dos veces. No había límite de reintentos ni lease: un evento en `error` se reintentaba para siempre (con `incluirErrores=true`) o nunca (sin ese flag), sin punto intermedio.

**Ahora (migración + código):**
- Nuevo estado `procesando` en el CHECK de `eventos_negocio.estado`, más columnas `intentos`, `procesando_desde`, `ultimo_error`.
- `reclamarEventos()` hace el claim con un `UPDATE ... WHERE id=X AND estado=<estado leído>` por fila — si otro barrido ya se lo llevó, esta actualización no afecta filas y se descarta el candidato.
- Eventos `procesando` cuyo lease venció (2 minutos — el despacho es síncrono e inmediato, nunca debería tardar más) vuelven a ser candidatos, para el caso de un worker caído a mitad de camino.
- Tope de 5 intentos (`EVENTOS_MAX_INTENTOS`): pasado ese número, un evento en `error` queda como dead-letter y `despacharPendientes(incluirErrores=true)` deja de recogerlo.
- `despacharEvento` ahora persiste `intentos` y `ultimo_error` (truncado a 500 chars) además de `estado`/`procesado_en`.

**No resuelto a propósito:** el `INSERT` inicial en `eventos_negocio` (`emitirEvento`, fire-and-forget con `.catch(console.error)`) sigue sin reintento durable — retenerlo de forma durable requeriría otra cola por detrás de esa misma inserción, un problema circular que no se ataca en este lote. El riesgo residual es bajo (falla de INSERT contra Supabase es un caso raro) pero queda anotado para no dar la falsa impresión de que el outbox es 100% a prueba de fallos en el punto de entrada.

## SYNC-07 — Cobro de Mercado Pago sin cola durable cuando falla el registro en cta_cte

**Antes:** en `lib/handlers/pagos.js`, tanto el webhook de MP (`manejarWebhook`) como el polling desde el cliente (`verificarPago`) confirman el pedido como pagado y después llaman a `registrarCobroCompletoRpc`. Si esa RPC fallaba (`errorCobro || !cobro?.ok`), lo único que pasaba era un `console.error('...RECUPERACIÓN MANUAL...')` — sin ninguna cola detrás, dependía de que alguien viera el log y reconciliara a mano. El pedido quedaba confirmado como pagado pero sin el débito correspondiente en `cta_cte`.

**Ahora:** se reusa `cola_financiera` (la tabla y el motor de reintento que ya existía para `asiento_factura`/`asiento_nc`/`vinculo_venta_factura`/`nc_cae_reconciliacion` — no se creó ninguna cola nueva):
- `lib/handlers/pagos.js` (los 2 puntos, webhook y polling): si `registrarCobroCompletoRpc` falla, además del log existente se encola una tarea `cobro_mp_reconciliacion` vía `FacturasRepo.encolarConciliacionFinanciera`, con el mismo `offline_local_id` (`mp:${payment_id}`) que ya se había intentado.
- `lib/handlers/cierre.js`: nuevo tipo `cobro_mp_reconciliacion` en el dispatch de `procesarConciliacionFinanciera` — reintenta `registrarCobroCompletoRpc` con el mismo `offline_local_id`. Como esa RPC dedupea por ese campo contra un índice único, el reintento nunca puede duplicar el cobro, sea cual sea el motivo del fallo original.
- Hereda gratis el resto del motor ya existente: backoff exponencial, tope de 4 intentos antes de `dead_letter`, el cron con `CRON_SECRET`, y la tool de chat `consultar_cola_financiera_pendiente`/`ejecutar_cierre_financiero_pendiente` para que dueño/admin vean y disparen el reproceso manualmente.



**Antes:** `marcarInvitacionUsada` (`lib/repos/chofer-invitacion.js`) hacía `UPDATE ... SET usado_at=now() WHERE id=X`, sin condición `usado_at IS NULL`, y se llamaba al final de `handlePublico` (`lib/handlers/chofer_invitacion.js`), después de ya haber creado/actualizado el usuario en Auth. `validarTokenPublico` (una lectura, vía RPC) solo confirmaba el estado en el momento de leer — dos activaciones concurrentes con el mismo link podían pasarla las dos antes de que cualquiera marcara nada, y las dos ejecutar los efectos sobre Auth.

**Ahora:**
- Nueva `intentarConsumirInvitacion(invitacion_id)`: `UPDATE ... WHERE id=X AND usado_at IS NULL RETURNING id`. Se llama **antes** de tocar Auth/perfil, no después. Si no matchea fila (ya usada), se responde 410 sin ejecutar ningún efecto.
- Nueva `liberarInvitacion(invitacion_id)` (revierte `usado_at` a `null`): se llama en el `catch` si algo falla después de haber "ganado" la carrera, para que el mismo link se pueda reintentar en vez de quedar inservible por un error transitorio (contraseña rechazada por Auth, etc.). Los rollbacks que ya existían más abajo (ej. borrar el usuario Auth si falla `insertarUsuarioChofer`) no se tocaron — esto solo libera el token en sí.

## Validación

- `node --check` sobre los 8 archivos `.js` tocados (incluye `lib/handlers/pagos.js` y `lib/handlers/cierre.js` de SYNC-07): OK.
- No se aplicó la migración contra ningún Supabase todavía — queda para correr contra QA/producción como con SEC-01/02/05.
- No se ejecutaron los tests del proyecto (Vitest) en este entorno — no se copiaron `node_modules` ni se instalaron dependencias acá; recomendado correr la suite de `auth`/`eventos`/`chofer-invitacion`/`pagos`/`cierre` antes de mergear.
- SYNC-07 se apoya en que `cola_financiera` ya existe en producción (creada por el track de remediación de la Auditoría Funcional Pre-Lanzamiento, hallazgo FAC-004) con las columnas `empresa_id, tipo, referencia_id, estado, intentos, proximo_intento, payload, error_msg, created_at, updated_at` y un índice único sobre `(referencia_id, tipo, estado)` — confirmado leyendo el uso real en `lib/repos/facturas.js`/`lib/repos/cierre.js`/`lib/handlers/cierre.js` de este mismo zip, no adivinado. Si esa tabla no existe todavía en el entorno donde se aplique este zip, `cobro_mp_reconciliacion` fallará igual que fallarían hoy `asiento_factura`/`asiento_nc` — no es una dependencia nueva que este lote introduzca.

## Qué sigue

Con esto, de los 5 hallazgos que quedaban pendientes de la sesión anterior (SEC-04, SEC-09, SYNC-06, SYNC-07, SYNC-08) no queda ninguno abierto. Lo que sigue de la Auditoría Integral 2026 es el resto de la matriz: SEC-03, SEC-06 a SEC-14, BUG-01 a BUG-11, SYNC-01 a 05, SYNC-09.
