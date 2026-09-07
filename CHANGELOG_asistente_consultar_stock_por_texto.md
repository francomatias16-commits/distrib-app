# Asistente: nueva tool `consultar_stock_por_texto_asistente`

**2026-09-07**

## Problema reportado
En uso real (captura de pantalla del chat-widget), el asistente no pudo
responder a una consulta de stock por familia de productos:

- "y cual tiene stock?" → *"No tengo una forma de consultar el stock de
  todos los productos de la lista a la vez."*
- "y de los aceites estamos hablando" → *"No tengo una forma de consultar
  el stock de todos los productos que contengan 'aceites'."*

## Causa
Las tools de stock existentes no cubrían este caso:
- `consultar_stock_critico`: solo un conteo total, sin detalle.
- `consultar_analisis_stock_predictivo`: solo productos que necesitan
  reposición, no "cuánto stock hay de X".
- La resolución de producto usada por las tools de escritura
  (`buscarProductoPorTexto`, vía `buscar_productos_asistente`) está pensada
  para resolver a **UN** producto exacto para ejecutar una acción (crear
  pedido, ajustar stock) — si el texto matchea varios, tira error de
  desambiguación en vez de listarlos.

Ninguna tool listaba **todos** los productos que matchean un texto/categoría
junto con su stock — que es justo lo que pide una pregunta tipo "qué
aceites tengo" o "cuánto stock hay de fideos".

## Solución
Nueva tool de solo lectura en `lib/asistente-tools/stock.js`:

**`consultar_stock_por_texto_asistente`** — roles `dueno/admin/vendedor/depositero`
(mismos que el resto de las tools de stock). Recibe `texto` (obligatorio) y
`limite` (opcional, default 20, tope 50). Busca productos activos por
`nombre ILIKE %texto%` o `codigo ILIKE %texto%` — mismo patrón exacto que
`buscarIdsProductos()` (usado hoy por el cuadro de búsqueda de
`stock.html`) — y devuelve, por cada uno, el stock disponible total y
desglosado por depósito (mismo cálculo `cantidad - cantidad_reservada` que
ya usa `lib/handlers/stock.js` como fallback cuando no viene la columna
generada `cantidad_disponible`).

No se tocó ninguna RPC ni repo compartido con la UI real — la tool hace sus
propias consultas `db.from('productos')` / `db.from('stock')` scopeadas por
`empresa_id` + `activo=true`, mismo criterio que `buscarCategoriaPorTexto`/
`buscarZonaPorTexto` en `_helpers.js` (inline, sin acoplar este archivo a
otro repo). No requiere confirmación (solo lectura).

## Verificación
- Tests nuevos: `tests/asistente/consultar-stock-por-texto.test.js` (7
  casos: listado con varios matches, producto sin filas de stock, sin
  coincidencias, sin texto, límite topeado a 50, error de DB propagado).
  Suite completa: 123/123 archivos, 1669/1669 tests OK (1662 + 7 nuevos).
- Verificado contra datos reales en Supabase (`jgiquzjwoedmzwqgzubr`,
  solo `SELECT`, sin escritura): la búsqueda "aceite" para la empresa de
  la captura devuelve 22 productos reales con su stock real (la mayoría en
  0, algunos con stock real: 170, 147, 116, 24) — coincide exactamente con
  lo que la tool nueva devolvería.

## Pendiente (no bloqueante)
No se probó todavía con el modelo real eligiendo esta tool a partir de una
pregunta dictada por voz (mismo tipo de pendiente que quedó anotado en
`PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md` §6) — la descripción de la
tool incluye explícitamente la frase "y de los X estamos hablando" (la
consulta real que falló en la captura) para ayudar al modelo a elegirla en
ese caso de seguimiento conversacional.
