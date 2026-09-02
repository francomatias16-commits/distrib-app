# Documentación del proyecto

Reorganizada el 25/08/2026 para que sea navegable — antes había ~450
archivos `.md` sueltos en la raíz del repo.

| Carpeta | Contenido |
|---|---|
| [`changelogs/`](changelogs/INDEX.md) | Historial completo de cambios, ~452 entradas indexadas por versión. Empezar por `reconciliados/` (fuente de verdad verificada contra código y DB en vivo). |
| [`planes/`](planes/) | Planes de trabajo por iniciativa (ERP, offline, E2E, asistente por voz, etc.) |
| [`auditorias/`](auditorias/) | Auditorías de seguridad, UX, bugs, CRUD/tablas. Incluye `AUDITORIA_2026/`, la auditoría estructurada por etapas. |
| [`reportes/`](reportes/) | Reportes de cierre, seguimiento de hoja de ruta, testing, diseño. |
| [`tecnico/`](tecnico/ARQUITECTURA_ACTUAL.md) | Arquitectura actual, deuda de escalabilidad, snapshots de esquema de base de datos, tracking de reskin de UI. |
| [`producto/`](producto/) | Manual de usuario, soporte, SLA, guion de walkthrough. |

## Por dónde empezar

- **¿Qué se hizo últimamente?** → `changelogs/reconciliados/` y `changelogs/v800-984/`.
- **¿Qué falta y por qué?** → `tecnico/ARQUITECTURA_ACTUAL.md` (código) y `reportes/SEGUIMIENTO_CHANGELOGS_SUELTOS_2026-08-25.md` (pendientes históricos).
- **¿Cómo está organizado el sistema?** → `planes/` para la visión de cada iniciativa grande.
