-- 623_fix_notas_credito_quitar_tipo_m.sql
--
-- Decisión 2.1 (DECISIONES_OPERATIVAS_2026-09.md, confirmada por CLAY,
-- opción A): se saca 'M' del rango válido de notas_credito.tipo.
--
-- Nunca hubo soporte real para Factura/NC tipo M en wsfev1.js: no existe
-- código de comprobante ARCA para M (TIPO_CBTE no lo define), ni la
-- lógica de umbral RG 3337 (acumulado facturado a 12 meses a un mismo
-- receptor RI) ni la percepción del 3% que ese régimen exige. Estaba
-- ofrecido como opción en el combo del frontend y aceptado por el check
-- de Node, pero era un callejón sin salida:
--   - Una NC "M" vinculada a una factura real terminaba emitiéndose con
--     la letra de esa factura (A/B) -- emitirNotaCreditoARCA toma la
--     letra de facturaOrig.tipo, no de nc.tipo.
--   - Una NC "M" sin factura vinculada fallaba directo al intentar
--     emitirla contra ARCA (emitirNotaCreditoARCA exige facturaOriginalId).
--   - crear_nota_credito solo calcula IVA para tipo IN ('A','B'): una NC
--     "M" quedaba con IVA en $0, igual que tipo C, aunque una Factura M
--     real sí discrimina IVA.
--
-- Verificado antes de aplicar (vía Supabase MCP, RPC real contra la base
-- real jgiquzjwoedmzwqgzubr, sin mocks): 0 filas de notas_credito con
-- tipo fuera de A/B/C en producción (todo el uso real hasta hoy es A/B;
-- ninguna empresa no-demo creó nunca una NC de ningún tipo). No hace
-- falta backfill. Ya aplicada en vivo.
--
-- Si en el futuro un cliente de CLAY factura montos que disparen el
-- régimen de Factura M de verdad, esto se reevalúa como una
-- implementación completa (código de comprobante + umbral + percepción),
-- no reactivando este valor sin más.

ALTER TABLE public.notas_credito
  DROP CONSTRAINT notas_credito_tipo_check;

ALTER TABLE public.notas_credito
  ADD CONSTRAINT notas_credito_tipo_check
  CHECK (tipo = ANY (ARRAY['A'::text, 'B'::text, 'C'::text]));
