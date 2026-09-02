# CHANGELOG v821 — Auditoría Integral 2026: cierre de los 11 hallazgos restantes (BUG-05 a BUG-11, BUG-03, SYNC-02, SYNC-04, SYNC-09)

**Fuente de los hallazgos:** `Matriz de hallazgos — Auditoría Integral 2026.md` (misma fuente que v820).

**Alcance de este lote:** los 11 hallazgos que quedaban pendientes tras v820 (que había cerrado SEC-11, SEC-12, SEC-13, BUG-04). Con este lote se cierran los 15 hallazgos MEDIA de la matriz post-v816.

---

## Cerrado en este lote

### BUG-10 — Upload de foto de remito en background sin validar status
`frontend/admin/js/compras.js:1002-1018`. Se disparaba después del OCR, en paralelo, sin validar `status` ni informar fallo.
**Fix:** nuevo helper de estado explícito con reintento junto a `_mostrarMiniatura`; la UI ahora muestra si la foto se subió, falló o está subiendo, y permite reintentar sin repetir el OCR/recepción.

### BUG-05 — Botón de checkout no se restaura tras fallo
`frontend/cliente/checkout.html:421-447`. Tras fallo de red o `ok=false` al confirmar pedido, el botón quedaba `disabled` sin restaurar el texto.
**Fix:** pantalla de error del checkout ahora tiene botón "Reintentar" propio (reusa la clase real `btn-confirmar` y el texto original), y el flujo de confirmación queda en un estado consistente ante error de red o `ok=false`.

### BUG-06 — Error de cta-cte se veía como "sin movimientos"
`frontend/admin/js/cta-cte.js:328-338,371-398`. Un error REST al cargar movimientos se transformaba en lista vacía.
**Fix:** `abrirCliente`/`renderPanelBody` ahora diferencian `error` de `vacío` explícitamente — el usuario ve un mensaje de error real, no "Sin movimientos registrados", cuando la carga falló.

### BUG-07 — Cancelación de ruta ignoraba errores
`frontend/admin/js/rutas.js:520-547`. `cancelarRuta` ejecutaba varias escrituras sin inspeccionar `error`, siempre informando "Ruta cancelada".
**Fix:** cada escritura (update de `rutas`, revertir `pedidos`, cerrar `entregas`) ahora valida su `error` y el toast final refleja si hubo actualización parcial en vez de éxito ciego.

### BUG-08 — Notificación WhatsApp de chofer no chequeaba `resp.ok`
`frontend/admin/js/rutas.js:551-571`. Un 4xx/5xx de `/api/notif/push-chofer` no lanzaba excepción; el flujo mostraba "notificado" igual.
**Fix:** `notificarChofer` valida `resp.ok` en ambos canales (WhatsApp y push) y el toast de creación de ruta distingue ruta creada de chofer efectivamente notificado.

### BUG-09 — Push de automatización no validaba respuestas
`frontend/admin/js/automatizacion.js:587-610`. No validaba respuestas de cancelación, VAPID ni suscripción; `guardarPref` silenciaba fallos por completo.
**Fix:** `togglePush` valida `resp.ok` en `push-cancelar`, `vapid-key` y `push-suscribir` — si el server rechaza la suscripción, se deshace del lado del browser (`sub.unsubscribe()`) para no dejar una suscripción huérfana; `guardarPref` revierte el checkbox y avisa con toast si falla, en vez de tragarse el error.

### BUG-11 — Doble-submit en `btnAsyncClick` con confirmación
`frontend/admin/js/ui-utils.js:380-414`. El lock se aplicaba después de esperar la confirmación opcional; dos clics rápidos con `{confirm:true}` podían abrir dos diálogos y disparar dos mutaciones.
**Fix:** el lock (`disabled` + `btn--loading`) se aplica antes de abrir la confirmación, liberándolo si el usuario cancela. Con 106 usos de este wrapper en el admin, el fix es central y no requirió tocar cada caller.

### BUG-03 — Logout no limpiaba Cache Storage/IndexedDB
`frontend/admin/sw-admin.js`, `frontend/admin/js/auth.js`. `cerrarSesion` limpiaba `sessionStorage` y hacía `signOut`, pero nunca avisaba al Service Worker — Cache Storage es global por origin, sin namespacing por empresa/usuario.
**Fix:** nuevo mensaje `CLEAR_ON_LOGOUT` en `sw-admin.js` que vacía `CACHE_DATA` (páginas `/admin/*` y respuestas de API cacheadas por networkFirst/staleWhileRevalidate); `cerrarSesion()` lo dispara antes de redirigir, con timeout de 1.5s para no bloquear el logout si no hay SW activo.
**Decisión de alcance:** no se borran las bases IndexedDB del outbox offline (POS/cobros/stock) en este fix — podrían contener mutaciones del usuario aún sin sincronizar, y ya filtran por `empresa_id` al leer (Etapa 4 del plan offline). La limpieza de esas colas queda cubierta por el criterio de SYNC-04 (abajo), no por borrado ciego.

### SYNC-02 — Routing de WhatsApp por teléfono sin `phone_number_id`
`lib/handlers/notif.js`, `lib/repos/whatsapp-bot.js`; migración 247. `resolverEmpresaCliente` consultaba "conversación abierta por teléfono" de forma GLOBAL (sin `phone_number_id` ni `empresa_id`) antes de considerar el número receptor — si el mismo teléfono era cliente de más de una empresa de la plataforma, un mensaje a la Empresa B podía leer/escribir la conversación abierta de la Empresa A. El índice único `idx_whatsapp_conv_telefono_abierta` (migración 247) reforzaba esto a nivel de esquema: solo podía existir UNA conversación abierta por teléfono en toda la base.
**Fix:**
- Nueva migración `20260818_sync02_whatsapp_conversacion_scope_por_empresa.sql`: reemplaza el índice único global por uno acotado a `(empresa_id, telefono)` — cada empresa puede tener su propia conversación abierta con un teléfono compartido.
- `lib/repos/whatsapp-bot.js`: nuevas funciones `buscarConversacionAbiertaPorTelefonoYEmpresa` y `buscarConversacionAbiertaIdPorEmpresa`, acotadas por `empresa_id`.
- `lib/handlers/notif.js`: `resolverEmpresaCliente` ahora resuelve la empresa por `phone_number_id` PRIMERO cuando existe (Embedded Signup, determinístico) y busca la conversación abierta acotada a esa empresa — nunca global. Sin `phone_number_id` propio (número global de prueba) se mantiene el comportamiento previo, documentado como limitación conocida del piloto (decisión #1 de la migración 246). `resolverConversacionWhatsapp` también quedó acotado por empresa al crear/reusar la fila.
**Nota:** la propia matriz marca este hallazgo como 🔍 no verificado en datos actuales (QA no tiene teléfonos duplicados) — riesgo condicional, no incidente confirmado.

### SYNC-04 — Registros offline legacy sin `empresa_id` se sincronizaban bajo la sesión actual
`frontend/shared/offline-core.js`, `frontend/admin/js/pos-offline.js`. El caso más grave encontrado: `_migrarVentasPendientesV1` (migración one-shot de la cola vieja `pos_offline_db` v2, pre-OfflineCore) re-encolaba ventas pendientes con `outbox.encolarAccion()`, que les estampa el `empresa_id` de la SESIÓN ACTUAL. En un dispositivo compartido entre usuarios de dos empresas, una venta vieja de la Empresa A podía terminar sincronizada y ejecutada (stock, facturación) bajo la Empresa B si es B quien abre el POS y dispara la migración.
**Fix:** nuevo estado `cuarentena_v1` en el outbox de `OfflineCore.crearOutbox`. `encolarLegacySinTenant()` guarda el registro con `empresa_id: null` explícito y estado `cuarentena_v1` — queda fuera de `getPendientes()`/`sincronizarPendientes()`, no se auto-sincroniza con nadie. `getCuarentena()`/`confirmarCuarentena(local_id, empresaIdConfirmado)`/`descartarCuarentena(local_id)` exponen la revisión explícita: recién con `confirmarCuarentena` el registro pasa a `pendiente` con el `empresa_id` que quien revisa confirme. `pos-offline.js` usa `encolarLegacySinTenant` en la migración v1 en vez de `encolarAccion`, loguea un warning y muestra un toast avisando que hay ventas antiguas pendientes de revisión manual; `window.PosOffline` expone `getCuarentenaLegacy`/`getContadorCuarentenaLegacy`/`confirmarCuarentenaLegacy`/`descartarCuarentenaLegacy`.
**Nota de alcance:** esto resuelve la migración v1 del POS (la única mencionada explícitamente en el hallazgo). El resto de `getPendientes`/`getConflictos`/`todosVigentes` en `offline-core.js` ya filtraba correctamente registros de OTRA empresa explícita (Etapa 4); el gap real era específicamente el momento de la migración v1, que no pasaba por ese filtro de lectura sino que escribía directo con el tenant equivocado.

### SYNC-09 — Envíos a Meta sin retry/circuit breaker uniforme
`lib/handlers/notif.js`. `enviarTextoWhatsApp` (texto libre) ya reintentaba fallas transitorias (429/5xx) con backoff — pero `whatsappHandler` (envío de los 6 templates de negocio: `pedido_despachado`/`entregado`/`por_llegar`/`no_entregado`, `cheques_por_vencer`, `deuda_vencida`) hacía un solo intento; un 429/500 pasajero de Meta ahí se traducía directo en notificación perdida, sin ningún reintento.
**Fix:** las constantes de reintento (`REINTENTOS_TRANSITORIO_META`, `ESPERA_REINTENTO_META_MS`) y el criterio de falla transitoria se movieron a un lugar compartido antes de ambas funciones; `whatsappHandler` ahora reintenta con el mismo backoff que `enviarTextoWhatsApp` tras la falla, después del caso especial 131030. Se eliminó la copia local duplicada de estas constantes que tenía `enviarTextoWhatsApp`.
**Fuera de alcance (a propósito):** `lib/arca/wsaa.js` (WSAA/AFIP) — la propia matriz aclara que el timeout sin retry ahí es deliberado (operación no idempotente; el caller debe manejar regeneración de TRA), así que no se tocó.

---

## Validación de este lote

- `node --check` sobre los 11 archivos JS tocados (`compras.js`, `rutas.js`, `cta-cte.js`, `automatizacion.js`, `ui-utils.js`, `sw-admin.js`, `auth.js`, `offline-core.js`, `pos-offline.js`, `notif.js`, `whatsapp-bot.js`): OK.
- Verificación de sintaxis de los bloques `<script>` inline de `checkout.html`: OK.
- 1 migración SQL nueva en este lote (`20260818_sync02_whatsapp_conversacion_scope_por_empresa.sql`) — no aplicada a producción todavía, misma situación que el resto de migraciones preparadas en sesiones anteriores (pendiente de `git push` / deploy / aplicación manual contra `jgiquzjwoedmzwqgzubr`).
- No se corrió la suite de Vitest en este entorno (no hay `node_modules` instalados acá — mismo motivo que en v816/v820).
- Pendiente de deploy para tener efecto real (git push / Vercel + aplicar la migración SQL).

## Cierre de la Auditoría Integral 2026 (post-v816)

Con este lote quedan cerrados los 15 hallazgos MEDIA que seguían abiertos tras v816: SEC-11, SEC-12, SEC-13, BUG-03, BUG-04, BUG-05, BUG-06, BUG-07, BUG-08, BUG-09, BUG-10, BUG-11, SYNC-02, SYNC-04, SYNC-09.
