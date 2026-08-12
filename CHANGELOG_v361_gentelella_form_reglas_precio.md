# CHANGELOG v361 — Reskin Gentelella del formulario de Reglas de precio

## Contexto

El modal de alta/edición de reglas de precio (Descuentos automáticos) nunca
había recibido el reskin Gentelella en profundidad: algunas reglas CSS
apuntaban a clases que no existen en el HTML real (`.modal-overlay`,
`.modal-box`, `.modal-inner`) y por lo tanto no se aplicaban nunca, y el
formulario no tenía ningún layout de columnas (`.form-row`/`.form-group`
sin estilos), por lo que cada campo quedaba apilado uno debajo del otro en
una sola columna larga.

## Cambios — `frontend/admin/css/reglas-precio-gentelella.css`

- **Modal**: reemplazadas las reglas con selectores muertos por las clases
  reales (`.modal-backdrop`, `.modal`, `.modal-header`, `.modal-titulo`,
  `.modal-subtitulo`, `.modal-close`), en línea con el patrón ya usado en
  `clientes-gentelella.css`. Se eliminó además una regla que pintaba
  `#modal-regla` (el panel) con el color oscuro pensado para el backdrop.
- **Layout**: se agregó la grilla de 2 columnas para `.form-row`/`.form-group`
  que faltaba (Zona/Cantidad mínima, Tipo de descuento/Valor, Vigente
  desde/hasta, Prioridad/Regla activa ahora van en pares), igual que en
  productos, clientes y stock. Colapsa a 1 columna en mobile (<640px).
- **Selector de alcance** (Todo el catálogo / Producto específico /
  Categoría): las pastillas ahora usan los tokens Gentelella y resaltan
  con borde + fondo teal cuando están seleccionadas.
- **Checkbox "Regla activa"** y **tooltip de prioridad**: colores e
  `accent-color` en teal, consistentes con el resto del admin.
- Inputs de fecha/número: `color-scheme: light` para que el ícono nativo
  del navegador no desentone con el fondo claro de Gentelella.

## Archivos modificados

- `frontend/admin/css/reglas-precio-gentelella.css`

## Deploy

Solo CSS → requiere commit del ZIP y deploy en Vercel.
