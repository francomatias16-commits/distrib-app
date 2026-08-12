# v637 — Dashboard mobile: rediseño completo y funcional

## Problema resuelto
El dashboard en mobile (≤640px) era inutilizable porque:
1. **`body { height:100vh; overflow:hidden }`** bloqueaba el scroll — todo el contenido
   quedaba aplastado sin poder navegar.
2. Los grids internos de 4/3/2 columnas estaban definidos con **estilos inline** que
   CSS no podía sobreescribir sin JavaScript.
3. El **zoom de cards** (click para agrandar) generaba animaciones raras en mobile porque
   el card ocupaba casi todo el viewport sin ganar nada.
4. No había una vía rápida para ir a las secciones principales sin hacer scroll.

## Solución implementada

### `frontend/admin/dashboard.html`

**CSS (bloque `<style>` inline):**
- `body` en ≤640px: `height:auto`, `min-height:100dvh`, `overflow-y:auto` — el body
  ahora scrollea en mobile.
- Barra de acceso rápido `.dash-quick-nav` + botones `.dash-qn-btn`: estilos completos,
  visible solo en mobile (oculta por defecto con `display:none`, revelada en ≤640px).
- `.card` en mobile: `height:auto`, `overflow:visible` — cada card ocupa su altura natural.
- Elementos con `overflow-y:auto` dentro de cards: desactivados en mobile para que el
  contenido fluya sin contenedores anidados que compitan con el scroll del body.
- `.card-nav` en mobile: cursor default, sin hover elevado — el click redirige directo.
- Topbar compacto: logo 24px, botón menú más pequeño.
- `.kpi-val`, `.hero-num`, `.hero-num-sm`: tamaños `clamp()` legibles en mobile.
- `.flow` en mobile: `flex-wrap:wrap`, líneas de conexión ocultas (evitan overflow).
- `.inner-tabs` y `.periodo-tab`: más compactos.
- `.chat-box`: altura limitada con scroll interno para no crecer demasiado.
- `.qr`: reducido a 40×40px.

**HTML (entre topbar y grid):**
```html
<nav class="dash-quick-nav" aria-label="Acceso rápido">
  Pedidos · Caja POS · Productos · Clientes · Cobros · Facturas · Stock · Reportes
</nav>
```
8 atajos a las secciones más usadas, en fila horizontal con scroll touch, visible solo en mobile.

**JS:**
- `fixMobileGrids()`: corrige en tiempo de ejecución los `grid-template-columns` inline
  de los cards KPI (4→2 cols), WhatsApp (2→1), Reportes Críticos (3→1), Catálogo
  (2→1), Score/Cheques (flex wrap), POS caja-kpis (2→1). Se ejecuta en
  `DOMContentLoaded` y en cada `resize` (debounce 120ms).
- `abrirZoom()`: en mobile (≤640px) redirige directo a la URL de la sección en lugar
  de abrir el panel de zoom — la animación no tiene sentido a ese ancho.

**Cache buster:** `responsive-mobile.css?v=637`

## Archivos modificados
- `frontend/admin/dashboard.html` — único archivo modificado

## Sin migraciones de base de datos
