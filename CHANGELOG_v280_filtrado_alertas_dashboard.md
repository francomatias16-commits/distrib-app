# v280 — Filtrado real desde las alertas del dashboard

## Problema
Las dos alertas superiores del panel principal ("Alerta de stock crítico" y
"Cheques vencidos sin gestionar") redirigían a `/admin/stock.html` y
`/admin/cheques.html`, pero sin ningún filtro aplicado — el usuario llegaba
a la sección y tenía que buscar manualmente los ítems que la alerta
mencionaba.

## Cambios

### Stock — pill "Bajo su mínimo" (ya integrado desde v279 sin publicar)
- Nuevo pill de filtro en `stock.html` que usa el mismo criterio real de la
  alerta del dashboard: `cantidad_disponible < stock_minimo` por producto
  (no un umbral fijo como los pills existentes "Crítico"/"Bajo").
- Como Supabase-js no permite comparar columna contra columna, el filtro
  consulta `GET /api/admin/stock/bajo` (el mismo endpoint que ya calcula
  este número para el dashboard) y filtra la tabla por esos `producto_id`.
- Se agregó `api-client.js` a `stock.html` para poder llamar ese endpoint.
- El export a Excel respeta el mismo filtro cuando está activo.

### Cheques — checkbox "Solo vencidos"
- Nuevo checkbox en la barra de filtros de `cheques.html`.
- Criterio: `estado = en_cartera` y vencido, usando `fecha_vto` (con
  `vencimiento` como respaldo) — el mismo criterio que usa el backend en
  `GET /api/admin/alertas` para calcular el número que se muestra en la
  alerta del dashboard. Antes la página usaba solo `vencimiento`, que según
  el propio comentario del backend puede no estar completo en cheques
  cargados por migración; esto podía hacer que el filtro mostrara menos
  cheques que los que decía la alerta.
- Se reutiliza el mismo criterio (`esVencido()`) también para resaltar en
  rojo las filas vencidas en la tabla, reemplazando el cálculo duplicado
  que había antes.

### Dashboard — links de las alertas
- "Resolver y cargar stock" → `/admin/stock.html?filtro=bajo_minimo`
- "Revisar cheques" → `/admin/cheques.html?filtro=vencidos`
- Bonus: la tarjeta de "tareas accionables" (zona 4, mismo bug) también
  quedó apuntando a `?filtro=bajo_minimo`.

Ambas páginas leen el query param al cargar y activan el filtro
correspondiente antes de la primera consulta, así que al hacer clic en la
alerta el usuario ve directamente la lista filtrada — no un tablero
completo para buscar a mano.

## Archivos modificados
- `frontend/admin/stock.html`
- `frontend/admin/js/stock.js`
- `frontend/admin/cheques.html`
- `frontend/admin/js/cheques.js`
- `frontend/admin/js/dashboard-optimizado.js`

## Sin migraciones SQL
Este paquete no requiere cambios de base de datos.
