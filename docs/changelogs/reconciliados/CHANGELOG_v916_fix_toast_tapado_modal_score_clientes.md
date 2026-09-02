# v916 — Fix: toast tapado en modal de nivel de confianza (Clientes)

## Motivo
Deuda dejada en v915: se confirmó que `clientes.html` tiene el mismo
bug detectado y arreglado en `riesgo-cheques.html`.

## Causa raíz
`#modal-score-cliente` tiene `z-index:1000` inline en `clientes.html`.
Además, en esta página hay un segundo overlay, `#modal-portal-overlay`,
con `z-index:9999` inline. `--z-toast` (tokens.css) vale 600 — muy por
debajo de ambos. Al clickear "Recalcular" dentro del modal de nivel de
confianza, el toast (`window.toast(...)`, alias de `toast()` en
`ui-utils.js`) se genera y anima correctamente, pero queda dibujado
detrás del overlay del modal: no se ve nada, aunque el recálculo se
ejecuta bien contra `/api/score?accion=recalcular`.

## Solución aplicada
Override de `--z-toast: 10200` al final de
`frontend/admin/css/clientes-gentelella.css` (última hoja de estilo
específica de la página, cargada después de `clientes.css` y antes de
las hojas compartidas/globales — mismo mecanismo que en v915).

10200 cubre tanto `#modal-score-cliente` (1000) como
`#modal-portal-overlay` (9999).

No se tocó `--z-modal`: no hay un segundo modal (confirm) involucrado
en este flujo puntual.

## Archivos modificados
- `frontend/admin/css/clientes-gentelella.css` — agregado override de
  `--z-toast` al final del archivo.
- `frontend/admin/clientes.html` — versión del CSS: v2 → v3
  (cache-busting).

## Alcance
Solo `clientes.html` y `clientes-gentelella.css`. No se tocó
`riesgo-cheques.*` (ya resuelto en v915) ni ninguna función de base de
datos.

## Sin migraciones de base de datos
