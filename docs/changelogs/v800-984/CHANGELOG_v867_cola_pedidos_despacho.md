# v867 — Rediseño de la cola de pedidos para despachar

## Objetivo

Hacer más simple y legible la selección de pedidos al armar una ruta,
reemplazando la grilla de recuadros repetidos por una cola operativa.

## Cambios

- Los pedidos ahora se muestran como filas planas con columnas consistentes:
  cliente/dirección, zona/fecha, total y acción.
- La selección permanece visible en la misma lista: una fila seleccionada queda
  resaltada y se puede quitar haciendo click nuevamente.
- Se agregaron indicadores superiores de pedidos disponibles y pedidos ya
  incluidos en la ruta.
- Se agregó selección masiva de los pedidos visibles y limpieza de selección.
- La búsqueda conserva el contexto completo de cada pedido y muestra estados
  de filtro sin confundirlos con una lista vacía.
- Se mantiene la agrupación por zona, pero con encabezados más claros y sin
  tarjetas anidadas.
- Se mantuvieron las mismas consultas y el mismo flujo de confirmación de ruta.