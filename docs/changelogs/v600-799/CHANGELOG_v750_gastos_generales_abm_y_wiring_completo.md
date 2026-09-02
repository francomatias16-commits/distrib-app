# CHANGELOG v750 — Gastos Generales: ABM completo + wiring de Ganancia Neta

## Contexto
Continuación de la sesión anterior (v749). La migración 479 (tabla
`gastos_generales` + RPC `obtener_resumen_gastos_generales`) ya estaba
aplicada en producción, y el wiring de KPIs en `reportes-financieros.js`,
`admin.js` (dashboard-ejecutivo/kpis) y el HTML/JS de la tab "Gastos" en
`dashboard.html` ya estaban hechos, pero faltaba:

1. El ABM propiamente dicho (página + JS) para cargar/editar/eliminar gastos.
2. La ruta API (`/api/gastos-generales`) y el handler/repo que la sirven.
3. Permisos, nav, y `cargarGastosTab()` en dashboard.html (estaba referenciada
   pero no definida).

## Backend
- `lib/repos/gastos-generales.js` (nuevo): CRUD completo — listar, obtener,
  resumen (RPC 479), crear, actualizar, eliminar (soft-delete vía `activo`).
- `lib/handlers/gastos-generales.js` (nuevo): GET lista/detalle/`_svc=resumen`,
  POST, PATCH, DELETE. Auditoría vía `AuditRepo.registrarAuditoriaSilenciosa`,
  mismo patrón que `maestros.js`.
- `lib/repos/admin.js`: agregada `obtenerResumenGastosGeneralesRpc()`.
- `lib/permisos-service.js`: recurso `gastos_generales` (leer/escribir:
  dueño, admin, contador).
- `api/index.js` y `vercel.json`: ruteo de `/api/gastos-generales` y
  `/admin/gastos-generales`.
- `supabase/migrations/479_gastos_generales.sql`: documentación fiel de la
  migración ya aplicada en producción (tabla + RPC), para sincronizar el repo.

## Frontend
- `frontend/admin/gastos-generales.html` (nuevo): página ABM — filtros
  (categoría/estado/búsqueda), tabla paginada client-side, modal alta/edición.
- `frontend/admin/js/gastos-generales.js` (nuevo): misma arquitectura que
  `reglas-precio.js` (CRUD contra la API, paginación "Cargar más", validación
  inline, soft-delete).
- `frontend/admin/css/gastos-generales-gentelella.css` (nuevo): reskin
  Gentelella v4, adaptado 1:1 desde `reglas-precio-gentelella.css`.
- `frontend/admin/js/nav-data.js`: entrada "Gastos generales" en Reportes,
  junto a Finanzas.
- `frontend/admin/dashboard.html`: implementada `cargarGastosTab()` — pinta
  el total del período, desglose por categoría y la "Ganancia estimada"
  (ventas − compras a proveedores − gastos generales) en la tab "Gastos" de
  Reportes críticos.
- `frontend/admin/js/reportes-financieros.js` / `.html`: KPI de Gastos
  Generales y Ganancia Neta (= Margen Bruto − Gastos Generales del período),
  incluidos en la exportación CSV/Excel.

## Verificación
- `node --check` OK en todos los archivos `.js` nuevos/editados.
- Script inline de `dashboard.html` extraído y verificado con `node --check`.
- IDs del nuevo HTML sin duplicados, tags balanceados.
