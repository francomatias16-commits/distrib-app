# v713 — Nuevas tools `ajustar_stock_asistente`, `registrar_conteo_stock_asistente`,
`crear_orden_compra_asistente`, `recepcionar_orden_compra_asistente`
(Fase A, ítem 4 — cierre de `compras.html` y ajuste manual de stock)

## Reportado

Cuarto y último ítem de la Fase A del backlog de
`PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`: ni el modal "Ajustar stock"
de `stock.html` (ingreso/egreso manual, conteo físico, producción propia)
ni ninguna operación de `compras.html` (crear OC, recepcionar OC) tenían
tool de escritura — solo lectura (`listar_ordenes_compra`,
`consultar_ranking_ahorro_proveedores`).

## Investigación previa (retomada de la sesión anterior)

Antes de escribir código se releyeron las RPCs reales y su versión más
reciente (no la primera migración que las creó):

- `frontend/admin/js/stock.js` → `guardarAjuste()`: un solo modal cubre
  tres ramas según `tipoActivo`/`motivo`:
  - `motivo === 'conteo_fisico'` (tipo ajuste) → `registrar_conteo_stock`
    (v443, la que agrega `p_stock_sistema_esperado`/`p_offline_local_id`
    para el outbox offline — **no** la v399 vieja). Fija el stock al
    valor contado, no lo suma/resta.
  - `tipoActivo === 'ingreso' && motivo === 'produccion'` → NO usa
    `ajustar_stock`: usa `producir_con_insumos` (v343), que descuenta los
    insumos de la receta (`producto_insumos`, BOM) en la misma
    transacción. Si el producto no tiene receta, produce igual
    (`tiene_receta:false`).
  - Cualquier otro ingreso/egreso → `ajustar_stock` con `p_delta` con
    signo (positivo/negativo según `tipoActivo`).
  - El `<select id="select-motivo">` de `stock.html` excluye a propósito
    el motivo `compra` de los ingresos manuales — ese ingreso solo puede
    entrar por `recepcionar_orden_compra` (ver abajo), nunca por el modal
    de ajuste. Se replicó la misma restricción en la tool: no se ofrece
    `compra` como motivo válido.
- `crear_orden_compra` (v354, la que completa `descripcion` — no la v192
  vieja): recibe `p_items` como jsonb con `producto_id`/`cantidad`/
  `precio_costo`; no valida rol internamente (solo
  `assert_empresa_access`, no-op con `service_role`), así que el gate de
  rol lo pone la tool con `roles: ['dueno','admin']`, calcado de que
  `compras.html` está restringido a esos roles en el panel real.
- `recepcionar_orden_compra` (v341, la que escribe en `stock` por
  depósito real — la v054 vieja solo tocaba una columna suelta
  `productos.stock_actual` que ni siquiera existe hoy en producción):
  firma de 5 parámetros (`p_deposito_id` opcional al final, resuelve al
  depósito principal si no se pasa). Igual que `crear_orden_compra`, sin
  gate de rol propio → lo pone la tool.
- Columna FK real de `ordenes_compra_items` es `orden_compra_id` (se
  verificó contra `migraciones_completas.sql`, no contra la definición
  más vieja en `017_req01_02_03.sql` que después quedó desactualizada
  respecto de un rename).

## Cambios

### `lib/asistente-tools.js`

- Nueva tool `ajustar_stock_asistente`:
  - `roles: ['dueno', 'admin', 'depositero']`, `requiereConfirmacion: true`.
  - Motivos de ingreso expuestos: `devolucion_cliente`, `produccion`,
    `ajuste_manual`. Motivos de egreso: `venta_manual`, `merma`, `rotura`,
    `muestra`, `ajuste_manual`. **No** se expone `compra` — si el usuario
    pide cargar una compra por acá, la tool está pensada para que el
    modelo explique que tiene que recepcionar la OC correspondiente en
    vez de inventar un ingreso libre.
  - `resumen()` valida contra el stock actual que un egreso no deje el
    stock negativo (mismo criterio informativo que ya usan otras tools de
    ajuste del archivo) y avisa si el motivo es `produccion` que se van a
    descontar insumos de la receta.
  - `execute()` replica la bifurcación exacta de `guardarAjuste()`:
    `producción` + `ingreso` → `producir_con_insumos`; cualquier otro
    caso → `ajustar_stock` con el delta con signo.
- Nueva tool `registrar_conteo_stock_asistente`:
  - Mismos roles que la anterior. Un solo número, `cantidad_contada`
    (≥ 0), que REEMPLAZA el stock del sistema — se aclaró explícitamente
    en la `description` para que el modelo no la confunda con
    `ajustar_stock_asistente` (cantidad relativa).
  - Llama a `registrar_conteo_stock` sin `p_offline_local_id` ni
    `p_stock_sistema_esperado` — son del plan offline del dispositivo, no
    tienen sentido en una llamada síncrona del asistente por voz.
- Nueva tool `crear_orden_compra_asistente`:
  - `roles: ['dueno', 'admin']`. Cada item requiere `producto`,
    `cantidad` y `precio_costo` — si falta el precio de costo, la
    `description` instruye explícitamente a pedirlo en vez de inventarlo
    o reusar el último precio de venta (los RPCs de este archivo nunca
    calculan precios del lado del modelo).
  - `resumen()` arma el detalle de items con subtotal (aclarando "más
    IVA", porque `crear_orden_compra` calcula el IVA server-side por
    `iva_pct` de cada item, no lo hace la tool).
- Nueva tool `recepcionar_orden_compra_asistente`:
  - `roles: ['dueno', 'admin', 'depositero']` (recepción física, mismo
    nivel de acceso que el resto de las tools de depósito).
  - Busca la OC por `numero_oc` (ilike dentro de la empresa); si hay más
    de una coincidencia, pide precisar en vez de adivinar.
  - Si el usuario no da `items`, recepciona **todo lo pendiente** de la
    orden (`cantidad - cantidad_recibida` de cada renglón, al
    `precio_costo` ya pactado en la OC) — cubre el caso más común
    ("llegó la mercadería de la OC tal") sin obligar a redictar cada
    línea. Si da `items` puntuales, cada producto se valida contra los
    renglones reales de la orden (rechaza productos que la OC no tiene).
  - Corta antes de llamar a la RPC si la orden está `cancelada` o ya
    `recibida` por completo, o si no queda ningún renglón pendiente.

### Helpers nuevos (junto a `resolverTransferenciaStock`)

- `resolverAjusteStock`, `resolverConteoStock`,
  `resolverOrdenCompraDesdeArgs`, `resolverRecepcionOrdenCompra` — mismo
  patrón que el resto del archivo: resuelven producto/depósito/proveedor
  por texto libre contra las búsquedas aproximadas existentes
  (`buscarProductoPorTexto`, `buscarDepositoPorTexto`,
  `buscarProveedorPorTexto`), nunca le confían un id al modelo, y tiran
  una excepción con una pregunta concreta cuando hace falta desambiguar.

## Pendiente (igual que v709/v710/v711)

- Prueba funcional contra datos reales (sin credenciales de Supabase en
  este entorno): dictar por voz al menos un caso de cada tool, confirmar,
  y verificar que el estado en las tablas queda idéntico a hacerlo a mano
  desde `stock.html`/`compras.html`.
- Con esto se cierran los 4 ítems de la Fase A del plan
  (`PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`) — falta actualizar la
  tabla de checkboxes del plan y arrancar la Fase B.
