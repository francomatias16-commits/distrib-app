# v235 — Fixes Etapa 3: Feedback, Estados de Carga y Manejo de Errores de Red

Aplica los hallazgos de `Etapa3_Feedback_Sistema.docx` sobre la base v234
(topbar/reloj/avatar + fixes de Etapa 2). Incluye además un hallazgo nuevo
detectado al verificar el ítem del bell icon contra la base de Supabase real.

## [Crítica] Fallback silencioso a modo demo en Torre de Control, sin indicador visual

`dashboard-control-tower.js` caía a datos ficticios (auth caído, cualquier
fetch fallido vía `pedir()`, o realtime sin cliente/empresaId) sin ninguna
señal en pantalla — un manager podía leer KPIs inventados sin saberlo.

- Nuevo badge persistente **"MODO DEMO — Datos no reales"** en el navbar de
  `dashboard-v2.html`, oculto por defecto.
- `activarModoDemoVisible()` (idempotente) lo activa desde los tres puntos
  de fallback: catch de `authReady`, catch de `pedir()`, y el fallback de
  `iniciarRealtime()` sin `supabaseClient`/`empresaId`.
- Toast de aviso (`ct-toast--error`, nueva variante) la primera vez que se
  activa el modo demo en la carga.
- Logging de errores ahora incluye `code`/`status`, no solo `message`.

## [Alta] Chip de sesión (auth.js) sin feedback de error, sin distinguir causa

`auth.js` trataba error de red transitorio igual que sesión/usuario
inválido: siempre redirigía a `/admin/login` sin parámetro de motivo.

- Se agregó `cargarPerfilConReintento()`: si el error es `PGRST116`
  (0 filas — usuario inexistente/inactivo) no reintenta; cualquier otro
  error (red, timeout, 5xx) se reintenta una vez con un toast
  "No pudimos verificar tu sesión, reintentando…" antes de redirigir.
- El redirect ahora manda `?error=usuario_inactivo` o `?error=red` según
  corresponda, con logging completo (`code`/`message`/`status`).
- `login.html` ahora lee `?error=` (antes se ignoraba por completo) y
  muestra el mensaje correspondiente reutilizando `mostrarError()` ya
  existente. Cubre `usuario_inactivo`, `empresa_inactiva` y `red`.

## [Alta] Topbar excluido del patrón antiSkeletonTimer/retry de los KPIs

El catch de `authReady` en `dashboard-optimizado.js` solo hacía
`console.warn`, sin ningún feedback visible al usuario.

- Reemplazado por `console.error` con detalle completo del error + un
  `window.mostrarToast(...)` visible informando que se está reintentando
  en segundo plano.
- El chip/reloj/avatar del topbar (que dependen 100% de `auth.js` y no
  tienen fetch propio) ahora muestran un **skeleton shimmer** mientras
  `.topbar-usuario` está vacío (`:empty` en `adminlte-components.css`,
  reutilizando el keyframe `skel-shimmer` ya global vía `skeletons.css`,
  cargado en las 34 páginas que usan este chip).

## [Alta] Sistema de toasts triplicado/duplicado

Convivían: la implementación global de `ui-utils.js`
(`window.toast`/`window.mostrarToast`), 12 declaraciones locales que la
sombreaban por orden de carga de script, y el sistema independiente
`ct-toast` de Torre de Control (que se mantiene, es una piel oscura
distinta a propósito).

- Eliminadas las 12 declaraciones locales de `mostrarToast` (patrón A —
  `#toast` fijo: `auditoria.js`, `cheques.js`, `cobranzas.js`, `cta-cte.js`,
  `devoluciones.js`, `liquidacion.js`, `notas.js`, `riesgo-cheques.js`;
  patrón B — `.toast` dinámico: `cc-proveedores.js`, `compras.js`,
  `notas-credito.js`; patrón de 1 argumento: `notif-log.js`). Todas
  cargan `ui-utils.js` antes en su HTML, así que quedan usando el global.
- Eliminado el bridge redundante `window.showToast` en `facturacion.html`.
- `toast()` en `ui-utils.js` ahora normaliza sinónimos de tipo
  (`err`/`error` → `danger`; `ok`/`exito` → `success`; `warn` → `warning`)
  contra los tres modificadores reales de `tokens.css`
  (`.toast--success/--danger/--warning`).
- Los `<div id="toast">` / `.toast` estáticos que quedaron huérfanos en
  los HTML son inofensivos (nunca se les agrega la clase visible).

## [Media] Búsqueda global no diferenciaba 401/429/500

`busqueda-global.js` mostraba el mismo "Error al buscar. Intentá de
nuevo." para cualquier código — en un 429 eso invitaba a reintentar de
inmediato, agravando el rate limit.

- 429 → mensaje de espera + cooldown de 8s antes de permitir otro fetch.
- 401 → mensaje específico de sesión expirada.
- 5xx / error de red → mensajes diferenciados, con `console.error` del
  código real para diagnóstico.

## [Media] `NotifManager` huérfano (`adminlte-ui.js`)

Archivo completo sin ninguna referencia en HTML — código muerto con una
implementación completa de estados que nunca se ejecutaba.

- **Eliminado** `frontend/shared/adminlte-ui.js`.
- Limpiado el comentario en `adminlte-components.css` que lo mencionaba.

## [Media] Preloaders duplicados (3 reimplementaciones)

`dashboard.html`, `dashboard-optimizado.js` y `ocultarPreloaderCt()` en
`dashboard-control-tower.js` reimplementaban el mismo patrón fade+failsafe.

- Nuevo `window.ocultarPreloader(selector, timeoutMs)` único en
  `ui-utils.js`.
- `dashboard-control-tower.js` ahora delega a este helper — para eso se
  agregó `ui-utils.js` a `dashboard-v2.html` (antes no lo cargaba; de
  paso esto también activó los toasts que `pos-offline.js` ya intentaba
  disparar ahí con `window.mostrarToast`, que hasta ahora no existía en
  esa página y fallaba en silencio).

## [Media] Bell icon (`ct-bell`) — hallazgo re-verificado y ampliado

El audit lo marcaba como "posiblemente hardcodeado". Verificación en
código: `CT.bellCount` ya no está hardcodeado desde Etapa 1, arranca en 0
y solo se incrementa desde `aplicarEventoIndividual()`, alimentado por el
canal `postgres_changes` de `iniciarRealtime()`. **Sin cambios de código
necesarios en ese frente.**

Sin embargo, verificando la base de Supabase real del proyecto se
encontraron dos problemas que impiden que ese canal funcione en absoluto:

1. **Bug de nombre de tabla**: la suscripción escuchaba `ventas` (evento
   INSERT), pero la tabla real es `ventas_pos`. Corregido en
   `iniciarRealtime()`.
2. **Hallazgo nuevo, no incluido en el audit original**: la publicación
   `supabase_realtime` de Postgres **no tenía ninguna tabla agregada**
   (`pg_publication_tables` devolvía 0 filas para `pedidos`, `rutas` y
   `ventas_pos`). Esto significaba que ningún `postgres_changes` se disparaba
   nunca — no solo en Torre de Control, sino también en `pedidos.js` y
   `rutas.js`, que dependen del mismo mecanismo (y `rutas.js` además
   escucha `entregas`).

   **Aplicado en esta etapa** (migración `etapa3_habilitar_realtime_pedidos_ventas_rutas_entregas`
   sobre el proyecto Supabase real): `ALTER PUBLICATION supabase_realtime
   ADD TABLE` para `pedidos`, `ventas_pos`, `rutas` y `entregas`.
   Verificado post-migración: las 4 tablas ya figuran en
   `pg_publication_tables`. Como las 4 tienen RLS activo, Realtime sigue
   filtrando los eventos según esas políticas — no se abrió nada adicional
   (chequeado contra el linter de seguridad de Supabase, sin hallazgos
   nuevos relacionados a este cambio).

## Resumen

- Crítica: 1 resuelta (badge MODO DEMO).
- Alta: 3 resueltas (chip de sesión con retry, topbar/KPIs con feedback
  visible, toasts unificados).
- Media: 4 resueltas (rate-limit del buscador, NotifManager eliminado,
  preloaders consolidados, skeleton de topbar) + 1 re-verificada con un
  bug de código corregido (nombre de tabla `ventas` → `ventas_pos` en
  `iniciarRealtime()`; bell icon ya no hardcodeado desde Etapa 1).
- **Hallazgo nuevo (fuera del audit original), aplicado en esta etapa**:
  la publicación `supabase_realtime` no incluía ninguna tabla — el
  realtime de todo el panel admin (no solo Torre de Control) estaba
  inoperante a nivel de base de datos. Se agregaron `pedidos`,
  `ventas_pos`, `rutas` y `entregas` a la publicación (migración aplicada
  sobre el proyecto Supabase real, verificada y sin impacto de seguridad
  adicional).
