# v622 — Fix: escanear un código nuevo no traía nombre ni foto (CORS)

## Síntoma reportado
"Escaneé un Rexona y no me tomó ni el nombre ni la imagen." El código de
barras se cargaba bien en el formulario (`#fp-codigo`), pero nombre y
foto quedaban vacíos aunque el producto sí existe en Open Food Facts.

## Causa raíz
El banco de códigos propio (440_banco_codigos_producto.sql) se armó bien
y funciona: si OTRA empresa ya había escaneado ese mismo código antes,
el dato aparece al toque. El problema era el camino de "primera vez que
alguien escanea este código" — las tres fuentes externas (Open Food
Facts, Open Products Facts, Mercado Libre) se consultaban con un
`fetch()` hecho **desde el navegador** en
`frontend/admin/js/productos-scanner-remoto.js`.

Ninguna de esas tres APIs manda la cabecera `Access-Control-Allow-Origin`
necesaria para que un `fetch()` cross-origin desde otro dominio pueda
leer la respuesta:
- Open Food Facts lo documenta explícito ("CORS: No").
- Open Products Facts es el mismo motor (Product Opener), mismo problema.
- La búsqueda pública de Mercado Libre además está restringida desde
  hace tiempo y devuelve 401/403 casi siempre, tenga o no CORS.

El navegador bloqueaba la respuesta antes de que el código JS la viera
— el `catch` la tragaba en silencio (`console.warn`), así que para
cualquier código que el banco propio todavía no tuviera, no había
ninguna fuente que funcionara de verdad. El Rexona del reporte era,
justamente, un código que nadie había escaneado todavía en el SaaS.

## Fix
Se movió la búsqueda en las tres fuentes externas al backend
(`lib/handlers/banco-codigos.js`, acción `GET ?accion=consultar`):
cuando el banco propio no tiene el código, el propio servidor sale a
buscarlo (server-to-server, sin CORS de por medio, con timeout de 4s por
fuente), en el mismo orden que antes: Open Food Facts → Open Products
Facts → Mercado Libre.

Si encuentra imagen, la baja y la resube (normalizada con `sharp`, igual
criterio que `/api/auto-imagenes`) al bucket propio `productos-fotos`,
bajo `banco-codigos/<codigo>.jpg` — así la URL que vuelve al navegador
es siempre propia, nunca depende de que el host externo la siga
sirviendo ni de CORS de un tercero. El hallazgo se cachea en
`banco_codigos_producto` antes de responder, así la próxima consulta
del mismo código (de cualquier empresa) es un SELECT directo.

`frontend/admin/js/productos-scanner-remoto.js` se simplificó: ya no
sale a ningún tercero, solo consulta `/api/banco-codigos?accion=consultar`
una vez (same-origin, sin problema de CORS) y listo.

## Archivos
- `lib/handlers/banco-codigos.js` — búsqueda externa + rehosteo de imagen
  movidos acá.
- `frontend/admin/js/productos-scanner-remoto.js` — se saca la búsqueda
  cliente-side a OFF/OPF/Mercado Libre (quedaba muerta por CORS).

## Nota aparte (no tocado en este fix)
La captura también mostraba "Error al cargar: Acción de POS desconocida:
(sin especificar)" en Historial de cierres (`/admin/cajas`). Se revisó:
el rewrite `/api/pos/historial-turnos → /api/index?_mod=pos&accion=
historial-turnos` y el handler correspondiente ya están correctos en
este mismo zip — todo indica que la captura es de una versión ya
desactualizada (antes de que ese rewrite se agregara) y que el problema
se resuelve solo al desplegar este paquete. Si después de desplegar
sigue apareciendo, es un caso aparte y conviene reportarlo con el
`Network tab` de esa request puntual.
