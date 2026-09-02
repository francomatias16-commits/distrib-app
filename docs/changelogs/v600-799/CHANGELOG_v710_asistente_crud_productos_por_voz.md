# v710 — Nuevas tools `crear_producto` y `editar_producto` (Fase A, ítem 2)

## Reportado

Segundo ítem del backlog de `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`
(Fase A): `productos.html` es una página entera del admin sin ninguna
tool del asistente — no se puede dar de alta un producto, cambiarle el
precio, ni darlo de baja por voz.

## Diagnóstico (cambia el planteo original del plan)

El plan original asumía que este ítem era "cablear sobre
`fn_crear_producto` / `fn_productos_lista`, ya existentes" — mismo
criterio que funcionó para `registrar_cobro_cliente` (v709). Al revisar
la firma real de `fn_crear_producto` (última definición vigente:
`441_fix_stock_cantidad_disponible_columna_generada.sql`), aparece una
diferencia de fondo con `registrar_cobro_completo`:

- `registrar_cobro_completo` recibe `p_empresa_id` **como parámetro
  explícito**, y solo lo valida contra `get_empresa_id()` cuando
  `auth.role() <> 'service_role'` — es decir, ya está preparada para que
  la llame el asistente (que siempre usa la service role key, ver
  `lib/repos/_db.js`).
- `fn_crear_producto` **no tiene ese parámetro**: resuelve la empresa
  con `v_empresa_id := public.get_empresa_id()`, una función que depende
  del JWT de sesión del usuario logueado en el navegador (RLS). Sin esa
  sesión —que es exactamente el caso del asistente, service role sin
  usuario— `get_empresa_id()` devuelve `NULL` y la función corta con
  `RAISE EXCEPTION 'No se pudo determinar la empresa del usuario
  actual.'`.

Dos caminos posibles: (a) modificar `fn_crear_producto` para que acepte
`p_empresa_id` explícito con el mismo patrón que
`registrar_cobro_completo`, o (b) no tocar la RPC de producción y
replicar su misma lógica con operaciones directas sobre tabla,
filtradas por `empresa_id` explícito. Se eligió **(b)**, por el mismo
motivo que ya aplicó `actualizar_preferencia_notificacion` (v_ tools de
notificaciones): es exactamente el mismo patrón que el resto del
cluster de "maestros" de este archivo (`crear_categoria`,
`crear_deposito`, `crear_zona`) — ya usan `db.from(tabla).insert(...)`
con `empresa_id` explícito en vez de una RPC — y no arriesga romper
`fn_crear_producto` (que sigue viva y en uso por `productos.html`) sin
poder probar el cambio contra la base real desde este entorno.

Para **editar producto**, el frontend (`productos.js` →
`guardarProducto()`) tampoco usa una RPC — hace
`sb.from('productos').update(payload).eq('id', modalProductoId)`
directo, apoyado en RLS + el JWT de sesión para el scoping por empresa.
Se replicó el mismo `UPDATE`, pero con `.eq('empresa_id', empresaId)`
explícito en vez de RLS (igual que el resto de tools de escritura del
archivo que no pasan por RPC).

## Limitación conocida (documentada a propósito, no un descuido)

`buscar_productos_asistente` (la RPC de búsqueda difusa que ya usa
`crear_pedido`, reusada acá para resolver "el producto tal" dicho por
voz) **filtra `activo = true`** — así fue diseñada desde el origen
(migración `420_asistente_busqueda_aproximada_pg_trgm.sql`). Consecuencia
directa: `editar_producto` puede **dar de baja** un producto activo
(porque lo puede encontrar), pero **no puede encontrar por voz un
producto ya inactivo** para reactivarlo o tocarle el precio — la
búsqueda simplemente no lo va a traer como candidato.

No se tocó esa RPC para arreglar este caso puntual porque la reusan
además `crear_pedido`, `crear_presupuesto` y los `diagnosticar_*` — un
cambio ahí tiene mucho más "blast radius" que agregar dos tools nuevas,
y no se puede probar contra la base real desde este entorno. Queda
anotado como pendiente explícito, no oculto: si en el uso real aparece
la necesidad de reactivar productos por voz con frecuencia, es un ítem
aparte (con su propia migración y prueba) antes de tocar la RPC
compartida.

## Cambios

### `lib/asistente-tools.js`

- Nuevos helpers (junto a `buscarMaestroExistente`):
  - `resolverDepositosPorNombre`: a diferencia de clientes/productos (que
    usan una RPC de similitud porque hay potencialmente cientos de
    filas), acá se trae la lista completa de depósitos de la empresa —
    normalmente un puñado— y se resuelve cada nombre pedido con un
    "contiene" case-insensitive en JS. 0 o 2+ coincidencias para un
    nombre dado es una excepción con la lista real de depósitos
    disponibles, nunca una adivinanza.
  - `resolverCategoriaPorNombre`: a propósito **nunca crea la categoría
    sola** si no existe (a diferencia de cómo `crear_pedido` resuelve
    cliente/producto) — una categoría mal transcripta que se
    auto-crea deja basura silenciosa en el catálogo. Si no existe, le
    dice al usuario que la cree primero con `crear_categoria` o que dejo
    el producto sin categoría.
  - `resolverCrearProductoDesdeArgs` / `resolverEditarProductoDesdeArgs`:
    arman los datos ya validados que usan `resumen()` y `execute()` de
    las dos tools nuevas (mismo criterio que `resolverPedidoDesdeArgs`
    de `crear_pedido`: se llaman de nuevo en `execute()`, no se reusa el
    resultado de `resumen()`, por si pasó tiempo entre proponer y
    confirmar).
- Nueva tool `crear_producto`:
  - `roles: ['dueno', 'admin']`, `requiereConfirmacion: true`.
  - Exige al menos un depósito (nunca asume "todos los depósitos" — a
    propósito, mismo criterio que la advertencia ya existente en
    `crear_deposito` sobre no asumir "depósito principal").
  - Inserta en `productos` y en `stock` (cantidad 0, `costo_promedio` =
    costo dado) para cada depósito resuelto, replicando exactamente la
    lógica de `fn_crear_producto` pero con `empresa_id` explícito.
- Nueva tool `editar_producto`:
  - `roles: ['dueno', 'admin']`, `requiereConfirmacion: true`.
  - Solo aplica los campos que el usuario mencionó explícitamente
    (precio, costo, stock mínimo, categoría, activo) — nunca completa
    con un valor no dicho.
  - `activo: false` es la forma de "dar de baja"; `activo: true` es
    "reactivar", con la limitación de búsqueda ya documentada arriba
    (la descripción de la tool se la explica al modelo para que la
    traslade al usuario en vez de fallar en silencio).

## Verificación

- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`
  (pasa limpio). Van 78 tools en total (76 + estas 2).
- Se confirmó el schema real de `stock` (`cantidad`,
  `cantidad_reservada`, `costo_promedio`, `UNIQUE(producto_id,
  deposito_id)`) contra `001_schema.sql` para que el insert de stock
  inicial replique exactamente lo que hace `fn_crear_producto`.
- Se confirmó que `productos.codigo` no tiene unique constraint a nivel
  DB (no hace falta manejar conflicto de duplicados como caso especial).
- **Pendiente, no se pudo hacer desde este entorno** (sin credenciales
  de Supabase): prueba funcional end-to-end — crear producto con 1 y
  con 2+ depósitos, depósito ambiguo/inexistente, categoría inexistente,
  editar precio de un producto activo, dar de baja, e intentar
  reactivar uno inactivo (debería fallar con el mensaje esperado, no
  romper). Mismo pendiente que v709: falta antes de pasar a producción.

## Cómo queda

El asistente ahora puede dar de alta productos nuevos (con stock
inicial en los depósitos que indique el usuario) y editar precio, costo,
stock mínimo, categoría o estado activo/inactivo de un producto
existente, todo con el mismo botón Confirmar del resto del catálogo.
Reactivar un producto inactivo por voz queda pendiente (ver
Limitación); mientras tanto se hace desde el panel.

## Archivos modificados

- `lib/asistente-tools.js`

## Siguiente paso (Fase A, ítem 3 del plan)

Emitir/anular factura — mayor riesgo que cobros y productos, por eso va
con confirmación reforzada (ítem 2 de la sección 3 del plan). Antes de
tocarlo conviene revisar si `facturas.js` tiene alguna RPC ya apta para
service_role (con `p_empresa_id` explícito, como `registrar_cobro_completo`)
o si va a hacer falta el mismo tipo de rodeo que este ítem.
