# v523 — Nueva tool `crear\_cliente` (faltaba conectarla)

## Reportado

Probando el flujo de imagen (foto de pedido → `crear\_pedido`), el cliente
"Rotisería La Esquina" no existía en el sistema. El asistente respondió
correctamente que no encontraba un cliente parecido y pidió aclarar el
dato — pero cuando el usuario le pidió directamente "créame un cliente
rotisería de la esquina por favor", contestó: "En este momento no
dispongo de una herramienta para crear clientes nuevos".

Duda del usuario: ¿no se había hecho ese trabajo?

## Diagnóstico

Se recorrió el catálogo completo de tools (68 en ese momento) y se
confirmó: **no existía ningún `crear\_cliente`**. Sí existe `crear\_proveedor`
(para altas de proveedor) — el asistente no estaba mintiendo ni fallando,
la tool genuinamente nunca se construyó para este caso.

Pero la funcionalidad de fondo SÍ existe en el sistema: `crearCliente()`
en `lib/repos/clientes.js` es la misma función que usa `POST /api/clientes`
(la pantalla normal de alta de clientes), con el chequeo de
`exigirLimitePlan()` (cupo de clientes del plaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxvbfgffgfffn contratado) ya incluido.
Solo faltaba conectarla como tool del asistente.

## Cambios

### `lib/asistente-tools.js`

* Nuevo import: `crearCliente` de `lib/repos/clientes.js` (renombrado
`crearClienteRepo` para no pisar el nombre de la tool).
* Nueva tool `crear\_cliente`, calcada del patrón de `crear\_proveedor`:

  * `roles: \['dueno', 'admin']`, `requiereConfirmacion: true` (igual que
todas las tools de escritura).
  * Campos: `razon\_social` (obligatorio), `nombre\_fantasia`, `cuit`,
`condicion\_iva` (default `consumidor\_final`, igual que la tabla),
`telefono`, `email`, `domicilio`, `localidad`, `notas`. Mismos campos
que expone el formulario normal de alta, sin incluir los operativos
más sensibles (`zona\_id`, `lista\_precio\_id`, `limite\_credito`,
`dias\_credito`) — mismo criterio que ya usa `crear\_proveedor` con sus
propios campos operativos.
  * A diferencia de `crear\_proveedor` (que inserta directo contra `db`),
`crear\_cliente` reusa `crearCliente()` del repo en vez de reimplementar
el insert — así el chequeo de límite de plan no queda duplicado ni
puede desincronizarse del que ya usa la pantalla normal.
  * Si `exigirLimitePlan()` corta por `LIMITE\_PLAN\_ALCANZADO`, se traduce
a un mensaje legible para el usuario en vez de mostrar el código
interno.
* Nueva función `buscarClienteExistente()`, calcada de
`buscarProveedorExistente()`: dedupe por CUIT exacto primero, si no por
ILIKE exacto de razón social — mismo motivo por el que no se reusa
`buscarClientePorTexto()` (esa tira error ante ambigüedad; acá alcanza
con saber si YA existe alguno, sin bloquear por ambigüedad).

## Cómo queda

El catálogo pasa de 68 a **69 tools**. Ahora, si el asistente lee una foto
de pedido y no encuentra el cliente, puede ofrecer directamente crearlo
(con confirmación del usuario) en vez de derivarlo a un administrador.

## Archivos modificados

* `lib/asistente-tools.js`

