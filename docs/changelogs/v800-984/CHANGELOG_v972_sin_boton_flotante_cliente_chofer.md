# v972 — Sacar el botón flotante "Trabajar con IA" de los portales cliente y chofer

## Resumen

El botón flotante del asistente de IA (`chat-widget.js`) aparecía en todas
las pantallas del portal de clientes (catálogo, inicio, carrito, pedidos,
cuenta, checkout) y en el portal de chofer (remito, index) — algo que no
tiene sentido en pantallas pensadas para que las use un cliente final o un
chofer, más aún visible en la vista previa del catálogo.

En el panel admin este problema ya se había resuelto en v960: el flag
`window.__CHAT_ASISTENTE_SIN_BOTON__ = true` se define antes de cargar
`chat-widget.js`, y el widget entonces no dibuja el botón flotante (solo
monta el panel, que se abre desde el ítem "Trabajar con IA" del menú). Se
aplicó exactamente el mismo patrón a los 8 archivos donde se repetía.

## Archivos modificados

- `frontend/cliente/catalogo.html`
- `frontend/cliente/inicio.html`
- `frontend/cliente/carrito.html`
- `frontend/cliente/pedidos.html`
- `frontend/cliente/cuenta.html`
- `frontend/cliente/checkout.html`
- `frontend/chofer/remito.html`
- `frontend/chofer/index.html`

En cada uno, antes del `<script src="/frontend/shared/chat-widget.js" ...>`
se agregó:

```html
<script>window.__CHAT_ASISTENTE_SIN_BOTON__ = true;</script>
<script src="/frontend/shared/chat-widget.js" defer data-chat-asistente="1"></script>
```

(el flag va en un `<script>` sin `defer`, para que corra antes de que el
IIFE de `chat-widget.js`, que sí es `defer`, lo lea al iniciar).

## Importante — a diferencia del panel admin

En el admin, sacar el FAB no eliminó el acceso al asistente: quedó
disponible desde el ítem "Trabajar con IA" del mega-menú (`nav-data.js`).
**Acá no se agregó ningún punto de acceso alternativo** — ni el portal de
clientes ni el de chofer tienen ese menú. El resultado de este cambio es
que el asistente de IA queda completamente inaccesible desde esas 8
pantallas (el panel sigue montado en el DOM, pero nada lo abre).

Si en algún momento se quiere que clientes o choferes puedan usar el
asistente (por ejemplo, un chofer preguntando por una dirección, o un
cliente buscando un producto por voz/foto), hay que agregar un botón o
ítem de menú propio de esos portales que llame a
`window.abrirAsistenteIA()` — no está hecho en este changelog porque no
se pidió.

## Verificación

- Los 8 archivos pasan un parseo real de HTML (`html.parser`) sin tags
  `<script>` sin cerrar.
- No se tocó `chat-widget.js` ni el patrón usado en el admin — mismo flag,
  mismo orden de scripts.
