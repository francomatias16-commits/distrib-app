# v615 — Botón "Vincular celular" con estado persistente + filtro del propio link

## Pedido
1. Que el botón "Vincular celular" cambie de estado una vez vinculado el celular.
2. Evitar que el link de vinculación termine tipeado en el buscador de productos.

## Causa del bug del buscador (visto en las capturas)
El primer frame de la cámara del celular (o, más raro, un lector físico
apuntando de rebote a la pantalla) llega a leer el propio QR de "Vincular
celular" que está en el monitor — antes de que el cajero reoriente la
cámara hacia el producto. Ese "código" (la URL `/scan-pos?t=...`) viajaba
como si fuera un código de barras real y disparaba la búsqueda que termina
en "No se encontró ningún producto con el código...".

## Cambios

### Botón con estado persistente (no dependía del modal)
Antes, cerrar el modal (X, Escape o "Cerrar vínculo") siempre desvinculaba
— no había forma de sacar el modal de encima y seguir usando el celular en
segundo plano.

- **`frontend/admin/pos.html`** / **`pos.css`** — el botón de la barra ahora
  tiene una etiqueta (`<span id="pos-btn-vincular-celular-label">`) y dos
  clases de estado: `.pos-btn-vinculo-pendiente` (vínculo generado,
  esperando que escaneen el QR) y `.pos-btn-vinculado` (celular ya
  conectado y mandando códigos, en verde). El estado se mantiene aunque el
  modal esté oculto.
- **`frontend/admin/js/pos-scanner-remoto.js`**:
  - Se separan dos acciones que antes eran una sola:
    - `ocultarModalVincularCelular()` (X, Escape, botón "Ocultar") — esconde
      el modal, el vínculo sigue vivo.
    - `desvincularCelular()` (botón "Cerrar vínculo", rojo/`btn--danger`) —
      corta el vínculo de verdad, revoca el token.
  - Reabrir el modal con el botón de la barra, si ya hay un vínculo activo,
    muestra su estado actual en vez de generar un token nuevo.

### Filtro del propio link como "código escaneado"
Se agrega la misma guarda en los tres puntos donde un código puede
convertirse en búsqueda de producto, para que este bug no pueda volver a
pasar por ninguno de los tres caminos:

- **`frontend/scan-pos/portal.js`** — el celular directamente no manda el
  código si matchea `/scan-pos` (no llega ni al canal Realtime).
- **`frontend/admin/js/pos-scanner.js`** (cámara local del POS) — mismo
  filtro, por si la webcam de la compu queda apuntando de rebote al modal.
- **`frontend/admin/js/pos.js`** (`buscarProductos`) — red de seguridad
  final: cubre lector físico y tipeo/pegado manual. Si `q` matchea, no pega
  contra la API — muestra un toast aclarando que es el link de vinculación,
  no un producto.
- **`frontend/admin/js/pos-scanner-remoto.js`** — mismo filtro también en
  `onCodigoRecibido`, por si quedó un celular con una versión vieja de
  `portal.js` en caché.

### Extra: el buscador se bloquea mientras se muestra el QR
Mientras el modal está en el estado "esperando que escaneen el QR" (antes
de que el celular se conecte), `#pos-input-producto` queda deshabilitado
un instante — es el campo con foco por defecto del POS, así que si algo
llega a leer el QR de la pantalla en ese momento, no tiene dónde
"tipearse". Se reactiva solo al conectar o al ocultar/cerrar.

## Archivos
- `frontend/admin/pos.html`
- `frontend/admin/css/pos.css`
- `frontend/admin/js/pos-scanner-remoto.js`
- `frontend/admin/js/pos-scanner.js`
- `frontend/admin/js/pos.js`
- `frontend/scan-pos/portal.js`
