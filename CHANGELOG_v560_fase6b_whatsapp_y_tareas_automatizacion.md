# v560 — Fase 6b: acciones "enviar_whatsapp" y "crear_tarea" para reglas de automatización

Continúa v559 (Fase 6: `reglas_automatizacion`, motor con un solo tipo de
acción soportado — `notificar_push`). Esta entrega cierra los puntos que
habían quedado pendientes:

1. Routing de tareas en el handler (`_svc=tareas` / `_svc=tareas-completar`).
2. Constructor de condición compuesta (y/o) en la UI.
3. Selector de tipo de acción (push / WhatsApp / tarea) en el modal.
4. Tests nuevos del motor.
5. Migración 433 y este changelog.

## Backend

- **Migración `433_fase6b_tareas_automatizacion.sql`** (aplicada en
  producción, proyecto `jgiquzjwoedmzwqgzubr`): tabla
  `tareas_automatizacion` (`empresa_id`, `regla_id`, `evento_disparador`,
  `titulo`, `descripcion`, `roles` text[], `estado`, `completada_por`,
  `completada_en`), índices `(empresa_id, estado, created_at)` y GIN sobre
  `roles`. RLS **más permisiva que `reglas_automatizacion`**: cualquier
  rol interno al que la tarea le fue asignada puede verla/completarla, no
  solo dueño/admin (dueño/admin siempre ven todo). Trigger de
  `updated_at` reutilizando `tg_precios_clientes_updated_at` — se agregó
  la columna `updated_at` a la tabla porque esa función genérica la
  necesita (no la tienen todas las tablas del sistema).

- **`lib/reglas-automatizacion.js`** — `ejecutarAccion()` ahora soporta
  los tres tipos:
  - `enviar_whatsapp`: resuelve teléfono y nombre desde
    `payload.cliente_id` (nunca desde un teléfono que venga suelto en el
    payload del evento) y reusa el endpoint interno
    `/api/notif?tipo=whatsapp` en vez de reimplementar la llamada a la
    Graph API — así la regla hereda gratis el modo demo, el corte de
    costos por empresa, la resolución de credenciales propias vs. número
    compartido, y el reintento de formato "9" en AR que ya tiene ese
    handler. Fail-closed: template no reconocido, sin `cliente_id`, o
    cliente sin teléfono cargado → error explícito, no intenta mandar
    nada. `TEMPLATES_WHATSAPP_DISPONIBLES` (10 templates ya aprobados en
    Meta, mismos que usa el resto del sistema).
  - `crear_tarea`: inserta en `tareas_automatizacion` con los roles de la
    regla (default dueño/admin) y el origen (`regla_id`,
    `evento_disparador`). Fail-closed sin `titulo`.

- **`lib/repos/reglas-automatizacion.js`** — `TIPOS_ACCION_SOPORTADOS`
  ahora incluye los tres tipos, con su validación al guardar la regla
  (`validarCampos`: WhatsApp exige template válido, tarea exige título).
  Nuevas funciones `listarTareasAutomatizacion(empresa_id, rol)` (filtra
  por `.contains('roles', [rol])`) y
  `completarTareaAutomatizacion(empresa_id, id, usuarioId)`.

- **`lib/handlers/reglas-automatizacion.js`** — nuevas rutas `_svc=tareas`
  (GET, lista las tareas pendientes del rol del usuario) y
  `_svc=tareas-completar` (POST `{id}`), resueltas **antes** del gate
  dueño/admin del resto del handler — usan `ROLES_TAREAS = ['dueno',
  'admin', 'vendedor', 'depositero', 'contador']` (cualquier rol interno
  con acceso al panel admin; el portal cliente y el portal chofer no
  entran, tienen su propia auth).

- **Tests**: `tests/handlers/reglas-automatizacion.test.js` reescrito con
  19 tests (evaluación de condiciones + `obtenerReglasActivas` sin
  cambios, `ejecutarAccion` con los tres tipos de acción, mocks nuevos
  para `clientes` y `tareas_automatizacion`, `fetch` stubbeado para
  WhatsApp). Suite completa: **102/102 tests pasando**, sin regresión en
  `eventos-dispatcher.test.js` ni en el resto de los handlers.

## Frontend

- **`automatizacion.html`** — selector de tipo de acción (push /
  WhatsApp / tarea) con campos condicionales por tipo; constructor de
  condición compuesta (y/o) con filas repetibles; nueva sección "Tareas"
  debajo de "Reglas personalizadas" con su propia tabla.
- **`automatizacion.js`** —
  - `leerCondicionRegla()` / `cargarCondicionEnForm()`: arman/leen
    `{y:[...]}` u `{o:[...]}` desde filas repetibles en vez de una sola
    condición simple.
  - `cambiarTipoAccionRegla()`: muestra/oculta los campos según
    `notificar_push` / `enviar_whatsapp` / `crear_tarea`.
  - `describirCondicion()` / `describirAccion()`: soportan y/o y los tres
    tipos de acción en la tabla de reglas.
  - **Sección Tareas (nueva en esta entrega — quedaba pendiente):**
    `cargarTareasAuto()`, `renderTareasAuto()`, `completarTareaAuto(id)`
    contra `/api/reglas-automatizacion?_svc=tareas` /
    `?_svc=tareas-completar`. Se dispara desde `iniciar()` junto con
    `cargarReglasAuto()`, fail-quiet si el rol no tiene acceso.

## Próximo paso

- Cron de barrido para eventos en estado `error`/`pendiente` viejos
  (sigue pendiente de una entrega anterior a Fase 6).
- Filtro/orden en la tabla de "Tareas" si crecen en volumen (hoy trae
  hasta 200 sin paginación de UI, mismo criterio que reglas).
