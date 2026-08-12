# CHANGELOG v218 — Responsive al 100%: auditoría y fix de punta a punta

## Alcance
Auditoría completa del frontend (57 páginas HTML, 26 hojas de estilo,
portales admin / cliente / chofer / proveedor + páginas públicas) para
detectar y corregir todo lo que rompía o degradaba el layout en tablet
y mobile. Se trabajó en capas, de mayor a menor impacto:

1. Capa compartida (`shared/*.css`) — afecta a todas las páginas.
2. CSS por módulo del panel admin (`admin/css/*.css`).
3. Páginas admin con estilos embebidos sueltos.
4. Portal cliente, chofer y proveedor.
5. Páginas públicas (landing, registro, legales).

## Hallazgos y qué se corrigió

### 1) Meta viewport faltante (bloqueante)
4 páginas no tenían `<meta name="viewport">`, por lo que el CSS
responsive nunca llegaba a activarse en el celular real (el navegador
renderizaba a un ancho de escritorio simulado y luego achicaba todo).
- `frontend/admin/cta-cte.html`
- `frontend/admin/presupuestos.html`
- `frontend/admin/liquidacion.html`
- `frontend/admin/lotes.html`

(Las 4 son redirects "puente" hacia páginas nuevas — el fix es
preventivo, por si alguna vez el redirect no dispara a tiempo).

### 2) `shared/base-layout.css` y `admin/css/base-layout.css`
No tenían ni un solo `@media`. `.main` usaba `padding: 24px 28px` fijo
en cualquier tamaño de pantalla.
- Agregado `min-width: 0` a `.main` (evita que tablas/grids anchos
  empujen el layout general y generen scroll horizontal de toda la
  página).
- Padding progresivo: 20px (≤1024px) → 16px (≤768px) → 12px (≤480px).

### 3) `shared/adminlte-components.css` (componentes usados en casi
   toda la app: cards, small-box, info-box, topbar, modal, kanban,
   notificaciones, profile-card) — 0 media queries en 636 líneas.
Agregado un bloque responsive completo:
- Cards, small-box e info-box: padding y tamaños de fuente reducidos
  en tablet/mobile.
- Topbar: se ocultan fecha/usuario/badge de workspace por debajo de
  768px (info secundaria que no entra con el título + acciones).
- `.notif-dropdown`: pasa de ancho fijo a `position: fixed` con
  márgenes laterales en mobile, para no desbordar la pantalla.
- Modal: padding reducido, `max-height` ajustado.
- Kanban: columnas de 280px → 240px en mobile (con scroll horizontal,
  que ya existía).

### 4) `shared/chat-widget.css`
El botón/panel flotante del asistente usaba `bottom: 24px` fijo, lo
que lo hacía superponerse con la barra de navegación mobile del panel
admin (barra fija de 60px + `safe-area-inset-bottom`, ver `nav.css`).
- Nuevo `@media (max-width: 768px)`: botón y panel se reposicionan por
  encima de esa barra.

### 5) CSS por módulo — grids sin fallback mobile
Varios formularios y grillas de 2, 3 o 4 columnas no colapsaban nunca
a 1 columna, quedando ilegibles/apretados en celular:

| Archivo | Selector | Fix |
|---|---|---|
| `finanzas.css` | `.finanzas-kpis` (4 cols), `.form-grid`, `.nota-tipo-selector` | 0 media queries → agregado bloque completo (2 cols en tablet, 1 en mobile) |
| `compras.css` | `.form-grid`, `.form-grid.cols-3` | Sin fallback → colapsan a 1 columna ≤600px |
| `clientes.css` | `.proyeccion-grid` (modal de proyección de stock) | Sin fallback → 1 columna ≤480px |
| `migracion.css` | `.mig-mapeo-row` (220px+1fr), `.mig-stats-grid` (3 cols) | Sin fallback → columna única / 2 cols según ancho |
| `rutas.css` | `.rutas-grid` (380px+1fr), `.seguimiento-grid` (340px+1fr), `.ruta-form-grid`, `.ruta-item` | Sin fallback → una sola columna en tablet, formulario e ítems apilados en mobile |
| `pos.css` | `.pos-caja-kpis` (3 cols) | Sin fallback → 1 columna ≤480px |

### 6) Páginas con estilos embebidos sin cobertura mobile
- `admin/setup.html` — `.fields-row` (2 cols) sin fallback → 1 columna ≤480px.
- `admin/facturacion-config.html` y `admin/mercadopago-config.html` —
  `.form-row` sin fallback + padding fijo del contenedor → colapsa a
  1 columna y reduce padding ≤600px.
- `admin/mi-suscripcion.html` — fila label/valor con `min-width: 160px`
  fijo podía apretar el valor en pantallas muy chicas → se permite
  wrap a 2 líneas ≤420px.
- `admin/puntos.html` — grilla de KPIs de 3 columnas sin fallback →
  2 columnas (≤700px) y 1 columna (≤420px).
- `admin/pedidos.html` — modal "Nuevo presupuesto": la fila de ítem
  (`producto / descripción / cantidad / precio / descuento / borrar`,
  6 columnas) no tenía fallback y el modal ocupa hasta el 95% del
  ancho de pantalla → en mobile pasa a un layout de 2 columnas por
  fila usando `grid-template-areas`, con el modal a pantalla completa.

### 7) Bug encontrado al revisar `pedidos.html` (no era de responsive,
   pero invalidaba el fix anterior)
El JS de presupuestos (`presupuestos.js`) generaba cada fila de ítem
con `class="item-row"`, mientras que el CSS (base y ahora responsive)
define el grid en `.pres-item-row`. Como los nombres no coincidían,
**el grid nunca se aplicó, ni en desktop ni en mobile** — los campos
quedaban con el layout por defecto del navegador. Se agregó la clase
`pres-item-row` junto a la existente en el template del JS para que el
grid (y su versión responsive) realmente tome efecto.
- Archivo: `frontend/admin/js/presupuestos.js`

### 8) Tabla sin scroll horizontal en ficha de cliente
`admin/js/clientes-ciclos.js` generaba la tabla de "ciclos de compra"
sin contenedor con `overflow-x`. Se agregó `.ciclo-tabla-wrap` (nueva
clase en `clientes-ciclos.css`) envolviendo la tabla, para que no
desborde la ficha del cliente en pantallas angostas.

### 9) Ya estaba bien resuelto (se revisó, no se tocó)
- `admin/css/nav.css` — sidebar de escritorio + barra inferior y
  drawer táctil en mobile: completo y prolijo.
- `admin/css/dashboard.css`, `dashboard-dark-bento.css`,
  `dashboard-showcase.css` — el panel principal (incluida la
  reestructuración de ZONA 2+3 de v217) ya tenía buena cobertura
  responsive.
- `admin/css/clientes.css` y `compras.css` — patrón "tabla → tarjetas"
  en mobile ya implementado para las listas principales.
- `admin/css/stock-overview.css`, `reportes.css`, `automatizacion.css`,
  `producto-picker.css`, `productos.css`, `facturacion.css`,
  `stock.css` — grids con `auto-fit/auto-fill` (fluidos por diseño) o
  con fallback explícito ya existente.
- **Portal cliente completo** (`cliente/*.html`) — diseño mobile-first
  desde el origen: unidades `rem`, contenedores con `max-width`
  fluido, sin grids rígidos ni anchos fijos. No requirió cambios.
- **Portal chofer** (`chofer/*.html`) y **portal proveedor**
  (`proveedor/portal.html`) — mismo patrón mobile-first, cobertura OK.
- Páginas públicas (`index.html`, `registro.html`, `privacidad.html`,
  `terminos.html`) — ya tenían media queries y contenedores fluidos.

## Archivos modificados
```
frontend/shared/base-layout.css
frontend/admin/css/base-layout.css
frontend/shared/adminlte-components.css
frontend/shared/chat-widget.css
frontend/admin/css/clientes.css
frontend/admin/css/clientes-ciclos.css
frontend/admin/css/compras.css
frontend/admin/css/finanzas.css
frontend/admin/css/migracion.css
frontend/admin/css/rutas.css
frontend/admin/css/pos.css
frontend/admin/css/login.css
frontend/admin/cta-cte.html
frontend/admin/presupuestos.html
frontend/admin/liquidacion.html
frontend/admin/lotes.html
frontend/admin/setup.html
frontend/admin/facturacion-config.html
frontend/admin/mercadopago-config.html
frontend/admin/mi-suscripcion.html
frontend/admin/puntos.html
frontend/admin/pedidos.html
frontend/admin/js/presupuestos.js
frontend/admin/js/clientes-ciclos.js
```

## Verificación realizada
- Balance de `<div>`/`</div>` y de llaves `{}` en todos los archivos
  tocados (sin desbalances).
- Revisión cruzada de que las clases usadas por JS coincidan con los
  selectores CSS en los componentes tocados (detectó y corrigió el bug
  de `item-row` / `pres-item-row`).
- No se pudo hacer verificación visual en navegador real (sin entorno
  de preview); se recomienda un smoke test manual en Chrome DevTools
  (modo responsive, 360px / 768px / 1024px) sobre: Panel principal,
  Pedidos (incl. modal de presupuesto), Clientes (ficha con ciclos),
  Finanzas/Cta-cte, POS y el portal cliente antes de pasar a producción.
