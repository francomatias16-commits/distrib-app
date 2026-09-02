# v999 — Menú flotante "⋮" no se cerraba al scrollear la página en mobile

## Contexto

Reportado con captura de un celular en `facturacion.html`: el menú "⋮"
(kebab) de acciones secundarias de la lista de facturas ("Ver / descargar
PDF", etc.) queda desalineado/cortado en mobile.

## Causa

El menú (`.dropdown-menu`, `position:fixed`) se posiciona una única vez al
abrirse, con `posicionarMenuFlotante()` (`ui-utils.js`), tomando como
referencia la posición del botón "⋮" en ese instante. Para cerrarlo si el
usuario se aleja de esa posición, cada módulo agrega un listener de
`scroll` — pero apuntando siempre al contenedor interno de la tabla
(`#tabla-body`, `#tbody-*` o `.tabla-wrap`), nunca a `window`.

En desktop eso alcanza, porque esos contenedores son los que efectivamente
scrollean. En mobile (vista de tarjetas, `table-responsive-cards`) esos
contenedores no tienen scroll propio — el que scrollea es la página
completa vía `window`/`body`. Resultado: al scrollear la página en mobile,
el listener existente nunca dispara, el menú `position:fixed` se queda
flotando en su coordenada vieja, y termina viéndose desconectado de la
fila que lo abrió (o cortado contra otro elemento).

El mismo patrón (`posicionarMenuFlotante` + cierre solo por scroll del
contenedor de tabla, sin listener de `window`) se repite igual en otros
5 módulos del admin que usan el mismo menú flotante — se corrigieron todos
en este mismo fix, ya que es el mismo bug con la misma causa raíz.

## Fix

Se agregó `window.addEventListener('scroll', cerrar, { passive: true })`
junto al listener de scroll existente, en los 6 módulos afectados:

- `frontend/admin/js/facturacion.js` (facturas)
- `frontend/admin/js/notas-credito.js` (notas de crédito)
- `frontend/admin/js/notas.js` (notas)
- `frontend/admin/js/compras.js` (compras)
- `frontend/admin/js/cc-proveedores.js` (cta-cte proveedores)
- `frontend/admin/js/proveedores.js` (proveedores)

No se tocó `posicionarMenuFlotante()` en sí (`ui-utils.js`) ni la lógica de
cierre por click-afuera/Escape/resize, que ya funcionaban bien — el único
gap era la falta de un listener a nivel `window` para el caso de scroll de
página completa.

Bump de cache-busting (`?v999fix`) en los `<script>` de los 6 archivos
tocados: `facturacion.html` (para `facturacion.js` y `notas-credito.js`),
`notas.html`, `compras.html`, `cc-proveedores.html`, `proveedores.html`.

## Fuera de alcance

- No se auditó si existen otros menús flotantes en el proyecto que usen un
  mecanismo de posicionamiento/cierre distinto a `posicionarMenuFlotante()`
  — este fix cubre únicamente los módulos que la usan.

## Verificación

- Revisados los 6 archivos tras el cambio: cada uno agrega el listener de
  `window` una sola vez, junto a los listeners existentes de `resize` y
  scroll del contenedor de tabla, sin removerlos.
- No verificable en este entorno: confirmación visual en un dispositivo
  mobile real (no hay navegador/Playwright disponible en este sandbox —
  mismo problema ya documentado en
  `docs/auditorias/2026-08_auditoria_mobile_PROGRESO.md`).
