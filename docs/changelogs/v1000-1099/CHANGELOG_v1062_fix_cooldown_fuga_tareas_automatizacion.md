# v1062 — Fix: cooldown de `cliente_en_riesgo_fuga` no cubría tareas de vendedor

Continuación de PLAN_CLIENTES_EN_FUGA.md tras el cierre de Fase 2 (v1060) y
Fase 3 (v1061). Auditoría de checklist del plan (§5): el ítem "el evento
`cliente_en_riesgo_fuga` no dispara dos veces el mismo aviso para el mismo
cliente dentro de una ventana razonable (15 días)" no se cumplía para dos de
los tres caminos del listener.

## Bug encontrado

`handleFugaCron` (`lib/handlers/notif.js`) chequeaba el cooldown con
`ultimoEnvioPorCliente(cliente_id, 'cliente_en_riesgo_fuga')`, que solo lee
`notif_log`. Pero de los tres caminos de
`lib/eventos-listeners/cliente_en_riesgo_fuga.js`, solo el camino 3
(WhatsApp automático a cliente chico/mediano) escribe en `notif_log` — los
caminos 1 (freno por deuda → tarea "cobrar") y 2 (cliente grande → tarea
"llamar") solo insertan en `tareas_automatizacion` vía `crearTareaFuga`.

Resultado real: un cliente grande en fuga, o uno frenado por deuda, nunca
pasaba el chequeo de cooldown — el cron (corre todos los días, `vercel.json`)
volvía a emitir el evento y a crear una tarea nueva para el mismo cliente
cada día que siguiera sin comprar, en vez de una sola vez cada 15 días.

## Fix

- `lib/repos/clientes-fuga.js`: nueva función `ultimoAvisoFuga(clienteId)`
  que toma el máximo `created_at` entre `notif_log`
  (`tipo='cliente_en_riesgo_fuga'`) y `tareas_automatizacion`
  (`evento_disparador='cliente_en_riesgo_fuga'`, filtrado por `cliente_id`,
  columna ya agregada en la migración 594 de Fase 3) — cubre los tres
  caminos del listener con una sola función.
- `lib/handlers/notif.js`: `handleFugaCron` usa `ultimoAvisoFuga` en vez de
  `ultimoEnvioPorCliente` para este cooldown puntual. `ultimoEnvioPorCliente`
  se deja intacto — sigue en uso por `handleDeudaCron`.

No hace falta migración nueva: las columnas que usa la consulta
(`tareas_automatizacion.cliente_id`, `.evento_disparador`, `.created_at`) ya
existen desde las migraciones 433/594, con índice parcial por `cliente_id`.

## Validado en esta sesión

- `node --check` OK en `lib/repos/clientes-fuga.js` y `lib/handlers/notif.js`.
- Revisión manual de los tres caminos del listener contra la nueva función:
  camino 1 y 2 (tarea) y camino 3 (WhatsApp) quedan cubiertos por
  `ultimoAvisoFuga`.
- `npm ci && npm test` corrido completo: **98 test files, 1404 tests, todos
  en verde** (26.5s). No rompe nada existente.

## Lo que sigue sin hacer

- No existen tests dedicados a `handleFugaCron`/`clientes-fuga` todavía
  (mismo gap de cobertura documentado en v1061) — la suite pasa porque
  nada la ejercita, no porque haya cobertura de regresión sobre el fix.
- No se probó en vivo contra el cron real ni contra el tenant de prueba
  ("Distribuidora del Litoral") — pendiente del ítem de la Fase 5 del plan
  ("al menos una sesión de uso real").
