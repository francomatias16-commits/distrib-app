# v246 — Integración de dos ramas divergentes (Etapa 2 UI + Etapa 6 export contable)

## Contexto

Llegaron dos entregas distintas partiendo ambas de v243_integrado, cada una
numerada como "v245" pero con contenido distinto y usando el **mismo número
de migración (245)** para cosas distintas:

- `distrib_v245_etapa2_reglas_precio_y_rentabilidad.zip`: agrega la UI/handler
  de administración de reglas de precio (el motor ya estaba desde 243) +
  panel de rentabilidad por producto/vendedor (`245_etapa2_rentabilidad_producto_vendedor.sql`).
- `distrib_v245_integrado.zip`: agrega Export contable, Etapa 6
  (`245_etapa6_export_contable.sql`).

Ambas ramas son compatibles entre sí (no tocan los mismos archivos, salvo
`nav-data.js`, `vercel.json` y `api/index.js`, que solo suman entradas). Este
build las une en una sola base.

## Qué se hizo

1. Base: `distrib_v245_integrado` (Export contable, Etapa 6) completa.
2. Se sumaron de la rama Etapa 2:
   - `frontend/admin/reglas-precio.html` + `frontend/admin/js/reglas-precio.js`
   - `frontend/admin/rentabilidad-producto-vendedor.html` + `frontend/admin/js/rentabilidad-producto-vendedor.js`
   - `lib/handlers/reglas-precio.js` + `lib/repos/reglas-precio.js`
   - Los dos bloques nuevos (`accion=rentabilidad-producto` / `rentabilidad-vendedor`)
     dentro de `lib/handlers/rutas-live.js` (reusa ese handler, no crea uno nuevo).
3. **Renumerada** `245_etapa2_rentabilidad_producto_vendedor.sql` →
   **`246_etapa2_rentabilidad_producto_vendedor.sql`** para no chocar con
   `245_etapa6_export_contable.sql` (quedan ambas, sin overlap). Actualizadas
   las referencias internas del archivo (nombre y número en el INSERT a
   `schema_migrations_registry`).
4. Fusionadas a mano las entradas aditivas en:
   - `api/index.js`: import + registro de `reglas-precio` en `HANDLERS`.
   - `vercel.json`: rewrite `/api/reglas-precio(.*)` y rutas `/admin/reglas-precio`,
     `/admin/rentabilidad-producto-vendedor`.
   - `frontend/admin/js/nav-data.js`: ítems de menú para ambas pantallas nuevas.

## Pendiente antes de aplicar en Supabase

- Ejecutar `246_etapa2_rentabilidad_producto_vendedor.sql` (la vieja 245 de
  esa rama, ya renombrada) contra `jgiquzjwoedmzwqgzubr` — probablemente
  **no** se llegó a aplicar todavía si nunca se corrió `245_etapa2...` con ese
  nombre.
- Verificar que `245_etapa6_export_contable.sql` sí esté aplicada (o
  aplicarla junto con la 246).
- No hay CHANGELOG propio para la parte de Etapa 2 UI (reglas de precio +
  rentabilidad producto/vendedor) en el zip que llegó — vale la pena
  redactarlo aparte para no perder el criterio de diseño usado.
