# v273 — Se revierte la promoción de Torre de Control, se borra dashboard-v2

## Motivo
Al revisar `/admin/dashboard` en vivo se detectó que Torre de Control
(dashboard-v2.html, promovida a panel principal en v270) tiene dos bugs
de fondo, no cosméticos:

1. **KPIs con contrato desalineado**: `dashboard-control-tower.js` esperaba de
   `/api/admin/kpis` los campos `ventas_hoy`, `rutas_activas`, `rutas_total`,
   `rutas_demora`, `pedidos_pendientes`, `pedidos_sugeridos`,
   `cajas_abiertas`, `efectivo_total`. El handler real (`handleKPIs` en
   `lib/handlers/admin.js`) sigue devolviendo el contrato viejo
   (`ventas_total`, `pedidos_total`, `clientes_activos`, `stock_critico`,
   etc.), pensado para el dashboard clásico. Resultado: las 4 tarjetas KPI
   mostraban "undefined" en vez de datos reales.
2. **Secciones enteras corriendo siempre en demo**: "Rutas en tiempo real" y
   "Stock crítico" llaman a `/api/admin/rutas-resumen` y
   `/api/admin/reportes-stock?criterio=fefo&limite=8`, que no existen como
   `_svc` en `lib/handlers/admin.js` (los que sí existen: `kpis`, `pedidos`,
   `stock-bajo`, `ventas-diarias`, `alertas`, `onboarding`,
   `dashboard-ejecutivo`, `comparativa-mensual`, `resumen-arranque`). El 404
   dispara el fallback y activa el badge "MODO DEMO" — con datos hardcodeados
   idénticos al mock del archivo, no datos reales de la empresa.

Torre de Control quedó, en los hechos, como un prototipo de frontend nunca
terminado de cablear al backend, pero sirviendo como panel principal real
desde v270.

## Decisión
Se descarta Torre de Control en vez de terminarla. Se borra:

- `frontend/admin/dashboard-v2.html`
- `frontend/admin/js/dashboard-control-tower.js`
- `frontend/admin/css/dashboard-control-tower.css`

## Cambios de reversión

- **vercel.json**: `/admin` y `/admin/dashboard` vuelven a apuntar a
  `frontend/admin/dashboard.html` (el dashboard clásico). Se eliminan las
  rutas `/admin/dashboard-legacy` y `/admin/dashboard-v2` (ya no hay destino).
- **dashboard.html**: se actualiza el comentario de cabecera — deja de estar
  marcado como legacy, vuelve a ser el panel principal sin aclaraciones.
- **sw-admin.js**: se saca `dashboard-control-tower.css` y
  `/admin/dashboard-legacy` de la lista de precache. Bump `admin-v147` →
  `admin-v148`.
- **ui-utils.js**: comentario actualizado (la referencia a
  `dashboard-control-tower.js` ya no aplica, el archivo no existe).

## Sin tocar
Ningún endpoint, RPC ni tabla — esto es 100% reversión de frontend/routing.
Los CHANGELOGs históricos (`CHANGELOG_dashboard_v2_torre_de_control.md`,
`CHANGELOG_v270_promocion_torre_de_control.md`, etc.) se dejan intactos
como registro de lo que se intentó.
