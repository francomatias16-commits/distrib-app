# v395 — Contador de consultas a Serper visible en el admin

## Motivación
Serper.dev (v394) da 2.500 consultas gratis y después es pago por créditos
prepagos, sin suscripción. Matías planteó la idea de usar varias API keys
para extender el trial gratuito — se descartó por riesgo (viola ToS,
puede bannear las cuentas) y por costo/beneficio (el ahorro es de centavos
frente al tiempo de mantener un sistema de rotación). En cambio, se agrega
algo simple y sin riesgo: un contador interno visible desde el admin, para
que Matías vea de un vistazo cuánto se lleva gastado sin salir de distrib
ni entrar al dashboard de serper.dev.

## Alcance y límites (importante)
Esto **no es el saldo real de la cuenta de Serper** — es un contador propio
que distrib incrementa cada vez que llama a `https://google.serper.dev/images`,
sea cual sea el resultado (match o no). Sirve como referencia rápida, no
como fuente de verdad para facturación: si algún día se factura distinto
(ej. Serper cambia su política de crédito por request fallido) este número
se puede desviar del real. Para el saldo exacto, siempre hay que mirar
serper.dev directamente.

Es un contador **global**, no por empresa/tenant: `SERPER_API_KEY` es una
sola env var compartida por todos los clientes de distrib, así que el gasto
también es compartido.

## Cambios

### Base de datos (`395_contador_uso_serper.sql`)
- Tabla `contador_uso_apis` (`servicio` PK, `usados`, `actualizado_at`) —
  hoy con una sola fila (`serper`), pensada para poder sumar otros
  servicios pagos en el futuro sin cambiar el schema.
- `fn_incrementar_contador_api(p_servicio)`: UPSERT atómico (`usados + 1`),
  necesario porque varios productos del mismo lote llaman a Serper en
  paralelo (`Promise.all`) y un simple `SELECT` + `UPDATE` desde JS tendría
  condición de carrera.

### Backend (`lib/handlers/auto-imagenes.js`)
- Nuevo método `GET /api/auto-imagenes`: devuelve `{ contadorSerper }` sin
  disparar ninguna búsqueda — lo usa el frontend para mostrar el contador
  antes de arrancar una corrida.
- Cada llamada real a Serper (`buscarPorImagenReal`) dispara
  `incrementarContadorSerper()` apenas responde el fetch, sin esperarlo
  (`fire-and-forget`) para no sumar latencia al flujo principal — Serper
  cobra por consulta ejecutada, no por resultado con match.
- La respuesta de `POST /api/auto-imagenes` (cada tanda) ahora incluye
  `contadorSerper: { usados, actualizadoAt }` para que el frontend lo vaya
  actualizando en vivo sin pedirlo aparte.

### Frontend (`frontend/admin/js/productos.js`)
- Antes de abrir el modal de elección (`elegirModoImagenes`), se pide el
  contador actual vía el nuevo `GET` y se muestra como aviso informativo
  arriba de las dos tarjetas ("Consultas a Serper registradas hasta ahora:
  N de las 2.500 gratis iniciales").
- El resumen final (`mostrarResultadoImagenes`) muestra el contador
  actualizado después de la corrida, solo si se usó la Capa 2 (con "solo
  código de barras" no se gastó nada, no tiene sentido mostrarlo).
- Si el `GET` falla (red, permisos), el modal se muestra igual, simplemente
  sin el dato — no bloquea el flujo principal.

## Deploy
```
vercel --prod
```
Corre la migración `395_contador_uso_serper.sql` contra Supabase antes o
después del deploy del frontend/backend — no depende una de la otra (la
tabla nueva no rompe nada si el código viejo todavía no la usa).
