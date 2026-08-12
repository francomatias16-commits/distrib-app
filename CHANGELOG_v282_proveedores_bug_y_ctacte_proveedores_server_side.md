# v282 — Fix bug Portal de Proveedores + Cc-proveedores server-side (continuación AUDITORIA_FILTROS_v280)

## Contexto
Cierra el ítem "Proveedores / Cc-proveedores" que quedaba pendiente del
plan de la auditoría (§5, mediano plazo). Al revisar `proveedores.js`
para este trabajo se encontró que la migración a búsqueda/paginación
server-side (`.range()` + `count:'exact'`, debounce 250ms) **ya estaba
aplicada** en el zip de partida — tanto en el frontend como en
`lib/handlers/proveedores.js` — y ya tenía su índice de apoyo
(`265_idx_proveedores_busqueda_trgm.sql`). No hizo falta tocar ese patrón.

Lo que sí apareció, leyendo el módulo completo (no solo el patrón de la
auditoría): un bug funcional nuevo, no reportado antes.

## Bug — Portal de proveedores: `abrirPortal()` rompía con ReferenceError

**Archivo:** `frontend/admin/js/proveedores.js`, función `abrirPortal()`.

Al generar el link de autogestión del proveedor, el template del modal
usaba `${razonSocial}` — una variable que nunca se declara en esa función
(solo existe `prov`, de donde sale `prov.razon_social`). Como el template
literal se evalúa al construir el string, esto tira `ReferenceError:
razonSocial is not defined` **después** de que el fetch ya generó el link
en el servidor, dejando el modal trabado en "Generando link..." sin
mostrar nunca el link, el botón de copiar ni el de WhatsApp — silencioso,
sin mensaje de error visible para el usuario.

**✅ Aplicado.** `${razonSocial}` → `${sanitize(prov?.razon_social || '')}`
(mismo criterio de sanitización que el resto de la función).

## Cc-proveedores — mismo patrón de la auditoría (`.limit(500)` + filtro en JS)

**Archivos:** `lib/handlers/cc_proveedores.js` (`accion=facturas`),
`frontend/admin/js/cc-proveedores.js`, `frontend/admin/cc-proveedores.html`.

Antes: el backend traía hasta 500 facturas de proveedor sin filtro de
fecha server-side, y `aplicarFiltros()` filtraba proveedor/estado/fecha
en el navegador con `Array.filter()` sobre ese recorte fijo — igual al
patrón ya identificado en Cheques/Riesgo de cheques/Facturación. Volumen
actual bajo (155 facturas, 25 proveedores en el tenant demo — confirmado
contra `jgiquzjwoedmzwqgzubr`), así que no era urgente por síntoma, pero
sí por consistencia con el resto del trabajo ya hecho.

**✅ Aplicado:**
- `lib/handlers/cc_proveedores.js`, `accion=facturas`: ahora acepta
  `proveedor_id`, `estado`, `desde`/`hasta` (nuevo — antes el rango de
  fecha no existía como filtro server-side) y `page`/`limit`, resueltos
  con `.gte/.lte(fecha_factura)` + `.range()` + `count:'exact'` en vez del
  `.limit(500)` fijo. Se agregó un lookup puntual por `?id=` sin paginar
  (usado para abrir un link directo a una factura, ver más abajo).
- `frontend/admin/js/cc-proveedores.js`: `cargarFacturas()` manda los 4
  filtros + `page`/`limit` al backend; `aplicarFiltros()` ya no filtra en
  memoria, resetea a página 1 y recarga server-side. Paginación real
  agregada (`paginaActualFacturas`, `ITEMS_POR_PAGINA_FACTURAS` = 50,
  `totalFacturasFiltradas`), controles inyectados dinámicamente
  (`inyectarControlesPaginacionFacturas` / `cambiarPaginaFacturas`), mismo
  componente visual que Proveedores/Cta-cte/Cobranzas
  (`.paginacion-container` / `.btn-pag` de `shared/pagination.css`). No se
  agregó debounce porque esta pantalla no tiene input de texto — los 4
  filtros son selects/fechas con `onchange`, no `oninput`.
- Efecto colateral de paginar `facturas`: `window.facturasPorId` (usado
  por los `onclick` de la tabla) ahora solo contiene la página visible, no
  las ~500 de antes. La lectura de `?factura=uuid` en `init()` (abrir una
  factura puntual por link) dependía de que estuviera en el array
  completo cargado; se cambió para pedirla al backend por `?id=` si no
  está en la página actual, en vez de asumir que siempre lo está.
- `frontend/admin/cc-proveedores.html`: agregado
  `<link rel="stylesheet" href="/shared/pagination.css?v=1" />` (no
  estaba incluido; los controles nuevos lo necesitan).
- **Nueva migración `269_idx_facturas_proveedor_empresa_fecha.sql`**:
  índice `idx_fp_empresa_fecha (empresa_id, fecha_factura DESC)` — ya
  existía `idx_fp_empresa (empresa_id, created_at DESC)`, pero la query
  nueva ordena/filtra por `fecha_factura`, no por `created_at`.
  **Aplicada en vivo contra `jgiquzjwoedmzwqgzubr`** (verificado con
  `pg_indexes` antes y después).
- Cache-busters actualizados: `proveedores.js?v282`,
  `cc-proveedores.js?v282`.

## No tocado en esta tanda
- `accion=balance` de `cc_proveedores.js` sigue con `.limit(500)`: está
  acotado por cantidad de *proveedores* (25 hoy), no de facturas — mismo
  orden de magnitud que la tabla `proveedores`, que ya tiene su propio
  límite de paginación aguas arriba. Sin urgencia; si se quiere cerrar del
  todo el módulo se puede pedir en la próxima tanda.

## Puntos (`puntos.js`) — §4 y §6.3 de la auditoría original

**Archivos:** `supabase/migrations/270_rpc_puntos_kpis_y_lista_server_side.sql`
(nueva, aplicada en vivo), `frontend/admin/js/puntos.js`,
`frontend/admin/puntos.html`.

Este era el módulo con mayor volumen real pendiente del plan: traía
**todos** los clientes con saldo de puntos (vista `v_puntos_clientes`, sin
`.limit`/`.range`) y filtraba por nombre/email con `Array.filter()` en
cada tecla, sin debounce — confirmado en vivo contra
`jgiquzjwoedmzwqgzubr`: 2.500 clientes en `saldo_puntos`, de los cuales
791 tienen saldo > 0. Los 3 KPIs de las tarjetas también se sumaban en JS
sobre ese array completo.

**✅ Aplicado:**
- Migración nueva `270_rpc_puntos_kpis_y_lista_server_side.sql`, mismo
  patrón que `266`/`268` (`fn_cta_cte_kpis`/`lista`,
  `fn_cobranzas_kpis`/`facturas`):
  - `fn_puntos_kpis()` — los 3 totales de las tarjetas en una sola fila.
  - `fn_puntos_lista(p_busqueda, p_limit, p_offset)` — página filtrada por
    nombre/email con `LIMIT`/`OFFSET` real y `total_count` vía
    `COUNT(*) OVER()`.
  - Aplicada en vivo y **probada de punta a punta** contra
    `jgiquzjwoedmzwqgzubr` simulando el JWT de un usuario real
    (`set_config('request.jwt.claims', ...)`): `fn_puntos_kpis()` devolvió
    839.508 puntos totales / 791 clientes con saldo / 88.700 canjeados;
    `fn_puntos_lista()` paginó y buscó correctamente (`total_count: 2500`).
  - **Bug propio detectado y corregido antes de aplicar**: el primer
    borrador declaraba `saldo`/`total_ganado`/`total_canjeado` como
    `integer` y `updated_at` como `timestamptz`, pero
    `saldo_puntos.puntos_disponibles/puntos_totales/puntos_canjeados` son
    `numeric` y `ultimo_movimiento` es `timestamp` sin zona horaria
    (confirmado con `information_schema.columns`) — se corrigieron los
    tipos de retorno antes de que llegara a producción.
  - Mismo fix de grants que la `267`: `CREATE FUNCTION` había dejado
    `EXECUTE` abierto a `PUBLIC`/`anon` por defecto; se revocó
    explícitamente, verificado con `pg_proc.proacl` antes y después.
- `frontend/admin/js/puntos.js`: `cargarClientes()` reescrita para llamar
  `fn_puntos_lista()` en vez de `v_puntos_clientes` sin paginar +
  `Array.filter()`. Buscador con debounce (250ms, mismo criterio que el
  resto de los módulos ya migrados) — cierra el pendiente de §6.3. KPIs
  ahora vienen de `fn_puntos_kpis()` (`cargarKPIs()`, independiente de la
  página/búsqueda actual). Paginación real agregada (`paginaActualPuntos`,
  `ITEMS_POR_PAGINA_PUNTOS` = 50, `totalClientesFiltrados`), mismo
  componente visual que el resto (`inyectarControlesPaginacionPuntos` /
  `cambiarPaginaPuntos`).
- Se mantiene `cargarClientesFallback()` por si la RPC no estuviera
  disponible en algún tenant (migración 270 no corrida todavía) — mismo
  criterio de fallback automático que `cta-cte.js`/`cobranzas.js`. De paso
  se corrigió un bug latente en ese fallback: llamaba `.ok`/`.json()`
  sobre el resultado de `supabase-js` (que devuelve `{data, error}`, no un
  `Response` de `fetch`), así que nunca había funcionado realmente si
  alguna vez se activaba.
- `frontend/admin/puntos.html`: agregado
  `<link rel="stylesheet" href="/shared/pagination.css?v=1" />` (no
  estaba incluido). Cache-buster de `puntos.js` actualizado a `?v282`.

## Estado del plan de la auditoría tras esta tanda
Del listado de §5 (mediano plazo), quedan: **Devoluciones, Reglas de
precio, Rutas, Conciliación bancaria**. Todas con 0 filas hoy en
`jgiquzjwoedmzwqgzubr` (confirmado contra la base real) — a diferencia de
Puntos, que ya tenía volumen real y por eso se priorizó en esta tanda. De
§6.4, Rutas sigue sin urgencia (filtra sobre un subconjunto ya chico
server-side). §6.3 queda cerrado: Puntos ya tiene debounce.

---

## Devoluciones — cierre §5

**Archivos:** `lib/handlers/pedidos.js` (`handleDevolucionesAdmin`),
`frontend/admin/js/devoluciones.js`, `frontend/admin/devoluciones.html`.

Antes: `accion=listar` traía hasta 200 devoluciones con `.limit(200)` fijo;
el backend soportaba filtro por `estado` pero el frontend nunca lo
mandaba — los 3 filtros (buscador por cliente, estado, motivo) se
resolvían con `Array.filter()` en el navegador sobre ese recorte, sin
debounce en el buscador. Los 3 KPIs de las tarjetas también se sumaban en
JS sobre el array completo cargado. Volumen actual: 0 filas — se corrige
por consistencia, mismo criterio que el resto de los módulos ya migrados.

**✅ Aplicado:**
- `handleDevolucionesAdmin`: `accion=listar` ahora resuelve los 3 filtros
  server-side (`estado`, `motivo` con `.eq()`, búsqueda por nombre de
  cliente con `.or()` sobre la tabla embebida `clientes!inner`) +
  `page`/`limit` con `.range()` + `count:'exact'` en vez de `.limit(200)`
  fijo. Nueva acción `accion=kpis`: 3 conteos (`head:true`, sin traer
  filas) por estado, independientes del filtro/página actual — mismo
  criterio que `fn_puntos_kpis`/`fn_cta_cte_kpis` pero sin necesidad de
  RPC nueva (este handler ya corre con service role + `empresa_id` propio,
  no depende de `get_empresa_id()`/JWT como los RPC llamados directo desde
  el frontend).
- `frontend/admin/js/devoluciones.js`: `cargarDevoluciones()` manda los 3
  filtros + `page`/`limit` al backend; `filtrarDevoluciones()` ya no
  filtra en memoria — debounce 250ms (mismo criterio que el resto) y
  recarga server-side. `cargarKPIs()` nuevo, independiente de la
  página/búsqueda. Paginación real agregada (`paginaActualDevoluciones`,
  `ITEMS_POR_PAGINA_DEVOLUCIONES` = 50), mismo componente visual
  (`inyectarControlesPaginacionDevoluciones` / `cambiarPaginaDevoluciones`).
  `revisarDevolucion()` refresca KPIs desde el servidor tras aprobar/
  rechazar en vez de recalcular en memoria.
- `frontend/admin/devoluciones.html`: agregado `pagination.css`.
  Cache-buster de `devoluciones.js` actualizado a `?v282`.

## Reglas de precio — revisado, sin cambios

Ya estaba bien resuelto: `reglas_precio` es una tabla de configuración
chica (0-cientos de filas por tenant, cargada a mano), con `.limit(2000)`
explícito como tope de seguridad en `listarReglasPrecio()` y el buscador
del frontend filtra 100% en memoria sobre ese conjunto ya acotado — sin
llamada de red por tecla, por lo que no necesita debounce. La decisión ya
estaba documentada en los propios comentarios del repo. No se aplicó
ningún cambio.

## Rutas — revisado, sin cambios

`cargarPedidosDespachables()` filtra server-side por
`estado IN ('confirmado','preparando')` — un subconjunto acotado por el
propio estado operativo (pedidos activos sin despachar), no un historial
sin cota — y el buscador de pendientes filtra en memoria sobre ese
conjunto chico, sin red por tecla. El historial de rutas y los reportes
ya tenían `.limit(60)`/`.limit(100)` explícitos. Sin cambios.

## Conciliación bancaria — cierre §5

**Archivo:** `lib/repos/conciliacion-bancaria.js`.

`listarMovimientos()` (movimientos de un lote/extracto importado) y
`listarLotes()` no tenían ningún límite —ni siquiera un tope de seguridad
fijo—, mismo hallazgo que tenía `reglas_precio` antes de su fix. No hay
buscador de texto en esta pantalla (solo filtro por `estado`, ya
soportado server-side), así que no aplica debounce acá.

**✅ Aplicado:**
- `listarMovimientos()`: agregado `.limit(2000)` explícito. Un lote es un
  extracto bancario importado de una sola vez (CSV), no una tabla que
  crece por evento — no hace falta paginación de UI, pero sí una cota
  explícita en vez de ninguna.
- `listarLotes()`: agregado `.limit(500)` explícito, mismo criterio.
- **Documentado y no resuelto a propósito**: por cada movimiento
  pendiente del lote se dispara una llamada RPC individual a
  `conciliacion_buscar_candidatos` (patrón N+1). Con el tope de arriba
  queda acotado a como mucho unos cientos de llamadas paralelas por carga
  de pantalla — no es el mismo riesgo que una tabla sin cota. Resolverlo
  del todo requeriría una RPC que reciba una lista de `movimiento_id`s y
  devuelva los candidatos de todos en una sola consulta, lo cual implica
  tocar el motor de matching en SQL (`conciliacion_buscar_candidatos`,
  migración 248) — fuera del alcance de este fix, no se tocó a ciegas sin
  visibilidad de cómo se usa el scoring en producción. Volumen actual: 0
  filas en `jgiquzjwoedmzwqgzubr`.

## Plan de la auditoría — cerrado
Con esta tanda se completó el listado de §5 (mediano plazo):
Proveedores/Cc-proveedores, Puntos, Devoluciones, Reglas de precio, Rutas
y Conciliación bancaria — los tres últimos, tras revisión, no requerían
cambios de fondo (ya estaban bien acotados o el filtrado en memoria era
sobre un conjunto ya chico, sin llamada de red de por medio).
