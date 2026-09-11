# v1067 — fix: `sharp` desinstalado por error en DEP-03 (v983), 4 rutas de producción rotas

## Contexto

Detectado al revisar `lib/handlers/auto-imagenes.js` durante el trabajo de
sync con el catálogo de Meta (`CHANGELOG_catalogo_meta_sync.md`).

## Bug

v983 (`DEP-03`, 2026-08-24) desinstaló `sharp` de `package.json` con el
argumento de que un grep exhaustivo a `lib/`, `api/`, `scripts/`,
`frontend/` no encontró ningún import. Ese grep no encontró nada porque
buscaba `require('sharp')` / `from 'sharp'` — pero las 4 rutas reales que
usan `sharp` lo hacen con `import()` dinámico (`await import('sharp')`),
patrón adoptado a propósito para no romper el arranque de la lambda si
faltara la dependencia (ver FIX 092 en `importar.js`). El grep de v983 no
matcheaba ese patrón, concluyó "cero resultados" y lo desinstaló.

Desde entonces, `sharp` no está en `node_modules` en producción. Las 4
rutas que dependen de él no rompen al arrancar (por eso el `import()`
dinámico), pero **fallan en el momento exacto en que se ejecutan**, con
`ERR_MODULE_NOT_FOUND`:

1. `lib/handlers/auto-imagenes.js` — normalización de imagen (800x800,
   JPEG) al autocompletar fotos de producto.
2. `lib/handlers/importar.js` — reprocesamiento de imagen en el modo
   `?vision=1` (OCR vía Claude Vision).
3. `lib/handlers/empresa.js` — normalización del logo de empresa
   (PNG/JPEG/WebP) en `POST /api/empresa/logo`.
4. `lib/handlers/banco-codigos.js` — normalización de imagen en la
   búsqueda externa de códigos de banco.

Los 4 casos son de producción real, no de test — coincide con lo que ya
había señalado v448 (`sharp` "es dependencia de producción real").

## Fix

- `npm install sharp@^0.33.5` (misma major que tenía antes de v983;
  0.33.x sigue siendo la última serie sin CVEs de libvips sin parchear
  al momento de esta sesión).
- Se agrega a `dependencies`, no a `devDependencies` — la clasificación
  original en v983 como devDependency era en sí parte del problema: algo
  usado en 4 handlers de producción no es una dependencia de desarrollo.
- `package.json` + `package-lock.json` actualizados (`npm install` real
  contra el registro, no editado a mano).

## Verificación

- `node -e "import('sharp')..."`: resuelve OK, `sharp.versions.sharp = 0.33.5`.
- Pipeline real (`resize(800,800,{fit:'contain'}).jpeg({quality:82})`)
  probado contra un buffer de imagen real: OK.
- `npm ci --dry-run`: limpio.
- `npx vitest run tests/handlers/auto-imagenes-permisos.test.js
  tests/handlers/importar-permisos.test.js`: 14/14 OK.
- `npm run check-wiring:all` (assets + API + dispatch interno): sin
  hallazgos.

## Archivos en este delta

- `package.json`
- `package-lock.json`

## Nota para la próxima auditoría de dependencias

Si se vuelve a correr un check de "dependencias sin uso", el grep tiene
que cubrir también `import(‹paquete dinámico›)`, no solo imports
estáticos — este mismo bug puede repetirse con cualquier otro paquete
que use el patrón de `importar.js` (carga diferida para no tumbar la
lambda entera si faltara).
