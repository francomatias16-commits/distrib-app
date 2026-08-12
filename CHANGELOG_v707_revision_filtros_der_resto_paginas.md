# v707 — Revisión de `.filtros-der` en las páginas admin restantes

## Contexto
A partir del fix de Pedidos (v706), se revisó `.filtros-der` en el
resto de las páginas admin que lo usan: clientes, stock, compras,
facturación (2 instancias), cc-proveedores, proveedores, usuarios y
vencimientos. No todas tienen el mismo síntoma — la gravedad depende
de cuántos campos de filtro reales hay adentro. Diagnóstico por página:

| Página | Contenido de filtros-der | Síntoma | Acción |
|---|---|---|---|
| **pedidos** | 7 filtros + 3 botones | Sección gigante | Ya resuelto en v706 |
| **stock** | 2 selects + Limpiar + 5 botones (incl. "Escanear con la cámara", la acción más usada del día a día) | Los 2 selects se estiraban a 100% y empujaban esa acción varias filas abajo | **Fix en esta versión** |
| **compras** / **cc-proveedores** (comparten `compras.css`) | 2 fechas + 2-3 botones de acción | `.filtros-der` no tenía `flex-wrap` ni ningún ajuste responsive — riesgo de que el botón de acción quedara recortado en pantallas chicas | **Fix en esta versión** |
| **clientes** | 1 select + 4 botones/acciones | Un solo select estirado a 100% — 40px extra, no es un problema real | Sin cambios |
| **facturación** (ambas pestañas) | 1-3 campos, ya con `flex-wrap` propio | Wrap razonable ya existente | Sin cambios |
| **proveedores** / **usuarios** / **vencimientos** | Solo 1 botón primario ("Nuevo X") | No hay filtros ahí, un botón no genera altura extra | Sin cambios |

## Cambios

### Stock — mismo patrón que Pedidos, pero separando filtros de acciones
`frontend/admin/stock.html`
- Los 2 selects (depósito, categoría) + "Limpiar" ahora viven en un
  sub-wrapper `#filtros-avanzados-stock`, detrás de un botón "Más
  filtros". Los botones de acción (Depósitos, Transferir stock,
  Exportar Excel, Escanear con la cámara, Vincular celular) quedan
  **siempre visibles**, sin tocar — a diferencia de Pedidos, acá no
  convenía esconder todo el bloque.
- Bump `stock.css?v=197`, `stock.js?v282`.

`frontend/admin/css/stock.css`
- `.filtros-avanzados { display: contents; }` en desktop (no cambia el
  layout actual). En `@media (max-width: 900px)` pasa a
  `display: none` por defecto y `.abierto` lo despliega en columna.
  Mismo estilo de botón toggle que pedidos.css.

`frontend/admin/js/stock.js`
- Nueva función `toggleFiltrosAvanzados()`, expuesta en `window`
  (mismo motivo que en pedidos.js: script `type="module"`).

### Compras / cc-proveedores — bug de wrap faltante (no de tamaño)
`frontend/admin/css/compras.css` (cc-proveedores.html reusa este mismo
archivo, no tiene uno propio)
- `.filtros-der` no tenía `flex-wrap` ni ajuste responsive. Se agregó
  `@media (max-width: 900px) { .filtros-der { flex-wrap: wrap; width: 100%; } }`
  para que "Comparar proveedores" / "Recepciones" / "Nueva orden"
  (compras) y "Nueva factura" (cc-proveedores) no corran riesgo de
  recortarse en pantallas chicas.
- Bump `compras.css?v=197` en ambos HTML.

## Alcance no cubierto
Clientes, facturación, proveedores, usuarios y vencimientos no se
tocaron — revisados y confirmados sin el mismo problema (ver tabla).

## Verificación
- `node --check` sobre `stock.js` → OK.
- Balance de `<div>`/`</div>` verificado en los 5 archivos HTML
  tocados (pedidos, stock, clientes, compras, cc-proveedores) — igual
  cantidad de apertura y cierre en todos.
- Sin acceso a Chromium en este entorno para el screenshot automatizado
  — recomendado probar stock.html y compras.html en celular real antes
  de cerrar.

## Sin migraciones de base de datos
