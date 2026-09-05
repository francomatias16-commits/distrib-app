# Plan — Acciones sobre "Clientes en fuga" (`frontend/admin/clientes-fuga.html`)

Continuación de PLAN_CLIENTES_EN_FUGA.md (Fases 1-4, ya cerradas — ver
`docs/changelogs/v1000-1099/CHANGELOG_v1060_fase2_clientes_en_fuga_cierre.md`,
`CHANGELOG_v1061_fase3_clientes_en_fuga_pantalla.md` y
`CHANGELOG_v1062_fix_cooldown_fuga_tareas_automatizacion.md`).

## Diagnóstico

La pantalla hoy es de **solo lectura**: lista clientes que rompieron su
ritmo de compra, con un badge de estado (`sin_accion` / `tarea_pendiente` /
`tarea_completada` / `whatsapp_enviado`) resuelto por `listarClientesEnFuga`
(`lib/repos/clientes-fuga.js`) contra `tareas_automatizacion` y `notif_log`.
No hay ningún `onclick` en las filas ni link a otro lado — parece rota pero
está así por diseño: la única acción real (WhatsApp automático a cliente
chico/mediano, o tarea para el vendedor si es deuda/cliente grande) la
dispara el listener `cliente_en_riesgo_fuga.js` desde el cron diario de las
8:15 (`vercel.json`), no un click acá.

Lo que sí existe pero está desconectado de esta pantalla: cuando el cron
crea una tarea (`crearTareaFuga`), esa tarea **ya se puede ver y completar**
hoy mismo en **Automatización → Tareas**
(`frontend/admin/js/automatizacion.js`, endpoints
`GET/POST /api/reglas-automatizacion?_svc=tareas[-completar]`). El vendedor
no tiene forma de saber, parado en "Clientes en fuga", que esa tarea ya
existe en otro menú.

Conclusión: el trabajo no es inventar acciones nuevas de la nada — es
**conectar lo que ya existe** (Fase A) y agregar las dos cosas que hoy no
tiene ningún lado del sistema: forzar una acción sin esperar el cron
(Fase B) y descartar un falso positivo (Fase C).

---

## Estado general

| # | Frente | Riesgo | Backend nuevo | Estado |
|---|--------|--------|----------------|--------|
| A1 | Nombre de cliente → ficha (`/admin/clientes?id=`) | Bajo | No | ✅ Hecho (v1064) |
| A2 | Badge de tarea → link a Automatización → Tareas | Bajo | No | ✅ Hecho (v1064) |
| B | Botón "Resolver ahora" (fuerza la acción, salteando el cooldown de 15 días) | Medio | Sí — endpoint + permiso nuevo | Pendiente |
| C | Botón "No aplica" (descarta un falso positivo) | Medio | Sí — reusa `tareas_automatizacion`, permiso nuevo | Pendiente |

---

## Fase A — Conectar lo que ya existe

### A1. Nombre del cliente → ficha real

`frontend/admin/js/clientes.js` ya soporta abrir directo un cliente con
`?id=<uuid>` (comentario propio: *"?id=<uuid> abre directo la ficha de ese
cliente"*). Cambio: en `renderTablaFuga()`
(`frontend/admin/js/clientes-fuga.js`), la celda de razón social pasa de
`<strong>` a un `<a href="/admin/clientes?id=${cliente_id}">`.

Sin backend nuevo — el dato (`cliente_id`) ya viaja en cada fila desde
`fn_clientes_en_fuga`.

### A2. Badge de acción → link a Automatización

Cuando `accion_disparada` sea `tarea_pendiente` o `tarea_completada`, el
badge deja de ser texto plano y pasa a ser un link a
`/admin/automatizacion#tareas` (con un `scrollIntoView` a la card de Tareas
al cargar, vía query param o hash). Ahí el vendedor ya puede marcarla
completada con el flujo que existe hace tiempo — no se duplica esa lógica
acá.

Para `whatsapp_enviado` no hace falta link: no hay nada más para hacer
sobre ese envío, solo mostrar la fecha (ya se muestra).

**Sin migraciones, sin endpoints nuevos — solo frontend.**

---

## Fase B — "Resolver ahora" (forzar la acción sin esperar el cron)

Hoy la única forma de que se dispare algo es esperar el cron de las 8:15.
Para un caso que se quiere resolver hoy mismo:

- Nuevo endpoint `POST /api/clientes-fuga?_svc=forzar-accion`, body
  `{ cliente_id }`.
- Internamente **reusa la función del listener**
  (`listenerRecuperacionFuga` en `lib/eventos-listeners/cliente_en_riesgo_fuga.js`)
  contra ese cliente puntual — misma clasificación (deuda → tarea de cobro;
  cliente grande → tarea de llamada; chico/mediano → WhatsApp automático),
  pero **ignora `ultimoAvisoFuga` (cooldown de 15 días) a propósito**: es un
  disparo explícito del usuario, no el barrido automático.
- Nuevo permiso en `lib/permisos-service.js`, scope `clientes_fuga`, acción
  `forzar` — propuesta inicial: `['dueno', 'admin']` (el vendedor ve la
  pantalla pero no dispara él solo una tarea de cobro o un WhatsApp
  automático; se puede sumar `'vendedor'` después si hace falta).
- En la tabla: botón "Resolver ahora" visible solo en filas `sin_accion` y
  solo si `puede(perfil, 'forzar', 'clientes_fuga')`.
- Tests: cubrir los 3 caminos de clasificación reusando los mismos casos que
  ya prueba el listener, más el guard de permiso 403 para rol sin acceso.

---

## Fase C — "No aplica" (descartar un falso positivo)

Para casos donde el cliente rompió el patrón por un motivo legítimo ajeno a
fuga o deuda (vacaciones, problema del proveedor, etc.) y no amerita ni
WhatsApp ni tarea, pero hoy reaparece en `sin_accion` todos los días sin
forma de sacarlo de la lista:

- Nuevo endpoint `POST /api/clientes-fuga?_svc=descartar`, body
  `{ cliente_id, motivo? }`.
- Inserta una fila en `tareas_automatizacion` ya en estado `completada`
  (mismo patrón que `crearTareaFuga`, pero con `estado: 'completada'` desde
  el insert) con `descripcion` = `"Descartado manualmente desde Clientes en
  fuga${motivo ? ': ' + motivo : ''}"`.
- **No hace falta tocar `listarClientesEnFuga`**: ya calcula
  `accion_disparada = 'tarea_completada'` para cualquier fila de
  `tareas_automatizacion` con `estado='completada'` — el descarte se ve
  gratis con la lógica que ya existe.
- Mismo permiso que Fase B (a decidir si comparten la acción `forzar` o se
  suma `descartar` aparte — más prolijo lo segundo, para poder auditar
  distinto quién descarta vs. quién fuerza un WhatsApp/tarea real).
- Botón "No aplica" en la tabla, junto a "Resolver ahora", mismo gate de
  permiso.

---

## Orden sugerido

**Fase A primero.** Es el 80% de la sensación de "esto no hace nada"
resuelta sin backend nuevo, en un par de horas. B y C son funcionalidad real
(permisos + endpoint + tests) para una tanda aparte, una vez validado que A
ya destraba el caso de uso más común (ir a ver/actuar sobre el cliente).
