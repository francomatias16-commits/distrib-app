# v947 — Fix: botón "Volver al inicio" invisible en módulos (mobile)

## Problema
En `frontend/landing/modulos/styles.css`, dentro del media query `@media (max-width: 760px)`,
la regla `.back-link { display: none; }` ocultaba por completo el link "Volver al inicio"
del header en las páginas de módulo cuando se veían desde celular.

## Fix
- Se eliminó el `display: none` sobre `.back-link`.
- Se agregó `flex-wrap: wrap` y `gap` a `.header-actions` para que el link y el botón
  "Ver demo" no se amontonen en pantallas angostas.
- Se redujo levemente el `font-size` de `.back-link` en mobile para que conviva mejor
  con el botón CTA.

## Archivo modificado
- `frontend/landing/modulos/styles.css`
