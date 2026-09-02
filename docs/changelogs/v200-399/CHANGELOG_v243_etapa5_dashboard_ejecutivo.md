# v243 — Etapa 5: Dashboard ejecutivo consolidado + comparativa mensual + export

## Contexto
Primera entrega de la Etapa 5 del plan por etapas ("BI/Reportes"). Cubre los
2 puntos de esa etapa: dashboard ejecutivo consolidado (ventas + cobranza +
stock + rentabilidad en una vista, export Excel/PDF) y comparativas
automáticas. Se decidió **mensual** (no interanual) porque el historial de
datos de este tenant recién empieza en 2026-02 — no hay con qué comparar
año contra año todavía. La función queda preparada para sumar el modo
interanual el día que haya más de 12 meses de historia, sin romper nada.

Se construyó ampliando `dashboard.html` (no una página nueva, no se
promovió `dashboard-v2.html`) — decisión tomada junto con el dueño del
proyecto.

## Qué se agregó

### Backend (Supabase)
- **Migración `243_etapa5_dashboard_ejecutivo_comparativa_mensual.sql`**:
  - `obtener_dashboard_ejecutivo_resumen(empresa_id, desde, hasta)` — agrega
    en una sola llamada lo que antes vivía repartido: reutiliza
    `v_cobranza_priorizada` (Etapa 3) y `v_rentabilidad_zona_ruta` (Etapa 1),
    y suma el mismo criterio de stock crítico que ya usa
    `obtener_kpis_dashboard_v3`. No reemplaza ninguna vista existente.
  - `obtener_comparativa_mensual(empresa_id, fecha_ref)` — serie diaria del
    mes en curso (día 1 al día de hoy) vs. el mismo tramo del mes anterior,
    con nombres de mes en español (no depende del locale del servidor).
  - Ambas probadas contra datos reales de producción antes de entregarse.

### Backend (API)
- `lib/handlers/admin.js`: 2 endpoints nuevos, mismo patrón que los
  existentes (rol admin/dueño/vendedor/contador, solo lectura):
  - `GET /api/admin/dashboard-ejecutivo?periodo=30d`
  - `GET /api/admin/comparativa-mensual`
- `vercel.json`: rewrites de esas 2 rutas, agregadas antes del catch-all
  `/api/admin/(.*)` existente.

### Frontend
- `dashboard.html`: nueva sección "Panel ejecutivo" (cobranza + rentabilidad
  por zona + comparativa mensual con gráfico SVG a mano, mismo criterio sin
  librerías que ya usa el gráfico de ventas del panel). El stock crítico
  no se duplica visualmente — ya tiene su tarjeta propia arriba — pero sí
  se incluye en el export consolidado.
- `frontend/admin/js/dashboard-ejecutivo.js` (nuevo, ~380 líneas): carga los
  2 endpoints nuevos, renderiza cobranza/rentabilidad/comparativa, y maneja
  el export. Es un módulo aparte y aditivo — no toca `dashboard-optimizado.js`,
  se engancha a los mismos controles (`#select-periodo`, `#btn-refrescar`)
  con sus propios listeners.
- `frontend/admin/css/dashboard-fireart.css`: estilos del panel ejecutivo
  agregados al final del archivo (bump `?v=2` en `dashboard.html`).

### Export Excel/PDF (nuevo — antes solo existía CSV vía `export-utils.js`)
- **Excel real (.xlsx)** vía SheetJS, 5 hojas: Resumen, Cobranza,
  Rentabilidad, Stock crítico, Comparativa mensual (serie diaria completa).
- **PDF** vía jsPDF + jspdf-autotable: KPIs + tabla de cobranza urgente +
  tabla de rentabilidad por zona.
- Ambas librerías se cargan por CDN recién al primer click del botón
  correspondiente (no penalizan la carga inicial del panel).

## Pendiente / próximos pasos sugeridos
1. QA visual en mobile del `pe-grid` (ya tiene breakpoint a 1 columna en
   ≤860px, pero no se probó en dispositivo real).
2. Si en algún momento se decide promover `dashboard-v2.html` a producción,
   portar esta sección ahí también (hoy solo vive en `dashboard.html`).
3. Cuando haya >12 meses de historia: agregar modo `interanual` a
   `obtener_comparativa_mensual` (o una función hermana) reusando la misma
   estructura de respuesta.

## Cómo aplicar
1. Correr la migración `243_etapa5_dashboard_ejecutivo_comparativa_mensual.sql`
   (ya aplicada en producción durante esta sesión — este archivo la deja
   versionada en el repo, correrla de nuevo es un no-op).
2. Deployar `lib/handlers/admin.js`, `vercel.json`, `dashboard.html`,
   `dashboard-ejecutivo.js` y `dashboard-fireart.css`.
