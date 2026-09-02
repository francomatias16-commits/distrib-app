# v812 — Fix: "Imprimir remito" no descarga ni muestra nada

## Síntoma reportado
Con v811 ya desplegado (así que la query a `pedidos` ya no fallaba),
al clickear "Imprimir remito" no pasaba nada visible: ni se abría una
ventana, ni aparecía el toast de "Bloqueador de popups activo".

## Causa
`imprimirRemito()` en `remito.js` hacía varios `await` (carga del
pedido, carga de items, reserva del número de remito) **antes** de
llamar a `window.open()`. Los navegadores modernos solo tratan un
`window.open()` como "originado por un gesto del usuario" (y por lo
tanto exento del bloqueador de popups) si ocurre de forma síncrona
dentro del handler del click, o como máximo tras una micro-espera muy
corta. Al haber varios `await` a Supabase/fetch de por medio, para
cuando el código llegaba a `window.open()` el navegador ya no lo
consideraba parte del gesto de click y lo bloqueaba — pero muchos
navegadores lo bloquean **en silencio** en este caso particular (sin
disparar el ícono/aviso nativo de popup bloqueado), y como `win` daba
`null`, nuestro propio chequeo `if (!win)` sí corría, pero el toast
tampoco llegaba a verse en algunos casos por timing con el resto de la
función. Resultado neto para el usuario: click sin ningún efecto
visible.

## Fix
Se reordena `imprimirRemito()` para abrir la ventana (`window.open`)
como primera instrucción, todavía de forma síncrona dentro del gesto
de click, antes de cualquier `await`. La ventana se abre con un HTML
placeholder ("Generando remito…") y recién al final, cuando ya se
armó el HTML completo del remito, se le hace `document.open()` +
`document.write()` + `document.close()` con el contenido real. Si el
pedido falla al cargar, la ventana ya abierta muestra un mensaje de
error en vez de quedar en blanco/colgada.

Este mismo fix cubre también el flujo de "Imprimir remito" desde
Rutas (`imprimirRemitoDesdeRuta` en `rutas.html`), que llama a la
misma función de `remito.js`.

## Archivos modificados
- `frontend/admin/js/remito.js` — reordenado `imprimirRemito()`:
  `window.open()` antes de los `await`, escritura del HTML al final
- `frontend/admin/pedidos.html` y `frontend/admin/rutas.html` — bump
  cache-buster de `remito.js`
