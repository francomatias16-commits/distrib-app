# v434 — Fix: sincronización rutas.estado + columna TOTAL / alerta de cobro parcial

## Reporte (Matías)
1. Al marcar "entregado" desde el portal del chofer, algunas secciones del admin
   no se actualizaban (Rutas del día, Historial, Choferes en la calle seguían
   mostrando "Pendiente" mientras "Seguimiento de entrega" ya mostraba 1/1).
2. El chofer cobró $3.200 contra una OC de $3.388 y la diferencia no se
   visualizaba en ningún lado.

## Causa raíz
- `rutas.estado` solo se escribía desde un webhook interno (`evento=despacho`),
  alcanzable únicamente por API externa con `INTERNAL_API_KEY` (n8n/Zapier).
  El flujo normal de la app (chofer marca entrega desde su portal) nunca
  tocaba ese campo, así que la ruta quedaba `pendiente` para siempre aunque
  todas sus entregas ya estuvieran en estado terminal.
- "Seguimiento de entrega" no tiene este bug porque calcula sus números en
  vivo desde la tabla `entregas`, no desde `rutas.estado` — por eso mostraba
  el dato correcto mientras el resto del admin mentía.
- La columna TOTAL en "Rutas del día" e "Historial" estaba hardcodeada a
  `0` / `"—"` — nunca se calculaba.
- No existía ninguna comparación entre `entregas.monto_cobrado` y
  `pedidos.total` para detectar cobros parciales.

## Fix
### Backend (`lib/handlers/pedidos.js`)
- Nueva función `sincronizarEstadoRuta(ruta_id)`: al terminar de actualizar
  una `entrega` (tanto en `entregar` como en `no-entregar`), revisa todas las
  entregas hermanas de la misma ruta:
  - Si **todas** están en estado terminal (`entregado` / `no_entregado`) →
    `rutas.estado = 'completada'`.
  - Si **alguna** ya arrancó y la ruta seguía `pendiente` → `rutas.estado = 'en_camino'`.
  - Nunca pisa `cancelada` ni `completada`.
- Los dos handlers ahora capturan `ruta_id` desde el `.update(...).select('ruta_id')`
  de `entregas` y llaman a `sincronizarEstadoRuta` (best-effort, no bloquea la
  respuesta al chofer si falla).

### Frontend (`frontend/admin/js/rutas.js`)
- `cargarRutasDelDia` y `cargarHistorial` ahora piden también
  `entregas(monto_cobrado, pedidos(total))`.
- Nueva función `celdaTotalRuta(entregas)`: suma `pedidos.total` de la ruta y,
  si hay un cobro registrado menor al total, muestra el monto junto con un
  aviso `⚠ falta $X` (tooltip con el detalle de cobrado vs. total).
- Reemplazado el `"—"` / `0` hardcodeado por `celdaTotalRuta(...)` en ambas
  tablas.

### Datos existentes (Supabase, producción)
- Backfill puntual: rutas con todas sus entregas en estado terminal pero
  `estado` huérfano en `pendiente`/`en_camino` → pasadas a `completada`.
  Afectó 1 fila (ruta `c5ddb238…`, chofer Juan Ramos, la del reporte).

## Pendiente / a decidir
- El $188 de diferencia en el caso reportado queda visible como alerta en la
  UI, pero no se generó automáticamente ninguna nota de crédito ni ajuste
  contable — habría que definir con el equipo si un cobro parcial debe:
  (a) quedar como saldo en cuenta corriente del cliente, o
  (b) requerir una nota/justificación obligatoria del chofer al cobrar menos
      del total. Ninguna de las dos estaba implementada antes de este fix.

---

# v435 — Aviso de cobro parcial en modal de entrega (admin) + confirmación explícita al chofer

## Contexto
Después del fix anterior, la diferencia de cobro solo se veía en "Rutas del
día" e "Historial" (a nivel ruta). Faltaba en el lugar donde el admin
investiga una entrega puntual, y el chofer podía cobrar de menos sin ningún
aviso al momento de confirmar.

## Fix

### Admin — modal de detalle de entrega (`frontend/admin/js/rutas.js`)
- `actualizarSeguimiento()` ahora trae también `monto_cobrado` y
  `medio_cobro` de `entregas` (antes solo pedía `pedidos(total)`).
- `abrirModalEntrega()` agrega una línea "Cobrado: $X (medio)" y, si hay
  diferencia (> $0,50) contra el total del pedido, una segunda línea en rojo:
  "⚠ Faltan $X respecto al total del pedido".

### Chofer — confirmación antes de cerrar la entrega (`frontend/chofer/remito.html`)
- En el handler de "Confirmar entrega", si el chofer cargó un cobro y el
  monto es menor al total del pedido (diferencia > $0,50), se le muestra un
  `confirm()` explícito: *"Vas a cobrar $X, pero el total del pedido es $Y
  (faltan $Z). ¿Confirmás que entregaste igual con ese cobro?"*.
- Si cancela, no se envía el PATCH y puede corregir el monto. Si confirma,
  sigue el flujo normal (firma, foto, PATCH `entregar`) sin cambios.
- No se tocó el backend: sigue siendo válido cobrar menos del total, esto
  solo agrega una confirmación explícita en el cliente para que sea una
  decisión consciente y no un descuido.

---

# v436 — Cobro parcial sumado al panel de Alertas automáticas

## Contexto
El aviso de cobro parcial solo era visible entrando a Repartos (Historial o
el modal de entrega). El dueño pidió que apareciera junto con las otras
alertas proactivas del dashboard (diferencia de caja, factura de proveedor
con diferencias vs. OC, etc.), en vez de tener que ir a buscarlo.

## Fix

### Backend — nueva sección 8 en `handleAlertas` (`lib/handlers/admin.js`)
- Busca entregas `estado='entregado'` con `monto_cobrado` registrado y una
  diferencia > $1 contra `pedidos.total`, en los últimos 30 días.
- Mismo mecanismo de "hecho histórico permanente" que ya usa la diferencia
  de caja: se excluyen las que ya fueron marcadas como resueltas en
  `anomalias_revisadas` (`tipo_anomalia='entrega_cobro_parcial'`), para que
  no queden pegadas en el panel para siempre.
- Cada alerta trae un `link` a `/admin/rutas.html?entrega_dif=<id>&ruta_id=<id>&fecha=<fecha>`
  para poder saltar directo al detalle.

### Frontend — ícono y color (`frontend/admin/js/dashboard-optimizado.js`)
- Nuevo tipo `entrega_cobro_parcial` en los mapas de `renderListaAlertas` e
  `iconoAlerta` (mismo ícono de camión que "Choferes en la calle").

### Frontend — deep-link + resolución (`frontend/admin/js/rutas.js`)
- Al entrar a `rutas.html` con los parámetros `entrega_dif`/`ruta_id`/`fecha`,
  la página cambia automáticamente a la fecha correcta, abre la pestaña
  "Seguimiento en vivo", selecciona la ruta y abre el modal de la entrega en
  cuestión — sin que el dueño tenga que buscarla a mano (mismo patrón que ya
  usa `cajas.html` con `turno_dif`).
- El modal de detalle de entrega ahora tiene un botón "Marcar como
  resuelto" cuando hay diferencia, que llama a
  `POST /api/auditoria?accion=resolver` (endpoint genérico ya existente,
  reutilizado tal cual usa `cajas.html` para `diferencia_caja`). Una vez
  resuelta, la alerta deja de aparecer en el panel del dashboard.

## Nota
No se agregó ninguna acción automática (nota de crédito, ajuste de cta_cte,
etc.) — "Marcar como resuelto" solo saca la alerta de la lista, no modifica
ningún monto. Esa decisión de negocio sigue pendiente (ver v434).

