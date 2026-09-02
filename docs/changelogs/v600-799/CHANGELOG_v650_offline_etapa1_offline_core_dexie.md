# CHANGELOG v650 — Plan offline, Etapa 1: OfflineCore genérico (Dexie)

**Fecha:** 2026-08-07.

## Qué cambió

Etapa 1 del plan offline cerrada: reemplazado el patrón manual de
IndexedDB (repetido a mano en pos-offline.js, chofer-offline.js,
cliente-offline.js y stock-offline.js v1) por una sola capa reutilizable:

- **`frontend/shared/offline-core.js`** (nuevo) — `OfflineCore.crearOutbox()`
  (cola FIFO genérica de escrituras pendientes, con badge de estado y
  Background Sync best-effort) y `OfflineCore.crearCache()` (caché de
  solo lectura con TTL por entidad). Una Dexie DB por portal.

- **`frontend/admin/js/stock-offline.js` → v2** — reescrito sobre
  OfflineCore. API pública (`window.StockOffline`) sin cambios.

- **`frontend/admin/js/pos-offline.js` → v2** — outbox de ventas +
  cache de catálogo sobre OfflineCore. Mantiene el nombre de DB
  (`pos_offline_db`) y agrega una **migración one-shot** que reencola
  cualquier venta pendiente que haya quedado en la cola vieja (v1,
  IndexedDB manual) antes de que Dexie tome la DB en la versión nueva —
  ningún vendedor pierde ventas ya encoladas por el cambio de schema.
  API pública (`window.PosOffline`) sin cambios.

- **`frontend/chofer/chofer-offline.js` → v2** — mismo outbox genérico;
  la lógica de subida de fotos/firma por tipo (entregar / no_entregar /
  devolución) se movió tal cual a `procesarAccion`. API pública
  (`window.ChoferOffline`) sin cambios.

- **`frontend/cliente/cliente-offline.js` → v2** — outbox de un solo
  tipo (`pedido`), sigue exigiendo `idempotency_key` en el payload
  (fast-path de deduplicación de `crear_pedido_cliente()`, migración 443).
  API pública (`window.ClienteOffline`) sin cambios.

- **Background Sync (best-effort)** agregado en los 3 Service Workers
  (`sw-admin.js` v149, `sw-chofer.js` v163, `sw-cliente.js` v2): listener
  `'sync'` que reenvía el tag a las pestañas abiertas vía `postMessage`
  — el SW no tiene la sesión del usuario, así que es la página la que
  dispara el sync real al recibir el mensaje.

- HTML actualizado (`stock.html`, `pos.html`, `remito.html`,
  `carrito.html`): agregado `<script>` de Dexie (CDN) + `offline-core.js`
  antes de cada `*-offline.js`.

## Compatibilidad

Ningún call site externo (`pos.js`, `stock.js`, `remito.html`,
`carrito.html`) necesitó cambios — las 4 APIs públicas
(`window.PosOffline`, `window.StockOffline`, `window.ChoferOffline`,
`window.ClienteOffline`) se preservaron exactamente.

## Pendiente (Etapa 3, resto)

- Ítem 4: cobros sueltos (no atados a una entrega).
- Ítem 5: transferencias entre depósitos.
