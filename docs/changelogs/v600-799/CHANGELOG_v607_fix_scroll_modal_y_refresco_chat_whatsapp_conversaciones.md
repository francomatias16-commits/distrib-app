# v607 — Fix: modal de conversación de WhatsApp sin scroll + mensajes nuevos invisibles

## Problema (reportado por el usuario)

En `/admin/whatsapp-conversaciones`, al abrir una conversación con varios
turnos:

1. **No se podía hacer scroll en el modal.** `.modal` (definida en
   `finanzas.css`, que pisa la de `adminlte-components.css` por orden de
   carga del `<head>`) tiene `overflow: hidden` y ninguna altura máxima.
   Con una charla larga el modal crecía más que el viewport y el pie con
   los botones "Tomar"/"Cerrar" quedaba directamente inalcanzable — no es
   que el scroll fallara, es que no existía ningún contenedor scrolleable.
2. **Un mensaje nuevo del cliente no aparecía** aunque ya estuviera guardado
   en la base (confirmado por SQL directo contra `whatsapp_mensajes`). El
   polling de 30s (`cargarConversaciones`) refrescaba estado/borrador de la
   fila del modal abierto, pero nunca volvía a pedir los mensajes — solo se
   veían si el vendedor cerraba y volvía a abrir el modal a mano.

## Solución

- **Scroll del modal** (`whatsapp-conversaciones.html`): `#modal-conv .modal`
  pasa a layout de columna con `max-height: 90vh` y `overflow: hidden`;
  header y footer quedan `flex: none` (fijos) y `.modal-body` es la única
  zona con `overflow-y: auto` y `flex: 1 1 auto; min-height: 0`. Mismo
  patrón que `#modal-conv .modal { max-height: 90vh }` de
  `adminlte-components.css`, que acá no aplicaba por el orden de carga de
  los CSS de la página.
- **Refresco de mensajes en vivo** (`whatsapp-conversaciones.js`): se extrajo
  `refrescarChatModal(conversacionId)` — trae los mensajes y repinta el chat —
  usada tanto en `abrirDetalle` (primer render) como en cada ciclo de
  `cargarConversaciones` mientras el modal sigue abierto, para que un
  mensaje nuevo aparezca solo, sin cerrar y reabrir.
- **Auto-scroll no invasivo**: `renderChat(mensajes, scrollearAlFondo)` ahora
  sí usa ese segundo parámetro (quedó pasado pero ignorado en un primer
  borrador de este mismo fix — corregido acá). `refrescarChatModal` calcula
  si el vendedor ya estaba mirando el final de la charla
  (`scrollHeight - scrollTop - clientHeight < 40`) *antes* de pedir los
  mensajes nuevos, y solo en ese caso se hace autoscroll al repintar. Si el
  vendedor se había subido a leer mensajes viejos, el poll ya no lo arrastra
  al fondo cada 30s.

## Archivos

- `frontend/admin/whatsapp-conversaciones.html`
- `frontend/admin/js/whatsapp-conversaciones.js`

## Testing

- Verificado en Supabase que el mensaje de prueba (`"Quiero hacer un
  pedido"`, 03:30:19) ya estaba guardado en `whatsapp_mensajes` antes del
  fix — confirma que era un problema de refresco del panel, no de
  ingesta del webhook.
- Chequeo de sintaxis (`node --check`) sobre el JS modificado.
- Pendiente: probar en el navegador que (a) el modal scrollea con una
  charla larga y el footer queda siempre visible, y (b) escribir un
  mensaje nuevo desde WhatsApp con el modal abierto lo hace aparecer solo
  dentro de los 30s, sin saltar al fondo si el vendedor estaba leyendo
  arriba.
