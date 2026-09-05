# v1064 — Fase A de PLAN_CLIENTES_FUGA_ACCIONES.md: links en "Clientes en fuga"

Primera fase del plan que conecta la pantalla `/admin/clientes-fuga` (Fase 3,
v1061) con funcionalidad que ya existía pero vivía desconectada — sin tocar
backend ni migraciones.

## Cambios

- `frontend/admin/js/clientes-fuga.js` (`renderTablaFuga`):
  - **A1**: la razón social de cada fila ahora es un link a
    `/admin/clientes?id=<cliente_id>` (patrón de deep-link que
    `clientes.js` ya soportaba). Si por algún motivo la fila no trae
    `cliente_id`, cae al `<strong>` plano de antes — no rompe.
  - **A2**: el badge de "Acción ya disparada" pasa a ser un link a
    `/admin/automatizacion#tareas-auto-card` **solo** cuando
    `accion_disparada` es `tarea_pendiente` o `tarea_completada` — ahí es
    donde esa tarea (creada por `crearTareaFuga`, caminos 1/2 del listener)
    ya se puede ver y completar de verdad, vía
    `automatizacion.js`/`_svc=tareas[-completar]`. Para `whatsapp_enviado` y
    `sin_accion` no hay link: no hay nada más para hacer sobre un envío ya
    hecho, y "sin acción" no tiene destino al que mandar a nadie todavía.
- `frontend/admin/clientes-fuga.html`: `<style>` scoped mínimo para que los
  links nuevos hereden el color del texto (sin azul de link por defecto,
  para no competir visualmente con los badges de estado) y solo se
  subrayen al hacer hover.

No hace falta migración ni endpoint nuevo — ambos cambios son 100%
frontend, reusan datos que la fila ya traía (`cliente_id`) y pantallas que
ya existían.

## Validado en esta sesión

- Test nuevo `tests/frontend/clientes-fuga-links.test.js` (7 casos): A1 con
  y sin `cliente_id`, A2 para los 4 valores de `accion_disparada`, y
  regresión de escape de `razon_social` maliciosa (mismo criterio que
  `tests/frontend/cobranzas.test.js`, hallazgo #19) ahora que ese campo
  vive dentro de un `<a>`.
- Suite completa: 100 archivos / 1416 tests, todos verdes
  (`npx vitest run --exclude "**/e2e/**"`).

## Pendiente (no entra en esta fase)

Fase B ("Resolver ahora" — forzar la acción salteando el cooldown de 15
días) y Fase C ("No aplica" — descartar falso positivo) quedan para una
tanda aparte: requieren endpoint nuevo, permiso nuevo en
`permisos-service.js` y tests de backend — ver
`PLAN_CLIENTES_FUGA_ACCIONES.md`.
