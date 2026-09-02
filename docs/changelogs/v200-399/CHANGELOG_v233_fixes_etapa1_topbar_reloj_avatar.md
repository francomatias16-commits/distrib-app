# CHANGELOG v233 — Fixes Etapa 1 (Topbar / Reloj / Avatar)

Aplicado sobre distrib v232, en base a `Auditoria_Etapa1_Topbar_Reloj_Avatar_distrib_v232.docx`.

## Nuevo módulo compartido

- **`frontend/shared/topbar-widgets.js`** (nuevo): fuente única de verdad para
  el reloj (`#topbar-fecha`) y el chip de usuario + avatar de iniciales
  (`#topbar-usuario` / `#topbar-avatar-ini`). Reemplaza la lógica que antes
  vivía únicamente en `dashboard-optimizado.js`.

## [Alta] Reloj y avatar fantasma en 14 páginas

Se agregó `<script src="/frontend/shared/topbar-widgets.js">` justo después
de `auth.js` en: `anomalias.html`, `auditoria.html`, `automatizacion.html`,
`cheques.html`, `cobranzas.html`, `devoluciones.html`, `fidelizacion.html`,
`notas.html`, `notif-log.html`, `puntos.html`, `rentabilidad-zona.html`,
`riesgo-cheques.html`, `rutas.html`, `vencimientos.html`. El reloj y el
avatar de iniciales ahora funcionan igual que en el Panel principal.

`dashboard.html` también pasa a usar el módulo compartido; se eliminaron
las funciones duplicadas (`iniciarRelojTopbar`, `mejorarChipUsuario`,
`_formatoRelojTopbar`, `DIAS_SEMANA`, `MESES_ANIO`) de
`dashboard-optimizado.js` y sus dos llamadas redundantes (evita además un
`setInterval` duplicado del reloj).

## [Alta] `#ct-sucursal` — dead click en Torre de Control

Sin listener ni funcionalidad real. Se deshabilita visualmente
(`disabled`, `opacity:.55`, se quita la flecha `▾`) hasta que exista
soporte real de multi-sucursal. `dashboard-control-tower.css`.

## [Media] Chip de usuario 100% decorativo

`topbar-widgets.js` ahora arma un menú real de cuenta (Mi perfil / Cerrar
sesión) sobre el chip avatar+nombre del topbar clásico. Mismo patrón
replicado en `#ct-avatar` de Torre de Control (`wireAvatarMenu()` en
`dashboard-control-tower.js`), que antes tenía `title="Cuenta"` sin ninguna
acción detrás.

## [Media] Fallback si `authReady` nunca resuelve

`topbar-widgets.js`: a los 12s (mismo timeout que ya usan los KPIs), si el
chip de usuario sigue vacío se muestra "Invitado" + badge "sin conexión" en
vez de dejarlo en blanco para siempre.

## [Media] Badge de notificaciones hardcodeado ("3")

`dashboard-v2.html`: el badge ya no trae un "3" quemado — arranca oculto
(`hidden`) y `dashboard-control-tower.js` lo actualiza con la cantidad real
de eventos en vivo acumulados (`CT.bellCount`, incrementado en
`aplicarEventoIndividual()`), se resetea al abrir la campana.

## [Baja] Título estático en `#ct-live-toggle`

Ahora alterna entre "Pausar actualización en vivo" y "Reanudar
actualización en vivo" según el estado real.

## [Baja] Reloj sin aclarar que es la hora local

`#topbar-fecha` ahora tiene `title="Hora de tu dispositivo"`.

## [Baja] Código muerto `renderAvatar()`

Eliminado de `frontend/shared/adminlte-ui.js` (cero call-sites en todo el
repo, además tenía un bug de scope: `window.renderAvatar = renderAvatar`
quedaba mal ubicado dentro del cuerpo de la función). Se retiró también la
clase CSS `.topbar-avatar` que solo usaba esa función muerta.

## Pendiente (fuera de esta tanda, requiere decisión de producto)

- Estandarizar el reloj en las ~17 páginas restantes que ni siquiera tienen
  el `<span id="topbar-fecha">` en el HTML, o confirmar que es intencional
  que no lo tengan.
- Definir si `dashboard-v2.html` (Torre de Control) es un WIP a enlazar
  desde el menú o código a remover — hoy sigue sin estar en `nav-data.js`.
