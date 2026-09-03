# v951 — Gastos Generales: fecha por defecto en UTC + etiqueta "recurrente" engañosa

Auditoría pre-lanzamiento, etapa 3 (Pagos online MP + Conciliación bancaria +
Gastos generales), arrancando por Gastos Generales (v750) por ser 100% nuevo
y sin ninguna auditoría previa (a diferencia de MP, ya revisado en la etapa
anterior).

## Hallazgo 1 — fecha por defecto se autocompleta un día adelantada de noche (bug sistémico ya conocido, UTC vs. hora AR)

`fmtFechaInput()` en `frontend/admin/js/gastos-generales.js` usaba
`d.toISOString().slice(0, 10)` para precargar el campo "Fecha" del modal
"Nuevo gasto" con la fecha de hoy. `toISOString()` convierte a UTC antes de
formatear — para Argentina (UTC-3), cargar un gasto entre las 21:00 y las
23:59 hora local hace que el campo se autocomplete con la fecha de **mañana**
en vez de hoy.

Es el mismo bug de fondo ya identificado y corregido en otros módulos del
proyecto (ya existe `fechaLocalISO()` en `facturacion.js` con el fix
correcto: componer la fecha con `getFullYear()/getMonth()/getDate()`
locales, sin pasar por UTC) — acá se había reintroducido en un módulo nuevo
que no pasó por ese fix.

**Impacto real:** un gasto cargado de noche (el momento más común para
cerrar caja/cargar gastos del día) queda fechado mañana. Como "Gastos
Generales" y "Ganancia Neta" (Reportes → Finanzas) filtran estrictamente por
`fecha` del período, ese gasto puede terminar contado en el mes/período
siguiente en vez del que realmente corresponde — silencioso, sin ningún
error visible.

**Fix:** `fmtFechaInput()` ahora usa el mismo criterio que `fechaLocalISO()`
(getters locales, sin UTC).

## Hallazgo 2 — "Gasto recurrente (se repite todos los meses)" no repite nada

El checkbox y el tooltip del contador en el dashboard afirman que un gasto
marcado como recurrente "se repite todos los meses". Revisé toda la cadena
(`gastos_generales`, `obtener_resumen_gastos_generales`, el estado financiero
integral de la migración 564, y el resto del backend) y no hay ningún cron,
trigger ni lógica que vuelva a insertar el gasto al mes siguiente. `recurrente`
es una columna booleana que solo alimenta un chip visual y un contador — es
una etiqueta, no una automatización.

**Impacto real:** alguien que carga "Alquiler" en enero marcándolo
recurrente, esperando (por el propio texto de la app) que se repita solo,
va a encontrar Gastos Generales de febrero en $0 para esa categoría —
subestimando gastos y sobreestimando Ganancia Neta, justo la métrica que
esta migración existe para corregir.

**Fix aplicado (alcance acotado a la etiqueta, no a construir la
automatización):** cambié el texto del checkbox y del tooltip para que
digan lo que el sistema realmente hace — es una etiqueta para identificarlo
como gasto fijo, no se vuelve a cargar solo. Construir la generación
automática mes a mes es una decisión de producto (qué día del mes generarlo,
qué pasa si se edita el monto a mitad de mes, si avisa antes de crearlo,
etc.) que no me pareció correcto tomar unilateralmente dentro de un fix de
auditoría — si lo querés, lo armo aparte como una pieza nueva.

## Archivos tocados

- `frontend/admin/js/gastos-generales.js` — `fmtFechaInput()` corregido; tooltip del contador "Recurrentes".
- `frontend/admin/gastos-generales.html` — texto del checkbox "Gasto recurrente".

## Pendiente

- Decisión de producto: ¿se arma la automatización real de gastos
  recurrentes (generación mensual), o se deja como etiqueta manual y ya
  quedó suficientemente aclarado con el fix de texto de arriba?
- No revisé todavía Mercado Pago más allá de lo ya cerrado en la etapa
  anterior (cta_cte), ni Conciliación bancaria — siguen en la cola de esta
  etapa 3.
