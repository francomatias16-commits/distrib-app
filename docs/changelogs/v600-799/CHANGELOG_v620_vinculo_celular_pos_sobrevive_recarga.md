# v620 — Vínculo de celular del POS sobrevive recarga/navegación

## El problema
El vínculo "Vincular celular" del POS (v612/v614/v615/v616) vivía
únicamente en memoria del script (`tokenActual`, `canal`) durante esa
carga de página puntual. El token seguía vivo en el servidor y el celular
seguía mandando códigos al mismo canal Realtime sin enterarse de nada —
pero apenas la compu recargaba la pestaña, navegaba a otra pantalla del
admin y volvía, o el cajero cerraba el navegador un momento, esa
referencia se perdía. Resultado: había que abrir el modal, generar un QR
nuevo y volver a escanearlo con el celular cada vez, aunque el vínculo
"de verdad" (contra la base) todavía estuviera activo.

Nota: el flujo de Productos (`vincular-celular.js` / v617-v619) ya tenía
resuelto el caso de "seguir escaneando sin recerrar el vínculo entre
productos" — este cambio es específico del POS y de sobrevivir una
recarga/navegación completa, no de la secuencia dentro de una misma carga
de página.

## El fix
- **`frontend/admin/js/pos-scanner-remoto.js`**:
  - Cada vez que se genera o extiende el vínculo, se guarda
    `{token, caja_id, expira_at}` en `localStorage` (no `sessionStorage`
    — tiene que sobrevivir también a cerrar la pestaña/navegador, no solo
    a cambiar de pantalla). Se borra al desvincular o al vencer por
    inactividad.
  - Nueva función `intentarResumirVinculoCelular(cajaId)`: si hay un
    vínculo guardado para esa caja y todavía no venció, llama a
    `?accion=extender` para confirmarlo contra el server (por si se cerró
    desde otra pestaña mientras tanto) y se re-suscribe al mismo canal
    Realtime en silencio — sin modal, sin QR nuevo. Reconstruye también
    el QR/link de fallback en el DOM por si el cajero abre el modal
    después a mirar el estado.
- **`frontend/admin/js/pos.js`**:
  - `usarTurno()` (se ejecuta al entrar/volver a la pantalla de venta de
    una caja) llama a `intentarResumirVinculoCelular` automáticamente.
  - Al cerrar el turno de caja (`confirmarCierreTurno`), se desvincula el
    celular también — evita dejar un vínculo huérfano apuntando a una
    caja sin turno abierto.

## Alcance
Es un vínculo por **caja**, no por celular ni por navegador — si la misma
caja se abre desde otra compu, esa otra compu va a intentar resumir el
mismo vínculo guardado (si hay uno vivo). Encaja con el modelo existente
(`entidad_id` = caja en la tabla `pos_scanner_tokens`), no se agregó
ningún criterio nuevo de "dueño" del vínculo.

## Sin cambios de esquema
No hace falta migración — reutiliza `?accion=extender` (ya existía desde
v614) tal cual.

## Archivos
- `frontend/admin/js/pos-scanner-remoto.js`
- `frontend/admin/js/pos.js`
