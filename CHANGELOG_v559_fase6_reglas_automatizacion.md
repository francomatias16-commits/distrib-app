# v559 — Fase 6: motor de automatización sobre el bus de eventos ("Reglas personalizadas")

Continúa `PLAN_ERP_SINCRONIZACION_2026.md` (fases 1–5 ya en producción:
`eventos_negocio`, listeners fijos, `eventos-dispatcher.js`, RLS). Esta
entrega agrega la Fase 6: reglas de automatización que el propio cliente
arma desde la UI, en paralelo a los 5 listeners de código fijo
(`pedido_creado`, `cliente_en_mora`, `cheques_por_vencer`, etc.).

Idea: **"cuando pase X, si se cumple esta condición, avisame"** — sin
tocar código, desde `automatizacion.html`.

## Backend

- **Migración `432_fase6_reglas_automatizacion.sql`** (aplicada en
  producción, proyecto `jgiquzjwoedmzwqgzubr`): tabla
  `reglas_automatizacion` (`empresa_id`, `nombre`, `evento_disparador`,
  `condicion` jsonb, `accion` jsonb, `activa`), índice
  `(empresa_id, evento_disparador, activa)` para la query caliente del
  despachador, RLS restringida a `dueno`/`admin`, trigger de
  `updated_at` (reutiliza `tg_precios_clientes_updated_at`, mismo patrón
  que `reglas_precio`, migración 243).

- **`lib/reglas-automatizacion.js`** — motor de evaluación/ejecución:
  - `obtenerReglasActivas(empresaId, tipoEvento)`.
  - `evaluarCondicion(condicion, payload)` — soporta comparación simple
    `{campo, operador, valor}` (`=`, `!=`, `>`, `>=`, `<`, `<=`) y
    combinadores `{y:[...]}` / `{o:[...]}`. **Fail-closed**: condición
    mal armada, operador desconocido o campo faltante → no matchea
    nunca (nunca dispara "por las dudas").
  - `ejecutarAccion(accion, payload, evento)` — MVP: un solo tipo,
    `notificar_push` (notifica a los roles indicados, default
    dueño/admin, vía `lib/handlers/_push.js:enviarPush`). Cualquier
    otro tipo tira un error explícito en vez de fallar en silencio.

- **`lib/eventos-dispatcher.js`** — `despacharReglasAutomatizacion()`
  corre siempre (incluso para tipos de evento sin listeners fijos
  migrados), en paralelo a `REGISTRO_LISTENERS`. Deliberadamente **no
  afecta** el estado `procesado`/`error` que `despacharEvento()` deja en
  `eventos_negocio` — eso sigue reflejando solo los listeners fijos, para
  no romper el contrato que ya prueban los tests existentes del
  despachador. Un error leyendo reglas, o una regla individual que
  falla, se loguea y no frena nada más (mismo criterio fire-and-forget
  del resto del bus).

- **`lib/repos/reglas-automatizacion.js`** + **`lib/handlers/reglas-automatizacion.js`**
  — CRUD de administración (listar/crear/editar/activar-desactivar/
  eliminar), mismo patrón que `reglas-precio.js`. Acceso restringido a
  `dueno`/`admin` (igual que las preferencias de push del panel).

- **`api/index.js`** / **`vercel.json`** — nuevo módulo registrado
  (`reglas-automatizacion`) y ruta `/api/reglas-automatizacion(.*)`.

- **Tests**: `tests/handlers/reglas-automatizacion.test.js` (11 tests
  nuevos: evaluación de condiciones, fail-closed, `obtenerReglasActivas`,
  `ejecutarAccion` con roles default/custom, tipo no soportado, acción
  sin `tipo`). Suite completa: **94/94 tests pasando**, sin regresión en
  `eventos-dispatcher.test.js`.

## Frontend

- **`automatizacion.html`** — nueva sección "Reglas personalizadas"
  debajo de la grilla de los 5 motores fijos: tabla con nombre, evento
  disparador, condición (legible), acción y estado (toggle click),
  + modal de alta/edición con:
  - Nombre, evento disparador (select poblado desde la API), activa/no.
  - Constructor de condición simple: campo (texto libre) + operador +
    valor. Vacío = "siempre".
  - Acción (fijo a `notificar_push` en este MVP): título, mensaje, y
    grilla de roles a notificar.
- **`automatizacion.js`** — CRUD completo contra
  `/api/reglas-automatizacion` (`cargarReglasAuto`, `renderReglasAuto`,
  `abrirModalReglaAuto`, `guardarReglaAuto`, `toggleReglaAuto`,
  `eliminarReglaAuto`), sin emojis (SVG line icons, stroke-width 2).
- **`automatizacion.css`** / **`automatizacion-gentelella.css`** —
  estilos base + reskin Gentelella scopeado (`body.dash-automatizacion-gentelella`),
  mismo patrón que `reglas-precio-gentelella.css` (solo tokens `--ge-*`
  existentes, sin inventar valores nuevos).

## Próximo paso

- Cron de barrido para eventos en estado `error`/`pendiente` viejos
  (`despacharPendientes()` ya existe pero todavía no hay ningún cron de
  Vercel llamándolo — queda pendiente de una entrega anterior).
- Tipos de acción adicionales para las reglas personalizadas
  (`enviar_whatsapp`, `crear_tarea`, etc.) — hoy `ejecutarAccion()` tira
  error explícito ante cualquier tipo que no sea `notificar_push`.
- Constructor de condición compuesta (`y`/`o`) en la UI — el motor ya lo
  soporta (`evaluarCondicion`), la UI de `automatizacion.html` por ahora
  solo arma condiciones simples de un campo.
