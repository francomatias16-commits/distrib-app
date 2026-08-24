# v893 — Fix "ComponentesAdmin is not defined" al entrar a Rutas

## Problema (reportado por Luc con captura de consola)

Al cargar `/admin/rutas` aparecía un toast rojo apenas entraba la página:
`ComponentesAdmin is not defined`.

## Causa

`rutas.html` carga `frontend/admin/js/zonas.js` (para la pestaña "Zonas"
del módulo de Rutas). `zonas.js` dispara su `init()` automáticamente en
cuanto resuelve `window.authReady`, sin importar en qué pestaña esté
parado el usuario — y `init() → cargarZonas() → renderTabla()` usa
`ComponentesAdmin.renderBadgeEstado()` / `renderFilaAcciones()` para
pintar la tabla.

`rutas.html` nunca incluyó el script `/frontend/shared/componentes-admin.js`
(donde se define `window.ComponentesAdmin`) — a diferencia de todas las
demás páginas que usan `zonas.js` o cualquier otro módulo dependiente de
`ComponentesAdmin` (proveedores, compras, facturación, cc-proveedores,
usuarios, lotes, notas de crédito), que sí lo cargan.

Como el error ocurre dentro de un `.then()` de una promesa sin `await` ni
`try/catch` que lo contenga, queda como una excepción no capturada — la
captura un listener global de errores que dispara el toast, en vez de
frenar la carga del resto de scripts de la página.

## Fix

`frontend/admin/rutas.html`
- Se agrega `<script src="/frontend/shared/componentes-admin.js?v=1"></script>`
  inmediatamente antes de `zonas.js`, mismo orden que usan el resto de las
  páginas del admin.
- Bump de cache-busting de `rutas.js` → `?v=20260820-1` (para descartar
  JS viejo cacheado al testear el botón "Invitar nuevo chofer" reportado
  en paralelo).

## Pendiente de confirmar

El botón "Invitar nuevo chofer" (tarjeta "Acciones de chofer" del
Resumen operativo) fue auditado en detalle: `onclick="abrirModalInvitarChofer()"`,
la función existe, está expuesta en `window`, y abre el modal correctamente
al invocarla de forma aislada (test con jsdom). No se encontró causa raíz
en el código para que no responda al click. Falta confirmar con Luc si,
una vez desplegado este fix (que elimina el toast de error que tapaba la
pantalla al cargar), el botón ya responde normalmente.
