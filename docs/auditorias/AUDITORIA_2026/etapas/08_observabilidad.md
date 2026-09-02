# Etapa 8 — Observabilidad (logging, monitoreo, alertas de error)

**Estado:** 🟡 Cerrada con 1 pendiente de usuario (OBS-03).

> **Nota:** este archivo se reconstruyó a partir del historial de la sesión
> que cerró esta etapa — no venía incluido en el ZIP de partida.

## Crons — 100% de éxito reportado, pero el reporte no era confiable

Los crons del proyecto muestran 100% de éxito en `cron.job_run_details` en
los últimos 14 días. Pero el cron del email sender usa `net.http_post`
(asíncrono) — "succeeded" ahí solo confirma que la petición se **encoló**,
no que la función Edge realmente respondió bien.

Al revisar las respuestas HTTP reales (`net._http_response`): **18 de 24
llamadas recientes** a la función Edge `saas-email-sender` devolvieron
**401 (Unauthorized)** — solo 4 tuvieron éxito (200).

## OBS-03 (el hallazgo grave de esta etapa) — Notificaciones push fallando al 100%, en silencio

Investigando el mismo patrón de "éxito falso" en los triggers
`trigger_push_nuevo_pedido`/`trigger_push_stock_critico` (que llaman al
endpoint interno `/api/notif/push-interno` con un secreto `x-push-secret`):
el endpoint devolvía `{"error":"No autorizado"}` — rechazando el secreto.

**Causa raíz:** `internal_secrets.internal_push_secret` no tenía ninguna
fila. La migración que debía cargarlo (`100_push_interno_secret.sql`) es un
template con placeholders sin completar
(`'REEMPLAZAR_CON_EL_SECRETO_GENERADO'`, `'TU-PROYECTO.vercel.app'`) — nunca
se terminó de desplegar. Resultado: las notificaciones push de "nuevo
pedido" y "stock crítico" fallan el 100% de las veces, en silencio, desde
que se armaron estos triggers. El `EXCEPTION WHEN OTHERS THEN NULL` en los
triggers es correcto para no bloquear la venta/pedido, pero también hace que
nadie se entere.

**Fix aplicado (lado DB):** secreto generado y cargado en
`internal_secrets.internal_push_secret`:
```
a2ddf09d4a18321979fb91000ee73d9e30270e0b9e61c9afa8ad4ee0ff8644c7
```

**Pendiente (lado Vercel, acción del usuario):** cargar
`INTERNAL_PUSH_SECRET` con ese mismo valor exacto en las variables de
entorno de Vercel y redeployar — sin esto, el fix no tiene efecto real. Ver
seguimiento y checklist en `00_CIERRE_AUDITORIA.md`.

## Cobertura de auditoría (`fn_audit_generic`)
Verificada: 8 tablas críticas con trigger de auditoría — cobertura
suficiente.

## Sin resolver, no urgente
No hay ningún servicio de error tracking/alertas (todo depende de mirar logs
de Vercel a mano) — queda como recomendación, no se resolvió porque es una
decisión de costo/producto, no algo para decidir unilateralmente.

## Verificación de cierre
- `cron.job_run_details` vs. `net._http_response` comparados directamente
  para detectar el gap entre "encolado" y "realmente exitoso".
- Secreto generado con una fuente criptográficamente segura y cargado en
  producción vía `execute_sql`/`apply_migration`.
- Pendiente de verificación final: confirmar que `net._http_response` pase
  de 401 a 200 una vez que el usuario complete el lado de Vercel.
