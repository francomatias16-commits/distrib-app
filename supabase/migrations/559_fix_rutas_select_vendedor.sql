-- Fix: el selector "Sobre una ruta" de prospección de competencia
-- (prospectos-competencia.js, pcCargarRutasDeHoy) consulta 'rutas'
-- directo contra Supabase (RLS), pero la policy de SELECT vigente solo
-- contemplaba dueno/admin/depositero (todas) o chofer (la propia por
-- chofer_id). El rol 'vendedor' -- explícitamente habilitado para leer
-- prospectos_competencia en permisos-service.js -- no entraba en
-- ninguna rama: la query no daba error, devolvía 0 filas, y la pantalla
-- mostraba "No hay rutas armadas para hoy todavía." aunque sí hubiera
-- (verificado en producción con una ruta real del día, estado
-- 'completada', que Lucía Fernández -rol vendedor- no podía ver).
-- Se agrega 'vendedor' a la rama de "ve todas las de su empresa" (solo
-- SELECT -- las policies de insert/update/delete no se tocan, el
-- vendedor sigue sin poder crear/modificar rutas).
DROP POLICY IF EXISTS "rutas_select_unificada" ON public.rutas;
CREATE POLICY "rutas_select_unificada" ON public.rutas FOR SELECT USING (
  ((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario, 'vendedor'::rol_usuario])))
  OR ((get_rol_usuario() = 'chofer'::rol_usuario) AND (chofer_id = ( SELECT auth.uid() AS uid)))
);

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '559_fix_rutas_select_vendedor.sql', '559', 'claude-session',
  'Fix "no hay rutas armadas para hoy" falso en prospección de competencia: la policy SELECT de rutas no contemplaba el rol vendedor (solo dueno/admin/depositero/chofer-propia), pese a que permisos-service.js ya lo habilita para prospectos_competencia. Se agrega vendedor a la rama de lectura de toda la empresa.')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
