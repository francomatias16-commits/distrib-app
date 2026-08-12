-- 430_trigger_sincronizar_total_cobrado_factura_pos.sql
-- Documenta en el repo el fix ya aplicado en producción (auditoría Cobranzas/POS, v532).
--
-- Bug: el cálculo de "cuánto ya se cobró en caja" al emitir una factura de
-- venta POS vivía solo en lib/facturas.js (Node). Si fallaba ahí (bug,
-- deploy a medias, factura creada por una ruta de código vieja), la
-- factura nacía marcada "pendiente" con total_cobrado = 0 aunque la venta
-- ya estuviera 100% cobrada en el momento.
-- Caso real encontrado: factura de la venta POS-20260720-00014 (consumidor
-- final, $1.210 en efectivo) con total_cobrado = 0.
--
-- Fix sistémico: trigger BEFORE INSERT en facturas que recalcula
-- total_cobrado en la base de datos misma para toda factura ligada a
-- venta_pos_id — independiente de que el código de la app lo calcule bien.
-- Lo que no quedó a cuenta corriente ya está cobrado.
-- No afecta facturas de pedidos (venta_pos_id IS NULL) — esas siguen su
-- flujo normal (nacen en 0, se cobran vía registrar_cobro_completo).
-- Incluye backfill retroactivo de las facturas ya afectadas.

CREATE OR REPLACE FUNCTION public.fn_sincronizar_cobrado_factura_pos()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_monto_cta_cte NUMERIC;
BEGIN
  IF NEW.venta_pos_id IS NOT NULL THEN
    SELECT COALESCE(SUM(monto), 0) INTO v_monto_cta_cte
    FROM venta_pos_pagos
    WHERE venta_pos_id = NEW.venta_pos_id
      AND medio = 'cuenta_corriente';

    NEW.total_cobrado := GREATEST(0, COALESCE(NEW.total, 0) - v_monto_cta_cte);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sincronizar_cobrado_factura_pos ON public.facturas;

CREATE TRIGGER trg_sincronizar_cobrado_factura_pos
BEFORE INSERT ON public.facturas
FOR EACH ROW
EXECUTE FUNCTION public.fn_sincronizar_cobrado_factura_pos();

-- Corrección retroactiva: aplica la misma fórmula a las facturas POS que
-- ya existen y quedaron mal cargadas (incluye el caso POS-20260720-00014
-- detectado antes, y cualquier otro con el mismo patrón).
UPDATE public.facturas f
SET total_cobrado = GREATEST(0, f.total - COALESCE((
  SELECT SUM(pp.monto) FROM venta_pos_pagos pp
  WHERE pp.venta_pos_id = f.venta_pos_id AND pp.medio = 'cuenta_corriente'
), 0))
WHERE f.venta_pos_id IS NOT NULL
  AND f.estado <> 'anulada';
