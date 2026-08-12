-- 199_fix_desbloqueo_automatico_cobro_manual.sql
-- Fase 3 — trazado del flujo crítico pedido → factura → cta_cte → cobro →
-- bloqueo/desbloqueo por deuda.
--
-- Hallazgo: en TODO el código sólo hay dos lugares que tocan
-- clientes.bloqueado:
--   - cierre.js (procesarBloqueo)      -> bloqueado: true  (automático, por deuda vencida)
--   - pagos.js (desbloquearSiSaldado)  -> bloqueado: false (SOLO se llama desde
--                                         el webhook de Mercado Pago)
-- No existe botón de desbloqueo manual en el admin, y el cobro registrado a
-- mano desde /admin/cobranzas (cta-cte.js -> rpc registrar_cobro_completo)
-- nunca reevaluaba el bloqueo. Resultado: un cliente bloqueado por deuda que
-- paga en efectivo, transferencia, cheque o cualquier medio que no sea MP
-- queda bloqueado para siempre, aunque haya saldado toda la deuda.
--
-- Fix: mover la reevaluación de bloqueo DENTRO del RPC registrar_cobro_completo,
-- que es el único punto de entrada real para registrar un cobro (tanto manual
-- como vía webhook), para que cubra todos los canales sin depender de que
-- cada caller se acuerde de llamar a una función aparte.

CREATE OR REPLACE FUNCTION public.registrar_cobro_completo(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_monto       NUMERIC,
  p_medio       TEXT,
  p_referencia  TEXT DEFAULT NULL,
  p_notas       TEXT DEFAULT NULL,
  p_usuario_id  UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cobro_id UUID;
  v_nro      TEXT;
  v_saldo    NUMERIC;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF p_monto <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'El monto debe ser mayor a cero');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id) THEN
    RETURN json_build_object('ok', false, 'error', 'Cliente no encontrado en la empresa');
  END IF;

  v_nro := siguiente_numero_comprobante(p_empresa_id, 'cobro');

  INSERT INTO cobros (empresa_id, cliente_id, monto, medio, referencia, notas, usuario_id)
  VALUES (p_empresa_id, p_cliente_id, p_monto, p_medio, p_referencia, p_notas,
          COALESCE(p_usuario_id, auth.uid()))
  RETURNING id INTO v_cobro_id;

  INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, cobro_id,
                        nro_comprobante, descripcion, medio_pago)
  VALUES (p_empresa_id, p_cliente_id, 'cobro', p_monto, v_cobro_id, v_nro,
          'Cobro ' || p_medio || COALESCE(' — ' || p_referencia, ''), p_medio);

  -- FIX (Fase 3): reevaluar bloqueo por deuda sin importar el medio de pago.
  -- Mismo cálculo que usan cierre.js (detectarVencimientosYBloquear /
  -- desbloquearSiSaldado): suma de 'debito' menos suma de todo lo demás
  -- (cobro, credito, etc.) sobre cta_cte para el cliente.
  SELECT COALESCE(SUM(CASE WHEN tipo = 'debito' THEN monto ELSE -monto END), 0)
  INTO v_saldo
  FROM cta_cte
  WHERE cliente_id = p_cliente_id;

  IF v_saldo <= 0 THEN
    UPDATE clientes
    SET bloqueado = false, bloqueado_motivo = NULL
    WHERE id = p_cliente_id AND bloqueado = true;

    UPDATE bloqueos_cliente
    SET activo = false
    WHERE cliente_id = p_cliente_id AND activo = true;
  END IF;

  RETURN json_build_object('ok', true, 'cobro_id', v_cobro_id, 'nro', v_nro);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_cobro_completo FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_cobro_completo TO authenticated, service_role;

COMMENT ON FUNCTION public.registrar_cobro_completo IS
  'Crea cobro + movimiento en cta_cte de forma atómica y reevalúa el bloqueo por deuda del cliente (fix Fase 3: antes el desbloqueo automático solo ocurría vía el webhook de Mercado Pago; un cobro manual en efectivo/transferencia/cheque no desbloqueaba aunque saldara la deuda).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '199_fix_desbloqueo_automatico_cobro_manual.sql', '199', 'claude-session',
        'Fase 3 (trazado de flujo critico pedido->factura->cta_cte->cobro->bloqueo): el desbloqueo automatico de clientes por deuda saldada solo se disparaba desde el webhook de Mercado Pago (pagos.js desbloquearSiSaldado). Un cobro manual registrado desde /admin/cobranzas via el RPC registrar_cobro_completo nunca reevaluaba el bloqueo, dejando clientes bloqueados para siempre si pagaban por cualquier medio que no fuera MP. Fix: la reevaluacion de bloqueo ahora vive dentro del RPC registrar_cobro_completo, que es el unico punto de entrada real para registrar cobros (manual y via webhook), cubriendo todos los canales.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
