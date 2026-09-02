# v616 — Fix: el vínculo se quedaba en "Vinculando…" para siempre

## Causa
El fix anterior (v615) bloqueó, con razón, que el reflejo del propio QR de
"Vincular celular" se procesara como si fuera un producto escaneado. El
problema es que ese reflejo era, sin querer, la única señal que tenía la
compu para saber "el celular ya se conectó" — al bloquearlo, se cortó
también esa señal. Resultado: el botón se quedaba en "Vinculando…" para
siempre, aunque el celular sí se hubiera conectado bien, hasta que se
escaneara un producto real.

## Fix
Se separa la señal de conexión del contenido escaneado — dos eventos
Realtime distintos en el mismo canal:

- **`frontend/scan-pos/portal.js`** — nuevo evento `listo`, disparado una
  sola vez apenas la cámara Y el canal están los dos operativos (no
  depende de que se haya leído ningún código). Se vuelve a mandar cada vez
  que el celular reconecta tras volver de segundo plano (`reconectar()`).
- **`frontend/admin/js/pos-scanner-remoto.js`** — se suscribe también al
  evento `listo` (`onCelularListo()`), que pasa el estado a "conectado" y
  actualiza el botón de la barra — igual que antes, pero ahora basado en
  una confirmación real de la cámara+canal, no en inferirlo de un código
  que además muchas veces era el reflejo del propio QR.

El evento `codigo` (productos escaneados de verdad) sigue funcionando
exactamente igual que antes — el filtro del link propio (v615) se
mantiene sin cambios.

## Archivos
- `frontend/scan-pos/portal.js`
- `frontend/admin/js/pos-scanner-remoto.js`
