# v731 — `remito.js` (excepción) + `vincular-celular.js` (migrado completo)

## `remito.js` — evaluado, no migrado (excepción documentada)

29 hex/rgba dentro de un `<style>` embebido en un documento HTML completo
que la función abre con `window.open('', '_blank')` y escribe con
`document.write()` — confirmado por el propio comentario del archivo: *"No
tiene dependencias externas: abre una ventana con HTML/CSS listo para
imprimir"*. Esa ventana no carga `tokens.css`, así que introducir
`var(--...)` ahí no resolvería a nada — sería un cambio que rompe el
render, no una migración.

Se deja sin tocar, mismo criterio que la excepción ya documentada de
`tema-claro-shipp.css`: documento autocontenido con paleta propia, no es
drift del sistema. Los grises puros del remito son además una elección
razonable para un documento pensado para imprimirse en blanco y negro.

## `vincular-celular.js` — migrado completo (21 colores)

Modal de "vincular celular" (QR para usar el teléfono como lector remoto),
estilos inyectados en `document.head` de la página viva — a diferencia de
`remito.js`, acá los tokens sí están disponibles. Era la paleta completa de
un modal con estética SaaS genérica, incluyendo literalmente `#2563EB` — el
mismo "Electric Blue heredado de Stripe/Linear" que
`DESIGN_SYSTEM_HOJA_DE_RUTA.md` nombra como lo que el rediseño reemplaza.

Mapeo completo: fondos/bordes → `--color-surface`/`--color-surface-2`/
`--color-border`/`--color-border-soft`; texto → `--color-text`/
`--color-text-muted`/`--color-text-light`; azul de acento → `--color-primary`
(verde del sistema); estados → `--color-warning-mid` (punto "esperando"),
`--color-success`/`--color-success-bg` (check de éxito),
`--color-danger`/`--color-danger-bg` (error/botón peligro); hover de botón
peligro → `color-mix(in srgb, var(--color-danger-bg) 92%, black)`, mismo
patrón que `cobranzas-gentelella.css`; overlay y shadow → tinta ink
`rgba(22,24,29,X)`.

## Verificado

- `remito.js`: sin cambios, 0 riesgo de regresión.
- `vincular-celular.js`: `node --check` sin errores; 0 hex/rgba crudos
  restantes (confirmado con el script comparativo).

## Lección para el resto del frente

Antes de migrar un archivo, confirmar si sus estilos se inyectan en el
documento vivo (tiene `tokens.css`) o en un documento standalone
(`window.open()` + `document.write()`, o similar) — en el segundo caso es
excepción, no deuda. Agregado como criterio explícito en
`SEGUIMIENTO_HOJA_DE_RUTA.md` §4.

## Siguiente

`rutas.js` (22 ocurrencias) — ver SEGUIMIENTO_HOJA_DE_RUTA.md §4.
