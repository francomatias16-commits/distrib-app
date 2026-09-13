# v1081 — `test:integration` y `test:e2e` corrieron en verde, cierre de B4, 2026-09-13

Sin cambios de código. Es un changelog de verificación.

## Contexto

`CHANGELOG_v1080_b4_b5_via_mcp_supabase.md` había dejado `audit:dinero`
mayormente en verde vía MCP, pero con dos pasos genuinamente pendientes
porque no eran reproducibles desde el sandbox de este chat:

- `test:integration` — hace ~45 operaciones reales de insert/delete
  (incluyendo un usuario de Auth real) vía SDK, no vía SQL directo, y el
  script tiene una guarda anti-producción que detecta el proyecto
  `jgiquzjwoedmzwqgzubr` y se niega a correr salvo `--allow-prod` explícito.
- `test:e2e` — necesita Playwright/Chromium, sin salida de red a su
  servidor de descargas ni herramienta de browser en el sandbox.

## Qué se corrió y resultado

| Paso | Cómo se corrió | Resultado |
|---|---|---|
| `test:integration -- --allow-prod` | Desde el entorno de Cristian, contra `jgiquzjwoedmzwqgzubr` (producción), asumiendo el flag explícito y las escrituras/deletes reales que implica | ✅ Verde |
| `test:e2e` | Desde el entorno de Cristian, con Playwright/Chromium disponible | ✅ Verde |

## Estado de B4 tras esto

Con estos dos últimos pasos en verde, `audit:dinero` queda verificado de
punta a punta (los 6 pasos estáticos vía MCP + `test:integration` +
`test:e2e`). Lo único que sigue pendiente de B4 es sumarlo como paso de
`predeploy`/hook de CI — eso es una decisión de tooling, no una
verificación que falte hacer.

## Lo que sigue pendiente en el plan general

- Sumar `audit:dinero` (o su parte estática) a `predeploy`/CI.
- B1 (pase manual en navegador real) — sigue bloqueado en este chat por
  falta de herramienta de browser.
- B5 (cron de conciliación) — en pausa por falta de objeto, sin cambios
  respecto a `CHANGELOG_v1080`.
