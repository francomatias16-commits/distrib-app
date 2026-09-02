# v368 — Fix: push-admin.js 404 (notificaciones push admin rotas)

## Causa
`frontend/admin/pedidos.html` importa el módulo así:
```js
import { inicializarPushAdmin } from '/frontend/admin/js/push-admin.js';
```
pero el archivo real había quedado movido a
`frontend/admin/js/_archive/push-admin.js` (probablemente en una limpieza
anterior), sin actualizar ni remover esa importación. Resultado: 404 en
consola en cada carga de `/admin/pedidos`, y el admin nunca llegaba a
registrar su token de push — es decir, las notificaciones "chofer → admin"
(vía Firebase Cloud Messaging) estaban completamente inactivas.

## Verificado antes de tocar nada
- `frontend/admin/sw-admin.js` (el service worker que este módulo registra)
  sigue existiendo en su ruta esperada — no se movió.
- El endpoint backend `/api/notif/push` (`lib/handlers/notif.js`) sigue
  activo y dispatcheado en `api/index.js` — no se tocó ni se rompió.
- La firma de la función coincide exacto con cómo la llama pedidos.html:
  `inicializarPushAdmin(sb, perfil.id, perfil.empresa_id)`.

## Fix
Se restauró el archivo a su ruta original:
`frontend/admin/js/push-admin.js` (copia idéntica del que estaba en
`_archive/`, sin cambios de contenido — el código en sí estaba bien, solo
mal ubicado). Se dejó también la copia en `_archive/` sin tocar, por las
dudas de que algo más la referencie.

## Nota aparte (no se tocó, queda pendiente si se quiere)
`dashboard-optimizado.js` tiene una llamada separada:
```js
if (typeof window.inicializarPushAdmin === 'function') {
  await window.inicializarPushAdmin();
}
```
Esto asume que `inicializarPushAdmin` se expone como global `window.*`, pero
el módulo real lo exporta vía ES modules (`export { inicializarPushAdmin }`)
y solo se importa en `pedidos.html`. La condición `typeof === 'function'`
evita que esto tire error (queda como no-op silencioso), pero en la
práctica significa que si el admin abre el dashboard sin pasar por
`/admin/pedidos`, el push nunca se inicializa ahí. No se tocó porque no era
parte de este bug puntual (el 404), pero queda anotado para cuando se
quiera que el push funcione desde cualquier página del admin, no solo
pedidos.
