# v730 — `productos.js`: primer archivo del frente de hex crudo real

Primer archivo migrado del frente que quedó pendiente después de v729 (hex/rgba
crudos fuera de `var()`, ~261 ocurrencias en 34 archivos).

## Migrado

7 `rgba(0,0,0,X)` (fondo de overlay de modal ×3, borde de opción seleccionable,
pista del spinner, fondo sutil de aviso de contador Serper, fondo de opción no
seleccionada) → `rgba(22,24,29,X)`. Mismo alpha, mismo mapeo de tinta (ink en
vez de negro puro) ya usado en `tienda-nav.css` y `pedido-modal-fullscreen.css`
para overlays.

## Dejado intencional (documentado en SEGUIMIENTO_HOJA_DE_RUTA.md §3.7)

`PALETA` — 12 pares fondo/texto (Tailwind: amarillo, ámbar, verde, naranja,
azul, piedra, rosa, pizarra, gris, rojo, violeta, teal) que rotan por
categoría de producto. El sistema de tokens tiene ~5 colores semánticos;
forzar esta paleta a tokens colapsaría categorías distintas al mismo color.
Mismo criterio que la excepción del verde de marca de WhatsApp.

## Verificado

`node --check admin/js/productos.js` — sin errores de sintaxis. 0 hex/rgba
nuevos introducidos, solo re-mapeo de los 7 existentes.

## Siguiente

`remito.js` (29 ocurrencias) — ver SEGUIMIENTO_HOJA_DE_RUTA.md §4.
