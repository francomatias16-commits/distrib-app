-- 149_fix_migracion_confirmar_sesion_idor.sql
-- Fix de seguridad sobre la RPC creada en 148_sistema_migracion_clientes.sql.
--
-- Encontrado al integrar el módulo en el repo v165 (auditoría de grants):
--   1. anon tenía EXECUTE sobre la función (heredado del GRANT genérico al
--      crearla), pudiendo invocarla sin estar autenticado.
--   2. La función comparaba `v_empresa_id <> public.get_empresa_id()`. Si
--      get_empresa_id() devuelve NULL (caller sin auth.uid(), p.ej. anon o
--      un JWT inválido), la comparación da NULL, y un `IF NULL` en plpgsql
--      se evalúa como false -> el chequeo de autorización se salteaba por
--      completo, permitiendo confirmar la migración de CUALQUIER empresa
--      conociendo (o adivinando) un sesion_id ajeno.
--
-- Fix: se revoca EXECUTE a anon/PUBLIC, se exige get_empresa_id() no nulo
-- al entrar, y se reemplaza la comparación por IS DISTINCT FROM (NULL-safe).

REVOKE EXECUTE ON FUNCTION public.migracion_confirmar_sesion(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.migracion_confirmar_sesion(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.migracion_confirmar_sesion(p_sesion_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_empresa_id uuid;
    v_caller_empresa_id uuid;
    v_entidad text;
    v_deposito_id uuid;
    v_lista_id uuid;
    v_row record;
    v_creados integer := 0;
    v_actualizados integer := 0;
    v_nuevo_id uuid;
BEGIN
    v_caller_empresa_id := public.get_empresa_id();

    IF v_caller_empresa_id IS NULL THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;

    SELECT empresa_id, entidad INTO v_empresa_id, v_entidad
    FROM public.migracion_sesiones WHERE id = p_sesion_id;

    IF v_empresa_id IS NULL THEN
        RAISE EXCEPTION 'Sesión de migración no encontrada';
    END IF;

    IF v_empresa_id IS DISTINCT FROM v_caller_empresa_id THEN
        RAISE EXCEPTION 'No autorizado para esta empresa';
    END IF;

    UPDATE public.migracion_sesiones SET estado = 'confirmando' WHERE id = p_sesion_id;

    IF v_entidad = 'clientes' THEN
        FOR v_row IN
            SELECT * FROM public.migracion_staging_rows
            WHERE sesion_id = p_sesion_id AND es_valida = true AND accion <> 'omitir'
        LOOP
            IF v_row.accion = 'actualizar' AND v_row.entidad_existente_id IS NOT NULL THEN
                UPDATE public.clientes SET
                    razon_social = COALESCE(v_row.datos_mapeados->>'razon_social', razon_social),
                    cuit = COALESCE(v_row.datos_mapeados->>'cuit', cuit),
                    telefono = COALESCE(v_row.datos_mapeados->>'telefono', telefono),
                    email = COALESCE(v_row.datos_mapeados->>'email', email),
                    domicilio = COALESCE(v_row.datos_mapeados->>'domicilio', domicilio),
                    localidad = COALESCE(v_row.datos_mapeados->>'localidad', localidad),
                    limite_credito = COALESCE((v_row.datos_mapeados->>'limite_credito')::numeric, limite_credito),
                    saldo_cuenta_corriente = COALESCE((v_row.datos_mapeados->>'saldo_inicial')::numeric, saldo_cuenta_corriente)
                WHERE id = v_row.entidad_existente_id AND empresa_id = v_empresa_id;
                v_actualizados := v_actualizados + 1;
            ELSE
                INSERT INTO public.clientes (empresa_id, razon_social, cuit, telefono, email, domicilio, localidad, limite_credito, saldo_cuenta_corriente)
                VALUES (
                    v_empresa_id,
                    v_row.datos_mapeados->>'razon_social',
                    v_row.datos_mapeados->>'cuit',
                    v_row.datos_mapeados->>'telefono',
                    v_row.datos_mapeados->>'email',
                    v_row.datos_mapeados->>'domicilio',
                    v_row.datos_mapeados->>'localidad',
                    COALESCE((v_row.datos_mapeados->>'limite_credito')::numeric, 0),
                    COALESCE((v_row.datos_mapeados->>'saldo_inicial')::numeric, 0)
                );
                v_creados := v_creados + 1;
            END IF;
        END LOOP;

    ELSIF v_entidad = 'productos' THEN
        SELECT id INTO v_deposito_id FROM public.depositos WHERE empresa_id = v_empresa_id AND es_principal = true LIMIT 1;
        SELECT id INTO v_lista_id FROM public.listas_precios WHERE empresa_id = v_empresa_id AND es_default = true LIMIT 1;

        FOR v_row IN
            SELECT * FROM public.migracion_staging_rows
            WHERE sesion_id = p_sesion_id AND es_valida = true AND accion <> 'omitir'
        LOOP
            IF v_row.accion = 'actualizar' AND v_row.entidad_existente_id IS NOT NULL THEN
                UPDATE public.productos SET
                    nombre = COALESCE(v_row.datos_mapeados->>'nombre', nombre),
                    codigo = COALESCE(v_row.datos_mapeados->>'codigo', codigo),
                    precio_base = COALESCE((v_row.datos_mapeados->>'precio')::numeric, precio_base)
                WHERE id = v_row.entidad_existente_id AND empresa_id = v_empresa_id;

                IF v_deposito_id IS NOT NULL AND v_row.datos_mapeados->>'stock' IS NOT NULL THEN
                    UPDATE public.stock SET cantidad = (v_row.datos_mapeados->>'stock')::numeric
                    WHERE producto_id = v_row.entidad_existente_id AND deposito_id = v_deposito_id;
                END IF;
                v_actualizados := v_actualizados + 1;
            ELSE
                INSERT INTO public.productos (empresa_id, nombre, codigo, precio_base)
                VALUES (
                    v_empresa_id,
                    v_row.datos_mapeados->>'nombre',
                    v_row.datos_mapeados->>'codigo',
                    COALESCE((v_row.datos_mapeados->>'precio')::numeric, 0)
                )
                RETURNING id INTO v_nuevo_id;

                IF v_lista_id IS NOT NULL AND v_row.datos_mapeados->>'precio' IS NOT NULL THEN
                    INSERT INTO public.precios_items (lista_id, producto_id, precio)
                    VALUES (v_lista_id, v_nuevo_id, (v_row.datos_mapeados->>'precio')::numeric);
                END IF;
                IF v_deposito_id IS NOT NULL AND v_row.datos_mapeados->>'stock' IS NOT NULL THEN
                    INSERT INTO public.stock (producto_id, deposito_id, cantidad)
                    VALUES (v_nuevo_id, v_deposito_id, (v_row.datos_mapeados->>'stock')::numeric);
                END IF;
                v_creados := v_creados + 1;
            END IF;
        END LOOP;
    END IF;

    UPDATE public.migracion_sesiones
    SET estado = 'completado', actualizado_at = now()
    WHERE id = p_sesion_id;

    INSERT INTO public.audit_log (empresa_id, tabla, registro_id, accion, datos_despues)
    VALUES (v_empresa_id, v_entidad, p_sesion_id, 'INSERT',
            jsonb_build_object('sesion_id', p_sesion_id, 'entidad', v_entidad, 'creados', v_creados, 'actualizados', v_actualizados));

    RETURN jsonb_build_object('ok', true, 'creados', v_creados, 'actualizados', v_actualizados);

EXCEPTION WHEN OTHERS THEN
    UPDATE public.migracion_sesiones SET estado = 'error', resumen_errores = jsonb_build_array(SQLERRM) WHERE id = p_sesion_id;
    RAISE;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.migracion_confirmar_sesion(uuid) TO authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '149_fix_migracion_confirmar_sesion_idor.sql', '149', 'claude-session', 'Fix IDOR: anon execute + NULL comparison bypass en check de empresa_id')
ON CONFLICT (carpeta, archivo) DO NOTHING;
