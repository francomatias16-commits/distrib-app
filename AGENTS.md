# AGENTS.md — reglas para agentes de IA en este repo

Este archivo es para cualquier agente (Claude Code, Cursor, Copilot, el reviewer
automático de CI, etc.) que trabaje sobre `distrib-app`. El objetivo es que
distintos agentes no se pisen entre sí y no repitan trabajo ya hecho, de la
misma forma en que ya lo resuelven `docs/changelogs/` y `docs/auditorias/`
para el trabajo humano.

Fase 3 del plan de CI/CD + agentes IA gratis para Fluxo.

## Antes de tocar código

1. Leé `docs/README.md` — es el mapa de toda la documentación del proyecto
   (changelogs, planes, auditorías, arquitectura). Ahorra repetir preguntas
   que ya están respondidas ahí.
2. Si el cambio toca un módulo grande, revisá si ya existe una auditoría en
   `docs/auditorias/AUDITORIA_2026/etapas_modulos/` para ese módulo antes de
   asumir cómo funciona o qué falta.
3. Si el cambio es parte de una iniciativa en curso, puede que ya haya un plan
   en `docs/planes/` — segui la numeración de fases que ya esté definida ahí
   en vez de inventar una nueva.

## Comandos que corren antes de abrir un PR

- `npm run predeploy` — chequeo de drift de migraciones, smoke test de
  frontend, wiring de assets/API/handlers. Es el mismo check que exige el CI.
- `npm test` — suite de Vitest.
- `npm run test:e2e` — Playwright, si el cambio toca flujos de UI.
- `npm run audit:all` — grants de seguridad + funciones fantasma. Corré esto
  si el cambio toca Supabase (tablas, RPCs, RLS) o rutas de permisos.

No hace falta correr manualmente `audit:mobile`, `audit:a11y` ni
`audit:lighthouse` en cada cambio — esos corren programados por cron en CI.

## Dónde va cada cosa

- Scripts nuevos de chequeo/auditoría → `scripts/`, siguiendo el patrón
  `audit-<algo>.js` / `check-<algo>.js` ya existente, con salida `--json`
  opcional si tiene sentido automatizarlo después.
- Documentación nueva → dentro de `docs/`, en la subcarpeta que corresponda
  (`planes/`, `auditorias/`, `reportes/`, `tecnico/`), no suelta en la raíz
  del repo. La raíz ya tiene años de archivos `.md` sueltos de antes de la
  reorganización del 25/08/2026 — no sumar más ahí.
- Changelogs → `docs/changelogs/`, siguiendo la numeración `vNNN` correlativa
  ya en uso. Si el changelog corresponde a una auditoría verificada contra
  código y DB en vivo (no solo contra lo que decía una auditoría anterior),
  va también referenciado en `docs/changelogs/reconciliados/`, que es la
  fuente de verdad del estado real del sistema.

## Módulos sensibles — confirmación humana obligatoria

En estos módulos, cualquier agente debe generar un PR chico y pedir
confirmación explícita a una persona antes de mergear — **aunque el reviewer
de IA (`ai-review.yml`) apruebe el PR sin objeciones**. El reviewer de IA es
informativo, no un gate de seguridad:

- Webhooks y cualquier lógica de Mercado Pago.
- Generación de comprobantes / facturación electrónica AFIP.
- Grants y políticas RLS de Supabase (cualquier migración que toque
  `GRANT`, `REVOKE`, `CREATE POLICY` o `ALTER POLICY`).
- Lógica de riesgo/scoring de cheques.

Para contexto de por qué estos módulos son sensibles, ver
`docs/auditorias/AUDITORIA_2026/etapas/02_seguridad_db.md`,
`docs/auditorias/AUDITORIA_2026/etapas_modulos/04_facturacion_afip.md` y
`docs/auditorias/AUDITORIA_2026/etapas/12_riesgo_cheques.md`.

## CI y el reviewer de IA

- `ci.yml` corre `predeploy + test` (chequeo obligatorio para mergear a
  `main`) y `e2e` (Playwright) en cada PR.
- `ai-review.yml` postea un comentario informativo con hallazgos del diff
  usando Gemini free tier. No bloquea el merge y no reemplaza revisión
  humana — ver la sección anterior para los módulos donde la revisión
  humana es obligatoria sin excepción.
- Si el reviewer de IA falla (cuota de Gemini agotada, error de red), el job
  igual pasa en verde — está diseñado para no bloquear nada. Si no ves el
  comentario en un PR, no es un problema del merge, solo faltó el insumo
  informativo.

## No repetir trabajo

Antes de auditar o investigar algo desde cero, buscá primero en:

- `docs/changelogs/INDEX.md` — por si ya se tocó esa parte del código antes.
- `docs/auditorias/AUDITORIA_2026/` — por si ya hay un hallazgo de seguridad
  o de arquitectura documentado sobre ese módulo.
- `docs/tecnico/ARQUITECTURA_ACTUAL.md` — por si la deuda técnica que estás
  por reportar ya está anotada ahí.

Si encontrás algo que contradice lo documentado, actualizá el documento
correspondiente en el mismo PR en vez de dejar dos fuentes de verdad
distintas conviviendo.
