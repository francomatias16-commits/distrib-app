# v1001 — Precios de planes desactualizados en "Suscripciones SaaS" vs. la landing

## Contexto

Reportado: la página de "Suscripciones SaaS" (`saas-billing.html`, vista
self-serve de cada tenant, sección "Planes disponibles" / upgrade-downgrade)
sigue mostrando precios inconsistentes con lo publicado en la landing
(`frontend/landing`, sección `#precios`).

## Causa

El contenido de features por plan (`FEATURES_PLAN_LANDING` en
`saas-billing.html`) ya estaba sincronizado palabra por palabra con la
landing — no había diferencias ahí. La inconsistencia real estaba en los
**precios**, que no vienen del HTML sino de la tabla `planes_limites` en
la base (poblada por la migración semilla 137 y nunca actualizada desde
entonces):

| Plan                | Landing (`#precios`)      | `planes_limites.precio_mes` |
|---------------------|----------------------------|------------------------------|
| Básico               | $30.000/mes                | $25.000                      |
| Premium (`pro`)      | $55.000/mes                | $55.000 — sin diferencia     |
| Platinum (`enterprise`) | "Desde $95.000/mes"     | `NULL`                       |

El precio de Básico subió a $30.000 en algún momento en la landing pero
nadie actualizó el dato semilla de la tabla. El de Platinum nunca tuvo
precio de referencia: `NULL` hacía que `fmtPrecioPlan()` — que ya tiene
la lógica correcta para anteponer "Desde " cuando `tier === 'enterprise'`
— cayera siempre en la rama `"A medida"` en vez de mostrar el precio de
entrada real.

De paso, se encontraron 4 usos de `15000` como valor de referencia
"genérico" (placeholder del input de configuración y 3 fallbacks cuando
un dato todavía no está cargado) — resabio de un precio base anterior a
que existiera el sistema de planes por tier, también desalineado con el
plan de entrada actual ($30.000).

## Fix

**`supabase/migrations/20260827000000_545_fix_precios_planes_limites_vs_landing.sql`**:
`UPDATE planes_limites SET precio_mes = 30000 WHERE tier = 'basico'` y
`SET precio_mes = 95000 WHERE tier = 'enterprise'`. No se tocó `pro`
(ya correcto) ni `trial` (correctamente en `0`, no se vende).

**`frontend/admin/saas-billing.html`**: los 4 usos de `15000` (placeholder
del input `cfg-precio` y los 3 fallbacks `|| 15000`) se actualizaron a
`30000`, para que la referencia genérica también sea consistente con el
plan de entrada real.

## Fuera de alcance

- No se tocaron `max_usuarios`/`max_clientes`/`max_pedidos_mes` de
  `planes_limites` — esos ya se dejaron sin restricciones para los 3
  planes pagos en la migración 499 y siguen correctos.
- No se auditó si `saas_config.precio_mensual` (el precio que se muestra
  en el banner de CBU) tiene un valor cargado en la base real que también
  esté desactualizado — esta migración solo toca `planes_limites`, la
  tabla que alimenta la grilla de planes de "Mi suscripción". Si el valor
  real de `saas_config` también quedó en $15.000 o similar, conviene
  revisarlo aparte con acceso a esa tabla.

## Verificación

- Revisada la lógica de `cargarPlanesTenant()`/`fmtPrecioPlan()`: no
  necesitó cambios de código, solo el dato — la rama "Desde " para
  `enterprise` ya estaba implementada correctamente y ahora tiene un
  precio no nulo para activarse.
- No se pudo ejecutar la migración contra la base real de este entorno
  (sin acceso a Supabase en este sandbox) — verificar que
  `SELECT tier, precio_mes FROM planes_limites` devuelva 30000/55000/95000
  para basico/pro/enterprise tras aplicarla.
