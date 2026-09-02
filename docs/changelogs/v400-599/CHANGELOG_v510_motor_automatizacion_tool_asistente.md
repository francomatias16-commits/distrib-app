# v510 — Tool de chat `ejecutar_motor_automatizacion`

## Contexto

Continuación de la revisión de `automatizacion.js` para el asistente de chat.
De los 6 endpoints del archivo se descartaron `vapid-key` (público, no aplica),
`push-suscribir`/`push-cancelar` (necesitan datos del navegador, no llegan por
chat) y `push-prefs` (ya cubierto por las tools existentes
`consultar_preferencias_notificaciones` / `actualizar_preferencia_notificacion`,
que apuntan a la misma tabla `notif_prefs_auto`). Quedaba pendiente
`POST ?accion=ejecutar` (disparo manual de un motor), incluido con
confirmación explícita — mismo patrón que `configurar_export_contable`.

## Problema técnico y solución (opción elegida: refactor)

`ejecutarTool()` en `asistente-tools.js` no recibe el request original ni el
Bearer token — solo `empresaId`, `rol`, `usuarioId`, `conversacionId`, `args`.
El endpoint `POST ?accion=ejecutar` original resolvía esto reenviando el
Bearer del usuario en un fetch HTTP interno a cada motor, algo que la tool no
puede replicar.

Se refactorizaron los 4 handlers que todavía no exponían su lógica como
función reusable scopeada por empresa (`cierre.js` ya tenía
`procesarColaFinancieraEmpresa`, agregada en una pasada anterior):

- `lib/handlers/piloto.js` → `generarSugerenciasPilotoEmpresa(empresa_id)`
- `lib/handlers/stock-auto.js` → `analizarYGenerarOrdenes(empresa_id)` (ya
  estaba scopeada por empresa, solo se agregó `export`)
- `lib/handlers/score.js` → `recalcularScoreEmpresa(empresa_id)`
- `lib/handlers/auditoria.js` → `detectarYNotificar(empresa_id, diasLookback, notificar)`
  (ya estaba scopeada, solo se agregó `export`)

En los tres primeros la rama HTTP correspondiente (`POST accion=generar`,
`POST accion=analizar`, `POST accion=recalcular-todos`) quedó llamando a la
misma función exportada — sin duplicar lógica entre el endpoint real y la
tool del asistente.

## Tool nueva

`ejecutar_motor_automatizacion` (única tool, parametrizada por `motor`:
`piloto` | `cierre` | `stock` | `score` | `auditoria`, con
`requiereConfirmacion: true`). El motor `cierre` reusa
`procesarColaFinancieraEmpresa`, la misma función que ya usa la tool
`ejecutar_cierre_financiero_pendiente` — un solo camino a ese código, no dos.

Cada `resumen()` deja explícito el efecto real de ese motor puntual antes de
que el usuario confirme (facturación real contra ARCA/AFIP en el caso de
`cierre`, WhatsApp/push en varios de los otros).

## Archivos modificados

- `lib/handlers/piloto.js`
- `lib/handlers/stock-auto.js`
- `lib/handlers/score.js`
- `lib/handlers/auditoria.js`
- `lib/asistente-tools.js`

## Pendiente / fuera de alcance de esta pasada

- `consultar_estado_automatizacion` (lectura del dashboard de los 6 motores)
  no se implementó — no fue parte de lo pedido en esta pasada. Los
  `getEstado*()` de `automatizacion.js` tampoco están exportados todavía.
