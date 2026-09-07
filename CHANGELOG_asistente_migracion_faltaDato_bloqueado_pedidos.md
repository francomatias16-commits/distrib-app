# Migración de tools a faltaDato/bloqueado — tercer lote (pedidos.js)

## Qué se migró

A diferencia de los lotes anteriores, acá el cambio no fue en
`lib/asistente-tools/pedidos.js` sino en **dos resolvers compartidos de
`lib/asistente-tools/_helpers.js`**, usados por las tools de este archivo:

- **`buscarPedidoSugeridoPropio`** (usada por `confirmar_pedido_sugerido`
  y `descartar_pedido_sugerido`): "Falta la referencia del pedido
  sugerido" pasó a `faltaDato('la referencia del pedido sugerido')`; "Ese
  pedido está en estado X, no sugerido" pasó a
  `bloqueado('Ese pedido está en estado "X", no "sugerido".', 'No se
  puede confirmar ni descartar con esta herramienta.')`. Esta función
  devuelve `{ error: <string> }` en vez de tirar (los call sites en
  `pedidos.js` hacen `if (pedido.error) throw new Error(pedido.error)`),
  así que se migró extrayendo `.message` de `faltaDato()`/`bloqueado()`
  — el `Error` que llega al usuario sigue siendo genérico (sin
  `.opciones`), pero con el mismo texto que producen esas funciones.

- **`buscarPedidoBorradorPorTexto`** (usada por
  `modificar_pedido_no_confirmado`): mismo criterio, pero esta función SÍ
  tira directo, así que acá se tira `faltaDato()`/`bloqueado()` sin
  envolver — "Falta la referencia del pedido." → `faltaDato('la
  referencia del pedido')`; "Ese pedido está en estado X, no en
  borrador..." → `bloqueado(...)`.

Nota de wording: al migrar a `bloqueado(motivo, salida)` el separador
pasó de un guion largo ("— no se puede...") a punto y mayúscula ("...no
se puede confirmar..." → "... . No se puede confirmar..."), porque
`bloqueado()` concatena `motivo + ' ' + salida`. No había tests que
asertaran la redacción anterior, así que no hubo wording a preservar.

## Qué NO se migró (a propósito)

- Los otros dos casos de esos mismos dos resolvers: "no se encontró
  ningún pedido con esa referencia" y "esa referencia coincide con más
  de un pedido". Ninguno encaja limpio en el contrato de 3 tipos: el
  usuario SÍ dio una referencia (no es `faltaDato`), y no es una regla de
  negocio bloqueando una acción válida (no es `bloqueado`) — es
  simplemente que la búsqueda no encontró o no distinguió un candidato.
  Mismo criterio de restricción que dejó `crear_producto`/
  `editar_producto` sin migrar en el lote de `stock.js`.
- **`crear_pedido` / `crear_presupuesto` / `registrar_devolucion_pedido`**:
  los `if (!resultado.ok) throw new Error(resultado.error)` de estas
  tools reenvían el `error` de handlers **compartidos con el portal HTTP
  del cliente** (`lib/handlers/pedidos/crear-pedido.js`,
  `presupuestos.js`, y `crearDevolucionCore` — este último el handler del
  hallazgo #0, ~$9.86M, con controles v805). No son mensajes de autoría
  de las tools del asistente: forzarlos al molde de `faltaDato`/
  `bloqueado` implicaría adivinar el tipo por el contenido del string
  (¿"Stock insuficiente" es bloqueado? ¿"Cliente no encontrado" es
  faltaDato?) sin tocar el handler compartido, con el riesgo de que un
  cambio de wording ahí desalinee la clasificación acá. Se deja fuera de
  esta migración incremental — si se llega a tocar `crear-pedido.js` por
  otro motivo, ahí se puede evaluar migrar el handler compartido mismo
  (no solo el call site del asistente).
- `contar_pedidos_pendientes`, `listar_pedidos_pendientes`,
  `diagnosticar_pedido`, `diagnosticar_presupuesto`,
  `consultar_pedidos_sugeridos_piloto`, `generar_sugerencias_piloto`,
  `confirmar_pedido_sugerido`/`descartar_pedido_sugerido`/
  `modificar_pedido_no_confirmado` (sus wrappers de error de DB propios,
  distintos del resolver), `cancelar_pedido_asistente`: wrappers de error
  de DB (`\`${tool}: ${error.message}\``), sin tocar.

## Test agregado

`tests/asistente/pedidos-formato-error.test.js` (6 tests) — cubre:

- `confirmar_pedido_sugerido` / `descartar_pedido_sugerido`,
  parametrizados con `describe.each` (comparten el mismo resolver): sin
  referencia → `faltaDato`, sin `.opciones`, sin llamar a `db.rpc`;
  pedido en estado distinto de "sugerido" → `bloqueado` citando el
  estado real.
- `modificar_pedido_no_confirmado`: sin referencia de pedido →
  `faltaDato`, sin tocar la DB; pedido ya confirmado (no en borrador) →
  `bloqueado` explicando por qué no se puede tocar.

Mismo patrón de mock que los lotes anteriores (`lib/repos/_db.js`
mockeado, resolvers reales de `_helpers.js` sin mockear).

## Verificación

Suite completa corrida después del cambio: **113 archivos / 1598 tests,
sin regresiones** (subió de 112/1592 tras el lote de `clientes.js`).

## Pendiente

Candidato para la próxima pasada: `proveedores.js` (20 call sites).
Sigue pendiente también el checklist de verificación manual de Fase 1.
