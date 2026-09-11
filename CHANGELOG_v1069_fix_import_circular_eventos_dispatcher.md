# v1069 — fix: import circular entre eventos-dispatcher.js y los listeners

Cierra la investigación que quedó abierta al final de la sesión de v1068
sobre `tests/handlers/cliente-en-mora-listener.test.js` fallando aislado
("preexistente", según se documentó ahí, pero sin causa raíz confirmada
todavía).

## Causa raíz

`lib/eventos-dispatcher.js` importa `listenersClienteEnMora` y
`listenersPedidoCreado` desde sus respectivos módulos de listener para
armar `REGISTRO_LISTENERS`, y de ahí calcula `TIPOS_EVENTO_SIN_LISTENER`
de forma síncrona al importar el módulo (`.filter(...)` a nivel top-level,
no diferido). A su vez, `cliente_en_mora.js` y `pedido_creado.js`
importaban `ErrorEventoNoRecuperable` desde `eventos-dispatcher.js` — un
import circular real.

Ese ciclo nunca se nota en producción porque el código de la app siempre
llega a un listener *a través* del despachador (importa
`eventos-dispatcher.js` primero), y para cuando `eventos-dispatcher.js`
llega a construir `REGISTRO_LISTENERS`, el módulo del listener ya
terminó de ejecutarse. Pero si algo importa un listener **directamente**
primero — como hace el test, a propósito, para no arrastrar el módulo
pesado de `notif.js` — el ciclo se resuelve al revés:
`eventos-dispatcher.js` termina leyendo el export del listener (todavía
en ejecución, circular) antes de que llegue a la línea `export const
listenersClienteEnMora = [...]`, así que en ese punto vale `undefined`.
Ese `undefined` queda congelado dentro de `REGISTRO_LISTENERS` y
`TIPOS_EVENTO_SIN_LISTENER` revienta con `Cannot read properties of
undefined (reading 'length')` apenas se importa el listener aislado —
nada que ver con la lógica del listener en sí, que es justo lo que hacía
difícil de ver la causa mirando solo el archivo del test.

## Fix

Se extrajo `ErrorEventoNoRecuperable` a un módulo nuevo sin imports
propios, `lib/eventos-errores.js`, y tanto `eventos-dispatcher.js` como
los dos listeners (`cliente_en_mora.js`, `pedido_creado.js`) importan la
clase desde ahí — eliminando el ciclo por completo en vez de parchear el
síntoma (por ejemplo, haciendo `TIPOS_EVENTO_SIN_LISTENER` diferido no
alcanzaba: el `REGISTRO_LISTENERS` en sí también queda con la entrada en
`undefined` mientras dure el ciclo, así que cualquier otro consumidor
síncrono del registro tendría el mismo problema). `eventos-dispatcher.js`
sigue re-exportando `ErrorEventoNoRecuperable` para no romper a nadie
más en el repo que la importe desde ahí.

## Verificación

- `cliente-en-mora-listener.test.js` corrido aislado: 5/5 OK (antes:
  0 tests, el archivo ni siquiera terminaba de importarse).
- Suite completa: 1971/1971 tests OK (137/137 archivos) — no quedan
  archivos fallando.
- `check-wiring:all` (asset, api, dispatch) y `check:migrations`: sin
  hallazgos.

## Pendiente

- `pedido_creado.js` tenía el mismo patrón de import circular
  (`ErrorEventoNoRecuperable` desde `eventos-dispatcher.js`) pero nunca
  se manifestó porque ningún test lo importa de forma aislada — se
  corrigió preventivamente en el mismo fix, no porque hubiera un test
  rojo ahí.
- Vale la pena anotar esto en la próxima auditoría de dependencias
  (mencionada ya en `CHANGELOG_v1067`): un módulo con efectos de
  import-time (acá, construir un registro a partir de sus propias
  dependencias) es frágil ante el orden de imports si participa de un
  ciclo, aunque nunca se note en producción porque ahí el orden es
  siempre el mismo.
