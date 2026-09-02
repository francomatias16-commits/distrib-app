# v1044 — Fix de falso "OK" en load-test.js cuando el servidor está caído (2026-08-31)

## Por qué

Corriendo `npm run loadtest` contra un `localhost:3000` sin servidor
levantado, los 9 endpoints mostraron `req/s: 0.0`, `latencia p50/p99:
0ms/0ms` y entre 40.000 y 45.000 "errores" cada uno — y aun así el
script terminó con:

```
[loadtest] OK — sin timeouts, 5xx ni latencias fuera de umbral.
```

Un apagón total (cero requests completados, decenas de miles de
conexiones rechazadas por endpoint) se reportaba exactamente igual que
un resultado perfecto.

## Causa

`resumirResultado()` en `scripts/load-test.js` calculaba `problema`
solo a partir de `timeouts`, `status5xx` y `p99` de latencia — nunca
miraba `r.errors`. `r.errors` es el contador que usa `autocannon` para
fallas a nivel de conexión (`ECONNREFUSED`, `ECONNRESET`, `socket hang
up`), que son distintas de un timeout o de una respuesta 5xx: cuando el
servidor ni siquiera acepta la conexión, no hay código de status que
contar como 5xx, no hay timeout (el rechazo es inmediato, no una espera
que expira) y no hay latencia que medir (no hay ninguna respuesta
completa). El resultado: el peor escenario posible (servidor caído)
quedaba fuera de las tres condiciones que el script sabía chequear.

## Fix

Se agregó `errores > 0` a la condición `problema` en
`resumirResultado()`, y el mensaje de "→ revisar" ahora menciona
explícitamente los errores de conexión (con la sugerencia de revisar
si el servidor está corriendo en `BASE_URL`) cuando corresponde.

## Pendiente

Ninguno. Nota para quien corra el script: el `OK` final ahora sí
implica que hubo requests completados y sin errores — si ves `errores`
> 0 en el detalle de un endpoint, revisar primero que el servidor esté
efectivamente escuchando en `BASE_URL` antes de sospechar de rate
limiting o del handler.
