# CHANGELOG v987 (integración) — Unificación de las ramas "fix filtros/breakpoints" (v229–v235/v986) y "split de clientes/productos" (v986/v987)

**Fecha:** 2026-08-26

## Contexto

Se recibieron dos ZIPs de distribución divergentes a partir de un mismo ancestro común:

- `distrib_v235_fix_filtros_der_breakpoints.zip` — rama de auditoría responsive
  (v229–v235: escala de breakpoints, consolidación de `.filtros-bar`/`.modal`,
  QA visual mobile con Playwright, fix de overflow-x en `#filtros-der`) que
  además incluía, más adelante en su historia, el v986 de prefill de
  `business_id` en la reconexión de WhatsApp Embedded Signup.
- `distrib_v987_split_clientes_frontend.zip` — rama de modularización de
  frontend (v986 split de `productos.js`, y el split adicional —sin
  changelog propio— de `clientes.js` en `frontend/admin/js/clientes/`).

Ambas ramas partían del mismo punto pero avanzaron en paralelo con distintos
números de versión (dos "v986" distintos), sin que ninguna tuviera visión
de los cambios de la otra.

## Qué se integró

1. **Base:** se tomó `v235` como base — es la rama con más commits y con
   fixes que tocan prácticamente todas las páginas de `frontend/admin/`
   (reordenamiento de `<link>` de CSS compartido) y con los últimos fixes
   de negocio (WhatsApp `business_id`, `_push.js` lazy-import de
   `firebase-admin`, `storage-urls.js` corte temprano en esquemas no
   soportados, dominio real en `robots.txt`/`sitemap.xml`/landing).
2. **Split de `productos.js` y `clientes.js`:** se incorporaron desde `v987`
   las carpetas `frontend/admin/js/productos/` (12 archivos) y
   `frontend/admin/js/clientes/` (16 archivos, ES modules), eliminando los
   dos archivos monolíticos de `v235` (que nunca vieron el split). Se
   verificó que el trabajo de breakpoints/`.filtros-bar`/`.modal` de v229–235
   vive enteramente en CSS/HTML, no en estos dos archivos JS — por lo tanto
   no hay lógica que "portar" entre ambas ramas para estos módulos.
3. **`productos.html` / `clientes.html`:** merge manual línea por línea —
   se conservó el `<head>` de `v235` (versionado de query-string actualizado
   de `tokens.css`, `adminlte-components.css`, `gentelella-tokens.css`,
   `responsive-mobile.css`, más el `<link>` de `componentes-admin.css` que
   faltaba) y se reemplazaron los `<script>` de cuerpo por los de la versión
   partida (los 12 `<script src="...">` clásicos de `productos/`, y el
   único `<script type="module" src=".../clientes/index.js">`).
4. **`tests/frontend/clientes.test.js`:** se tomó la versión de `v987`, que
   ya testea `score-cliente.js` vía import dinámico real (compatible con
   ES modules), en vez de la versión de `v235` que todavía cargaba el
   monolito con `vm.runInContext`.
5. **`docs/tecnico/ARQUITECTURA_ACTUAL.md`:** se tomó la versión de `v987`
   (documenta el split de `productos.js` como sección 8) y se agregó la
   sección 9, faltante en ambas ramas, documentando el split de
   `clientes.js` con el mismo nivel de detalle que las secciones anteriores.
   Se corrigió también la sección 4 (pasos sugeridos), que en `v987` seguía
   listando `clientes.js` como pendiente pese a que el split ya estaba en
   el árbol de archivos.
6. **`docs/changelogs/INDEX.md`:** se agregaron las 5 filas de reconciliados
   que existían como archivo pero no estaban indexadas en ninguna de las dos
   ramas (v229, v230, v232, v233, v235), más una sección nueva `v985+` con
   el split de `pedidos.js` (v985) y los dos v986 (split de `productos.js`
   y prefill de `business_id`), que tampoco estaban indexados en ninguna
   rama. Total: 461 changelogs indexados (antes 452/453 según la rama).
7. **Resto de archivos exclusivos de cada rama** (capturas de
   `docs/auditorias/screenshots_mobile/`, `scripts/audit-mobile.js`,
   `scripts/audit-breakpoints.js`, `scripts/check-shared-selectors.js` y la
   migración `20260825000000_544_...` de `v235`; el changelog
   `CHANGELOG_v986_split_productos_frontend.md` de `v987`) se incorporaron
   sin cambios — no había conflicto porque cada uno solo existía en una
   rama.

## Verificación hecha en este entorno

- Diff exhaustivo de los ~1750/1719 archivos de ambas distribuciones:
  89 archivos con contenido distinto (analizados uno por uno, no en bloque),
  60 exclusivos de `v235`, 29 exclusivos de `v987` — todos revisados y
  reconciliados según el criterio de esta lista.
- `node --check` sobre los 28 archivos de los dos splits (`productos/` +
  `clientes/`): sin errores de sintaxis.
- `package-lock.json`: idéntico entre ambas ramas (0 líneas de diff) — sin
  conflicto de dependencias.
- `supabase/migrations/`: 422 archivos en el resultado final (421 comunes
  + la migración 544 exclusiva de `v235`), sin colisión de números de
  migración entre ramas.
- Confirmado que ningún archivo de `v987` quedó fuera del árbol final
  (comparación de listados completos de ambos ZIPs contra el resultado).

## Pendiente / no verificable sin entorno vivo

Esta integración se hizo por comparación estática de archivos (sin Supabase
real, sin browser para Playwright, sin `npm test` corrido en este entorno).
Antes de desplegar a producción, correr:

```
npm run test           # vitest — en particular tests/frontend/clientes.test.js
npm run test:e2e       # smoke sobre productos.html y clientes.html
node scripts/check-asset-wiring.js
node scripts/smoke-test-frontend.js
node scripts/audit-breakpoints.js
```
