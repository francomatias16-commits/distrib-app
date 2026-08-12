-- 315_etapa9_fix_aplicar_nota_credito_cta_cte.sql
-- AUDITORIA_2026/etapas_modulos — Etapa 9 (Notas de crédito y débito / devoluciones)
--
-- Hallazgo 1 (crítico): el INSERT INTO cta_cte dentro de esta función usaba
-- la columna legacy "importe" (que el frontend ni lee — cta-cte.js solo usa
-- m.monto) y directamente omitía "empresa_id" y "monto", ambas NOT NULL sin
-- default. Resultado: el INSERT fallaba SIEMPRE (23502 not-null violation),
-- lo que revertía toda la función -- incluida la UPDATE que marca la NC como
-- 'emitida'. Como lib/handlers/facturas.js nunca revisaba el error de este
-- RPC, la falla era 100% silenciosa: el admin veía "NC emitida" en el
-- frontend pero la NC quedaba en estado 'pendiente' para siempre y el
-- cliente nunca recibía el crédito en cta_cte.
--
-- Verificado en vivo contra una NC pendiente real antes del fix (rollback
-- automático, sin efectos persistidos): 42 notas_credito en estado
-- 'emitida' en producción, 0 filas en cta_cte con ese origen -- esas 42 son
-- datos de demo cargados directo por SQL (migración comercialización jul
-- 5-6), no productos de este flujo.
--
-- Fix: usar "monto" (magnitud positiva, como espera el CASE de
-- sync_saldo_deuda_cliente() para tipo='credito', que ya lo resta) y
-- agregar "empresa_id" al INSERT.
--
-- NOTA: esta migración ya fue aplicada directamente en Supabase
-- (jgiquzjwoedmzwqgzubr) durante la auditoría y verificada en vivo. Se
-- versiona acá para que quede en el repo / historial de migraciones.

CREATE OR REPLACE FUNCTION public.aplicar_nota_credito_cta_cte(
  p_empresa_id uuid,
  p_nc_id      uuid,
  p_nc_numero  text,
  p_cae        text DEFAULT NULL::text,
  p_cae_vto    date DEFAULT NULL::date,
  p_pdf_url    text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_nc notas_credito%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  SELECT * INTO v_nc FROM notas_credito
   WHERE id = p_nc_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nota de crédito no encontrada';
  END IF;

  UPDATE notas_credito
     SET numero      = p_nc_numero,
         cae         = p_cae,
         cae_vto     = p_cae_vto,
         pdf_url     = p_pdf_url,
         estado      = 'emitida',
         notas_error = NULL,
         updated_at  = now()
   WHERE id = p_nc_id;

  INSERT INTO cta_cte
    (empresa_id, cliente_id, tipo, monto, factura_id, nro_comprobante, descripcion, fecha)
  VALUES (
    p_empresa_id,
    v_nc.cliente_id,
    'credito',
    v_nc.total,
    v_nc.factura_id,
    p_nc_numero,
    'NC-' || v_nc.tipo || ' ' || p_nc_numero || ' — ' || v_nc.motivo,
    now()
  );
END;
$function$;
