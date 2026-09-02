# Auditoría de landing

> **Nota (v984, verificado contra código real):** desde este documento
> (21/08) la landing se reconstruyó por completo — pasó de HTML estático a
> una SPA renderizada por `bundle-part1.js`/`bundle-part2.js` dentro de un
> único `<div id="root">` (`index.html` ya no tiene la sección
> `#colaboracion` como marcado estático, ni ningún otro `id` propio). Dos
> cosas separadas:
> - **El fix técnico del sticky (el motivo real de esta auditoría) sigue
>   vivo:** `overflow:visible!important` en `.gamma-page`/`.hero-stage`
>   está presente en `bundle.css`, dos veces, en los mismos breakpoints de
>   escritorio (`≥761px`) que describía el documento. No se perdió en la
>   reconstrucción.
> - **El contenido de la sección `#colaboracion` (mensaje de operación
>   offline) no lo pude confirmar.** Busqué el texto ("sin conexión",
>   "se sincronizan automáticamente") en los bundles JS actuales y no
>   aparece con esa redacción ni con variantes cercanas — pero el
>   contenido ahora se arma en JS/CSS-in-JS, no como texto plano
>   grepeable, así que esto **no es un hallazgo de "se perdió"**, es un
>   "no pude verificarlo por grep, hace falta mirarlo renderizado". La
>   sección `#colaboracion.feature-section` sigue teniendo estilos
>   dedicados en `bundle.css`, lo cual sugiere que la sección existe, solo
>   que no puedo leer su copy actual desde el código fuente estático.
> - La lista de "Archivos modificados" de abajo quedó obsoleta —
>   `frontend/landing/styles.css` y `offline-section-patch.js` ya no
>   existen como tales, todo se compila a `bundle.css`/`bundle-part*.js`.

## Hallazgos corregidos

### 1. El sticky se liberaba antes de terminar el carril

`.gamma-page` tenía `overflow: hidden`. Ese `overflow` convierte al ancestro
en un scroll-container y limita el alcance de `position: sticky` en
`.hero-sticky`. El síntoma era que el carril funcionaba al comienzo, pero el
contenido dejaba de quedar fijo después de algunas diapositivas.

**Corrección:** se fuerza `overflow: visible` en `.gamma-page` y
`.hero-stage` para escritorio, y se reafirma `position: sticky`, `top: 0` y
`min-height: 100vh` en `.hero-sticky`.

### 2. Espacio vacío al final del hero

El pseudo-elemento del stage (`.hero-stage::after`) quedaba anclado a una
zona inferior del stage que ya no coincidía con el viewport del sticky cuando
el ancestro liberaba el sticky. Por eso se veía la leyenda del carril sobre
un área casi vacía.

**Corrección:** el stage mantiene un recorrido estable de
`100vh + 1200px` y conserva overflow visible, de modo que la decoración y
las ocho diapositivas quedan dentro del mismo recorrido.

## Verificaciones ejecutadas

- Sintaxis JavaScript de los siete scripts de la landing: **OK**.
- Cableado de assets de todo el frontend: **79 páginas, 1.727 referencias,
  0 referencias rotas**.
- Se mantuvo el comportamiento responsive existente: el parche sticky solo
  se aplica desde `761px`; mobile continúa usando el flujo normal.

## Archivos modificados en el fix sticky

- `frontend/landing/styles.css`

## Cambio acotado de contenido — sección `#colaboracion`

La sección ahora comunica operación offline: pedidos, rutas y cobros quedan
guardados en el dispositivo sin conexión y se sincronizan automáticamente al
recuperar internet. El cambio se implementó como una capa aislada en
`offline-section-patch.js`, sin editar el bundle principal ni otras secciones
de la landing.

Archivos agregados/modificados para esta sección:

- `frontend/landing/index.html`
- `frontend/landing/offline-section-patch.js`
- `frontend/landing/styles.css`
