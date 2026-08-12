-- 198_fix_integridad_referencial_fase1.sql
-- Aplica los fixes de la Auditoría de integridad referencial - Fase 1
-- (AUDITORIA_FASE1_integridad_referencial.md)
--
-- Verificado en vivo contra jgiquzjwoedmzwqgzubr antes de aplicar:
--   - 0 filas huérfanas en los 6 casos (cta_cte, presupuestos,
--     migracion_plantillas_mapeo x2, canjes_recompensas)
--   - asistente_uso.usuario_id está en producción como TEXT (no UUID como
--     declaraba la migración 195) y la tabla está vacía (0 filas), por lo
--     que se corrige el tipo de columna antes de agregar la FK.
--
-- No se tocan los casos de la sección 1.2 (polimórficos, por diseño) ni
-- 1.3 (IDs externos) del informe: no son bugs.

-- ─────────────────────────────────────────────────────────────
-- 1. cta_cte.empresa_id — CRÍTICO
--    Declarada en 038_fix_consistencia_v39.sql, ausente en producción.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.cta_cte
  ADD CONSTRAINT cta_cte_empresa_id_fkey
  FOREIGN KEY (empresa_id) REFERENCES public.empresas(id);

-- ─────────────────────────────────────────────────────────────
-- 2. presupuestos.pedido_id
--    Declarada en 021_req05_presupuestos.sql, ausente en producción.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.presupuestos
  ADD CONSTRAINT presupuestos_pedido_id_fkey
  FOREIGN KEY (pedido_id) REFERENCES public.pedidos(id);

-- ─────────────────────────────────────────────────────────────
-- 3. asistente_uso.usuario_id
--    Declarada en 195_asistente_ayuda.sql como UUID + FK + ON DELETE CASCADE,
--    pero en producción la columna quedó como TEXT y sin FK.
--    Tabla vacía (0 filas) -> se corrige tipo y se agrega FK sin riesgo.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.asistente_uso
  ALTER COLUMN usuario_id TYPE UUID USING usuario_id::uuid;

ALTER TABLE public.asistente_uso
  ADD CONSTRAINT asistente_uso_usuario_id_fkey
  FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- 4 y 5. migracion_plantillas_mapeo — nunca declaradas (168_migracion_plantillas_mapeo.sql)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.migracion_plantillas_mapeo
  ADD CONSTRAINT migracion_plantillas_mapeo_deposito_id_fkey
  FOREIGN KEY (deposito_id) REFERENCES public.depositos(id);

ALTER TABLE public.migracion_plantillas_mapeo
  ADD CONSTRAINT migracion_plantillas_mapeo_lista_precio_id_fkey
  FOREIGN KEY (lista_precio_id) REFERENCES public.listas_precios(id);

-- ─────────────────────────────────────────────────────────────
-- 6. canjes_recompensas.aplicado_en_pedido_id
--    0 referencias en /api y /lib/handlers (feature sin terminar/sin uso).
--    0 huérfanos verificados en producción -> se agrega la FK igual porque
--    no rompe nada hoy y deja la tabla consistente para cuando se use.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.canjes_recompensas
  ADD CONSTRAINT canjes_recompensas_aplicado_en_pedido_id_fkey
  FOREIGN KEY (aplicado_en_pedido_id) REFERENCES public.pedidos(id);

-- ─────────────────────────────────────────────────────────────
-- Registro
-- ─────────────────────────────────────────────────────────────
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '198_fix_integridad_referencial_fase1.sql', '198', 'claude-session',
        'Fixes de Auditoria Fase 1 de integridad referencial: restaura 3 FKs declaradas en migraciones previas pero ausentes en produccion (cta_cte.empresa_id critico, presupuestos.pedido_id, asistente_uso.usuario_id -- esta ultima ademas requirio corregir el tipo de columna de TEXT a UUID), agrega 2 FKs nunca declaradas en migracion_plantillas_mapeo, y 1 FK en canjes_recompensas.aplicado_en_pedido_id (sin uso en codigo, agregada preventivamente). 0 huerfanos verificados antes de aplicar en los 6 casos.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
