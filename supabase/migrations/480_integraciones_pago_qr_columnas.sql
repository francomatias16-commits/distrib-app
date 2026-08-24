-- 480_integraciones_pago_qr_columnas.sql
-- Cobro presencial con QR de Mercado Pago (POS) — Fase QR.
--
-- Agrega a integraciones_pago los datos que devuelve la API de MP al crear
-- la Store y el POS (Point of Sale) asociados a la cuenta que el cliente ya
-- conectó en Admin → Pagos (mismo access_token que usa Checkout Pro/Point,
-- ver lib/handlers/pagos.js). No se agregan tablas nuevas: es la misma
-- integración, con los campos que le faltan para el flujo de QR dinámico
-- (Instore Orders API).
--
--   mp_user_id  → id de usuario de MP dueño de la cuenta (requerido por los
--                 endpoints /instore/... que llevan el user_id en el path).
--   store_id    → id de la Store creada en MP (POST /users/{id}/stores).
--   pos_id      → external_id del POS creado en MP (POST /pos). Es el que
--                 se usa en el PUT de /instore/orders/qr/... para "cargar"
--                 el monto de cada venta sobre el mismo QR impreso/mostrado.
--   qr_image    → URL (https, la sirve MP) a la imagen del QR, devuelta al
--                 crear el POS — se guarda para no tener que recrear el POS
--                 cada vez que el admin entra a la pantalla de cobro QR.
--
-- Todas nullable: una empresa puede tener Checkout Pro conectado (para
-- pagos online de pedidos) sin haber configurado todavía el cobro
-- presencial por QR del POS — son pasos separados que el admin activa
-- cuando quiere.

ALTER TABLE integraciones_pago
  ADD COLUMN IF NOT EXISTS mp_user_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS store_id   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS pos_id     VARCHAR(50),
  ADD COLUMN IF NOT EXISTS qr_image   TEXT;

COMMENT ON COLUMN integraciones_pago.mp_user_id IS 'user_id de Mercado Pago dueño de la cuenta conectada (requerido por la Instore Orders API)';
COMMENT ON COLUMN integraciones_pago.store_id   IS 'id de la Store de MP asociada a esta empresa (cobro QR presencial en POS)';
COMMENT ON COLUMN integraciones_pago.pos_id     IS 'external_id del POS de MP — se usa para cargar el monto de cada venta sobre el QR fijo del POS';
COMMENT ON COLUMN integraciones_pago.qr_image   IS 'URL (https, servida por Mercado Pago) a la imagen del QR fijo devuelta al crear el POS — se muestra en pantalla en caja para que el cliente la escanee';
