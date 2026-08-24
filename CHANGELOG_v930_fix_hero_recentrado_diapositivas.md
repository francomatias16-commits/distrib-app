# v930 — Fix: el hero "se corre" (se recentra) a partir de la 3ra diapositiva

## Bug

Reporte del usuario tras v929 (que arregló el salto de 2 a 6): "calibra
mejor porque a partir de la tercera se empieza a correr el hero". El
salto de índices ya no ocurre, pero el conjunto del hero (tarjeta +
texto) se desplaza verticalmente al pasar entre ciertas diapositivas,
notorio a partir de la 3ra.

## Causa

No es un problema de cálculo de scroll (`app.js` sigue intacto y su
mapeo scroll→índice es correcto desde v929). Es un layout shift de CSS:

- Cada una de las 8 diapositivas (`Lo[]` en el bundle) trae un título y
  un texto de longitud distinta: el título va de 22 a 35 caracteres
  ("Asistente IA incluido" vs "Automatización del pedido al cobro"), el
  texto de 63 a 81.
- `.hero-offer h2` y `.hero-offer>p` no tienen alto reservado, solo la
  tarjeta `.hero-offer` tiene `min-height`.
- `.hero-art` centra verticalmente su contenido (`align-items:center`).

Resultado: cada vez que el título o el texto de la diapositiva activa
ocupa una línea de más o de menos, la tarjeta cambia de alto real y
`.hero-art` la recentra — todo el conjunto (tarjeta, rail de puntos)
salta hacia arriba o abajo. Las diapositivas 1 y 2 tienen títulos de
longitud parecida, por eso no se nota ahí; recién en la 3ra aparece una
diferencia de líneas visible.

## Fix

`frontend/landing/styles.css`, bloque nuevo al final, solo desktop/tablet
(≥761px, mismo alcance que v929):

```css
@media (min-width:761px){
  .hero-offer h2{min-height:2.94em}
  .hero-offer>p{min-height:4.5em}
}
```

Reserva el alto del peor caso (3 líneas) para el título y el texto, en
`em` para escalar junto con el `font-size: clamp()` ya existente. Así la
tarjeta nunca cambia de alto real al pasar de una diapositiva a otra y
`.hero-art` no tiene nada que recentrar. Diapositivas con título/texto
más corto simplemente dejan un poco de espacio en blanco debajo, no
perceptible porque el espaciado hacia el resto de la tarjeta no cambia.

## Qué no toqué

Ningún JS del bundle (el mapeo scroll→índice de v929 queda intacto),
ningún otro breakpoint, ninguna otra sección de la landing, ni el resto
del proyecto (backend, POS, migraciones).

Verifiqué que el CSS quedó balanceado (1913 llaves abren / 1913 cierran)
y reempaqueté el proyecto completo.
