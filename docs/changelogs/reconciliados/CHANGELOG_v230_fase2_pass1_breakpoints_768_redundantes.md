# CHANGELOG v230 — Fase 2 (pasada 1): breakpoint redundante de `.filtros-bar` en 7 páginas

**Fecha:** 2026-08-25
**Contexto:** Continuación inmediata de v229 (Fase 1). Al revisar los 25+ archivos de
página que redeclaran `.filtros-bar` para decidir qué tocar en Fase 2, apareció un
caso concreto y seguro de resolver ya: 7 archivos `-gentelella.css` tenían su propio
`@media (max-width: 768px) { .filtros-bar { flex-direction:column; ... } }` con
`!important`, duplicando *exactamente* el comportamiento mobile que ya hace el
canónico de `componentes-admin.css` (Fase 1) — pero en 768px en vez de 640px
(`--bp-md`). Es el ejemplo de manual del hallazgo original de la auditoría: dos
archivos "creyendo" que el corte a mobile es un ancho distinto.

## Qué se hizo

Se quitó el bloque `.filtros-bar { flex-direction:column; align-items:stretch }` +
`.filtros-bar input, select { width:100% }` de 768px en:

- `auditoria-gentelella.css`
- `devoluciones-gentelella.css`
- `gastos-generales-gentelella.css`
- `notas-gentelella.css`
- `reglas-precio-gentelella.css`
- `rentabilidad-producto-vendedor-gentelella.css`
- `rentabilidad-zona-gentelella.css`

Se dejó un comentario puntero en cada uno, no un borrado silencioso. El resto de
cada bloque `@media (max-width: 768px)` (reglas de `.kpis-grid`, `.form-grid`, etc.
no relacionadas a `.filtros-bar`) se conservó intacto.

## Qué se revisó y se decidió NO tocar (a propósito)

- **Las reglas `body.dash-<pagina> .filtros-bar input/select { border/background/color
  vía --ge-* !important }`** en ~20 archivos `-gentelella.css`: no son bugs, son un
  reskin visual deliberado ("tema Gentelella") que varias páginas usan a propósito.
  Sacarlas cambiaría el diseño visual de esas pantallas, no es parte del bug de
  layout/tamaño.
- **`reskin-patch.css`** (fondo/borde/sombra "glass" de `.filtros-bar` vía
  `!important`, agrupado con `.filtros-section/.filter-bar/.search-bar`): sigue
  activo y `tema-claro-shipp.css` depende explícitamente de que gane por
  especificidad (documentado en su propio comentario). No se tocó.
- **Los 6 archivos base de página con `.filtros-bar {...}` completa sin scope**
  (`clientes.css`, `compras.css`, `stock.css`, `facturacion.css`, `pedidos.css`,
  `finanzas.css`): se verificó que en las 6 páginas correspondientes
  `componentes-admin.css` carga *después* (gracias al fix de orden de v229), así que
  el canónico gana por cascada sin necesidad de tocar estos archivos. Se comprobó
  explícitamente, no se asumió.
- **Los selectores con ID** (`#vista-clientes .filtros-bar`, `#vista-stock
  .filtros-bar`, etc.): tienen mayor especificidad a propósito para ajustes puntuales
  (color de borde, z-index de dropdown) que no compiten con el comportamiento mobile
  — se dejaron.

## Verificación
- Grep de barrido final: no queda ningún otro `max-width` compitiendo con el
  comportamiento column/100% de `.filtros-bar` en `frontend/admin/`.
- Balance de llaves OK en los 7 archivos tocados.
- Sin verificación visual (mismo bloqueo de red a Chromium que v229) — pendiente
  QA manual antes de dar esto por cerrado.

## Pendiente (sigue en Fase 2)
- Migrar los ~20 valores de `max-width` sueltos restantes (no relacionados a
  `.filtros-bar`) a la escala `--bp-*`.
- Consolidar `.tabla-wrap`, `.modal`, `.chip`, `.badge-estado`,
  `.btn-exportar/importar` (mencionados en el plan, no tocados todavía).
- QA visual real de las 57 páginas.
