-- FIX: sync_saldo_deuda_cliente truncaba con GREATEST(0, v_saldo) el saldo del
-- cliente en clientes.saldo_deuda. Un cliente que sobrepaga queda con saldo
-- negativo real en cta_cte (crédito a favor), pero esa columna -que es la que
-- lee pedidos.js, registrar_venta_pos, el portal cliente (cuenta.html) y el
-- panel admin (clientes.js) para límite de crédito y para mostrar deuda- lo
-- mostraba en $0, ocultando el crédito y sin descontarlo del límite futuro.
-- No hay CHECK constraint que impida negativos en la columna, así que se
-- puede permitir directamente.
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
  WHERE cliente_id = v_cliente_id;

  -- FIX (v409): antes GREATEST(0, v_saldo) descartaba el crédito a favor.
  -- Ahora saldo_deuda refleja el saldo real: positivo = debe, negativo = a favor.
  UPDATE public.clientes
     SET saldo_deuda = v_saldo,
         updated_at  = now()
   WHERE id = v_cliente_id;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- FIX: cheques no tenía ningún constraint que impidiera cargar el mismo
-- cheque (mismo banco + número) dos veces para la misma empresa por error
-- (doble carga manual, reintento). Mismo patrón que facturas_proveedor
-- (migración 408). Parcial: ignora anulados, para poder recargar un cheque
-- corregido sin chocar con el anulado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cheques_empresa_banco_numero
  ON public.cheques (empresa_id, banco, numero)
  WHERE estado <> 'anulado';
