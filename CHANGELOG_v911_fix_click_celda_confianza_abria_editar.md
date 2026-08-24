# v911 — Fix: click en la celda "Confianza" de Clientes abría el modal de Editar

## Bug reportado

"El primer clic que hago se abre el modal de editar clientes y a partir
del segundo abre el de confianza."

## Causa

La fila de la tabla (`<tr class="fila-cliente">`) tiene un `onclick` que
abre el modal de Editar, salvo que el click haya caído sobre algún
elemento clickeable propio (`[onclick],a,select,input,textarea,button`):

```html
<tr onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalEditar('${c.id}')">
```

En la celda "Confianza", solo el `<button class="score-badge-btn">`
(el pill con el ícono y el número) tenía su propio `onclick="verScoreCliente(...)"`.
La frase de motivo que aparece debajo del pill cuando el cliente está en
riesgo (`<div class="score-motivo-inline">`, ej. "3 pedidos sin cobrar
hace 45 días") **no** lo tenía — visualmente parece parte del mismo
elemento clickeable, pero al no matchear el selector de exclusión, el
click ahí caía al handler de la fila y abría Editar en vez de Confianza.

Eso explica el patrón reportado: clickear la frase de motivo (muy
fácil, ocupa más área que el pill) abre Editar; una vez abierto ese
modal, sigue mostrando el mismo score con un link "Ver historial ↗"
(`abrirModalEditar`, línea ~728) que si se vuelve a clickear en la
misma zona de la pantalla, ahora sí dispara `verScoreCliente` — de ahí
la sensación de "primer clic Editar, segundo clic Confianza".

## Fix

`clientes.js`: se saca el `onclick` del `<button>` y se pone en el
`<td class="td-score">` que envuelve tanto al pill como a la frase de
motivo, así toda la celda (no solo el pill) abre el modal de Confianza
y ningún click ahí puede colarse al handler de la fila (el propio `td`
ya matchea `[onclick]` en el selector de exclusión).

`clientes.css`: se agrega `cursor: pointer` a `.td-score[onclick]` para
que el área clickeable ampliada se sienta consistente.

- Cache-busting: se bumpeó el `?v=` de `clientes.css` y `clientes.js`
  en `clientes.html`.

## No afectado

- `verScoreCliente()`, el modal de score en sí y el link "Ver historial ↗"
  dentro del modal de Editar siguen iguales — el bug era solo de qué
  handler capturaba el click en la tabla, no de la lógica de los modales.
