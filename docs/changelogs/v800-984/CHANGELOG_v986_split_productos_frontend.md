# v986 — Split de `frontend/admin/js/productos.js`

**Fecha:** 25/08/2026

## Qué se hizo

Se partió `frontend/admin/js/productos.js` (2377 líneas, el candidato
siguiente documentado en `ARQUITECTURA_ACTUAL.md` tras el split de
`pedidos.js` en v985) en `frontend/admin/js/productos/`, 12 archivos por
sección, siguiendo el mismo mecanismo ya usado para `pos.js` y
`migracion.js` (script clásico sin bundler — cada pieza es un `<script>`
más, cargado en el mismo orden, con `'use strict'` repetido por archivo).

Archivos nuevos: `nucleo-estado.js`, `carga-datos.js`, `filtros-menu.js`,
`render-tabla.js`, `seleccion-etiquetas.js`, `orden-busqueda-nav.js`,
`modal-producto.js` (el más grande, 444 líneas), `categorias-abm.js`,
`guardar-eliminar-producto.js`, `init-vistas.js`, `receta-bom.js`,
`auto-imagenes.js`. Detalle completo en
`docs/tecnico/ARQUITECTURA_ACTUAL.md` §8.

`productos.html` actualizado con los 12 `<script>` en orden;
`productos.js` original eliminado (no queda barrel, igual que en los
splits de frontend anteriores).

## Verificación

- Contenido comparado byte a byte contra el original — idéntico.
- `node --check` en los 12 archivos — OK.
- `node scripts/check-asset-wiring.js`: 0 referencias rotas en las 80
  páginas.
- `node scripts/smoke-test-frontend.js`: `productos` OK.
- `npx vitest run`: **72 archivos, 1185 tests, todos pasando** (misma
  cantidad exacta que antes del split).

## Sin cambios de comportamiento

Ningún otro HTML referenciaba `productos.js` directamente, así que no hubo
otros lugares que actualizar.
