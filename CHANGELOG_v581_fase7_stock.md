# v581 — Fase 7, paso 5: `lib/repos/stock.js` — cerrado

Continuación de `CHANGELOG_v580_fase7_permisos_pos.md`. Es el handler más
grande migrado hasta ahora en esta fase: 35 `.from()` directos, 1155 líneas,
6 sub-rutas absorbidas (stock, lotes, lotes-fefo, sugerencias,
cliente-categorias/productos, liquidación).

## Qué se hizo

- **`lib/repos/stock.js` (nuevo)** — 25 funciones cubriendo `stock`,
  `movimientos_stock`, `depositos`, `lotes`, `sugerencias_pedido`,
  `categorias`, `ofertas_liquidacion` y `reglas_liquidacion`, más un par de
  lecturas puntuales de `pedidos`/`pedido_items` que solo se usan desde acá
  (sugerencias FEFO). Sigue la convención ya usada en `cta-cte.js`/`productos.js`:
  se preserva tal cual la política de error de cada query original — algunas
  ignoran el error (devuelven `[]`/`null`), otras lo propagan para que el
  handler responda con `errorSeguro`. No se "mejora" de paso (checklist,
  punto 2).
- **Las 7 lecturas de `usuarios` que el handler resolvía a mano** (perfil/rol)
  se reemplazaron por `verificarToken(req, db)`, mismo patrón que `empresa.js`
  — no tienen función de repo propia.
- **`lib/handlers/stock.js` migrado a 0 `.from()` directos.**
- **2 hallazgos corregidos de paso** (mismo criterio que los de `empresa.js`
  y `cta-cte.js` — bug real de aislamiento entre empresas, no solo estético):
  - **Hallazgo 1** — el ajuste manual de stock (`tipo: ajuste/ingreso/egreso`)
    se resolvía con un select + upsert manual en el propio handler, sin
    validar que `producto_id`/`deposito_id` fueran de la empresa del usuario
    ni lock atómico (dos ajustes concurrentes podían pisarse). Se reemplazó
    por la RPC `ajustar_stock()` — la misma que ya usa el frontend para
    transferencias entre depósitos — que sí valida empresa y lockea la fila
    (`FOR UPDATE`) antes de escribir.
  - **Hallazgo 2** — al crear un lote se validaba `producto_id` contra la
    empresa pero no `deposito_id`, permitiendo crear un lote apuntando al
    depósito de otra empresa (dato inconsistente, aunque no movía stock
    ajeno). Se agregó `existeDepositoEnEmpresa()` y el chequeo
    correspondiente antes de `crearLote()`.

## Tests

- `tests/repos/stock.test.js` (nuevo, 45 casos) — una `describe` por función,
  cubriendo tanto el camino feliz como la política de error de cada una
  (silenciosa vs. propagada).
- Suite completa: **567/567 OK** (26 archivos de test).
- Confirmado `grep -c "\.from(" lib/handlers/stock.js` = 0.

## Checklist Fase 7 (`FASE7_PLAN_ARRANQUE.md`, sección 3) — completo para este módulo

1. ✅ Repo creado (25 funciones, `empresa_id` explícito en cada una)
2. ✅ Handler migrado sin cambiar comportamiento observable (expand-contract)
3. ✅ `grep -c "\.from(" lib/handlers/stock.js` → 0
4. ✅ Suite completa corrida (no solo el archivo tocado) — 567/567
5. ✅ Tests de repo nuevos, con foco en aislamiento por `empresa_id`
   (en particular los 2 hallazgos de cross-tenant de arriba)
6. ✅ Changelog por módulo — este documento

Con `stock` cerrado, quedan `pedidos`/`pos` como los dos únicos handlers
grandes de la sección 1 sin repo propio (ya con `PermisosService` aplicado
desde v579/v580) — el paso 6 del plan original.
