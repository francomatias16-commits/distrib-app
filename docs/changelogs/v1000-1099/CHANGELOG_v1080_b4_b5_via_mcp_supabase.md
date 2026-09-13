# v1080 — B4/B5 avanzados vía MCP de Supabase (sin credenciales manuales), 2026-09-13

Sin cambios de código. Es un changelog de verificación.

## Contexto

B4 (`audit:dinero` completo) y B5 (conciliación recurrente) estaban marcados
como bloqueados por falta de credenciales reales de Supabase en este chat.
Apareció una vía alternativa: este chat tiene el conector de Supabase (MCP)
conectado a la cuenta real de Cristian, con acceso a `jgiquzjwoedmzwqgzubr`.
Eso permite correr SQL real contra producción sin pegarle por red desde el
sandbox de bash (que no tiene salida a `*.supabase.co`).

## Qué se corrió y resultado

| Paso de `audit:dinero` | Cómo se corrió | Resultado |
|---|---|---|
| `npm test` | Local (`npx vitest run`) | 145/145 archivos, 2024/2024 tests OK |
| `check:migrations` | Local | 500 archivos, 0 colisiones reales |
| `check-wiring:all` (asset+api+handler-dispatch) | Local | 0 rotos en los 3 checks |
| `audit:security` (`audit_security_definer_grants`, `audit_views_security_invoker`) | SQL directo vía MCP contra producción | 0 hallazgos de riesgo en ambas |
| `audit:funciones-fantasma` (`audit_funciones_vivas()`) | SQL vía MCP + comparación local contra `supabase/migrations/` (500 archivos) | 314 funciones vivas, 0 fantasmas |
| `check-schema` (código vs. DB real) | Schema real (165 tablas) + RPCs (314) traídos vía MCP, corridos contra la lógica real de `check-schema.js` (200 archivos JS, 623 referencias) | 0 errores de sincronización |
| Etapa 4 — conciliación (antes B5) | `conciliar_cta_cte`, `conciliar_stock_por_producto`, `conciliar_stock_por_deposito` corridas vía MCP contra el único tenant no-demo con actividad real ("matias franco", `a274fe77-…`) | 0 diferencias en las 3 |
| `test:integration` | **No corrido** — hace escrituras/rollbacks reales vía SDK de `@supabase/supabase-js`, no vía SQL directo; no reproducible por MCP sin reescribir el script | Pendiente desde tu entorno |
| `test:e2e` | **No corrido** — requiere Playwright/browser, no disponible en este chat | Pendiente desde tu entorno |

## Nota sobre el tenant usado para conciliación

Se relevaron todas las empresas no-demo: la inmensa mayoría (Maribel
distribuciones, Distribuidora Desing, distribuidora del sol, distri gas,
Studio Proveedores, Selecta Studio) tienen 0 pedidos/0 movimientos — ningún
cliente real está operando todavía. La única con historial real es la
empresa de prueba **"matias franco"** (11 pedidos, 31 movimientos de stock,
7 movimientos de cta_cte, 5 ventas POS) — se usó esa para ejercitar las 3
RPCs de conciliación de punta a punta contra datos reales.

## B5 — decisión

Agendar la conciliación en un cron/`predeploy` no tiene sentido hoy: no hay
ningún cliente real generando movimientos contra los cuales conciliar
periódicamente. Queda documentado como "listo para activar" el día que el
primer cliente real esté operando — no como pendiente de código.

## Lo que sigue genuinamente bloqueado

- `test:integration`/`test:e2e` completos, de punta a punta, desde tu
  máquina o una sesión con Playwright disponible.
- Sumar `audit:dinero` (o al menos su parte estática) como paso de
  `predeploy`/hook de CI — decisión de tooling, no de verificación.
- B1 (pase manual en navegador real) — sigue igual que antes, sin
  herramienta de browser en este chat.
