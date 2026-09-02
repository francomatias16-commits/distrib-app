# v1007 — Etapa 8 del plan de robustez: documento de capacidad + runbook

## Contexto

`docs/planes/PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md` — Etapa 8. No
existía ningún documento con "cuánto aguanta el sistema hoy" ni una secuencia
de pasos pensada de antemano para un incidente de latencia/504 en producción
— cada vez había que reconstruir el diagnóstico desde cero.

## Cambio

Nuevo `docs/operaciones/CAPACIDAD_Y_RUNBOOK.md`, con 4 secciones:

1. **Números de referencia de hoy**: plan de Vercel (Hobby, `maxDuration: 60`
   en `api/index.js`, retención de logs de 1h) y de Supabase (Free, 74/500 MB
   de storage, conexiones — todo tomado de la Etapa 7, no re-medido), más un
   resumen de qué ya está resuelto y no hay que re-diagnosticar: rate limiting
   distribuido (Etapa 11, tabla `rate_limits` + RPC atómico) y circuit
   breakers (Etapa 5, `wsaaBreaker`/`wsfev1Breaker`/`waBreaker`/`mpBreaker`).
2. **Qué falta**: honesto sobre que no hay todavía un número de "usuarios
   concurrentes soportados" — depende de que corras `npm run
   loadtest:etapa4` (Etapa 4, bloqueada en tus credenciales de prueba). Deja
   escrito qué actualizar en este mismo documento cuando eso pase.
3. **Runbook**: orden de diagnóstico por probabilidad de causa raíz —
   `get_runtime_logs`/`get_runtime_errors` (Vercel) → `get_advisors`
   (Supabase) → tabla `rate_limits` → estado de los circuit breakers →
   storage/conexiones. Incluye una nota de "qué NO es señal de alarma"
   (100% de éxito en `cron.job_run_details` con `net.http_post` no confirma
   nada — mismo patrón que causó el incidente OBS-03).
4. **Cuándo revisar este documento de nuevo**: al correr la Etapa 4, al
   pasar el 50% de storage, o al sumar el primer cliente real.

## Fuera de alcance

- Los números reales de carga (throughput, p95/p99 bajo tráfico simulado)
  quedan pendientes de que corras `loadtest:etapa4` — no se inventaron
  cifras para completar la sección.
- La Etapa 9 (observabilidad/`INTERNAL_PUSH_SECRET`) sigue pausada — la
  dejaste explícitamente para más adelante (secreto expuesto en texto plano
  en `08_observabilidad.md`, sin resolver).

## Verificación

- Todos los números citados en el documento están tomados directamente de
  secciones ya cerradas y verificadas del propio plan (Etapas 5, 6, 7, 11) —
  no son estimaciones nuevas.
