# v220 — Fix botones sin evento + tool de diagnóstico de pedido en el asistente

## 1. Bug: botones sin evento en páginas cargadas como `type="module"`

**Causa raíz:** en un módulo ES6, las funciones top-level declaradas no se
cuelgan automáticamente de `window`. La UI sigue usando `onclick="funcion()"`
inline en el HTML generado, que sí necesita `window.funcion`. El resultado:
click sin efecto y `ReferenceError` silencioso en consola.

**Corregido** (se agregaron las exposiciones a `window` que faltaban):
- `pedidos.js` → `cambiarEstado`, `abrirModalPorId`, `confirmarCancelar`
  (bug original reportado: botón "Iniciar preparación" sin evento)
- `automatizacion.js` → `cargarEstado` (botón "Reintentar")
- `clientes.js` → `enviarEstadoCuenta`
- `stock.js` → `cargarStock` (botón "Reintentar")

Se auditaron todos los HTML del admin que cargan scripts `type="module"`,
cruzando cada `onclick` contra lo expuesto a `window`. Estos son todos los
casos encontrados.

**Nota para el futuro:** este patrón se va a repetir cada vez que se agregue
una función nueva a un archivo-módulo con `onclick` inline, porque depende de
acordarse de exponerla a mano. Migrar a `addEventListener` con delegación de
eventos (data-action + data-id) eliminaría la clase de bug por completo —
no se hizo en esta sesión por ser un refactor más grande, queda pendiente.

## 2. Asistente: umbral de "Fuente" separado del umbral de contexto

`buscar_articulos_asistente` ya filtraba con `match_threshold=0.5`, pero para
un corpus chico y homogéneo (todo habla de "el sistema", "pedidos", "panel")
ese piso lo supera casi cualquier artículo, tenga o no relación real con la
pregunta. Se agregó un umbral separado y más estricto (`0.68`, a calibrar con
casos reales) solo para decidir qué se muestra como "Fuente" al usuario — el
umbral de 0.5 se mantiene para lo que se le pasa al modelo como contexto.

Archivo: `lib/handlers/asistente.js`.

## 3. Nueva tool: `diagnosticar_pedido`

Herramienta de function-calling para el asistente: dado el ID corto de 6
caracteres de un pedido (el que se ve en el panel, ej. "#A1B2C3") o su UUID
completo, devuelve estado del pedido, si tiene factura, estado de esa
factura (emitida/error_afip/pendiente/anulada) con el motivo registrado en
`notas_error`, y si quedó asentada en la cuenta corriente del cliente — más
un resumen en texto plano listo para que el modelo lo use directamente.

- Migración: `supabase/migrations/205_asistente_diagnostico_pedido.sql`
  (aplicada y verificada con `pg_get_functiondef` en producción).
- Catálogo de tools: `lib/asistente-tools.js`.
- Prompt del asistente actualizado para mencionar la nueva capacidad:
  `lib/handlers/asistente.js`.

**Bug encontrado y corregido durante la prueba:** la función tiraba
`record "v_asiento" is not assigned yet` al diagnosticar un pedido sin
factura. Causa: en PL/pgSQL, una variable `RECORD` que nunca ejecutó un
`SELECT INTO` — ni siquiera uno de 0 filas — no se puede leer después. La
consulta de `v_asiento` estaba adentro de un `IF v_factura.id IS NOT NULL`,
así que en el caso "sin factura" nunca corría. Se sacó del `IF`: ahora
siempre se ejecuta (si no hay factura, el `WHERE` no matchea nada y el
record queda en NULL, que sí es un estado válido para leer).

Probado en producción contra 3 casos reales: pedido sin factura, pedido con
factura en estado `pendiente`, y referencia inexistente. Los tres devuelven
lo esperado.

## Pendiente / observado, no tocado en esta sesión

- Se vio una factura de demo con CAE y número asignados pero `estado`
  todavía en `pendiente` — inconsistente con el flujo esperado (CAE debería
  implicar `emitida`). Puede ser solo data de homologación/demo no
  perfectamente prolija; no se investigó más a fondo porque no era el
  objetivo de esta sesión, pero si el asistente da diagnósticos raros en esa
  cuenta puntual, es por esto.
