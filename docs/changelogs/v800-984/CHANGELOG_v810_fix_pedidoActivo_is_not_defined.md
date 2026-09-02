# v810 — Fix: "pedidoActivo is not defined" al generar comprobante o imprimir remito

## Síntoma reportado
Gracias al fix v809 (que dejó de tapar los errores reales con el mensaje
genérico), apareció el error de verdad al clickear "Generar Comprobante
de Venta" en el detalle de un pedido: `ReferenceError: pedidoActivo is
not defined`.

## Causa
`pedidos.js` se carga como `<script type="module">`, así que su `let
pedidoActivo` (línea 23) vive en el scope del módulo y nunca llega a
`window`. Pero dos botones del modal de detalle lo referencian desde un
atributo `onclick` inline en `pedidos.html`:

```html
<button id="btn-generar-factura"
  onclick="btnAsyncClick(this, () => generarFactura(pedidoActivo?.id))">
<button id="btn-imprimir-remito"
  onclick="imprimirRemito(pedidoActivo?.id)">
```

Los `onclick` inline se ejecutan en el scope global, donde `pedidoActivo`
no existe → `ReferenceError`. Es el mismo patrón de bug que ya se había
encontrado antes con funciones top-level del módulo (ver el comentario
"FIX bug botones de acción de estado sin evento" más abajo en el mismo
archivo, que ya cubrió `cambiarEstado`, `abrirModalPorId`,
`confirmarCancelar`, etc.) — pero esta vez afectaba a una variable, no
a una función, así que quedó fuera de esa lista.

Como `btnAsyncClick` atrapaba el error y lo mostraba genérico, este bug
estaba invisible hasta el fix v809.

## Fix
Se sincroniza `window.pedidoActivo` en los dos únicos puntos donde se
reasigna la variable del módulo (`abrirModal` y `cerrarModal`), siguiendo
el mismo patrón ya usado para las funciones expuestas a `window` más
abajo en el archivo.

## Auditoría de otras páginas
Se corrió un chequeo sistémico sobre todos los pares `js/*.js` +
`*.html` del admin buscando otras variables `let` de scope de módulo
referenciadas en `onclick` inline sin exponer a `window`. El único hit
adicional (`eventos` en `auditoria.html`) resultó ser un falso
positivo — es un string literal (`cambiarTab('eventos')`), no la
variable. No se encontraron más casos.

## Archivos modificados
- `frontend/admin/js/pedidos.js` — sync `window.pedidoActivo` en
  `abrirModal`/`cerrarModal`
- `frontend/admin/pedidos.html` — bump cache-buster `?v259` → `?v260`
