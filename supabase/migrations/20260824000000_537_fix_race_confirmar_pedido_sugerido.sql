-- ============================================================
-- 20260824000000_537_fix_race_confirmar_pedido_sugerido.sql
-- Fix Hallazgo 🟡 #9 (AUDITORIA_BUGS_v954.md): confirmar_pedido_sugerido
-- (068_piloto_whatsapp.sql) hacía un SELECT ... WHERE estado = 'sugerido'
-- y, si existía, un UPDATE aparte SIN WHERE estado = 'sugerido' ni
-- SELECT ... FOR UPDATE. Dos requests concurrentes al link público de
-- confirmación (confirmarPedidoSugeridoHandler, sin login — doble tap del
-- cliente o reintento de red del WhatsApp bot) podían pasar ambas el
-- chequeo antes de que la primera actualizara, y las dos ejecutaban el
-- UPDATE: no duplica el pedido (el estado final es idempotente), pero deja
-- una segunda fila de auditoría para la misma transición y es una
-- construcción frágil para cualquier efecto secundario que se agregue a
-- futuro dentro de esta RPC.
--
-- Mismo criterio que bloquearPresupuestoAceptado() (lib/repos/pedidos.js)
-- para el caso gemelo en Presupuestos: el UPDATE mismo es el lock
-- optimista — WHERE incluye la condición que antes se chequeaba aparte,
-- así que solo una de las dos ejecuciones concurrentes puede afectar la
-- fila (la segunda no encuentra filas y devuelve error "ya procesado").
-- ============================================================

CREATE OR REPLACE FUNCTION public.confirmar_pedido_sugerido(
  p_pedido_id  uuid,
  p_empresa_id uuid,
  p_cliente_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_numero text;
BEGIN
  UPDATE pedidos
  SET estado = 'pendiente', canal = 'whatsapp', updated_at = now()
  WHERE id = p_pedido_id
    AND empresa_id = p_empresa_id
    AND cliente_id = p_cliente_id
    AND estado = 'sugerido'
  RETURNING numero_pedido INTO v_numero;

  IF v_numero IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado o ya procesado');
  END IF;

  RETURN jsonb_build_object('ok', true, 'numero_pedido', v_numero);
END;
$$;

ALTER FUNCTION public.confirmar_pedido_sugerido(uuid,uuid,uuid) SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION public.confirmar_pedido_sugerido(uuid,uuid,uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pedido_sugerido(uuid,uuid,uuid) TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260824000000_537_fix_race_confirmar_pedido_sugerido.sql',
  '537',
  'claude_assistant',
  'confirmar_pedido_sugerido reescrita como UPDATE atómico único (WHERE ... AND estado = ''sugerido'' RETURNING numero_pedido) en vez de SELECT-then-UPDATE, cierra condición de carrera check-then-update (hallazgo #9). Mismo patrón que bloquearPresupuestoAceptado para el caso gemelo en Presupuestos.'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
