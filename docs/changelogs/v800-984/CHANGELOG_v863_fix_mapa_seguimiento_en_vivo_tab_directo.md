# v863 — Fix: mapa en blanco al entrar directo a "Seguimiento en vivo"

## Síntoma reportado
El mapa de `Seguimiento en vivo` sólo se veía si se llegaba a esa pantalla
apretando "Ver" desde una ruta en el tab "Armar ruta". Si en cambio se
entraba directo al tab "Seguimiento en vivo" y se elegía la ruta desde el
combo, no se visualizaba nada.

## Causa raíz (diagnóstico, no confirmado con logs — es frontend, no hay
stack trace de servidor)
`inicializarMapa()` crea el mapa de Leaflet (`L.map(...)`) y llama
`fitBounds()` sobre el contenedor `#mapa`, que vive dentro de
`#tab-seguimiento-content`. Ese tab arranca con `class="hidden"`
(`display:none`) y `mostrarTab('seguimiento')` sólo saca esa clase — no
garantiza que el navegador ya haya hecho el reflow/layout del contenedor
en el instante exacto en que Leaflet mide su tamaño.

Leaflet calcula y cachea el tamaño del contenedor en el momento de
`L.map()` / `fitBounds()`. Si en ese instante el contenedor todavía no
tiene su tamaño real (por venir de `display:none`), Leaflet lo toma como
0x0 y el mapa queda invisible o mal encuadrado — y no se autocorrige solo,
necesita un `invalidateSize()` posterior.

Por qué se notaba distinto según el camino de entrada: en el flujo
"Armar ruta → Ver" (`mostrarTab('seguimiento'); sel.value=...;
cargarSeguimiento()`, todo en el mismo handler) solía haber más trabajo
previo en el hilo principal antes de llegar a `inicializarMapa()`, dándole
al navegador más chance de terminar el reflow a tiempo. Entrando directo
al tab y seleccionando del combo, ese margen no siempre estaba — de ahí
que pareciera "funcionar sólo desde armar ruta" cuando en realidad es una
condición de timing, no una diferencia real de lógica entre los dos
caminos (ambos llaman exactamente a `mostrarTab` + `cargarSeguimiento`).

## Fix
`frontend/admin/js/rutas.js`:
- Nueva función `refrescarTamanioMapa(bounds)`: llama
  `_mapaLeaflet.invalidateSize()` dentro de un `requestAnimationFrame`
  (es decir, recién cuando el navegador garantiza que ya hizo el reflow) y
  recién ahí reaplica `fitBounds()`.
- Se invoca al final de `inicializarMapa()`, después del `fitBounds()`
  original — cubre la creación en frío del mapa.
- Se invoca también desde `mostrarTab()` cuando se entra al tab
  `seguimiento` y ya existía un mapa creado de una visita anterior (para
  el caso de ir y volver del tab con el mapa ya inicializado pero
  potencialmente con un tamaño cacheado viejo).

Cambio acotado a la capa de presentación del mapa; no toca la consulta a
`entregas` ni el resto del flujo de seguimiento.

## Pendiente de verificación en vivo
- Entrar directo a "Seguimiento en vivo" (sin pasar por "Armar ruta") y
  confirmar que el mapa se ve al elegir una ruta del combo.
- Repetir yendo y viniendo entre tabs con una ruta ya seleccionada, para
  confirmar que no quedó ningún caso con el mapa cortado o mal encuadrado.

## Verificación
- `node --check frontend/admin/js/rutas.js` → OK.
