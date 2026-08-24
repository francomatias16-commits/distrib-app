# v869 · Reestructuración visual del dashboard

## Objetivo

Se rehizo la presentación de las superficies de **Comprobantes ARCA**, **POS · Caja** y **Score · Cheques** sin cambiar sus fuentes de datos, IDs funcionales ni destinos de navegación.

## Cambios

- Cada módulo tiene ahora una superficie continua con identidad propia:
  - ARCA: ciruela profunda.
  - Caja: verde petróleo operativo.
  - Score: azul pizarra.
- Se quitaron las mini superficies claras que encerraban cada KPI.
- Los valores se agrupan mediante jerarquía tipográfica, separación y líneas sutiles.
- “Rechazados” ya no se muestra dentro de una caja roja independiente: mantiene el color de alerta y una regla inferior fina dentro de la composición del Score.
- Se conservaron la carga desde Supabase, los enlaces, el zoom de tarjetas, los filtros, la ordenación y los estados vacíos.

## Validación

- Se verificó que los identificadores funcionales (`arca-*`, `pos-*` y `cheq-*`) siguen presentes.
- Se verificó que la lógica ya no aplica `kpi-box-alert` al bloque de rechazados.
- El archivo continúa siendo un documento HTML autocontenido en su estructura original y el resto del proyecto se conserva sin eliminar archivos.