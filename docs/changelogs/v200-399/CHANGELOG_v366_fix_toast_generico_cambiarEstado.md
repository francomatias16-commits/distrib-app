# v366 — Fix: toast genérico "Ocurrió un error" en cambiarEstado()

## Contexto
El error persistía en producción (todos los estados: pendiente, confirmado,
preparando, etc.) incluso después de un fix previo que envolvía las llamadas
RPC de `cambiarEstado()` en try/catch. Ese fix era correcto pero no cubría
todo el flujo: el estado se guardaba bien en la DB, y el error visible al
usuario venía de otro lado.

## Diagnóstico
En `cambiarEstado()` (frontend/admin/js/pedidos.js), el tramo posterior al
cambio de estado exitoso — actualizar la fila local, registrar auditoría,
mostrar el toast de éxito, armar y disparar la notificación de WhatsApp —
quedaba **fuera** del try/catch existente. Cualquier excepción ahí (por
ejemplo, un elemento del DOM ausente en cierta vista, o un dato inesperado
en `WA_TEMPLATE`) se escapaba de `cambiarEstado()` sin capturar, subía hasta
el catch genérico de `btnAsyncClick` (en ui-utils.js) y mostraba
"Ocurrió un error. Intentá de nuevo." — dando a entender que el cambio de
estado había fallado, cuando en realidad ya estaba guardado en la DB.

De forma relacionada, `cargarPedidos()` (disparada por `aplicarFiltros()`,
sin `await` en `cambiarEstado()`) accedía directo a
`document.getElementById('topbar-contador').textContent` sin verificar que
el elemento existiera, y usaba `Promise.all` (que rechaza entero ante
cualquier excepción real de una de las dos llamadas) en vez de
`Promise.allSettled`.

## Cambios
- `cambiarEstado()`: el post-proceso (fila local, auditoría, toast, WhatsApp)
  ahora tiene su propio try/catch. Si algo falla ahí, el mensaje ahora es
  "El pedido se actualizó, pero hubo un problema al refrescar la pantalla.
  Recargá si no ves el cambio." — y el error real queda logueado en consola
  con el prefijo `[pedidos] Error en post-proceso de cambiarEstado`.
- `aplicarFiltros()` dentro de `cambiarEstado()` ahora loguea su propio error
  si falla (antes era fire-and-forget sin ningún `.catch`).
- `cargarPedidos()`: `Promise.all` → `Promise.allSettled`, ninguna de las dos
  llamadas RPC puede escapar sin capturar.
- `cargarPedidos()`: null-check en `topbar-contador` antes de escribir
  `.textContent`.

## Cómo verificar
1. Reproducir la acción que antes daba el toast genérico con la consola del
   navegador abierta.
2. Si vuelve a fallar, el log de consola ahora debería señalar exactamente
   en qué línea/función ocurre — ya no debería aparecer como excepción
   silenciosa o genérica.
