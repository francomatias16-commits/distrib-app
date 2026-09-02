# v706 — Fix: sección de filtros de Pedidos gigante en mobile

## Contexto
El fix de v699 (`responsive-mobile.js`) resolvió tablas sin wrapper y
grids inline, pero no tocó este problema: en `pedidos.html`,
`.filtros-der` (7 campos: cliente, vendedor, zona, canal, 2 fechas,
importe mínimo + 3 botones) pasa a `flex-direction: column` desde los
900px (`pedidos.css`), y a los 640px cada campo se estira a
`width: 100% !important` (`responsive-mobile.css`, sección 4). El
resultado: 10 elementos apilados a ancho completo antes de llegar a la
tabla — un bloque de filtros que ocupa toda la pantalla en celular.

Diagnóstico confirmado leyendo `pedidos.css`, `pedidos-gentelella.css`,
`adminlte-components.css`, `reskin-patch*.css` y `responsive-mobile.css`
línea por línea: ninguno definía un límite de alto ni un colapso, por
eso el intento previo (revisar `.select-filtro` puntual) no cambiaba
nada — el tamaño del control individual nunca fue el problema real.

## Cambios
- `frontend/admin/pedidos.html`
  - Nuevo botón `.btn-toggle-filtros-der` ("Más filtros" + chevron),
    insertado antes de `.filtros-der`. Solo visible en mobile (oculto
    por CSS en desktop).
  - `id="filtros-der"` agregado al contenedor (antes solo tenía clase).
  - Bump `pedidos.css?v=218`, `pedidos.js?v259`.

- `frontend/admin/css/pedidos.css`
  - `@media (max-width: 900px)`: `.filtros-der` pasa a `display: none`
    por defecto; `.filtros-der.abierto` lo muestra. Estilo del botón
    toggle (ancho completo, chevron que rota al abrir).

- `frontend/admin/js/pedidos.js`
  - Nueva función `toggleFiltrosAvanzados()`: togglea la clase
    `.abierto` en el botón y en `#filtros-der`, y `aria-expanded`.
    Expuesta en `window` (el script es `type="module"`, igual que el
    resto de los handlers inline de este archivo).

## Alcance no cubierto (fuera de esta pasada)
`clientes.html`, `stock.html`, `compras.html`, `facturacion.html`,
`cc-proveedores.html`, `proveedores.html`, `usuarios.html`,
`vencimientos.html` usan el mismo patrón `.filtros-der` y probablemente
tengan el mismo problema en mobile, en distinto grado según la
cantidad de campos. No se tocaron en esta pasada — quedan pendientes
si se confirma el mismo síntoma ahí.

## Verificación
- `node --check` sobre `pedidos.js` → OK.
- No se pudo correr el screenshot automatizado con Playwright en este
  entorno (sin acceso de red al binario de Chromium) — revisar en
  celular real o DevTools mobile antes de dar por cerrado.

## Sin migraciones de base de datos
