# v914 — Modal de nivel de confianza también en "Cheques por vigilar"

## Motivo

En Clientes, el badge de score (`SCORE_CATEGORIAS`) es un botón que abre
`#modal-score-cliente` con el detalle completo (componentes, historial,
recalcular, ofrecer plan de pago). En la página de riesgo de cheques
(`riesgo-cheques.html`) se mostraba el mismo badge pero como `<span>`
fijo, sin acción al hacer clic — quedó afuera cuando se armó la página,
no fue una decisión a propósito.

## Cambio

Se duplicó el modal y la lógica de `clientes.js`/`clientes.html` en
`riesgo-cheques.js`/`riesgo-cheques.html` (decisión explícita del
usuario: duplicar en vez de extraer a un componente compartido, para no
tocar el código de Clientes que ya funciona).

- **`riesgo-cheques.html`**: agregado `#modal-score-cliente`, idéntico
  al de `clientes.html`. No hizo falta CSS nuevo — `clientes.css` ya
  estaba cargado en esta página (línea 22 del `<head>`), que es donde
  viven todas las clases `.score-*` que usa el modal.
- **`riesgo-cheques.js`**: agregadas `motivoFrase()`, `renderScore()`,
  `verScoreCliente()`, `cerrarModalScore()`, `recalcularScore()` y
  `ofrecerPlanPago()` — copiadas de `clientes.js` y adaptadas a los
  helpers que ya existían en este archivo (`getFreshToken()` local,
  `mostrarToast()` en vez de `window.toast()`, `window.sanitize()` en
  vez del wrapper `escHtml()` que solo existe en clientes.js).
  `SCORE_CATEGORIAS` no se dupdicó — ya existía en este archivo desde
  antes (se usaba para el badge, solo faltaba la parte interactiva).
- El badge de la tabla de riesgo pasó de `<span class="score-badge">`
  a `<button class="score-badge-btn" onclick="verScoreCliente(...)">`,
  mismo patrón que usa Clientes.

## Riesgo conocido / no verificado en este cambio

`/api/score?accion=cliente` recibe `cliente_id` directo — no depende
de que el cliente esté en ninguna lista precargada del lado del
backend, así que debería funcionar igual viniendo de
`fn_riesgo_cheques_lista` que desde Clientes. No se corrió un test end
to end contra el entorno real (no hay ambiente de staging accesible
desde este chat) — recomendado antes de dar por cerrado: abrir Cheques
por vigilar, clickear un score, confirmar que carga el detalle y que
"Recalcular" no rompe nada.

## Alcance

Solo `riesgo-cheques.html` y `riesgo-cheques.js`. No se tocó
`clientes.js`/`clientes.html` ni ninguna función de base de datos.
