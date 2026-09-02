# v751 — Atajos de teclado del POS ampliados

## Motivo
El POS ya tenía atajos tipo caja registradora (F2/F4/F5/F6/F7, Supr, Enter,
Esc) pero cubrían solo una parte de las acciones frecuentes de la pantalla
de venta. Se completó el set con las acciones que quedaban sueltas.

## Atajos nuevos (frontend/admin/js/pos.js)
- **F1** — abre un modal de ayuda con el listado completo de atajos
  (`abrirModalAtajos()` / `cerrarModalAtajos()`).
- **F3** — foco directo en el % de descuento global. Si el carrito está
  vacío (campo oculto) avisa con un toast en vez de fallar en silencio.
- **F8** — cerrar caja (mismo guard de visibilidad que ya usaba F7).
- **F9** — reporte Z (mismo guard de visibilidad que ya usaba F7).
- **F10** — escanear con la cámara de la pantalla.
- **+ / -** (fuera de un campo de texto) — suma/resta una unidad (o 0.1 kg
  si el producto se vende por peso) al último producto agregado al
  carrito. Mismo criterio de exclusión de inputs que ya usaba Supr/Backspace.

Todos siguen el mismo patrón que los atajos existentes: `preventDefault()`,
chequeo de `hayModalAbierto()` para no interrumpir otro modal en curso, y
guard de visibilidad (`offsetParent !== null`) para las acciones que
dependen de que haya un turno abierto.

## UI (frontend/admin/pos.html)
- Botón "Atajos" (F1) junto a Cámara / Vincular celular.
- Botón "Descuento" (F3) en accesos rápidos (Nueva venta / Buscar producto).
- Tooltips con el atajo correspondiente en: Elegir cliente (F6), Movimiento
  de caja (F7), Reporte Z (F9), Cerrar caja (F8), Cámara (F10).
- Modal nuevo `#modal-atajos-overlay` con tabla tecla → acción.

## CSS (frontend/admin/css/pos.css)
- Estilos para `<kbd>` y `.pos-atajos-nota` dentro del modal de ayuda.

## Notas
- No se tocó ninguna función existente, solo se agregaron casos nuevos al
  mismo `document.addEventListener('keydown', ...)` y funciones nuevas.
- Verificado: `node --check` sobre pos.js sin errores; tags balanceados en
  pos.html (div y script).
- Pendiente (no bloqueante): pase manual en navegador real para confirmar
  que F8/F9/F10 disparan bien con y sin turno abierto, y que +/- no
  interfiere con el input de cantidad de cada fila del carrito.
