# v747 — Reportes financieros y de ventas ahora incluyen ventas de mostrador (POS)

## Problema

`reportes-financieros.html` y `reportes-ventas.html` consultaban únicamente la
tabla `pedidos` (web/WhatsApp/reparto). La tabla `ventas_pos` (mostrador
físico) nunca se leía en ninguno de los dos archivos, a pesar de que el
dashboard ejecutivo (`obtenerVentasPosPeriodo` en `lib/repos/admin.js`) sí la
suma. Resultado: ingresos, costos, márgenes, flujo de caja y todos los
rankings de estos reportes subestimaban el negocio real en cualquier empresa
que factura por mostrador.

## Cambios — `frontend/admin/js/reportes-financieros.js`

Se agregó una consulta a `ventas_pos` (filtro `estado = 'completada'`, mismo
criterio que el dashboard) en cada función, sumada a los datos de `pedidos`:

- `cargarKPIsFinancieros`: ingresos y costos del período actual y del
  anterior. Costos calculados con `venta_pos_items.cantidad × productos.costo`,
  igual que se hace con `pedido_items`.
- `cargarFlujoCaja`: el total diario de ventas POS se suma al de pedidos
  entregados, agrupado por `created_at`.
- `cargarIngresosVsCostos`: ingresos y costos diarios combinados.
- `cargarEvolucionMargen`: ingresos y costos mensuales combinados (vista
  anual).

Sin cambios en `cargarKPIsCobranza`, `cargarDeudaPorCliente` ni
`cargarResumenCobranzas` — esas secciones ya convergen en `facturas`/`cta_cte`
independientemente del canal de origen (pedido o venta POS), según lo
confirmado en la auditoría previa.

## Cambios — `frontend/admin/js/reportes-ventas.js`

- `cargarKPIs`: Total de Ventas, Cantidad, Ticket Promedio y Clientes Activos
  (actual y período anterior) suman `ventas_pos`.
- `cargarVentasDiarias`: gráfico diario combinado.
- `cargarVentasCategorias`: categorías de producto combinadas.
- `cargarRankingProductos`: ranking de productos combinado.
- `cargarRankingClientes`: incluye ventas POS con `cliente_id` no nulo. Las
  ventas de mostrador anónimas (sin cliente cargado) quedan fuera del
  ranking porque no hay a quién atribuirlas — mismo criterio con el que ya
  se filtraban ventas sin cliente en `pedidos`. Respeta el filtro de zona
  (vía `clientes.zona_id`) igual que ya hacía con pedidos.
- `cargarRankingVendedores` y `cargarVentasPorZona`: **sin cambios,
  deliberadamente**. `ventas_pos` no tiene un concepto de "vendedor" (ruta de
  reparto) ni de zona de entrega — es venta de mostrador. Combinar ahí sería
  forzar datos que no existen.

**Regla aplicada en ambos archivos:** cuando hay un filtro de vendedor
activo (`estadoReportesVentas.vendedorSeleccionado`), las consultas a
`ventas_pos` se omiten — el filtro no tiene sentido para venta de mostrador,
así que incluirla ahí volvería a mezclar cosas que no corresponden.

## Sin tocar

- El fix de paginación de v746 (`pos.js`/`pos.html`/`pos.css`) queda igual.
- Ningún cambio de schema ni migración — solo lectura adicional de
  `ventas_pos`/`venta_pos_items`, misma tabla y columnas que ya usa el
  dashboard y el propio panel de POS.

## Verificado

- `node --check` OK en ambos archivos.
- No se probó end-to-end contra datos reales (sin credenciales de Supabase
  en este entorno) — recomendado revisar los reportes en un tenant con
  ventas de mostrador cargadas antes de dar por cerrado.
