# Plan robusto y gratuito: CI/CD + agentes IA para Fluxo

> Adaptado al repo real de Fluxo (`distrib-app`): Node 24, Express, Supabase, Vercel, Vitest, Playwright E2E, scripts de auditoría propios, y workflows de backup/restore de Supabase.

> **Última verificación de estado: 06/09/2026.** Los estados marcados como ✅ fueron confirmados directamente en el repo/GitHub (no repetir el chequeo). Los marcados ⏳ siguen pendientes de implementar o verificar.

---

## 0. Diagnóstico de partida (histórico, ya superado)

Esta sección quedó desactualizada respecto al estado real del repo — se mantiene solo como referencia histórica del punto de partida. El estado real y verificado está en las tablas de cada fase, más abajo.

---

## Fase 0 — Enchufar lo que ya existe

**Estado general: ✅ COMPLETA**

| Punto | Estado | Detalle |
|---|---|---|
| Job de Playwright E2E en `ci.yml` | ✅ Confirmado | Job `e2e (playwright)` ya integrado, corre en push/PR a `main`, instala Chromium, sube traces como artifact si falla. |
| Branch protection en `main` | ✅ Confirmado | Ruleset "main" activo con `deletion`, `non_fast_forward` y `required_status_checks`. |
| E2E como check bloqueante | ✅ Agregado 06/09/2026 | Se sumó `e2e (playwright)` a `required_status_checks` (antes solo exigía `predeploy + test`). |
| Cron de auditorías existentes con issues automáticos | ✅ Implementado y mergeado 06/09/2026 | Workflow `.github/workflows/scheduled-audits.yml`, corre lunes 06:00 UTC + `workflow_dispatch`, ejecuta `audit:security`, `audit:mobile`, `audit:a11y`, `audit:lighthouse`, sube logs como artifact, abre/comenta issue con label `audit-automatico` si algo falla. Revisado por el reviewer IA sin objeciones bloqueantes. |
| Dependabot alerts | ✅ Activado 06/09/2026 | |
| Dependabot security updates | ✅ Activado 06/09/2026 | |
| Dependabot malware alerts | ✅ Activado 06/09/2026 | |
| Grouped security updates | ✅ Activado 06/09/2026 | |
| Dependency graph | ✅ Activado 06/09/2026 | Prerequisito de Dependabot, ya activo. |
| Dependabot version updates | ⏳ No activado (opcional) | No crítico: cubre solo desactualización, no vulnerabilidades. Se puede dejar apagado. |
| Secret scanning (Secret Protection) | ✅ Activado 06/09/2026 | |
| Push protection | ✅ Activado 06/09/2026 | Bloquea el push antes de que el secreto llegue a existir en el historial. |
| CodeQL analysis | ⏳ No configurado (opcional, evaluar aparte) | No urgente; requiere setup dedicado para JS/Node y puede generar falsos positivos. |
| gitleaks como job de CI adicional | ⏳ No verificado | El plan lo proponía como complemento al secret scanning nativo. No confirmado si existe como job en `ci.yml`. |

**Pendiente real de Fase 0:** solo `gitleaks` como job de CI (opcional/complementario, ya que el secret scanning nativo + push protection cubren lo esencial).

---

## Fase 1 — Reviewer de código con IA, gratis, como gate en los PRs

**Estado general: ✅ YA IMPLEMENTADA (descubierto en el repo, no estaba marcada como hecha)**

| Punto | Estado | Detalle |
|---|---|---|
| Workflow `ai-review.yml` | ✅ Confirmado existente | Vía Gemini free tier, tal como proponía la Opción A del plan. |
| Modo informativo (no bloquea merge) | ✅ Confirmado | El bot comenta "Revisión automática (IA, modo informativo)" y aclara explícitamente que no bloquea el merge. |
| Calidad de las observaciones | ✅ Verificado en la práctica | Detectó correctamente falta de permisos `issues: write` y mala práctica de interpolar output directo en script (en el PR de `scheduled-audits.yml`); tras corregir, marcó "sin objeciones bloqueantes". |
| Revisión humana obligatoria en módulos sensibles (Mercado Pago, AFIP, RLS Supabase, riesgo de cheques) | ✅ Confirmado 06/09/2026 | Documentado explícitamente en `AGENTS.md`: estos módulos requieren PR chico + confirmación humana explícita, "aunque el reviewer de IA apruebe el PR sin objeciones". Ver detalle completo en Fase 3. |

**Pendiente real de Fase 1:** ninguno.

---

## Fase 2 — Aproximación gratuita al "agente recorriendo pantallas"

**Estado general: ✅ PRÁCTICAMENTE COMPLETA (verificado en detalle 06/09/2026, código leído línea por línea)**

| Punto | Estado | Detalle |
|---|---|---|
| E2E determinístico en CI | ✅ Confirmado (mismo punto que Fase 0) | |
| Workflow `ai-explore-screens.yml` | ✅ Verificado completo | Cron lunes 13:00 UTC (10:00 Argentina) + `workflow_dispatch` con inputs opcionales (`paginas`, `viewports`). Permisos ajustados (`contents: read`, `issues: write`). Sube screenshots como artifact (`if: always()`, 14 días). |
| Script `scripts/ai-explore-screens.js` (500 líneas) | ✅ Verificado completo | Reusa infraestructura del E2E (server estático, mocks de Supabase/API, helper de login) en vez de duplicar setup. |
| Exploración con visión (LLM mirando screenshots) | ✅ Confirmado | Screenshot en base64 vía `inline_data` a Gemini con visión. Prompt bien acotado: pide defectos visuales concretos, con instrucción explícita anti-alucinación ("verificá dos veces antes de reportar", "preferimos menos hallazgos reales a una lista larga inventada"). |
| Apertura automática de issues por findings | ✅ Confirmado, con mejora extra no pedida | `upsertIssue` usa un marcador oculto para actualizar siempre el mismo issue (no duplica por corrida) y lo **cierra automáticamente** si una corrida no encuentra hallazgos. |
| Trigger: manual o cron semanal (no en cada commit) | ✅ Confirmado | Igual que la tabla del workflow arriba. |
| Rotación de las 5 API keys de Gemini | ✅ Ya implementada, bien diseñada | Distingue cuota realmente agotada (chequea el texto específico del error 429 de Google) de un 503/429 transitorio (reintenta con backoff antes de rotar). Solo pasa a la siguiente key cuando la cuota está agotada de verdad. Tras agotar las 5 keys, recién ahí cae al modelo de respaldo (`GEMINI_FALLBACK_MODEL`). |
| Control de cuota/costo | ✅ Confirmado | `EXPLORE_DELAY_MS` entre llamadas (~13 req/min default) + subset curado de 12 páginas por defecto (no las 52 totales del E2E) + 2 viewports de escritorio por defecto. |
| Origen de las 5 API keys | ⚠️ Zona gris de ToS, no bloqueante | Confirmado por el usuario: cuentas de Google distintas (no proyectos dentro de la misma cuenta). No se encontró una cláusula explícita de Google que lo prohíba, pero tampoco hay garantía — riesgo operativo de suspensión, no legal. Se deja como está por decisión del usuario. |

**Detalle de calidad adicional (no pedido por el plan, pero presente):** los comentarios del código documentan bugs reales que el propio script detectó en producción (fragmentación de `.filtros-der` a 1846px, falso positivo de un spinner de carga interpretado como superposición) — evidencia de que ya se usó y ajustó con casos reales, no es código sin probar.

**Pendiente real de Fase 2:** nada bloqueante. Mejora opcional menor: agregar una línea de resumen al final del log del job (ej. "Total: 4 hallazgos en 2 páginas") para escanear rápido sin abrir el issue — cosmético, no urgente.

---

## Fase 3 — Reglas para que los agentes no se pisen entre sí

**Estado general: ✅ COMPLETA (contenido completo verificado 06/09/2026)**

| Punto | Estado | Detalle |
|---|---|---|
| `AGENTS.md` en la raíz del repo | ✅ Confirmado | 93 líneas, mergeado a `main`. |
| Convenciones del proyecto documentadas | ✅ Confirmado | Dónde van scripts nuevos (`audit-<algo>.js`/`check-<algo>.js` con `--json` opcional), dónde va documentación nueva (subcarpetas de `docs/`, no la raíz), numeración de changelogs (`vNNN` correlativo) y la fuente de verdad reconciliada (`docs/changelogs/reconciliados/`). Incluye también qué comandos correr antes de un PR (`predeploy`, `test`, `test:e2e`, `audit:all` si toca Supabase) y aclara que `audit:mobile`/`a11y`/`lighthouse` NO hace falta correrlos a mano porque ya van por cron. |
| Módulos sensibles marcados explícitamente (pagos, AFIP, cheques, grants Supabase) | ✅ Confirmado, cierra también el pendiente de Fase 1 | Lista exacta: webhooks/lógica de Mercado Pago, comprobantes/facturación AFIP, grants y políticas RLS de Supabase (`GRANT`, `REVOKE`, `CREATE POLICY`, `ALTER POLICY`), lógica de riesgo/scoring de cheques. Texto explícito: *"aunque el reviewer de IA apruebe el PR sin objeciones"* — confirma que el reviewer IA de la Fase 1 no es gate de seguridad en estos módulos. |
| Referencia cruzada a `AUDITORIA_2026/` | ✅ Confirmado, con precisión mayor a la esperada | No es una referencia genérica: cada módulo sensible apunta a su documento específico (`02_seguridad_db.md`, `04_facturacion_afip.md`, `12_riesgo_cheques.md`). |

**Pendiente real de Fase 3:** ninguno.

---

## Qué NO conviene automatizar al 100% todavía

Sigue vigente sin cambios — no se tocó ni verificó en esta ronda de trabajo:

- Webhooks y lógica de Mercado Pago.
- Generación de comprobantes AFIP.
- Grants y políticas RLS de Supabase.
- Lógica de riesgo/scoring de cheques.

---

## Resumen de gratuidad y límites a vigilar

Sigue vigente sin cambios respecto al plan original:

| Pieza | Se logra gratis con | Límite a vigilar |
|---|---|---|
| CI (Vitest + Playwright E2E) | GitHub Actions (plan free) | ~2000 minutos/mes en cuenta free |
| Reviewer IA en PRs | Gemini API (free tier) | Cuota diaria de requests |
| Backups de DB | Ya implementado (cron en GH Actions) | — |
| Hosting | Vercel Hobby (ya en uso) | Bandwidth y cantidad de builds del plan free |
| Base de datos | Supabase (verificar plan actual) | Tamaño de DB y pausa por inactividad en free tier |
| Secret scanning | GitHub Secret Protection + Push protection (ya activos) | Gratis también en repos privados |
| Exploración con IA + visión | Notebook prendida puntualmente + Gemini free tier (posible rotación de 5 keys) | Cuota de requests con imágenes, más limitada que solo texto |

---

## Orden actualizado de lo que falta (06/09/2026)

**Las 4 fases del plan están completas.** No queda ningún pendiente bloqueante ni de seguridad. Solo quedan dos mejoras cosméticas/opcionales, sin urgencia:

1. Evaluar si sumar `gitleaks` como job de CI complementario al secret scanning nativo (ya activo). Redundante en gran parte, no urgente.
2. Línea de resumen al final del log de `ai-explore-screens.js` (ej. "Total: N hallazgos en M páginas") para escanear el log del Action sin abrir el issue. Cosmético.
3. `Dependabot version updates` sigue sin activar — opcional, cubre solo desactualización sin vulnerabilidad, no crítico.

---

## Historial de cambios de este documento

- **06/09/2026 (primera pasada)**: Se verificó y marcó el estado real de Fase 0 (completa), Fase 1 (ya implementada, no detectada antes), Fase 3 (completa a nivel de existencia del archivo, contenido no verificado en detalle). Se dejó Fase 2 como próximo tema a tratar.
- **06/09/2026 (segunda pasada)**: Se leyó el contenido completo de `ai-explore-screens.yml` y `ai-explore-screens.js` (500 líneas). Fase 2 confirmada como prácticamente completa: visión con Gemini, rotación de 5 keys bien implementada (distingue cuota agotada de error transitorio), apertura/cierre automático de issues, control de costo de cuota. Se confirmó con el usuario que las 5 API keys son de cuentas de Google distintas (no proyectos de una misma cuenta) — zona gris de ToS sin cláusula explícita encontrada que lo prohíba, riesgo operativo (no legal) de suspensión, se mantiene por decisión del usuario.
- **06/09/2026 (tercera pasada)**: Se leyó el contenido completo de `AGENTS.md` (93 líneas). Fase 3 confirmada completa: convenciones documentadas, módulos sensibles listados explícitamente con la excepción al reviewer IA, referencias cruzadas específicas (no genéricas) a `AUDITORIA_2026/`. Esto cierra también el único pendiente que quedaba abierto en Fase 1. **Con esto, las 4 fases del plan quedan completas** — solo restan 3 mejoras opcionales sin urgencia, listadas arriba.
