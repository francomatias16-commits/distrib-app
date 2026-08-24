-- 525_fix_emitir_nota_cta_cte_authenticated.sql
--
-- BUG: desde la pantalla "Notas" (frontend/admin/js/notas.js) no se puede
-- emitir NINGUNA nota manual (ni de crédito ni de débito). El botón
-- "Nueva Nota" llama directo desde el navegador a
-- sb.rpc('emitir_nota_cta_cte', ...) con la sesión del usuario
-- (rol `authenticated`), pero la migración 142
-- (142_revoke_execute_rpcs_sin_tenant_check_lote2.sql, auditoría de
-- seguridad 2026-06-30) le revocó el EXECUTE a `authenticated` asumiendo
-- que, como el resto del lote de 22 funciones, solo se llamaba desde
-- handlers de backend con service_role. Esa función es la excepción:
-- es la única vía existente para emitir una nota de DÉBITO (las notas de
-- crédito además pueden salir del circuito de devoluciones/facturación
-- vía crear_nota_credito, que sí corre con service_role — por eso el
-- síntoma se nota más en débito, pero ambos tipos están rotos desde acá).
--
-- FIX: en vez de simplemente revertir el REVOKE (lo que reabriría el
-- hueco cross-tenant que 142 vino a cerrar — esta función no valida
-- p_empresa_id contra el llamador), se le agrega el mismo patrón de
-- chequeo que ya usan crear_nota_credito/anular_nota_cta_cte
-- (validar empresa_id vs get_empresa_id() y rol dueno/admin, salvo que
-- el caller sea service_role) y recién ahí se vuelve a otorgar EXECUTE
-- a authenticated.

CREATE OR REPLACE FUNCTION public.emitir_nota_cta_cte(
  p_empresa_id UUID,
  p_cliente_id UUID,
  p_tipo       TEXT,    -- 'nota_credito' | 'nota_debito'
  p_importe    NUMERIC,
  p_descripcion TEXT DEFAULT NULL,
  p_fecha      DATE DEFAULT CURRENT_DATE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_nro    TEXT;
  v_cta_id UUID;
BEGIN
  -- Mismo patrón de chequeo tenant/rol que crear_nota_credito (migración
  -- 20260818_..._rpcs_financieras.sql): sin esto, cualquier authenticated
  -- podría emitir notas para OTRA empresa pasando su empresa_id.
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF p_tipo NOT IN ('nota_credito', 'nota_debito') THEN
    RETURN json_build_object('ok', false, 'error', 'Tipo debe ser nota_credito o nota_debito');
  END IF;

  IF p_importe <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'El importe debe ser mayor a cero');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Cliente no encontrado');
  END IF;

  -- Número secuencial por tipo (atómico vía SELECT...FOR UPDATE)
  v_nro := siguiente_numero_comprobante(p_empresa_id, p_tipo);

  INSERT INTO cta_cte
    (empresa_id, cliente_id, tipo, monto, nro_comprobante, descripcion, fecha)
  VALUES
    (p_empresa_id, p_cliente_id, p_tipo, p_importe, v_nro,
     COALESCE(p_descripcion, 'Nota de ' || replace(p_tipo, '_', ' ')), p_fecha)
  RETURNING id INTO v_cta_id;

  RETURN json_build_object(
    'ok',     true,
    'id',     v_cta_id,
    'nro',    v_nro
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.emitir_nota_cta_cte(uuid, uuid, text, numeric, text, date) TO authenticated, service_role;
