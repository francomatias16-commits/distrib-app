# Etapa 6 — Rutas y entregas

**Estado:** 🟢 2/2 hallazgos corregidos en código — pendiente `git push`/deploy
a Vercel. Una corrección manual de datos (caso real en producción) ya
aplicada directamente en Supabase.

> **Nota:** este archivo se reconstruyó el 2026-07-12 a partir de
> `CHANGELOG_v313_etapa6_no_entrega_y_rutas_duplicadas.md` — el detalle
> original de la etapa 6 se había perdido (mismo problema de otros archivos
> de esta auditoría) y el índice la marcaba erróneamente como "pendiente".

## Hallazgo 1 — Flujo de "no se pudo entregar" inexistente para el chofer
🔴 Alta

El estado `entregas.estado = 'no_entregado'` ya se mostraba en el admin, la
columna `motivo_no_entrega`, el template de WhatsApp
(`entrega_no_realizada`) y la documentación
(`docs/ayuda/rutas-y-entregas.md`) ya existían — pero ningún botón ni
endpoint alcanzable por el chofer permitía generarlo. La única función
relacionada (`manejarNoEntregado` en `notif.js`) no tenía ningún caller en
todo el repo y, además, marcaba el pedido como `cancelado` en vez de
dejarlo disponible para reprogramar, como indica la documentación.

**Estado:** ✅ Corregido en código.
- Nuevo endpoint `PATCH /api/chofer/remitos/:id/no-entregar`
  (`lib/handlers/pedidos.js`): valida motivo, exige
  `pedido.estado === 'despachado'`, actualiza la fila de `entregas` activa
  (`pendiente`/`en_camino`, nunca un update ciego por `pedido_id`),
  revierte el pedido a `confirmado` y notifica por WhatsApp (best-effort).
- `notif.js` → `manejarNoEntregado` corregido: ya no escribe estado del
  pedido; queda acotada a enviar la notificación de WhatsApp.
- Nuevo botón "No se pudo entregar" + modal (motivo, notas, foto opcional)
  en `frontend/chofer/remito.html`, visible cuando el pedido está
  `despachado`, junto a "Marcar entregado".

## Hallazgo 2 — Un pedido podía quedar asignado a más de una ruta activa
🔴 Alta-media

La query de "pedidos disponibles" para armar una ruta (admin) decía en el
comentario "sin ruta asignada" pero solo filtraba por `estado`, sin
verificar si el pedido ya tenía una entrega activa en otra ruta. El
endpoint `agregar-urgente` tenía el mismo gap. Se confirmó en producción un
caso real con 3 filas de `entregas` en estado `pendiente` simultáneas para
el mismo pedido, en 3 rutas distintas (una de ellas ya cancelada).

**Estado:** ✅ Corregido en código + base.
- `frontend/admin/js/rutas.js`: la query de pedidos disponibles ahora
  excluye los que ya tienen una entrega activa (`pendiente`/`en_camino`)
  en otra ruta.
- `lib/handlers/rutas-live.js`: `agregar-urgente` valida lo mismo antes de
  insertar.
- `cancelarRuta` (`rutas.js`) ya no deja las `entregas` de la ruta
  cancelada huérfanas en `pendiente` para siempre — ahora se cierran.
- Índice único parcial en base (aplicado directo en Supabase, sin archivo
  de migración versionado en el repo):
  `idx_entregas_pedido_activo_unico ON entregas(pedido_id) WHERE estado IN ('pendiente','en_camino')`
  como red de seguridad a nivel esquema.
- `pedidos.js` (`entregar`): el update de `entregas` al confirmar entrega
  ahora está acotado a la fila activa.

## Corrección manual de datos (no repetible, ya aplicada en producción)
Se resolvió a mano el caso real encontrado (pedido `7b791cf3...`, 3
entregas duplicadas) tras confirmar con el usuario que la entrega real fue
la ruta del 6/7. Aplicada directamente vía Supabase MCP durante la
auditoría — no requiere acción adicional.

## Pendiente
- `git push` / deploy a Vercel del código (endpoint, frontend, handlers).
  La corrección de datos y el índice único de base ya están activos en
  producción.
