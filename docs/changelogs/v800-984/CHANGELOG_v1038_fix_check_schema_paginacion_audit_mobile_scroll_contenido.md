# v1038 — Fix check-schema (paginación PostgREST) y audit-mobile (falsos positivos de scroll contenido) (2026-08-31)

## Por qué

Dos herramientas de auditoría interna daban resultados incorrectos, ambas
por no distinguir "esto se ve raro" de "esto está mal":

1. `npm run check-schema` reportaba 337 errores de tablas/columnas
   "inexistentes" (`usuarios`, `productos`, `rutas`, `stock`,
   `ventas_pos`, `whatsapp_*`, etc.) que en realidad sí existen en
   Supabase (proyecto `jgiquzjwoedmzwqgzubr`, confirmado vía MCP:
   `list_tables` devuelve 140+ tablas en `public`).

2. `npm run audit:mobile` marcaba 13 hallazgos P1 de overflow horizontal
   en `automatizacion` (`#tabla-reglas-auto`, `#tabla-tareas-auto`) y
   `pos` (`#pos-quickbar-admin`) que en realidad son scroll horizontal
   *a propósito* — ya resueltos en CSS (ver comentario
   `AUDITORIA-RESPONSIVE-ETAPA4` en `automatizacion.css`).

## `scripts/check-schema.js`

Causa: el RPC `check_schema_columns()` devuelve **1690 filas** (una por
columna, no por tabla — 156 tablas en total). PostgREST trunca
silenciosamente a ~1000 filas por respuesta (`db-max-rows`) cuando se
llama sin paginar. Como el RPC ordena `ORDER BY table_name,
ordinal_position`, el corte cae en `pos_favoritos` y todo lo
alfabéticamente posterior (`productos`, `refresh_tokens`, `rutas`,
`stock`, `usuarios`, `ventas_pos`, `whatsapp_*`, `zonas`...) desaparecía
del schema que el script comparaba contra el código — de ahí los 337
falsos positivos.

Fix: `fetchRealSchema()` y `fetchRealFunctions()` ahora paginan con
`.range()` en loop hasta agotar resultados, en vez de una sola llamada
sin límite.

## `scripts/audit-mobile.js`

Causa: el detector de overflow-x (`el.scrollWidth > vpWidth` +
`rect.width > vpWidth`) marcaba cualquier elemento renderizado más ancho
que el viewport, sin chequear si un ancestro ya lo contiene con scroll
horizontal a propósito (`overflow-x: auto`/`scroll` con el propio
ancestro entrando en el viewport) — el patrón correcto para tablas
anchas en mobile, usado en `#reglas-auto-card`/`#tareas-auto-card`
(automatizacion) y `.pos-quickbar` (pos).

Fix: nueva función `tieneAncestroScrollContenido(el)` — sube por los
ancestros del elemento; si encuentra uno con `overflow-x: auto`/`scroll`
cuyo propio `getBoundingClientRect().width` entra en el viewport,
descarta el hallazgo como scroll contenido a propósito. Si no encuentra
ninguno, se sigue reportando igual que antes (el overflow real que rompe
el layout de la página no se filtra).

## Pendiente

No pude re-correr ninguno de los dos scripts en el sandbox (sin
credenciales `.env` de Supabase para `check-schema.js`, sin Playwright
+ Chromium instalado para `audit-mobile.js`). Falta confirmar en la
máquina de Matías:

- `npm run check-schema` → debería bajar de 337 errores a los reales
  (posiblemente solo `productos-fotos`, que es un bucket de Storage,
  no una tabla).
- `npm run audit:mobile` → debería bajar de 13 hallazgos a 0 (o a
  overflow real, si lo hay, en páginas no revisadas todavía).
