-- ============================================================
-- 519 — Fix: tablas que se perdían en cascada en cada reset del demo,
--        nunca snapshoteadas (saldo_puntos, scores_cliente, alertas_score,
--        reglas_precio, conteos_stock, proveedor_portal_tokens,
--        producto_insumos, whatsapp_reset_codigos, alertas_stock,
--        canjes_recompensas, transacciones_pago, whatsapp_conversaciones,
--        whatsapp_mensajes, devoluciones_pos_items, movimientos_stock_lotes)
-- ============================================================
--
-- CONTEXTO:
-- La auditoría de FKs hecha durante el debugging de 515-518 encontró que,
-- además de cobro_facturas_aplicadas (ya resuelto en 515), hay ~14 tablas
-- más con ON DELETE CASCADE hacia las tablas del reset (clientes,
-- productos, zonas, categorias, proveedores, movimientos_stock,
-- devoluciones_pos, listas_precios vía otras) que nunca se agregaron al
-- snapshot. No rompían nada (no daban error, a diferencia de las FKs
-- NO ACTION de 516/517) — simplemente se borraban en silencio cada vez
-- que se resetea el demo y no se restauraban. Con el cron cada 6 horas
-- (494/514), esto significa que funcionalidades enteras (fidelización,
-- scoring de clientes, pasarela de pago, alertas de stock, portal de
-- proveedores, recetas/insumos, historial de WhatsApp) quedan cada vez
-- más vacías con cada corrida.
--
-- FIX: se agregan las 14 tablas al ciclo de snapshot/reset (ord 57-70).
-- producto_insumos reemplaza el parche de 518 (que la borraba pero nunca
-- la restauraba) por un snapshot/restore completo, ahora que se confirmó
-- que tiene empresa_id propio.
--
-- Las que tienen una FK NO ACTION hacia una tabla del reset (mismo
-- problema que whatsapp_conversaciones.pedido_creado_id en 516) usan el
-- mismo patrón que pedidos.factura_id / ventas_pos.factura_id /
-- facturas.factura_origen_id: se excluye el campo del JSON antes del
-- INSERT y se restaura con un UPDATE al final, en vez de mutar la fila
-- viva antes del DELETE (por eso se retiran los parches puntuales de
-- 516/517 para canjes_recompensas.aplicado_en_pedido_id,
-- alertas_stock.orden_compra_id y whatsapp_conversaciones.pedido_creado_id
-- — ahora se resuelven como parte natural del ciclo). Los de
-- migracion_sesiones/migracion_plantillas_mapeo de 517 NO se tocan: esas
-- tablas son de la herramienta de migración de datos, no del demo, y
-- siguen sin estar en el ciclo de snapshot.
--
-- movimientos_stock_lotes es nieta (vía movimientos_stock, que a su vez
-- no tiene empresa_id propio) — se maneja aparte con una consulta propia
-- en vez del patrón genérico "es_hija" de un solo nivel.
--
-- whatsapp_mensajes y devoluciones_pos_items sí encajan en el patrón
-- "es_hija" estándar, ahora que sus padres (whatsapp_conversaciones,
-- devoluciones_pos) entran al ciclo.

-- ------------------------------------------------------------
-- 1. fn_snapshot_demo_v2
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
      (56, 'cobro_facturas_aplicadas',false, NULL,                 NULL),
      (57, 'saldo_puntos',            false, NULL,                 NULL),
      (58, 'scores_cliente',          false, NULL,                 NULL),
      (59, 'alertas_score',           false, NULL,                 NULL),
      (60, 'reglas_precio',           false, NULL,                 NULL),
      (61, 'conteos_stock',           false, NULL,                 NULL),
      (62, 'proveedor_portal_tokens', false, NULL,                 NULL),
      (63, 'producto_insumos',        false, NULL,                 NULL),
      (64, 'whatsapp_reset_codigos',  false, NULL,                 NULL),
      (65, 'alertas_stock',           false, NULL,                 NULL),
      (66, 'canjes_recompensas',      false, NULL,                 NULL),
      (67, 'transacciones_pago',      false, NULL,                 NULL),
      (68, 'whatsapp_conversaciones', false, NULL,                 NULL),
      (69, 'whatsapp_mensajes',       true,  'whatsapp_conversaciones', 'conversacion_id'),
      (70, 'devoluciones_pos_items',  true,  'devoluciones_pos',   'devolucion_id')
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

  -- movimientos_stock_lotes: nieta vía movimientos_stock (que no tiene
  -- empresa_id propio) -> productos.empresa_id. No encaja en el patrón
  -- genérico de un solo nivel, se snapshotea aparte.
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_part
  FROM (
    SELECT msl.id, msl.movimiento_stock_id, msl.lote_id, msl.cantidad, msl.direccion, msl.created_at
    FROM movimientos_stock_lotes msl
    JOIN movimientos_stock ms ON ms.id = msl.movimiento_stock_id
    JOIN productos p ON p.id = ms.producto_id
    WHERE p.empresa_id = v_empresa_id
  ) x;
  v_datos := jsonb_set(v_datos, ARRAY['movimientos_stock_lotes'], v_part);

  v_datos := jsonb_set(v_datos, ARRAY['empresa'], (SELECT to_jsonb(e) FROM empresas e WHERE e.id = v_empresa_id));

  INSERT INTO demo_snapshots (empresa_id, datos)
  VALUES (v_empresa_id, v_datos)
  ON CONFLICT (empresa_id) DO UPDATE
    SET datos = EXCLUDED.datos, actualizado_at = now();

  RETURN v_empresa_id;
END;
$function$;

-- ------------------------------------------------------------
-- 2. fn_reset_demo_v2
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
  v_migses jsonb;
  v_migplant jsonb;
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

  -- FKs externas NO ACTION que no forman parte del ciclo del reset
  -- (herramienta de migración de datos, ver CONTEXTO de 517 — sin cambios).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'lista_precio_id', lista_precio_id, 'deposito_id', deposito_id)), '[]'::jsonb)
  INTO v_migses FROM migracion_sesiones
  WHERE empresa_id = v_empresa_id AND (lista_precio_id IS NOT NULL OR deposito_id IS NOT NULL);
  UPDATE migracion_sesiones SET lista_precio_id = NULL, deposito_id = NULL
  WHERE empresa_id = v_empresa_id AND (lista_precio_id IS NOT NULL OR deposito_id IS NOT NULL);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'lista_precio_id', lista_precio_id, 'deposito_id', deposito_id)), '[]'::jsonb)
  INTO v_migplant FROM migracion_plantillas_mapeo
  WHERE empresa_id = v_empresa_id AND (lista_precio_id IS NOT NULL OR deposito_id IS NOT NULL);
  UPDATE migracion_plantillas_mapeo SET lista_precio_id = NULL, deposito_id = NULL
  WHERE empresa_id = v_empresa_id AND (lista_precio_id IS NOT NULL OR deposito_id IS NOT NULL);

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
      (56,'cobro_facturas_aplicadas',false,NULL,NULL),
      (57,'saldo_puntos',false,NULL,NULL),(58,'scores_cliente',false,NULL,NULL),(59,'alertas_score',false,NULL,NULL),
      (60,'reglas_precio',false,NULL,NULL),(61,'conteos_stock',false,NULL,NULL),(62,'proveedor_portal_tokens',false,NULL,NULL),
      (63,'producto_insumos',false,NULL,NULL),(64,'whatsapp_reset_codigos',false,NULL,NULL),(65,'alertas_stock',false,NULL,NULL),
      (66,'canjes_recompensas',false,NULL,NULL),(67,'transacciones_pago',false,NULL,NULL),(68,'whatsapp_conversaciones',false,NULL,NULL),
      (69,'whatsapp_mensajes',true,'whatsapp_conversaciones','conversacion_id'),
      (70,'devoluciones_pos_items',true,'devoluciones_pos','devolucion_id')
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
      (56,'cobro_facturas_aplicadas'),
      (57,'saldo_puntos'),(58,'scores_cliente'),(59,'alertas_score'),(60,'reglas_precio'),(61,'conteos_stock'),
      (62,'proveedor_portal_tokens'),(63,'producto_insumos'),(64,'whatsapp_reset_codigos'),(65,'alertas_stock'),
      (66,'canjes_recompensas'),(67,'transacciones_pago'),(68,'whatsapp_conversaciones'),(69,'whatsapp_mensajes'),
      (70,'devoluciones_pos_items')
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
    ELSIF v_cfg.tabla = 'alertas_stock' THEN
      SELECT COALESCE(jsonb_agg(elem - 'orden_compra_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    ELSIF v_cfg.tabla = 'canjes_recompensas' THEN
      SELECT COALESCE(jsonb_agg(elem - 'aplicado_en_pedido_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    ELSIF v_cfg.tabla = 'transacciones_pago' THEN
      SELECT COALESCE(jsonb_agg(elem - 'pedido_id' - 'factura_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    ELSIF v_cfg.tabla = 'whatsapp_conversaciones' THEN
      SELECT COALESCE(jsonb_agg(elem - 'pedido_creado_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
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

  -- movimientos_stock_lotes: nieta, se reinserta aparte una vez que
  -- movimientos_stock (padre) ya existe con los mismos ids del snapshot.
  INSERT INTO movimientos_stock_lotes (id, movimiento_stock_id, lote_id, cantidad, direccion, created_at)
  SELECT (elem->>'id')::uuid, (elem->>'movimiento_stock_id')::uuid, (elem->>'lote_id')::uuid,
         (elem->>'cantidad')::numeric, elem->>'direccion', (elem->>'created_at')::timestamptz
  FROM jsonb_array_elements(v_datos->'movimientos_stock_lotes') elem;

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

  UPDATE alertas_stock a SET orden_compra_id = (elem->>'orden_compra_id')::uuid
  FROM jsonb_array_elements(v_datos->'alertas_stock') elem
  WHERE a.id = (elem->>'id')::uuid AND elem->>'orden_compra_id' IS NOT NULL;

  UPDATE canjes_recompensas c SET aplicado_en_pedido_id = (elem->>'aplicado_en_pedido_id')::uuid
  FROM jsonb_array_elements(v_datos->'canjes_recompensas') elem
  WHERE c.id = (elem->>'id')::uuid AND elem->>'aplicado_en_pedido_id' IS NOT NULL;

  UPDATE transacciones_pago t SET
    pedido_id = (elem->>'pedido_id')::uuid,
    factura_id = (elem->>'factura_id')::uuid
  FROM jsonb_array_elements(v_datos->'transacciones_pago') elem
  WHERE t.id = (elem->>'id')::uuid AND (elem->>'pedido_id' IS NOT NULL OR elem->>'factura_id' IS NOT NULL);

  UPDATE whatsapp_conversaciones w SET pedido_creado_id = (elem->>'pedido_creado_id')::uuid
  FROM jsonb_array_elements(v_datos->'whatsapp_conversaciones') elem
  WHERE w.id = (elem->>'id')::uuid AND elem->>'pedido_creado_id' IS NOT NULL;

  UPDATE migracion_sesiones m SET
    lista_precio_id = (elem->>'lista_precio_id')::uuid,
    deposito_id = (elem->>'deposito_id')::uuid
  FROM jsonb_array_elements(v_migses) elem
  WHERE m.id = (elem->>'id')::uuid;

  UPDATE migracion_plantillas_mapeo m SET
    lista_precio_id = (elem->>'lista_precio_id')::uuid,
    deposito_id = (elem->>'deposito_id')::uuid
  FROM jsonb_array_elements(v_migplant) elem
  WHERE m.id = (elem->>'id')::uuid;

  UPDATE empresas e SET
    nombre = (v_datos->'empresa'->>'nombre'),
    activa = (v_datos->'empresa'->>'activa')::boolean,
    setup_completado = (v_datos->'empresa'->>'setup_completado')::boolean
  WHERE e.id = v_empresa_id;

END;
$function$;

REVOKE ALL ON FUNCTION public.fn_reset_demo_v2(uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. fn_redistribuir_fechas_demo: agrega redistribución de fechas para
--    las tablas nuevas que tienen columnas de fecha (deja intactas
--    scores_cliente/alertas_score/whatsapp_conversaciones/whatsapp_mensajes,
--    que ya se redistribuían desde 514 aunque no estuvieran en el ciclo
--    de snapshot).
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

  -- Nuevas: tablas agregadas al ciclo de snapshot en esta migración que
  -- tienen columnas de fecha propias.
  UPDATE saldo_puntos sp
  SET created_at = created_at - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval,
      ultimo_movimiento = CASE WHEN ultimo_movimiento IS NOT NULL THEN ultimo_movimiento - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM saldo_puntos WHERE empresa_id = v_empresa_id) d
  WHERE sp.id = d.id;

  UPDATE reglas_precio rp
  SET created_at  = created_at - (d.delta || ' days')::interval,
      updated_at  = updated_at - (d.delta || ' days')::interval,
      fecha_desde = CASE WHEN fecha_desde IS NOT NULL THEN (fecha_desde - (d.delta||' days')::interval)::date END,
      fecha_hasta = CASE WHEN fecha_hasta IS NOT NULL THEN (fecha_hasta - (d.delta||' days')::interval)::date END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM reglas_precio WHERE empresa_id = v_empresa_id) d
  WHERE rp.id = d.id;

  UPDATE conteos_stock cs
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM conteos_stock WHERE empresa_id = v_empresa_id) d
  WHERE cs.id = d.id;

  UPDATE proveedor_portal_tokens ppt
  SET creado_at     = creado_at - (d.delta || ' days')::interval,
      expira_at     = CASE WHEN expira_at IS NOT NULL THEN expira_at - (d.delta || ' days')::interval END,
      revocado_at   = CASE WHEN revocado_at IS NOT NULL THEN revocado_at - (d.delta || ' days')::interval END,
      ultimo_uso_at = CASE WHEN ultimo_uso_at IS NOT NULL THEN ultimo_uso_at - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM proveedor_portal_tokens WHERE empresa_id = v_empresa_id) d
  WHERE ppt.id = d.id;

  UPDATE producto_insumos pi
  SET created_at = created_at - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM producto_insumos WHERE empresa_id = v_empresa_id) d
  WHERE pi.id = d.id;

  UPDATE whatsapp_reset_codigos wrc
  SET created_at = created_at - (d.delta || ' days')::interval,
      expira_at  = CASE WHEN expira_at IS NOT NULL THEN expira_at - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM whatsapp_reset_codigos WHERE empresa_id = v_empresa_id) d
  WHERE wrc.id = d.id;

  UPDATE alertas_stock als2
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM alertas_stock WHERE empresa_id = v_empresa_id) d
  WHERE als2.id = d.id;

  UPDATE canjes_recompensas cr
  SET created_at  = created_at - (d.delta || ' days')::interval,
      aplicado_at = CASE WHEN aplicado_at IS NOT NULL THEN aplicado_at - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM canjes_recompensas WHERE empresa_id = v_empresa_id) d
  WHERE cr.id = d.id;

  UPDATE transacciones_pago tp
  SET created_at = created_at - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM transacciones_pago WHERE empresa_id = v_empresa_id) d
  WHERE tp.id = d.id;

  UPDATE movimientos_stock_lotes msl
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(movimiento_stock_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM movimientos_stock_lotes msl2
        JOIN movimientos_stock ms ON ms.id = msl2.movimiento_stock_id
        JOIN productos p ON p.id = ms.producto_id
        WHERE p.empresa_id = v_empresa_id) d
  WHERE msl.id = d.id;

END;
$function$;
