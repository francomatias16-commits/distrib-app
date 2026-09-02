# v545 — Rediseño de indicadores KPI: de tira de manifiesto a tarjetas

## Por qué
La v2 de `kpi-line.css` (tira de "manifiesto de carga" con perforaciones,
casilleros divididos por líneas punteadas y numeración 01·02·03) generaba
rechazo visual: dato apretado en una sola línea, sin aire, y sin
explicación de qué significaba cada número.

## Qué cambia
`frontend/shared/kpi-line.css` pasa de una tira continua a un **grid de
tarjetas independientes**, una por indicador:

- Número grande centrado, en tinta uniforme (ya no coloreado por estado).
- Filete corto de color debajo del número — reemplaza a la banderita y a
  la numeración de renglón; sigue codificando el estado (rojo/amarillo/
  azul/verde/morado).
- Label en negrita, sin mayúsculas forzadas.
- **Nueva línea de descripción** debajo del label (`kpi-line-sub`) en
  cada tarjeta, explicando en una frase corta qué es el dato y de dónde
  sale (ej. "Facturado" → "Pedidos ya facturados").
- Tarjetas clickeables (filtros de facturación/saas-billing): al
  activarse quedan con borde y fondo tintado del color de acento, en vez
  del subrayado inferior de la versión anterior.
- En mobile el grid se reacomoda solo (auto-fit), sin reglas especiales
  de layout.

## Alcance
- **CSS**: reescritura completa de `frontend/shared/kpi-line.css`
  (mismas clases/ids — cero cambios estructurales de las 22 pantallas
  que ya la consumían).
- **HTML/JS**: se agregó `kpi-line-sub` con una descripción breve en los
  indicadores que todavía no la tenían, para que las ~28 tarjetas de
  indicador del admin (pedidos, POS, puntos, cta.cte. proveedores,
  saas-billing, conversaciones de WhatsApp, conciliación bancaria,
  fidelización, reglas de precio, rentabilidad por producto/vendedor y
  por zona) queden con el mismo formato número + filete + label +
  descripción.

## Pantallas afectadas
cc-proveedores, cheques, cobranzas, comparador-precios,
conciliacion-bancaria, devoluciones, facturacion, fidelizacion, pedidos,
pos, puntos, reglas-precio, rentabilidad-producto-vendedor,
rentabilidad-zona, reportes-financieros, reportes-stock, reportes-ventas,
riesgo-cheques, saas-billing, stock, vencimientos,
whatsapp-conversaciones.

(El dashboard principal no usa este componente — tiene su propio sistema
de tarjetas KPI aparte, sin cambios en esta entrega.)
