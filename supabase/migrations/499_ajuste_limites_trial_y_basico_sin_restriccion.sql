-- Ajuste de límites comerciales, a pedido de negocio (ago-2026).
-- Motivo: los límites de trial (1 usuario/50 clientes/100 pedidos) resultaban
-- muy bajos para hacer una demo con datos reales; el plan básico mantenía
-- límites (3 usuarios/200 clientes) pese a que la intención comercial es que
-- sea "sin restricciones" a partir del plan pago de entrada.
--
-- Cambios:
--   trial:      1/50/100 -> 3/200/1000 (sigue siendo trial, ahora más usable en demo)
--   basico/pro/enterprise -> NULL/NULL/NULL (sin restricciones de ningún tipo en
--   ningún plan pago; se diferencian por funciones -multisucursal, condiciones a
--   medida-, no por cupos de uso).
--
-- Nota: en la base real (proyecto jgiquzjwoedmzwqgzubr) pro y enterprise tenían
-- topes (15/3.000/6.000 y 50/20.000/50.000) que no estaban reflejados en la
-- migración semilla 137 de este repo (que los dejaba en NULL). Esta migración
-- deja el repo y la base reales alineados y sin límites en los tres planes pagos.

UPDATE public.planes_limites
SET max_usuarios = 3, max_clientes = 200, max_pedidos_mes = 1000, updated_at = now()
WHERE tier = 'trial';

UPDATE public.planes_limites
SET max_usuarios = NULL, max_clientes = NULL, max_pedidos_mes = NULL, updated_at = now()
WHERE tier IN ('basico', 'pro', 'enterprise');
