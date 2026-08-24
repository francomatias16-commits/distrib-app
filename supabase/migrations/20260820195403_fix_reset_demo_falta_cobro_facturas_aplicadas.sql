-- ============================================================
-- 515 — Fix: fn_reset_demo_v2 / fn_snapshot_demo_v2 / fn_redistribuir_fechas_demo
--        no contemplaban la tabla cobro_facturas_aplicadas
-- ============================================================
--
-- CONTEXTO:
-- Al probar el pipeline completo de la migración 514 contra datos reales
-- de la empresa demo, fn_reset_demo_v2() falló:
--
--   ERROR: update or delete on table "facturas" violates foreign key
--   constraint "cobro_facturas_aplicadas_factura_id_fkey" on table
--   "cobro_facturas_aplicadas"
--
-- `cobro_facturas_aplicadas` (cobro_id -> cobros ON DELETE CASCADE,
-- factura_id -> facturas SIN cascade) nunca se agregó a la lista de 55
-- tablas de fn_reset_demo_v2/fn_snapshot_demo_v2 (v492) — quedó afuera
-- del snapshot y del borrado/reinserción del reset. Bug preexistente,
-- no introducido por la migración 514; solo se manifestó ahora porque
-- es la primera vez que se corre el reset con datos reales que la usan.
--
-- FIX: se agrega como tabla propia (tiene empresa_id directo, no hace
-- falta tratarla como "hija" vía FK de otra tabla) con orden 56 — se
-- borra primero (antes que facturas y cobros) y se inserta al final
-- (después de ambas), que es justo lo que exige su doble FK.
-- También se agrega a fn_redistribuir_fechas_demo, tomando el delta de
-- su factura (mismo criterio que cta_cte / notas_credito), para que
-- quede fechada de forma consistente con la factura que cancela.

-- ------------------------------------------------------------
-- 1. fn_snapshot_demo_v2: agrega cobro_facturas_aplicadas (ord 56)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_snapshot_demo_v2(p_empresa_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_datos jsonb := '{}'::jsonb;
  v_cfg record;
  v_cols text;
  v_sql text;
  v_part jsonb;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para snapshotear';
  END IF;

  FOR v_cfg IN
    SELECT * FROM (VALUES
      (1,  'facturacion_config',      false, NULL::text,          NULL::text),
      (2,  'zonas',                   false, NULL,                 NULL),
      (3,  'depositos',               false, NULL,                 NULL),
      (4,  'categorias',              false, NULL,                 NULL),
      (5,  'proveedores',             false, NULL,                 NULL),
      (6,  'listas_precios',          false, NULL,                 NULL),
      (7,  'rutas',                   false, NULL,                 NULL),
      (8,  'reglas_liquidacion',      false, NULL,                 NULL),
      (9,  'productos',               false, NULL,                 NULL),
      (10, 'cajas_pos',                false, NULL,                 NULL),
      (11, 'clientes',                false, NULL,                 NULL),
      (12, 'stock',                   true,  'productos',          'producto_id'),
      (13, 'lotes',                   false, NULL,                 NULL),
      (14, 'promociones',             false, NULL,                 NULL),
      (15, 'pos_favoritos',           false, NULL,                 NULL),
      (16, 'cliente_direcciones',     false, NULL,                 NULL),
      (17, 'bloqueos_cliente',        false, NULL,                 NULL),
      (18, 'precios_clientes',        false, NULL,                 NULL),
      (19, 'carrito_items',           false, NULL,                 NULL),
      (20, 'ciclos_compra',           false, NULL,                 NULL),
      (21, 'ordenes_compra',          false, NULL,                 NULL),
      (22, 'cobros',                  false, NULL,                 NULL),
      (23, 'comprobantes_historicos', false, NULL,                 NULL),
      (24, 'turnos_caja',             true,  'cajas_pos',          'caja_id'),
      (25, 'precios_items',           true,  'listas_precios',     'lista_id'),
      (26, 'ofertas_liquidacion',     false, NULL,                 NULL),
      (27, 'movimientos_caja',       false, NULL,                 NULL),
      (28, 'ventas_pos',              false, NULL,                 NULL),
      (29, 'ordenes_compra_items',    true,  'ordenes_compra',     'orden_id'),
      (30, 'recepciones_mercaderia', false, NULL,                 NULL),
      (31, 'reportes_ruta',           false, NULL,                 NULL),
      (32, 'pedidos',                 false, NULL,                 NULL),
      (33, 'cheques',                 false, NULL,                 NULL),
      (34, 'venta_pos_items',         true,  'ventas_pos',         'venta_pos_id'),
      (35, 'venta_pos_pagos',         true,  'ventas_pos',         'venta_pos_id'),
      (36, 'devoluciones_pos',       false, NULL,                 NULL),
      (37, 'facturas_proveedor',      false, NULL,                 NULL),
      (38, 'ruta_items',              false, NULL,                 NULL),
      (39, 'pedido_items',            true,  'pedidos',            'pedido_id'),
      (40, 'sugerencias_pedido',      false, NULL,                 NULL),
      (41, 'presupuestos',            false, NULL,                 NULL),
      (42, 'facturas',                false, NULL,                 NULL),
      (43, 'devoluciones',            false, NULL,                 NULL),
      (44, 'notas_credito',           false, NULL,                 NULL),
      (45, 'presupuesto_items',       true,  'presupuestos',       'presupuesto_id'),
      (46, 'devolucion_items',        true,  'devoluciones',       'devolucion_id'),
      (47, 'facturas_proveedor_items',true,  'facturas_proveedor', 'factura_id'),
      (48, 'pagos_proveedor',        false, NULL,                 NULL),
      (49, 'notas_debito_proveedor', false, NULL,                 NULL),
      (50, 'cta_cte',                 false, NULL,                 NULL),
      (51, 'notas_credito_items',     true,  'notas_credito',      'nota_credito_id'),
      (52, 'movimientos_puntos',      false, NULL,                 NULL),
      (53, 'movimientos_stock',       true,  'depositos',          'deposito_id'),
      (54, 'entregas',                true,  'rutas',              'ruta_id'),
      (55, 'audit_log',               false, NULL,                 NULL),
      (56, 'cobro_facturas_aplicadas',false, NULL,                 NULL)
    ) AS t(ord, tabla, es_hija, tabla_padre, fk_col)
    ORDER BY ord
  LOOP
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = v_cfg.tabla AND is_generated <> 'ALWAYS';

    IF v_cfg.es_hija THEN
      v_sql := format(
        'SELECT COALESCE(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM (SELECT %s FROM %I WHERE %I IN (SELECT id FROM %I WHERE empresa_id = $1)) x',
        v_cols, v_cfg.tabla, v_cfg.fk_col, v_cfg.tabla_padre
      );
    ELSE
      v_sql := format(
        'SELECT COALESCE(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM (SELECT %s FROM %I WHERE empresa_id = $1) x',
        v_cols, v_cfg.tabla
      );
    END IF;

    EXECUTE v_sql INTO v_part USING v_empresa_id;
    v_datos := jsonb_set(v_datos, ARRAY[v_cfg.tabla], v_part);
  END LOOP;

  v_datos := jsonb_set(v_datos, ARRAY['empresa'], (SELECT to_jsonb(e) FROM empresas e WHERE e.id = v_empresa_id));

  INSERT INTO demo_snapshots (empresa_id, datos)
  VALUES (v_empresa_id, v_datos)
  ON CONFLICT (empresa_id) DO UPDATE
    SET datos = EXCLUDED.datos, actualizado_at = now();

  RETURN v_empresa_id;
END;
$function$;

-- ------------------------------------------------------------
-- 2. fn_reset_demo_v2: agrega cobro_facturas_aplicadas (ord 56) —
--    se borra primero (DESC) y se inserta al final (ASC), ya que
--    depende de facturas y cobros.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_reset_demo_v2(p_empresa_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_datos jsonb;
  v_cfg record;
  v_cols text;
  v_sql text;
  v_data_tabla jsonb;
  v_defaults jsonb;
  v_def_rec record;
  v_def_val jsonb;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para resetear';
  END IF;

  SELECT datos INTO v_datos FROM demo_snapshots WHERE empresa_id = v_empresa_id;
  IF v_datos IS NULL THEN
    RAISE EXCEPTION 'No existe snapshot para la empresa %. Corré fn_snapshot_demo_v2() primero.', v_empresa_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  UPDATE pedidos    SET factura_id = NULL, presupuesto_id = NULL WHERE empresa_id = v_empresa_id;
  UPDATE ventas_pos SET factura_id = NULL                        WHERE empresa_id = v_empresa_id;
  UPDATE facturas   SET factura_origen_id = NULL                 WHERE empresa_id = v_empresa_id;

  FOR v_cfg IN
    SELECT * FROM (VALUES
      (1,'facturacion_config',false,NULL::text,NULL::text),(2,'zonas',false,NULL,NULL),(3,'depositos',false,NULL,NULL),
      (4,'categorias',false,NULL,NULL),(5,'proveedores',false,NULL,NULL),(6,'listas_precios',false,NULL,NULL),
      (7,'rutas',false,NULL,NULL),(8,'reglas_liquidacion',false,NULL,NULL),(9,'productos',false,NULL,NULL),
      (10,'cajas_pos',false,NULL,NULL),(11,'clientes',false,NULL,NULL),(12,'stock',true,'productos','producto_id'),
      (13,'lotes',false,NULL,NULL),(14,'promociones',false,NULL,NULL),(15,'pos_favoritos',false,NULL,NULL),
      (16,'cliente_direcciones',false,NULL,NULL),(17,'bloqueos_cliente',false,NULL,NULL),(18,'precios_clientes',false,NULL,NULL),
      (19,'carrito_items',false,NULL,NULL),(20,'ciclos_compra',false,NULL,NULL),(21,'ordenes_compra',false,NULL,NULL),
      (22,'cobros',false,NULL,NULL),(23,'comprobantes_historicos',false,NULL,NULL),(24,'turnos_caja',true,'cajas_pos','caja_id'),
      (25,'precios_items',true,'listas_precios','lista_id'),(26,'ofertas_liquidacion',false,NULL,NULL),(27,'movimientos_caja',false,NULL,NULL),
      (28,'ventas_pos',false,NULL,NULL),(29,'ordenes_compra_items',true,'ordenes_compra','orden_id'),(30,'recepciones_mercaderia',false,NULL,NULL),
      (31,'reportes_ruta',false,NULL,NULL),(32,'pedidos',false,NULL,NULL),(33,'cheques',false,NULL,NULL),
      (34,'venta_pos_items',true,'ventas_pos','venta_pos_id'),(35,'venta_pos_pagos',true,'ventas_pos','venta_pos_id'),(36,'devoluciones_pos',false,NULL,NULL),
      (37,'facturas_proveedor',false,NULL,NULL),(38,'ruta_items',false,NULL,NULL),(39,'pedido_items',true,'pedidos','pedido_id'),
      (40,'sugerencias_pedido',false,NULL,NULL),(41,'presupuestos',false,NULL,NULL),(42,'facturas',false,NULL,NULL),
      (43,'devoluciones',false,NULL,NULL),(44,'notas_credito',false,NULL,NULL),(45,'presupuesto_items',true,'presupuestos','presupuesto_id'),
      (46,'devolucion_items',true,'devoluciones','devolucion_id'),(47,'facturas_proveedor_items',true,'facturas_proveedor','factura_id'),(48,'pagos_proveedor',false,NULL,NULL),
      (49,'notas_debito_proveedor',false,NULL,NULL),(50,'cta_cte',false,NULL,NULL),(51,'notas_credito_items',true,'notas_credito','nota_credito_id'),
      (52,'movimientos_puntos',false,NULL,NULL),(53,'movimientos_stock',true,'depositos','deposito_id'),
      (54,'entregas',true,'rutas','ruta_id'),(55,'audit_log',false,NULL,NULL),
      (56,'cobro_facturas_aplicadas',false,NULL,NULL)
    ) AS t(ord, tabla, es_hija, tabla_padre, fk_col)
    ORDER BY ord DESC
  LOOP
    IF v_cfg.es_hija THEN
      EXECUTE format('DELETE FROM %I WHERE %I IN (SELECT id FROM %I WHERE empresa_id = $1)', v_cfg.tabla, v_cfg.fk_col, v_cfg.tabla_padre) USING v_empresa_id;
    ELSE
      EXECUTE format('DELETE FROM %I WHERE empresa_id = $1', v_cfg.tabla) USING v_empresa_id;
    END IF;
  END LOOP;

  FOR v_cfg IN
    SELECT * FROM (VALUES
      (1,'facturacion_config'),(2,'zonas'),(3,'depositos'),(4,'categorias'),(5,'proveedores'),(6,'listas_precios'),
      (7,'rutas'),(8,'reglas_liquidacion'),(9,'productos'),(10,'cajas_pos'),(11,'clientes'),(12,'stock'),
      (13,'lotes'),(14,'promociones'),(15,'pos_favoritos'),(16,'cliente_direcciones'),(17,'bloqueos_cliente'),(18,'precios_clientes'),
      (19,'carrito_items'),(20,'ciclos_compra'),(21,'ordenes_compra'),(22,'cobros'),(23,'comprobantes_historicos'),(24,'turnos_caja'),
      (25,'precios_items'),(26,'ofertas_liquidacion'),(27,'movimientos_caja'),(28,'ventas_pos'),(29,'ordenes_compra_items'),(30,'recepciones_mercaderia'),
      (31,'reportes_ruta'),(32,'pedidos'),(33,'cheques'),(34,'venta_pos_items'),(35,'venta_pos_pagos'),(36,'devoluciones_pos'),
      (37,'facturas_proveedor'),(38,'ruta_items'),(39,'pedido_items'),(40,'sugerencias_pedido'),(41,'presupuestos'),(42,'facturas'),
      (43,'devoluciones'),(44,'notas_credito'),(45,'presupuesto_items'),(46,'devolucion_items'),(47,'facturas_proveedor_items'),(48,'pagos_proveedor'),
      (49,'notas_debito_proveedor'),(50,'cta_cte'),(51,'notas_credito_items'),
      (52,'movimientos_puntos'),(53,'movimientos_stock'),(54,'entregas'),(55,'audit_log'),
      (56,'cobro_facturas_aplicadas')
    ) AS t(ord, tabla)
    ORDER BY ord
  LOOP
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = v_cfg.tabla AND is_generated <> 'ALWAYS';

    v_data_tabla := v_datos -> v_cfg.tabla;
    IF v_cfg.tabla = 'ventas_pos' THEN
      SELECT COALESCE(jsonb_agg(elem - 'factura_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    ELSIF v_cfg.tabla = 'pedidos' THEN
      SELECT COALESCE(jsonb_agg(elem - 'factura_id' - 'presupuesto_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    ELSIF v_cfg.tabla = 'facturas' THEN
      SELECT COALESCE(jsonb_agg(elem - 'factura_origen_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    END IF;

    v_defaults := '{}'::jsonb;
    FOR v_def_rec IN
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_cfg.tabla
        AND column_default IS NOT NULL
        AND is_generated <> 'ALWAYS'
    LOOP
      BEGIN
        EXECUTE format('SELECT to_jsonb(%s)', v_def_rec.column_default) INTO v_def_val;
        v_defaults := jsonb_set(v_defaults, ARRAY[v_def_rec.column_name], v_def_val);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;

    IF v_defaults <> '{}'::jsonb THEN
      SELECT COALESCE(jsonb_agg(v_defaults || elem), '[]'::jsonb) INTO v_data_tabla
      FROM jsonb_array_elements(v_data_tabla) elem;
    END IF;

    v_sql := format('INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_recordset(NULL::%I, $1)', v_cfg.tabla, v_cols, v_cols, v_cfg.tabla);
    EXECUTE v_sql USING v_data_tabla;
  END LOOP;

  UPDATE ventas_pos v SET factura_id = (elem->>'factura_id')::uuid
  FROM jsonb_array_elements(v_datos->'ventas_pos') elem
  WHERE v.id = (elem->>'id')::uuid AND elem->>'factura_id' IS NOT NULL;

  UPDATE pedidos p SET factura_id = (elem->>'factura_id')::uuid
  FROM jsonb_array_elements(v_datos->'pedidos') elem
  WHERE p.id = (elem->>'id')::uuid AND elem->>'factura_id' IS NOT NULL;

  UPDATE pedidos p SET presupuesto_id = (elem->>'presupuesto_id')::uuid
  FROM jsonb_array_elements(v_datos->'pedidos') elem
  WHERE p.id = (elem->>'id')::uuid AND elem->>'presupuesto_id' IS NOT NULL;

  UPDATE facturas f SET factura_origen_id = (elem->>'factura_origen_id')::uuid
  FROM jsonb_array_elements(v_datos->'facturas') elem
  WHERE f.id = (elem->>'id')::uuid AND elem->>'factura_origen_id' IS NOT NULL;

  UPDATE empresas e SET
    nombre = (v_datos->'empresa'->>'nombre'),
    activa = (v_datos->'empresa'->>'activa')::boolean,
    setup_completado = (v_datos->'empresa'->>'setup_completado')::boolean
  WHERE e.id = v_empresa_id;

END;
$function$;

-- ------------------------------------------------------------
-- 3. fn_redistribuir_fechas_demo: agrega cobro_facturas_aplicadas
--    (delta de su factura, mismo criterio que cta_cte/notas_credito)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_redistribuir_fechas_demo(p_empresa_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para redistribuir fechas';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  UPDATE pedidos p
  SET created_at     = created_at - (d.delta || ' days')::interval,
      updated_at     = updated_at - (d.delta || ' days')::interval,
      fecha_pedido   = fecha_pedido - (d.delta || ' days')::interval,
      fecha_despacho = CASE WHEN fecha_despacho IS NOT NULL THEN fecha_despacho - (d.delta || ' days')::interval END,
      entregado_at   = CASE WHEN entregado_at IS NOT NULL THEN entregado_at - (d.delta || ' days')::interval END,
      fecha_entrega  = CASE WHEN fecha_entrega IS NOT NULL THEN (fecha_entrega - (d.delta || ' days')::interval)::date END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM pedidos WHERE empresa_id = v_empresa_id) d
  WHERE p.id = d.id;

  UPDATE ordenes_compra o
  SET created_at             = created_at - (d.delta || ' days')::interval,
      updated_at             = updated_at - (d.delta || ' days')::interval,
      fecha_pedido           = fecha_pedido - (d.delta || ' days')::interval,
      fecha_confirmacion_at  = CASE WHEN fecha_confirmacion_at IS NOT NULL THEN fecha_confirmacion_at - (d.delta || ' days')::interval END,
      fecha_esperada         = CASE WHEN fecha_esperada IS NOT NULL THEN (fecha_esperada - (d.delta || ' days')::interval)::date END,
      fecha_recepcion        = CASE WHEN fecha_recepcion IS NOT NULL THEN fecha_recepcion - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM ordenes_compra WHERE empresa_id = v_empresa_id) d
  WHERE o.id = d.id;

  UPDATE turnos_caja t
  SET abierto_at = abierto_at - (d.delta || ' days')::interval,
      cerrado_at = CASE WHEN cerrado_at IS NOT NULL THEN cerrado_at - (d.delta || ' days')::interval END
  FROM (SELECT tc.id, (('x'||substr(md5(tc.id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM turnos_caja tc JOIN cajas_pos cp ON cp.id = tc.caja_id WHERE cp.empresa_id = v_empresa_id) d
  WHERE t.id = d.id;

  UPDATE rutas r
  SET created_at         = created_at - (d.delta || ' days')::interval,
      fecha              = (fecha - (d.delta || ' days')::interval)::date,
      chofer_actualizado = CASE WHEN chofer_actualizado IS NOT NULL THEN chofer_actualizado - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM rutas WHERE empresa_id = v_empresa_id) d
  WHERE r.id = d.id;

  UPDATE facturas f
  SET fecha_emision     = fecha_emision - (d.delta || ' days')::interval,
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (fecha_vencimiento - (d.delta||' days')::interval)::date END,
      vencimiento       = CASE WHEN vencimiento IS NOT NULL THEN (vencimiento - (d.delta||' days')::interval)::date END,
      cae_vto           = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto - (d.delta||' days')::interval)::date END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM facturas WHERE empresa_id = v_empresa_id) d
  WHERE f.id = d.id;

  UPDATE ventas_pos v
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT vp.id, (('x'||substr(md5(vp.turno_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM ventas_pos vp WHERE vp.empresa_id = v_empresa_id) d
  WHERE v.id = d.id;

  UPDATE recepciones_mercaderia rm
  SET created_at    = created_at - (d.delta || ' days')::interval,
      confirmada_at = CASE WHEN confirmada_at IS NOT NULL THEN confirmada_at - (d.delta || ' days')::interval END
  FROM (SELECT r.id, (('x'||substr(md5(r.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM recepciones_mercaderia r WHERE r.empresa_id = v_empresa_id) d
  WHERE rm.id = d.id;

  UPDATE facturas_proveedor fp
  SET created_at        = created_at - (d.delta || ' days')::interval,
      updated_at        = updated_at - (d.delta || ' days')::interval,
      fecha_factura      = CASE WHEN fecha_factura IS NOT NULL THEN (fecha_factura - (d.delta||' days')::interval)::date END,
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (fecha_vencimiento - (d.delta||' days')::interval)::date END
  FROM (SELECT f2.id, (('x'||substr(md5(f2.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM facturas_proveedor f2 WHERE f2.empresa_id = v_empresa_id) d
  WHERE fp.id = d.id;

  UPDATE cta_cte c
  SET fecha      = fecha - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval
  FROM (SELECT c2.id,
               COALESCE((('x'||substr(md5(c2.factura_id::text),1,8))::bit(32)::bigint % 216),
                        (('x'||substr(md5(c2.id::text),1,8))::bit(32)::bigint % 216)) AS delta
        FROM cta_cte c2 WHERE c2.empresa_id = v_empresa_id) d
  WHERE c.id = d.id;

  UPDATE notas_credito nc
  SET fecha_emision = fecha_emision - (d.delta || ' days')::interval,
      cae_vto       = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto - (d.delta||' days')::interval)::date END,
      updated_at    = updated_at - (d.delta || ' days')::interval,
      created_at    = created_at - (d.delta || ' days')::interval
  FROM (SELECT n2.id, (('x'||substr(md5(n2.factura_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM notas_credito n2 WHERE n2.empresa_id = v_empresa_id) d
  WHERE nc.id = d.id;

  UPDATE pagos_proveedor pp
  SET created_at = created_at - (d.delta || ' days')::interval,
      fecha_pago = CASE WHEN fecha_pago IS NOT NULL THEN (fecha_pago - (d.delta||' days')::interval)::date END
  FROM (SELECT p2.id, (('x'||substr(md5(fp.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM pagos_proveedor p2 JOIN facturas_proveedor fp ON fp.id = p2.factura_id WHERE p2.empresa_id = v_empresa_id) d
  WHERE pp.id = d.id;

  UPDATE notas_debito_proveedor nd
  SET created_at = created_at - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval
  FROM (SELECT n2.id, (('x'||substr(md5(fp.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM notas_debito_proveedor n2 JOIN facturas_proveedor fp ON fp.id = n2.factura_id WHERE n2.empresa_id = v_empresa_id) d
  WHERE nd.id = d.id;

  UPDATE entregas e
  SET fecha_confirmacion = CASE WHEN fecha_confirmacion IS NOT NULL THEN fecha_confirmacion - (d.delta || ' days')::interval END
  FROM (SELECT e2.id, (('x'||substr(md5(e2.pedido_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM entregas e2 JOIN rutas ru ON ru.id = e2.ruta_id WHERE ru.empresa_id = v_empresa_id) d
  WHERE e.id = d.id;

  UPDATE devoluciones dv
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(pedido_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM devoluciones WHERE empresa_id = v_empresa_id) d
  WHERE dv.id = d.id;

  UPDATE devoluciones_pos dp
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT d2.id, (('x'||substr(md5(vp.turno_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM devoluciones_pos d2 JOIN ventas_pos vp ON vp.id = d2.venta_pos_id WHERE d2.empresa_id = v_empresa_id) d
  WHERE dp.id = d.id;

  UPDATE cobros c
  SET fecha = fecha - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM cobros WHERE empresa_id = v_empresa_id) d
  WHERE c.id = d.id;

  UPDATE cobro_facturas_aplicadas cfa
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT c2.id,
               COALESCE((('x'||substr(md5(c2.factura_id::text),1,8))::bit(32)::bigint % 216),
                        (('x'||substr(md5(c2.id::text),1,8))::bit(32)::bigint % 216)) AS delta
        FROM cobro_facturas_aplicadas c2 WHERE c2.empresa_id = v_empresa_id) d
  WHERE cfa.id = d.id;

  UPDATE whatsapp_conversaciones w
  SET created_at          = created_at - (d.delta || ' days')::interval,
      tomada_en           = CASE WHEN tomada_en IS NOT NULL THEN tomada_en - (d.delta || ' days')::interval END,
      turno_desde         = CASE WHEN turno_desde IS NOT NULL THEN turno_desde - (d.delta || ' days')::interval END,
      ultima_interaccion  = CASE WHEN ultima_interaccion IS NOT NULL THEN ultima_interaccion - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM whatsapp_conversaciones WHERE empresa_id = v_empresa_id) d
  WHERE w.id = d.id;

  UPDATE whatsapp_mensajes m
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT m2.id, (('x'||substr(md5(m2.conversacion_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM whatsapp_mensajes m2 JOIN whatsapp_conversaciones wc ON wc.id = m2.conversacion_id WHERE wc.empresa_id = v_empresa_id) d
  WHERE m.id = d.id;

  UPDATE asistente_conversaciones a
  SET creado_en      = creado_en - (d.delta || ' days')::interval,
      actualizado_en = CASE WHEN actualizado_en IS NOT NULL THEN actualizado_en - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM asistente_conversaciones WHERE empresa_id = v_empresa_id) d
  WHERE a.id = d.id;

  UPDATE asistente_mensajes am
  SET creado_en = creado_en - (d.delta || ' days')::interval
  FROM (SELECT m2.id, (('x'||substr(md5(m2.conversacion_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM asistente_mensajes m2 JOIN asistente_conversaciones ac ON ac.id = m2.conversacion_id WHERE ac.empresa_id = v_empresa_id) d
  WHERE am.id = d.id;

  UPDATE movimientos_puntos mp
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM movimientos_puntos WHERE empresa_id = v_empresa_id) d
  WHERE mp.id = d.id;

  UPDATE scores_cliente sc
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM scores_cliente WHERE empresa_id = v_empresa_id) d
  WHERE sc.id = d.id;

  UPDATE alertas_score als
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM alertas_score WHERE empresa_id = v_empresa_id) d
  WHERE als.id = d.id;

  UPDATE conciliacion_bancaria_lotes cbl
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM conciliacion_bancaria_lotes WHERE empresa_id = v_empresa_id) d
  WHERE cbl.id = d.id;

  UPDATE export_contable_log ecl
  SET created_at  = created_at - (d.delta || ' days')::interval,
      fecha_desde = CASE WHEN fecha_desde IS NOT NULL THEN (fecha_desde - (d.delta||' days')::interval)::date END,
      fecha_hasta = CASE WHEN fecha_hasta IS NOT NULL THEN (fecha_hasta - (d.delta||' days')::interval)::date END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM export_contable_log WHERE empresa_id = v_empresa_id) d
  WHERE ecl.id = d.id;

  UPDATE push_log pl
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT pl2.id, (('x'||substr(md5(pl2.id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM push_log pl2 JOIN usuarios u ON u.id = pl2.usuario_id WHERE u.empresa_id = v_empresa_id) d
  WHERE pl.id = d.id;

  UPDATE movimientos_stock ms
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (
    SELECT ms2.id, (('x'||substr(md5(COALESCE(ms2.referencia_id, ms2.id)::text),1,8))::bit(32)::bigint % 216) AS delta
    FROM movimientos_stock ms2
    JOIN productos p ON p.id = ms2.producto_id
    WHERE p.empresa_id = v_empresa_id
  ) d
  WHERE ms.id = d.id;

END;
$function$;
