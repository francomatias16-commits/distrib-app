# v709 — Nueva tool `registrar_cobro_cliente` (Fase A, ítem 1 del plan de operación por voz)

## Reportado

Primer ítem del backlog de `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`
(Fase A): registrar un cobro de cliente es la acción de escritura más
repetida del día a día (vendedores/reparto cobrando en la calle) y hoy
solo se puede hacer a mano, tocando la pantalla de Rutas del día o
Cuenta corriente. El asistente podía **listar** cobros (`listar_cobros`,
ya existente) pero no podía **registrar** uno.

## Diagnóstico

`registrar_cobro_completo` ya es una RPC `SECURITY DEFINER` madura,
usada hoy en producción desde tres lugares del frontend
(`rutas-resumen.js` → "Registrar cobro" del resumen del día,
`cta-cte.js`, `cobros-offline.js`) y ya contempla: validación de monto
> 0, cliente perteneciente a la empresa, aplicación opcional a una o
varias facturas (`p_facturas_aplicadas`), numeración de comprobante, y
reevaluación automática del bloqueo del cliente si el cobro salda su
deuda. **No hizo falta ninguna migración SQL nueva** — es exactamente
el caso previsto en el diagnóstico del plan (§1.B): cablear una tool
sobre una RPC que ya existe y ya está probada, no escribir lógica de
negocio desde cero.

Se dejó **deliberadamente afuera** `p_facturas_aplicadas`: aplicar un
cobro a una factura puntual requiere que el usuario elija entre varias
facturas abiertas de ese cliente, y esa es justo el tipo de decisión con
varias opciones ambiguas que no conviene resolverse a ciegas por voz sin
una lista visual — coherente con cómo el resto del catálogo ya maneja la
ambigüedad (`buscarClientePorTexto`, `buscarProductoPorTexto`: candidato
único o se pregunta, nunca se adivina). Con esta tool el cobro queda
como cobro general de cuenta corriente, igual que el flujo de "Rutas del
día" que ya usa el vendedor en el campo.

## Cambios

### `lib/asistente-tools.js`

- Nuevo helper `buscarClienteParaCobroPorTexto`: mismo criterio de
  búsqueda aproximada que `buscarClientePorTexto` (RPC
  `buscar_clientes_asistente`, candidato único o se tira una pregunta
  concreta), pero **sin** el bloqueo por `activo` que sí tiene la
  versión usada por `crear_pedido` — cobrar una deuda vieja de un
  cliente ya dado de baja es un caso válido, a diferencia de cargarle un
  pedido nuevo.
- Nueva tool `registrar_cobro_cliente`, ubicada junto a `listar_cobros`.
  - `roles: ['dueno', 'admin', 'vendedor']` — mismo criterio que
    `crear_pedido`/`ROLES_PEDIDO` (quien puede cargar un pedido en el
    campo, puede cobrar en el campo); a diferencia de `listar_cobros`
    (que incluye `contador` para lectura), acá no se incluye `contador`
    porque no es quien maneja efectivo en la operación diaria.
  - `requiereConfirmacion: true`, con `resumen()` que muestra monto,
    medio y cliente, y **enriquece con el saldo actual de deuda del
    cliente y en cuánto queda después del cobro** (o si lo deja a
    favor) — para que el usuario confirme con contexto real, no a
    ciegas.
  - `execute()` vuelve a resolver el cliente desde cero (no reusa nada
    de `resumen()`, mismo criterio que `crear_pedido`: pudo pasar
    tiempo entre proponer y confirmar) y llama a
    `registrar_cobro_completo` vía `db.rpc(...)` sin
    `p_facturas_aplicadas` ni `p_factura_id` (quedan `NULL`, default de
    la función).
  - Medio de pago restringido a `enum: ['efectivo', 'transferencia',
    'cheque', 'otro']` (mismas 4 opciones que el `<select>` de
    "Registrar cobro" en `rutas.html`), con la `referencia` como lugar
    para el detalle real cuando el usuario dice algo que no encaja
    exacto (Mercado Pago, débito, QR, etc.).

## Verificación

- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`
  (pasa limpio).
- Se revisó a mano la firma vigente de `registrar_cobro_completo`
  (migración `444_offline_dedup_entregas_devoluciones_cobro.sql`, la
  más reciente que la redefine) para confirmar nombres y orden de
  parámetros nombrados, y que `p_facturas_aplicadas`/`p_factura_id`/
  `p_offline_local_id` son todos opcionales con default `NULL`.
- **Pendiente, no se pudo hacer desde este entorno** (sin credenciales
  de Supabase ni acceso de red al proyecto): la prueba funcional
  end-to-end contra datos reales (candidato de cliente único vs.
  ambiguo, cobro que salda deuda y dispara el desbloqueo automático,
  medio "otro" con referencia). Antes de pasar a producción falta
  correr esto en el tenant demo, igual que se hizo para
  `listar_movimientos_caja` en v528, y probar el flujo completo por voz
  (dictado real, no solo texto tipeado) — es el mismo criterio que pide
  el checklist de "completo" del plan (§6).

## Cómo queda

El asistente ahora puede registrar un cobro general de cuenta corriente
a partir de un pedido por voz o texto ("cobré $15.000 en efectivo a
Juan Pérez"), mostrando el saldo antes/después como parte de la
confirmación, con el mismo botón Confirmar que ya usan las otras 27
tools de escritura — nunca se ejecuta en el mismo turno en que el
modelo la decide. Aplicar el cobro a una factura puntual sigue siendo
manual, por diseño (ver Diagnóstico).

## Archivos modificados

- `lib/asistente-tools.js`

## Siguiente paso (Fase A, ítem 2 del plan)

CRUD de productos, cableando sobre `fn_crear_producto` /
`fn_productos_lista` (ya existentes, hoy solo llamadas por
`productos.html` de forma directa) — requiere primero confirmar si esas
RPC ya son suficientes para exponer como tool tal cual, o si hace falta
una capa intermedia de "editar"/"dar de baja" que hoy no tiene RPC
propia.
