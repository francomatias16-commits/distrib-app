# v809 — Fix: btnAsyncClick pisaba el mensaje real de error en 106 botones del admin

## Síntoma reportado
Al clickear "Generar Comprobante de Venta" en el detalle de un pedido,
apareció el toast genérico "Ocurrió un error. Intentá de nuevo.", sin
ninguna pista de qué falló.

## Causa
`generarFactura()` (pedidos.js) ya tiene su propio try/catch con mensajes
específicos ("Todavía no configuraste la facturación...", "El servidor
respondió con un error (500)...", etc.), así que en circunstancias
normales no debería dejar escapar una excepción sin mensaje útil.

El problema real es más grande: el wrapper universal `btnAsyncClick`
(`ui-utils.js`), usado en **106 botones distintos de todo el panel admin**
(guardar cliente, guardar caja, guardar cheque, registrar pago, etc.),
pisaba SIEMPRE el mensaje real del error con el texto genérico, sin
importar que la función interna hubiera lanzado un `Error` con un mensaje
específico. Cualquier función que no capturara sus propios errores
internamente (muchas simplemente hacen `if (error) throw new
Error(error.message)` y dejan que btnAsyncClick maneje el resto) perdía
toda la información útil para diagnosticar la falla.

Si lo que vio el usuario fue justo este caso (una excepción real escapando
de generarFactura, no contemplada en su try/catch actual), este fix va a
mostrar el mensaje real la próxima vez que ocurra — clave para poder
diagnosticarlo. También es posible que el sitio en producción todavía no
tuviera desplegada la versión más reciente de generarFactura (que ya
había sido reforzada en un fix anterior); igual vale la pena este arreglo
de raíz porque cubre los otros 105 botones también.

## Fix
`frontend/admin/js/ui-utils.js` → `btnAsyncClick`: el catch ahora usa
`err.message` cuando existe y no está vacío; el texto genérico queda solo
como último fallback (para errores sin mensaje real, ej. `throw 'algo'`).

## Archivos modificados
- `frontend/admin/js/ui-utils.js`
