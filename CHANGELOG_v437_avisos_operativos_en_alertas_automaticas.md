# v437 — Avisos operativos en "Alertas automáticas"

## Qué pedía
Las notificaciones que ya arma la campanita del topbar (Entrega con cobro
parcial, Faltante/Sobrante de caja al cerrar, Factura con diferencias vs. OC,
cheques vencidos, clientes en riesgo, pedidos demorados, migraciones con
filas pendientes) sólo se veían ahí — top 8, sin historial — y en ningún
lado dentro de la sección "Alertas automáticas" del menú, que hasta ahora
sólo tenía "Movimientos raros" (detección de patrones por IA, un motor
totalmente distinto).

## Qué se hizo
- **Nueva pantalla `/admin/avisos`** ("Avisos operativos"), segundo ítem del
  grupo "Alertas automáticas" en el menú. Reusa el mismo endpoint que ya
  arma la campanita (`GET /api/admin/alertas`, `handleAlertas` en
  `lib/handlers/admin.js`) pero pidiendo más resultados (`?limite=50`) para
  mostrar un historial real en vez del resumen corto del dropdown.
- **`handleAlertas` ahora acepta `?limite=`** (1–50, default 20 — mismo
  comportamiento de siempre para quien no lo mande, como la campanita).
  Antes cada categoría estaba cableada a `.limit(5)` sin importar qué pidiera
  el cliente.
- **"Marcar como revisado"** disponible sólo para los dos tipos que ya lo
  soportaban en el resto de la app (`diferencia_caja` desde cajas.html,
  `entrega_cobro_parcial` desde rutas.js) — reusa el mismo endpoint
  `POST /api/auditoria?accion=resolver` y la tabla `anomalias_revisadas`, sin
  agregar mecanismo nuevo. El resto de los tipos (cheque vencido, factura con
  diferencia, pedido demorado, migración pendiente, cliente en riesgo) se
  resuelven solos cuando cambia el estado real que los origina — igual que
  ya pasa hoy en la campanita — así que en `/admin/avisos` sólo tienen un
  link "Ver detalle →" hacia la pantalla correspondiente.

## Archivos
- `lib/handlers/admin.js` — `handleAlertas`: parámetro `limite` configurable.
- `frontend/admin/js/nav-data.js` — nuevo ítem "Avisos operativos" en el
  grupo `automatizacion`.
- `vercel.json` — ruta `/admin/avisos` → `/frontend/admin/avisos.html`.
- `frontend/admin/avisos.html` (nuevo) — mismo reskin que "Movimientos
  raros" (`anomalias-gentelella.css`, scope `body.dash-anomalias-gentelella`).
- `frontend/admin/js/avisos.js` (nuevo).

## Pendiente / decisiones a revisar
- No agregué paginación real (offset) — varias de las categorías se computan
  al vuelo desde distintas tablas, no desde una sola query, así que un
  historial infinito requeriría rediseñar el endpoint. Por ahora alcanza con
  el tope de 50.
- El resto de los tipos no tienen botón de "revisado" a propósito (ver
  arriba) — si se quiere agregarlo habría que sumar una columna de estado o
  reusar `anomalias_revisadas` con un `tipo_anomalia` nuevo por cada uno.
