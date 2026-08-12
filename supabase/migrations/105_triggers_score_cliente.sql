-- ============================================================
-- 105_triggers_score_cliente.sql
-- Triggers automáticos para recalcular score en cobros y entregas
-- Aplicado en prod: 2026-06-24 (migración post-094)
-- ============================================================

-- Función trigger para cobros
CREATE OR REPLACE FUNCTION public.tg_score_cobro()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.calcular_score_cliente(NEW.cliente_id, NEW.empresa_id, 'pago_registrado');
  RETURN NEW;
END;
$$;

-- Función trigger para entregas
CREATE OR REPLACE FUNCTION public.tg_score_entrega()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cli UUID;
  v_emp UUID;
BEGIN
  IF NEW.estado = 'entregado' AND OLD.estado <> 'entregado' THEN
    SELECT p.cliente_id, r.empresa_id INTO v_cli, v_emp
    FROM public.pedidos p
    JOIN public.rutas r ON r.id = NEW.ruta_id
    WHERE p.id = NEW.pedido_id;
    IF FOUND THEN
      PERFORM public.calcular_score_cliente(v_cli, v_emp, 'entrega_confirmada');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Crear trigger en cobros (AFTER INSERT)
DROP TRIGGER IF EXISTS tg_score_cobro ON public.cobros;
CREATE TRIGGER tg_score_cobro
  AFTER INSERT ON public.cobros
  FOR EACH ROW EXECUTE FUNCTION public.tg_score_cobro();

-- Crear trigger en entregas (AFTER UPDATE)
DROP TRIGGER IF EXISTS tg_score_entrega ON public.entregas;
CREATE TRIGGER tg_score_entrega
  AFTER UPDATE ON public.entregas
  FOR EACH ROW EXECUTE FUNCTION public.tg_score_entrega();
