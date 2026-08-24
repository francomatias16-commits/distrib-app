# v753 — POS: Enter cobra en reposo, el buscador libera el foco solo, hints con dígito

## Motivo
Prueba en vivo de v752 (screenshot real del admin en producción): el
cartel de atajos de abajo seguía mostrando solo F-keys, los dígitos 1-0 no
disparaban nada porque el cursor queda siempre adentro del buscador
(`autofocus` + refoco tras cada producto agregado), y Enter tampoco hacía
nada estando ahí con el campo vacío — a pesar de que el propio cartel lo
mostraba como "Confirmar".

## 1) Franja de atajos y modal de ayuda (frontend/admin/pos.html)
- La franja fija de abajo ahora muestra ambas teclas por acción:
  `F2`/`2` Cobrar, `F4`/`4` Nueva venta, `F5`/`5` Buscar producto,
  `F6`/`6` Cliente, `F7`/`7` Movimiento de caja.
- El hint de `Enter` pasó de "Confirmar" a "Cobrar / Confirmar", reflejando
  el comportamiento nuevo (ver punto 3).
- Modal de ayuda (`F1`/`1`): fila de Enter actualizada con las tres
  situaciones posibles (buscar producto / cobrar / confirmar pago).

## 2) El buscador libera el foco solo cuando queda vacío y ocioso (frontend/admin/js/pos.js)
No se sacó el `autofocus` ni el refoco tras agregar un producto — eso hay
que mantenerlo, porque un lector de código de barras físico solo manda las
teclas a donde esté el foco; si se lo sacamos de raíz, un escaneo con nada
enfocado se pierde.

En cambio, se agregó un timer de 1.5s (`_programarBlurBuscadorSiOcioso`):
si el campo queda **vacío** y sin actividad durante ese tiempo, se le saca
el foco (`inputProducto.blur()`). Un escaneo real llena el campo casi al
instante y dispara `input` en cada tecla, así que el timer se reinicia
constantemente mientras está en curso — nunca llega a dispararse en medio
de un escaneo. Si el campo tiene texto (búsqueda por nombre en curso) no
se toca el foco, timer o no. Con el buscador sin foco, `enCampoDeTexto()`
da `false` y los atajos de dígito (1-0, agregados en v752) quedan libres
para actuar.

## 3) Enter "suelto" ahora también cobra (frontend/admin/js/pos.js)
El handler de `Enter` en `document` (antes solo actuaba dentro del modal
de cobro) ahora cubre tres casos, en este orden:
1. **Modal de cobro abierto** → confirma el pago (sin cambios, igual que
   antes).
2. **Sin modal abierto, buscador con texto** → no hace nada acá: ese
   Enter ya lo procesa el listener propio de `inputProducto` (agrega el
   producto encontrado). Evita duplicar el agregado.
3. **Sin modal abierto, buscador vacío** (incluye el caso de foco en
   cualquier otro lugar, o recién liberado por el punto 2) → abre el
   cobro, misma función que usa F2/2 (`intentarAbrirCobro()`, extraída
   para no duplicar la lógica de guards: `hayModalAbierto()`,
   `cobroYaAbierto`, `btnCobrar.disabled`).

Como `Enter` no forma parte de la fila F1-F12, no depende del problema de
hardware de v752 — funciona en cualquier teclado. Con esto, terminar de
escanear y apretar Enter cobra directamente, sin necesitar que el cursor
haya salido del buscador.

## Notas
- Verificado: `node --check` sobre pos.js sin errores.
- No se tocó `_intentarConfirmarCobroPorEnter()` ni ninguna lógica dentro
  del modal de cobro.
- Pendiente (no bloqueante): probar en la notebook real que 1) el lector
  físico sigue agregando productos en ráfaga sin que el blur-por-ocio
  interrumpa un escaneo largo, y 2) que Enter con el carrito vacío avisa
  bien ("Agregá al menos un producto para cobrar") en vez de fallar en
  silencio.
