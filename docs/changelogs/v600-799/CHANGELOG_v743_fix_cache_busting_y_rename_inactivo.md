# CHANGELOG v743 — El modal de categorías seguía tapado y "Inactivo" seguía sin verse

## Motivo

Después de aplicar v742 (fix de z-index del modal de categorías + fix del
texto del toast), el dueño probó de nuevo en el sitio en vivo y reportó
que **seguía** sin poder abrir "(administrar)" y **seguía** sin ver una
opción "Inactivo" en ningún lado. Dos causas distintas, ninguna relacionada
con que el fix de v742 estuviera mal escrito.

## Causa 1 — Cache-busting: los archivos cambiaron, pero la URL no

Este proyecto versiona sus assets estáticos por query string
(`archivo.js?v=283`, `archivo.css?v=2`, etc.) — es el mecanismo que usa
para forzar que el navegador (y el CDN de Vercel) descarguen la versión
nueva en vez de servir la copia cacheada de siempre bajo la misma URL.

v742 modificó el **contenido** de `productos-modal-fix.css`,
`productos.js` y `etiquetas.js`, pero no tocó el `?v=N` con el que
`productos.html` los referencia. Resultado: aunque el deploy en Vercel
sí haya subido los archivos nuevos, cualquier navegador que ya haya
visitado `/admin/productos` antes sigue teniendo cacheada la versión
vieja bajo esa misma URL exacta — así que el fix nunca llegaba a
ejecutarse en el navegador del dueño.

**Fix:** se subió el número de versión de los tres archivos tocados:
- `productos-modal-fix.css` → `?v=2` → `?v=3`
- `productos.js` → `?v=283` → `?v=285`
- `etiquetas.js` → `?v1` → `?v2`

## Causa 2 — "Inactivo" no era un wording a corregir, era la opción que faltaba

En v742 se asumió que el bug era solo de vocabulario (el toast decía
"inactivo" pero el select decía "Archivado", eran el mismo estado) y se
corrigió el *toast* para que dijera "archivado". Pero el dueño insistió:
él espera ver literalmente la palabra **"Inactivo"**, no "Archivado" —
es el término que usa para referirse a productos que dejó de vender sin
borrar su historial.

**Fix:** en vez de tocar el toast de nuevo, se renombró la propia opción
en los tres lugares donde aparecía "Archivado" en la pantalla de
Productos, para que el vocabulario sea consistente en toda la pantalla:

- `frontend/admin/productos.html` — filtro "ESTADO" de la tabla
  (`prod-filtro-estado`, value `borrador`) y select "Estado" del modal de
  edición (`fp-activo`, value `false`).
- `frontend/admin/js/productos.js` — label del badge que se pinta en la
  columna Estado de la tabla (mapa `'borrador' → label`).
- El toast de "no se puede eliminar" ahora sí dice "inactivo" porque esa
  es la palabra real que aparece en el select — ya no hay desajuste.

No se tocó el valor interno (`false` / `'borrador'`), solo la etiqueta
visible — cero impacto en filtros, RPCs o la base de datos.

## Archivos modificados (acumulado desde v741)

- `frontend/admin/productos.html` — rename Archivado→Inactivo (2
  lugares) + bump de versión de 3 assets.
- `frontend/admin/js/productos.js` — rename del badge + texto del toast
  + comentarios.
- `frontend/admin/css/productos-modal-fix.css` — z-index del modal de
  categorías (de v742, sin cambios de contenido en esta versión).
- `frontend/admin/js/etiquetas.js` — feedback al hacer click en "Crear"
  con el campo vacío (de v742, sin cambios de contenido en esta
  versión).

## Importante para el deploy

Si en algún fix futuro se edita un `.css` o `.js` que `productos.html`
(o cualquier otra página) referencia con `?v=N`, **hay que subir ese
número en el mismo cambio** — si no, el navegador de quien ya visitó la
página antes va a seguir viendo la versión vieja aunque el deploy en
Vercel haya salido bien. Este es el motivo más probable de un "apliqué
el fix pero no cambió nada" cuando el código en sí está correcto.
