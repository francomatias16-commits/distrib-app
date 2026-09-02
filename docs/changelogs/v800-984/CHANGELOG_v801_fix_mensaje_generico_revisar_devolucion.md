# v801 — Fix: "No se pudo registrar la revisión. Probá de nuevo." tapaba el error real

## Problema
Al aprobar/rechazar una devolución, si algo fallaba, siempre aparecía
el mismo texto genérico sin ninguna pista de qué pasó — ni el motivo
(ej. sin permisos, error de validación) ni forma de rastrearlo en el
servidor.

## Causa raíz
El `catch` de `revisarDevolucion()` (panel de detalle) pisaba
**siempre** el error real con un string fijo, descartando:
- el mensaje público que el backend ya arma correctamente para estos
  casos (`data.error` — por ejemplo "Sin permiso para revisar
  devoluciones", o el mensaje genérico controlado de `errorSeguro`),
- el `correlation_id` que `errorSeguro` genera justamente para poder
  cruzar el error con los logs del servidor cuando el mensaje público
  es a propósito genérico (para no filtrar detalle interno).

El alta manual (`guardarNuevaDevolucion`) ya mostraba el error
específico — solo faltaba aplicar el mismo criterio acá.

## Fix
`frontend/admin/js/devoluciones.js` → `revisarDevolucion()`:
- Ahora se muestra el `data.error` real que devuelve el backend.
- Si el backend respondió con `correlation_id` (caso de error
  genérico/500 vía `errorSeguro`), se agrega al toast como
  "(código: xxxxxxxx)" — permite pedir soporte/revisar logs del
  servidor con ese código puntual en vez de "probá de nuevo".
- Si la respuesta ni siquiera fue JSON válido (caída del servidor,
  problema de red), se distingue con un mensaje de conexión en vez
  del genérico de validación.

No se tocó la lógica de aprobar/rechazar en sí — solo cómo se informa
el error cuando falla.
