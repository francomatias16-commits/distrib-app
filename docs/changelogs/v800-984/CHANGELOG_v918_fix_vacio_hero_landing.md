# v918 — Fix: vacío enorme debajo del hero de la landing

## Bug

Debajo del hero (justo después de "Ocho módulos. Un solo circuito.")
aparecía una franja blanca vacía enorme antes de que continuara el resto
de la página.

## Causa

`frontend/landing/styles.css` trae la clase `.hero-stage` con:

```css
.hero-stage{min-height:calc(100vh + 1800px);position:relative}
```

Es el espacio reservado por el template original para un efecto de
"scroll-jacking": mientras se hace scroll dentro de esos ~1800px extra,
el hero (`.hero-sticky`, con `position:sticky;top:0`) queda pegado en
pantalla simulando una animación. En este export esa animación no se ve
(no hay contenido visible que cambie durante el scroll), así que el
resultado es simplemente una franja en blanco del alto de ese espacio
reservado.

Dato relevante: el propio template ya desactiva este comportamiento en
mobile —`@media (max-width:760px){ .hero-stage{min-height:auto} ... }`—
o sea que los mismos autores lo tratan como un efecto opcional, no
esencial.

## Fix

Se agregó al final de `frontend/landing/styles.css`:

```css
.hero-stage{min-height:auto!important}
.hero-sticky{min-height:auto!important;position:relative!important}
```

Esto aplica en todos los tamaños de pantalla el mismo comportamiento que
el template ya usaba en mobile: el hero pasa a tener altura natural (la
que ocupa su contenido real) y deja de reservar el espacio muerto de
scroll-jacking. `app.js` no se tocó (no hace falta: es solo CSS).

## Verificación pendiente

No hay entorno de browser para renderizar y confirmar visualmente acá.
Recomendado: desplegar y revisar que el hero se vea seguido del resto de
las secciones sin la franja blanca, en desktop y mobile.
