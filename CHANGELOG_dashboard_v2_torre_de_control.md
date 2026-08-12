# Nuevo Panel Principal — "Torre de Control" (v2, propuesta)

## Contexto
Rediseño del Panel Principal desarrollado en 4 fases (arquitectura de
información, interactividad/UX, UI kit, maquetado) a partir del prompt
maestro de diseño. Se entrega como página nueva, **no reemplaza**
todavía `dashboard.html` en producción — queda para revisión antes de
promoverla.

## Archivos nuevos
- `frontend/admin/dashboard-v2.html` — estructura de la página.
- `frontend/admin/css/dashboard-control-tower.css` — piel oscura
  "Torre de Control", scopeada a `body.dash-control-tower` (no afecta
  ninguna otra pantalla, mismo criterio de aislamiento que
  `dashboard-dark-bento.css`).
- `frontend/admin/js/dashboard-control-tower.js` — lógica de interfaz.

## Qué incluye
- KPI cards (Ventas del día, Rutas activas, Pedidos entrantes,
  Cajas/Efectivo) con drill-down in-place (una card expandida a la vez).
- Línea de ruta como divisor estructural (línea de tiempo del turno).
- Rutas en tiempo real (timeline por chofer) y Stock crítico FEFO con
  selección en lote (una tabla activa a la vez, con confirmación para
  acciones destructivas).
- Termómetro de riesgo de cheques/cta. cte. y widget de Asistente de
  Pedidos Pendientes (conectado conceptualmente a
  `contar_pedidos_pendientes`, migración 196).
- Canal realtime único por empresa
  (`dashboard-live-{empresaId}`) siguiendo el mismo patrón
  `channel().on('postgres_changes', …)` que ya usan `pedidos.js` y
  `rutas.js`, con agregación adaptativa de eventos (ventana 800ms),
  indicador de reconexión de canal, y toggle manual "Pausar en vivo".
- Contingencia POS offline: lee `PosOffline.getContadorPendientes()` y
  deduplica eventos de venta por `offline_local_id` contra el estado
  real persistido (`sincronizado` / `pendiente` / `error_permanente`),
  no contra un set en memoria de la pestaña.
- Respeta `prefers-reduced-motion` (desactiva pulsos y animaciones).

## Pendiente antes de promoverla a producción
1. Confirmar que los endpoints que consume
   (`/api/admin/kpis`, `/api/admin/rutas-resumen`,
   `/api/admin/reportes-stock`, `/api/riesgo-cheques`,
   `/api/piloto?accion=sugeridos`) existen con ese contrato — si no
   responden, la página cae a datos demo silenciosamente
   (`console.warn`) en vez de romperse, así que un mismatch de endpoint
   podría pasar desapercibido si no se revisa la consola.
2. Decidir si reemplaza a `dashboard.html` o convive como alternativa
   (ej. detrás de un flag por empresa).
3. QA de accesibilidad de teclado en el drill-down de KPIs (ya soporta
   Enter/Espacio, falta probar con lector de pantalla).
