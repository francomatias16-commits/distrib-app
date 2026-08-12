# v512 — Flexibilidad general del asistente (no solo pedidos)

## Pedido

Después de la v511 (que resolvió el caso puntual de "pasame los pedidos
pendientes"), CLAY pidió que la mejora tuviera impacto general: la misma
rigidez existía en otras secciones, no solo en pedidos.

## Diagnóstico auditado

Se relevaron las 4 tools de "diagnóstico de un documento puntual":
`diagnosticar_pedido`, `diagnosticar_presupuesto`, `diagnosticar_venta_pos`
y `diagnosticar_cheque`. Las primeras 3 exigían el ID corto de 6 caracteres
de entrada — si el usuario solo daba el nombre del cliente, el prompt le
decía al modelo que se lo pidiera, sin intentar resolverlo. La cuarta
(`diagnosticar_cheque`) ya buscaba por nombre de cliente (un cheque no tiene
ID visible en el panel), y funcionaba mucho mejor en la práctica — esa
asimetría era la causa de fondo de la rigidez reportada, y no era exclusiva
de pedidos.

También se encontró el mismo patrón "solo doy el número, no el detalle" en
`consultar_stock_critico` (devolvía nada más que un conteo, cuando
`consultar_analisis_stock_predictivo` ya existe y da el detalle producto por
producto con días hasta quiebre).

## Cambios

### `lib/asistente-tools.js`

- Helper nuevo `buscarDocumentosRecientesPorCliente(empresaId, texto, tabla,
  columnaFecha)`: reusa `buscarClientePorTexto` (la misma búsqueda aproximada
  por trigramas que ya usa `crear_pedido`) para resolver el cliente sin
  adivinar, y trae sus documentos más recientes en la tabla pedida.
- Helper nuevo `resolverReferenciaParaDiagnostico`: punto de entrada
  compartido por las 3 tools de diagnóstico — si viene `referencia` la usa
  tal cual; si viene solo `cliente`, resuelve con el helper anterior y
  devuelve el documento directo si hay uno solo, o una lista de candidatos
  (mismo shape `ambiguo`/`candidatos` que ya devuelven las RPC
  `diagnosticar_*` cuando la referencia matchea más de un registro) si hay
  varios.
- `diagnosticar_pedido`, `diagnosticar_presupuesto`, `diagnosticar_venta_pos`:
  ahora aceptan un campo `cliente` alternativo a `referencia` y usan el
  resolutor de arriba — mismo comportamiento que ya tenía
  `diagnosticar_cheque`, sin tocar las RPC de Supabase (siguen recibiendo
  solo `p_referencia`, la resolución por nombre ocurre del lado de Node).
- `consultar_stock_critico`: descripción aclarada para que el modelo use
  `consultar_analisis_stock_predictivo` cuando piden el detalle, no solo el
  número.

### `lib/handlers/asistente.js`

- `armarSystemPrompt()`: el párrafo sobre "no pedir de más" ya no habla
  específicamente de pedidos — ahora dice explícitamente que las tools de
  diagnóstico saben buscar por nombre de cliente y que hay que priorizar
  eso, para cualquier sección (pedidos, presupuestos, ventas, cheques,
  cuentas corrientes, stock, cola financiera, automatización, etc.), antes
  de pedirle al usuario cualquier ID.

## Archivos modificados

- `lib/asistente-tools.js`
- `lib/handlers/asistente.js`

## Fuera de alcance de esta pasada

- Las tools de ESCRITURA (`anular_venta_pos`, `confirmar_pedido_sugerido`,
  etc.) siguen exigiendo la referencia exacta a propósito — no se les aplicó
  la búsqueda por nombre, para no arriesgarse a ejecutar una acción real
  sobre el documento equivocado.
