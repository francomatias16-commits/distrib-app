# v864 — Geocodificación automática de entregas urgentes + aviso de entregas sin ubicar en el mapa

## Contexto
En "Seguimiento en vivo", las entregas sin `lat/lng` (ni del chofer ni del
domicilio del cliente) no tenían marcador en el mapa y desaparecían del
encuadre sin ningún aviso — no había forma de saber, mirando el mapa, que
faltaban entregas por mostrar.

## Cambios

### 1. Geocodificación automática al agregar una entrega urgente
`lib/handlers/rutas-live.js` (acción `agregar-urgente`): si el cliente del
pedido no tiene `lat/lng` pero sí domicilio, se geocodifica con Nominatim
(mismo patrón que `lib/handlers/clientes.js` acción `geocodificar`) y se
persiste con `actualizarCliente()`. Best-effort: si Nominatim falla o no
matchea la dirección, sigue el flujo normal sin bloquear el alta.

### 2. Fallback de geocodificación en "Reoptimizar"
Antes de armar los destinos para la reoptimización, se geocodifican en
serie (Nominatim exige 1 req/seg) hasta 5 entregas que todavía no tengan
coords — cubre clientes cargados antes de este cambio o geocodificaciones
fallidas en el paso 1. El resto queda para la próxima reoptimización o para
el botón "Geocodificar direcciones pendientes" del panel de Clientes. Se
acota a 5 por llamada para no alargar la respuesta del endpoint, y sólo se
pausa entre intentos reales (no se cuenta cada `continue`) para no gastar
tiempo de espera de más.

### 3. Aviso visual de "sin ubicar" en el mapa de seguimiento en vivo
`frontend/admin/js/rutas.js` (`inicializarMapa`): las entregas que quedan
afuera del filtro de puntos con coordenadas ahora se listan en un bloque
nuevo debajo del mapa (`#mapa-sin-ubicar`, ya presente en `rutas.html`) en
vez de desaparecer en silencio — muestra la cantidad y el nombre de cada
cliente sin ubicar. Se oculta automáticamente cuando no hay ninguna.

Estilos agregados en `frontend/admin/css/rutas.css` (bloque base, tono
warning) con overrides en `rutas-gentelella.css` (tema) y
`rutas-compact.css` (alto compacto, `max-height` reducido).

## Archivos tocados
- `lib/handlers/rutas-live.js`
- `frontend/admin/rutas.html`
- `frontend/admin/js/rutas.js`
- `frontend/admin/css/rutas.css`
- `frontend/admin/css/rutas-gentelella.css`
- `frontend/admin/css/rutas-compact.css`

## Pendiente / no bloqueante
Pase manual en navegador real: entrar directo al tab "Seguimiento en vivo",
elegir una ruta con al menos un cliente sin domicilio geocodificado y
confirmar que aparece el bloque "Sin ubicar" con el nombre correcto.
