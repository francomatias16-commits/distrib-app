# Limpieza de monolitos JS huérfanos en frontend/admin/js

## Contexto
Auditoría general del proyecto (2026-09-09) detectó 4 archivos JS en `frontend/admin/js/`
que quedaron en el repo tras refactors de split anteriores, pero que ningún HTML
carga más (superados por sus versiones divididas en subcarpetas):

- `pos.js` (3595 líneas) → reemplazado por `frontend/admin/js/pos/*`
- `migracion.js` (2631 líneas) → reemplazado por `frontend/admin/js/migracion/*`
- `productos.js` (2209 líneas) → reemplazado por `frontend/admin/js/productos/*`
- `clientes.js` (2173 líneas) → reemplazado por `frontend/admin/js/clientes/*`

Total: ~10.600 líneas de código muerto (no se ejecutaban, ninguna página los referenciaba).

## Verificación antes de borrar
- `grep` literal de `src="/frontend/admin/js/<archivo>.js` contra todo `frontend/**/*.html`: 0 resultados para los 4 archivos.
- Confirmado que las páginas reales (`pos.html`, `migracion.html`, `productos.html`, `clientes.html`)
  cargan únicamente las versiones partidas.

## Acción
- Eliminados los 4 archivos monolíticos.
- Backup de los archivos borrados incluido en este ZIP (`removed_files_backup/`) por las dudas.

## Verificación después de borrar
- `npm run check-asset-wiring`: 1945 referencias revisadas, 0 rotas (idéntico a antes)
- `npm run check-api-wiring`: 0 fetch rotos, 0 rewrites rotos
- `npm run check-handler-dispatch`: 97 combinaciones, 0 sin manejar
- `node scripts/smoke-test-frontend.js`: 40 OK
- `npx vitest run`: 137 archivos / 1964 tests, todos OK (idéntico a antes)

## Nota sobre xlsx
Se evaluó también remover la dependencia `xlsx` del `package.json` por sospecha de no uso
(no aparecía en `require`/`import` estático). Se descartó: se usa vía `import()` dinámico
en `lib/utils/extraer-texto-archivo.js` para leer archivos Excel adjuntos al asistente
(confirmado porque al removerla se rompió `tests/asistente/extraer-texto-archivo.test.js`).
No se tocó esa dependencia.
