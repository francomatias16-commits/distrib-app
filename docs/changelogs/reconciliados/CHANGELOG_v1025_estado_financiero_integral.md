# CHANGELOG v1025 — Estado Financiero Integral (una sola pantalla)

## Contexto
Pedido de Ruben: una sola pantalla donde se vea TODO — ventas de POS,
WhatsApp, tienda/web, vendedores y demás canales; ingresos por otros medios;
egresos; y el resultado (diario/mensual/anual) + patrimonio neto.

Hoy esto vivía fragmentado en 3 pantallas que no se hablaban entre sí:
- `reportes-financieros.html`: calculaba ingresos/costos/margen 100% en el
  navegador (traía `pedidos`+`ventas_pos` completos con items y armaba todo
  en JS — no escalaba y no reutilizaba nada del backend).
- dashboard-ejecutivo (`admin.js` + `obtener_ventas_por_canal`, mig. 478):
  ya desglosaba ventas por canal pero solo como mini-resumen de "Hoy en tu
  negocio".
- `obtener_resumen_gastos_generales` (mig. 479) y
  `obtener_resumen_compras_proveedor` (mig. 478): cubrían egresos por
  separado, sin combinar con ingresos ni con un total de resultado.

Esta migración no reemplaza esas funciones — las reutiliza como fuente de
verdad para no duplicar criterios (mismos estados de pedido/POS/factura ya
validados por Ruben en producción) — y agrega una RPC nueva que consolida
todo en una sola respuesta.

**Nota de reconciliación:** el plan original de esta sesión reservaba el
número de migración 560, pero al aplicar quedó libre el 564 — el 560 ya
había sido tomado por `560_fix_captura_matchear_producto_gap.sql` en otra
sesión paralela. Se renumeró el archivo y todas sus referencias (handler,
repo, HTML, JS, CSS) de 560 → 564 antes de aplicar.

## Backend
- `supabase/migrations/564_estado_financiero_integral.sql` (nuevo): función
  `obtener_estado_financiero_integral(p_empresa_id, p_desde, p_hasta,
  p_agrupacion)` que trae:
  1. Ingresos por canal (pos/whatsapp/vendedor/web/portal_cliente/etc.).
  2. Egresos por categoría: `gastos_generales` + pagos a proveedores
     (egreso de caja real) + compras a proveedores facturadas (aparte, para
     contexto).
  3. Serie de resultado (ingreso - egreso) agrupada por día, mes o año
     según `p_agrupacion`.
  4. Patrimonio neto aproximado a `p_hasta`: activo (caja de turnos POS +
     cuentas por cobrar + stock valorizado a costo promedio) menos pasivo
     (deuda pendiente a proveedores). Foto gerencial, no balance contable de
     partida doble.
  - Sigue la convención de 478/479: si alguna tabla no está disponible en
    una empresa vieja, degrada a 0/null sin romper el resto de la respuesta.
  - `SECURITY` por defecto (invoker), `REVOKE ALL FROM PUBLIC` + `GRANT
    EXECUTE TO service_role`, mismo patrón que el resto de RPCs de admin.
  - Probada end-to-end contra una empresa real tras aplicar: devuelve serie
    mensual, ingresos por canal, egresos por categoría y patrimonio neto
    coherentes.
- `lib/repos/admin.js`: agregado `obtenerEstadoFinancieroIntegralRpc(params)`
  — wrapper delgado sobre `db.rpc('obtener_estado_financiero_integral', ...)`,
  mismo patrón que `obtenerResumenGastosGeneralesRpc` y compañía.
- `lib/handlers/admin.js`: nuevo `handleEstadoFinanciero(req, res,
  empresa_id)`, ruteado por `_svc=estado-financiero`. Valida `agrupacion`
  contra `{'dia','mes','anio'}` (default `'mes'`) y aplica un rango de
  fechas por defecto cuando el usuario no eligió (`desde`/`hasta` ausentes):
  30 días en vista Día, 12 meses en vista Mes, 5 años en vista Año — mismo
  criterio documentado en el JS del frontend. Try/catch con `errorSeguro`,
  igual que `handleComparativaMensual`.
- `vercel.json`: ruteo de `/api/admin/estado-financiero` →
  `/api/index?_mod=admin&_svc=estado-financiero`, y de página
  `/admin/estado-financiero` → `/frontend/admin/estado-financiero.html`.

## Frontend
- `frontend/admin/estado-financiero.html` (nuevo): filtros (vista
  Día/Mes/Año + rango de fechas), KPIs de resultado del período (ingresos,
  egresos, resultado neto), KPIs de patrimonio neto (activo, pasivo,
  patrimonio neto) con detalle expandible, gráfico de evolución (ECharts),
  tabla de ingresos por canal, tabla de egresos por categoría y tabla de
  detalle por período. Roles permitidos: `dueno`, `admin`, `contador`
  (mismo criterio que el resto de reportes financieros). Carga
  `api-client.js` (hasta ahora solo la cargaba `dashboard.html`).
- `frontend/admin/js/estado-financiero.js` (nuevo): consume la única RPC,
  arma KPIs, barras proporcionales, gráfico de evolución y las tres tablas.
- `frontend/admin/css/estado-financiero-gentelella.css` (nuevo): estilos
  específicos de la página (manifiesto de KPIs, barras, detalle de
  patrimonio).
- `frontend/admin/js/nav-data.js`: agregada la entrada de menú "Estado
  financiero integral" en la sección Reportes, junto a "Finanzas".

## Validación
- Sintaxis: `node --check` OK en `lib/handlers/admin.js`,
  `lib/repos/admin.js`, `frontend/admin/js/estado-financiero.js` y
  `frontend/admin/js/nav-data.js`; `vercel.json` parseado como JSON válido.
- Columnas/tablas referenciadas por la RPC (`pedidos`, `ventas_pos`,
  `gastos_generales`, `pagos_proveedor`, `facturas_proveedor`,
  `turnos_caja`, `cajas_pos`, `facturas`, `stock`, `depositos`) verificadas
  contra `information_schema` antes de aplicar.
- Migración 564 aplicada en Supabase (proyecto `jgiquzjwoedmzwqgzubr`) y
  probada con una empresa real: respuesta coherente en serie mensual,
  ingresos por canal, egresos por categoría y patrimonio neto.
- `get_advisors` (security): sin alertas nuevas asociadas a la función.

## Pendiente / no cubierto en esta sesión
- `reportes-financieros.html` sigue existiendo con su cálculo 100%
  client-side; no se migró ni se dio de baja — quedan ambas pantallas
  convivendo por ahora.
- No se agregó un test automatizado para la RPC (no hay carpeta de tests de
  SQL en este proyecto todavía); la validación fue manual vía
  `execute_sql` contra datos reales.
