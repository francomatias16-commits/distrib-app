-- 442_fix_actualizar_estado_lotes_enum_y_wiring.sql
--
-- [reconstruido retroactivamente desde el estado real de producción — el
--  archivo original vivía en db/, carpeta ausente en los exports/zips del
--  repo. Definición verificada contra pg_get_functiondef() de la base viva.]
--
-- F3-03 (auditoría de páginas, Fase 3): actualizar_estado_lotes()
-- reescrita para usar solo activo/agotado/vencido (el CHECK actual ya no
-- admite vigente/por_vencer). Nunca se llamaba desde el código; se cablea
-- en listarLotes() y listarLotesPorVencer() (lib/handlers/lotes.js) para
-- que la columna estado se autocorrija en cada lectura. El wiring del
-- lado JS no forma parte de esta migración SQL — ver esos handlers en el
-- repo.

BEGIN;

CREATE OR REPLACE FUNCTION public.actualizar_estado_lotes(p_empresa_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  -- Marcar vencidos: ya pasó la fecha, todavía tenía cantidad, y seguía
  -- marcado como activo.
  UPDATE lotes
  SET    estado = 'vencido', updated_at = now()
  WHERE  empresa_id = p_empresa_id
    AND  estado     = 'activo'
    AND  fecha_vencimiento < CURRENT_DATE
    AND  cantidad > 0;

  -- Marcar agotados: cantidad en 0 pero no estaba marcado como agotado
  -- (cubre lotes activos o vencidos que se vendieron/dieron de baja del
  -- todo).
  UPDATE lotes
  SET    estado = 'agotado', updated_at = now()
  WHERE  empresa_id = p_empresa_id
    AND  estado <> 'agotado'
    AND  cantidad = 0;
$function$;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '442_fix_actualizar_estado_lotes_enum_y_wiring.sql', '442', 'claude-session',
  'F3-03 (auditoria de paginas, Fase 3): actualizar_estado_lotes() reescrita para usar solo '
  'activo/agotado/vencido (el CHECK actual ya no admite vigente/por_vencer). Nunca se llamaba '
  'desde el codigo; se cablea en listarLotes() y listarLotesPorVencer() para que la columna '
  'estado se autocorrija en cada lectura.')
ON CONFLICT DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
