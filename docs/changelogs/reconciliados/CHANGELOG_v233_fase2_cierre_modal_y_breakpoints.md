# CHANGELOG v233 — Fase 2: cierre — consolidación de `.modal` (panel lateral) y decisión final sobre breakpoints sueltos

**Fecha:** 2026-08-25

## Consolidado: `.modal` — panel lateral (4 de 5 páginas)
Al re-inspeccionar los 11 archivos con `.modal { ... }` propio, se encontró que
`clientes.css`, `facturacion.css`, `productos.css` y `stock.css` son
**literalmente idénticos** salvo 3 valores (`right`, `width`, `gap`) — el mismo
patrón de duplicación que `.filtros-bar` y `.btn-exportar`, no visto antes
porque la primera pasada comparó los 11 archivos entre sí sin aislar el
subconjunto que sí comparte mecanismo.

Forma base movida a `componentes-admin.css`, con selector `body.dash-X .modal`
(mismo patrón que `.badge-estado`) porque `componentes-admin.css` carga
DESPUÉS del CSS de cada página en estas 4 — sin el `body.dash-X` la base
compartida ganaría por orden de carga y anularía el `right`/`width`/`gap`
locales. Cada archivo de página conserva solo esos 3 valores (más el
`transform: none` de `productos.css`, que sigue siendo necesario y documentado
igual que antes). Verificado: llaves balanceadas en los 5 archivos tocados y
las reglas `.modal.open { right: 0; }` (que dependen de que `right` siga
siendo local) intactas en los 4.

`pedidos.css` se dejó fuera a propósito: usa `transform: translateX()` en vez
de animar `right`, un mecanismo distinto, no una variante de valores — no es
el mismo bug.

Los otros 6 archivos con `.modal` propio (`automatizacion`, `finanzas`, `rutas`,
`rutas-professional`, `tema-claro-shipp`, y el genérico centrado de
`adminlte-components.css`) siguen siendo diseños realmente distintos (modal
centrado vs. panel lateral, anchos distintos) — no hay nada mecánico para
unificar ahí sin decidir cuál "gana", que es una decisión de diseño, no un bug.

## Breakpoints sueltos — decisión final, no un pendiente más
Se intentó cerrar esto con una migración "segura": alias vía token CSS
(`var(--bp-md)`, etc.) en los valores que ya coinciden con la escala (480,
640, 900, 1200px — más de 60 de los ~160 usos). **No es viable**: las custom
properties de CSS no se evalúan dentro de la condición de un `@media`
(`@media (max-width: var(--bp-md))` no es válido en ningún navegador), así
que no hay forma de tocar esto sin cambiar el número real en cada `@media`.
Para los ~20 valores que no coinciden con la escala (768, 700, 760, 600, 560,
1024, etc.), "migrar" significa correr el punto de quiebre real de esa regla
— exactamente el tipo de cambio que solo se puede verificar mirando la página
en varios anchos, y sigue bloqueado acá por la restricción de red hacia
Chromium. No se tocó ningún valor de `@media`.

## Estado de la Fase 2
Cerrada en su totalidad la parte resoluble sin QA visual: `.filtros-bar`,
`.btn-exportar`/`.btn-importar`, y ahora `.modal` (panel lateral). `.chip`,
`.badge-estado` y `.tabla-wrap` ya estaban bien de antes, confirmado sin
cambios. Queda un único punto genuinamente fuera de alcance de este entorno —
no por elección sino por límite técnico real (sin navegador para verificar):
la migración de los ~20 breakpoints sueltos a la escala `--bp-*`. Eso pasa a
ser el primer ítem de una Fase 3 con QA visual real, no una tarea de CSS que
se pueda completar a ciegas.
