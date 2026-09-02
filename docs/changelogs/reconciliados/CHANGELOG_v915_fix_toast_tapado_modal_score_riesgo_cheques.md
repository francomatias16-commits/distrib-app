# v915 — Fix: "Recalcular" en modal de confianza (riesgo-cheques) no mostraba nada

## Síntoma reportado
En "Cheques por vigilar" (`riesgo-cheques.html`), al abrir el modal de
nivel de confianza de un cliente y clickear "Recalcular", no pasaba
nada visible: ni error, ni mensaje de éxito.

## Investigación
- El endpoint `/api/score?accion=recalcular` existe y no depende de
  nada exclusivo de Clientes (`lib/handlers/score.js`).
- `recalcularScore()` en `riesgo-cheques.js` llama correctamente al
  endpoint y a `mostrarToast(...)`, que es alias de la misma función
  `toast()` de `ui-utils.js` que usa `clientes.js` (`window.toast`).
- La función `toast()` crea y anima el elemento igual en ambos casos.

## Causa raíz
Mismo patrón que v633 / v742 / v806 / v633, etc.: un elemento con
z-index alto tapando al toast (`--z-toast`, tokens.css, valor 600).

`#modal-score-cliente` (y `#modal-bcra-cliente`), agregados en
`riesgo-cheques.html` en v914, tienen `z-index:1000` inline. Como el
toast vive en z-index 600, quedaba dibujado **detrás** del overlay del
modal: la acción se ejecutaba bien en el backend (el score se
recalculaba), pero la confirmación visual era invisible para el
usuario — de ahí "no hace nada, ni un mensaje".

## Solución aplicada
Override de `--z-toast` a `10200` en
`frontend/admin/css/riesgo-cheques-gentelella.css` (se carga al final
del `<head>` de `riesgo-cheques.html`, después de `tokens.css`, mismo
mecanismo que usan `productos-modal-fix.css`, `cheques-gentelella.css`,
`cobranzas-gentelella.css`, etc.).

No se tocó `--z-modal` porque en este flujo no hay un segundo modal
(confirm) involucrado — solo el toast quedando atrás del propio
`modal-score-cliente`.

## Archivos modificados
- `frontend/admin/css/riesgo-cheques-gentelella.css` — agregado override
  de `--z-toast` al final del archivo.
- `frontend/admin/riesgo-cheques.html` — versión del CSS: v1 → v2
  (cache-busting).

## Nota / deuda técnica resuelta en v916
`clientes.html` usaba el mismo `#modal-score-cliente` con `z-index:1000`
(y además `#modal-portal-overlay` con `z-index:9999`), tampoco tenía
override de `--z-toast`. Se confirmó el mismo bug latente y se corrigió
en v916 — ver `CHANGELOG_v916_fix_toast_tapado_modal_score_clientes.md`.

## Sin migraciones de base de datos
