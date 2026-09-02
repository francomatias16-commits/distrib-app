# v1006 — Etapa 1 del plan de robustez: branch protection activa (cierre)

## Contexto

`docs/planes/PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md` — Etapa 1.
El workflow `.github/workflows/ci.yml` (v1004) corría en cada push/PR desde
el 2026-08-29, pero no bloqueaba nada por sí solo: hacía falta marcarlo como
check requerido en GitHub, paso manual que solo el dueño del repo puede
hacer desde la UI (no ejecutable desde este entorno — sin token de GitHub
ni acceso a la API de rulesets).

## Cambio

Sin cambios de código. Luc configuró en GitHub → Settings → Rulesets un
nuevo ruleset sobre la rama por defecto (`main`):

- Enforcement status: **Active** (no `Disabled`).
- Target branches: `Default` (apunta a la rama por defecto del repo, hoy
  `main`, sin necesidad de tipear el nombre a mano).
- Bypass list: vacía — nadie puede saltarse la regla.
- Branch rules: `Restrict deletions` tildado (protege `main` de un borrado
  accidental) + `Require status checks to pass` con el check `predeploy +
  test` agregado, junto con `Require branches to be up to date before
  merging`.

Con esto, un PR con el check en rojo queda con el merge bloqueado en la UI
de GitHub — el gate de la Etapa 1 es real, no solo informativo.

## Estado

Etapa 1 del plan de robustez: **completa**. Ver tabla de estado y sección
correspondiente actualizadas en
`docs/planes/PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md`.

## Verificación

- Confirmado por Luc directamente en la UI de GitHub (capturas de pantalla
  del formulario de ruleset completo). No hay nada para correr en este
  entorno — es configuración de GitHub, no código del repo.
