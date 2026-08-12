# reskin-patch-v2-shadcn.css — Guía rápida

## Qué se hizo
Se creó `shared/reskin-patch-v2-shadcn.css` y se inyectó automáticamente
como `<link>` justo después de `shared/reskin-patch.css` en **las 57
páginas** que ya cargaban ese archivo (siguiendo el mismo mecanismo que ya
usa el proyecto: último en cargar, gana con `!important`). No se tocó
ninguna paleta de color ni ningún JS.

## Qué entra en vigencia YA, sin tocar HTML
- Foco de teclado con anillo + separación (estilo shadcn), en vez del
  `outline` genérico del navegador — accesibilidad mejorada en toda la app.
- `prefers-reduced-motion` respetado globalmente.

## Qué es opt-in (agregar la clase donde se necesite)
| Necesito... | Clase a usar | Inspirado en |
|---|---|---|
| Botón fantasma (sin fondo) | `btn-ghost` | shadcn |
| Botón tipo link | `btn-link` | shadcn |
| Botón con fondo suave | `btn-soft` | Chakra "subtle" |
| Botón chico / grande / solo ícono | `btn-xs` / `btn-lg` / `btn-icon` | Mantine |
| Botón cargando | `data-loading="true"` en el `<button>` | shadcn |
| Tag con punto de estado | `tag-dot` (sobre `.badge` existente) | Ant Design |
| Tag cerrable | `tag-closable` + `<button class="tag-close">×</button>` | Ant Design |
| Tabla compacta / cómoda | `table-compact` / `table-comfortable` en el `<table>` | Ant Design |
| Header de tabla fijo al hacer scroll | `table-sticky` en el `<table>` | — |
| Columna ordenable | `is-sortable` en el `<th>`, `is-sorted` cuando está activa | Ant Design |
| Estado "sin datos" | ver bloque `.empty-state` abajo | Ant Design |
| Input con ícono | ver bloque `.input-group-icon` abajo | Mantine |
| Campo inválido | `aria-invalid="true"` en el input + `<p class="field-error-msg">` | Chakra |
| Switch on/off | ver bloque `.switch` abajo | shadcn/Mantine |
| Alerta con icono | `alert-box alert-info/success/warning/danger` | Chakra |
| Tarjeta KPI plana (alternativa a `.small-box`) | `stat-card` / `stat-label` / `stat-number` / `stat-delta up|down` | Chakra Stat |
| Selector de 2-4 opciones (alternativa a tabs) | `segmented` | Mantine |
| Avatar circular | `avatar avatar-xs|sm|md|lg` | Chakra/Mantine |

### Ejemplos de snippet

**Empty state:**
```html
<div class="empty-state">
  <div class="empty-state-icon">📭</div>
  <p class="empty-state-title">Sin pedidos todavía</p>
  <p class="empty-state-desc">Cuando ingrese un pedido nuevo, va a aparecer acá.</p>
  <button class="btn-primary">Crear pedido</button>
</div>
```

**Input con ícono:**
```html
<div class="input-group-icon">
  <span class="input-icon-left">🔍</span>
  <input class="form-control" placeholder="Buscar cliente...">
</div>
```

**Switch:**
```html
<label class="switch">
  <input type="checkbox">
  <span class="switch-track"></span>
</label>
```

**Stat card:**
```html
<div class="stat-card">
  <p class="stat-label">Ventas del mes</p>
  <p class="stat-number">$1.240.500</p>
  <span class="stat-delta up">▲ 12% vs mes anterior</span>
</div>
```

## Punto 4 — resultado de la revisión de las 14 páginas que quedaban afuera

Se inspeccionaron una por una. Ninguna recibió el reskin completo
(`reskin-patch.css` + `reskin-patch-v2-shadcn.css`); se dividieron en
tres grupos:

**A. Redirects sin contenido visual (5) — sin cambios, no aplica:**
`admin/cta-cte.html`, `admin/liquidacion.html`, `admin/lotes.html`,
`admin/presupuestos.html`, `admin/superadmin.html`. Son stubs que
hacen `location.replace(...)` a páginas que ya tienen el reskin v2
(`vencimientos`, `pedidos`, `saas-billing`).

**B. PWA chofer (4) — reskin completo descartado a propósito:**
`chofer/index.html`, `chofer/invitacion.html`, `chofer/login.html`,
`chofer/remito.html`. Tienen su propio sistema de diseño mobile-first
(botones full-width, padding generoso para touch targets con guantes,
color `#185FA5`, radius 10px). El `!important` de
`reskin-patch-v2-shadcn.css` sobre `.btn-primary`/`.form-control`
reduciría el tamaño de los botones por debajo de 44-48px, degradando
la app en uso real por choferes en la calle. Se decidió no tocarlas.

**C. Páginas públicas / marketing (5) — reskin completo descartado a propósito:**
`index.html`, `registro.html`, `cliente/login.html`, `privacidad.html`,
`terminos.html`. `index.html` y `registro.html` tienen sus propios
`.btn-primary`/`.btn-ghost` pensados como CTAs de landing (tipografía
grande, `<a>` en vez de `<button>`); pisarlos con las clases del admin
sería una regresión visual en las páginas de conversión, no una mejora.
`cliente/login.html` tiene su propio `.btn-ingresar`. `privacidad.html`
y `terminos.html` son texto legal sin componentes interactivos que
mejorar.

**Agregado seguro aplicado a los 9 de B + C** (no a los 5 stubs, que no
tienen `<head>` con contenido para mejorar): se creó
`shared/a11y-focus.css`, un subconjunto mínimo de v2 con:
- Anillo de foco de teclado (`:focus-visible`) — solo en selectores de
  *elemento* (`button`, `a`, `input`, `select`, `textarea`,
  `[tabindex]`), sin clases, para no pisar los botones a medida de
  cada página.
- `prefers-reduced-motion` respetado.

Se verificó antes que ninguna de las 9 páginas tuviera ya una regla
`:focus-visible` en conflicto (solo tenían `:focus` con `border-color`,
que conviven sin problema con el anillo nuevo). El `<link>` se agregó
al final del `<head>` de las 9 páginas.

## Próximos pasos sugeridos (por impacto)
1. **Tablas** (`stock.html`, `pedidos.html`, `cta-cte.html`, `cheques.html`):
   agregar `table-compact` + `table-sticky` — son las pantallas con más
   filas del sistema, mayor beneficio inmediato.
2. **Dashboard**: reemplazar 2-3 `.small-box` por `.stat-card` como
   prueba piloto antes de decidir si se migra todo el mazo de KPIs.
3. **Formularios largos** (reglas-precio, facturacion-config): agregar
   `aria-invalid` + `field-error-msg` a los campos con validación.
4. Si en algún momento se quiere un reskin visual real para la PWA
   chofer o las páginas públicas, tiene que ser un diseño dedicado
   (no el de admin) — requiere una decisión de producto, no un parche
   automático.
