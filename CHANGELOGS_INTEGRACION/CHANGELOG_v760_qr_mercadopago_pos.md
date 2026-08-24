# v760 — Cobro con QR de Mercado Pago en el POS + fix stale-cache (v759)

## ⚠️ Update tras validar contra la documentación oficial de MP
Antes de que lo probaras contra una cuenta de test, revisé el flujo de QR
línea por línea contra la Referencia API de Mercado Pago (no lo había hecho
al escribirlo la primera vez) y encontré dos bugs reales:

1. **Endpoint de la orden mal armado.** Tenía
   `PUT /instore/orders/qr/seller/collectors/{user_id}/pos/{pos_id}/orders`.
   El endpoint real (Órdenes presenciales V2) es
   `PUT /instore/qr/seller/collectors/{user_id}/stores/{external_store_id}/pos/{external_pos_id}/orders`
   — lleva el `store_id` en el path (el externo, no el numérico) y el
   nombre del recurso es `instore/qr/...`, no `instore/orders/qr/...`.
   Con la URL vieja, cada intento de cobro devolvía 404.
2. **`fetchMP()` no soportaba 204.** Esa misma orden, si sale bien,
   responde `204 No Content` (sin body) — el helper hacía
   `response.json()` a ciegas y explotaba con "Unexpected end of JSON
   input" incluso si el cobro se había cargado correctamente en MP.
3. (Menor) `qr.image` que devuelve `POST /pos` es una **URL https**
   servida por MP, no un string base64 — el código lo envolvía en un
   `data:image/png;base64,...` innecesario. Ya usa la URL tal cual.

Los tres están corregidos en este paquete. El resto del payload (creación
de Store, creación de POS, búsqueda de pago por `external_reference`) sí
coincidía con la documentación.

Sigue sin probarse contra la API real — no tengo salida de red hacia
`api.mercadopago.com` desde este entorno — pero ahora está verificado
contra la Referencia API oficial punto por punto, no solo de memoria.

## Integrado en este paquete
1. **v759** (adjuntado): fix del bug "hay que hacer Ctrl+Shift+R para ver el
   dato nuevo" en `frontend/admin/sw-admin.js` — se vació `SWR_PATTERNS` y
   se movieron los 12 endpoints afectados a `NETWORK_ONLY_PATTERNS`.
   `SW_VERSION` subido a `admin-v150`.
2. **Cobro presencial con QR en el POS** (continuación de lo charlado en el
   chat adjunto — arranca con "token manual por cliente", sin OAuth,
   reusando la misma cuenta que ya conectan en Admin → Pagos para Checkout
   Pro/Point).

## Cómo queda armado el QR
Reusa el `access_token` ya guardado en `integraciones_pago` — no hay una
segunda conexión ni credenciales nuevas que pedirle al cliente.

- **Migración 480** (`480_integraciones_pago_qr_columnas.sql`): agrega
  `mp_user_id`, `store_id`, `pos_id`, `qr_image` a `integraciones_pago`
  (todas nullable — el checkout online sigue funcionando sin esto).
- **`lib/repos/pagos.js`**: `obtenerIntegracionMPParaQr` y
  `guardarStoreYPosQr` (esta última ahora acepta un objeto parcial, para
  poder guardar store y POS en dos pasos sin pisar el otro campo con null).
- **`lib/handlers/pagos.js`** — 3 endpoints nuevos, todos bajo `/api/pagos`:
  - `_svc=pos-qr-setup` (GET/POST, rol dueño/admin): crea la Store y el POS
    en la cuenta de MP del cliente (Instore Orders API) y guarda el QR fijo
    (`qr_image`, URL a la imagen). Se hace **una sola vez** por empresa — el
    admin carga nombre de sucursal + dirección en un formulario nuevo en
    `mercadopago-config.html`. `store_id`/`pos_id` externos (los que usa la
    URL de la orden) se derivan siempre de `empresa_id` — nunca se
    reconstruyen a mano ni pueden desincronizarse de lo guardado.
  - `_svc=pos-qr-cobrar` (POST, rol dueño/admin/vendedor): "carga" el monto
    de la venta actual sobre ese mismo QR ya impreso/mostrado (PUT a la
    orden del POS) — no genera un QR nuevo por venta.
  - `_svc=pos-qr-verificar` (GET, mismos roles): busca el pago por
    `external_reference` contra la API de MP — usado para polling desde la
    pantalla de caja mientras el cliente escanea.
  - Rutas agregadas a `vercel.json` (mismo patrón que `/api/pagos/config`).
- **Frontend**:
  - `frontend/admin/mercadopago-config.html`: nueva card "Cobro con QR en
    caja" (solo visible si ya hay cuenta conectada) — formulario de
    dirección de la sucursal + botón "Activar QR en el POS" + preview del
    QR una vez configurado.
  - `frontend/admin/js/pos-terminal.js`: nuevo driver `mp_qr` en el mismo
    módulo `PosTerminal` que ya maneja Point/Getnet/Lapos/Naranja — a
    diferencia de `mp_point`, el `access_token` **nunca viaja al
    frontend**: el POS solo le pide al backend que cargue el monto y
    pollea el resultado. Aparece automático en el selector de terminal de
    Admin → Hardware (lee de `getTerminalesSoportadas()`).

## Pendiente / próximo paso
- El webhook (`manejarWebhook`) hoy solo actualiza `transacciones_pago`
  (pagos online por `pedido_id`) — los pagos de QR en el POS **no** tienen
  fila en esa tabla, así que la notificación de MP para una venta QR cae en
  el branch `empresa no resuelta` (no rompe nada, pero no hace nada). La
  confirmación real de una venta QR depende hoy 100% del polling desde
  `pos-qr-verificar`; falta decidir si conviene además registrar algo en
  `transacciones_pago` (o una tabla nueva) para trazabilidad/reconciliación
  contable de las ventas cobradas por QR.
- **Todavía no se probó contra una cuenta de test real** — recomendado
  antes de habilitarlo a un cliente. Como no hay salida de red desde este
  entorno hacia `api.mercadopago.com`, la validación end-to-end (crear
  Store/POS de verdad, escanear el QR, confirmar el webhook/polling) tiene
  que correrla alguien con acceso a internet — yo puedo revisar los
  resultados/errores que te tire si me los pasás.
- La guía en lenguaje simple para que cada cliente sepa completar el
  formulario de sucursal (nombre, calle, ciudad, provincia) queda
  pendiente de redactar, mismo criterio que se usa para el Access Token.

