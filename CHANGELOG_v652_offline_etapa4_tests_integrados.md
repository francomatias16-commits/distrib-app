# v652 — Etapa 4 offline: tests reconstruidos e integrados

Continuación de v651 (UI de conflicto offline). En esta sesión se reconstruyó y
integró al proyecto la suite de tests offline que se había perdido antes del
zip anterior.

## Cambios

- **Fix real en `frontend/chofer/chofer-offline.js`**: bug de precedencia de
  regex. El mensaje de error "Cliente no encontrado" matcheaba primero
  `/no encontrado/i` (branch genérico de "pedido ya no disponible") antes de
  llegar al branch específico de cobro asociado. Se acotó el patrón a
  `/pedido no encontrado/i`.
- **Nuevo helper** `tests/helpers/cargar-modulo-offline.js`: carga los módulos
  `frontend/**/*-offline.js` (IIFEs de navegador, sin exports, dependientes de
  `window`/`OfflineCore`/`crypto`/`fetch` globales) en un sandbox `vm` con
  `OfflineCore.crearOutbox` mockeado, capturando el objeto `opts` de
  configuración de cada módulo como superficie pública a testear.
- **Suite `tests/frontend-offline/`** (85 tests, 5 archivos):
  - `chofer-offline.test.js` (19 tests, incluye el caso de regresión del fix)
  - `cliente-offline.test.js` (13 tests)
  - `cobros-offline.test.js` (11 tests)
  - `stock-offline.test.js` (13 tests)
  - `pos-offline.test.js` (29 tests, reconstruido desde cero: conflicto 4xx
    con `data.tipo`, 5xx sin conflicto, cache de productos, migración v1,
    hooks)

## Estado de la suite

Última corrida confirmada (sesión anterior, entorno con dependencias
instaladas): **85/85 tests pasando** en los 5 módulos offline.

La suite general del proyecto (`npm test`) tiene 55 fallos preexistentes en
`tests/handlers/whatsapp-*` y `tests/repos/whatsapp-bot.test.js`, no
relacionados con este trabajo (expectativas de test desactualizadas respecto
a la implementación actual, ej. `turno_desde` no esperado). Quedan fuera de
este alcance.

## Nota de este empaquetado

Este ZIP fue integrado y verificado por sintaxis (`node --check` en los 6
archivos tocados/agregados) en un entorno sin acceso a red, por lo que no fue
posible reinstalar `node_modules` y re-ejecutar `npx vitest run` acá. Antes
de dar por cerrada la etapa, correr:

```
npm install
npx vitest run tests/frontend-offline/
```
