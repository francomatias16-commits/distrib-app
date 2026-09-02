# v994 — "Portal" del menú "⋮" no respondía al toque en mobile (proveedores.html)

## Contexto

En `frontend/admin/proveedores.html`, cada tarjeta de proveedor (mobile)
tiene "Editar" / "Dar de baja" / "⋮". El "⋮" abre un menú flotante
compartido (`#menu-acciones-proveedor`, un único nodo reusado para todas
las filas, posicionado por JS con `getBoundingClientRect()`) con dos
opciones: Compras y Portal. Reporte: "Portal" no responde al toque en
mobile.

## Causa

`#menu-acciones-proveedor` hereda `.dropdown-menu { z-index: var(--z-dropdown) }`
= **100** (`frontend/shared/componentes-admin.css`). En el layout de
tarjetas de mobile (`table-responsive-cards`), las tarjetas apiladas
quedan lo bastante cerca entre sí como para que, aunque el menú se
*pinte* visualmente por encima (cualquier elemento posicionado con
z-index gana contra hermanos `position:static`), el toque no siempre
caiga sobre él según la tarjeta de abajo — **mismo síntoma exacto ya
diagnosticado y resuelto antes en este mismo codebase** para
`#vista-clientes .dropdown-menu` (`clientes.css`, comentario: "quedaba
tapado por la tarjeta de la tabla de abajo al abrirse"), que en su
momento se arregló forzando el menú a `--z-overlay-critical` (9000) en
vez de perseguir qué regla puntual le ganaba el stacking. Ese fix nunca
se replicó en `proveedores.html`, que usa el mismo patrón de menú
compartido.

## Fix

**`frontend/admin/css/proveedores-gentelella.css`** (nuevo bloque al
final):

```css
body.dash-proveedores-gentelella #menu-acciones-proveedor {
  z-index: var(--z-overlay-critical) !important;
}
```

Mismo criterio, mismo token (`--z-overlay-critical`, tokens.css), que el
fix ya validado en clientes.css — no se inventó un valor nuevo.

Cache-busting: `proveedores-gentelella.css?v=1` → `?v=2` en las dos
páginas que lo cargan (`proveedores.html`, `cc-proveedores.html` — esta
última no tiene `body.dash-proveedores-gentelella` así que la regla no
le aplica, pero comparte el archivo y necesita la misma versión para no
quedar con una copia vieja en caché).

## Fuera de alcance

- No se tocó el JS de posicionamiento (`iniciarMenuAccionesProveedor` en
  `proveedores.js`) — el cálculo de `top`/`right` vía
  `getBoundingClientRect()` es correcto, el problema era puramente de
  stacking (z-index), no de posición.
- "Compras" (la otra opción del mismo menú) tiene el mismo z-index
  insuficiente y en teoría el mismo riesgo, pero no fue reportado como
  fallando — el fix de z-index en el contenedor del menú lo cubre a los
  dos por igual, así que queda resuelto de paso.

## Verificación

- Confirmado que `--z-overlay-critical` (9000, tokens.css) es
  significativamente mayor que cualquier z-index competidor visible en
  el layout de tarjetas de mobile de esta página.
- No verificable en este entorno: repetir el toque real en un dispositivo
  para confirmar que "Portal" abre el modal de forma consistente.
