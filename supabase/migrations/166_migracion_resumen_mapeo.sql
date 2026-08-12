-- Migración 166 (housekeeping — ver v182): resumen agregado post-mapeo
-- (conteo por acción crear/actualizar y top errores más frecuentes), para
-- mostrar un resumen ejecutivo ANTES de confirmar en vez de que el usuario
-- tenga que revisar fila por fila un archivo de decenas de miles de filas.
--
-- Esta columna ya está viva en producción (jgiquzjwoedmzwqgzubr) desde una
-- sesión anterior; este archivo sincroniza el repo con lo que ya corre,
-- mismo criterio que el housekeeping de las migraciones 160-165 (v182).
ALTER TABLE public.migracion_sesiones
  ADD COLUMN IF NOT EXISTS resumen_mapeo JSONB;

COMMENT ON COLUMN public.migracion_sesiones.resumen_mapeo IS
  'Resumen agregado calculado en el paso de mapeo: {por_accion:{crear,actualizar}, total_validas, total_error, top_errores:[{mensaje,cantidad}]}. Se recalcula en cada re-mapeo.';
