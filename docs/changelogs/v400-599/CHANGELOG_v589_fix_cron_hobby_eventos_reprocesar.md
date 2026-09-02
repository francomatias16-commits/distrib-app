# v589 — Fix: cron de reprocesamiento de eventos excedía el límite del plan Hobby

Continuación de `CHANGELOG_v588_fase7_pos_lote4_nucleo_venta.md`.

## El problema

El deploy fallaba, no por un bug de código sino por un límite de plan de
Vercel. `vercel.json` define 11 cron jobs; uno de ellos,
`/api/notif/eventos-reprocesar`, corría con `0 * * * *` (cada hora). Desde
enero 2026 Vercel subió el límite de *cantidad* de crons a 100 por proyecto
en todos los planes, pero el plan Hobby sigue exigiendo que cada cron
individual corra como máximo una vez por día. Ese cron horario cortaba el
deploy antes de llegar a desplegar el resto.

Este cron reprocesa eventos de `eventos_negocio` que quedaron en
`pendiente`/`error` (Fase 3-4 del plan ERP) — bajarle la frecuencia no es
solo cosmético: cambia cuánto tarda el sistema en reintentar una
notificación o un evento fallido.

## Qué se hizo

- **`vercel.json`** — `/api/notif/eventos-reprocesar` pasa de `0 * * * *`
  (cada hora) a `0 3 * * *` (una corrida diaria, 3am), sin colisión con los
  otros 10 schedules del archivo.
- **`lib/handlers/notif.js` (`handleEventosReprocesarCron`)** — el límite de
  eventos despachados por corrida sube de 200 a 500. Con la cadencia horaria
  anterior, 200 alcanzaba porque el backlog entre corridas no debía crecer
  mucho en uso normal. Al pasar a 1 corrida diaria el backlog entre corridas
  puede ser hasta 24x mayor en el peor caso, así que el límite sube en la
  misma proporción. El comentario se actualizó para dejar registrado el
  motivo del cambio y el criterio original: si el límite se satura, sigue
  siendo señal de algo fallando en loop (no una razón para subirlo más sin
  investigar). Si el volumen real de eventos crece de forma sostenida, esto
  necesita revisarse junto con la Fase 8 del plan ERP (observabilidad,
  todavía sin arrancar).

## Testing

- `vercel.json` validado como JSON válido.
- `lib/handlers/notif.js` validado con `node --check`.
- Suite completa: **689/689 tests pasaron** (30 archivos). No hay tests
  unitarios de configuración de cron en sí, pero `notif.js` tiene cobertura
  indirecta y no se rompió nada.

## Archivos tocados

- `vercel.json` (+1/-1)
- `lib/handlers/notif.js` (+15/-7, comentario + límite)
