# v758 — POS: impresión de ticket con formato de comprobante térmico real

## Problema
El ticket que imprimía el POS en modo navegador (el default, sin hardware
térmico configurado) no se parecía en nada a un ticket de supermercado:
salía como una página A4 completa ("2 hojas de papel", layout vertical
ancho), sin encabezado de la empresa ni pie de "gracias por su compra".
El módulo `pos-printer.js` ya tenía todo el circuito ESC/POS armado para
impresoras térmicas reales (USB/red/Bluetooth), pero el modo "Navegador"
—el que usa cualquiera sin hardware dedicado— nunca aprovechaba el ancho
de papel (58/80mm) que ya se configura en Admin → Hardware.

## Cambios

**`pos-printer.js`**
- Nueva función `prepararPaginaNavegador()`: inyecta un `<style>` con
  `@page { size: 58mm|80mm auto; margin: 0; }` (según el ancho configurado)
  y marca `<body data-pos-papel="58|80">`. Se llama antes de cada
  `window.print()` en modo navegador — ticket, reporte Z y prueba de
  impresión — así el diálogo de impresión del navegador ya arranca con el
  ancho real del rollo en vez de A4/carta.
- Expuesta en `window.PosPrinter.prepararPaginaNavegador` para que `pos.js`
  también pueda llamarla desde su propio atajo de impresión de Reporte Z.

**`pos.js`**
- `mostrarTicket()` y `mostrarTicketOffline()`: arman un encabezado
  (`#pos-ticket-print-header`) con razón social, domicilio, CUIT, teléfono
  (de `empresaData`, ya cargado al iniciar el POS) más N° de ticket y
  fecha/hora, y un pie (`#pos-ticket-print-footer`) con "¡Gracias por su
  compra!" — igual que ya hacía el builder ESC/POS de `pos-printer.js`,
  pero ahora también en la vista/impresión por navegador.
- `imprimirReporteZ()`: ahora llama a `prepararPaginaNavegador()` antes de
  imprimir en modo navegador.

**`pos.html`**
- Agregados los contenedores `#pos-ticket-print-header` /
  `#pos-ticket-print-footer` dentro del modal de ticket (vacíos por
  defecto, se completan por JS).

**`pos.css`**
- El encabezado/pie nuevo está oculto en pantalla (`display:none`) — solo
  aparece al imprimir, no le agrega ruido al modal normal.
- Reescrito el bloque `@media print`: tipografía monoespaciada, separadores
  punteados, sin sombras/bordes/colores de modal, ancho 100% de la página
  (que ahora es 58/80mm real gracias al `@page` inyectado), letra más chica
  automáticamente si el papel configurado es de 58mm
  (`body[data-pos-papel="58"]`). Aplica tanto al ticket de venta como al
  Reporte Z, que comparten el mismo rollo físico.

## Resultado
Con impresora térmica conectada por USB/red/Bluetooth no cambia nada (ya
imprimía ESC/POS nativo). Con modo "Navegador" — el caso por defecto, sin
hardware — el ticket ahora sale angosto, con encabezado de la empresa y
pie de agradecimiento, mucho más parecido a un comprobante de comercio
real que a una hoja de oficina.
