# Etapa 1 — Inventario y superficie de ataque

**Estado:** 🟢 Completa · **Última actualización:** 2026-07-11 (sesión 8)

## 1.1 Estructura del proyecto (código, ZIP subido)

| Área | Detalle |
|------|---------|
| Backend | Vercel serverless (`api/index.js` como entrypoint + `lib/handlers/` con 34 handlers), Node ≥20 |
| Base de datos | Supabase Postgres 17.6, 103 tablas en `public`, 224 migraciones versionadas en `supabase/migrations/` |
| Edge Functions | 1: `saas-email-sender` |
| Frontend | 4 portales estáticos: `admin/` (3.1MB, el más grande), `cliente/`, `chofer/`, `proveedor/`, más `shared/` |
| Integraciones | AFIP/ARCA (`lib/arca/`, facturación electrónica), WhatsApp Business (bidireccional), email (`lib/email.js`), push (`web-push`), pagos online |
| Scripts propios de auditoría | `scripts/audit-security-grants.js`, `scripts/audit-funciones-fantasma.js`, `scripts/check-schema.js` — ya corridos/cotejados en Etapa 2 (sesión 5) |
| Documentación | `docs/ayuda/` (30 guías funcionales), `docs/schema-snapshots/` (snapshots previos de schema) |

## 1.2 Dependencias (`package.json`) — auditado (sesión 8)

**Nota de método:** este sandbox no tiene acceso a `registry.npmjs.org` (`npm audit` falla con 403/host no permitido), así que la verificación se hizo con `web_search` contra las versiones exactas resueltas en `package-lock.json` (311 paquetes totales, incluye transitivos), no con el propio `npm audit`. Se recomienda correr `npm audit`/Socket.dev real con acceso a internet como complemento — esta pasada no cubre el árbol de transitivas completo.

**Directas, versiones resueltas en el lockfile:**
| Paquete | Versión resuelta | Estado |
|---|---|---|
| `jsonwebtoken` | 9.0.3 | ✅ Sin vulnerabilidades directas conocidas (Snyk). Las CVEs históricas (2022-23529/23539/23540/23541, algorithm confusion / RCE) están todas parcheadas desde 9.0.0+. Uso en el código (`lib/auth-helpers.js`, `lib/handlers/auth.js`) firma y verifica con secreto simétrico fijo (`HS256`) — no usa retrieval callback, que es el vector real de la vulnerabilidad histórica. |
| `node-forge` | 1.4.0 | ✅ Parcheado. Hay 3 CVEs recientes y serias (nov. 2025): **CVE-2025-12816** (bypass de verificación de firmas ASN.1, crítica), CVE-2025-66031 (DoS por recursión), CVE-2025-66030 (overflow) — todas afectan versiones ≤1.3.1. El proyecto está en 1.4.0, por encima del fix (1.3.2+). |
| `sharp` (dev) | 0.33.5 | ✅ Sin CVEs nuevas relevantes a esa versión (la única histórica, CVE-2022-29256, se arregló en 0.30.5). |
| `@supabase/supabase-js` | 2.110.0 | Sin hallazgos buscados puntualmente — versión reciente. |
| `firebase-admin` | 12.7.0 | Sin hallazgos buscados puntualmente. |
| `bcryptjs`, `bwip-js`, `docx`, `gray-matter`, `node-fetch`, `pdfkit`, `web-push` | ver lockfile | No se investigó CVE por CVE (bajo perfil de riesgo, no manejan crypto/parsing de datos no confiables como los dos de arriba) — pendiente si se quiere ser exhaustivo. |

**Punto de atención (no una vulnerabilidad confirmada, sí una alerta a seguir de cerca):** en sept. 2025 y de forma recurrente durante 2026 hubo compromisos de cadena de suministro reales en el ecosistema npm (`chalk`, `debug`, `ansi-styles`, `strip-ansi`, `color-convert`, `wrap-ansi`, `ansi-regex`, etc. — paquete `is-arrayish` incluido, "Shai-Hulud" y variantes). Todos estos paquetes están presentes como **transitivos** en `package-lock.json` de este proyecto (`debug@4.4.3`, `ansi-styles@4.3.0`, `strip-ansi@6.0.1`, `color-convert@2.0.1`, `wrap-ansi@7.0.0`, `ansi-regex@5.0.1`, `is-arrayish@0.3.4`). No pude confirmar por búsqueda si esas versiones específicas coinciden con las que fueron troyanizadas en algún momento (los reportes públicos hablan de ventanas de pocas horas antes del rollback) — **recomendación:** correr `npm audit`/`socket.dev`/`npm ls <paquete>` con red real antes de cualquier `npm install` limpio, y considerar `npm ci` con lockfile ya congelado (que es lo que hay acá) en vez de un install que re-resuelva versiones.

## 1.3 Supabase — confirmado
- Proyecto: `jgiquzjwoedmzwqgzubr`, `ACTIVE_HEALTHY`, Postgres 17.6.1.127, región `us-west-2`.
- 103 tablas en schema `public`.
- 1 Edge Function activa.
- **Verificado en vivo (sesión 7)** con `get_advisors(security)` contra la base real — resultado consistente con todo lo documentado en Etapa 2 (ver ahí).

## 1.4 Historial de versiones (changelogs) — leído (sesión 8)
El repo tiene ~70 archivos CHANGELOG. Se leyó `AUDITORIA_SEGURIDAD_DISTRIB_v194.md` (auditoría propia previa, 01/07/2026, 320 líneas — frontend admin + dispatcher) y se cruzó contra el código actual (v295):

| Hallazgo v194 | Estado en v295 (verificado ahora) |
|---|---|
| **SEC-01** — sin Content-Security-Policy en ningún HTML admin | ✅ **Corregido** — `vercel.json` ya tiene CSP completa para `/frontend/*.html` y `/api/*` (confirmado en Etapa 5). |
| **BUG-03** — `api/index.js` exponía `err?.message` crudo en 500 (information disclosure de esquema interno) | ✅ **Corregido** — el código actual tiene un comentario explícito citando este mismo hallazgo (`// BUG-03 (auditoría v194, P0)`) y ahora usa `correlation_id` + logging server-side, sin exponer `err.message`/stack al cliente. |
| **BUG-01** — `typeof sanitize === 'function' ? sanitize(e) : e` como fallback silencioso de escape (si `sanitize` no cargó, pasa el dato crudo) | 🟡 **Sigue presente**, sin corregir: `admin/js/compras.js:161`, `admin/js/devoluciones.js:293`, `admin/js/notas-credito.js:168`. Hoy `sanitize` sí está definida globalmente (`ui-utils.js`, confirmado en Etapa 5) y se carga en esas páginas, así que no es explotable *hoy* — pero el patrón es frágil por diseño: una falla de orden de carga lo convierte en un XSS silencioso sin ningún error visible. Bajo, no urgente. |
| **BUG-02** — `api-client.js` (que maneja 401/403 → redirect y espera `authReady`) casi no se usa; la mayoría de los módulos hace `fetch` directo contra `${SUPABASE_URL}/rest/v1/...` con el anon key, bypaseando el backend propio | 🟡 **Sigue presente**: `api-client.js` solo está en 2 de 51 HTML del admin. Confirmado que `cheques.js`, `cta-cte.js`, `notas.js` siguen pegándole directo a PostgREST (`admin/js/cheques.js:323/330/352`, `cta-cte.js:106/282`, `notas.js:96`). **No es una vulnerabilidad de autorización** en sí — Etapa 2 ya verificó exhaustivamente que las políticas RLS de las tablas involucradas (`cheques`, `facturas`, `cta_cte`, `clientes`) filtran correctamente por `empresa_id`/`auth.uid()`, así que un bypass del backend no bypasea el aislamiento real. Es, eso sí, una inconsistencia arquitectónica: las validaciones de negocio que sí viven en los handlers (no en RLS) no corren para estas tablas cuando se accede así. |
| **BUG-04** — módulos inline que leen `window.authCtx` sin esperar `window.authReady` (race condition, token vacío) | No re-auditado línea por línea en esta pasada — queda como pendiente de menor prioridad si se quiere cerrar 100%. |

Auditorías previas adicionales confirmadas presentes en el repo (no releídas en detalle, están fechadas y ya incorporadas a versiones posteriores del código): `AUDITORIA_FILTROS_v280.md`, `CHANGELOG_v249_etapa0_auditoria_security_definer_funciones_fantasma.md` (antecedente directo de lo que esta auditoría retomó y completó en Etapa 2/SEC-010), `CHANGELOG_v281_ctacte_server_side_y_fix_grants.md`, `CHANGELOG_v283_etapa6_hardening_webhook_whatsapp.md`, `CHANGELOG_v293_whatsapp_access_token_cifrado.md`.

## 1.5 Variables de entorno y secretos — auditado (sesión 8)
- **0 secretos hardcodeados** encontrados en `lib/`, `api/`, `scripts/` (barrido con patrón `(api_key|secret|password|token)\s*[:=]\s*['"][a-zA-Z0-9_-]{15,}` filtrando `process.env.*` — sin resultados).
- 34 variables de entorno referenciadas por el backend (`process.env.*`), todas leídas dinámicamente, ninguna con fallback hardcodeado a un valor real: `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `WA_ACCESS_TOKEN`/`WA_APP_SECRET`/`WA_VERIFY_TOKEN`/`WA_PHONE_NUMBER_ID`, `WEBHOOK_SECRET_MP`, `ARCA_SECRETS_KEY`, `VAPID_PRIVATE_KEY`/`VAPID_PUBLIC_KEY`, `RESEND_API_KEY`, `GEMINI_API_KEY`/`GROQ_API_KEY`/`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`, `INTERNAL_API_KEY`/`INTERNAL_PUSH_SECRET`, `CRON_SECRET`, `SUPERADMIN_EMPRESA_ID`, `FIREBASE_SERVICE_ACCOUNT_KEY`, `GOOGLE_MAPS_API_KEY`, y variables no sensibles de configuración (`ALLOWED_ORIGINS`, `APP_URL`, `FRONTEND_URL`, `SITE_URL`, `EMAIL_FROM`, modelos de IA, `VERCEL_*`).
- Confirma y amplía lo ya visto en Etapa 5: los identificadores públicos en el frontend (`env-config.js` — Supabase anon key, Firebase API key, WhatsApp App/Config ID) son intencionales y no secretos reales; el `WA_APP_SECRET` real vive solo server-side.

## 1.6 Mapeo de endpoints × auth × validación
✅ **Completado en Etapa 3** (34/34 handlers, barrido de superficie de auth) — ver `etapas/03_backend_api.md`. No se duplica acá.

## Cerrado — sin pendientes bloqueantes
Quedan, sin urgencia, dos ítems de higiene heredados de la auditoría v194 que nunca se cerraron del todo (BUG-01 y BUG-02 de la tabla de arriba) — no son explotables hoy per Etapa 2 (RLS) y Etapa 5 (sanitize sí carga), pero son deuda técnica real. Se pueden tomar como tarea de Etapa 6 (consistencia/robustez) si se quiere, ya que encajan mejor ahí que en "inventario".

