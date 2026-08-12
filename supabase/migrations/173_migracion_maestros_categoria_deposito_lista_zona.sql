-- 173_migracion_maestros_categoria_deposito_lista_zona.sql
-- Punto 7 del plan de migraciones (P1) / Gap crítico 3: categorías, depósitos,
-- listas de precios y zonas pasan a ser entidades propias del wizard de
-- migración, con sus atributos reales, en vez de autocrearse solo con
-- nombre como efecto colateral de migrar clientes/productos.
--
-- depositos no tenía columnas para dirección/responsable — se agregan acá
-- porque son atributos reales que un sistema origen puede traer y que hoy
-- se perdían al autocrear el depósito solo por nombre.

ALTER TABLE depositos ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE depositos ADD COLUMN IF NOT EXISTS responsable TEXT;

ALTER TABLE migracion_sesiones DROP CONSTRAINT IF EXISTS migracion_sesiones_entidad_check;
ALTER TABLE migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY[
    'clientes','productos','pedidos','cta_cte','precios_clientes',
    'proveedores','ordenes_compra','pagos_proveedores','lotes',
    'categorias','depositos','listas_precios','zonas'
  ]::text[]));

-- Convierte texto libre ("lunes, Miércoles y viernes") en el TEXT[] con los
-- 7 valores canónicos que ya usa zonas.dias_reparto (ver seed 003:
-- lunes/martes/miercoles/jueves/viernes/sabado/domingo, sin tilde,
-- minúscula). Tolerante a acentos, mayúsculas y separadores mixtos.
CREATE OR REPLACE FUNCTION public.migracion_parsear_dias_reparto(p_texto TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_tok  TEXT;
  v_norm TEXT;
  v_out  TEXT[] := '{}';
BEGIN
  IF p_texto IS NULL OR TRIM(p_texto) = '' THEN RETURN NULL; END IF;
  FOREACH v_tok IN ARRAY regexp_split_to_array(p_texto, '[,;/]+|\s+y\s+') LOOP
    v_norm := lower(trim(v_tok));
    v_norm := translate(v_norm, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU');
    IF v_norm = ANY (ARRAY['lunes','martes','miercoles','jueves','viernes','sabado','domingo']) THEN
      IF NOT (v_norm = ANY(v_out)) THEN
        v_out := array_append(v_out, v_norm);
      END IF;
    END IF;
  END LOOP;
  IF array_length(v_out, 1) IS NULL THEN RETURN NULL; END IF;
  RETURN v_out;
END;
$function$;

-- RPC única para las 4 entidades "maestro" (mismo patrón de lote resumible
-- que migracion_confirmar_proveedores_lote), parametrizada por p_entidad
-- para evitar 4 funciones casi idénticas. es_principal (depósitos) y
-- es_default (listas) solo se honran si la fila lo pide Y la empresa
-- todavía no tiene uno marcado — nunca se pisa un principal/default ya
-- elegido por el usuario como efecto colateral de una migración.
CREATE OR REPLACE FUNCTION public.migracion_confirmar_maestro_lote(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_entidad    TEXT,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT DEFAULT 500
)
RETURNS JSONB
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
  v_ya_hay_uno   BOOLEAN;
  v_dias         TEXT[];
  v_pide_flag    BOOLEAN;
BEGIN
  IF p_entidad NOT IN ('categorias','depositos','listas_precios','zonas') THEN
    RAISE EXCEPTION 'Entidad no soportada por migracion_confirmar_maestro_lote: %', p_entidad;
  END IF;

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
      IF p_entidad = 'categorias' THEN
        IF v_fila.accion = 'actualizar' AND v_fila.entidad_existente_id IS NOT NULL THEN
          UPDATE categorias SET
            nombre      = COALESCE(NULLIF(TRIM(v_d->>'nombre'), ''), nombre),
            descripcion = COALESCE(NULLIF(TRIM(v_d->>'descripcion'), ''), descripcion),
            orden       = COALESCE(NULLIF(v_d->>'orden', '')::INT, orden)
          WHERE id = v_fila.entidad_existente_id AND empresa_id = p_empresa_id;
          v_actualizados := v_actualizados + 1;
          v_nuevo_id := v_fila.entidad_existente_id;
        ELSE
          INSERT INTO categorias (empresa_id, nombre, descripcion, orden, activa)
          VALUES (
            p_empresa_id, NULLIF(TRIM(v_d->>'nombre'), ''), NULLIF(TRIM(v_d->>'descripcion'), ''),
            COALESCE(NULLIF(v_d->>'orden', '')::INT, 0), true
          )
          RETURNING id INTO v_nuevo_id;
          v_creados := v_creados + 1;
        END IF;

      ELSIF p_entidad = 'depositos' THEN
        v_pide_flag := lower(COALESCE(v_d->>'es_principal','')) IN ('true','1','si','sí','x');

        IF v_fila.accion = 'actualizar' AND v_fila.entidad_existente_id IS NOT NULL THEN
          UPDATE depositos SET
            nombre      = COALESCE(NULLIF(TRIM(v_d->>'nombre'), ''), nombre),
            direccion   = COALESCE(NULLIF(TRIM(v_d->>'direccion'), ''), direccion),
            responsable = COALESCE(NULLIF(TRIM(v_d->>'responsable'), ''), responsable)
          WHERE id = v_fila.entidad_existente_id AND empresa_id = p_empresa_id;
          v_actualizados := v_actualizados + 1;
          v_nuevo_id := v_fila.entidad_existente_id;

          IF v_pide_flag THEN
            SELECT EXISTS(SELECT 1 FROM depositos WHERE empresa_id = p_empresa_id AND es_principal = true AND id <> v_nuevo_id) INTO v_ya_hay_uno;
            IF NOT v_ya_hay_uno THEN
              UPDATE depositos SET es_principal = true WHERE id = v_nuevo_id;
            END IF;
          END IF;
        ELSE
          SELECT EXISTS(SELECT 1 FROM depositos WHERE empresa_id = p_empresa_id AND es_principal = true) INTO v_ya_hay_uno;
          INSERT INTO depositos (empresa_id, nombre, direccion, responsable, es_principal)
          VALUES (
            p_empresa_id, NULLIF(TRIM(v_d->>'nombre'), ''), NULLIF(TRIM(v_d->>'direccion'), ''), NULLIF(TRIM(v_d->>'responsable'), ''),
            (v_pide_flag AND NOT v_ya_hay_uno)
          )
          RETURNING id INTO v_nuevo_id;
          v_creados := v_creados + 1;
        END IF;

      ELSIF p_entidad = 'listas_precios' THEN
        v_pide_flag := lower(COALESCE(v_d->>'es_default','')) IN ('true','1','si','sí','x');

        IF v_fila.accion = 'actualizar' AND v_fila.entidad_existente_id IS NOT NULL THEN
          UPDATE listas_precios SET
            nombre = COALESCE(NULLIF(TRIM(v_d->>'nombre'), ''), nombre)
          WHERE id = v_fila.entidad_existente_id AND empresa_id = p_empresa_id;
          v_actualizados := v_actualizados + 1;
          v_nuevo_id := v_fila.entidad_existente_id;

          IF v_pide_flag THEN
            SELECT EXISTS(SELECT 1 FROM listas_precios WHERE empresa_id = p_empresa_id AND es_default = true AND id <> v_nuevo_id) INTO v_ya_hay_uno;
            IF NOT v_ya_hay_uno THEN
              UPDATE listas_precios SET es_default = true WHERE id = v_nuevo_id;
            END IF;
          END IF;
        ELSE
          SELECT EXISTS(SELECT 1 FROM listas_precios WHERE empresa_id = p_empresa_id AND es_default = true) INTO v_ya_hay_uno;
          INSERT INTO listas_precios (empresa_id, nombre, es_default, activa)
          VALUES (
            p_empresa_id, NULLIF(TRIM(v_d->>'nombre'), ''),
            (v_pide_flag AND NOT v_ya_hay_uno), true
          )
          RETURNING id INTO v_nuevo_id;
          v_creados := v_creados + 1;
        END IF;

      ELSIF p_entidad = 'zonas' THEN
        v_dias := migracion_parsear_dias_reparto(v_d->>'dias_reparto');

        IF v_fila.accion = 'actualizar' AND v_fila.entidad_existente_id IS NOT NULL THEN
          UPDATE zonas SET
            nombre       = COALESCE(NULLIF(TRIM(v_d->>'nombre'), ''), nombre),
            dias_reparto = COALESCE(v_dias, dias_reparto)
          WHERE id = v_fila.entidad_existente_id AND empresa_id = p_empresa_id;
          v_actualizados := v_actualizados + 1;
          v_nuevo_id := v_fila.entidad_existente_id;
        ELSE
          INSERT INTO zonas (empresa_id, nombre, dias_reparto, activa)
          VALUES (p_empresa_id, NULLIF(TRIM(v_d->>'nombre'), ''), v_dias, true)
          RETURNING id INTO v_nuevo_id;
          v_creados := v_creados + 1;
        END IF;
      END IF;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_nuevo_id
       WHERE id = v_fila.id;

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
