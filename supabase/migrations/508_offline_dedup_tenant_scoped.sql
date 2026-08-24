-- ============================================================
-- 508_offline_dedup_tenant_scoped.sql
--
-- Auditoría pre-lanzamiento 2026 — Punto 5 (Fase A).
--
-- HALLAZGO: el mecanismo de deduplicación offline (offline_local_id,
-- migraciones 443/444/446/448) usa índices únicos y lookups de fast-path
-- SIN acotar por empresa_id en 6 tablas: movimientos_stock, conteos_stock,
-- entregas, devoluciones, cobros, facturas_proveedor. `ventas_pos` (119)
-- es la única tabla que YA lo hacía bien: índice único
-- (empresa_id, offline_local_id) + lookup filtrado por empresa.
--
-- RIESGO: offline_local_id lo genera el dispositivo con
-- crypto.randomUUID() — colisión entre dos empresas distintas es
-- astronómicamente improbable, pero si ocurriera (bug de cliente, RNG
-- degradado, dispositivo reusado entre tenants, etc.) hoy el fast-path
-- devolvería el registro de OTRA empresa como "ya_existia: true" — el
-- caller (chofer/depositero/proveedor) leería datos de un tenant ajeno en
-- vez de crear el suyo propio. Es defensa en profundidad, no un bug
-- observado en producción (backfill de esta migración: 0 colisiones
-- reales encontradas en las 6 tablas).
--
-- FIX (dos capas, igual que ventas_pos):
--   1. Constraint real en DB: UNIQUE (empresa_id, offline_local_id) en vez
--      de UNIQUE (offline_local_id) a secas.
--   2. Todo lookup de fast-path (RPC y repo JS) filtra también por
--      empresa_id — el índice único por sí solo no alcanza: sigue
--      permitiendo un SELECT sin filtro que lea la fila de otra empresa
--      antes de intentar el insert.
--
-- movimientos_stock y entregas no tenían columna empresa_id (a diferencia
-- de conteos_stock/devoluciones/cobros/facturas_proveedor, que ya la
-- tenían pero con el índice mal armado). Se agrega la columna + trigger
-- BEFORE INSERT que la resuelve automáticamente (vía deposito_id /
-- pedido_id / ruta_id) para no depender de tocar cada INSERT disperso por
-- el código — hay ~10 funciones/paths distintos que insertan en
-- movimientos_stock y varios en entregas.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- 1) movimientos_stock — agregar empresa_id + trigger + backfill + índice
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE movimientos_stock
  ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);

UPDATE movimientos_stock ms
   SET empresa_id = d.empresa_id
  FROM depositos d
 WHERE d.id = ms.deposito_id
   AND ms.empresa_id IS NULL;

CREATE OR REPLACE FUNCTION public.fn_movimientos_stock_set_empresa_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.empresa_id IS NULL AND NEW.deposito_id IS NOT NULL THEN
    SELECT empresa_id INTO NEW.empresa_id FROM public.depositos WHERE id = NEW.deposito_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_movimientos_stock_set_empresa_id ON movimientos_stock;
CREATE TRIGGER trg_movimientos_stock_set_empresa_id
  BEFORE INSERT ON movimientos_stock
  FOR EACH ROW EXECUTE FUNCTION fn_movimientos_stock_set_empresa_id();

COMMENT ON FUNCTION public.fn_movimientos_stock_set_empresa_id IS
  'Auto-completa movimientos_stock.empresa_id desde depositos.empresa_id si '
  'no vino en el INSERT. Evita depender de que cada función que inserta un '
  'movimiento (ajustar_stock, transferir_stock, registrar_venta_pos, '
  'recepcionar_orden_compra, etc.) lo agregue a mano — necesario para que '
  'el índice único (empresa_id, offline_local_id) sea correcto sin tocar '
  'cada una de esas funciones.';

DROP INDEX IF EXISTS idx_movimientos_stock_offline_local_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_stock_offline_local_id
  ON movimientos_stock (empresa_id, offline_local_id)
  WHERE offline_local_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 2) entregas — agregar empresa_id + trigger + backfill + índice
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE entregas
  ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);

UPDATE entregas e
   SET empresa_id = p.empresa_id
  FROM pedidos p
 WHERE p.id = e.pedido_id
   AND e.empresa_id IS NULL;

-- Backstop por ruta_id para las (si las hubiera) filas sin pedido_id.
UPDATE entregas e
   SET empresa_id = r.empresa_id
  FROM rutas r
 WHERE r.id = e.ruta_id
   AND e.empresa_id IS NULL;

CREATE OR REPLACE FUNCTION public.fn_entregas_set_empresa_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.empresa_id IS NULL THEN
    IF NEW.pedido_id IS NOT NULL THEN
      SELECT empresa_id INTO NEW.empresa_id FROM public.pedidos WHERE id = NEW.pedido_id;
    END IF;
    IF NEW.empresa_id IS NULL AND NEW.ruta_id IS NOT NULL THEN
      SELECT empresa_id INTO NEW.empresa_id FROM public.rutas WHERE id = NEW.ruta_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_entregas_set_empresa_id ON entregas;
CREATE TRIGGER trg_entregas_set_empresa_id
  BEFORE INSERT ON entregas
  FOR EACH ROW EXECUTE FUNCTION fn_entregas_set_empresa_id();

COMMENT ON FUNCTION public.fn_entregas_set_empresa_id IS
  'Auto-completa entregas.empresa_id desde pedidos.empresa_id (o rutas.empresa_id '
  'como backstop) si no vino en el INSERT. Mismo motivo que el trigger '
  'análogo de movimientos_stock: hay varios paths de inserción (asignación '
  'a ruta, entrega urgente, etc.) y no se quiere depender de tocar cada uno.';

DROP INDEX IF EXISTS idx_entregas_offline_local_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entregas_offline_local_id
  ON entregas (empresa_id, offline_local_id)
  WHERE offline_local_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 3) conteos_stock / devoluciones / cobros / facturas_proveedor — ya
--    tenían empresa_id (siempre se insertaba), el índice era el único
--    problema. Se reemplaza por la versión compuesta.
-- ────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_conteos_stock_offline_local_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conteos_stock_offline_local_id
  ON conteos_stock (empresa_id, offline_local_id)
  WHERE offline_local_id IS NOT NULL;

DROP INDEX IF EXISTS idx_devoluciones_offline_local_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devoluciones_offline_local_id
  ON devoluciones (empresa_id, offline_local_id)
  WHERE offline_local_id IS NOT NULL;

DROP INDEX IF EXISTS idx_cobros_offline_local_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobros_offline_local_id
  ON cobros (empresa_id, offline_local_id)
  WHERE offline_local_id IS NOT NULL;

DROP INDEX IF EXISTS idx_facturas_proveedor_offline_local_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_proveedor_offline_local_id
  ON facturas_proveedor (empresa_id, offline_local_id)
  WHERE offline_local_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 4) ajustar_stock — fast-path y backstop de unique_violation acotados
--    por empresa_id (se resuelve v_empresa_id ANTES del fast-path en vez
--    de después, para poder usarlo ahí).
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ajustar_stock(
  p_producto_id       UUID,
  p_deposito_id       UUID,
  p_delta             NUMERIC,
  p_tipo              tipo_movimiento DEFAULT NULL,
  p_motivo            TEXT DEFAULT 'ajuste_manual',
  p_notas             TEXT DEFAULT NULL,
  p_usuario_id        UUID DEFAULT NULL,
  p_offline_local_id  TEXT DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_empresa_id   UUID;
  v_stock_actual NUMERIC;
  v_stock_nuevo  NUMERIC;
  v_tipo         tipo_movimiento;
  v_existente_id UUID;
  v_mov_id       UUID;
  v_lote_id      UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  -- Punto 5: resuelto ANTES del fast-path (antes se resolvía después,
  -- dejando el dedup sin acotar por empresa).
  SELECT empresa_id INTO v_empresa_id
    FROM public.depositos
   WHERE id = p_deposito_id;

  IF v_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.movimientos_stock
     WHERE empresa_id = v_empresa_id
       AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      SELECT cantidad INTO v_stock_nuevo
        FROM public.stock
       WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;
      RETURN json_build_object('ok', true, 'stock_nuevo', COALESCE(v_stock_nuevo, 0), 'delta', p_delta, 'ya_existia', true);
    END IF;
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado en esta empresa');
  END IF;

  v_tipo := COALESCE(p_tipo, CASE WHEN p_delta >= 0 THEN 'ingreso' ELSE 'egreso' END::tipo_movimiento);

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  SELECT cantidad INTO v_stock_actual
    FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id
   FOR UPDATE;

  v_stock_nuevo := COALESCE(v_stock_actual, 0) + p_delta;

  IF v_stock_nuevo < 0 THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'Stock insuficiente: la operación dejaría el stock en negativo',
      'stock_disponible', COALESCE(v_stock_actual, 0)
    );
  END IF;

  UPDATE public.stock
     SET cantidad = v_stock_nuevo, updated_at = NOW()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;

  -- Punto 5: empresa_id explícito acá también (aunque el trigger lo
  -- resolvería igual) por claridad de lectura.
  INSERT INTO public.movimientos_stock
    (empresa_id, producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas, offline_local_id)
  VALUES
    (v_empresa_id, p_producto_id, p_deposito_id, v_tipo, ABS(p_delta), p_motivo, p_usuario_id, p_notas, p_offline_local_id)
  RETURNING id INTO v_mov_id;

  IF p_delta > 0 THEN
    INSERT INTO lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_id,
      'AJUSTE-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      p_delta, p_delta,
      'activo'
    ) RETURNING id INTO v_lote_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_id, v_lote_id, p_delta, 'alta');

  ELSIF p_delta < 0 THEN
    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    SELECT v_mov_id, f.lote_id, f.cantidad_consumida, 'consumo'
      FROM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, ABS(p_delta), p_motivo, p_usuario_id) f;
  END IF;

  RETURN json_build_object(
    'ok',          true,
    'stock_nuevo', v_stock_nuevo,
    'delta',       p_delta
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id INTO v_existente_id
        FROM public.movimientos_stock
       WHERE empresa_id = v_empresa_id
         AND offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        SELECT cantidad INTO v_stock_nuevo
          FROM public.stock
         WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;
        RETURN json_build_object('ok', true, 'stock_nuevo', COALESCE(v_stock_nuevo, 0), 'delta', p_delta, 'ya_existia', true);
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 5) registrar_conteo_stock — mismo criterio (v_empresa_id ya se resolvía
--    razonablemente temprano, pero después del fast-path; se adelanta).
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.registrar_conteo_stock(
  p_producto_id             UUID,
  p_deposito_id             UUID,
  p_cantidad_contada        NUMERIC,
  p_motivo                  TEXT DEFAULT 'conteo_fisico',
  p_notas                   TEXT DEFAULT NULL,
  p_usuario_id              UUID DEFAULT NULL,
  p_offline_local_id        TEXT DEFAULT NULL,
  p_stock_sistema_esperado  NUMERIC DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_empresa_id     UUID;
  v_stock_sistema  NUMERIC;
  v_diferencia     NUMERIC;
  v_conteo_id      UUID;
  v_existente_id   UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  -- Punto 5: resuelto ANTES del fast-path.
  SELECT empresa_id INTO v_empresa_id FROM public.depositos WHERE id = p_deposito_id;
  IF v_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.conteos_stock
     WHERE empresa_id = v_empresa_id
       AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      SELECT cantidad_sistema, cantidad_contada, diferencia
        INTO v_stock_sistema, p_cantidad_contada, v_diferencia
        FROM public.conteos_stock WHERE id = v_existente_id;
      RETURN json_build_object(
        'ok', true, 'stock_nuevo', p_cantidad_contada,
        'cantidad_sistema', v_stock_sistema, 'diferencia', v_diferencia,
        'conteo_id', v_existente_id, 'ya_existia', true
      );
    END IF;
  END IF;

  IF p_cantidad_contada IS NULL OR p_cantidad_contada < 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad contada debe ser un número mayor o igual a cero');
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado en esta empresa');
  END IF;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  SELECT cantidad INTO v_stock_sistema
    FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id
   FOR UPDATE;

  v_stock_sistema := COALESCE(v_stock_sistema, 0);

  IF p_stock_sistema_esperado IS NOT NULL AND p_stock_sistema_esperado IS DISTINCT FROM v_stock_sistema THEN
    RETURN json_build_object(
      'ok', false,
      'tipo', 'conflicto_stock_cambio',
      'error', 'El stock cambió en el servidor mientras el conteo estaba sin enviar',
      'stock_sistema_esperado', p_stock_sistema_esperado,
      'stock_sistema_actual', v_stock_sistema
    );
  END IF;

  v_diferencia := p_cantidad_contada - v_stock_sistema;

  UPDATE public.stock SET cantidad = p_cantidad_contada, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;

  IF v_diferencia > 0 THEN
    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_id,
      'CONTEO-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      v_diferencia, v_diferencia,
      'activo'
    );
  ELSIF v_diferencia < 0 THEN
    PERFORM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, ABS(v_diferencia), p_motivo, p_usuario_id);
  END IF;

  INSERT INTO public.conteos_stock
    (empresa_id, producto_id, deposito_id, cantidad_sistema, cantidad_contada, diferencia, motivo, notas, usuario_id, offline_local_id)
  VALUES
    (v_empresa_id, p_producto_id, p_deposito_id, v_stock_sistema, p_cantidad_contada, v_diferencia, p_motivo, p_notas, p_usuario_id, p_offline_local_id)
  RETURNING id INTO v_conteo_id;

  IF v_diferencia <> 0 THEN
    INSERT INTO public.movimientos_stock
      (empresa_id, producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
    VALUES
      (v_empresa_id, p_producto_id, p_deposito_id, 'ajuste', v_diferencia, p_motivo, v_conteo_id, p_usuario_id, p_notas);
  END IF;

  RETURN json_build_object(
    'ok',               true,
    'stock_nuevo',      p_cantidad_contada,
    'cantidad_sistema', v_stock_sistema,
    'diferencia',       v_diferencia,
    'conteo_id',        v_conteo_id
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id INTO v_existente_id
        FROM public.conteos_stock
       WHERE empresa_id = v_empresa_id
         AND offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        SELECT cantidad_sistema, cantidad_contada, diferencia
          INTO v_stock_sistema, p_cantidad_contada, v_diferencia
          FROM public.conteos_stock WHERE id = v_existente_id;
        RETURN json_build_object(
          'ok', true, 'stock_nuevo', p_cantidad_contada,
          'cantidad_sistema', v_stock_sistema, 'diferencia', v_diferencia,
          'conteo_id', v_existente_id, 'ya_existia', true
        );
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 6) transferir_stock — mismo criterio (v_empresa_origen se resolvía
--    después del fast-path; se adelanta).
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transferir_stock(
  p_producto_id       UUID,
  p_deposito_origen   UUID,
  p_deposito_destino  UUID,
  p_cantidad          NUMERIC,
  p_motivo            TEXT DEFAULT 'transferencia_manual',
  p_notas             TEXT DEFAULT NULL,
  p_usuario_id        UUID DEFAULT NULL,
  p_offline_local_id  TEXT DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_empresa_origen      UUID;
  v_empresa_destino     UUID;
  v_dep_lock1           UUID;
  v_dep_lock2           UUID;
  v_stock_origen        NUMERIC;
  v_stock_destino       NUMERIC;
  v_stock_origen_nuevo  NUMERIC;
  v_stock_destino_nuevo NUMERIC;
  v_existente_id        UUID;
  v_mov_origen_id       UUID;
  v_mov_destino_id      UUID;
  v_lote                RECORD;
  v_restante            NUMERIC;
  v_consumir            NUMERIC;
  v_lote_destino_id     UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  -- Punto 5: resuelto ANTES del fast-path.
  SELECT empresa_id INTO v_empresa_origen  FROM public.depositos WHERE id = p_deposito_origen;
  SELECT empresa_id INTO v_empresa_destino FROM public.depositos WHERE id = p_deposito_destino;

  IF v_empresa_origen IS NULL OR v_empresa_destino IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.movimientos_stock
     WHERE empresa_id = v_empresa_origen
       AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      SELECT cantidad INTO v_stock_origen_nuevo
        FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;
      SELECT cantidad INTO v_stock_destino_nuevo
        FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

      RETURN json_build_object(
        'ok',                   true,
        'stock_origen_nuevo',   COALESCE(v_stock_origen_nuevo, 0),
        'stock_destino_nuevo',  COALESCE(v_stock_destino_nuevo, 0),
        'deposito_origen',      p_deposito_origen,
        'deposito_destino',     p_deposito_destino,
        'cantidad',             p_cantidad,
        'ya_existia',           true
      );
    END IF;
  END IF;

  IF p_deposito_origen = p_deposito_destino THEN
    RETURN json_build_object('ok', false, 'error', 'El depósito de origen y destino no pueden ser el mismo');
  END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad a transferir debe ser mayor a cero');
  END IF;

  IF v_empresa_origen <> v_empresa_destino THEN
    RETURN json_build_object('ok', false, 'error', 'Ambos depósitos deben pertenecer a la misma empresa');
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_origen
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = v_empresa_origen
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado en esta empresa');
  END IF;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_origen, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_destino, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  IF p_deposito_origen < p_deposito_destino THEN
    v_dep_lock1 := p_deposito_origen;
    v_dep_lock2 := p_deposito_destino;
  ELSE
    v_dep_lock1 := p_deposito_destino;
    v_dep_lock2 := p_deposito_origen;
  END IF;

  PERFORM cantidad FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = v_dep_lock1 FOR UPDATE;
  PERFORM cantidad FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = v_dep_lock2 FOR UPDATE;

  SELECT cantidad INTO v_stock_origen
    FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;
  SELECT cantidad INTO v_stock_destino
    FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

  v_stock_origen_nuevo  := COALESCE(v_stock_origen, 0) - p_cantidad;
  v_stock_destino_nuevo := COALESCE(v_stock_destino, 0) + p_cantidad;

  IF v_stock_origen_nuevo < 0 THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'Stock insuficiente en el depósito de origen para transferir',
      'stock_disponible', COALESCE(v_stock_origen, 0)
    );
  END IF;

  UPDATE public.stock SET cantidad = v_stock_origen_nuevo, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;

  UPDATE public.stock SET cantidad = v_stock_destino_nuevo, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

  INSERT INTO public.movimientos_stock
    (empresa_id, producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, offline_local_id)
  VALUES
    (v_empresa_origen, p_producto_id, p_deposito_origen, 'transferencia', p_cantidad, p_motivo, p_deposito_destino, p_usuario_id, p_notas,
     p_offline_local_id)
  RETURNING id INTO v_mov_origen_id;

  INSERT INTO public.movimientos_stock
    (empresa_id, producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, offline_local_id)
  VALUES
    (v_empresa_destino, p_producto_id, p_deposito_destino, 'transferencia', p_cantidad, p_motivo, p_deposito_origen, p_usuario_id, p_notas,
     CASE WHEN p_offline_local_id IS NOT NULL THEN p_offline_local_id || '-destino' ELSE NULL END)
  RETURNING id INTO v_mov_destino_id;

  v_restante := p_cantidad;

  FOR v_lote IN
    SELECT id, cantidad_disponible, costo_unitario, fecha_vencimiento,
           numero_lote, fecha_fabricacion
      FROM public.lotes
     WHERE producto_id = p_producto_id
       AND deposito_id = p_deposito_origen
       AND estado      = 'activo'
       AND cantidad_disponible > 0
     ORDER BY fecha_vencimiento ASC NULLS LAST, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_restante <= 0;

    v_consumir := LEAST(v_lote.cantidad_disponible, v_restante);

    UPDATE public.lotes
       SET cantidad            = GREATEST(0, cantidad - v_consumir),
           cantidad_disponible = GREATEST(0, cantidad_disponible - v_consumir),
           updated_at          = now()
     WHERE id = v_lote.id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_origen_id, v_lote.id, v_consumir, 'consumo');

    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      costo_unitario, fecha_fabricacion, fecha_vencimiento, estado
    ) VALUES (
      v_empresa_origen, p_producto_id, p_deposito_destino,
      COALESCE(v_lote.numero_lote, 'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI')),
      v_consumir, v_consumir,
      v_lote.costo_unitario, v_lote.fecha_fabricacion, v_lote.fecha_vencimiento,
      'activo'
    ) RETURNING id INTO v_lote_destino_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_destino_id, v_lote_destino_id, v_consumir, 'alta');

    v_restante := v_restante - v_consumir;
  END LOOP;

  IF v_restante > 0 THEN
    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible, estado
    ) VALUES (
      v_empresa_origen, p_producto_id, p_deposito_destino,
      'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      v_restante, v_restante,
      'activo'
    ) RETURNING id INTO v_lote_destino_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_destino_id, v_lote_destino_id, v_restante, 'alta');
  END IF;

  RETURN json_build_object(
    'ok',                   true,
    'stock_origen_nuevo',   v_stock_origen_nuevo,
    'stock_destino_nuevo',  v_stock_destino_nuevo,
    'deposito_origen',      p_deposito_origen,
    'deposito_destino',     p_deposito_destino,
    'cantidad',             p_cantidad
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 7) registrar_cobro_completo — p_empresa_id ya es parámetro de entrada
--    (lo manda el caller autenticado), no hace falta reordenar: solo se
--    agrega el filtro a los dos lookups.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.registrar_cobro_completo(
  p_empresa_id          UUID,
  p_cliente_id          UUID,
  p_monto               NUMERIC,
  p_medio               TEXT,
  p_referencia          TEXT DEFAULT NULL,
  p_notas               TEXT DEFAULT NULL,
  p_usuario_id          UUID DEFAULT NULL,
  p_factura_id          UUID DEFAULT NULL,
  p_facturas_aplicadas  JSONB DEFAULT NULL,
  p_offline_local_id    TEXT DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cobro_id     UUID;
  v_nro          TEXT;
  v_saldo        NUMERIC;
  v_factura      RECORD;
  v_aplicado     NUMERIC;
  v_item         JSONB;
  v_fact_id      UUID;
  v_monto_pedido NUMERIC;
  v_restante     NUMERIC;
  v_total_aplicado NUMERIC := 0;
  v_resultados   JSONB := '[]'::JSONB;
  v_existente_id UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  -- Punto 5: acotado por empresa_id (antes buscaba en toda la tabla).
  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.cobros
     WHERE empresa_id = p_empresa_id
       AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      RETURN json_build_object('ok', true, 'cobro_id', v_existente_id, 'ya_existia', true);
    END IF;
  END IF;

  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','vendedor','contador','chofer') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF p_monto <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'El monto debe ser mayor a cero');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id) THEN
    RETURN json_build_object('ok', false, 'error', 'Cliente no encontrado en la empresa');
  END IF;

  IF p_facturas_aplicadas IS NULL AND p_factura_id IS NOT NULL THEN
    p_facturas_aplicadas := jsonb_build_array(jsonb_build_object('factura_id', p_factura_id, 'monto', p_monto));
  END IF;

  v_restante := p_monto;
  IF p_facturas_aplicadas IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_facturas_aplicadas)
    LOOP
      v_fact_id      := (v_item->>'factura_id')::UUID;
      v_monto_pedido := (v_item->>'monto')::NUMERIC;

      IF v_monto_pedido IS NULL OR v_monto_pedido <= 0 THEN
        RETURN json_build_object('ok', false, 'error', 'Monto inválido en facturas_aplicadas');
      END IF;

      SELECT id, total, COALESCE(total_cobrado, 0) AS total_cobrado, estado
        INTO v_factura
        FROM facturas
       WHERE id = v_fact_id AND empresa_id = p_empresa_id AND cliente_id = p_cliente_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'Una factura indicada no existe o no pertenece a este cliente');
      END IF;

      IF v_factura.estado = 'anulada' THEN
        RETURN json_build_object('ok', false, 'error', 'Una de las facturas está anulada, no se le puede aplicar un cobro');
      END IF;

      IF (v_factura.total - v_factura.total_cobrado) <= 0 THEN
        RETURN json_build_object('ok', false, 'error', 'Una de las facturas ya está saldada');
      END IF;

      v_total_aplicado := v_total_aplicado + LEAST(v_monto_pedido, v_factura.total - v_factura.total_cobrado, v_restante);
    END LOOP;

    IF v_total_aplicado > p_monto THEN
      RETURN json_build_object('ok', false, 'error', 'La suma de facturas_aplicadas supera el monto del cobro');
    END IF;
  END IF;

  v_nro := siguiente_numero_comprobante(p_empresa_id, 'cobro');

  INSERT INTO cobros (empresa_id, cliente_id, monto, medio, referencia, notas, usuario_id, offline_local_id)
  VALUES (p_empresa_id, p_cliente_id, p_monto, p_medio, p_referencia, p_notas,
          COALESCE(p_usuario_id, auth.uid()), p_offline_local_id)
  RETURNING id INTO v_cobro_id;

  INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, cobro_id,
                        nro_comprobante, descripcion, medio_pago)
  VALUES (p_empresa_id, p_cliente_id, 'cobro', p_monto, v_cobro_id, v_nro,
          'Cobro ' || p_medio || COALESCE(' — ' || p_referencia, ''), p_medio);

  v_restante := p_monto;
  IF p_facturas_aplicadas IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_facturas_aplicadas)
    LOOP
      v_fact_id      := (v_item->>'factura_id')::UUID;
      v_monto_pedido := (v_item->>'monto')::NUMERIC;

      SELECT id, total, COALESCE(total_cobrado, 0) AS total_cobrado, estado
        INTO v_factura
        FROM facturas
       WHERE id = v_fact_id AND empresa_id = p_empresa_id AND cliente_id = p_cliente_id;

      v_aplicado := LEAST(v_monto_pedido, v_factura.total - v_factura.total_cobrado, v_restante);
      v_restante := v_restante - v_aplicado;

      UPDATE facturas
         SET total_cobrado = v_factura.total_cobrado + v_aplicado,
             estado = CASE
                        WHEN (v_factura.total_cobrado + v_aplicado) >= v_factura.total
                             AND v_factura.estado = 'parcial'::estado_factura
                          THEN 'emitida'::estado_factura
                        WHEN (v_factura.total_cobrado + v_aplicado) >= v_factura.total
                          THEN estado
                        ELSE 'parcial'::estado_factura
                      END
       WHERE id = v_fact_id;

      INSERT INTO cobro_facturas_aplicadas (cobro_id, factura_id, empresa_id, monto_aplicado)
      VALUES (v_cobro_id, v_fact_id, p_empresa_id, v_aplicado);

      v_resultados := v_resultados || jsonb_build_object(
        'factura_id', v_fact_id,
        'monto_aplicado', v_aplicado,
        'saldada', (v_factura.total_cobrado + v_aplicado) >= v_factura.total
      );
    END LOOP;
  END IF;

  SELECT COALESCE(saldo_deuda, 0) INTO v_saldo
  FROM clientes WHERE id = p_cliente_id;

  IF v_saldo <= 0 THEN
    UPDATE clientes
    SET bloqueado = false, bloqueado_motivo = NULL
    WHERE id = p_cliente_id AND bloqueado = true;

    UPDATE bloqueos_cliente
    SET activo = false
    WHERE cliente_id = p_cliente_id AND activo = true;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'cobro_id', v_cobro_id,
    'nro', v_nro,
    'factura_id', p_factura_id,
    'factura_saldada', CASE WHEN p_factura_id IS NOT NULL AND jsonb_array_length(v_resultados) = 1
                             THEN (v_resultados->0->>'saldada')::BOOLEAN
                             ELSE NULL END,
    'facturas_aplicadas', CASE WHEN jsonb_array_length(v_resultados) > 0 THEN v_resultados ELSE NULL END
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id INTO v_existente_id
        FROM public.cobros
       WHERE empresa_id = p_empresa_id
         AND offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        RETURN json_build_object('ok', true, 'cobro_id', v_existente_id, 'ya_existia', true);
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.ajustar_stock FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ajustar_stock TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.registrar_conteo_stock FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_conteo_stock TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.transferir_stock FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transferir_stock TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.registrar_cobro_completo FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_cobro_completo TO authenticated, service_role;

COMMENT ON FUNCTION public.ajustar_stock IS
  'Aplica un delta a stock.cantidad de forma atómica (lock FOR UPDATE), registra el movimiento y opcionalmente (p_offline_local_id) es idempotente ante reintentos del outbox offline — devuelve el stock ya actualizado en vez de aplicar el delta dos veces. Punto 5 (auditoría 2026): el dedup por offline_local_id ahora está acotado por empresa_id.';
COMMENT ON FUNCTION public.registrar_conteo_stock IS
  'Fija stock.cantidad a un valor absoluto contado físicamente, deja snapshot en conteos_stock. Opcionalmente (p_offline_local_id) es idempotente ante reintentos del outbox offline, acotado por empresa_id (Punto 5). Opcionalmente (p_stock_sistema_esperado) rechaza el conteo con tipo:conflicto_stock_cambio si el stock real ya no coincide con el que el dispositivo tenía al contar offline.';
COMMENT ON FUNCTION public.transferir_stock IS
  'Transfiere stock entre depósitos de la misma empresa de forma atómica con reparto FEFO real de lotes. Opcionalmente (p_offline_local_id) es idempotente ante reintentos del outbox offline, acotado por empresa_id (Punto 5).';
COMMENT ON FUNCTION public.registrar_cobro_completo IS
  'Crea cobro + movimiento en cta_cte de forma atómica, reevalúa el bloqueo por deuda del cliente, opcionalmente (p_factura_id / p_facturas_aplicadas) aplica el cobro a una o varias facturas puntuales, y opcionalmente (p_offline_local_id) es idempotente ante reintentos del outbox offline del chofer, acotado por empresa_id (Punto 5) — devuelve el cobro ya existente en vez de duplicarlo.';

COMMIT;
