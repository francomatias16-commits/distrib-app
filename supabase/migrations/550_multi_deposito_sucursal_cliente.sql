-- 550_multi_deposito_sucursal_cliente.sql
--
-- Multi-depósito por sucursal de cliente (550). La columna clientes.deposito_id,
-- resolver_deposito_pedido() y el crear_pedido_cliente() de 13 parámetros
-- ya estaban aplicados directo en producción vía MCP de Supabase en una
-- sesión anterior (mismo criterio que SEC-005..014 / SECNEW-01: se
-- reconstruye acá para que el repo quede sincronizado). Ver
-- lib/repos/depositos.js para el espejo en JS.
--
-- Verificado contra la base real (jgiquzjwoedmzwqgzubr) antes de escribir
-- este archivo — lo único que faltaba era:
--
--   a) el trigger de consistencia de tenant en clientes.deposito_id
--      (existe uno análogo para turnos_caja desde
--      20260820162759_513_..., pero clientes.deposito_id se agregó sin su
--      versión — un cliente podía terminar apuntando a un depósito de
--      OTRA empresa si el UPDATE viene de un import o corrección manual).
--
--   b) DROP del overload viejo de crear_pedido_cliente (12 parámetros,
--      sin p_deposito_id) — quedó vivo junto al nuevo de 13 parámetros,
--      mismo problema que 139_drop_zombie_crear_pedido_cliente_overload.sql
--      ya resolvió una vez: cualquier caller que arme el payload del RPC
--      SIN la clave p_deposito_id (JS: `db.rpc('crear_pedido_cliente', {...})`
--      sin esa key) corre el riesgo de que PostgREST resuelva al overload
--      viejo — que todavía reserva contra el depósito es_principal a
--      mano, ignorando la sucursal del cliente. Con los 3 canales (bot,
--      admin, portal) ya pasando p_deposito_id siempre, no hay ningún
--      caller legítimo que necesite el viejo.

-- ── a) Trigger de consistencia de tenant en clientes.deposito_id ─────────

CREATE OR REPLACE FUNCTION public.fn_validar_tenant_cliente_deposito()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_empresa_deposito uuid;
BEGIN
  IF NEW.deposito_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT empresa_id INTO v_empresa_deposito
  FROM depositos
  WHERE id = NEW.deposito_id;

  IF v_empresa_deposito IS NULL THEN
    RAISE EXCEPTION 'clientes.deposito_id (%) no corresponde a ningún depósito existente', NEW.deposito_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_empresa_deposito <> NEW.empresa_id THEN
    RAISE EXCEPTION
      'Tenant inconsistente en clientes: el depósito % pertenece a la empresa % pero el cliente pertenece a la empresa %',
      NEW.deposito_id, v_empresa_deposito, NEW.empresa_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validar_tenant_cliente_deposito ON public.clientes;

CREATE TRIGGER trg_validar_tenant_cliente_deposito
  BEFORE INSERT OR UPDATE OF deposito_id, empresa_id
  ON public.clientes
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_validar_tenant_cliente_deposito();

COMMENT ON FUNCTION public.fn_validar_tenant_cliente_deposito() IS
  'Multi-depósito (550): garantiza a nivel de DB que clientes.deposito_id apunte siempre a un depósito de la MISMA empresa del cliente, incluso si el INSERT/UPDATE viene de un import o corrección manual que se salte la validación del handler de aplicación. Mismo criterio que fn_validar_tenant_turno_caja (513).';

-- ── b) Drop del overload zombie de crear_pedido_cliente (12 parámetros) ──

DROP FUNCTION IF EXISTS public.crear_pedido_cliente(
  uuid, uuid, uuid, jsonb, numeric, numeric, numeric, text, date, text, uuid, text
);
