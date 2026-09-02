# CHANGELOG v742 — Fix: toast pide un "Estado inactivo" que no existe + modal "Administrar categorías" se abre tapado

## Motivo

El dueño reportó dos problemas en el modal de "Editar producto":

1. Al intentar eliminar un producto con historial (stock/pedidos/movimientos
   asociados), el sistema avisa que hay que "marcarlo como inactivo", pero el
   desplegable **Estado** solo tiene dos opciones: **Activo** y **Archivado**.
   No hay ningún "Inactivo" para elegir.
2. El link **(administrar)**, al lado del combo de Categoría, no parecía
   hacer nada al hacer click.

## Causa real

### 1. Desajuste de vocabulario, no una opción faltante

El campo detrás del combo Estado es simplemente `productos.activo`
(booleano `true`/`false`), mostrado como **Activo** / **Archivado**
(`frontend/admin/productos.html`, select `fp-activo`). Nunca existió un
tercer estado "Inactivo": "Archivado" **es** ese estado — un producto
archivado no se lista en catálogo/ventas pero conserva su historial.

El bug estaba en el texto del toast de error al eliminar
(`eliminarProducto()`, `frontend/admin/js/productos.js`), que decía
*"Marcalo como inactivo en su lugar"* — una palabra que no aparece en
ningún otro lugar de la UI. El comentario del propio código tenía el
mismo desajuste ("campo ESTADO → inactivo"). El dueño buscaba esa opción
en el desplegable, no la encontraba, y por eso reportó el problema como
si faltara un estado.

**Fix:** se corrigió el texto del toast (y el comentario) para decir
"archivado", que es la etiqueta real del desplegable. No se tocó ningún
comportamiento — el flujo de "dar de baja sin borrar" ya funcionaba
correctamente, era solo la palabra la que no coincidía.

### 2. El modal de categorías sí se abre — pero detrás del panel de producto

`abrirModalCategoriasAbm()` sí corre y sí pone
`display:flex`/`display:block` en `#modal-categorias-abm` y
`#modal-backdrop-cat-abm`. El problema es de capas (z-index):

- El panel "Editar producto" (`#modal-producto`) fue fijado a
  `z-index: 9999 !important` en `productos-modal-fix.css`, para
  garantizar que quede por encima de casi todo lo demás en la pantalla
  de Productos.
- El modal de categorías usa la clase genérica `.modal` /
  `.modal-backdrop` (mismas que usa Clientes), cuyo z-index base es
  400/300 — muy por debajo de 9999.
- Ya había pasado exactamente este mismo problema con el modal de
  Receta (BOM), y en su momento se agregó una regla para subirlo por
  encima (`#modal-backdrop-receta` / `#modal-receta` → 10000/10001).
  Esa corrección nunca se replicó para el modal de categorías, que
  quedó con el mismo bug sin resolver.

Resultado: al hacer click en "(administrar)" el modal se renderizaba
igual, pero invisible detrás del panel de producto — daba la sensación
de que el link no hacía nada.

**Fix:** se agregó la misma regla de z-index ya usada para Receta, ahora
también para `#modal-backdrop-cat-abm` (10000) y `#modal-categorias-abm`
(10001), en `frontend/admin/css/productos-modal-fix.css`.

### 3. Botón "Crear" (en Gestionar etiquetas) sin feedback si el campo está vacío

`_onCrearDesdeGestion()` (`frontend/admin/js/etiquetas.js`), llamada por el
botón **Crear** del popover "Gestionar etiquetas", validaba el campo
"Nueva etiqueta..." así: si estaba vacío, hacía `return` sin avisar nada —
ni toast, ni resaltar el campo. Si se hace click en Crear sin haber
escrito un nombre, el botón parece no responder, aunque en realidad está
rechazando el envío en silencio.

**Fix:** ahora, si el campo está vacío, se muestra un toast ("Escribí un
nombre para la etiqueta.") y se enfoca el input, en vez de no hacer nada.

## Archivos modificados

- `frontend/admin/js/productos.js` — texto del toast + comentario.
- `frontend/admin/css/productos-modal-fix.css` — z-index del modal de
  categorías.
- `frontend/admin/js/etiquetas.js` — feedback al hacer click en "Crear"
  con el campo vacío.

## Alcance / pendiente

- No se tocó el modelo de datos ni el endpoint de categorías — el ABM en
  sí ya funcionaba, solo estaba invisible.
- Si en el futuro se agrega algún otro modal secundario abierto **desde
  adentro** de `#modal-producto` (como pasó con Receta y ahora con
  Categorías), hay que acordarse de sumarlo a este mismo bloque de
  z-index en `productos-modal-fix.css` — no hay una regla genérica que
  cubra "cualquier modal hijo", cada uno se agregó a mano.
