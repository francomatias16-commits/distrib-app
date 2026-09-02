# v367 — Fix DEFINITIVO: "Ocurrió un error" en cambiarEstado() (y afines)

## Causa raíz real (confirmada en producción)
Gracias al logging agregado en v366, la consola mostró el error exacto:

```
TypeError: window.supabaseClient.rpc(...).catch is not a function
    at cambiarEstado (pedidos.js:994)
```

`.rpc()` de supabase-js devuelve un objeto "thenable" (solo implementa
`.then()`), **no un `Promise` completo** — no tiene método `.catch()` propio
en esta versión del cliente. El código:

```js
window.supabaseClient.rpc('registrar_auditoria', {...}).catch(e => ...);
```

tira un `TypeError` **síncrono** apenas se ejecuta esa línea, porque
`.catch` no existe en ese objeto. Como `registrar_auditoria()` se llama en
**every** cambio de estado exitoso (confirmar, preparar, despachar,
entregar, cancelar), esto explica por qué el toast genérico aparecía en
absolutamente todas las transiciones por igual.

Se confirmó con los logs de Supabase que el estado SÍ se guardaba
correctamente en la base en cada caso — el error era puramente del cliente,
posterior al guardado exitoso.

## Cambios
- `frontend/admin/js/pedidos.js`: `registrar_auditoria(...).catch(...)` →
  `.then(onFulfilled, onRejected)` (compatible con el objeto "thenable").
- `frontend/admin/js/facturacion.js`: mismo patrón corregido en 2 lugares
  (reintento de factura, anulación de comprobante).
- `frontend/admin/js/cta-cte.js`: mismo patrón corregido (registro de
  cobro) — acá el error quedaba atrapado por un catch exterior, pero
  mostraba "no se pudo registrar el cobro" cuando el cobro sí se guardaba.

## Nota para el futuro
Cualquier lugar del código que haga `supabaseClient.rpc(...).catch(...)`
o `.finally(...)` directo (sin `await` ni `.then()`) tiene este mismo riesgo.
Usar siempre `await` + try/catch, o `.then(onFulfilled, onRejected)`.
