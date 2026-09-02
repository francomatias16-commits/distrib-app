# v214 — Optimización de Reportes de Stock

## Problema reportado
En "Reportes de Stock" (`/admin/reportes-stock`) la tabla "Estado de Stock por Producto"
mostraba absolutamente todo el stock de la empresa en un único `innerHTML`, sin paginar
(2000 filas hoy, creciendo con cada producto/depósito nuevo). Esto generaba un scroll
interminable y tildaba el navegador, porque además:

- La tabla cruzaba cada fila de `stock` contra un array de `productos` completo con
  `.find()` (costo O(n×m): 2000 × 1000 búsquedas lineales).
- Los KPIs (`cargarKPIs`) y el gráfico de torta (`cargarDistribucionStock`) traían
  **toda** la tabla `stock` y **todos** los `productos` solo para sumarlos/agruparlos
  en JavaScript — y `cargarKPIs` lo hacía dos veces (actual + "anterior").
- El filtro "Estado" del HTML (`filtroEstado`) nunca se aplicaba en ningún lado: quedaba
  como código muerto en la UI.

## Solución

### Backend (Supabase — migración `rpc_reportes_stock_agregados`)
Dos funciones nuevas que agregan en SQL en vez de transferir filas crudas:
- `fn_reportes_stock_kpis(p_deposito_id, p_categoria_id)`: valor total, productos en
  stock, productos críticos y rotación promedio, todo calculado con `SUM`/`COUNT` en
  una sola pasada por la base.
- `fn_reportes_stock_distribucion(p_deposito_id)`: valorización agrupada por categoría
  para el gráfico de torta.

Ambas usan `SECURITY DEFINER` + `get_empresa_id()` para mantener el scope por empresa,
en línea con el resto de RPCs del proyecto.

### Frontend (`reportes-stock.js` / `reportes-stock.html`)
- **Tabla de Estado de Stock**: ahora pagina de a 50 filas (configurable a 25/100/200)
  usando `.range()` de Supabase, con `count: 'exact'` para saber el total. Se agregaron
  controles "Anterior / Siguiente" y el texto "Mostrando X-Y de Z productos".
- **Join embebido**: la query trae `productos(nombre, categoria_id, categorias(nombre))`
  en el mismo `select`, eliminando los `.find()` en arrays completos.
- **Filtro de categoría**: ahora se aplica en la query (`productos!inner` + `.eq()`),
  no después de traer todo a JS.
- **Filtro de estado**: ahora sí funciona (antes era un `<select>` sin efecto). Traduce
  Crítico/Bajo/Normal/Exceso a rangos de `cantidad` en la query.
- **KPIs y gráfico de distribución**: reemplazados por llamadas a los RPCs nuevos.

## Impacto esperado
- La tabla principal pasa de renderizar ~2000 filas (y creciendo) a 50 por vez.
- Los KPIs pasan de transferir ~3000+1000 filas a 1 fila calculada en el servidor.
- El gráfico de torta pasa de transferir ~2000+1000+categorías a N filas (una por
  categoría).
- El comportamiento escala con el crecimiento de catálogo/depósitos de cada cliente,
  en vez de degradarse linealmente con el tamaño de la base.

## Pendiente (fuera de este alcance, para una próxima pasada si crece el volumen)
- `cargarValorizacion` y `cargarProductosCriticos` siguen trayendo la tabla `stock`
  completa (aceptable hoy porque son agregaciones simples sobre pocos depósitos, pero
  candidatas a los mismos RPCs si el catálogo crece mucho más).
