# v926 — Fix real: backdrop del zoom bloqueaba clicks a los demás cards

## Síntoma reportado
Con mouse (desktop), sin errores en consola: el primer click sobre un card
del dashboard abre el zoom correctamente. A partir de ahí, ningún click
subsiguiente responde — ni sobre el mismo card ni sobre otros.

## Causa raíz
No era un problema de timing (`abrirZoom`/`cerrarZoom`/`ZOOM_CLOSE_MS` ya
estaban bien resueltos, según confirman los comentarios existentes en el
código). El problema era de **stacking (z-index)**:

- `#zoom-backdrop.open` → `z-index:499`, `pointer-events:auto`, cubre todo
  el viewport mientras hay un card zoomeado.
- El card zoomeado (`.zoom-active`) → `z-index:501`, por eso ESE card sí
  respondía a sus propios botones/clicks.
- El resto de los `.card-nav` (los demás 8 cards del mosaico) no tenían
  ningún `z-index` propio → quedaban en `auto` (~0), es decir, **por
  debajo del backdrop**.

Consecuencia: cualquier click dirigido a otro card, mientras había un zoom
activo, nunca llegaba al `onclick="abrirZoom(this,url)"` de ese card — lo
absorbía el backdrop antes, que solo tiene `onclick = cerrarZoom`. La rama
de `abrirZoom()` que ya maneja explícitamente el caso "click en un card
distinto al zoomeado" (cerrar el actual y abrir el nuevo tras
`ZOOM_CLOSE_MS`) era código correcto pero **inalcanzable**: nunca se
disparaba el click de origen que la activa.

Esto explica el síntoma "no responde ningún card": cada click del usuario,
sin importar sobre qué card creía estar clickeando, terminaba cerrando el
zoom actual (a veces sin que se notara) y nunca abriendo el siguiente.

## Fix
Mientras el zoom está abierto (`body.zoom-open`), se sube el `z-index` de
**todos** los `.card-nav` a `500` — por encima del backdrop (`499`) pero
por debajo del card efectivamente zoomeado (`501`, que sigue siendo el
tope). Con esto:

- Los clicks en otros cards vuelven a llegar directo a su propio
  `onclick=abrirZoom(...)`, activando la lógica de "cerrar actual y abrir
  el nuevo" que ya estaba implementada.
- El backdrop sigue funcionando igual para cerrar el zoom al clickear un
  área vacía del mosaico (huecos entre cards, o el propio backdrop donde
  no hay ningún `.card-nav` encima).

```css
body.zoom-open .card-nav{position:relative;z-index:500}
```

(agregado en `frontend/admin/dashboard.html`, justo después de la regla
`.zoom-backdrop.open`)

## Por qué no lo mostraba la consola
No había excepción: el flujo de `abrirZoom`/`cerrarZoom` corría siempre
hasta el final sin tirar error. El bug era puramente visual/de captura de
eventos (qué elemento recibe el click según el stacking), algo que el
navegador no reporta como error.
