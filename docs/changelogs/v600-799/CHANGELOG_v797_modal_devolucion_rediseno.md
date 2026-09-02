# v797 — Modal "Registrar devolución": deja de requerir scroll infinito

## Problema
El modal completo (header + datos generales + buscador + grilla de
productos + ítems ya cargados + footer) scrolleaba como un solo bloque
(`#modal-nueva-devolucion { overflow-y: auto }`). Para llegar a
"Registrar devolución" había que scrollear pasando por una grilla de
productos potencialmente larga.

## Cambios

### Estructura (`devoluciones.html`)
- El modal pasa a layout flex-column: **header fijo**, **footer fijo**,
  y solo el contenido del medio (`.nd-modal-scroll`) scrollea.
- Se separó "Ítems devueltos" en dos secciones claras: "Buscar
  productos" (el picker) y "Seleccionados" (lo que ya se cargó), con
  contador visible.

### Estilos (`devoluciones-gentelella.css`)
- `#modal-nueva-devolucion`: `overflow: hidden` + `display:flex` en vez
  de scroll de bloque único.
- `.nd-modal-scroll`: `flex:1; overflow-y:auto` — acá vive todo el
  contenido variable.
- `.nd-items-lista` (panel "Seleccionados"): tope de alto propio
  (190px) con su scroll, para que agregar muchos ítems no vuelva a
  estirar el modal.
- Grilla del picker (`.pp-grid` dentro de este modal) bajada a 230px
  para no competir con el scroll general (evita doble scrollbar
  anidado).
- Footer rediseñado: resumen a la izquierda ("3 ítems · 12 u. ·
  $19.732,00"), botones Cancelar/Registrar a la derecha — **siempre
  visible, sin scroll**.

### Lógica (`devoluciones.js`)
- `renderNdItems()` ahora también actualiza el badge de "Seleccionados"
  y el resumen del footer.
- `ndActualizarItem()` refresca el resumen del footer al editar
  cantidad/precio sin re-renderizar toda la lista (no pierde el foco
  del input).

## Resultado
Cliente, motivo, buscador y lista de seleccionados quedan en el área
scrolleable; el resumen y los botones de acción están siempre a la
vista, sin importar cuántos productos tenga el catálogo.
