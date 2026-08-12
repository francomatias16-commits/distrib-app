# Etapa 3 — Backend / API (handlers)

Estado: 🟢 Barrido de superficie de auth completo (34/34 handlers) — 0 hallazgos abiertos (SEC-013 corregido en código, pendiente de deploy)

## Metodología
Para cada handler grande sin llamadas visibles a los helpers compartidos
(`verificarToken`/`verificarRequest` de `lib/auth-helpers.js`), se verificó si
implementa su propio chequeo de auth inline (patrón dominante en este repo:
cada handler valida el Bearer token de Supabase por su cuenta en vez de usar
el helper compartido — inconsistencia de mantenibilidad, no de seguridad).
Para cada ruta que se despacha *antes* del bloque de auth "principal" de su
archivo, se rastreó la función destino para confirmar si tiene su propio
guard o si efectivamente queda sin proteger.

## Handlers revisados en esta sesión (6/34)

| Handler | Resultado |
|---|---|
| `saas.js` (panel superadmin) | ✅ Limpio. `getSuperAdmin()` corre antes de cualquier ruteo por `_svc`, exige rol `superadmin` o `dueno` de la empresa raíz. Fix histórico documentado en el código (v220). |
| `pedidos.js` | ✅ Limpio. Rutas dispatched antes del bloque de auth "principal" (`_svc=presupuestos/remito-nro/chofer/devoluciones`, `accion=confirmar/confirmar-sugerido/crear-admin`) tienen todas su propio chequeo de token+rol inline. `confirmar`/`confirmar-sugerido` son públicas por diseño (documentado) y resuelven `empresa_id`/`cliente_id` server-side, nunca del body. |
| `pos.js` | ✅ Limpio. El `if (req.method === 'GET')` antes del token check es solo para elegir el rate limiter, no despacha nada. |
| `facturas.js` | ✅ Limpio. `notas-credito`, `comprobantes-historicos`, `config`, `anular`, `reintentar` — las 5 rutas dispatched antes del bloque principal tienen auth inline propia con validación de rol. |
| `portal_proveedor.js` / `proveedores.js` (`_svc=portal`) | ✅ Limpio y bien diseñado. Superficie pública por token (no JWT de Supabase): hashea el token, lo valida contra `proveedor_portal_tokens` vía RPC `validar_token_portal_proveedor` (service_role, tabla con RLS deny-all), y **deriva `proveedor_id`/`empresa_id` del token validado, nunca de params del cliente**, antes de llamar a `confirmarEntrega`/`subirFactura`. |
| `stock.js` (`handleClienteProductos`/`handleClienteCategorias`) | ℹ️ Confirma el patrón de SEC-008: comentario explícito en el código ("puede ser cliente autenticado o consulta pública con `empresa_id` param") — el catálogo público sin sesión es un patrón de diseño usado en más de un lugar del backend, no un descuido aislado. Refuerza que SEC-008 es intencional (catálogo tipo vidriera), sujeto a confirmación de negocio.

| `notif.js` | ✅ Limpio. Usa el helper compartido `verificarToken` en varias rutas (a diferencia de la mayoría). El webhook de WhatsApp (`whatsapp-webhook`) valida `X-Hub-Signature-256` con HMAC-SHA256 sobre el `rawBody`, **fail-closed** si `WA_APP_SECRET` no está seteado, y compara con `timingSafeEqual`. Los cron (`cheques-cron`, `deuda-cron`) exigen `CRON_SECRET` y también fallan cerrado si la env var no está configurada. `handleEstadoCuenta` valida rol y que el `cliente_id` pertenezca a la empresa del caller. |
| `admin.js` | ✅ Limpio. Un solo gate de auth (`autenticar()`) antes de cualquier `_svc`, exige rol admin, `empresa_id` siempre resuelto server-side. Solo GET (dashboard de solo lectura), superficie de riesgo baja. |
| `pagos.js` | ✅ **SEC-013 corregido en esta sesión.** El resto del archivo está bien: `guardarConfigMP`/`obtenerConfigMP`/`desactivarConfigMP` pasan por `autenticarAdmin()` (rol dueño/admin) antes de tocar nada, `crearPreferencia` recalcula todo server-side desde `pedido_id` (nunca confía en monto/cliente del body), y el webhook resuelve `empresa_id` desde una tabla propia (`transacciones_pago`), no de lo que manda el llamante. |

### SEC-013 — Webhook de Mercado Pago fallaba ABIERTO si faltaba el secret (✅ corregido, sesión 5)
`verificarFirmaMP()` en `pagos.js`: si `WEBHOOK_SECRET_MP` no estaba seteada en el entorno, la función devolvía `true` ("firma válida") en vez de rechazar, con solo un `console.warn`. Es el patrón inverso al que este mismo proyecto ya identificó y corrigió para el webhook de WhatsApp (`firmaValidaDeMeta` en `notif.js`, que falla **cerrado** si falta `WA_APP_SECRET`).

**Fix aplicado:** mismo patrón fail-closed que `notif.js` — si `WEBHOOK_SECRET_MP` no está seteada, ahora se rechaza con 401 (`return false`) en vez de aceptar. Verificado con `node --check lib/handlers/pagos.js`.

**⚠️ Este es un fix de código, no de base de datos — no tiene efecto hasta el próximo deploy (git push / Vercel).** A diferencia de los hallazgos SEC-005 a SEC-012 (migraciones SQL, con efecto inmediato en producción vía Supabase), este cambio vive en el ZIP/repositorio y depende de que se despliegue.

## Resto de handlers (25/34) — barrido automatizado + spot-checks

Se corrió sobre los 25 handlers restantes el mismo chequeo automatizado que reveló los casos de `pedidos.js`/`facturas.js` (rutas dispatched antes del primer chequeo de auth visible en el archivo, con varias variantes de sintaxis de llamada) — **0 coincidencias**: ningún handler despacha una ruta sensible antes de su propio chequeo de token/rol.

Además, spot-check dirigido:
- **`registro.js`** (registro público de nuevas empresas SaaS) y **`setup.js`** (inicialización one-time del sistema) son los únicos sin ningún chequeo de Bearer token — **por diseño**: ambos son endpoints de alta antes de que exista ninguna sesión. Ambos tienen rate limit propio, validan CUIT/formato, y `setup.js` además tiene doble guarda (handler + el RPC `setup_inicial_empresa` verifica internamente que no exista ninguna empresa). Verificado contra la base real: ya hay 2 empresas cargadas, así que `setup.js` está permanentemente inutilizado en la práctica (siempre devuelve 409).
- **`bcra.js`** no filtra por `empresa_id` — correcto, es un proxy a las APIs públicas del BCRA (Banco Central), consultado por CUIT, no maneja datos propios del tenant. Sí usa el helper compartido `verificarToken` y restringe a roles `dueno/admin/contador`.
- **`auth.js`**: acá es donde realmente se usa `verificarRequest` (el mecanismo de cookie+CSRF de `lib/auth-helpers.js`) — en `handleMe`/`handleChangePassword`/etc. Esto resuelve la duda abierta de la sesión anterior sobre si ese helper era código muerto: no lo es, se usa en el flujo principal de `/api/auth/*`. Queda pendiente entender por qué `pedidos.js` (`_svc=chofer`) usa un mecanismo distinto (Bearer JWT directo) en vez de este — probablemente son dos generaciones distintas de la app (web vs. una posterior), no un problema de seguridad en sí.
- Inconsistencia menor de higiene: la contraseña mínima exigida es de 8 caracteres en `registro.js`/`setup.js` pero de 6 en `handleChangePassword` (`auth.js`). No es una vulnerabilidad, pero vale unificar.
- El resto (`automatizacion.js`, `busqueda.js`, `cc_proveedores.js`, `ciclos.js`, `empresa.js`, `export-contable.js`, `importar.js`, `stock-auto.js`, `rutas-live.js`, `score.js`, `conciliacion-bancaria.js`, `reglas-precio.js`, `piloto.js`, `cierre.js`, `clientes.js`, `asistente.js`, `auditoria.js`) declaran roles explícitos (`ROLES_*`) y filtran consistentemente por `empresa_id` — sin anomalías detectadas en el barrido.

## Alcance de esta etapa (para que quede claro qué cubre y qué no)
Lo revisado es la **superficie de autenticación/autorización** de los 34 handlers: ¿quién puede llamar cada ruta, y se valida antes de ejecutar algo sensible? Lo que **no** se revisó línea por línea es la lógica de negocio interna de cada handler (cálculos, condiciones de carrera, casos borde) — eso queda más del lado de la Etapa 6 (consistencia end-to-end) si se quiere ir más profundo.

## Pendiente
- Nada bloqueante pendiente en el barrido de auth. Como trabajo futuro (no urgente): unificar el mínimo de contraseña (6 vs 8 caracteres) y confirmar si `verificarRequest` sigue teniendo sentido como mecanismo separado para el portal chofer o si conviene unificarlo con el resto.
- Hallazgo de higiene (no bloqueante): la mayoría de los handlers reimplementan el chequeo de token en línea en vez de usar `verificarToken`/`verificarRequest` de `lib/auth-helpers.js` — funciona, pero es una superficie de mantenimiento más grande (cada copia podría divergir con el tiempo). Se podría recomendar refactor a futuro, no es un hallazgo de seguridad hoy.
- Se detectó que el portal chofer (`_svc=chofer` en `pedidos.js`) usa Bearer JWT de Supabase directo, mientras `lib/auth-helpers.js` documenta un mecanismo alternativo de cookie+CSRF (`verificarRequest`) también pensado para chofer — confirmar si `verificarRequest` está en uso en algún otro lugar o quedó obsoleto (podría ser código muerto a limpiar, no vulnerabilidad).
