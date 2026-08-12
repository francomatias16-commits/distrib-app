-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 159: pedidos/presupuestos abiertos como nueva entidad del wizard
--
-- Hasta acá el wizard solo migraba "clientes" o "productos" (CHECK en
-- migracion_sesiones.entidad). Si la distribuidora tenía pedidos en curso
-- en el sistema viejo, no había forma de traerlos como pedidos activos —
-- entraban como si fueran nuevos desde cero, o no entraban.
--
-- Se agrega "pedidos" como entidad válida. A diferencia de clientes/productos
-- (1 fila de archivo = 1 entidad), acá 1 fila = 1 línea de pedido (producto +
-- cantidad), agrupadas por "numero_pedido" en un pedido con sus items.
--
-- Reglas de diseño:
--  - Cliente y producto deben EXISTIR ya en el sistema (se resuelven por
--    CUIT/código en el paso de mapeo, no se autocrean — a diferencia de
--    categoría/proveedor/depósito/lista, un pedido sin cliente/producto real
--    no tiene sentido). Si no matchean, la fila queda inválida con el motivo.
--  - El campo "cliente_id_resuelto" / "producto_id_resuelto" se guarda en
--    datos_mapeados durante el mapeo (server-side), no se vuelve a resolver
--    por nombre en la confirmación.
--  - Los pedidos importados quedan en estado "confirmado" salvo que el
--    archivo traiga un estado mapeable a un valor válido del enum.
--  - OJO: esta migración NO reserva stock automáticamente (no llama a la
--    lógica de reserva que usa el flujo normal de creación de pedidos). Si
--    el negocio necesita que el stock quede reservado para estos pedidos
--    migrados, hace falta una reconciliación manual aparte.
--
-- FIX 30/06 (prueba de volumen, aplicado en caliente en producción, sin
-- archivo de migración propio hasta ahora): v_estado se armaba como TEXT y
-- se insertaba directo en pedidos.estado, que es el enum estado_pedido.
-- Postgres no permite esa asignación implícita → confirmar pedidos abiertos
-- fallaba al 100% de las veces, en la primera fila, sin importar el archivo.
-- Esta versión ya incluye el cast (v_estado tipado como estado_pedido) y es
-- la que efectivamente corre en producción hoy. Re-correr este archivo es
-- seguro (CREATE OR REPLACE), solo deja el repo sincronizado con la base.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE migracion_sesiones DROP CONSTRAINT migracion_sesiones_entidad_check;
ALTER TABLE migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY['clientes'::text, 'productos'::text, 'pedidos'::text]));

CREATE OR REPLACE FUNCTION public.migracion_normalizar_estado_pedido(p_texto TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(regexp_replace(COALESCE(p_texto, ''), '[\s_-]+', '', 'g'))
    WHEN 'borrador' THEN 'borrador'
    WHEN 'confirmado' THEN 'confirmado'
    WHEN 'preparando' THEN 'preparando'
    WHEN 'despachado' THEN 'despachado'
    WHEN 'entregado' THEN 'entregado'
    WHEN 'pendiente' THEN 'pendiente'
    ELSE 'confirmado'  -- default seguro: pedido abierto válido, no se pierde en un limbo
  END;
$$;

-- Confirma un lote de PEDIDOS (no de filas): agrupa las filas de staging
-- pendientes por numero_pedido + cliente, crea 1 pedido por grupo con sus
-- items, y marca procesado_en en todas las filas de ese grupo a la vez.
-- p_lote_size acá es "pedidos por llamada", no filas — un pedido con 40
-- líneas avanza como una unidad atómica.
CREATE OR REPLACE FUNCTION public.migracion_confirmar_pedidos_lote(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT  DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_grupo       RECORD;
  v_pedido_id   UUID;
  v_creados     INT := 0;
  v_errores     JSONB := '[]'::jsonb;
  v_procesadas  INT := 0;
  v_estado      estado_pedido;
BEGIN
  FOR v_grupo IN
    SELECT datos_mapeados->>'numero_pedido' AS numero_pedido,
           (datos_mapeados->>'cliente_id_resuelto')::UUID AS cliente_id,
           MIN(datos_mapeados->>'estado') AS estado_raw,
           MIN(fila_numero) AS primera_fila
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND es_valida = true
       AND accion <> 'omitir'
       AND procesado_en IS NULL
     GROUP BY 1, 2
     ORDER BY MIN(fila_numero)
     LIMIT p_lote_size
  LOOP
    v_procesadas := v_procesadas + 1;
    v_estado := migracion_normalizar_estado_pedido(v_grupo.estado_raw)::estado_pedido;

    BEGIN
      IF v_grupo.cliente_id IS NULL THEN
        RAISE EXCEPTION 'Cliente no resuelto para el pedido %', v_grupo.numero_pedido;
      END IF;

      INSERT INTO pedidos (empresa_id, cliente_id, estado, canal, numero_pedido, notas_internas, fecha_pedido)
      VALUES (p_empresa_id, v_grupo.cliente_id, v_estado, 'migracion',
              'MIG-' || COALESCE(v_grupo.numero_pedido, v_grupo.primera_fila::text),
              'Importado por wizard de migración', now())
      RETURNING id INTO v_pedido_id;

      INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unitario, subtotal)
      SELECT
        v_pedido_id,
        (msr.datos_mapeados->>'producto_id_resuelto')::UUID,
        (msr.datos_mapeados->>'cantidad')::NUMERIC,
        COALESCE(NULLIF(TRIM(msr.datos_mapeados->>'precio_unitario'), '')::NUMERIC, 0),
        (msr.datos_mapeados->>'cantidad')::NUMERIC * COALESCE(NULLIF(TRIM(msr.datos_mapeados->>'precio_unitario'), '')::NUMERIC, 0)
      FROM migracion_staging_rows msr
      WHERE msr.sesion_id = p_sesion_id
        AND msr.es_valida = true AND msr.accion <> 'omitir' AND msr.procesado_en IS NULL
        AND msr.datos_mapeados->>'numero_pedido' IS NOT DISTINCT FROM v_grupo.numero_pedido
        AND (msr.datos_mapeados->>'cliente_id_resuelto')::UUID = v_grupo.cliente_id;

      UPDATE pedidos SET
        subtotal = (SELECT COALESCE(SUM(subtotal), 0) FROM pedido_items WHERE pedido_id = v_pedido_id),
        total    = (SELECT COALESCE(SUM(subtotal), 0) FROM pedido_items WHERE pedido_id = v_pedido_id)
      WHERE id = v_pedido_id;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_pedido_id
       WHERE sesion_id = p_sesion_id
         AND datos_mapeados->>'numero_pedido' IS NOT DISTINCT FROM v_grupo.numero_pedido
         AND (datos_mapeados->>'cliente_id_resuelto')::UUID = v_grupo.cliente_id
         AND procesado_en IS NULL;

      v_creados := v_creados + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('numero_pedido', v_grupo.numero_pedido, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows
         SET procesado_en = now(), error_ejecucion = SQLERRM
       WHERE sesion_id = p_sesion_id
         AND datos_mapeados->>'numero_pedido' IS NOT DISTINCT FROM v_grupo.numero_pedido
         AND (datos_mapeados->>'cliente_id_resuelto')::UUID IS NOT DISTINCT FROM v_grupo.cliente_id
         AND procesado_en IS NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'procesadas', v_procesadas,
    'pedidos_creados', v_creados,
    'errores', v_errores,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;
