# CHANGELOG v925 — Fix: click en un card distinto al zoomeado no hacía nada

## Reporte del usuario

"no se esta cumpliendo, el primer clic siempre abre en grande el recuadro y
a partir del segundo redirecciona o filtra, pero siempre al cargar o estar
en la pagina y por cada recuadro en particular"

Es decir: el comportamiento 1er-click-zoom / 2do-click-redirige debía
cumplirse **de forma independiente en cada card**, en cualquier momento de
la sesión — no solo la primera vez que se usaba el dashboard.

## Causa raíz

En v924, `abrirZoom(cardEl, url)` solo contemplaba dos escenarios dentro de
`if (zoomState) { ... }`:

```js
if (zoomState) {
  if (zoomState.card === cardEl) {
    if (url) irA(url); else cerrarZoom();
  }
  return; // <-- si zoomState.card !== cardEl, no hacía NADA
}
```

Faltaba el tercer escenario: **hay un card A en zoom y el usuario hace click
en el fondo de un card B distinto**. Ahí el `return` temprano ignoraba el
click por completo — ni cerraba A ni abría B. Desde la perspectiva del
usuario esto se sentía como "el card no responde" o "no se cumple, y
depende de cuál sea el primer card que tocaste": una vez zoomeado cualquier
card, todos los demás quedaban muertos al click hasta cerrar ese zoom
manualmente (Escape, click en el backdrop, o botón de cerrar).

## Cambio

Se agregó el caso faltante: si el click es sobre un card distinto al que
está en zoom, ahora se cierra el zoom actual (`cerrarZoom()`) y se abre el
nuevo card como su propio 1er click (`abrirZoom(cardEl, url)` en el
siguiente frame, para no pisar la animación de cierre):

```js
if (zoomState) {
  if (zoomState.card === cardEl) {
    if (url) irA(url); else cerrarZoom();
    return;
  }
  cerrarZoom();
  requestAnimationFrame(() => abrirZoom(cardEl, url));
  return;
}
```

Con esto cada uno de los 8 cards mantiene su propio ciclo
zoom → redirige, sin importar el orden en que se clickeen ni cuántas veces
se repita durante la sesión.

## Ajuste posterior (mismo v925): timing de la transición

Un primer intento de este fix abría el card nuevo con `requestAnimationFrame`
inmediatamente después de `cerrarZoom()`. Eso resultó en un bug visual: el
card viejo tiene `transition: top/left/width/height .32s` (ver CSS
`.card.zoom-active`) y tarda 320ms en volver a su lugar; como el nuevo card
se abría casi al instante en la MISMA posición central (`position:fixed`,
`z-index:501`), quedaba tapado por el viejo mientras este terminaba de
cerrarse — se sentía como "el segundo card no responde" aunque en realidad
sí se activaba, solo que no se veía.

Fix: se agregó una constante `ZOOM_CLOSE_MS = 330` (320ms de transición CSS
+ margen) y ahora se espera ese tiempo con `setTimeout` antes de abrir el
card nuevo, para que la animación de cierre del anterior termine primero:

```js
cerrarZoom();
setTimeout(() => abrirZoom(cardEl, url), ZOOM_CLOSE_MS);
```

La misma constante reemplaza el `330` que ya estaba hardcodeado dentro de
`cerrarZoom()`, para que ambos valores no puedan desincronizarse a futuro.

## Archivo modificado

- `frontend/admin/dashboard.html` (función `abrirZoom`, `cerrarZoom` y
  nueva constante `ZOOM_CLOSE_MS`, script inline)

## Verificación sugerida post-deploy

1. Click en card "Ventas" → zoom. Sin cerrarlo, click en card "WhatsApp" →
   Ventas se cierra y WhatsApp abre en zoom (antes: no pasaba nada).
2. Click de nuevo en el fondo de "WhatsApp" (ya zoomeado) → redirige a
   `/admin/whatsapp-conversaciones`.
3. Repetir la secuencia completa alternando entre varios cards (POS, ARCA,
   Score/Cheques, Automatización, Catálogo, Reportes críticos) en cualquier
   orden, varias veces seguidas — cada uno debe responder siempre igual:
   1er click = zoom, 2do click sobre el mismo = redirige (o cierra, en el
   caso de Reportes críticos).
4. Confirmar que "Reportes críticos" sigue cerrando (no redirigiendo) en su
   2do click, y que sus `item-nav` internos siguen navegando directo.
5. Al pasar de un card a otro, confirmar que la animación se ve fluida:
   el card viejo termina de encogerse a su lugar original ANTES de que
   empiece a aparecer el nuevo agrandándose (sin superposición ni "salto").
6. Repetir la secuencia varias veces seguidas, alternando rápido entre
   distintos cards, para descartar que quede algún card "pisado" a mitad
   de transición.
7. Validar sintaxis: `node --check` sobre el script inline no debe arrojar
   errores.
