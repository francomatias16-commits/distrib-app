# CHANGELOG v321 — Estados críticos visibles en el dashboard (+ bug de fondo en score)

## Contexto

Al implementar "que en el dashboard también se visualicen estados críticos"
se encontró que el problema no era solo de visualización: **la función
`calcular_score_cliente()` venía fallando en el 100% de sus llamadas desde
el 24/06/2026** (migración 092), por columnas inexistentes en dos INSERTs.
Confirmado en vivo contra producción (`jgiquzjwoedmzwqgzubr`).

## 1. Migración `318_fix_alertas_score_columnas_inexistentes.sql` (aplicada)

Tres bugs en la misma función, los tres heredados de la migración 092:

1. **`INSERT INTO scores_cliente`** usaba `score_categoria` (no existe en
   esa tabla) y `motivo` (la columna real es `motivo_cambio`). Esto
   abortaba la función completa, para TODOS los clientes, en cada llamada
   — no solo los críticos.
2. **`INSERT INTO alertas_score`** usaba `score, categoria, motivo,
   resuelta` — ninguna de esas columnas existe. El esquema real es
   `score_anterior, score_nuevo, mensaje`.
3. **`UPDATE clientes`** dejó de escribir `score_actual` y
   `score_actualizado` (solo tocaba `score_categoria`). Nada más en el
   sistema escribe esas columnas, así que quedaban congeladas — rompiendo
   el número mostrado en `clientes.js` y en Motor 5 de `automatizacion.js`.

**Fix:** los tres INSERT/UPDATE corregidos a las columnas reales. Se
mantiene intacto el cálculo (componente Pagos con el join vía `factura_id`,
Frecuencia, Deuda, Devoluciones) — ese estaba bien. El disparo de alerta
ahora cubre dos casos (categoría crítica ahora, o caída de 15+ puntos) y no
duplica alertas sin resolver del mismo cliente.

**Acciones ya ejecutadas sobre producción como parte de este fix:**
- Recalculado masivo de los ~1580 clientes con categoría legacy A/B/C/D
  (estaban congelados por el bug). Resultado real: **10 clientes pasaron a
  `riesgo`**, el resto a categorías válidas.
- Validado el constraint `chk_score_categoria` (migración 317) — ya no
  quedan filas fuera de dominio, ni siquiera entre clientes inactivos (125
  normalizados manualmente por no requerir recálculo de score).
- 62 alertas en `alertas_score` quedaron sin resolver y ahora sí son
  legibles por el widget "Alertas de Nivel de Confianza de Clientes" del
  dashboard (antes rotas por el mismo bug de columnas).

## 2. `lib/handlers/admin.js` — `handleResumenArranque` (zona 1, tarjeta "🔥")

Se agrega un cuarto conteo (`clientes_score_critico_count`) junto a stock
crítico y deuda vencida, usando el mismo criterio real
(`score_categoria IN ('riesgo','bloqueado')`) que ya usa el Motor 5.

## 3. `lib/handlers/admin.js` — `handleAlertas` (panel de notificaciones)

Se agrega un quinto bloque que lista hasta 5 clientes en riesgo/bloqueado
(los de score más bajo primero), mismo patrón que la alerta de cheques
vencidos, con link directo a la ficha del cliente.

## 4. `frontend/admin/js/dashboard-optimizado.js`

- `renderResumenArranque`: `totalFuego` ahora suma también
  `clientes_score_critico_count`; el detalle de la tarjeta muestra la
  tercera línea "N clientes en riesgo/bloqueado (score)".
- `iconoAlerta`: nuevo ícono para `tipo: 'score_critico'` en la lista de
  alertas (mismo ícono de barras que ya usa el widget de confianza).

## Archivos modificados
- `supabase/migrations/318_fix_alertas_score_columnas_inexistentes.sql` (nuevo, aplicado)
- `lib/handlers/admin.js`
- `frontend/admin/js/dashboard-optimizado.js`

## Pendiente / a tu criterio
- El link de la tarjeta "🔥" (`#seccion-stock-critico`) sigue apuntando solo
  a la sección de stock — no lo cambié porque es un ancla dentro de la
  misma página, no un filtro como `stock.html?filtro=...`. Si querés un
  link directo a clientes en riesgo desde ahí, decime y lo agrego.
- El widget "Alertas de Nivel de Confianza de Clientes" ya funcionaba en el
  frontend (dashboard-optimizado.js) — el bug estaba 100% en la función SQL
  que nunca lograba insertar filas nuevas ahí. No hizo falta tocar ese JS.
