-- 569_track_funciones_fantasma.sql
--
-- Trackea las 7 funciones que `npm run audit:funciones-fantasma` reportó
-- como "fantasma": viven en pg_proc (schema public) pero no tenían ningún
-- CREATE FUNCTION en supabase/migrations/, así que un `supabase db reset`
-- / recrear el proyecto desde cero NO las traería de vuelta. Se crearon
-- en algún momento a mano desde el SQL editor de Supabase y nunca
-- quedaron versionadas. Mismo caso que forzar_cierre_turno_caja,
-- trackeada recién en la migración 241.
--
-- Los cuerpos de acá abajo son la definición REAL sacada de producción con
-- pg_get_functiondef(oid) (vía Supabase MCP), no una reconstrucción — copia
-- exacta de lo que ya está corriendo. Este archivo es CREATE OR REPLACE
-- puro: no cambia comportamiento, solo lo deja versionado.
--
-- Dos de las 7 (trigger_sync_saldo_puntos, trigger_saas_avisar_nuevo_tenant)
-- son funciones de trigger — el CREATE FUNCTION solo no alcanza para que un
-- reset recree el comportamiento real, hace falta además el CREATE TRIGGER
-- que las conecta a su tabla. Verificado con pg_get_triggerdef: ese wiring
-- TAMPOCO estaba en ninguna migración, así que se agrega acá también.

-- ════════════════════════════════════════════════════════════════════════
-- 1. fn_asegurar_piso_reciente_demo — mantiene "piso" de actividad reciente
--    (rutas/facturas) en la empresa demo para que nunca se vea vacía.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_asegurar_piso_reciente_demo(p_empresa_id uuid DEFAULT NULL::uuid)
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
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para asegurar piso reciente';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  -- ── PISO 1: rutas — al menos 6 dentro de los últimos 30 días ────────
  DROP TABLE IF EXISTS tmp_piso_rutas;
  CREATE TEMP TABLE tmp_piso_rutas AS
  SELECT id AS ruta_id,
         (
           (CURRENT_DATE - (2 + (rn - 1) * 4 + floor(random() * 3)::int)::int)
           - fecha
         ) AS delta_dias
  FROM (
    SELECT r.id, r.fecha, row_number() OVER (ORDER BY r.fecha DESC) AS rn
    FROM rutas r
    WHERE r.empresa_id = v_empresa_id
      AND r.fecha < (CURRENT_DATE - 30)
    ORDER BY r.fecha DESC
    LIMIT GREATEST(0, 6 - (
      SELECT count(*) FROM rutas
      WHERE empresa_id = v_empresa_id AND fecha >= (CURRENT_DATE - 30)
    ))
  ) candidatas;

  UPDATE rutas r
  SET fecha              = fecha + (t.delta_dias || ' days')::interval,
      created_at         = created_at + (t.delta_dias || ' days')::interval,
      chofer_actualizado = CASE WHEN chofer_actualizado IS NOT NULL
                                 THEN chofer_actualizado + (t.delta_dias || ' days')::interval END
  FROM tmp_piso_rutas t
  WHERE r.id = t.ruta_id;

  UPDATE entregas e
  SET fecha_confirmacion = CASE WHEN fecha_confirmacion IS NOT NULL
                                 THEN fecha_confirmacion + (t.delta_dias || ' days')::interval END
  FROM tmp_piso_rutas t
  WHERE e.ruta_id = t.ruta_id;

  DROP TABLE tmp_piso_rutas;

  -- ── PISO 2: facturas pendientes — al menos 4 dentro de últimos 30 días
  DROP TABLE IF EXISTS tmp_piso_facturas;
  CREATE TEMP TABLE tmp_piso_facturas AS
  SELECT id AS factura_id,
         (
           (CURRENT_DATE - (3 + (rn - 1) * 5 + floor(random() * 4)::int)::int)::timestamptz
           - fecha_emision
         ) AS delta
  FROM (
    SELECT f.id, f.fecha_emision, row_number() OVER (ORDER BY f.fecha_emision DESC) AS rn
    FROM facturas f
    WHERE f.empresa_id = v_empresa_id
      AND f.estado::text = 'pendiente'
      AND f.fecha_emision < (CURRENT_DATE - 30)
    ORDER BY f.fecha_emision DESC
    LIMIT GREATEST(0, 4 - (
      SELECT count(*) FROM facturas
      WHERE empresa_id = v_empresa_id AND estado::text = 'pendiente'
        AND fecha_emision >= (CURRENT_DATE - 30)
    ))
  ) candidatas;

  UPDATE facturas f
  SET fecha_emision     = fecha_emision + t.delta,
      vencimiento       = CASE WHEN vencimiento IS NOT NULL THEN (vencimiento::timestamptz + t.delta)::date END,
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (fecha_vencimiento::timestamptz + t.delta)::date END,
      cae_vto           = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto::timestamptz + t.delta)::date END
  FROM tmp_piso_facturas t
  WHERE f.id = t.factura_id;

  UPDATE cta_cte c
  SET fecha      = fecha + t.delta,
      updated_at = updated_at + t.delta
  FROM tmp_piso_facturas t
  WHERE c.factura_id = t.factura_id;

  UPDATE notas_credito nc
  SET fecha_emision = fecha_emision + t.delta,
      cae_vto       = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto::timestamptz + t.delta)::date END,
      updated_at    = updated_at + t.delta,
      created_at    = created_at + t.delta
  FROM tmp_piso_facturas t
  WHERE nc.factura_id = t.factura_id;

  UPDATE cobro_facturas_aplicadas cfa
  SET created_at = created_at + t.delta
  FROM tmp_piso_facturas t
  WHERE cfa.factura_id = t.factura_id;

  DROP TABLE tmp_piso_facturas;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════════
-- 2. fn_extraer_medida — parsea "2x500grs", "1.5 kg", etc. de un nombre de
--    producto para el matching de captura de precios de competencia
--    (bloqueo de mismatch de unidad). IMMUTABLE, sin permisos elevados.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_extraer_medida(p_texto text)
 RETURNS TABLE(tipo text, valor numeric)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v_match   text[];
  v_cant    numeric;
  v_mult    numeric := 1;
  v_unidad  text;
BEGIN
  v_match := regexp_match(lower(p_texto), '(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(kgs?|gr?s?|l|lt|ml|cc)\y');
  IF v_match IS NOT NULL THEN
    v_mult   := v_match[1]::numeric;
    v_cant   := replace(v_match[2], ',', '.')::numeric;
    v_unidad := v_match[3];
  ELSE
    v_match := regexp_match(lower(p_texto), '(?:^|[^0-9])x?\s*(\d+(?:[.,]\d+)?)\s*(kgs?|gr?s?|l|lt|ml|cc)\y');
    IF v_match IS NULL THEN
      RETURN;
    END IF;
    v_cant   := replace(v_match[1], ',', '.')::numeric;
    v_unidad := v_match[2];
  END IF;

  IF v_unidad IN ('kg', 'kgs') THEN
    tipo := 'peso'; valor := v_cant * v_mult * 1000;
  ELSIF v_unidad IN ('g', 'gr', 'grs') THEN
    tipo := 'peso'; valor := v_cant * v_mult;
  ELSIF v_unidad IN ('l', 'lt') THEN
    tipo := 'volumen'; valor := v_cant * v_mult * 1000;
  ELSIF v_unidad IN ('ml', 'cc') THEN
    tipo := 'volumen'; valor := v_cant * v_mult;
  ELSE
    RETURN;
  END IF;
  RETURN NEXT;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════════
-- 3. fn_generar_alertas_stock_autonomo — a partir de analizar_stock_autonomo()
--    (035/049/071/460, sí trackeada), genera órdenes de compra auto y
--    alertas_stock (sin_historial / sin_proveedor / critico / quiebre).
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_generar_alertas_stock_autonomo(p_empresa_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prov RECORD;
  v_orden_id uuid;
  v_numero text;
  v_subtotal numeric;
BEGIN
  DROP TABLE IF EXISTS tmp_analisis_stock;
  CREATE TEMP TABLE tmp_analisis_stock ON COMMIT DROP AS
  SELECT * FROM analizar_stock_autonomo(p_empresa_id);

  -- sin_historial: necesita reponer pero sin cantidad sugerida calculable
  INSERT INTO alertas_stock (empresa_id, producto_id, tipo, dias_restantes, orden_compra_id, resuelta)
  SELECT p_empresa_id, producto_id, 'sin_historial', dias_restantes, NULL, false
  FROM tmp_analisis_stock
  WHERE necesita_reponer AND NOT (cantidad_sugerida > 0)
  ON CONFLICT (producto_id, tipo, resuelta) DO NOTHING;

  -- sin_proveedor: necesita reponer, cantidad calculable, sin proveedor default
  INSERT INTO alertas_stock (empresa_id, producto_id, tipo, dias_restantes, orden_compra_id, resuelta)
  SELECT p_empresa_id, producto_id, 'sin_proveedor', dias_restantes, NULL, false
  FROM tmp_analisis_stock
  WHERE necesita_reponer AND cantidad_sugerida > 0 AND proveedor_id IS NULL
  ON CONFLICT (producto_id, tipo, resuelta) DO NOTHING;

  -- con proveedor: una orden auto-generada por proveedor (si no hay una
  -- reciente en los últimos 7 días) + alertas critico/quiebre
  FOR v_prov IN
    SELECT DISTINCT proveedor_id
    FROM tmp_analisis_stock
    WHERE necesita_reponer AND cantidad_sugerida > 0 AND proveedor_id IS NOT NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM ordenes_compra
      WHERE empresa_id = p_empresa_id
        AND proveedor_id = v_prov.proveedor_id
        AND estado IN ('borrador','pendiente_aprobacion','enviada')
        AND created_at >= now() - interval '7 days'
    ) THEN
      CONTINUE;
    END IF;

    v_numero := 'AUTO-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));

    SELECT COALESCE(SUM(ceil(a.cantidad_sugerida) * COALESCE(p.costo,0)),0)
    INTO v_subtotal
    FROM tmp_analisis_stock a JOIN productos p ON p.id = a.producto_id
    WHERE a.necesita_reponer AND a.cantidad_sugerida > 0 AND a.proveedor_id = v_prov.proveedor_id;

    INSERT INTO ordenes_compra (empresa_id, proveedor_id, numero, estado, fecha_pedido, fecha_esperada, subtotal, total, auto_generada)
    VALUES (p_empresa_id, v_prov.proveedor_id, v_numero, 'pendiente_aprobacion', now(), CURRENT_DATE + 7, v_subtotal, v_subtotal, true)
    RETURNING id INTO v_orden_id;

    INSERT INTO ordenes_compra_items (orden_id, producto_id, descripcion, cantidad, precio_unitario, subtotal, precio_costo)
    SELECT v_orden_id, a.producto_id, COALESCE(p.nombre, a.nombre), ceil(a.cantidad_sugerida)::int,
           COALESCE(p.costo,0), ceil(a.cantidad_sugerida)*COALESCE(p.costo,0), COALESCE(p.costo,0)
    FROM tmp_analisis_stock a JOIN productos p ON p.id = a.producto_id
    WHERE a.necesita_reponer AND a.cantidad_sugerida > 0 AND a.proveedor_id = v_prov.proveedor_id;

    INSERT INTO alertas_stock (empresa_id, producto_id, tipo, dias_restantes, orden_compra_id, resuelta)
    SELECT p_empresa_id, a.producto_id,
           CASE WHEN a.dias_restantes < 3 THEN 'quiebre' ELSE 'critico' END,
           a.dias_restantes, v_orden_id, false
    FROM tmp_analisis_stock a
    WHERE a.necesita_reponer AND a.cantidad_sugerida > 0 AND a.proveedor_id = v_prov.proveedor_id
    ON CONFLICT (producto_id, tipo, resuelta) DO NOTHING;
  END LOOP;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════════
-- 4. fn_relink_portal_clientes_demo — re-vincula usuarios de portal cliente
--    (rol='cliente') con su fila en clientes por teléfono normalizado a
--    E.164 + "@portal.distrib", para la empresa demo.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_relink_portal_clientes_demo(p_empresa_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  WITH tel_norm AS (
    SELECT
      c.id AS cliente_id,
      (
        CASE
          WHEN regexp_replace(c.telefono, '\D', '', 'g') LIKE '54%' THEN regexp_replace(c.telefono, '\D', '', 'g')
          WHEN regexp_replace(c.telefono, '\D', '', 'g') LIKE '0%'  THEN '54' || substring(regexp_replace(c.telefono, '\D', '', 'g') FROM 2)
          ELSE '54' || regexp_replace(c.telefono, '\D', '', 'g')
        END
      ) || '@portal.distrib' AS email_esperado
    FROM public.clientes c
    WHERE c.empresa_id = p_empresa_id AND c.telefono IS NOT NULL AND c.telefono <> ''
  ),
  match AS (
    SELECT t.cliente_id, u.id AS usuario_id
    FROM tel_norm t
    JOIN public.usuarios u ON u.email = t.email_esperado AND u.rol = 'cliente'
  )
  UPDATE public.usuarios u
  SET cliente_id = m.cliente_id
  FROM match m
  WHERE u.id = m.usuario_id AND u.cliente_id IS DISTINCT FROM m.cliente_id;

  WITH tel_norm AS (
    SELECT
      c.id AS cliente_id,
      (
        CASE
          WHEN regexp_replace(c.telefono, '\D', '', 'g') LIKE '54%' THEN regexp_replace(c.telefono, '\D', '', 'g')
          WHEN regexp_replace(c.telefono, '\D', '', 'g') LIKE '0%'  THEN '54' || substring(regexp_replace(c.telefono, '\D', '', 'g') FROM 2)
          ELSE '54' || regexp_replace(c.telefono, '\D', '', 'g')
        END
      ) || '@portal.distrib' AS email_esperado
    FROM public.clientes c
    WHERE c.empresa_id = p_empresa_id AND c.telefono IS NOT NULL AND c.telefono <> ''
  ),
  match AS (
    SELECT t.cliente_id, u.id AS usuario_id
    FROM tel_norm t
    JOIN public.usuarios u ON u.email = t.email_esperado AND u.rol = 'cliente'
  )
  UPDATE public.clientes c
  SET usuario_id = m.usuario_id
  FROM match m
  WHERE c.id = m.cliente_id AND c.usuario_id IS DISTINCT FROM m.usuario_id;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════════
-- 5. resolver_deposito_pedido — resuelve qué depósito usar para un pedido:
--    el explícito (si está activo) → el default del cliente → el principal
--    de la empresa. Mencionada solo en un comentario de la migración 550
--    ("resolver_deposito_pedido() y el crear_pedido_cliente() de 13
--    parámetros"), nunca definida ahí ni en ningún otro lado hasta ahora.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.resolver_deposito_pedido(p_empresa_id uuid, p_cliente_id uuid, p_deposito_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deposito_cliente uuid;
  v_resuelto         uuid;
BEGIN
  IF p_deposito_id IS NOT NULL THEN
    SELECT id INTO v_resuelto FROM depositos
     WHERE id = p_deposito_id AND empresa_id = p_empresa_id AND activa = true;
    IF v_resuelto IS NOT NULL THEN RETURN v_resuelto; END IF;
  END IF;

  SELECT deposito_id INTO v_deposito_cliente FROM clientes WHERE id = p_cliente_id;
  IF v_deposito_cliente IS NOT NULL THEN
    SELECT id INTO v_resuelto FROM depositos
     WHERE id = v_deposito_cliente AND empresa_id = p_empresa_id AND activa = true;
    IF v_resuelto IS NOT NULL THEN RETURN v_resuelto; END IF;
  END IF;

  SELECT id INTO v_resuelto FROM depositos
   WHERE empresa_id = p_empresa_id AND es_principal = true AND activa = true;

  RETURN v_resuelto;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════════
-- 6. trigger_sync_saldo_puntos — mantiene saldo_puntos sincronizado ante
--    cualquier INSERT/UPDATE/DELETE en movimientos_puntos.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trigger_sync_saldo_puntos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cliente_id uuid;
  v_empresa_id uuid;
begin
  -- 1) Revertir el efecto de la fila vieja (UPDATE/DELETE)
  if tg_op in ('UPDATE','DELETE') then
    v_cliente_id := OLD.cliente_id;
    v_empresa_id := OLD.empresa_id;

    insert into public.saldo_puntos (cliente_id, empresa_id, puntos_disponibles, puntos_totales, puntos_canjeados)
    values (v_cliente_id, v_empresa_id, 0, 0, 0)
    on conflict (cliente_id, empresa_id) do nothing;

    if OLD.tipo = 'canje' then
      update public.saldo_puntos
         set puntos_disponibles = puntos_disponibles + abs(OLD.cantidad),
             puntos_canjeados   = puntos_canjeados   - abs(OLD.cantidad)
       where cliente_id = v_cliente_id and empresa_id = v_empresa_id;
    else -- 'ganancia' / 'ajuste' / cualquier otro tipo futuro
      update public.saldo_puntos
         set puntos_disponibles = puntos_disponibles - OLD.cantidad,
             puntos_totales     = puntos_totales     - OLD.cantidad
       where cliente_id = v_cliente_id and empresa_id = v_empresa_id;
    end if;
  end if;

  -- 2) Aplicar el efecto de la fila nueva (INSERT/UPDATE)
  if tg_op in ('INSERT','UPDATE') then
    v_cliente_id := NEW.cliente_id;
    v_empresa_id := NEW.empresa_id;

    insert into public.saldo_puntos (cliente_id, empresa_id, puntos_disponibles, puntos_totales, puntos_canjeados)
    values (v_cliente_id, v_empresa_id, 0, 0, 0)
    on conflict (cliente_id, empresa_id) do nothing;

    if NEW.tipo = 'canje' then
      update public.saldo_puntos
         set puntos_disponibles = puntos_disponibles - abs(NEW.cantidad),
             puntos_canjeados   = puntos_canjeados   + abs(NEW.cantidad),
             ultimo_movimiento  = greatest(coalesce(ultimo_movimiento, NEW.created_at), NEW.created_at),
             updated_at         = now()
       where cliente_id = v_cliente_id and empresa_id = v_empresa_id;
    else
      update public.saldo_puntos
         set puntos_disponibles = puntos_disponibles + NEW.cantidad,
             puntos_totales     = puntos_totales     + NEW.cantidad,
             ultimo_movimiento  = greatest(coalesce(ultimo_movimiento, NEW.created_at), NEW.created_at),
             updated_at         = now()
       where cliente_id = v_cliente_id and empresa_id = v_empresa_id;
    end if;
  end if;

  -- 3) Recalcular ultimo_movimiento con precision tras un DELETE/UPDATE
  --    (por si se borro/edito justo el movimiento mas reciente).
  if tg_op in ('UPDATE','DELETE') then
    update public.saldo_puntos sp
       set ultimo_movimiento = (
             select max(mp.created_at) from public.movimientos_puntos mp
              where mp.cliente_id = sp.cliente_id and mp.empresa_id = sp.empresa_id
           ),
           updated_at = now()
     where sp.cliente_id = (case when tg_op = 'DELETE' then OLD.cliente_id else NEW.cliente_id end)
       and sp.empresa_id = (case when tg_op = 'DELETE' then OLD.empresa_id else NEW.empresa_id end);
  end if;

  return coalesce(NEW, OLD);
end;
$function$;

-- Wiring del trigger — verificado con pg_get_triggerdef que TAMPOCO estaba
-- trackeado. DROP + CREATE (no existe "CREATE OR REPLACE TRIGGER" en esta
-- versión de Postgres) para que la migración sea reproducible desde cero.
DROP TRIGGER IF EXISTS tg_sync_saldo_puntos ON public.movimientos_puntos;
CREATE TRIGGER tg_sync_saldo_puntos
  AFTER INSERT OR DELETE OR UPDATE ON public.movimientos_puntos
  FOR EACH ROW EXECUTE FUNCTION trigger_sync_saldo_puntos();

-- ════════════════════════════════════════════════════════════════════════
-- 7. trigger_saas_avisar_nuevo_tenant — al insertar una empresa nueva,
--    avisa (fire-and-forget vía net.http_post) al endpoint de alertas SaaS.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trigger_saas_avisar_nuevo_tenant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_secret  text;
  v_payload jsonb;
BEGIN
  v_secret := public.get_push_secret();

  v_payload := jsonb_build_object(
    'tipo', 'nuevo_tenant',
    'empresa', jsonb_build_object(
      'id', NEW.id,
      'nombre', NEW.nombre,
      'email', NEW.email,
      'cuit', NEW.cuit,
      'created_at', NEW.created_at,
      'saas_plan', NEW.saas_plan,
      'saas_trial_fin', NEW.saas_trial_fin
    )
  );

  BEGIN
    PERFORM net.http_post(
      url     := 'https://distrib-app-nine.vercel.app/api/index?_mod=saas-alertas',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-push-secret', v_secret
      ),
      body    := v_payload
    );
  EXCEPTION WHEN OTHERS THEN
    -- Un error de red/email nunca debe abortar el alta del tenant
    NULL;
  END;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_saas_avisar_nuevo_tenant ON public.empresas;
CREATE TRIGGER trg_saas_avisar_nuevo_tenant
  AFTER INSERT ON public.empresas
  FOR EACH ROW EXECUTE FUNCTION trigger_saas_avisar_nuevo_tenant();

-- ════════════════════════════════════════════════════════════════════════
-- Permisos — reproducen exactamente lo verificado en producción con
-- has_function_privilege() antes de esta migración. Ninguna de las 7 tenía
-- permisos que este CREATE OR REPLACE fuera a alterar (Postgres preserva
-- privilegios existentes en un REPLACE), pero se dejan explícitos acá para
-- que la migración sea autocontenida y quede documentado el criterio:
-- todo lo SECURITY DEFINER queda service_role-only salvo fn_extraer_medida,
-- que es IMMUTABLE de solo cómputo (sin acceso a tablas) y se usa desde
-- consultas de cliente para el comparador de precios de competencia.
-- ════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.fn_asegurar_piso_reciente_demo(uuid)      FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_generar_alertas_stock_autonomo(uuid)   FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_relink_portal_clientes_demo(uuid)     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolver_deposito_pedido(uuid,uuid,uuid) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_extraer_medida(text) TO anon, authenticated, service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260831000003_569_track_funciones_fantasma.sql',
  '569',
  'claude_assistant',
  'Trackea las 7 funciones fantasma reportadas por audit:funciones-fantasma (fn_asegurar_piso_reciente_demo, fn_extraer_medida, fn_generar_alertas_stock_autonomo, fn_relink_portal_clientes_demo, resolver_deposito_pedido, trigger_saas_avisar_nuevo_tenant, trigger_sync_saldo_puntos). Cuerpos sacados 1:1 de producción con pg_get_functiondef. Incluye además el CREATE TRIGGER de las 2 funciones de trigger (tg_sync_saldo_puntos en movimientos_puntos, trg_saas_avisar_nuevo_tenant en empresas), que tampoco estaba trackeado (verificado con pg_get_triggerdef). No cambia comportamiento — CREATE OR REPLACE puro sobre lo que ya corre.'
)
ON CONFLICT DO NOTHING;
