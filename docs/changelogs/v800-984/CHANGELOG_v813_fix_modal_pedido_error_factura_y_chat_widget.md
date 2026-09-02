# v813 — Fix: modal de detalle de pedido roto al mostrar error de facturación

## Contexto

Reportado con captura: al abrir el detalle de un pedido con factura
rechazada por AFIP, el modal se veía roto — el texto del error
("Último error de facturación: Rechazo AFIP: CUIT del receptor
inválido") aparecía partido palabra por palabra, superpuesto con los
botones "Reintentar Comprobante de Venta" / "Imprimir remito", y el
botón flotante "Trabajar con IA" tapaba esa misma esquina.

Se reprodujo localmente (server.js + Playwright, sin tocar Supabase)
armando una réplica del `<head>`/markup de `pedidos.html` para aislar
el problema del cascade de CSS real del proyecto. Confirmado: son dos
bugs independientes, no uno.

## Causa 1 — texto de error metido como hijo flex del footer

`abrirModal()` en `frontend/admin/js/pedidos.js` insertaba el div
`#info-error-factura` con:

```js
btnFactura.insertAdjacentElement('afterend', errWrap);
```

Eso lo dejaba como tercer hijo de `#modal-acciones`, junto a los dos
botones. `#modal-acciones` es `display:flex; justify-content:flex-end`
sin `flex-wrap` (regla en `pedidos-gentelella.css`, única definición
activa de esa clase para esta pantalla) y el div de texto no tenía
ancho propio — los 3 elementos se comprimían en una sola fila y el
texto, sin límite de ancho, cortaba en cada palabra.

**Fix:** el div ahora se inserta con
`modalAcciones.insertAdjacentElement('beforebegin', errWrap)` — queda
como fila propia de ancho completo, arriba de los botones, en vez de
compartir fila con ellos.

## Causa 2 — chat widget flotante no se ocultaba en este modal

`pedido-modal-fullscreen.css` ya ocultaba el botón/panel del chat
(`z-index:590`, `position:fixed`) mientras estaban abiertos los
modales "Nuevo pedido" (`#pedido-modal-nuevo`) y "Nuevo presupuesto"
(`#pres-modal-nuevo`), pero no incluía `#modal-pedido` (el modal de
*detalle*, que es el de la captura). Como el chat tiene z-index más
alto que el modal (590 vs 400), quedaba flotando literalmente encima
del footer.

**Fix:** se agregó `#modal-pedido.modal.open` a la misma regla
`:has()` que ya ocultaba el widget para los otros dos modales.

## Archivos modificados

- `frontend/admin/js/pedidos.js` — reubicación del punto de inserción
  de `#info-error-factura`.
- `frontend/admin/css/pedido-modal-fullscreen.css` — selector `:has()`
  ampliado para incluir `#modal-pedido`.

## Verificación

- `node --check frontend/admin/js/pedidos.js` → OK.
- Repro visual con Playwright headless contra `server.js` local
  (markup + orden real de `<link>` de `pedidos.html`): antes/después
  confirma el error resuelto (fila propia, sin overlap del chat).

## Nota / riesgo estructural pendiente

`.modal` / `.modal-backdrop` / `.modal-acciones` están definidos con
el mismo nombre de clase en al menos 8 CSS distintos
(`pedidos.css`, `clientes.css`, `facturacion.css`, `productos.css`,
`stock.css`, `automatizacion.css`, `reskin-patch.css`,
`tema-claro-shipp.css`, `pedidos-gentelella.css`), varios con
`!important`. Hoy "funciona" por orden de carga en el `<head>`; es
frágil ante cualquier reordenamiento de `<link>`. Pendiente evaluar
scoping por ID (`#modal-pedido .modal-acciones` en vez de global) en
una sesión de auditoría aparte — no se tocó acá para no ampliar el
alcance de este fix puntual.
