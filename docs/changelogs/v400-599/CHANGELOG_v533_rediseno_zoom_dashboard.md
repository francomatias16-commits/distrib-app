# v533 — Rediseño del "zoom" de los recuadros del dashboard

A pedido del dueño, tras mostrar una captura del modal de POS · Caja: se veía
desprolijo, con huecos vacíos y un botón flotando fuera de lugar.

## Diagnóstico

Lo que se abre al cliquear un recuadro del dashboard no es un modal
propiamente dicho: es el mismo card chico del grid, animado con
`position:fixed` hasta ocupar casi toda la pantalla (`abrirZoom()` en
`dashboard.html`). Dos problemas de fondo, comunes a **todos** los cards
(no solo POS):

1. **CSS `justify-content:space-between`** repartía el espacio libre entre
   los bloques del card — en un card con poco contenido (ej. POS con un
   turno recién abierto y una sola venta) eso dejaba huecos enormes entre
   el número y la fila de abajo.
2. **Botones flotantes posicionados a mano**: el botón cerrar y "Ver
   sección completa" no vivían dentro del card — eran elementos `fixed`
   en `document.body` cuya posición se recalculaba en JS
   (`posicionarControlesZoom()`) a partir de `getBoundingClientRect()`.
   Frágil y visualmente desconectado del contenido (el botón amarillo
   terminaba flotando en medio de la pantalla).

## Cambios

- **CSS**: se reemplaza `space-between` por flujo normal de arriba hacia
  abajo con más aire entre bloques; el header queda separado por una
  línea (aplicada con `:first-child`, porque en varios cards `card-head`
  viene envuelto en un div propio — POS, ARCA, WhatsApp, Automatización,
  Reportes — y en otros no — Catálogo, Score).
- **JS**: el botón cerrar y "Ver sección completa" ahora son hijos reales
  del card zoomeado (`.zoom-close-inline`, `.zoom-goto-inline`) — el
  primero con `position:absolute` arriba a la derecha, el segundo como
  última fila del propio contenido (`margin-top:auto` lo empuja al pie
  solo a él). Se elimina `posicionarControlesZoom()` — ya no hace falta
  recalcular nada en cada resize.
- **Bug real encontrado en el camino**: `#pos-barra-wrap` tenía dos
  atributos `style` en el mismo tag (HTML inválido) — el segundo
  (`display:none`) pisaba al primero y la barra de medios de pago nunca
  se mostraba, sin importar lo que hiciera el JS.
- **POS · Caja específicamente** (el card de la captura) ganó contenido
  real que ya devolvía `resumen_turno_caja` y no se mostraba: "efectivo
  esperado en caja" (`monto_calculado`), "monto inicial del turno" y el
  detalle de sangrías/refuerzos del turno. Se agregó `data-zoom="pos"` +
  entrada en `ZOOM_RELOAD` para que la data se refresque al abrir el
  zoom (mismo patrón que WhatsApp/Catálogo/Score/Reportes, que POS no
  tenía).

## Ajuste de tamaño (mismo día, a pedido del dueño)

El zoom seguía ocupando casi toda la pantalla (92% × 90%), y con eso la
info quedaba "muy dispersa" aunque ya no hubiera huecos vacíos. Se
reemplazó el cálculo por márgenes (`innerWidth - margen*2`) por un
tamaño fijo relativo, centrado: `calcularRectZoom()` apunta a ~50% del
ancho y ~55% del alto del viewport (con piso de 420×360px para pantallas
chicas), usada tanto al abrir como en el resize handler. Tipografías y
paddings del modo zoom se reescalaron hacia abajo en la misma proporción
(antes pensados para el tamaño casi-pantalla-completa).


Este rediseño de `.zoom-active` y de los botones es genérico — mejora la
base de los 8 cards del dashboard por igual. El enriquecimiento de
contenido (KPIs de caja, movimientos) se hizo puntualmente en POS, que es
el que se reportó. Si el resultado convence, el mismo criterio (sumar
contenido real que el backend ya devuelve pero el dashboard no mostraba)
se puede repetir en el resto de los cards.
