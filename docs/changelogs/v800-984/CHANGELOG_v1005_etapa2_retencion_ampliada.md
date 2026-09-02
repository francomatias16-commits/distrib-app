# v1005 — Etapa 2 del plan de robustez (ampliación): retención en security_audit_historial, whatsapp y asistente

## Contexto

`docs/planes/PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md` — Etapa 2. La
migración `20260828213422_etapa2_retencion_archivado_notif_eventos_audit.sql`
(aplicada 2026-08-28, encontrada ya en el repo) cubrió `notif_log`,
`eventos_negocio` y `audit_log`, con un RPC (`archivar_y_purgar_retencion`),
un handler (`lib/handlers/retencion.js`) y un cron diario (`/api/retencion`,
03:50 UTC) ya wireados en `vercel.json`. El diagnóstico original del plan
listaba 3 tablas más de crecimiento no acotado que quedaron sin cubrir:
`security_audit_historial`, `whatsapp_conversaciones`/`whatsapp_mensajes` y
`asistente_conversaciones`/`asistente_mensajes`.

## Cambio

Migración `20260829000000_etapa2_retencion_ampliada_asistente_whatsapp_security_audit.sql`:

- Tablas `_historico` espejo para las 3 tablas/pares nuevos, mismo patrón
  que la migración anterior (`LIKE ... INCLUDING DEFAULTS`, RLS habilitado,
  política SELECT scopeada por empresa donde corresponde).
- `security_audit_historial_historico`: RLS sin políticas (solo
  `service_role`), igual que la tabla original — es información de
  auditoría de seguridad, no algo que el panel admin deba listar.
- `CREATE OR REPLACE` sobre `archivar_y_purgar_retencion` (misma firma,
  mismo `p_dias_retencion` compartido) para sumar el archivado de las 3
  tablas nuevas al mismo ciclo — el handler, el repo y el cron de
  `vercel.json` no cambian, solo el trabajo que hace el RPC por dentro.
- Reglas de selección específicas, no solo por fecha:
  - **whatsapp**: solo conversaciones con `estado='cerrada'` y
    `ultima_interaccion` vieja. Una conversación activa, esperando
    confirmación o derivada a humano nunca se purga, sin importar la
    antigüedad.
  - **asistente**: por `actualizado_en` — son sesiones de chat corto, sin
    estado abierta/cerrada que cuidar.
  - **security_audit_historial**: por `ejecutado_en`, mismo criterio que
    `audit_log`.
- En los dos casos padre/hijo (asistente, whatsapp) los mensajes/turnos se
  archivan primero (mismo criterio de selección del padre), después el
  padre — así nunca queda un mensaje huérfano en `_historico` sin su
  conversación.
- Ninguna de las 3 tablas tiene relación con facturación/AFIP — no aplica
  la salvedad de retención legal que menciona el plan para datos contables.

## Código

- `lib/handlers/retencion.js` y `lib/repos/retencion.js`: comentario de
  cabecera actualizado para reflejar las 6 tablas cubiertas ahora (antes
  documentaba solo 3). Sin cambios de lógica — ya eran agnósticos a qué
  claves devuelve el RPC.
- `tests/handlers/retencion-permisos.test.js`: sumado un test que confirma
  que el handler propaga TODAS las claves que devuelva el RPC (no solo las
  3 originales), para no acoplar el contrato HTTP a una lista fija de
  tablas si el RPC suma o saca alguna más adelante.

## Verificación

- `npm run predeploy`: OK (0 referencias rotas de assets/api, dispatch
  heurístico solo con los 6 warnings preexistentes de `chofer-offline.js`/
  `gps-tracker.js`, no relacionados a este cambio).
- `npx vitest run`: 73 archivos, 1192 tests, sin regresiones (incluye el
  test nuevo de este cambio).
- No verificable en este entorno: correr la migración SQL contra Supabase
  real (sin red en este sandbox) — mismo patrón exacto que la migración
  180-días ya aplicada el 2026-08-28, solo se revisó sintaxis y lógica leyendo
  el código de las tablas/RLS originales (204, 247, 20260828041000).
