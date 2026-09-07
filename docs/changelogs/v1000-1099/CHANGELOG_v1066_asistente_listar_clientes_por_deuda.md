# v1066 — Nueva tool del asistente: `listar_clientes_por_deuda`

Origen: Matías reportó que el asistente de ayuda respondía "No tengo una
forma de consultar eso todavía" ante "decime cuántos clientes tienen más
de 150000 en deuda" (ver screenshot del widget en el panel admin).

## Diagnóstico

No era un bug del selector de tools (`seleccionarToolsRelevantes` en
`lib/asistente-tools/index.js`) — ese motor elige bien entre las 98 tools
existentes por coincidencia de palabras clave. El problema es que
**ninguna tool de clientes hacía una consulta agregada sobre
`saldo_deuda`**. La única relacionada, `consultar_bloqueo_cliente`, busca
UN cliente puntual por nombre y devuelve su deuda individual — no había
forma de filtrar/contar/sumar sobre TODOS los clientes de la empresa a la
vez. Preguntas tipo "cuántos clientes deben más de $X" o "quiénes son los
que más deben" no matcheaban ninguna tool, y el modelo (siguiendo el
prompt del sistema, que le prohíbe inventar datos) contestaba que no
podía.

## Fix

- **Migración `597_asistente_listar_clientes_por_deuda.sql`** (aplicada
  directo en producción vía Supabase MCP, `jgiquzjwoedmzwqgzubr`): RPC
  `listar_clientes_por_deuda(p_empresa_id, p_monto_minimo DEFAULT 0,
  p_solo_activos DEFAULT true)`, mismo patrón que
  `listar_cheques_alerta`/`listar_lotes_por_vencer` (203):
  `SECURITY DEFINER`, `STABLE`, `search_path = public`, revocada de
  `PUBLIC`, otorgada a `service_role`. Devuelve `total_clientes` y
  `deuda_total_acumulada` sobre **todos** los clientes que matchean el
  filtro (no solo los que se muestran), y hasta 20 filas ordenadas de
  mayor a menor deuda. Verificada contra la empresa demo
  (`4462586e-e11a-4d34-a405-17103bb9cf9f`): con `monto_minimo=0` trae 66
  clientes por $1.112.906,81 acumulados; con 150000 da 0 clientes
  (correcto — el máximo real en esa demo es $146.531 de "La Familia", así
  que la pregunta original de Matías iba a devolver "0 clientes", no un
  error, una vez resuelto esto).

- **`lib/asistente-tools/clientes.js`**: nueva entrada
  `listar_clientes_por_deuda` en `TOOLS_CLIENTES`, roles
  `['dueno','admin','contador']` (mismo nivel que `listar_cobros`, que ya
  expone montos agregados de cobranza a esos tres roles). Parámetros:
  `monto_minimo` (number, default 0 si no lo dan) e `incluir_inactivos`
  (boolean, default false → solo activos). Descripción redactada con las
  frases típicas que dispara ("cuántos clientes tienen más de $X en
  deuda", "qué clientes me deben más", "ranking de deudores") para que
  matchee bien tanto en Gemini (catálogo completo) como en el segundo
  filtro por keywords de Groq/OpenRouter (`seleccionarToolsRelevantes`) —
  "cliente" y "deuda" en el nombre de la tool pesan 3 puntos cada uno ahí,
  por encima de cualquier otra tool de clientes.

- **`tests/asistente/listar-clientes-por-deuda.test.js`** (nuevo, 4
  tests): mismo patrón de mock que `clientes-formato-error.test.js`
  (mockea `lib/repos/_db.js`). Cubre: la tool existe y no requiere
  confirmación (es de solo lectura), llama a la RPC con el monto mínimo y
  `p_solo_activos: true` por default, usa `0` si no dan monto e
  `incluir_inactivos` invierte el flag, y propaga el error de la RPC con
  el prefijo `listar_clientes_por_deuda:`.

## Nota

No pude correr la suite completa de Vitest en el entorno de esta sesión
(`npm install` tiró `Cannot read properties of null (reading 'edgesOut')`
al intentar instalar dependencias) — el archivo nuevo pasa `node --check`
y la lógica de la RPC se verificó a mano contra la base real, pero
correr `npm test` localmente antes de deployar sigue pendiente de
confirmación.
