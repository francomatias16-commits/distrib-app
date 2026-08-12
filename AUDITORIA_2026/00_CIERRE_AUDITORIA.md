# Cierre de Auditoría Integral — Distrib SaaS (v295→v296+)
**Proyecto Supabase:** `jgiquzjwoedmzwqgzubr` (Postgres 17.6, us-west-2)
**Alcance:** 11 etapas — backend (Vercel/Node), base de datos (Supabase, RLS,
funciones), frontend (4 portales), integraciones externas, consistencia de
negocio, performance, observabilidad, backups/DR, dependencias, rate limiting/DoS.
**Duración:** 1 sesión inicial + 10 sesiones de continuación, todas 2026-07-11.
**Cierre:** todas las 11 etapas revisadas. 0 hallazgos técnicos abiertos sin
plan de acción — quedan **4 pendientes que requieren una decisión o acción
tuya** (no de código), listados en la sección 1.

---

## 1. Lo que necesita tu acción — en orden de importancia real

| # | Qué | Por qué importa | Esfuerzo |
|---|-----|------------------|----------|
| 1 | **Activar el backup automatizado** (BACKUP-01): cargar `SUPABASE_DB_URL` y `BACKUP_GPG_PASSPHRASE` como secrets en GitHub y hacer push del workflow ya creado. | 🟡 **En pausa (2026-07-12).** Workflow (`backup-supabase.yml`) ya commiteado en el repo, ambos secrets cargados. Corrido manualmente 5 veces: primero falló por versión de Postgres client (corregido), después 4 veces seguidas con `password authentication failed for user "postgres"` contra el pooler de sesión, pese a resetear la contraseña más de una vez. No se llegó a aislar la causa (sospechas sin confirmar: propagación lenta del pooler tras el reset, o que el clic de "Reset password" en Supabase no se confirmó de verdad). Se decidió pausar para retomar con más tiempo. Hoy, si algo borra o corrompe datos en producción, **sigue sin haber ningún camino de vuelta** — plan Free de Supabase no tiene backups ni PITR. Sigue siendo el hallazgo más grave de toda la auditoría. **Decisión registrada: seguís en Free, así que este paso sigue siendo la única red de seguridad real pendiente de activar.** | 10 min (si no hay más problemas de auth) |
| 2 | ~~Setear `INTERNAL_PUSH_SECRET` en Vercel y redeployar~~ (OBS-03). | 🟢 **Resuelto y verificado end-to-end (2026-07-12).** Dos bugs encadenados, ambos corregidos: (a) el valor de `INTERNAL_PUSH_SECRET` en Vercel no coincidía con el que los triggers de Supabase mandan en `x-push-secret` → 401; (b) `lib/handlers/notif.js` buscaba rol `'deposito'` (no existe; el enum real es `depositero`) → 500 en toda notificación de `stock_critico`. Se corrigieron ambos y se deployó. Prueba final contra la empresa demo (`es_demo=true`, sin tocar clientes reales): forzado el trigger de stock crítico → respuesta `200 {"ok":true,"enviadas":0,"destinatarios":1}` — encontró correctamente al destinatario, sin error. El `enviadas:0` es esperado (el usuario demo no tiene ningún dispositivo con push registrado, no es un bug). Ver `CHANGELOG_v298_fix_typo_rol_deposito_push_stock_critico.md`. | Cerrado |
| 3 | **Decisión sobre Supabase Pro y Vercel Pro** (BACKUP-01 / RL-02). | **Ambas decididas (2026-07-11): sin presupuesto para upgrades pagos por el momento — seguís en Supabase Free + backup casero y en Vercel Hobby.** Consecuencia directa: el paso 4 (probar restauración) es la única red de seguridad real para datos, y el riesgo de ToS de Vercel Hobby queda aceptado conscientemente (no hay mitigación técnica para eso). Como mitigación gratuita del riesgo relacionado (RL-01), conviene resolver el rate limiting con un contador centralizado en Supabase en vez de un store pago tipo Redis/Upstash. | Decisión de costo, no técnica |
| 4 | **Probar la restauración de un backup** al menos una vez, contra un proyecto de prueba. | Un backup nunca probado no es un backup confiable — es la única forma de saber si el proceso de la fila 1 realmente funciona el día que lo necesites. | ~20 min, cuando tengas el backup activo |

Todo lo demás de este documento es contexto y detalle — si solo tenés 5
minutos, con resolver la fila 1 y la 2 ya sacaste el 90% del riesgo real que
dejó esta auditoría.

---

## 2. Estado por etapa

| # | Etapa | Estado final |
|---|-------|--------------|
| 1 | Inventario y superficie de ataque | 🟢 Completa |
| 2 | Seguridad de base de datos (RLS, `SECURITY DEFINER`, grants) | 🟢 Completa en lo accionable por SQL (2 pendientes de esfuerzo mayor/manual, ver §4) |
| 3 | Backend / API (handlers) | 🟢 Completa — 34/34 handlers, 0 abiertos |
| 4 | Integraciones externas (AFIP/ARCA, WhatsApp, email, Mercado Pago) | 🟢 Completa — 0 abiertos |
| 5 | Frontend (XSS) | 🟢 Completa — 8 hallazgos corregidos, 0 abiertos |
| 6 | Consistencia end-to-end y robustez | 🟢 Completa — CONS-01/02/03 corregidos y verificados |
| 7 | Performance y escalabilidad | 🟢 Completa — PERF-01/02/03 resueltos |
| 8 | Observabilidad | 🟡 Cerrada, 1 pendiente de deploy tuyo (OBS-03) |
| 9 | Backups y disaster recovery | 🟡 Mitigado parcialmente (BACKUP-01, workflow creado, activación pendiente) |
| 10 | Dependencias / supply chain (npm) | 🟢 Completa — 0 críticas/altas, 1 moderada no explotable, 1 higiene de build |
| 11 | Rate limiting y protección DoS | 🟡 Completa con revert — RL-01 (v297, contador en Supabase) se deployó, tumbó producción, y se revirtió a memoria (v303, deployado hoy). Ver detalle abajo. |
| 12 | Riesgo de cheques | 🟢 Completa — módulo sin hallazgos propios; 2 hallazgos colaterales corregidos (login bloqueaba 3 roles; 4 acciones de `score.js` sin chequeo de rol) |

---

## 3. Lo que se corrigió y ya tiene efecto en producción (sin acción tuya)

**Base de datos (Supabase, vía migraciones aplicadas directo — efecto inmediato):**
- **SEC-006 / SEC-007**: aislamiento por empresa agregado en `rpc_registrar_devolucion_pos` y autorización agregada en `onboarding_empresa` — ambas permitían antes que cualquier usuario autenticado tocara datos de **otras empresas** del SaaS.
- **SEC-010**: 18 funciones del wizard de migración (`migracion_*`) sin aislamiento por empresa — el hallazgo de mayor volumen de toda la auditoría, corregido en 4 migraciones.
- **SEC-005 / SEC-011 / SEC-012**: `search_path` fijo, restricción a `service_role` de un cron mal expuesto, y revocación de `EXECUTE` de `anon` en 25 funciones de negocio sin caller legítimo sin sesión.
- **SEC-008 / SEC-009**: catálogo público gateado por flag de empresa (decisión de negocio: restringir) y `p_usuario_id` forzado a `auth.uid()` en 4 funciones que confiaban en lo que mandaba el cliente.
- **SEC-014**: credencial de test sin cifrar eliminada de `integraciones_pago`.
- **CONS-01/02/03** (Etapa 6): trigger de sincronización de deuda que fallaba en silencio (`ELSE 0`), 3 funciones (`registrar_cobro_completo`, `calcular_deuda_cliente`, `calcular_score_cliente`) que desbloqueaban crédito indebido por una fórmula que no reconocía facturas como cargo, y una función de cta-cte que escribía en la columna que nadie leía.
- **PERF-02/03** (Etapa 7): `ANALYZE` corrido sobre toda la base (el planner venía trabajando a ciegas — `pedido_items` mostraba 17 filas en el catálogo cuando tiene 13.482 reales) + 11 índices FK faltantes agregados, priorizando `whatsapp_conversaciones.cliente_id` (la feature que están escalando).
- **OBS-03** (parcial): secreto de push generado y cargado en Supabase — falta el lado de Vercel (ver §1, fila 2).

**Código (frontend/backend — con efecto solo después de deploy a Vercel):**
- **SEC-013**: webhook de Mercado Pago fallaba abierto (aceptaba sin firma) si faltaba `WEBHOOK_SECRET_MP` — ahora falla cerrado, mismo patrón que el webhook de WhatsApp.
- **8 hallazgos de XSS** (Etapa 5): el más serio, un patrón repetido de `onclick="fn('${valor}')"` con texto libre (nombre de cliente/empresa) sin escapar comillas — explotable incluso en la sesión del **superadmin del SaaS** vía el nombre de una empresa que se autoregistra. Corregido con un helper que delega a `JSON.stringify`.

**Actualización 2026-07-12 — incidente RL-01 y estado real de deploy:** todo lo de este bloque (SEC-013, los 8 fixes de XSS, y RL-01 v297) **ya fue deployado.** RL-01 v297 causó una caída real de producción (504 en 9 endpoints de `/admin/dashboard`, reportado por Cristian) — la causa raíz fue la llamada de red que el rate limiter agregaba antes de cualquier lógica de negocio. Se revirtió en `v303` (`lib/rate-limit.js` vuelve al `Map` en memoria, igual que la última versión confirmada estable). **`v303` es el baseline deployado confirmado hoy** — el incidente está resuelto, pero el hallazgo original de RL-01 (límite no compartido entre instancias de Vercel) sigue abierto a propósito, pendiente de una solución de fondo (Upstash/Vercel KV, o diagnosticar por qué colgaba `fn_rate_limit_check`).

**Pendiente de deploy ahora mismo (posterior a `v303`):** `v304` (etapas 13-18 de esta auditoría, 21 hallazgos — `lib/handlers/pedidos.js`, `frontend/admin/js/migracion.js`, `ui-utils.js`, `rutas.js`, `rutas-resumen.js`, `cheques.js`, `cta-cte.js`, `notas.js`, `saas-billing.html`, `clientes.js`, `notif-log.js`) y la **Etapa 12** (`frontend/admin/login.html`, `frontend/admin/dashboard.html`, `lib/handlers/score.js`) — 13 archivos en total, sin migraciones SQL pendientes (las de v304 ya están aplicadas en Supabase).

---

## 4. Pendientes de esfuerzo mayor o decisión manual (sin bloquear el cierre)

| ID | Qué | Por qué no se resolvió ya |
|----|-----|---------------------------|
| SEC-003 | Protección de contraseñas filtradas (HaveIBeenPwned) deshabilitada en Supabase Auth | No accionable por API/SQL — activar manualmente en el dashboard: Authentication → Policies → Password Security |
| SEC-004 | Extensiones `pg_trgm`/`vector` instaladas en `public` en vez de un schema dedicado | Migración de mayor riesgo: ~29 funciones de alto tráfico (`fn_productos_lista`, `registrar_venta_pos`, todo el módulo `migracion_*`, etc.) dependen del `search_path` actual — moverlas sin actualizar esas 29 en la misma migración rompería producción. Mapeo ya hecho, falta ejecutar en una rama de prueba primero. |
| DEP-01 | `firebase-admin` necesita bump de major (12→14) para cerrar el único aviso moderado de `npm audit` | No explotable en este proyecto hoy (solo se usa Cloud Messaging), pero requiere probar `admin.messaging()` en rama aparte antes de mergear |
| DEP-02 | `esbuild` sin entrada en `package-lock.json` | 1 comando (`npm install` + commit) — no accionable desde este sandbox, solo desde el repo real |

---

## 5. Riesgos de negocio detectados (no son bugs — son decisiones de costo/plan)

Dos hallazgos de esta auditoría no son técnicos, son el mismo patrón repetido
en dos plataformas distintas: **el proyecto corre sobre planes gratuitos que
no están pensados para un SaaS comercial con clientes pagos reales.**

- **Supabase — plan Free** (BACKUP-01): cero backups, sin PITR, sin SLA. 65 MB
  de 500 MB usados — el espacio no es el problema, la falta de red de
  seguridad sí.
- **Vercel — plan Hobby** (RL-02, descubierto de forma incidental en la
  Etapa 11): confirmado por el propio código (`api/index.js` consolida ~17
  handlers en 1 función por el límite de 12 del plan gratuito). El ToS de
  Hobby prohíbe uso comercial — riesgo de suspensión de cuenta, no solo de
  funcionalidad limitada.

No es una recomendación de gastar por gastar: es información para que la
decisión de seguir en Free/Hobby (si es esa) sea consciente y no por
default.

**Actualización (2026-07-11): decisión tomada y registrada.** Sin
presupuesto disponible por el momento para ningún upgrade — se sigue en
Supabase Free y Vercel Hobby en ambos casos. Es una decisión consciente,
no un default sin revisar. Las mitigaciones gratuitas que quedan
disponibles (backup casero para BACKUP-01, contador en Supabase para
RL-01/RL-02) son las que hay que sostener con más disciplina justamente
porque no hay red de plan pago detrás.

---

## 6. Lo que ya estaba bien (para que no quede la sensación de que todo eran problemas)

- RLS auditado en profundidad en las tablas más sensibles (`clientes`,
  `empresas`, `facturas`, `usuarios`, `cta_cte`, `tokens_wsaa`,
  `internal_secrets`, `refresh_tokens`) — ninguna con agujeros tipo
  `USING (true)`.
- Los 3 webhooks externos (WhatsApp, Mercado Pago tras el fix, y el
  cron interno) validan firma/secreto con comparación de tiempo constante y
  fallan **cerrado**, no abierto.
- 0 secretos hardcodeados en todo el backend; módulo de cifrado
  (`crypto-secrets.js`, AES-256-GCM) usado consistentemente para credenciales
  por tenant, sin fallback inseguro.
- 34/34 handlers con superficie de auth verificada — ninguna ruta sensible
  despachada antes de su chequeo de token/rol.
- Cobertura de rate limiting amplia (34/35 handlers) aunque con el defecto
  arquitectónico de RL-01 — no es que falte protección, es que la protección
  que hay puede debilitarse bajo carga real.
- El equipo (vos) ya había detectado y corregido el mismo tipo de patrón más
  de una vez antes de que esta auditoría llegara a esa parte del código
  (el fix de rate limiting del asistente de IA en v220 es el ejemplo más
  claro) — la base de código tiene buena memoria institucional en los
  comentarios, lo cual ayudó bastante a esta auditoría a moverse rápido.

---

## 7. Recomendación de cadencia hacia adelante

Esta auditoría fue un barrido puntual, no un proceso continuo. Para que no se
vuelva a acumular deuda del tipo que se encontró acá (backups nunca
verificados, secretos a medio cargar, funciones nuevas que se olvidan del
chequeo de aislamiento), conviene pensar en:
- Repetir el barrido de `SECURITY DEFINER`/grants (Etapa 2) cada vez que se
  agregue un módulo nuevo grande (como se hizo ahora con `migracion_*`).
- Probar la restauración de un backup una vez cada tanto (no solo la primera
  vez) — el punto 4 de la sección 1 no es "hacé esto una vez y ya", es un
  hábito.
- Revisar `npm audit` real (ya se confirmó que el acceso a `registry.npmjs.org`
  funciona ahora) antes de cada release grande, no solo en auditorías.

## Archivos de esta auditoría
Todo el detalle etapa por etapa queda en `AUDITORIA_2026/etapas/*.md`, con
este archivo (`00_PLAN_MAESTRO.md`) y este cierre (`00_CIERRE_AUDITORIA.md`)
como punto de entrada. Para retomar en una sesión nueva más adelante (una
etapa puntual, o una auditoría de seguimiento), alcanza con decir "revisá el
cierre de la auditoría 2026" y se retoma desde acá sin repetir contexto.
