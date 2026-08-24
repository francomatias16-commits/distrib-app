# v897 — Fix: tarjeta "Resultado principal" cortaba el número (ej. $1.092.3...)

## Página
`rentabilidad-zona.html` ("Qué zona rinde más") → tarjeta hero "Resultado principal" (Margen neto).

## Causa raíz
`.kpi-card--hero .kpi-card__value` usaba un `font-size` fijo grande
(`clamp(27px, 2.5vw, 38px)`) combinado con `white-space: nowrap` y
`text-overflow: ellipsis`. Con montos de 7+ cifras (ej. "$1.092.300") el
texto no entraba en el ancho de la tarjeta y se cortaba con "...".

## Fix
- `js/rentabilidad-zona.js`: nueva función `claseTamanioValor(texto)` que
  agrega una clase modificadora según el largo del string formateado
  (`fmtPeso`). Se aplica al `<strong class="kpi-card__value">` de la
  tarjeta "Resultado principal".
- `css/rentabilidad-zona-gentelella.css`: nuevas reglas
  `.kpi-card__value--size-md` (montos de 11-13 caracteres) y
  `.kpi-card__value--size-sm` (14+ caracteres) que reducen el `font-size`
  dentro de la tarjeta hero, en desktop y en el breakpoint mobile de 480px.

Con esto el número siempre se ve completo: se achica automáticamente en
vez de truncarse, sin tocar el resto de las tarjetas KPI (que ya vienen
con textos más cortos).
