# v369 — Auditoría Gentelella: formularios/páginas sin cobertura de estilos

Continuación de la auditoría estructural (link de CSS, clase `dash-gentelella`,
clases usadas en HTML/JS sin regla en ningún stylesheet cargado por la página).

## Gap crítico resuelto — `pos.html`

Los 3 modales de "Fase 3" (alta rápida de cliente, alerta de stock vacío,
facturar opcional) usaban nombres de clase con drift respecto al resto del
sistema y no tenían **ningún CSS**:

- `pos-modal-header` (en vez de `pos-modal-head`)
- `pos-modal-cerrar` (en vez de `.modal-close`)
- `pos-modal-footer` (en vez de `.pos-modal-acciones`)
- `pos-modal-body`, `pos-modal-titulo`

Se agregaron alias en `frontend/admin/css/pos.css` y `pos-gentelella.css`
replicando el tratamiento visual ya establecido, sin tocar HTML ni JS.

También se corrigió un typo real: dos botones usaban `btn--secundario`
(sin estilo) en vez de `btn--secondary`.

## Gaps menores resueltos

- `reglas-precio.html`: faltaba `.form-requerido` (asterisco rojo de campo
  obligatorio) → agregado a `reportes.css` (compartido por esta página,
  `rentabilidad-zona.html` y `reportes-financieros.html`).
- `rentabilidad-zona.html`: faltaban `.chip`, `.chip-completada` y
  `.chip-cancelada` (los chips de estado no tenían ningún estilo) →
  agregados a `reportes.css`, mismo look que `rutas.css`.
- `migracion.html`: `.mig-paso` (contenedor de cada paso del wizard) no
  tenía estilo, los pasos quedaban sin separación vertical → agregado
  a `migracion.css`.

## Descartado como no-bug (verificado, sin impacto visual)

- `.content-area` en reportes-financieros/stock/ventas: div wrapper
  redundante, el padding ya lo aplica `.main` (base-layout.css).
- `.container` en saas-billing.html: tiene `style="padding:24px"` inline
  como respaldo.
- `cta-cte.html`, `lotes.html`, `presupuestos.html`, `liquidacion.html`:
  son stubs de redirección (body vacío o casi vacío), las clases sin
  cobertura ahí son JS viejo que ya no se ejecuta.
- Múltiples "clases sin cobertura" detectadas por el script inicial eran
  falsos positivos: variables de JS dentro de template literals
  (`${...}`) o nombres pasados a `getElementById` (no `classList`),
  identificados y filtrados en el análisis.
