# v1060 — Cierre de Fase 2, PLAN_CLIENTES_EN_FUGA.md

Continuación de la sesión anterior (cortada por límite de herramientas a mitad de
la validación de Fase 2). Se retomó desde los archivos sueltos que esa sesión ya
había dejado listos (`notif.js`, `vercel.json`, `eventos-dispatcher.js`,
`reglas-automatizacion.js` handler, `cliente_en_riesgo_fuga.js`) más el estado real
de producción (proyecto `jgiquzjwoedmzwqgzubr`), y se cerró lo que faltaba.

## Lo que faltaba y se completó ahora

- **`lib/repos/clientes-fuga.js` (nuevo)** — no existía como archivo; lo importaba
  `cliente_en_riesgo_fuga.js` pero nunca se había escrito. Contiene
  `resolverClienteParaFuga`, `resolverUmbralClienteGrande` (lee
  `empresas.config->>'fuga_umbral_cliente_grande'`, default $600.000/año) y
  `crearTareaFuga` (inserta en `tareas_automatizacion` con `usuario_id` + roles
  `['dueno','admin']` de respaldo).
- **`lib/repos/reglas-automatizacion.js`** — `listarTareasAutomatizacion` no
  soportaba el 3er parámetro (`usuarioId`) que el handler ya le pasaba desde la
  sesión anterior; se lo agregué (`.or(roles.cs.{rol},usuario_id.eq.…)`) para que
  el vendedor vea en su panel las tareas dirigidas a él, no solo las de su rol.
  También agregué `cliente_en_riesgo_fuga` a `EVENTOS_DISPONIBLES` (catálogo de
  eventos para reglas de usuario en `automatizacion.html`).
- **Migraciones 592 y 593** — estaban aplicadas en producción (confirmado contra
  `schema_migrations_registry`) pero no existían como archivo en el repo (mismo
  problema ya señalado para 590/591, no bloqueante). Se reconstruyeron 1:1 contra
  la definición real (`pg_get_functiondef` / `pg_get_constraintdef`) para que el
  repo quede sincronizado con producción. **Pendiente, no bloqueante:** 590 y 591
  siguen sin archivo — mismo criterio que ya se venía arrastrando.
- Sincronizados al repo los archivos que la sesión anterior ya había dejado
  validados con `node --check`: `lib/handlers/notif.js`, `lib/eventos-dispatcher.js`,
  `lib/handlers/reglas-automatizacion.js`, `lib/eventos-listeners/cliente_en_riesgo_fuga.js`,
  `vercel.json`.

## Validación hecha en esta sesión

- `node --check` OK en los 6 archivos JS tocados/nuevos + `vercel.json` parseable.
- Confirmado el cron: `vercel.json` tiene `/api/notif/clientes-en-fuga` (08:15 diario)
  → rewrite a `_mod=notif&_svc=fuga-cron`.
- **Detección SQL contra datos reales** (Distribuidora del Litoral, tenant demo):
  insertado un ciclo de compra de prueba vencido para "Rotisería Duarte" (score
  `bloqueado`) y confirmado que `fn_clientes_en_fuga` lo devuelve con
  `motivo_probable: 'posible_freno_por_deuda'` y `telefono` presente (valida 591 y
  592 juntos). Fila de prueba borrada después de confirmar.
- **Las 3 ramas de decisión del listener**, probadas con mocks (sin tocar la base
  real ni mandar WhatsApp real):
  1. Deuda → tarea "Cobrar a…" ✅
  2. Cliente grande ($850.000/año) + fuga real → tarea al vendedor ("Llamar a…") ✅
  3. Cliente chico ($45.000/año) + fuga real → intenta WhatsApp automático ✅
  4. Cliente sin teléfono en camino 3 → tira error (no crea tarea, no manda nada) ✅

## Lo que sigue sin hacer (a propósito, no se tocó en esta sesión)

- **No se corrió el pipeline completo contra WhatsApp real** — `handleFugaCron`
  excluye tenants demo (`excluirDemo: true`), así que Distribuidora del Litoral
  nunca dispara el cron real igual; y forzar un envío real de prueba manda un
  WhatsApp a un teléfono real de un cliente de prueba, que no corresponde hacer
  sin que Matías lo decida a propósito (con un número de prueba propio, o el
  template `recuperacion_cliente` ya dado de alta en Meta Business Manager — sigue
  pendiente, mismo estado que dejó la sesión anterior).
- Fase 3 (pantalla) — según el propio plan, es lo último porque necesita datos
  reales circulando primero.
