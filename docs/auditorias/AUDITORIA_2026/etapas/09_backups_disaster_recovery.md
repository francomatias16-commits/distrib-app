# Etapa 9 — Backups y disaster recovery

**Estado:** 🟢 Mitigado — decisión de negocio tomada (Free + backup casero),
backup automatizado corriendo en verde desde 2026-08-16 (ver
`09b_backup_automatizado_setup.md` para los 3 bugs encontrados y resueltos).
Único pendiente real: probar una restauración completa contra un proyecto
de prueba.

## BACKUP-01 (crítico) — El proyecto está en plan Free de Supabase: cero backups, sin PITR, sin SLA

Verificado directamente vía API de Supabase (`get_organization`): la organización
`distribuidora_prueba` está en **plan `free`**. Se confirmó contra la
documentación oficial y varias fuentes actuales (julio 2026) que el plan Free
de Supabase:

- **No tiene backups automáticos de ningún tipo** (ni diarios ni PITR) — eso
  es exclusivo de Pro ($25/mes, 7 días de retención) en adelante.
- No tiene SLA.
- Los proyectos se pausan automáticamente tras 7 días sin actividad (no es un
  riesgo hoy porque el proyecto tiene actividad constante).
- Límite de 500 MB de base de datos — hoy se usan **65 MB (13%)**, margen
  cómodo por ahora pero a vigilar con el crecimiento planeado (300-400
  clientes empresariales).

**Impacto real:** esta base tiene datos financieros reales de producción
(cta_cte, facturas, cobros, cheques — miles de filas, plata real de clientes
reales) sin ninguna posibilidad de restaurar ante:
- Un `DELETE`/`UPDATE` sin `WHERE` por error humano.
- Un bug en una función `SECURITY DEFINER` que borre de más (recordar
  `migracion_deshacer_sesion`, que ya fue un hallazgo de seguridad en la
  Etapa 2 — un bug ahí sin backup detrás es directamente irrecuperable).
- Corrupción de datos, ransomware, o cualquier incidente de la cuenta.

Hoy, si algo de esto pasa, **no hay ningún camino de vuelta** — salvo el
backup casero implementado (ver más abajo).

**Opciones evaluadas, de más a menos robusta:**
1. **Upgrade a Pro ($25/mes)**: backups diarios automáticos con 7 días de
   retención, más la opción de habilitar PITR (recuperación a cualquier
   segundo, plan adicional).
2. **Quedarse en Free + backup propio**: automatizar `pg_dump`/`supabase db
   dump` con un cron externo (GitHub Actions) hacia GitHub Actions artifacts
   — cero costo de Supabase pero mantenimiento propio, sin PITR.
3. **No hacer nada**: no recomendable dado el estado del proyecto.

**Decisión tomada (2026-07-11):** opción 2 — **Free por ahora, con backup
casero como red mínima.** Implementado en
`etapas/09b_backup_automatizado_setup.md`
(`.github/workflows/backup-supabase.yml`, semanal, GPG + artifact 90 días).
Con esta decisión, **probar la restauración de un backup real queda como la
mitigación más importante pendiente** — sin PITR, el backup semanal es la
única red de seguridad real, y nunca se verificó que el proceso de
restauración funcione de punta a punta.

## Verificación de cierre
- Plan confirmado vía `get_organization` (Supabase Management API).
- Tamaño de la base confirmado vía `pg_database_size()`.
- Política de backups del plan Free confirmada contra documentación oficial
  de Supabase (julio 2026) y múltiples fuentes independientes actuales.
- Decisión de negocio (Free + backup casero) registrada explícitamente por
  el usuario — no es un default por omisión.
