# Etapa 4 — Integraciones externas (AFIP/ARCA, WhatsApp, email, Mercado Pago)

Estado: 🟢 Completa — 0 hallazgos abiertos (SEC-014 corregido y verificado)

## Módulo de cifrado (`lib/crypto-secrets.js`)
Base de todo lo demás: AES-256-GCM, IV de 12 bytes, autenticación con `authTag` (GCM), formato versionado (`v1:iv:authTag:ciphertext`). Falla explícitamente (`throw`) si `ARCA_SECRETS_KEY` no está configurada o no mide 32 bytes — no hay fallback inseguro. Compatibilidad hacia atrás documentada para valores legacy sin cifrar, pensada como puente de migración. ✅ Sin hallazgos.

## AFIP/ARCA (`lib/arca/wsaa.js`, `lib/handlers/facturas.js`)
- Certificado/clave privada por empresa se descifra antes de firmar el TRA contra WSAA. Firma con `node-forge` en JS puro (no `openssl`/`child_process`) — correcto para el entorno serverless de Vercel.
- Verificado contra la base real: 0 filas en `facturacion_config` con `cert_pem`/`key_pem` sin cifrar.
- `testearCredencialesARCA` sanitiza los mensajes de error (no expone certificado/clave), bloqueada para la empresa demo.
- `tokens_wsaa` ya revisada en Etapa 2: RLS correcta.
✅ Sin hallazgos.

## WhatsApp Business (`lib/handlers/notif.js`, `lib/whatsapp-pedido-tools.js`)
- Webhook: validación `X-Hub-Signature-256` (HMAC-SHA256, fail-closed, `timingSafeEqual`).
- Access tokens por empresa (`empresa_whatsapp.access_token`) pasan por `cifrar()`/`descifrar()`. 0 filas actualmente (nadie conectó su WhatsApp Business todavía), pero el flujo de alta cifra antes de guardar.
- `whatsapp-pedido-tools.js` (asistente de pedidos por WhatsApp): el modelo nunca arma SQL ni decide `empresaId`/`conversacionId` — se resuelven antes de invocar al modelo. El modelo nunca confirma un pedido en firme; eso requiere un "sí" explícito y determinístico del cliente, manejado en `notif.js`, no por tool-calling.
✅ Sin hallazgos.

## Mercado Pago (`lib/handlers/pagos.js`)
- SEC-013 (webhook fail-open) corregido en sesión anterior (pendiente de deploy, ver Etapa 3).
- `access_token`/`public_key` pasan por `cifrar()` en `guardarConfigMP`.
- **SEC-014 (resuelto 2026-07-11):** había 1 fila en `integraciones_pago` con `access_token` sin cifrar — token de test de sandbox MP (`TEST-...`), integración inactiva (`activa=false`), sin ningún caller real. Se eliminó la fila directamente (no había razón de negocio para conservarla). **Verificado post-fix:** `integraciones_pago` ahora tiene 0 filas sin cifrar (0 filas en total).

## Email (`lib/email.js`)
- API de Resend vía `RESEND_API_KEY`, no SMTP con credenciales propias. Riesgo bajo, sin URLs/destinos controlados por el usuario.
✅ Sin hallazgos.

## Asistente de ayuda (`lib/asistente-providers.js`, `lib/asistente-tools.js`)
- Las API keys de los proveedores de IA (Gemini/Groq/OpenRouter) son variables de entorno globales, no credenciales por tenant en la base — no aplica el módulo de cifrado.
- `asistente-tools.js`: mismo patrón de contención que el resto del proyecto — el modelo elige de una lista fija de tools con parámetros primitivos, cada una llama una RPC ya escrita a mano y `empresa_id` se inyecta server-side desde el token verificado, nunca sale del modelo.
✅ Sin hallazgos.

## Historial
| Fecha | ID | Acción |
|---|---|---|
| 2026-07-11 | SEC-014 | Fila de test sin cifrar en `integraciones_pago` eliminada directamente en producción (sin migración de re-cifrado porque no había valor de negocio que preservar). Verificado: 0 filas restantes. |
