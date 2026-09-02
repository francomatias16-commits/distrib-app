# Auditoría de filtros y búsquedas — distrib v280

> **Actualización:** se completó la revisión de los 3 portales (cliente, chofer, proveedor) que faltaban en la primera pasada, más un repaso de los módulos admin no cubiertos en detalle. El bug del punto 1 (Clientes) ya está corregido — ver nota al pie de esa sección. Detalle de lo nuevo al final del documento, sección 6.

> **⚠️ Reconciliación 2026-08-25 — este documento quedó muy atrasado, para bien.**
> Gran parte del "Plan de acción sugerido" (sección corto/mediano plazo) ya está
> implementada en el código y corrida en la base real (confirmado con
> `Supabase:list_migrations` y `pg_stat_user_indexes` sobre el proyecto real,
> no solo grep). Resumen abajo; detalle completo al final, sección 7.
> - **Migración 255 (catálogo cliente) SÍ se corrió** — el doc decía "falta
>   correr contra la base", pero aparece aplicada (`20260710165745`), junto
>   con su fix de seguridad posterior (`fix_sec008_gate_catalogo_publico`,
>   `20260711213838`). El índice nuevo `idx_stock_producto_cantidades` tiene
>   **46.905 scans** — está en uso pesado en producción.
> - **Productos, Pedidos, Cheques, Riesgo de cheques, Facturación, Notas,
>   Notas de crédito, Cta-cte, Cobranzas y Puntos** ya migraron a RPCs
>   server-side (`fn_productos_lista`, `fn_pedidos_lista`, `fn_cheques_lista`,
>   etc.) con paginación real vía `p_limit/p_offset/total_count` — no vive
>   más el patrón "traer todo + `.filter()` en JS" para ninguno de estos.
> - **`puntos.js` y `comparador-precios.js` ya tienen debounce** — la sección
>   6.3 de este mismo documento decía lo contrario ("confirmado sin
>   debounce"); quedó desactualizada por un fix posterior.
> - Siguen **sin tocar**, confirmado por ausencia de `.rpc(` en el archivo:
>   `proveedores.js`, `devoluciones.js`, `rutas.js`, `reglas-precio.js`,
>   `cc-proveedores.js`, `conciliacion-bancaria.js`, `presupuestos.js`.

Revisé los 64 HTML + 148 JS del admin y crucé cada pantalla con búsqueda/filtro contra tu Supabase real (`jgiquzjwoedmzwqgzubr`): índices existentes, uso real de esos índices (`pg_stat_user_indexes`) y volumen actual de filas.

## Resumen ejecutivo

Hay **un bug funcional** (no de performance) y **un patrón sistémico** repetido en ~20 módulos:

1. **La búsqueda de Clientes no filtra nada.** El input lee el texto pero nunca se manda a la query.
2. **Ya pagaste los índices de búsqueda correctos** (trigram/GIN) para `productos` y `clientes`, pero casi ninguna pantalla los usa: trae la tabla entera a JS y filtra con `.filter()` en el navegador. Confirmé con `pg_stat_user_indexes` que `idx_productos_busqueda_trgm` tiene **0 scans** desde que existe.
3. Ninguno de esos ~14 módulos pagina en la UI: renderizan la tabla completa en el DOM en cada filtro.

---

## 1. BUG — Búsqueda de Clientes rota

**Archivo:** `frontend/admin/js/clientes.js`, función `cargarClientes()` (línea 318-369).
**HTML:** `clientes.html:95` → `oninput="aplicarFiltros()"`.

```js
const busq = document.getElementById('input-busqueda').value.trim();  // línea 333
const zonaFiltro = document.getElementById('filtro-zona').value;

if (zonaFiltro) query = query.eq('zona_id', zonaFiltro);
if (filtroEstado === 'activo') query = query.eq('activo', true);
// ... nunca se usa `busq` acá
```

El comentario en el código (línea 332) dice *"Aplicar filtros de base de datos si es posible para eficiencia"* — pero la variable `busq` se lee y se descarta. Los otros filtros (zona, estado) sí llegan a la query; el de texto no. Resultado: **escribir un nombre, razón social o CUIT en el buscador de la lista principal de Clientes no hace nada** — sigue mostrando la página tal cual estaba.

Lo curioso es que 900 líneas más abajo (línea 1245, en otra función — un picker/selector) sí está bien resuelto:
```js
if (busq) query = query.or(`razon_social.ilike.%${busq}%,nombre_fantasia.ilike.%${busq}%,cuit.ilike.%${busq}%`);
```

Y en tu base ya existe exactamente el índice para esto:
```
idx_clientes_busqueda_trgm  GIN (razon_social || ' ' || nombre_fantasia || ' ' || cuit) gin_trgm_ops
```
Está pagado, funciona (14 scans registrados, del picker), y la pantalla principal de clientes no lo toca.

### Fix propuesto
```js
if (busq) query = query.or(`razon_social.ilike.%${busq}%,nombre_fantasia.ilike.%${busq}%,cuit.ilike.%${busq}%`);
```
insertado junto a los otros `.eq()` de la línea 336-340, antes de `const { data, count, error } = await query;`. Además conviene agregar un debounce de ~250ms en el HTML (hoy `oninput` dispara un fetch a Supabase en cada tecla, incluso sin este fix).

**✅ Aplicado.** Se agregó el `.or(...)` de búsqueda en `cargarClientes()`, se sacó el `oninput="aplicarFiltros()"` inline de `clientes.html` y se reemplazó por un listener con debounce de 250ms en `clientes.js` (mismo criterio que `busqueda-global.js`). El buscador principal de Clientes ya filtra correctamente y no dispara una query por tecla.

---

## 2. Patrón sistémico: "traer todo y filtrar en el navegador"

Con `pg_stat_user_indexes` confirmé que armaste una infraestructura de búsqueda sólida (migración `028_indices_optimizados.sql` + índices posteriores), pero la mayoría de las pantallas no la usan:

| Índice | Scans reales |
|---|---|
| `idx_productos_busqueda_trgm` (nombre+código) | **0** |
| `idx_clientes_busqueda_trgm` (razón social+fantasía+CUIT) | **0** |
| `idx_clientes_razon_social_trgm` | 14 (solo el picker) |

El patrón que se repite: `sb.from(tabla).select(...).order(...)` sin `.ilike/.or/.range` de por medio, con o sin un `.limit(N)` "tope de seguridad" fijo, y todo el filtrado (texto, estado, fecha, cliente) resuelto después con `Array.filter()` en JS.

**El modelo correcto ya existe en tu propio código** — `lib/handlers/busqueda.js` (búsqueda global del header): server-side, `.or()` con `ilike`, `empresa_id` por `.eq()`, escapa caracteres reservados de PostgREST, rate-limit, corre en paralelo por entidad. Y `clientes.js` (lista principal, salvo el bug de arriba) hace paginación real con `.range()` + `count: 'exact'`. Ese es el patrón a replicar; no hace falta inventar nada nuevo.

### Módulos afectados y su volumen real en tu base

| Módulo | Filas hoy | Qué hace hoy | Índice servidor disponible y sin usar |
|---|---|---|---|
| **Productos** (`productos.js`) | 1.008 | Trae **toda** la tabla con joins a `categorias` y `stock` (sin `.eq(empresa_id)`, sin `.limit`), filtra nombre/categoría en JS. No busca por código. | `idx_productos_busqueda_trgm` |
| **Pedidos** (`pedidos.js`) | 3.019 | `.limit(200)` fijo + filtro en JS. Si hay más de 200 pedidos "vivos", los que quedan afuera del límite no aparecen aunque coincidan con el filtro. | `idx_pedidos_empresa_estado_fecha` (para filtros de estado/fecha; falta trgm para número de pedido/cliente) |
| **Cuenta corriente — listado de clientes** (`cta-cte.js`) | 2.510 clientes | Trae todos los clientes, filtra en JS. | `idx_clientes_busqueda_trgm` |
| **Cheques** (`cheques.js`) | 189 | `.limit(500)` + filtro en JS (cliente/estado/fecha). Hoy no molesta por el volumen, pero el patrón es el mismo. | `idx_cheques_cliente_estado`, `idx_cheques_fecha_vto` |
| **Riesgo de cheques** (`riesgo-cheques.js`) | — | `.limit(1000)` + agregación y filtro en JS. | ídem |
| **Cta. cte. proveedores** (`cc-proveedores.js`) | — | Filtra proveedor/estado/fechas en JS. | — |
| **Presupuestos, Facturación, Cobranzas, Devoluciones, Notas, Notas de crédito, Proveedores, Reglas de precio, Rutas, Puntos, Conciliación bancaria** | variable | Mismo patrón: fetch completo (a veces con `.limit(300)`) + `Array.filter()`. | según tabla |

`facturacion.js` tiene el mismo problema con un agravante: `.limit(300)` sobre 1.505 facturas totales — el filtro de la pantalla no ve más de un 20% de los datos reales, dependiendo del orden.

### Por qué importa ahora, no "algún día"
No es un problema teórico: `clientes` ya tiene 2.510 filas, `pedidos` 3.019, `movimientos_stock` 8.804, `cta_cte` 2.292 — y esto es sobre lo que vi en un solo tenant demo. Cada pantalla afectada hoy transfiere y renderiza el dataset completo del tenant en cada carga de página, y lo vuelve a filtrar/ordenar en el cliente en cada tecla. Con más empresas dadas de alta (el modelo es multi-tenant), el costo crece con cada una, no de forma global — así que el síntoma va a aparecer primero en tu tenant más grande, no en todos a la vez.

---

## 3. Sin paginación en la UI (14 módulos)

Confirmé con grep que estos módulos no tienen ningún mecanismo de paginación — imprimen el array filtrado completo en la tabla:

`cta-cte.js`, `cheques.js`, `presupuestos.js`, `facturacion.js`, `devoluciones.js`, `notas.js`, `notas-credito.js`, `riesgo-cheques.js`, `proveedores.js`, `rutas.js`, `puntos.js`, `cc-proveedores.js`, `reglas-precio.js`, `conciliacion-bancaria.js`.

Contraejemplos que sí lo resuelven bien y sirven de modelo: `clientes.js` (`.range()` + `count: 'exact'` + controles prev/next), `pedidos.js` (paginación de UI ya implementada según v211, aunque el fetch de origen sigue capado en 200), `reportes-stock.js` (paginación server-side explícita, con comentario propio marcándolo como el patrón correcto), `auditoria.js` (`.range()` server-side).

---

## 4. Falta de debounce

Solo `busqueda-global.js` (280ms) y `producto-picker.js` (180ms) debouncean el input. El resto —incluido `puntos.js`, `pos.js` (7 inputs de búsqueda distintos), `comparador-precios.js`— dispara el filtro en cada `keydown`. Mientras el filtro sea 100% client-side el costo es "solo" re-renderizar tablas grandes en cada tecla; en `clientes.js`, que si aplicás el fix del punto 1 va a pegarle a Supabase en cada tecla, un debounce deja de ser cosmético y pasa a ser necesario para no generar una query por letra.

---

## Plan de acción sugerido, en orden de impacto/esfuerzo

**Ya (bug, 10 minutos):**
1. Clientes — aplicar el filtro `busq` que falta en `cargarClientes()`. Un fix de una línea que hoy hace que el buscador principal de Clientes no sirva para nada.

**Corto plazo (server-side search + `.range()`, reusando índices que ya pagaste):**
2. Productos: agregar `.or(codigo.ilike...,nombre.ilike...)` + `.range()`, sacar el join `stock` innecesario de la carga inicial (traerlo solo al abrir el detalle), agregar `.eq('empresa_id', ...)` explícito por claridad de query plan aunque RLS ya lo cubra (confirmé RLS con `empresa_id = get_empresa_id()`, no hay riesgo de fuga, es tema de performance del planner).
3. Pedidos: sacar el `.limit(200)` duro y reemplazar por `.range()` + `.ilike`/`.or` para número/cliente, reusando `idx_pedidos_empresa_estado_fecha`.
4. Cheques / Riesgo de cheques / Facturación: mismo tratamiento — los `.limit(500/1000/300)` "tope de seguridad" hoy son en la práctica un techo que esconde resultados de búsqueda, no una protección.

**Mediano plazo:**
5. Cta-cte, Cobranzas, Devoluciones, Notas, Notas de crédito, Proveedores, Reglas de precio, Rutas, Puntos, Conciliación bancaria, Cc-proveedores: mover filtros a `.eq/.ilike/.range()` y agregar paginación de UI, usando `clientes.js` y `reportes-stock.js` como plantilla.
6. Agregar debounce (~200-250ms) a todos los inputs de búsqueda que hoy no lo tienen.

¿Querés que siga por Productos/Pedidos (mayor volumen), o por el hallazgo nuevo del catálogo del portal cliente (sección 6.1, es el de mayor exposición porque es cara al público)?

---

## 6. Ampliación — portales (cliente/chofer/proveedor) y repaso de módulos admin restantes

La primera pasada auditó admin (64 HTML + 148 JS) pero no había cubierto los tres portales externos ni una revisión módulo por módulo del resto de admin. Esto cierra esa brecha.

### 6.1 Portal Cliente — `catalogo.html` trae toda la tabla `stock` en cada carga y cada tecla

**Archivos:** `frontend/cliente/catalogo.html` → `/api/cliente/productos` → `lib/handlers/stock.js`, función `handleClienteProductos` (línea 784).

El endpoint sí pagina y busca bien a nivel de `productos` (usa `q`, `categoria`, `page`/`limit` contra la API), pero para calcular disponibilidad de stock trae **la tabla `stock` completa de la empresa** (todos los depósitos, sin filtrar) a memoria de la función serverless, calcula "disponible" ahí, y recién con esos IDs arma el filtro de productos. Confirmado en la base real:

```
total_stock_rows: 2008   depositos: 3   productos_con_fila: 1008
```

Es decir, 2008 filas viajan y se procesan en JS en **cada búsqueda y cada page load** del catálogo — y esta pantalla es la de mayor tráfico de todo el sistema porque es la que ven los clientes finales, a veces sin login. El costo escala con productos × depósitos por tenant, así que empeora con el tiempo y con cada empresa nueva que sume depósitos o catálogo.

**Fix sugerido:** resolver "disponible" con una agregación en SQL (`GROUP BY producto_id` con `SUM(cantidad)` o una vista, filtrando por `empresa_id`) en vez de traer las filas crudas y sumarlas en JS — mismo patrón que ya usan en otras vistas del proyecto (`reportes-stock.js`, que la propia auditoría anterior marca como el modelo correcto de paginación server-side).

**✅ Aplicado.** Migración `255_etapa7_catalogo_cliente_stock_sql.sql`: RPC `cliente_productos_disponibles(empresa_id, categoria, busqueda, limit, offset)` que resuelve stock disponible (JOIN LATERAL contra `stock`+`depositos`), filtro de categoría/búsqueda y paginación en una sola query SQL, con `count(*) OVER()` para el total. Se agregó un índice de apoyo `idx_stock_producto_cantidades` (covering `cantidad`/`cantidad_reservada`). El handler `handleClienteProductos` en `stock.js` ya no trae ninguna fila cruda de `stock` a memoria — solo llama al RPC y adjunta las ofertas de liquidación. **Falta correr la migración 255 contra la base** (no se aplicó automáticamente, queda en el zip para tu flujo normal de deploy).

Los otros portales no tienen este problema:
- **Cliente → pedidos.html / cuenta.html**: consultas ya acotadas por `cliente_id`, sin necesidad de filtro adicional.
- **Proveedor → portal.js**: dataset acotado a un solo proveedor, filtrado en JS sobre un array chico. Sin urgencia, pero si el proveedor acumula muchas OC con los años convendría revisar el handler `/api/proveedores?_svc=portal` más adelante.
- **Chofer → index**: remitos del día, acotado a un chofer. Sin problema.

### 6.2 Corrección sobre `pos.js`

La primera pasada lo había marcado como uno de los módulos sin debounce. Revisando los 6 inputs de búsqueda del POS (producto, cliente, favoritos, venta admin, transferencia de producto, promo) resultó que **todos** tienen debounce (200-250ms) y pegan contra endpoints server-side bien resueltos (`/api/pos/productos`, `/api/clientes?busqueda=`). Se retira esta pantalla de la lista de pendientes de la sección 4 — no requiere trabajo.

### 6.3 Confirmado: `puntos.js` sin debounce

Se verificó puntualmente: el input de búsqueda en `puntos.js` (línea 33) dispara en cada `keydown` sin debounce, tal como decía la sección 4 original. Se mantiene en el plan de acción (ítem 6 del plan original).

### 6.4 Resto de módulos admin no detallados en la primera pasada

Repaso con grep de `pos.js`, `notas-internas.js`, `anomalias.js`, `automatizacion.js`, `dashboard-ejecutivo.js`, `export-contable.js`, `rentabilidad-producto-vendedor.js`, `rentabilidad-zona.js`, `reportes-financieros.js`, `reportes-ventas.js`, `remito.js`, `lotes.js`, `migracion-maestra.js`, `migracion.js`, `fidelizacion.js`, `reglas-precio.js`, `comparador-precios.js`, `conciliacion-bancaria.js`, `rutas-resumen.js`, `rutas.js`, `puntos.js`, `notas.js`, `notas-credito.js`, `devoluciones.js`, `cc-proveedores.js`, `proveedores.js`, `presupuestos.js`, `compras.js`:

- **`rutas.js`** (12 `.filter()`, el más alto del lote): el query base de pedidos despachables ya está bien acotado server-side (`empresa_id` + `estado IN (...)`), y el filtro de texto adicional corre en JS sobre ese subconjunto chico — no es el mismo problema que Cta-cte/Cheques, no requiere cambios urgentes.
- **`migracion.js` / `migracion-maestra.js`**: todo el filtrado es en memoria sobre datos ya subidos en CSV/staging (nunca tocan una tabla grande de la base), no aplica el patrón de riesgo.
- El resto de los módulos de esta lista no tiene picos de volumen ni patrones nuevos distintos a los ya cubiertos en la sección 2/3 original (mismo patrón fetch-completo + `.filter()`, ya están en la tabla de módulos afectados o son de bajo volumen y no ameritan prioridad).

No aparecieron bugs funcionales nuevos (como el de Clientes) en esta ronda — solo el hallazgo de performance del catálogo (6.1) y la corrección sobre POS (6.2).

---

## 7. Reconciliación 2026-08-25 — verificación contra código y base real

Repaso hallazgo por hallazgo de las secciones 2-5, cruzando `grep` en el zip
actual con `Supabase:list_migrations` y `pg_stat_user_indexes` sobre el
proyecto real (`jgiquzjwoedmzwqgzubr`), no solo lectura de código:

### 7.1 Catálogo cliente (6.1) — SÍ se corrió, y se usa fuerte
El doc original decía *"Falta correr la migración 255 contra la base"*. Al
listar las migraciones aplicadas en el proyecto real aparece
`255_etapa7_catalogo_cliente_stock_sql` (aplicada) y también un fix de
seguridad posterior que el documento no llegó a ver:
`fix_sec008_gate_catalogo_publico` — el RPC `cliente_productos_disponibles`
(`SECURITY DEFINER`) devolvía catálogo completo de cualquier empresa sin
validar sesión (GRANT directo a `anon`/`authenticated` vía PostgREST). Se
corrigió gateando el acceso público detrás de un flag por empresa
(`empresas.config->>'catalogo_publico_habilitado'`, default `false`). No es
parte de esta auditoría de filtros, pero es relevante: el fix de performance
del punto 6.1 destapó un hallazgo de seguridad que ya se resolvió aparte.
`idx_stock_producto_cantidades` (el índice de apoyo creado en la 255) tiene
**46.905 scans** reales — confirma que el RPC está en uso constante, no solo
deployado.

### 7.2 Productos, Pedidos y el resto de la tabla de la sección 2 — migrados
Contra lo que dice la sección 2/5 ("corto/mediano plazo, pendiente"), el
código ya usa RPC server-side en:
- `productos.js` → `fn_productos_lista` (búsqueda+categoría+estado+orden+stock agregado+paginación, todo en SQL — el propio comentario en el archivo cita esta auditoría).
- `pedidos.js` → `fn_pedidos_lista` (ya no depende del `.limit(200)` duro que señalaba el punto 3 del plan).
- `cheques.js` → `fn_cheques_lista` + `fn_cheques_contadores`.
- `riesgo-cheques.js` → `fn_riesgo_cheques_lista` (agregado por cliente, no es una lista paginable por diseño — no aplica el mismo criterio de "falta paginación").
- `facturacion.js` → `fn_facturas_lista` + `fn_facturas_contadores`.
- `notas.js` → `fn_notas_lista`.
- `notas-credito.js` → `fn_notas_credito_lista`.
- `cta-cte.js` → `fn_cta_cte_kpis` + `fn_cta_cte_lista`.
- `cobranzas.js` → `fn_cobranzas_kpis` + `fn_cobranzas_facturas`.
- `puntos.js` → `fn_puntos_kpis` + `fn_puntos_lista`.

De estos, todos salvo `riesgo-cheques.js` muestran `p_limit/p_offset/total_count`
en el propio archivo — es decir, además de mover el filtro a SQL, agregaron
paginación real de UI (cierra también buena parte de la sección 3, "sin
paginación", para estos módulos puntuales).

`idx_productos_busqueda_trgm` pasó de **0 scans** (cuando se escribió este
documento) a **63 scans** ahora — coherente con que `fn_productos_lista` ya
lo está usando. `idx_clientes_busqueda_trgm` sigue en **0 scans** pese al fix
del bug de Clientes (punto 1): probablemente low-traffic real todavía, no
evidencia de que el fix no funcione (se confirmó por lectura de código que
el `.or(...)` sí está en `cargarClientes()`).

### 7.3 Debounce (sección 4) — dos correcciones más de las que el documento sabía
- `puntos.js` **ya tiene debounce** (`debounceBusquedaPuntos`, con comentario
  propio citando el problema original). La sección 6.3 de este mismo
  documento decía "confirmado sin debounce" — quedó desactualizada por un
  fix posterior a esa verificación.
- `comparador-precios.js` **ya tiene debounce** interno en `onBuscarProducto`
  (`buscarTimeout`), pese a que el `addEventListener` no lo deja ver a
  simple vista (el debounce está adentro de la función, no en el listener).

### 7.4 Lo que sigue realmente pendiente
Confirmado por ausencia de cualquier `.rpc(` en el archivo — estos son los
únicos módulos de la tabla original de la sección 2 que siguen sin tocar:
**`proveedores.js`, `devoluciones.js`, `rutas.js`, `reglas-precio.js`,
`cc-proveedores.js`, `conciliacion-bancaria.js`, `presupuestos.js`.**
De estos, `proveedores` es el más "listo para hacer": el índice
`idx_proveedores_busqueda_trgm` (migración 265) ya existe en la base, pagado
y sin usar — mismo patrón que tenía `productos`/`clientes` antes del fix.

**Plan de acción actualizado:** de los ~14 módulos originales de la sección
2/3, quedan 7 pendientes (listados arriba). El resto puede darse por
resuelto y sacarse del plan.
