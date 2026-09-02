# v501 — Asistente: búsqueda aproximada (pg_trgm) para clientes/productos

## Qué cambia

`crear_pedido` (v500) resolvía cliente/producto por texto libre con un
ILIKE `%texto%` exacto. Con pedidos dictados por voz, un reconocimiento que
transcribe mal un nombre propio ("El Cotyllon" → "Otoclass") no matcheaba
nada aunque un humano hubiera entendido a qué cliente se refería. Se
reemplaza por búsqueda de similitud por trigramas (pg_trgm), con una regla
explícita para decidir cuándo el asistente puede elegir el mejor candidato
solo y cuándo tiene que preguntarle al usuario.

## Archivos modificados

- `supabase/migrations/420_asistente_busqueda_aproximada_pg_trgm.sql`
  (nuevo, **reconstruido en esta sesión** — se había armado y aplicado en un
  chat anterior pero el archivo no había quedado guardado en el repo, solo
  se conservó el `lib/asistente-tools.js` resultante). Habilita `pg_trgm`,
  agrega índices GIN trigram sobre `clientes.razon_social`,
  `clientes.nombre_fantasia` y `productos.nombre`, y dos RPCs
  `SECURITY DEFINER`: `buscar_clientes_asistente(p_empresa_id, p_texto,
  p_limite)` y `buscar_productos_asistente(...)`. Mismo patrón de tenant
  check que `registrar_cobro_completo` (417): `auth.role() <>
  'service_role' AND p_empresa_id IS DISTINCT FROM get_empresa_id()` →
  excepción. CUIT/teléfono se siguen comparando con ILIKE simple (no tiene
  sentido "parecido por voz" para dígitos); código de producto igual.
  **Pendiente: aplicar esta migración en producción** (jgiquzjwoedmzwqgzubr)
  — no se pudo ejecutar desde este entorno porque el conector de Supabase
  todavía no está autorizado en esta conversación.
- `lib/asistente-tools.js` — `buscarClientePorTexto()` /
  `buscarProductoPorTexto()` ahora llaman a las RPCs de arriba en vez de un
  `.or(...ilike...)` directo; se elimina `escaparFiltroPostgrest()` (ya no
  se arma el filtro a mano, así que no hace falta escapar nada — se
  verificó que no quedó ningún otro uso colgado). Nueva
  `elegirMejorCandidato()`: autoelige el primer resultado si hay uno solo,
  o si el mejor tiene similitud ≥ 0.35 y saca al segundo por ≥ 0.15 de
  margen; si no, pide desambiguar (mismo mensaje de error que antes, con
  "parecido a" en vez de "coincide con").

## Verificado antes de armar el zip

- `node --check` en `asistente-tools.js`.
- `require()` real del módulo (con `@supabase/supabase-js` instalado) —
  sin ciclos ni referencias rotas; confirma que no quedó ningún uso
  colgante de `escaparFiltroPostgrest`.
- Columnas usadas por las RPCs nuevas contra `001_schema.sql`
  (`razon_social`, `nombre_fantasia`, `cuit`, `telefono`, `activo` en
  `clientes`; `nombre`, `codigo`, `activo` en `productos`).
- **No se pudo correr** `scripts/check-schema.js` contra la base real
  (necesita `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, sin conexión desde
  este entorno) ni confirmar que la migración 420 quedó realmente aplicada
  en producción con la misma definición exacta de este archivo — a
  verificar apenas se habilite el acceso a Supabase.

## Nota pendiente

`pg_trgm` con el operador `%` usa el umbral global
`pg_trgm.similarity_threshold` (default 0.3) para decidir si una fila entra
al `WHERE` antes de que Node vea nada — un poco más laxo que el 0.35 que
usa `elegirMejorCandidato()` para autoelegir, así que en la práctica el
filtro SQL nunca es el cuello de botella. No se tocó ese GUC; si en el uso
real aparecen casos de nombres muy cortos o con pocas coincidencias de
trigramas que no entran al `WHERE`, conviene revisar bajarlo por sesión
dentro de la función.
