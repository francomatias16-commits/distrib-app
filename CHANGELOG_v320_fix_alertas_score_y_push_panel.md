# CHANGELOG v320 — Fix alertas Motor 5 (Score) + push del panel de automatización

Origen: diagnóstico SQL corrido en vivo contra Supabase (`jgiquzjwoedmzwqgzubr`),
ver `diagnostico_alertas_criterios_notif_eventos_v319.sql`.

## 1. `lib/handlers/automatizacion.js` — `getEstadoScore()`

**Bug:** filtraba `score_categoria` contra `'critico' | 'en_riesgo' | 'saludable' | 'excelente'`,
valores que `calcular_score_cliente()` (la función real que corre en la DB) **nunca** escribe.
Su dominio real es `premium | bueno | normal | riesgo | bloqueado`. Resultado: el Motor 5 del
panel siempre mostraba `alertas_activas: 0` y las 3 barras del gráfico en cero, sin importar
cuántos clientes reales estuvieran en `riesgo` o `bloqueado`.

**Fix:** se mapean los valores reales a los mismos 3 buckets que ya consume el frontend
(no hizo falta tocar el JS del cliente):
- `bloqueado` → `criticos`
- `riesgo` → `enRiesgo`
- `normal`, `bueno`, `premium` → `saludables`

## 2. `frontend/admin/css/automatizacion.css` — clases `.score-*`

**Bug:** el pill de "peores clientes" usa `score-${c.categoria}` con la categoría REAL del
cliente (`riesgo`, `bloqueado`, etc.), pero `automatizacion.css` sólo definía clases para los
valores ficticios (`score-critico`, `score-en_riesgo`, `score-saludable`, `score-excelente`).
Como `automatizacion.html` tampoco carga `clientes.css` (que sí tiene las clases correctas),
el pill quedaba sin color/estilo.

**Fix:** se reemplazan por las clases reales (`score-premium/bueno/normal/riesgo/bloqueado`),
mismo esquema de color que `clientes.css` para consistencia visual en toda la app. Se agregan
además `score-A/B/C/D` (estilo neutro, borde punteado) para los ~1580 clientes con categorías
legacy que el cron de recálculo todavía no procesó — no bug de código, pero sin esto quedaban
sin ningún estilo.

## 3. `lib/handlers/automatizacion.js` — `push-suscribir` / `push-cancelar`

**Bug:** la suscripción Web Push (VAPID) del navegador se guardaba con
`token_push: endpoint` (upsert con `onConflict: 'token_push'`). Pero el motor que efectivamente
envía las 6 alertas del panel, `_auto-push.js`, lee
`select('endpoint, p256dh, auth')` — columna `endpoint`, que quedaba `NULL` para estas
suscripciones. `webpush.sendNotification({ endpoint: null, ... })` fallaba en silencio
(capturado por el try/catch) y la notificación nunca llegaba.

**Fix:** se guarda en la columna `endpoint` (ya existe índice único
`idx_dispositivos_push_endpoint` desde `053_fix_sincronizacion_v54.sql`, así que
`onConflict` pasa a `'endpoint'`). `push-cancelar` también se actualizó para dar de baja
por `endpoint` en vez de `token_push`.

Confirmado que el flujo de FCM/app móvil (`lib/handlers/notif.js` → `registrarDispositivo`/
`_push.js` → `enviarPush`) es un sistema aparte que sí usa `token_push` correctamente — no
se tocó.

## Estado en producción al momento del diagnóstico (13/07/2026)

- 0 clientes en `riesgo`/`bloqueado` todavía (bug latente, no manifestado en el panel hoy).
- 0 dispositivos push registrados (bug latente, nadie activó push desde el panel todavía).
- Por eso ninguno de los 3 bugs generó un incidente visible hasta ahora — pero estaban listos
  para fallar en el momento en que hubiera datos.

## Pendiente / no incluido en este fix

- Migrar los ~1582 clientes con `score_categoria` en `A/B/C/D` (legacy) — se van resolviendo
  solos a medida que corre el cron de `calcular_score_cliente`, no requiere acción a menos que
  quieras forzar un recálculo masivo.

## 4. Migración `317_fix_check_score_categoria.sql` (aplicada en producción)

Los 3 bugs de arriba son 100% JS/CSS — no necesitaban migración. Pero al diagnosticar se
encontró que el `CHECK` constraint de `clientes.score_categoria` (definido originalmente en
`036_score_cliente.sql`) **no existe hoy en producción** — probablemente porque
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` no reaplica el `CHECK` si la columna ya existía en
una corrida anterior de la migración. Esa falta de blindaje es justamente lo que permitió que
~1580 clientes quedaran con categorías legacy `A/B/C/D` sin que nada lo detectara.

Se restauró el constraint con `NOT VALID`:

```sql
ALTER TABLE public.clientes
  ADD CONSTRAINT chk_score_categoria
  CHECK (score_categoria IS NULL OR score_categoria IN ('premium','bueno','normal','riesgo','bloqueado'))
  NOT VALID;
```

`NOT VALID` valida todo INSERT/UPDATE **nuevo** desde ya, pero no rompe con las filas legacy
existentes. Cuando el cron termine de reprocesar a los clientes con letras A-D, se puede correr:

```sql
ALTER TABLE public.clientes VALIDATE CONSTRAINT chk_score_categoria;
```

Ya aplicada en producción (`jgiquzjwoedmzwqgzubr`) y verificada con `pg_constraint`.
