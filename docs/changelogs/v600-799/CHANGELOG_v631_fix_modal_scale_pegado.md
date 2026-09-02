# v631 — Fix: modal de producto no abría del todo (transform pegado)

## Síntoma
"No abre por completo el formulario" al hacer click en Nuevo/Editar producto:
el panel se veía como si la animación de apertura se hubiera frenado a
mitad de camino.

## Causa raíz
`adminlte-components.css` (carga antes que `productos.css`) define su
propio componente `.modal` centrado, con animación de entrada:

```css
.modal { transform: scale(.96); ... }
.modal-backdrop.visible .modal { transform: scale(1); }
```

`productos.js` (`abrirModalProducto`) usa el patrón de panel lateral
(`.modal.open { right: 0 }`) y nunca agrega la clase `.visible` al
backdrop. Como ninguna otra regla en la cascada de `productos.html`
volvía a declarar `transform` sobre `.modal`, el modal quedaba
permanentemente en `scale(.96)` — nunca llegaba a `scale(1)`.

## Fix
Se agregó `transform: none;` a la regla `.modal` propia de
`productos.css` (que carga después y es la dueña real del patrón usado
en esta pantalla), cancelando el `scale(.96)` heredado.

Archivo: `frontend/admin/css/productos.css`
Cache-busting bumpeado: `productos.css?v=232` → `?v=233` en
`frontend/admin/productos.html`.

## Nota
No se tocó `adminlte-components.css` (lo usan otras pantallas con su
propio patrón de modal centrado + `.visible`), ni `productos.js`.
Cambio quirúrgico de una sola propiedad.
