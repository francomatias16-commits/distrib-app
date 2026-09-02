# v866 — Información operativa en tarjetas del resumen de repartos

## Objetivo

Completar el espacio disponible de las cuatro tarjetas superiores del resumen
sin reducir artificialmente su tamaño ni agregar consultas nuevas.

## Cambios

- **Pedidos despachados:** promedio diario y día de mayor despacho de los
  últimos siete días.
- **Entregas exitosas:** avance real del día y cantidad de rutas/choferes
  monitoreados.
- **Total cobrado:** promedio diario y mejor día de cobranza del período.
- **Cobranzas de hoy:** total acumulado, cantidad de operaciones y hora/monto
  del último cobro registrado.

Todos los valores se calculan desde las respuestas que ya usa la sección:
no se modificaron sincronizaciones, RPCs ni contratos con Supabase.