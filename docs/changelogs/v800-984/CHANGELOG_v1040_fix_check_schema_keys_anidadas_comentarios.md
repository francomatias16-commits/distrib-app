# v1040 — Fix check-schema: keys anidadas en jsonb y comentarios de documentación (2026-08-31)

## Por qué

Tras v1039, `check-schema` bajó a 6 errores. Los dos casos restantes eran
también falsos positivos del checker, no bugs de la app:

**`frontend/admin/js/fidelizacion.js:208`** — reportaba que `premium`,
`bueno`, `normal`, `riesgo`, `bloqueado` no existen en
`programas_fidelizacion`. Real: son keys **dentro** del valor jsonb
`bonus_pct_categoria` (columna real, `data_type: jsonb`, verificado
contra `information_schema.columns`), no columnas de la tabla.

**`frontend/admin/js/ui-utils.js:653`** — reportaba `RPC 'fn_x' no
existe`. Real: `fn_x` aparece solo en un comentario de documentación
(`// Uso: window.conTimeoutRed(window.supabaseClient.rpc('fn_x', {}),
10000)`), no en código ejecutándose.

## Causa y fix

1. **`parseObjectKeys()` no distinguía profundidad.** Tomaba cualquier
   `key:` como columna top-level, incluso dentro de un objeto anidado.
   Ahora parte el body del objeto por comas de nivel superior (mismo
   criterio que ya usaba `parseSelectCols()` para paréntesis anidados) y
   solo extrae la key de cada segmento top-level.

2. **La captura del objeto de `.insert()/.update()/.upsert()` cortaba
   en la primera `}`** (regex `[^}]{0,800}`), que con un valor anidado
   es el cierre del objeto interno, no el del objeto completo — además
   de la confusión de keys, esto también podía perder columnas
   top-level que vinieran DESPUÉS del valor anidado. Nuevo helper
   `extractBalancedBraces()` cuenta llaves para encontrar el cierre real
   del objeto.

3. **El scanner no ignoraba comentarios.** `extractReferences()` ahora
   vacía (preservando el salto de línea, para no correr los números de
   línea del resto del archivo) cualquier línea que sea 100% comentario
   (`// ...`) antes de correr los regex — no toca comentarios al final
   de una línea de código real, para no arriesgar falsos negativos por
   strings con "//" (URLs, etc.).

Verificado con un harness standalone que aísla `extractReferences()` y
la corre sobre ambos archivos reales: `fidelizacion.js:208` ahora
extrae exactamente `empresa_id`, `bonus_pct_categoria`, `updated_at`
(las 3 columnas reales, de yapa ahora también detecta `updated_at`, que
antes se perdía por el corte prematuro); `ui-utils.js` ya no reporta
ningún `rpc`.

## Estado acumulado (v1038 → v1040)

337 errores → 142 (fix paginación) → 6 (fix ventana de búsqueda) → 0
esperados (fix keys anidadas + comentarios), sobre el mismo código real
sin cambios — los 337 originales eran, en su totalidad, ruido del
checker, no deuda técnica real del proyecto.

## Pendiente

No pude re-correr `npm run check-schema` completo en el sandbox (sin
`.env` con credenciales de Supabase). Falta la corrida final contra los
193 archivos para confirmar 0 errores.
