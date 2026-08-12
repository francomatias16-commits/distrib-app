-- ═══════════════════════════════════════════════════════════════════════════
-- 093_schema_migrations_registry.sql
-- Registro único de migraciones aplicadas — resuelve el punto pendiente de
-- Fase 1 del Plan Estratégico de Recuperación: "dos carpetas de migraciones
-- sin coordinar (db/ y supabase/migrations/), sin forma de saber qué corrió
-- en la base real".
--
-- Esta tabla NO reemplaza ni toca `supabase_migrations.schema_migrations`
-- (la interna del CLI de Supabase) — es una tabla propia, en `public`, para
-- registrar manualmente qué archivo de CUALQUIERA de las dos carpetas ya se
-- corrió contra la base real. De acá en más, todo archivo nuevo en db/ o en
-- supabase/migrations/ debe agregar su fila acá al aplicarse (ver INSERT de
-- ejemplo al final).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.schema_migrations_registry (
  id            bigserial   PRIMARY KEY,
  carpeta       text        NOT NULL CHECK (carpeta IN ('db', 'supabase/migrations')),
  archivo       text        NOT NULL,
  numero        text        NOT NULL,   -- prefijo numérico tal cual aparece en el nombre
  aplicada_en   timestamptz NOT NULL DEFAULT now(),
  aplicada_por  text        NOT NULL DEFAULT 'manual',   -- 'manual' | 'runbook' | nombre de quien la corrió
  notas         text,
  UNIQUE (carpeta, archivo)
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_registry_numero
  ON public.schema_migrations_registry (numero);

COMMENT ON TABLE public.schema_migrations_registry IS
  'Registro manual de qué archivo de db/ o supabase/migrations/ ya se corrió
   contra esta base. Ver scripts/check-migraciones-registro.js para detectar
   archivos nuevos que todavía no tienen fila acá.';

-- ───────────────────────────────────────────────────────────────────────────
-- Seed: todo lo que ya está confirmado corriendo en prod a la fecha de hoy.
-- Incluye el universo completo de db/ (001–092) + supabase/migrations/
-- (041,047,050–054,080,085–087), MENOS los 3 objetos que sabíamos faltantes
-- y que recién se corrieron hoy vía runbook (079, 076-parte2, 092-fix4) —
-- esos quedan con aplicada_por='runbook' y fecha de hoy; el resto queda con
-- aplicada_por='historico' porque ya estaban funcionando antes de este plan.
--
-- IMPORTANTE: este seed es una foto de "ya estaba andando", no una garantía
-- línea por línea de cada migración — para eso ya se hizo el cruce real
-- contra backup.sql en la Fase 1 (ver CHANGELOG_v112.md, 24 jun 2026).
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas) VALUES
  ('db', '001_schema.sql', '001', 'historico', NULL),
  ('db', '002_rls.sql', '002', 'historico', NULL),
  ('db', '003_seed.sql', '003', 'historico', NULL),
  ('db', '004_facturacion.sql', '004', 'historico', NULL),
  ('db', '005_notif_log.sql', '005', 'historico', NULL),
  ('db', '006_logistica.sql', '006', 'historico', NULL),
  ('db', '007_finanzas_fix.sql', '007', 'historico', NULL),
  ('db', '008_facturas_fix.sql', '008', 'historico', NULL),
  ('db', '009_etapa6_produccion.sql', '009', 'historico', NULL),
  ('db', '010_etapa7_fidelizacion.sql', '010', 'historico', NULL),
  ('db', '011_fase1_transacciones.sql', '011', 'historico', NULL),
  ('db', '012_fase1_roles_rls.sql', '012', 'historico', NULL),
  ('db', '013_fase1_fixes.sql', '013', 'historico', NULL),
  ('db', '014_rpc_crear_pedido.sql', '014', 'historico', NULL),
  ('db', '015_audit_log.sql', '015', 'historico', NULL),
  ('db', '016_push_triggers.sql', '016', 'historico', NULL),
  ('db', '017_req01_02_03.sql', '017', 'historico', NULL),
  ('db', '018_req10_email_log.sql', '018', 'historico', NULL),
  ('db', '019_req14_notas_internas.sql', '019', 'historico', NULL),
  ('db', '020_dt02_puntos.sql', '020', 'historico', NULL),
  ('db', '021_req05_presupuestos.sql', '021', 'historico', NULL),
  ('db', '022_req06_lotes.sql', '022', 'historico', NULL),
  ('db', '023_logo_storage.sql', '023', 'historico', NULL),
  ('db', '024_fix_trigger_productos_precio.sql', '024', 'historico', NULL),
  ('db', '025_rpc_importar_productos.sql', '025', 'historico', NULL),
  ('db', '027_refresh_tokens.sql', '027', 'historico', NULL),
  ('db', '028_indices_optimizados.sql', '028', 'historico', NULL),
  ('db', '029_rpc_crear_pedido_optimizada.sql', '029', 'historico', NULL),
  ('db', '030_rls_hardening.sql', '030', 'historico', NULL),
  ('db', '031_push_subscriptions.sql', '031', 'historico', NULL),
  ('db', '032_piloto_automatico.sql', '032', 'historico', NULL),
  ('db', '033_cierre_financiero.sql', '033', 'historico', NULL),
  ('db', '034_rutas_dinamicas.sql', '034', 'historico', NULL),
  ('db', '035_stock_autonomo.sql', '035', 'historico', NULL),
  ('db', '036_score_cliente.sql', '036', 'historico', NULL),
  ('db', '037_notif_prefs_auto.sql', '037', 'historico', NULL),
  ('db', '038_fix_consistencia_v39.sql', '038', 'historico', NULL),
  ('db', '039_fix_auth_id_rls.sql', '039', 'historico', NULL),
  ('db', '039_fix_rls_y_categorias.sql', '039', 'historico', NULL),
  ('db', '040_fix_rls_duplicates.sql', '040', 'historico', NULL),
  ('db', '041_fix_categorias_activa.sql', '041', 'historico', NULL),
  ('db', '042_fix_productos_modify_roles.sql', '042', 'historico', NULL),
  ('db', '043_fix_rls_reglas_score.sql', '043', 'historico', NULL),
  ('db', '048_fix_sync_code_v47.sql', '048', 'historico', NULL),
  ('db', '049_fix_missing_tables_rpcs.sql', '049', 'historico', NULL),
  ('db', '050_fix_activo_rls_v53.sql', '050', 'historico', NULL),
  ('db', '051_automatizacion_setup.sql', '051', 'historico', NULL),
  ('db', '052_saneamiento_final_v54.sql', '052', 'historico', NULL),
  ('db', '053_fix_sincronizacion_v54.sql', '053', 'historico', NULL),
  ('db', '054_recepcion_mercaderia.sql', '054', 'historico', NULL),
  ('db', '055_storage_bucket_remitos.sql', '055', 'historico', NULL),
  ('db', '056_cc_proveedores.sql', '056', 'historico', NULL),
  ('db', '058_ajustar_stock.sql', '058', 'historico', NULL),
  ('db', '059_compat_views.sql', '059', 'historico', NULL),
  ('db', '060_fix_vistas_puntos.sql', '060', 'historico', NULL),
  ('db', '061_drop_pedido_rpc_stubs.sql', '061', 'historico', NULL),
  ('db', '062_fix_notas_internas_schema.sql', '062', 'historico', NULL),
  ('db', '063_fix_ordenes_compra_items_fk_huerfana.sql', '063', 'historico', NULL),
  ('db', '064_vidriera_devoluciones_v80.sql', '064', 'historico', NULL),
  ('db', '065_fidelizacion_bonus_score.sql', '065', 'historico', NULL),
  ('db', '066_semaforo_accion_cobranza.sql', '066', 'historico', NULL),
  ('db', '067_priorizacion_cobranza.sql', '067', 'historico', NULL),
  ('db', '068_piloto_whatsapp.sql', '068', 'historico', NULL),
  ('db', '069_rentabilidad_zona_ruta.sql', '069', 'historico', NULL),
  ('db', '070_auditoria_anomalias.sql', '070', 'historico', NULL),
  ('db', '071_punto_pedido_predictivo.sql', '071', 'historico', NULL),
  ('db', '072_pos.sql', '072', 'historico', NULL),
  ('db', '073_fix_score_y_escritura_portal_proveedor.sql', '073', 'historico', NULL),
  ('db', '074_facturas_venta_pos.sql', '074', 'historico', NULL),
  ('db', '075_resumen_cierre_caja.sql', '075', 'historico', NULL),
  ('db', '076_kpis_dashboard.sql', '076', 'historico', NULL),
  ('db', '077_critical_rls_y_politicas.sql', '077', 'historico', NULL),
  ('db', '078_numeracion_atomica_y_saldo_deuda.sql', '078', 'historico', NULL),
  ('db', '079_anomalias_revisadas.sql', '079', 'historico', NULL),
  ('db', '091_fase1_empresa_id_security.sql', '091', 'historico', NULL),
  ('db', '092_fix_bugs_criticos.sql', '092', 'historico', NULL),
  ('db', '093_schema_migrations_registry.sql', '093', 'historico', NULL),
  ('db', 'backup.sql', '????', 'historico', NULL),
  ('db', 'clientes_schema.sql', '????', 'historico', NULL),
  ('db', 'functions.sql', '????', 'historico', NULL),
  ('db', 'public_schema_full.sql', '????', 'historico', NULL),
  ('db', 'public_tables.sql', '????', 'historico', NULL),
  ('db', 'tables.sql', '????', 'historico', NULL),
  ('supabase/migrations', '041_enable_rls_comprehensive.sql', '041', 'historico', NULL),
  ('supabase/migrations', '047_sincronizacion_real_db.sql', '047', 'historico', NULL),
  ('supabase/migrations', '050_fix_activo_rls_v53.sql', '050', 'historico', NULL),
  ('supabase/migrations', '051_check_schema_rpc.sql', '051', 'historico', NULL),
  ('supabase/migrations', '052_activar_rls_faltante.sql', '052', 'historico', NULL),
  ('supabase/migrations', '053_portal_proveedor.sql', '053', 'historico', NULL),
  ('supabase/migrations', '054_push_interno_secret.sql', '054', 'historico', NULL),
  ('supabase/migrations', '080_pos_fase3.sql', '080', 'historico', NULL),
  ('supabase/migrations', '085_facturacion_arca.sql', '085', 'historico', NULL),
  ('supabase/migrations', '086_bucket_comprobantes.sql', '086', 'historico', NULL),
  ('supabase/migrations', '087_factura_origen_id.sql', '087', 'historico', NULL)
ON CONFLICT (carpeta, archivo) DO NOTHING;

-- Marca explícita de los 3 que se aplicaron HOY vía runbook (Fase 1):
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas) VALUES
  ('db', '079_anomalias_revisadas.sql',      '079', 'runbook', 'Aplicado 24 jun 2026 — runbook migraciones pendientes Fase 1'),
  ('db', '076_kpis_dashboard.sql',           '076', 'runbook', 'Solo Parte 2 (v2) — la v1 ya estaba aplicada antes'),
  ('db', '092_fix_bugs_criticos.sql',        '092', 'runbook', 'FIX 1 (calcular_score_cliente) + FIX 4 (generar_pedido_sugerido_cliente)')
ON CONFLICT (carpeta, archivo) DO UPDATE SET
  aplicada_por = EXCLUDED.aplicada_por,
  notas        = EXCLUDED.notas;

-- Verificación:
SELECT carpeta, count(*) AS migraciones_registradas
FROM public.schema_migrations_registry
GROUP BY carpeta;
