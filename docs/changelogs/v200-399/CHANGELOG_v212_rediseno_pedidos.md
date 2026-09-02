# CHANGELOG v212 — Rediseño visual de Pedidos + fix vendedor UUID

## 1. Bug corregido: la columna "Vendedor" mostraba el UUID crudo
`p._vendedor_nombre` nunca se poblaba en ningún lado del código — la
variable no existía, así que siempre caía al fallback `p.vendedor_id`
(el UUID). Se agregó `vendedoresMap` (id → nombre), poblado desde
`cargarFiltrosSecundarios()`, y ahora `renderTabla()` y la exportación a
Excel/CSV resuelven el nombre real contra ese mapa. También se cambió el
orden de carga en `init()` (antes `Promise.all`, ahora secuencial:
filtros primero, pedidos después) para que el primer render ya tenga el
mapa listo y no titile mostrando el UUID por una fracción de segundo.

## 2. Rediseño visual de la sección Pedidos
- **Layout de dos columnas**: la tabla principal ahora convive con un
  panel lateral (`.pedidos-grid-side`) con:
  - Card de resumen del mes (pedidos del mes + total facturado, calculado
    en vivo en `renderStatsLaterales()` a partir de `pedidos`).
  - Card de conteo por estado (Confirmado / Preparando / Despachado /
    Entregado), también en vivo.
  - Card de upsell hacia el plan Pro (WhatsApp + ARCA), con el gradiente
    verde de marca.
  - En pantallas angostas (`max-width: 1180px`) el panel pasa a fila
    horizontal debajo de la tabla en vez de columna lateral.
- **Celda de cliente con avatar de iniciales**: cada fila muestra un
  círculo de color (hash determinístico por nombre, así el mismo cliente
  siempre tiene el mismo color) con las iniciales, en vez de solo texto
  plano — mismo patrón que la mayoría de las apps SaaS modernas (Linear,
  Attio, etc.) usan para filas de listas.
- Se mantiene intacto el modal de detalle del pedido (transiciones de
  estado, WhatsApp, FEFO, remito) — no se reescribió esa lógica porque
  ya funciona y tiene bastante superficie de negocio; solo se le montó
  el nuevo look a la tabla y al layout general.

## Archivos tocados
- `frontend/admin/js/pedidos.js`
- `frontend/admin/pedidos.html`
- `frontend/admin/css/pedidos.css`
(cache-busting subido a `v212` en ambos assets)

## Seguía viniendo de v211
- Paginación de 20 pedidos por página (ver `CHANGELOG_v211_pedidos_paginacion.md`).
