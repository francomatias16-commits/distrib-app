# v984 — Fix hallazgo #3 (3ra recurrencia) + test estructuralmente frágil

## Contexto
Al investigar las 2 fallas preexistentes de `tests/scripts/migraciones-orden.test.js` (reportadas en v983): no eran ruido de test, eran 2 problemas reales distintos.

## 1. Regresión real: SECNEW-01/02 sin prefijo (3ra recurrencia del hallazgo #3)

`fix_secnew01_aislamiento_empresa_crear_pedido_cliente.sql` y `fix_secnew02_revocar_funciones_expuestas_sin_caller.sql` (fixes de seguridad aplicados directo en producción vía MCP de Supabase, reconstruidos en el repo para trazabilidad — ver `AUDITORIA_2026/00_PLAN_MAESTRO.md`, filas SECNEW-01/02) habían llegado al repo **sin prefijo numérico** — exactamente el mismo patrón que causó el hallazgo #3 original (fase5/notifLog) y su reaparición en 540/541.

**Fix:** renombrados con timestamp:
- `20260824070000_fix_secnew01_aislamiento_empresa_crear_pedido_cliente.sql`
- `20260824070001_fix_secnew02_revocar_funciones_expuestas_sin_caller.sql`

Verificado: sin colisiones de número (`check-migraciones-registro.js`), sin referencias rotas (`check-asset-wiring.js`, `check-api-wiring.js`).

También corregidas 2 referencias desactualizadas en `00_PLAN_MAESTRO.md`:
- SECNEW-01: apuntaba al nombre viejo sin prefijo → actualizado al archivo real.
- SECNEW-02: describía "2 migraciones" (`...revocar_anon_auth...` + `...parte2_revocar_public_grant_residual`) que no existen en el repo — el archivo real es uno solo y el `REVOKE EXECUTE ... FROM PUBLIC` que ya trae cubre el privilegio heredado del pseudo-rol PUBLIC en un solo paso, sin necesitar una parte2 separada. Texto corregido para reflejar la realidad del repo.

## 2. Test estructuralmente frágil (assertion #4 removida)

La 4ta aserción de `migraciones-orden.test.js` comparaba el prefijo de fase5/notifLog contra **todas** las migraciones futuras con formato timestamp de 14 dígitos, excluyendo a mano una lista fija de archivos conocidos al momento de escribirla (v967). Cualquier migración nueva legítima agregada después (en este caso 542/543, sin relación con RLS) rompe la comparación para siempre — no detecta una regresión real, solo el paso del tiempo.

**Fix:** se eliminó esa aserción. El riesgo que buscaba cubrir ya queda cerrado por la 1ra aserción del mismo archivo (ningún `.sql` puede empezar con letras): una vez que todo archivo usa prefijo numérico, orden alfabético = orden numérico = orden cronológico real, sin necesidad de una lista de exclusiones que crece para siempre. Quedó documentado en el header del test para que no se reintente la misma aserción más adelante.

## Verificación
- Suite completa: **1096/1096 OK** (0 fallas)
- `check-migraciones-registro.js`: 421 archivos, 0 colisiones
- `check-asset-wiring.js`: 1767 referencias, 0 rotas
- `check-api-wiring.js`: 0 rotos

## Archivos en este delta
- `supabase/migrations/20260824070000_fix_secnew01_aislamiento_empresa_crear_pedido_cliente.sql` (renombrado)
- `supabase/migrations/20260824070001_fix_secnew02_revocar_funciones_expuestas_sin_caller.sql` (renombrado)
- `AUDITORIA_2026/00_PLAN_MAESTRO.md` (2 referencias corregidas)
- `tests/scripts/migraciones-orden.test.js` (aserción frágil removida + doc)
