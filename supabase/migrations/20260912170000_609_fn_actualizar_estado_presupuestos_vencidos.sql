-- 20260912170000_609_fn_actualizar_estado_presupuestos_vencidos.sql
--
-- Etapa 1 del plan de auditoría de dinero (2026-09): punto abierto "si
-- existe o no un job que marque presupuestos.estado='vencido'
-- automáticamente". Verificado: no existe. No hay ningún cron.schedule
-- que lo haga (revisados todos los jobs programados del proyecto) y
-- listarPresupuestos() (lib/repos/pedidos.js) lee la columna `estado` tal
-- cual está guardada, sin recalcularla contra `fecha_vencimiento` — a
-- diferencia de `lotes.estado`, que sí tiene este mismo problema ya
-- resuelto (ver 442_fix_actualizar_estado_lotes_enum_y_wiring.sql, F3-03).
--
-- Mismo criterio que esa función: en vez de depender de un cron con la
-- demora que eso implica (un presupuesto vencido a las 00:01 recién se
-- vería como tal si el cron corrió), se autocorrige en cada lectura. Se
-- cablea en listarPresupuestos() y obtenerPresupuestoConDetalle()
-- (lib/repos/pedidos.js) — el wiring JS no forma parte de esta migración
-- SQL.
--
-- Alcance: solo pasa de 'enviado' a 'vencido'. 'borrador' no tiene sentido
-- vencerlo (nunca se envió) y 'aceptado'/'rechazado'/'vencido' ya son
-- estados terminales que no se pisan.

BEGIN;

CREATE OR REPLACE FUNCTION public.actualizar_estado_presupuestos_vencidos(p_empresa_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  UPDATE presupuestos
  SET    estado = 'vencido', updated_at = now()
  WHERE  empresa_id = p_empresa_id
    AND  estado     = 'enviado'
    AND  fecha_vencimiento IS NOT NULL
    AND  fecha_vencimiento < CURRENT_DATE;
$function$;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '20260912170000_609_fn_actualizar_estado_presupuestos_vencidos.sql', '609', 'claude-session',
  'Etapa 1 auditoria de dinero: no existia ningun mecanismo (cron ni '
  'autocorreccion en lectura) que marcara presupuestos.estado=vencido. Se '
  'crea actualizar_estado_presupuestos_vencidos(), mismo patron que '
  'actualizar_estado_lotes() (442) - se cablea en listarPresupuestos() y '
  'obtenerPresupuestoConDetalle().')
ON CONFLICT DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
