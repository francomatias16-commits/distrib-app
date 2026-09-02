# CHANGELOG v820 — Auditoría Integral 2026 (lote de los 15 hallazgos post-v816): SEC-11, SEC-12, SEC-13, BUG-04

**Fuente de los hallazgos:** `Matriz de hallazgos — Auditoría Integral 2026.md` (del zip `Audit_Remediation_Plan_and_Execution_Instructions`), la única con el texto completo de los 15 que quedaban sin ninguna descripción en el resto del proyecto.

**Alcance de este lote:** 4 de los 15 hallazgos MEDIA que quedaban tras v816 (SEC-01 a SEC-10/14, BUG-01/02, SYNC-01/03/05/06/07/08 ya estaban cerrados por otras migraciones/lotes que no habían sido revisados hasta ahora — ver detalle abajo). Todos severidad MEDIA en la matriz original.

---

## Cerrado en este lote

### SEC-11 — CORS wildcard en handlers mutantes de `pedidos.js`

**Hallazgo original:** `lib/handlers/pedidos.js:2168-2170,2944-2946`; `lib/security-headers.js:51-66`. Handlers mutantes fijan `Access-Control-Allow-Origin: *` y sobreescriben la política central de allowlist. Bearer reduce explotación automática, pero queda una superficie cross-origin innecesariamente abierta y divergente del control central.

**Fix:** `handleChofer` y `handleDevolucionesAdmin` reemplazaron `res.setHeader('Access-Control-Allow-Origin', '*')` por `applySecurityHeaders(res)` + `applyCorsHeaders(req, res)`, el mismo par que ya usan `auth.js`/`cierre.js`/`automatizacion.js`/etc. — allowlist de `ALLOWED_ORIGINS`, no wildcard.

### SEC-12 — Logo SVG sin sanitizar

**Hallazgo original:** `lib/handlers/empresa.js:82-116`. El logo acepta SVG y lo almacena sin sanitización; raster pasa por `sharp`, pero SVG arbitrario puede conservar contenido activo aunque el bucket sea privado.

**Fix:** se sacó `image/svg+xml` de los tipos permitidos en `POST /api/empresa/logo`. Se rechaza con 400 pidiendo PNG/JPEG/WebP — todos pasan por `sharp` (que además, al reprocesar el archivo, actúa como validación de que es una imagen rasterizada real). No se agregó librería de sanitización SVG nueva: rechazar es la opción de la propia recomendación del hallazgo y evita una dependencia adicional para un caso de uso (logo vectorial) que no es imprescindible.

### SEC-13 — Imagen del asistente validada solo por MIME declarado

**Hallazgo original:** `lib/handlers/asistente.js:538-550`; providers LLM. Validación de imagen para asistente confía en MIME declarado y longitud de base64, sin magic bytes.

**Fix:** nuevo helper `lib/utils/image-sniff.js` (`sniffImageMimeType`, sin dependencias nuevas: firmas JPEG/PNG/WEBP por bytes) + `validarImagenPorContenido`. `asistente.js` decodifica el base64 una vez y valida el buffer real antes de reenviarlo a Gemini/Groq/OpenRouter, además del chequeo de MIME declarado y tamaño que ya existía.

### BUG-04 — Uploads de proveedor/compras sin magic bytes

**Hallazgo original:** `lib/handlers/empresa.js`, `proveedores.js`, `portal_proveedor.js`, `compras.js`; uploads. Logo, comprobantes proveedor, remitos/recepciones y otros uploads aceptan MIME/prefijo sin verificar magic bytes.

**Nota de alcance:** no existe `lib/handlers/compras.js` — el endpoint real detrás de la subida de foto de remito que dispara `frontend/admin/js/compras.js` es `accion=upload-remito` en `lib/handlers/proveedores.js` (confirmado en el código, no asumido por el nombre).

**Fix:**
- `lib/utils/image-sniff.js` se extendió con `validarArchivoPorContenido` (mismas firmas + `%PDF-` para PDF), ya que estos dos endpoints aceptan foto **o** PDF escaneado.
- `proveedores.js` (`upload-remito`): antes no tenía **ningún** allowlist de `mime_type` — se usaba tal cual del payload para elegir extensión y `Content-Type` de Storage. Ahora valida contenido real contra `['image/jpeg','image/png','image/webp','application/pdf']` y usa el mime detectado, no el declarado.
- `portal_proveedor.js` (`subir-factura`): el regex `data:(mime);base64,` solo valida el prefijo que arma el propio cliente. Ahora, después de decodificar, se valida el buffer real con el mismo helper antes de subir a `facturas-proveedor`.

---

## Pendiente — texto completo de los 11 hallazgos que faltan (fuente: misma matriz)

### BUG-03 — Logout no limpia Cache Storage/IndexedDB
`frontend/admin/sw-admin.js:15-17,19-38,133-165`; `frontend/admin/js/auth.js:60-62,269-273`. Logout limpia `sessionStorage` y hace `signOut`, pero no invalida Cache Storage/IndexedDB ni envía mensaje al SW. Caches son globales por origin/version, sin namespacing por empresa/usuario. `SWR_PATTERNS=[]` limita fuga API hoy, pero queda persistencia de shell y riesgo de regresión.
**Recomendación de la matriz:** invalidar caches sensibles al logout, namespaciar por sesión/tenant y evitar cachear respuestas autenticadas.

### BUG-05 — Botón de checkout no se restaura tras fallo
`frontend/cliente/checkout.html:421-447`. Tras fallo de red o `ok=false` al confirmar pedido, el botón queda `disabled` y no restaura el texto; el cliente no puede reintentar sin recargar.
**Recomendación:** usar `finally` para restaurar botón y preservar la idempotency key para reintento seguro.

### BUG-06 — Error de cta-cte se ve como "sin movimientos"
`frontend/admin/js/cta-cte.js:328-338,371-398`. Un error REST al cargar movimientos se transforma en lista vacía; el usuario ve "Sin movimientos registrados" en vez de un error, y puede interpretar saldo sin movimientos cuando en realidad falló la lectura.
**Recomendación:** diferenciar `loading`/`empty`/`error`; mostrar retry/toast sin borrar el contexto del cliente.

### BUG-07 — Cancelación de ruta ignora errores
`frontend/admin/js/rutas.js:520-547`. Cancelación de ruta ejecuta varias escrituras y nunca inspecciona `error`; siempre informa "Ruta cancelada", aun si ruta/pedidos/entregas quedan parcialmente actualizados.
**Recomendación:** RPC/transacción atómica o verificar cada operación y mostrar estado parcial/reintento; incluir scope tenant en la operación server-side.

### BUG-08 — Notificación WhatsApp de chofer no chequea `resp.ok`
`frontend/admin/js/rutas.js:551-571`. Un 4xx/5xx no lanza excepción y el flujo muestra "Ruta creada y ... notificado" igual.
**Recomendación:** validar status, persistir entrega/notificación pendiente y diferenciar ruta creada de chofer notificado.

### BUG-09 — Push de automatización no valida respuestas
`frontend/admin/js/automatizacion.js:587-610`. No valida respuestas de cancelación, VAPID ni suscripción; puede mostrar éxito pese a 4xx/5xx. `guardarPref` silencia fallos por completo.
**Recomendación:** validar `resp.ok`, revertir UI en error y mostrar feedback/retry; no marcar suscripción local hasta confirmación server-side.

### BUG-10 — Upload de foto de remito en background sin validar status
`frontend/admin/js/compras.js:1002-1018`. Se dispara después del OCR, en paralelo; no valida `status` ni informa fallo. OCR/productos quedan en éxito aunque la evidencia fotográfica no se haya persistido.
**Recomendación:** hacer explícito el estado de foto, validar status y permitir reintentar sin repetir OCR/recepción.

### BUG-11 — Doble-submit en `btnAsyncClick` con confirmación
`frontend/admin/js/ui-utils.js:380-414`; usos en `gastos-generales.js:156`, `reglas-precio.js:197`. `btnAsyncClick` deshabilita después de esperar confirmación opcional — dos clics rápidos con `{confirm:true}` pueden abrir dos confirmaciones y ejecutar dos mutaciones.
**Recomendación:** marcar lock/disabled antes de abrir confirmación y liberar si el usuario cancela; proteger también server-side por idempotencia/estado.

### SYNC-02 — Routing de WhatsApp por teléfono sin `phone_number_id`
`lib/handlers/notif.js:822-887`; índice WhatsApp. Consulta por teléfono antes de respetar `phone_number_id`; índice único de conversación abierta es global por teléfono. En número compartido puede enviar conversación al tenant equivocado.
**Recomendación:** resolver por `phone_number_id + telefono + empresa`, ajustar índice y exigir tenant antes de leer/escribir conversación.
**Nota de la matriz:** 🔍 no verificado en datos actuales — QA no tiene teléfonos duplicados; riesgo condicional de configuración multi-tenant.

### SYNC-04 — Registros offline legacy sin `empresa_id` se sincronizan bajo la sesión actual
`frontend/shared/offline-core.js:379-382,441-449,463-468,722-740`; migración POS v1. Registros legacy sin `empresa_id` se muestran/sincronizan bajo la sesión actual; en dispositivo compartido una acción histórica de otra empresa puede atribuirse o enviarse bajo el tenant actual. POS v1 reencola legacy sin cuarentena de tenant.
**Recomendación:** no sincronizar legacy sin tenant verificable; cuarentena y revalidación explícita antes de migrar.

### SYNC-09 — Envíos a Meta sin retry/circuit breaker uniforme
`lib/handlers/notif.js` (llamadas a Meta); `lib/arca/wsaa.js:228-258`. Envíos Meta directos no usan retry/circuit breaker uniforme; fallos transitorios pueden dejar notificaciones fuera sin cola/reintento homogéneo. WSAA usa timeout sin retry deliberadamente, pero el caller debe manejar regeneración de TRA.
**Recomendación:** diferenciar operaciones no repetibles de notificaciones repetibles; usar outbox/backoff/circuit breaker donde la operación sea idempotente.

---

## Validación de este lote

- `node --check` sobre los 6 archivos tocados (`lib/handlers/pedidos.js`, `lib/handlers/empresa.js`, `lib/handlers/asistente.js`, `lib/utils/image-sniff.js`, `lib/handlers/proveedores.js`, `lib/handlers/portal_proveedor.js`): OK.
- No se aplicó ninguna migración SQL en este lote (los 4 hallazgos cerrados son 100% código).
- No se corrió la suite de Vitest en este entorno (mismo motivo que en v816: no hay `node_modules` instalados acá).
- Pendiente de deploy para tener efecto real (git push / Vercel).
