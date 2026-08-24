-- 481_integraciones_pago_prisma_columnas.sql
-- Terminal de pago Prisma (Paystore terminals API) — reemplaza al driver
-- "Lapos" del POS, que nunca fue una integración real (WebSocket local
-- inventado). No se crea tabla nueva: `integraciones_pago` ya es genérica
-- por proveedor (columna `proveedor`, UNIQUE(empresa_id, proveedor) desde
-- 010_etapa7_fidelizacion.sql) — se usa una fila con proveedor='prisma'.
--
-- access_token guarda el Bearer token de Prisma, cifrado igual que el de
-- Mercado Pago (lib/crypto-secrets.js). cuit_cuil es el único dato extra
-- que Prisma necesita como query param en cada request y que MP no tiene
-- equivalente, así que no había columna previa para reusar.
--
-- NOTA: el token de Prisma expira (a diferencia del access_token de larga
-- vida de MP) y todavía no tenemos documentado el endpoint de autenticación
-- para refrescarlo solo — por ahora se repega a mano (ver comentario en
-- guardarConfigPrisma, lib/handlers/pagos.js).

ALTER TABLE integraciones_pago
  ADD COLUMN IF NOT EXISTS cuit_cuil VARCHAR(20);

COMMENT ON COLUMN integraciones_pago.cuit_cuil IS 'CUIT/CUIL del comercio en PayStore (Prisma) — requerido como query param en cada request a la Terminal Payments API';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '481_integraciones_pago_prisma_columnas.sql', '481', 'claude-session', 'Agrega integraciones_pago.cuit_cuil para la integración de terminal de pago Prisma (Paystore terminals API), que reemplaza al driver "Lapos" del POS (WebSocket local inventado, sin agente real del otro lado). Reusa integraciones_pago con proveedor=''prisma'' — sin tabla nueva')
ON CONFLICT DO NOTHING;

