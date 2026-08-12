# v708 — Fix: Service Worker cacheaba el precio del catálogo cliente (SWR)

## Contexto

Pase manual de F4-02 (checklist_pase_manual.md): con "Supermercado La
Esquina" logueado en `/cliente/login` (no vista previa admin), el
catálogo mostraba el precio de lista normal de Coca Cola 2.25L en vez
del precio especial ($1.600) configurado en `precios_clientes`.

## Diagnóstico

Se descartó capa por capa, de atrás hacia adelante:

1. **Supabase en vivo** — `resolver_precios_cliente()` llamada con los
   mismos argumentos exactos que usa el handler devuelve
   `{precio: 1600.00, origen: "especial"}`. Correcto.
2. **Dato** — fila en `precios_clientes` bien cargada (cliente/producto
   correctos).
3. **Usuario** — `usuarios` del cliente activo, con `cliente_id` bien
   seteado.
4. **Handler** (`lib/handlers/stock.js` → `handleClienteProductos`) —
   resuelve `resolverClienteIdSiAutenticado`, llama a la RPC, pisa
   `precio_base`/`origen_precio` si hay resultado. Código correcto.

Causa real: **`frontend/cliente/sw-cliente.js`**. El fix F4-02 (sesión
anterior) cambió `/api/cliente/productos` de "catálogo genérico" a
"catálogo con precio real resuelto por cliente" — pero el endpoint
había quedado en `SWR_PATTERNS` (stale-while-revalidate) desde antes de
ese fix, categoría pensada para datos "bajo riesgo" que no son plata.
Con SWR el Service Worker sirve la respuesta cacheada al toque
(precio_base viejo/genérico) y recién revalida en segundo plano — el
usuario no ve el precio corregido hasta la carga siguiente. El propio
comentario del archivo decía "Nunca cachear: precio/stock en tiempo
real, dinero..." pero el endpoint no se había movido de categoría al
dejar de ser genérico.

## Fix

- `frontend/cliente/sw-cliente.js`: `/api/cliente/productos` movido de
  `SWR_PATTERNS` a `NETWORK_ONLY_PATTERNS`, con comentario explicando
  el motivo. `/api/cliente/categorias` y `/api/fidelizacion` quedan en
  SWR (no llevan precio resuelto por cliente).
- No hace falta bumpear `SW_VERSION` a mano — `bump-sw-version.js` lo
  hace en cada build/deploy, así que la caché vieja se descarta sola.

## Pendiente

- Re-probar el paso 4 de F4-02 con este fix deployado (ver
  `checklist_pase_manual.md`).
