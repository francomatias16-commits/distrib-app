# CHANGELOG v738 — Gestión de etiquetas integrada al panel de filtros de Productos

## Resumen

Se integran los archivos actualizados de Productos (recibidos por separado) sobre
la base v737, agregando administración completa del catálogo de etiquetas
(crear / renombrar / recolorear / eliminar) directamente desde un popover en el
panel de filtros de la pantalla de Productos, sin necesidad de una página aparte.

## Archivos modificados

- `frontend/admin/js/etiquetas.js`
  - Nuevas funciones en la API pública del módulo `Etiquetas`:
    - `actualizar(etiquetaId, { nombre?, color? })` → `Promise<etiqueta>`
    - `eliminarEtiqueta(etiquetaId)` → `Promise<void>`
    - `renderGestion(containerId, { onCambio? })` → renderiza el CRUD del
      catálogo de etiquetas de la empresa.
  - `eliminarEtiqueta` se apoya en el `ON DELETE CASCADE` de
    `entidad_etiquetas.etiqueta_id` (definido en v473), por lo que al borrar
    una etiqueta también se la quita de todo lo que la tuviera asignada.
  - El popover de gestión inyecta sus propios estilos en `<head>` bajo el id
    `et-styles` (una sola vez), en vez de depender de reglas CSS estáticas.

- `frontend/admin/productos.html`
  - El `<select>` de filtro por etiqueta ahora está envuelto en
    `.prod-etiqueta-filtro-wrap`, junto a un botón "Gestionar etiquetas"
    (ícono de engranaje) que abre el popover `#popover-gestion-etiquetas`
    con el body `#gestion-etiquetas-body`.

- `frontend/admin/js/productos.js`
  - Nueva función `toggleGestionEtiquetas(ev)` que abre/cierra el popover y
    llama a `Etiquetas.renderGestion('gestion-etiquetas-body', { onCambio })`
    para refrescar el `<select>` de filtro y la lista de productos ante
    cualquier alta, edición o baja de etiquetas.
  - Manejo de cierre del popover al hacer clic fuera de
    `.prod-etiqueta-filtro-wrap`.

- `frontend/admin/css/productos.css`
  - Estilos de layout para `.prod-etiqueta-filtro-wrap` y el botón de
    gestión; los estilos del popover en sí (`.et-gestion-popover`,
    `.et-gestion-fila`, `.et-swatch`, etc.) se inyectan dinámicamente desde
    `etiquetas.js`.

## Compatibilidad

Cambios aditivos sobre la base v737 — no se removió funcionalidad existente
del filtro por etiqueta (`onFiltroEtiqueta`, `prod-filtro-etiqueta`), solo se
lo envolvió en un contenedor nuevo y se sumó el botón/popover de gestión.
