# v313 — Auditoría 2026, Etapa 6: flujo de "no entrega" + rutas duplicadas

## Hallazgo 1 — Flujo de "no se pudo entregar" inexistente para el chofer
El estado `entregas.estado = 'no_entregado'` ya se mostraba en el admin, la
columna `motivo_no_entrega`, el template de WhatsApp (`entrega_no_realizada`)
y la documentación (`docs/ayuda/rutas-y-entregas.md`) ya existían — pero
ningún botón ni endpoint alcanzable por el chofer permitía generarlo. La
única función relacionada (`manejarNoEntregado` en `notif.js`) no tenía
ningún caller en todo el repo y, además, marcaba el pedido como `cancelado`
en vez de dejarlo disponible para reprogramar como indica la documentación.

**Fix:**
- Nuevo endpoint `PATCH /api/chofer/remitos/:id/no-entregar` (`pedidos.js`):
  valida motivo, exige `pedido.estado === 'despachado'`, actualiza la fila
  de `entregas` activa (`pendiente`/`en_camino`, nunca un update ciego por
  `pedido_id`), revierte el pedido a `confirmado` y notifica por WhatsApp
  (best-effort).
- `notif.js` → `manejarNoEntregado` corregido: ya no escribe estado del
  pedido (compartía sección con lo anterior, corría el riesgo de pisar el
  estado seteado por el nuevo endpoint autenticado); queda acotada a
  enviar la notificación de WhatsApp.
- Nuevo botón "No se pudo entregar" + modal (motivo, notas, foto opcional)
  en `frontend/chofer/remito.html`, visible cuando el pedido está
  `despachado`, junto a "Marcar entregado".

## Hallazgo 2 — Un pedido podía quedar asignado a más de una ruta activa
La query de "pedidos disponibles" para armar una ruta (admin) decía en el
comentario "sin ruta asignada" pero solo filtraba por `estado`, sin
verificar si el pedido ya tenía una entrega activa en otra ruta. El
endpoint `agregar-urgente` tenía el mismo gap. Se confirmó en producción
un caso real con 3 filas de `entregas` en estado `pendiente` simultáneas
para el mismo pedido, en 3 rutas distintas (una de ellas ya cancelada).

**Fix:**
- `frontend/admin/js/rutas.js`: la query de pedidos disponibles ahora
  excluye los que ya tienen una entrega activa (`pendiente`/`en_camino`)
  en otra ruta.
- `lib/handlers/rutas-live.js`: `agregar-urgente` valida lo mismo antes de
  insertar.
- `cancelarRuta` (`rutas.js`) ya no deja las `entregas` de la ruta
  cancelada huérfanas en `pendiente` para siempre — ahora se cierran.
- Índice único parcial en base:
  `idx_entregas_pedido_activo_unico ON entregas(pedido_id) WHERE estado IN ('pendiente','en_camino')`
  como red de seguridad a nivel esquema.
- `pedidos.js` (`entregar`): el update de `entregas` al confirmar entrega
  ahora está acotado a la fila activa (antes no filtraba por estado, y con
  más de una fila histórica por `pedido_id` posible tras el fix de
  reprogramación, podía marcar como entregada una fila incorrecta).

## Corrección manual de datos (no repetible, ya aplicada en producción)
Se resolvió a mano el caso real encontrado (pedido `7b791cf3...`, 3 entregas
duplicadas) tras confirmar con el usuario que la entrega real fue la ruta
del 6/7. Ver migración `etapa6_correccion_manual_pedido_duplicado_y_no_entrega`
ya aplicada directamente vía Supabase MCP durante la auditoría — no requiere
acción adicional.
