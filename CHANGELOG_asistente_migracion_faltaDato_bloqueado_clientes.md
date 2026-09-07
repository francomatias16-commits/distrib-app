# Migración de tools a faltaDato/bloqueado — segundo lote (clientes.js)

## Qué se migró

`lib/asistente-tools/clientes.js`, 5 call sites, en 4 tools:

- **`consultar_precio_producto_cliente`**: el chequeo "no se mandó ningún
  producto para cotizar" pasó de
  `throw new Error('Falta indicar al menos un producto para cotizar.')` a
  `throw faltaDato('al menos un producto')`.

- **`crear_cliente`**: "falta razón social" pasó a
  `throw faltaDato('el nombre o razón social del cliente')`; "ya existe
  un cliente con ese CUIT/esa razón social" pasó de un string armado a
  mano a
  `throw bloqueado(\`Ya existe un cliente con ese...\`, 'No hace falta crearlo de nuevo.')`.
  Nota: el template original arma `ese` + `a razón social` sin corregir
  la concordancia ("esea razón social") — se preservó tal cual, no se
  tocó redacción fuera del alcance de esta migración.

- **`crear_cliente`** (rama de error de `exigirLimitePlan()`, dentro de
  `crearClienteRepo`): "límite de clientes del plan contratado" pasó a
  `bloqueado(motivo, salida)`.

- **`editar_cliente_asistente`**: "el cliente ya está activo" (al pedir
  reactivar uno que no estaba inactivo) pasó a `bloqueado()`, migrado en
  los dos call sites idénticos (`resumen()` y `execute()` repiten el
  mismo chequeo).

- **`dar_de_baja_cliente_asistente`**: "el cliente ya está inactivo",
  mismo patrón, también migrado en `resumen()` y `execute()`.

## Qué NO se migró (a propósito)

- Los wrappers de error de DB (`throw new Error(\`<tool>: ${error.message}\`)`)
  en las ~9 tools restantes del archivo (`consultar_bloqueo_cliente`,
  `consultar_ciclo_compra_cliente`, `consultar_score_cliente`,
  `consultar_puntos_cliente`, `canjear_recompensa_asistente`,
  `crear_recompensa_asistente`, `editar_recompensa_asistente`,
  `editar_cliente_asistente`, `dar_de_baja_cliente_asistente`): no son
  ni "falta un dato" ni "acción bloqueada", son errores de infraestructura
  — no encajan en el contrato de `_respuestas.js`.
- `editar_recompensa_asistente` / `editar_cliente_asistente`: el caso
  "no especificaste ningún dato para cambiar" queda sin migrar, mismo
  criterio que `editar_producto` en el lote de `stock.js` — forzarlo al
  molde de `faltaDato(campo, ejemplo)` degradaría la redacción actual.
- El resto de `clientes.js` y los demás archivos de tools por dominio
  (`pedidos.js`, `proveedores.js`, y el resto): sin tocar. Migración
  deliberadamente incremental.

## Test agregado

`tests/asistente/clientes-formato-error.test.js` (10 tests) — cubre:

- `consultar_precio_producto_cliente`: items vacío → `faltaDato`, sin
  `.opciones`.
- `crear_cliente` `resumen()`: sin razón social → `faltaDato`, sin tocar
  la DB; ya existe por razón social y por CUIT → `bloqueado`, verificando
  que el mensaje distingue ambos motivos.
- `crear_cliente` `execute()`: `LIMITE_PLAN_ALCANZADO` → `bloqueado` con
  motivo y salida; otro error de DB → se preserva el formato viejo
  `crear_cliente: <mensaje>` (no migrado, control de que no se rompió).
- `editar_cliente_asistente` y `dar_de_baja_cliente_asistente`,
  parametrizados donde aplica: `resumen()` y `execute()` tiran
  `bloqueado()` con el mismo mensaje y no llegan a llamar al repo
  (`actualizarCliente`/`desactivarCliente` sin invocar).

Mismo patrón de mock que el lote de `stock.js` (`lib/repos/_db.js`
mockeado, resolvers reales de `_helpers.js` sin mockear); acá además se
mockeó `lib/repos/clientes.js` para simular el código
`LIMITE_PLAN_ALCANZADO` sin reconstruir `exigirLimitePlan()`.

## Verificación

Suite completa corrida después del cambio: **112 archivos / 1592 tests,
sin regresiones** (subió de 111/1582 tras el lote de `stock.js`).

## Pendiente

Candidatos para la próxima pasada: `pedidos.js` (19 call sites),
`proveedores.js` (20) — mismo patrón de siempre (`bloqueado` para
"no hay suficiente stock/saldo/crédito", `faltaDato` para "falta un dato
concreto"). Sigue pendiente también el checklist de verificación manual
de Fase 1.
