-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 161: deshacer una sesión de migración "completado"
--
-- RECONSTRUIDO el 30/06 a partir del estado vivo de producción
-- (jgiquzjwoedmzwqgzubr) — ver nota de la migración 160 sobre por qué este
-- archivo no estaba en el repo hasta ahora.
--
-- NOTA: la versión de migracion_deshacer_sesion() que está viva hoy en
-- producción ya incluye las ramas de 'precios_clientes' y 'proveedores'
-- (entidades que numéricamente se agregan recién en las migraciones 162 y
-- 164). Eso es así porque en algún momento posterior a 161 se volvió a
-- correr CREATE OR REPLACE sobre esta misma función para sumarle esas dos
-- ramas — no hay una versión "161 original sin proveedores/precios" que
-- se pueda recuperar de la base, solo queda el estado final. Se deja el
-- archivo así (completo) en vez de fabricar una versión intermedia falsa.
--
-- Alcance de "deshacer": solo revierte filas que crearon una entidad nueva
-- (accion <> 'actualizar'); las actualizaciones de registros existentes NO
-- se revierten automáticamente (no hay snapshot del valor "antes"). Si la
-- entidad creada ya tiene movimientos asociados generados después de la
-- migración (cta_cte/pagos para clientes, OC/facturas/pagos para
-- proveedores), tampoco se borra sola: queda marcada como "omitida" con el
-- motivo, para revisión manual.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE migracion_staging_rows ADD COLUMN IF NOT EXISTS deshecho_en timestamptz;
ALTER TABLE migracion_staging_rows ADD COLUMN IF NOT EXISTS deshecho_error text;

CREATE OR REPLACE FUNCTION public.migracion_deshacer_sesion(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_entidad    TEXT,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT  DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_grupo           RECORD;
  v_accion          TEXT;
  v_resultado_id    UUID;
  v_eliminados      INT := 0;
  v_no_revertibles  INT := 0;
  v_omitidos        INT := 0;
  v_procesadas      INT := 0;
  v_motivo_omision  TEXT;
  v_cnt_cta_cte     INT;
  v_cnt_pagos       INT;
  v_cnt_oc          INT;
  v_cnt_fact_prov   INT;
  v_cnt_pagos_prov  INT;
BEGIN
  IF p_entidad NOT IN ('clientes', 'productos', 'pedidos', 'cta_cte', 'precios_clientes', 'proveedores') THEN
    RAISE EXCEPTION 'Entidad no soportada para deshacer: %', p_entidad;
  END IF;

  FOR v_grupo IN
    SELECT DISTINCT entidad_resultado_id, accion
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND entidad_resultado_id IS NOT NULL
       AND error_ejecucion IS NULL
       AND accion <> 'omitir'
       AND deshecho_en IS NULL
     ORDER BY entidad_resultado_id
     LIMIT p_lote_size
  LOOP
    v_procesadas := v_procesadas + 1;
    v_resultado_id := v_grupo.entidad_resultado_id;
    v_accion := v_grupo.accion;
    v_motivo_omision := NULL;

    BEGIN
      IF v_accion = 'actualizar' THEN
        -- No revertible automáticamente: sin snapshot confiable "antes".
        v_no_revertibles := v_no_revertibles + 1;
        v_motivo_omision := 'Actualización de un registro existente: no se revierte automáticamente, requiere revisión manual';

      ELSIF p_entidad = 'clientes' THEN
        SELECT count(*) INTO v_cnt_cta_cte FROM cta_cte WHERE cliente_id = v_resultado_id;
        SELECT count(*) INTO v_cnt_pagos   FROM transacciones_pago WHERE cliente_id = v_resultado_id;
        IF v_cnt_cta_cte > 0 OR v_cnt_pagos > 0 THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'Tiene cuenta corriente o pagos asociados (posiblemente generados después de la migración): no se elimina automáticamente';
        ELSE
          DELETE FROM clientes WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
          v_eliminados := v_eliminados + 1;
        END IF;

      ELSIF p_entidad = 'productos' THEN
        DELETE FROM productos WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;

      ELSIF p_entidad = 'pedidos' THEN
        DELETE FROM pedidos WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;

      ELSIF p_entidad = 'cta_cte' THEN
        DELETE FROM cta_cte WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;

      ELSIF p_entidad = 'precios_clientes' THEN
        DELETE FROM precios_clientes WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;

      ELSIF p_entidad = 'proveedores' THEN
        SELECT count(*) INTO v_cnt_oc        FROM ordenes_compra     WHERE proveedor_id = v_resultado_id;
        SELECT count(*) INTO v_cnt_fact_prov FROM facturas_proveedor WHERE proveedor_id = v_resultado_id;
        SELECT count(*) INTO v_cnt_pagos_prov FROM pagos_proveedor   WHERE proveedor_id = v_resultado_id;
        IF v_cnt_oc > 0 OR v_cnt_fact_prov > 0 OR v_cnt_pagos_prov > 0 THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'Tiene órdenes de compra, facturas o pagos asociados (posiblemente generados después de la migración): no se elimina automáticamente';
        ELSE
          DELETE FROM proveedores WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
          v_eliminados := v_eliminados + 1;
        END IF;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      v_omitidos := v_omitidos + 1;
      v_motivo_omision := SQLERRM;
    END;

    UPDATE migracion_staging_rows
       SET deshecho_en = now(), deshecho_error = v_motivo_omision
     WHERE sesion_id = p_sesion_id
       AND entidad_resultado_id = v_resultado_id
       AND deshecho_en IS NULL;
  END LOOP;

  RETURN jsonb_build_object(
    'procesadas', v_procesadas,
    'eliminados', v_eliminados,
    'no_revertibles', v_no_revertibles,
    'omitidos', v_omitidos,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;
