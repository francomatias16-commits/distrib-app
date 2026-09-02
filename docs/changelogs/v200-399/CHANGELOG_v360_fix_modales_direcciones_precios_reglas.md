# CHANGELOG v360 — Fix modales sin evento (Direcciones, Precios especiales, Reglas de precio)

## Problema

- **Clientes → Direcciones**: el botón "Editar" no producía ningún efecto visible.
- **Clientes → Precios especiales**: mismo problema en su modal.
- **Comercial → Reglas de precio (Descuentos automáticos)**: el modal se abría pero
  se cerraba solo al tocar cualquier botón de adentro (Guardar, Cancelar, etc.).

## Causa raíz

En toda la app, los modales usan un patrón de "cajón deslizante": el CSS posiciona
el `.modal` fuera de pantalla (`right: -600px`) con `z-index` por encima del
`.modal-backdrop`, y una clase `.open` lo desliza a la vista (`right: 0`). El JS
de apertura/cierre debe alternar esa clase `.open`.

Los modales de Direcciones y Precios especiales (`clientes.js`) y el modal completo
de Reglas de precio (`reglas-precio.js`) se programaron usando únicamente
`style.display = 'block'/'none'`, sin agregar/quitar la clase `.open`:

- En Direcciones/Precios: el modal quedaba "display:block" pero seguía posicionado
  fuera de la pantalla (nunca recibía `.open`) → parecía que el botón no hacía nada.
- En Reglas de precio: esa pantalla no tenía ninguna regla CSS que le diera al
  `.modal` una posición fija con z-index por encima del backdrop. El backdrop
  (fixed, cubre toda la pantalla, z-index 400 por `--z-modal`) quedaba siempre
  arriba y absorbía cualquier click, disparando `cerrarModalRegla()` al toque.

## Fix

- `frontend/admin/js/clientes.js`:
  - `abrirModalDireccion()` / `cerrarModalDireccion()` ahora usan
    `classList.add('open')` / `classList.remove('open')` sobre `#modal-direccion`.
  - `abrirModalPrecio()` / `cerrarModalPrecio()` ídem sobre `#modal-precio`.
- `frontend/admin/js/reglas-precio.js`:
  - `abrirModalRegla()` / `cerrarModalRegla()` ídem sobre `#modal-regla`.
- `frontend/admin/css/reglas-precio-gentelella.css`:
  - Nuevas reglas `#modal-regla-backdrop.modal-backdrop` y `#modal-regla.modal`
    que replican el patrón de cajón deslizante (position fixed, right -600px,
    z-index 400 por encima del backdrop en 300, `.open { right: 0 }`).

## Archivos modificados

- `frontend/admin/js/clientes.js`
- `frontend/admin/js/reglas-precio.js`
- `frontend/admin/css/reglas-precio-gentelella.css`

## Deploy

Cambios solo de frontend → requiere commit del ZIP y deploy en Vercel (no hay
cambios de base de datos).
