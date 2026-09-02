-- ═══════════════════════════════════════════════════════════════════════════
-- 20260824030003_registrar_rls_renombradas_hallazgo3.sql
--
-- Etapa 8 / hallazgo 🟠 #3 (AUDITORIA_BUGS_v954.md): las 2 migraciones RLS
-- `fase5_eventos_negocio_rls_dueno_admin.sql` y
-- `fix_rls_notif_log_scope_por_rol.sql` eran las únicas 2 de 403 archivos de
-- supabase/migrations/ sin prefijo numérico/timestamp. Supabase aplica
-- migraciones en orden ALFABÉTICO de nombre de archivo, así que estas 2
-- SIEMPRE se iban a aplicar después de cualquier migración futura con el
-- prefijo estándar — riesgo real de que un cambio nuevo sobre las mismas
-- policies (eventos_negocio / notif_log) quedara aplicado ANTES que este fix
-- de seguridad, reabriendo la fuga sin que se note.
--
-- Fix (v967): ambos archivos renombrados con prefijo timestamp real:
--   fase5_eventos_negocio_rls_dueno_admin.sql
--     → 20260824030001_fase5_eventos_negocio_rls_dueno_admin.sql
--   fix_rls_notif_log_scope_por_rol.sql
--     → 20260824030002_fix_rls_notif_log_scope_por_rol.sql
--
-- Estas 2 migraciones ya estaban aplicadas en producción bajo su nombre
-- viejo (confirmado: nunca tuvieron fila en schema_migrations_registry,
-- precisamente porque el script de reconciliación
-- (scripts/check-migraciones-registro.js) matchea por prefijo numérico y,
-- al no tener uno, quedaban fuera de su barrido). Por eso NO se tocó el
-- seed histórico de 093_schema_migrations_registry.sql — se agrega acá,
-- en una migración nueva y separada, la fila que documenta que ambas ya
-- corrieron contra la base real, bajo su nombre nuevo (que es el que
-- importa de acá en más para el orden de aplicación futuro).
--
-- ADENDA (misma sesión, al correr el test de regresión de este hallazgo
-- contra la suite real): el test detectó 2 archivos MÁS con el mismo
-- problema, no relacionados con RLS — `540_reconstruccion_retroactiva_
-- calcular_deuda_cliente_cons_01_02_03.sql` y `541_fix_calcular_score_
-- cliente_componente_deuda_cons_04.sql` (Etapa 6, sesión 2026-08-24,
-- fix de `calcular_score_cliente`/componente Deuda). Igual que las 2 RLS
-- originales, tampoco tenían fila en el registro. A diferencia de esas 2,
-- no son fixes de seguridad — pero el riesgo de orden de aplicación es
-- idéntico: al usar un prefijo secuencial corto ("540"/"541") en vez de
-- timestamp, ASCII compara char a char y '5' > '2', así que estos 2
-- archivos ordenaban DESPUÉS de cualquier migración con prefijo
-- timestamp 2026... (todas las de la serie 513+), invirtiendo el orden
-- real en que se aplicaron. Mismo fix: renombrados con timestamp
-- (20260824030004 / 20260824030005) y registrados acá.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas) VALUES
  ('supabase/migrations', '20260824030001_fase5_eventos_negocio_rls_dueno_admin.sql', '20260824030001', 'runbook',
   'Renombrada en v967 (hallazgo #3, AUDITORIA_BUGS_v954.md) — nunca tuvo prefijo de orden. Ya estaba aplicada en producción bajo el nombre viejo "fase5_eventos_negocio_rls_dueno_admin.sql"; el rename no vuelve a ejecutar el contenido, solo corrige el orden de aplicación futuro.'),
  ('supabase/migrations', '20260824030002_fix_rls_notif_log_scope_por_rol.sql', '20260824030002', 'runbook',
   'Renombrada en v967 (hallazgo #3, AUDITORIA_BUGS_v954.md) — nunca tuvo prefijo de orden. Ya estaba aplicada en producción bajo el nombre viejo "fix_rls_notif_log_scope_por_rol.sql"; el rename no vuelve a ejecutar el contenido, solo corrige el orden de aplicación futuro.'),
  ('supabase/migrations', '20260824030004_540_reconstruccion_retroactiva_calcular_deuda_cliente_cons_01_02_03.sql', '20260824030004', 'runbook',
   'Renombrada en v967 al descubrirse el mismo problema de orden que el hallazgo #3 (mismo prefijo secuencial corto sin timestamp). Ya estaba aplicada en producción bajo el nombre viejo "540_reconstruccion_retroactiva_calcular_deuda_cliente_cons_01_02_03.sql".'),
  ('supabase/migrations', '20260824030005_541_fix_calcular_score_cliente_componente_deuda_cons_04.sql', '20260824030005', 'runbook',
   'Renombrada en v967 al descubrirse el mismo problema de orden que el hallazgo #3 (mismo prefijo secuencial corto sin timestamp). Ya estaba aplicada en producción bajo el nombre viejo "541_fix_calcular_score_cliente_componente_deuda_cons_04.sql".')
ON CONFLICT (carpeta, archivo) DO NOTHING;
