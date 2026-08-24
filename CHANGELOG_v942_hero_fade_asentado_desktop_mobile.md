# v942 — Fade del hero: asentamiento de ráfagas (mobile) + más pausado y sincronizado (desktop)

## Pedido
- Escritorio: el desvanecimiento entre diapositivas debía quedar más
  pausado, y la imagen/tarjeta debía ir sincronizada en tiempo y forma
  con el título y la descripción de la izquierda.
- Mobile: seguía sin desvanecimiento — pasaba directo de una
  diapositiva a otra, o saltaba 2-3 diapositivas juntas de un tirón,
  sin ningún filtro/fade.

## Diagnóstico
`hero-fade-transition-v941.js` armaba un crossfade nuevo por cada
remonte de `.hero-offer`. En desktop, la rueda del mouse dispara un
cambio de diapositiva por vez, así que esto se veía bien. En mobile,
un swipe con inercia mueve el scroll varios cientos de píxeles de
golpe, y el bundle (`app.js`) puede remontar `.hero-offer` 2 o 3 veces
en unos pocos milisegundos. Cada remonte disparaba un crossfade
propio, que el siguiente remonte interrumpía antes de completarse —
el resultado visible era un salto directo, como si no hubiera fade.

## Solución
- **`hero-fade-transition-v941.js`**: se agrega `SETTLE_MS` (150ms).
  En vez de animar cada remonte individual, se congela un clon del
  estado "antes de la ráfaga" y se espera a que el scroll se quede
  quieto (sin nuevos remontes por 150ms) para recién ahí correr un
  único crossfade limpio desde ese estado congelado hasta el estado
  final — sin importar cuántas diapositivas se saltearon en el medio.
- **`hero-copy-correlacionado.js`**: el título grande (`.hero-copy
  h1`) y el párrafo de la izquierda usan la misma lógica de
  asentamiento (`SETTLE_MS = 150`) y las mismas duraciones que la
  tarjeta, para que las dos cosas se sientan como un mismo
  desvanecimiento y no se desincronicen entre sí.
- **Duración del fade**: sube a 1500ms en escritorio (antes 1100ms,
  ahora más pausado, como se pidió) y queda en 1150ms en mobile.
- `prefers-reduced-motion` se sigue respetando en ambos archivos.

## Archivos tocados
- `frontend/landing/hero-fade-transition-v941.js`
- `frontend/landing/hero-copy-correlacionado.js`

## v943 — Ajuste: SETTLE_MS 150 → 45 (se saltaba diapositivas en mobile)
Con `SETTLE_MS = 150`, un scroll SOSTENIDO en mobile (arrastrar el
dedo, no un solo golpe) generaba remontes de `.hero-offer` más
seguido que cada 150ms. Cada remonte reiniciaba la espera de
asentamiento, así que mientras el dedo seguía en movimiento nunca se
llegaba a confirmar ninguna diapositiva intermedia — solo se veía la
de antes de empezar a scrollear y la de cuando el scroll se frenaba
del todo. Síntoma reportado: se salteaban la 2, la 4 y la 6, y se
veían solo la 1, la 3, la 5 y la 8.

Se bajó `SETTLE_MS` a 45ms en ambos archivos (`hero-fade-transition-v941.js`
y `hero-copy-correlacionado.js`). Con ese valor solo se funden los
remontes que ocurren en el mismo frame de scroll (el caso real que se
quería resolver: un fling que salta 2-3 diapositivas casi al mismo
tiempo), pero un scroll sostenido normal ya no pierde ninguna
diapositiva intermedia — cada una llega a mostrar su propio fade.

## v943 (corrección real) — La causa no era el fade: era la distancia de scroll por diapositiva en mobile
Los ajustes anteriores a `SETTLE_MS` (150 → 45) eran cosméticos:
controlan qué tan lento se funde una diapositiva con otra, pero NO
cuántas diapositivas cambian durante un mismo gesto de scroll. Eso lo
define únicamente la altura de `.hero-stage` en
`hero-transitions-v937.css`, repartida entre las 8 diapositivas.

En mobile estaba en 375px por diapositiva (3000px totales), bajo el
supuesto (v939) de que "el swipe táctil es más controlado que la
rueda del mouse". Reporte real de uso lo contradice: un fling con
inercia en celular recorre fácilmente 1500-3000px+ en menos de un
segundo, así que con 375px/diapositiva un solo gesto atraviesa las 8
de punta a punta — de ahí "la 2 se saltea, la 4 se ve muy poco, la 6
casi no se visualiza". Ningún ajuste al tiempo del fade podía arreglar
esto: el fade es cosmético sobre el cambio, la velocidad del cambio en
sí la define esta distancia.

**Fix real**: se sube mobile a 900px por diapositiva x 8 = 7200px
(antes 375px x 8 = 3000px, 2.4x más). Con esto un swipe normal ya no
cruza una diapositiva entera, y un fling fuerte cruza como mucho 1-2
— que es el caso que `hero-fade-transition-v941.js` ya sabe fundir en
un crossfade limpio con `SETTLE_MS`.

### Archivo tocado
- `frontend/landing/hero-transitions-v937.css` (bloque `@media
  (max-width:760px)`, `.hero-stage { min-height }`).

## v944 (fix definitivo) — Se elimina el mecanismo que ocultaba diapositivas
Los dos ajustes anteriores (SETTLE_MS 150→45, y la distancia de scroll
en mobile) no atacaban la causa real. Revisando el código con calma:

**El bug estaba en `hero-fade-transition-v941.js` mismo.** Desde v942,
cuando el bundle remontaba una nueva `.hero-offer`, el script la
dejaba en `opacity:0` hasta que el scroll se quedara quieto
(`SETTLE_MS`). Si llegaba OTRO remonte antes de esa pausa —que pasa
con cualquier scroll continuo normal, no hace falta un fling extremo—
el nodo anterior se descartaba del DOM sin haber llegado NUNCA a
`opacity:1`. Existió, pero fue invisible. Eso es exactamente "se
saltea la 2, la 4, la 6": no era un problema de velocidad de scroll ni
de distancia por diapositiva, era que mi propio script las escondía y
las tiraba antes de mostrarlas. El mismo defecto existía, en espejo,
en `hero-copy-correlacionado.js` para el título y el párrafo.

**Solución (v944), sin atajos de tiempo**: se elimina por completo el
mecanismo de "ocultar hasta asentarse" en los dos archivos.
- El contenido nuevo (tarjeta, título, párrafo) se muestra siempre al
  instante, en el mismo momento en que existe — nunca se demora ni se
  pone en opacity:0.
- En la tarjeta, lo único que se anima es la SALIDA: se clona el nodo
  viejo, se superpone sobre el nuevo (ya visible) y se desvanece. Si
  llegan varios remontes seguidos, se apilan varios clones
  desvaneciéndose a la vez — nunca se pierde visibilidad de una
  diapositiva real.
- En el título/párrafo, se aplica el texto correcto de inmediato y
  solo se anima un "dip" de opacidad que nunca baja de 0.4 (nunca
  invisible), como refuerzo visual del cambio.
- Duración pareja en ambos archivos: 900ms desktop / 500ms mobile
  (bajó de los 1500/1150 anteriores, porque ya no depende de una
  espera previa — el efecto se siente igual de suave con menos
  tiempo total).

### Archivos tocados
- `frontend/landing/hero-fade-transition-v941.js` (reescrito)
- `frontend/landing/hero-copy-correlacionado.js` (reescrito `fadeUpdate`)

## Sin cambios
- `frontend/landing/hero-scroll-throttle-v940.js` (ya venía reconstruido
  correctamente en el ZIP anterior, sigue igual).
- `frontend/landing/hero-transitions-v937.css` / `mobile-hero-v935.css`
  (no hacía falta tocar CSS: ninguna regla ahí pisa con `!important`
  las propiedades `opacity`/`transition` que estos scripts setean
  inline).
