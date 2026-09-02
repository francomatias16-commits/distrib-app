# v985 — Split de `lib/handlers/pedidos.js`

**Fecha:** 25/08/2026

## Qué se hizo

Se partió `lib/handlers/pedidos.js` (3492 líneas, el archivo más grande del
backend) en `lib/handlers/pedidos/`, siguiendo el mismo criterio ya
aplicado a `lib/asistente-tools.js` (ver `ARQUITECTURA_ACTUAL.md` §5): 9
archivos por dominio + `index.js` como orquestador, con `pedidos.js`
convertido en un barrel de 21 líneas que reexporta la misma API pública de
siempre.

Archivos nuevos: `_helpers.js`, `notificaciones.js`, `pedido-sugerido.js`,
`crear-pedido.js`, `confirmar-pedido.js`, `presupuestos.js`, `remito.js`,
`chofer.js` (el más grande, 605 líneas — portal del chofer), y
`devoluciones.js`. Detalle completo de qué quedó en cada uno en
`docs/tecnico/ARQUITECTURA_ACTUAL.md` §7.

## Por qué

Era el candidato natural siguiente según el propio `ARQUITECTURA_ACTUAL.md`
(generado en la sesión anterior, 25/08/2026 más temprano) tras cerrar los
splits de `asistente-tools.js`, `pos.js` y `migracion.js`.

## Verificación

- Cuerpo de cada función comparado byte a byte contra el original: sin
  alteración de lógica, solo reorganización de imports y `export` añadido
  a 13 funciones que pasaron a compartirse entre módulos.
- `node --check` en los 11 archivos — OK.
- Import real en runtime del barrel — los 9 named exports + default
  resuelven sin error.
- `npx vitest run`: **72 archivos, 1185 tests, todos pasando** (misma
  cantidad exacta que antes del split).

## Sin cambios de comportamiento

Ningún import externo (16 tools de `lib/asistente-tools/`,
`lib/eventos-listeners/pedido_creado.js`, `api/index.js`, tests) necesitó
tocarse — todos siguen apuntando a `lib/handlers/pedidos.js`.
