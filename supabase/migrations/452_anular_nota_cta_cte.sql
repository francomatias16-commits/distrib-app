-- 452_anular_nota_cta_cte.sql
-- Las notas de crédito/débito (pantalla "Notas", cta_cte.tipo IN
-- ('nota_credito','nota_debito')) no tenían ninguna forma de anularse:
-- ni borrado ni anulación. Como llevan numeración secuencial formal
-- (nro_comprobante, vía siguiente_numero_comprobante), un borrado físico
-- dejaría un hueco en la numeración — mala práctica de auditoría. Se
-- resuelve con el mismo patrón que ya usa notas_credito.estado
-- ('anulada') y anular_venta_pos: la fila queda, se marca anulada, y el
-- trigger que sincroniza saldo_deuda la excluye del cálculo.
--
-- Nota: fn_notas_lista cambia su firma de RETURNS TABLE (agrega
-- `anulado` y `descripcion`), así que hace falta un DROP FUNCTION previo
-- (Postgres no permite ALTER de OUT params vía CREATE OR REPLACE). Ver
-- 452b/452c aplicados directamente en Supabase; acá quedan unificados
-- en un solo archivo para el repo.

BEGIN;

ALTER TABLE public.cta_cte
  ADD COLUMN IF NOT EXISTS anulado         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anulado_motivo  text,
  ADD COLUMN IF NOT EXISTS anulado_at      timestamptz,
  ADD COLUMN IF NOT EXISTS anulado_por     uuid REFERENCES public.usuarios(id);

-- Excluye filas anuladas del cálculo de saldo_deuda (mismo cuerpo que la
-- versión vigente en producción, agregando "AND NOT anulado" al SELECT).
CREATE OR REPLACE FUNCTION public.sync_saldo_deuda_cliente()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cliente_id      uuid;
  v_saldo           numeric(15,2);
  v_tipo_no_valido  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_cliente_id := OLD.cliente_id;
  ELSE
    v_cliente_id := NEW.cliente_id;
  END IF;

  SELECT tipo INTO v_tipo_no_valido
    FROM public.cta_cte
   WHERE cliente_id = v_cliente_id
     AND tipo NOT IN ('factura', 'debito', 'cargo', 'nota_debito',
                       'cobro', 'credito', 'nota_credito', 'pago')
   LIMIT 1;

  IF v_tipo_no_valido IS NOT NULL THEN
    RAISE EXCEPTION 'sync_saldo_deuda_cliente: tipo de cta_cte no reconocido "%" para cliente % — agregalo al CASE de esta función (con su signo correcto) antes de insertar filas con ese tipo.',
      v_tipo_no_valido, v_cliente_id;
  END IF;

  SELECT COALESCE(
    SUM(CASE
          WHEN tipo IN ('factura', 'debito', 'cargo', 'nota_debito') THEN monto
          WHEN tipo IN ('cobro', 'credito', 'nota_credito', 'pago') THEN -monto
        END
    ), 0
  )
  INTO v_saldo
  FROM public.cta_cte
  WHERE cliente_id = v_cliente_id
    AND NOT anulado;

  UPDATE public.clientes
     SET saldo_deuda = v_saldo,
         updated_at  = now()
   WHERE id = v_cliente_id;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- RPC de anulación. SECURITY DEFINER porque cta_cte no tiene policy de
-- UPDATE para authenticated (solo se escribe hoy vía funciones definer,
-- como emitir_nota_cta_cte); el chequeo de rol/tenant queda adentro.
CREATE OR REPLACE FUNCTION public.anular_nota_cta_cte(
  p_empresa_id uuid,
  p_id         uuid,
  p_usuario_id uuid,
  p_motivo     text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.cta_cte%ROWTYPE;
  v_rol public.rol_usuario;
BEGIN
  SELECT rol INTO v_rol FROM public.usuarios WHERE id = p_usuario_id AND empresa_id = p_empresa_id;
  IF v_rol IS NULL OR v_rol NOT IN ('dueno', 'admin', 'contador') THEN
    RETURN json_build_object('ok', false, 'error', 'Sin permisos para anular notas');
  END IF;

  SELECT * INTO v_row FROM public.cta_cte WHERE id = p_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Nota no encontrada');
  END IF;

  IF v_row.tipo NOT IN ('nota_credito', 'nota_debito') THEN
    RETURN json_build_object('ok', false, 'error', 'Este movimiento no es una nota de crédito/débito');
  END IF;

  IF v_row.anulado THEN
    RETURN json_build_object('ok', false, 'error', 'Esta nota ya está anulada');
  END IF;

  UPDATE public.cta_cte
     SET anulado = true,
         anulado_motivo = p_motivo,
         anulado_at = now(),
         anulado_por = p_usuario_id
   WHERE id = p_id;

  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.anular_nota_cta_cte(uuid, uuid, uuid, text) TO authenticated, service_role;

COMMIT;

-- fn_notas_lista cambia de firma (agrega anulado/descripcion) — requiere
-- DROP previo, fuera de la transacción anterior por separado en Supabase
-- pero documentado acá junto para que el repo quede consistente con lo
-- aplicado.
DROP FUNCTION IF EXISTS public.fn_notas_lista(text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.fn_notas_lista(
  p_busqueda text    DEFAULT NULL,
  p_tipo     text    DEFAULT NULL, -- 'nota_credito' | 'nota_debito' | NULL (todos)
  p_limit    integer DEFAULT 200,
  p_offset   integer DEFAULT 0
)
RETURNS TABLE(
  id                       uuid,
  tipo                     text,
  fecha                    timestamptz,
  nro_comprobante          text,
  importe                  numeric,
  cliente_id               uuid,
  cliente_razon_social     text,
  cliente_nombre_fantasia  text,
  anulado                  boolean,
  descripcion              text,
  total_count              bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  SELECT cc.id, cc.tipo, cc.fecha, cc.nro_comprobante, cc.importe,
         cc.cliente_id, cli.razon_social, cli.nombre_fantasia,
         cc.anulado, cc.descripcion,
         COUNT(*) OVER() AS total_count
  FROM public.cta_cte cc
  LEFT JOIN public.clientes cli ON cli.id = cc.cliente_id
  WHERE cc.empresa_id = v_empresa_id
    AND cc.tipo IN ('nota_credito', 'nota_debito')
    AND (p_tipo IS NULL OR p_tipo = '' OR cc.tipo = p_tipo)
    AND (
      p_busqueda IS NULL OR p_busqueda = '' OR
      (
        COALESCE(cli.razon_social, '') || ' ' || COALESCE(cli.nombre_fantasia, '') || ' ' || COALESCE(cc.nro_comprobante, '')
      ) ILIKE '%' || p_busqueda || '%'
    )
  ORDER BY cc.fecha DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_notas_lista(text, text, integer, integer) TO authenticated, service_role;
