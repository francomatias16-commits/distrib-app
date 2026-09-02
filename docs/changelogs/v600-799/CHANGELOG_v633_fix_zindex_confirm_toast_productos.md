# v633 — Fix z-index: confirm y toast por encima del panel de producto

## Problema
El panel lateral `#modal-producto` (z-index: 9999) tapaba los diálogos
`window.confirmar` (--z-modal: 400) y los toasts (--z-toast: 600).
Al intentar borrar o confirmar una acción desde el formulario de producto,
el diálogo de confirmación aparecía oculto detrás del panel, haciendo la
UI inutilizable.

## Causa raíz
Los tokens CSS `--z-modal` y `--z-toast` están definidos en `tokens.css`
con valores 400 y 600 respectivamente, muy por debajo del z-index: 9999
que usa el panel de producto.

## Solución aplicada
Se agregaron overrides de los tokens CSS al final de
`frontend/admin/css/productos-modal-fix.css` (único punto de carga de
ese CSS, solo en `productos.html`):

```css
:root {
  --z-modal: 10100;
  --z-toast: 10200;
}
```

Esto eleva los diálogos y toasts por encima del panel sin afectar
el resto del sistema (el override solo aplica cuando se carga ese CSS).

## Archivos modificados
- `frontend/admin/css/productos-modal-fix.css` — agregados overrides al final
- `frontend/admin/productos.html` — versión del CSS: v1 → v2

## Sin migraciones de base de datos
