# v746 — Reestructuración total del Punto de Venta (terminal profesional)

## Qué se pidió
Rehacer la pantalla `/admin/pos` para que se vea y se sienta como una
terminal de supermercado profesional: moderna, clara, fácil de manejar,
sin perder ninguna funcionalidad existente.

## Enfoque
Etapa 1 = reestructuración visual completa sin tocar lógica. Se mantuvo el
100% de los `id` que consume `pos.js` (carrito, favoritos, cliente, cobro,
turno, modales) para no arriesgar nada funcional; el cambio es de layout,
tipografía, tamaños y jerarquía visual. Se usó y reforzó la identidad
"Hoja de Ruta" que ya tiene el resto del sistema (papel + verde + Oswald /
IBM Plex Mono) en vez de inventar una paleta nueva — mismo lenguaje visual,
llevado al contraste y tamaño que necesita un cajero parado frente a la
pantalla.

## Archivos

- **Nuevo:** `frontend/admin/css/pos-terminal-pro.css` — hoja de estilos
  que reescribe el layout y la piel visual completa del POS. Se carga
  último a propósito para ganar la cascada sin tocar `pos.css` /
  `pos-gentelella.css` / los reskin-patch existentes.
- **Editado:** `frontend/admin/pos.html` —
  - Se agregó el `<link>` a `pos-terminal-pro.css`.
  - Se movió la grilla de favoritos (accesos rápidos) de la columna
    derecha al costado del buscador, como tira de "productos frecuentes"
    horizontal — como las teclas rápidas de una caja de supermercado.
  - Se movieron "Datos del cliente", "Datos de la venta" y el botón
    "Cerrar caja" a la columna derecha (antes eran una fila aparte debajo
    de toda la grilla), para que el panel de cobro sea una columna única,
    fija, con scroll propio.
  - Se agregó una franja fija de atajos de teclado (F2 Cobrar, F4 Nueva
    venta, F5 Ver precio, Enter, Esc) — puramente informativa, sin JS
    nuevo, para que se vea como una terminal real con teclas rotuladas.
  - Ningún `id`, `onclick` ni estructura que usa `pos.js` fue tocado.

## Cambios visuales principales

1. **Layout**: grilla de 2 columnas (ticket + panel de cobro fijo) más
   una franja de atajos abajo, en vez de 2 columnas + fila suelta de
   cliente/venta + fila suelta de cerrar caja.
2. **Buscador/scanner**: input más grande, con foco marcado (glow verde),
   pensado para ser lo primero que mira el cajero.
3. **Favoritos** → tira horizontal de tarjetas grandes con barra de color
   lateral y precio en tipografía monoespaciada, estilo "tecla rápida".
4. **Tabla del ticket**: filas más altas (mejor para tocar en pantalla
   táctil), números en IBM Plex Mono con `tabular-nums`, hover de fila,
   header en negro con tracking ancho.
5. **Panel de cobro**: total en tipografía mono grande (2.4rem), botón
   Cobrar en mayúsculas estilo terminal, accesos "Nueva venta"/"Ver
   precio" más compactos.
6. **Cliente / datos de venta / cerrar caja**: unificados en tarjetas
   prolijas dentro del panel derecho, en vez de ocupar una fila entera
   abajo de toda la pantalla.
7. **Franja de atajos de teclado** fija abajo — referencia constante,
   como las teclas de función rotuladas de una registradora física.
8. **Modales** (cobro, cierre de turno, movimiento de caja, admin):
   mismo radio de borde, misma sombra, mismo header en negro con título
   en Oswald mayúscula — quedan como una sola herramienta coherente.
9. **Quickbar** (Movimiento / Reporte Z / Ventas / Stock / Favoritos /
   Devoluciones / Promociones / Hardware / Config POS): rediseñada como
   ribbon de comandos oscuro, con hover verde sólido.

## Qué NO se tocó (a propósito)
- `pos.js`, `pos-terminal.js`, `pos-offline.js`, `pos-scanner*.js`,
  `pos-printer.js` — cero cambios de lógica.
- RPCs / migraciones de Supabase.
- Los modales de administración (Ventas / Stock / Devoluciones /
  Promociones / Hardware / Config POS) heredan el mismo pulido visual vía
  las reglas de `.pos-modal` — no se rehizo cada pestaña individualmente.

## Próximas etapas propuestas (no incluidas en este ZIP)
- **Etapa 2**: grilla de categorías reales (no solo favoritos) para
  navegar el catálogo tocando en vez de escanear, si el rubro lo pide.
- **Etapa 3**: reloj en vivo + duración del turno visible en el header,
  y un indicador visual más fuerte de "caja abierta / cerrada".
- **Etapa 4**: modo alto contraste / oscuro de mostrador para locales con
  luz de local muy fuerte o pantallas económicas.

## Verificación pendiente de tu lado
No se puede levantar el server Next/Vercel ni Supabase desde este entorno
para tomar captura en vivo. Antes de pasar a producción: abrir
`/admin/pos`, abrir una caja de prueba, y revisar que el carrito, favoritos,
cobro, cierre de turno y los modales de administración respondan igual
que antes (visualmente van a verse distintos, funcionalmente no cambia
nada).
