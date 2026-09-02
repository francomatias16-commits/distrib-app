# CHANGELOG v725 — Compactación pantalla Devoluciones

## Motivo
La página principal, el panel lateral de detalle y el modal "Registrar
devolución" tenían demasiado aire muerto (paddings y gaps generosos
heredados de finanzas.css/adminlte-components.css) para la cantidad de
contenido real que muestran.

## Cambios
- `frontend/admin/css/devoluciones-gentelella.css`: nueva sección de
  overrides "COMPACTACIÓN" — reduce padding de tabla, header de tabla,
  panel lateral (header/body/footer) y secciones del modal; sube
  ligeramente el tamaño de fuente de filas de detalle, celdas de tabla,
  labels e inputs del modal para compensar la mayor densidad.
- `frontend/admin/devoluciones.html`:
  - Grid del modal: el campo "Foto (opcional)" pasa a compartir fila con
    "Motivo" (antes ocupaba una fila propia de ancho completo) — una fila
    menos en el formulario.
  - Gaps/márgenes inline del grid de "Datos generales" de 10px → 8px.
  - Labels del modal y del filtro de fechas de 12px → 13px.
  - Cache-busting: `devoluciones-gentelella.css?v=2`, `devoluciones.js?v284`.
- `frontend/admin/js/devoluciones.js`: botón "Guardar notas" del panel
  lateral con tipografía y padding levemente mayores (12px→13px).

## No afecta
Ningún otro módulo — todo el CSS nuevo está scopeado a
`body.dash-devoluciones-gentelella`, y los cambios de HTML/JS son
exclusivos de `devoluciones.html`/`devoluciones.js`.
