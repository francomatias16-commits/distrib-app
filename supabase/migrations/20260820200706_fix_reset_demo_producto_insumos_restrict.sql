-- ============================================================
-- 518 — Fix: fn_reset_demo_v2 falla por FK RESTRICT producto_insumos.insumo_id
-- ============================================================
-- producto_insumos no está en el ciclo del reset (recetas/insumos no se
-- snapshotean). Su FK insumo_id es RESTRICT y su FK producto_terminado_id
-- es CASCADE — en el mismo DELETE de productos, el orden de evaluación de
-- ambos triggers puede disparar el RESTRICT antes que el CASCADE. Se borra
-- explícito antes del ciclo para evitar el conflicto (de todos modos se
-- perdería por la cascada; no se restaura porque nunca se snapshoteó).
-- (Esta versión ya estaba corriendo en producción vía execute_sql directo
-- durante el debugging; esta migración solo la deja registrada en
-- supabase_migrations.schema_migrations.)
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
  v_wc_pedido_creado jsonb;
  v_canjes_pedido jsonb;
  v_alertas_oc jsonb;
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

  DELETE FROM producto_insumos WHERE empresa_id = v_empresa_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'pedido_creado_id', pedido_creado_id)), '[]'::jsonb)
  INTO v_wc_pedido_creado FROM whatsapp_conversaciones
  WHERE empresa_id = v_empresa_id AND pedido_creado_id IS NOT NULL;
  UPDATE whatsapp_conversaciones SET pedido_creado_id = NULL
  WHERE empresa_id = v_empresa_id AND pedido_creado_id IS NOT NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'aplicado_en_pedido_id', aplicado_en_pedido_id)), '[]'::jsonb)
  INTO v_canjes_pedido FROM canjes_recompensas
  WHERE empresa_id = v_empresa_id AND aplicado_en_pedido_id IS NOT NULL;
  UPDATE canjes_recompensas SET aplicado_en_pedido_id = NULL
  WHERE empresa_id = v_empresa_id AND aplicado_en_pedido_id IS NOT NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'orden_compra_id', orden_compra_id)), '[]'::jsonb)
  INTO v_alertas_oc FROM alertas_stock
  WHERE empresa_id = v_empresa_id AND orden_compra_id IS NOT NULL;
  UPDATE alertas_stock SET orden_compra_id = NULL
  WHERE empresa_id = v_empresa_id AND orden_compra_id IS NOT NULL;

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

  UPDATE whatsapp_conversaciones w SET pedido_creado_id = (elem->>'pedido_creado_id')::uuid
  FROM jsonb_array_elements(v_wc_pedido_creado) elem
  WHERE w.id = (elem->>'id')::uuid;

  UPDATE canjes_recompensas c SET aplicado_en_pedido_id = (elem->>'aplicado_en_pedido_id')::uuid
  FROM jsonb_array_elements(v_canjes_pedido) elem
  WHERE c.id = (elem->>'id')::uuid;

  UPDATE alertas_stock a SET orden_compra_id = (elem->>'orden_compra_id')::uuid
  FROM jsonb_array_elements(v_alertas_oc) elem
  WHERE a.id = (elem->>'id')::uuid;

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
