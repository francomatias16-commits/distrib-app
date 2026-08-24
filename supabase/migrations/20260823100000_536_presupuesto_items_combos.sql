-- ============================================================
-- 20260823100000_536_presupuesto_items_combos.sql
-- Combos (530) llegó hasta pedidos/carrito, pero presupuesto_items se
-- quedó afuera: no tenía columna combo_id y crear_presupuesto_con_items
-- exigía producto_id válido en TODOS los renglones (ver 20260818_p1...,
-- "Producto de un ítem no pertenece a la empresa" para cualquier renglón
-- sin producto_id). Esta migración cierra ese gap para que
-- crearPresupuestoParaCliente (lib/handlers/pedidos.js) pueda aceptar
-- renglones de combo igual que crearPedidoParaCliente /
-- confirmarPedidoHandler — mismo criterio de "ítem único" (producto XOR
-- combo) que pedido_items/carrito_items (530).
--
-- A diferencia de pedido_items, acá NO hay reserva de stock que ajustar:
-- un presupuesto es una cotización, no reserva nada (ver comentario de
-- crearPresupuestoParaCliente) — el combo aporta precio propio + IVA
-- ponderado (calculado en JS, calcularIvaPonderadoCombo), la RPC solo
-- necesita poder persistir el renglón.
-- ============================================================

-- ── 1. presupuesto_items: renglón único (producto O combo) ───────────────
ALTER TABLE presupuesto_items
  ALTER COLUMN producto_id DROP NOT NULL;

ALTER TABLE presupuesto_items
  ADD COLUMN IF NOT EXISTS combo_id UUID REFERENCES combos(id);

ALTER TABLE presupuesto_items
  DROP CONSTRAINT IF EXISTS presupuesto_items_producto_o_combo;

ALTER TABLE presupuesto_items
  ADD CONSTRAINT presupuesto_items_producto_o_combo
  CHECK (
    (producto_id IS NOT NULL AND combo_id IS NULL) OR
    (producto_id IS NULL AND combo_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_presupuesto_items_combo
  ON presupuesto_items(combo_id) WHERE combo_id IS NOT NULL;

-- ── 2. crear_presupuesto_con_items: aceptar combo_id por renglón ────────
-- Base: 20260818_p1_sec03_sec08_sync03_sync05_rpcs_financieras.sql (la
-- versión vigente antes de esta migración). Cambios:
--   - la validación "producto pertenece a la empresa" solo corre para
--     renglones con producto_id; los de combo_id se validan contra
--     `combos` (existe, pertenece a la empresa, activo).
--   - el INSERT en presupuesto_items ahora persiste combo_id también.
-- El subtotal/total se sigue recalculando 100% server-side a partir de
-- precio_unitario/cantidad/descuento_pct que ya vienen resueltos por
-- crearPresupuestoParaCliente (precio propio del combo, nunca lo que
-- mande el cliente) — mismo criterio que la versión sin combos.
CREATE OR REPLACE FUNCTION public.crear_presupuesto_con_items(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_vendedor_id uuid,
  p_estado text,
  p_subtotal numeric,
  p_total numeric,
  p_notas text,
  p_fecha_vencimiento timestamp with time zone,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_numero text;
  v_next integer;
  v_presupuesto_id uuid;
  v_item jsonb;
  v_subtotal_calc numeric := 0;
  v_sub numeric;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','vendedor','contador') THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'El presupuesto necesita al menos un ítem';
  END IF;

  IF p_cliente_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id
  ) THEN
    RAISE EXCEPTION 'Cliente no encontrado en la empresa';
  END IF;

  IF p_vendedor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM usuarios WHERE id = p_vendedor_id AND empresa_id = p_empresa_id
  ) THEN
    RAISE EXCEPTION 'Vendedor no encontrado en la empresa';
  END IF;

  -- v536: cada renglón es DE UN PRODUCTO o DE UN COMBO — mismo criterio
  -- que pedido_items_producto_o_combo (530). Se valida acá también (no
  -- solo en JS) porque esta RPC es la fuente de verdad transaccional.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'producto_id') IS NOT NULL AND (v_item->>'combo_id') IS NOT NULL THEN
      RAISE EXCEPTION 'Item inválido: no puede tener producto_id y combo_id a la vez';
    END IF;
    IF (v_item->>'producto_id') IS NULL AND (v_item->>'combo_id') IS NULL THEN
      RAISE EXCEPTION 'Item inválido: falta producto_id o combo_id';
    END IF;

    IF (v_item->>'producto_id') IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM productos
         WHERE id = (v_item->>'producto_id')::uuid AND empresa_id = p_empresa_id
      ) THEN
        RAISE EXCEPTION 'Producto de un ítem no pertenece a la empresa';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM combos
         WHERE id = (v_item->>'combo_id')::uuid AND empresa_id = p_empresa_id AND activo = true
      ) THEN
        RAISE EXCEPTION 'Combo de un ítem no disponible en la empresa';
      END IF;
    END IF;

    v_sub := (v_item->>'cantidad')::numeric * (v_item->>'precio_unitario')::numeric
             * (1 - COALESCE((v_item->>'descuento_pct')::numeric, 0) / 100);
    v_subtotal_calc := v_subtotal_calc + v_sub;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_empresa_id::text || ':presupuesto', 0));

  SELECT COALESCE(MAX((substring(numero FROM 'PRES-([0-9]+)'))::integer), 0) + 1
    INTO v_next
    FROM public.presupuestos
   WHERE empresa_id = p_empresa_id
     AND numero ~ '^PRES-[0-9]+$';
  v_numero := 'PRES-' || lpad(v_next::text, 5, '0');

  INSERT INTO public.presupuestos (
    empresa_id, cliente_id, vendedor_id, numero, estado,
    subtotal, total, notas, fecha_vencimiento
  ) VALUES (
    p_empresa_id, p_cliente_id, p_vendedor_id, v_numero, p_estado,
    v_subtotal_calc, v_subtotal_calc, p_notas, p_fecha_vencimiento
  ) RETURNING id INTO v_presupuesto_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.presupuesto_items (
      presupuesto_id, producto_id, combo_id, cantidad, precio_unitario, descuento_pct, subtotal
    ) VALUES (
      v_presupuesto_id,
      (v_item->>'producto_id')::uuid,
      (v_item->>'combo_id')::uuid,
      (v_item->>'cantidad')::numeric,
      (v_item->>'precio_unitario')::numeric,
      COALESCE((v_item->>'descuento_pct')::numeric, 0),
      (v_item->>'cantidad')::numeric * (v_item->>'precio_unitario')::numeric
        * (1 - COALESCE((v_item->>'descuento_pct')::numeric, 0) / 100)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'presupuesto_id', v_presupuesto_id,
    'numero', v_numero
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', SQLERRM
    );
END;
$function$;

COMMENT ON FUNCTION public.crear_presupuesto_con_items(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz,jsonb) IS
  'v536: soporta renglones de combo (presupuesto_items.combo_id) — ítem único (producto XOR combo), combo validado contra `combos` (empresa + activo) en vez de `productos`. Base: 20260818_p1_sec03_sec08_sync03_sync05_rpcs_financieras.';

REVOKE EXECUTE ON FUNCTION public.crear_presupuesto_con_items(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz,jsonb) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.crear_presupuesto_con_items(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz,jsonb) TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260823100000_536_presupuesto_items_combos.sql',
  '536',
  'claude_assistant',
  'presupuesto_items.combo_id + constraint producto_o_combo + crear_presupuesto_con_items acepta renglones de combo (valida contra combos en vez de productos), cierra el gap dejado por 530 (combos solo llegaba a pedidos/carrito).'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
