-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 164: proveedores como maestro propio, entidad del wizard
--
-- RECONSTRUIDO el 30/06 a partir del estado vivo de producción
-- (jgiquzjwoedmzwqgzubr) — ver nota de la migración 160.
--
-- A diferencia de pedidos/cta_cte/precios_clientes, acá SÍ se autocrean
-- proveedores (hoy ya pasa como efecto colateral de migrar productos, que
-- deja proveedores "stub" con solo razón social). Por eso esta función
-- soporta dos caminos:
--  - accion = 'actualizar' + entidad_existente_id: completa un proveedor
--    existente (típicamente un stub) sin pisar campos que ya tenían datos
--    reales — solo entran los campos que la fila trae con valor.
--  - cualquier otro caso: inserta un proveedor nuevo.
-- Dedupe (por CUIT si está presente, si no por razón_social) se resuelve
-- server-side en el paso de mapeo, no acá.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE migracion_sesiones DROP CONSTRAINT IF EXISTS migracion_sesiones_entidad_check;
ALTER TABLE migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY['clientes'::text, 'productos'::text, 'pedidos'::text, 'cta_cte'::text, 'precios_clientes'::text, 'proveedores'::text]));

CREATE OR REPLACE FUNCTION public.migracion_confirmar_proveedores_lote(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT  DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fila         RECORD;
  v_d            JSONB;
  v_creados      INT := 0;
  v_actualizados INT := 0;
  v_errores      JSONB := '[]'::jsonb;
  v_nuevo_id     UUID;
  v_procesadas   INT := 0;
  v_cond_iva     TEXT;
BEGIN
  FOR v_fila IN
    SELECT id, fila_numero, datos_mapeados, accion, entidad_existente_id
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND es_valida = true
       AND accion <> 'omitir'
       AND procesado_en IS NULL
     ORDER BY fila_numero
     LIMIT p_lote_size
       FOR UPDATE SKIP LOCKED
  LOOP
    v_procesadas := v_procesadas + 1;
    v_d := COALESCE(v_fila.datos_mapeados, '{}'::jsonb);

    BEGIN
      v_cond_iva := migracion_normalizar_condicion_iva(v_d->>'condicion_iva');

      IF v_fila.accion = 'actualizar' AND v_fila.entidad_existente_id IS NOT NULL THEN
        -- Completa un proveedor existente (típicamente un stub autocreado
        -- por nombre desde la migración de productos): solo pisa los
        -- campos que la fila realmente trae, nunca borra datos ya cargados.
        UPDATE proveedores SET
          razon_social    = COALESCE(NULLIF(TRIM(v_d->>'razon_social'), ''), razon_social),
          nombre_fantasia = COALESCE(NULLIF(TRIM(v_d->>'nombre_fantasia'), ''), nombre_fantasia),
          cuit            = COALESCE(NULLIF(regexp_replace(COALESCE(v_d->>'cuit', ''), '[^0-9]', '', 'g'), ''), cuit),
          condicion_iva   = COALESCE(v_cond_iva, condicion_iva),
          contacto        = COALESCE(NULLIF(TRIM(v_d->>'contacto'), ''), contacto),
          telefono        = COALESCE(NULLIF(TRIM(v_d->>'telefono'), ''), telefono),
          email           = COALESCE(NULLIF(TRIM(v_d->>'email'), ''), email),
          dias_pago       = CASE WHEN NULLIF(TRIM(v_d->>'dias_pago'), '') IS NOT NULL
                                  THEN (v_d->>'dias_pago')::INT ELSE dias_pago END,
          domicilio       = COALESCE(NULLIF(TRIM(v_d->>'domicilio'), ''), domicilio),
          localidad       = COALESCE(NULLIF(TRIM(v_d->>'localidad'), ''), localidad),
          notas           = COALESCE(NULLIF(TRIM(v_d->>'notas'), ''), notas),
          updated_at      = now()
        WHERE id = v_fila.entidad_existente_id AND empresa_id = p_empresa_id;

        v_actualizados := v_actualizados + 1;
        UPDATE migracion_staging_rows
           SET procesado_en = now(), entidad_resultado_id = v_fila.entidad_existente_id
         WHERE id = v_fila.id;
      ELSE
        INSERT INTO proveedores (
          empresa_id, razon_social, nombre_fantasia, cuit, condicion_iva,
          contacto, telefono, email, dias_pago, domicilio, localidad, notas
        ) VALUES (
          p_empresa_id,
          NULLIF(TRIM(v_d->>'razon_social'), ''),
          NULLIF(TRIM(v_d->>'nombre_fantasia'), ''),
          NULLIF(regexp_replace(COALESCE(v_d->>'cuit', ''), '[^0-9]', '', 'g'), ''),
          COALESCE(v_cond_iva, 'responsable_inscripto'),
          NULLIF(TRIM(v_d->>'contacto'), ''),
          NULLIF(TRIM(v_d->>'telefono'), ''),
          NULLIF(TRIM(v_d->>'email'), ''),
          COALESCE(NULLIF(TRIM(v_d->>'dias_pago'), '')::INT, 0),
          NULLIF(TRIM(v_d->>'domicilio'), ''),
          NULLIF(TRIM(v_d->>'localidad'), ''),
          NULLIF(TRIM(v_d->>'notas'), '')
        )
        RETURNING id INTO v_nuevo_id;

        v_creados := v_creados + 1;
        UPDATE migracion_staging_rows
           SET procesado_en = now(), entidad_resultado_id = v_nuevo_id
         WHERE id = v_fila.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('fila_numero', v_fila.fila_numero, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows
         SET procesado_en = now(), error_ejecucion = SQLERRM
       WHERE id = v_fila.id;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'procesadas', v_procesadas,
    'creados', v_creados,
    'actualizados', v_actualizados,
    'errores', v_errores,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;
