-- =============================================================
-- 435_fase8_indices_observabilidad_eventos.sql
-- PLAN_ERP_SINCRONIZACION_2026.md — Fase 8: observabilidad continua.
--
-- Fase 8 no agrega tablas nuevas: lee eventos_negocio (Fase 1) con dos
-- patrones de consulta que los índices existentes (migración 431) no
-- cubren bien:
--   1. "resumen de salud" — todo lo de una empresa en una ventana de
--      tiempo, sin filtrar por tipo_evento (idx_eventos_negocio_empresa_tipo
--      tiene tipo_evento como segunda columna, así que una consulta sin
--      ese filtro no lo aprovecha igual de bien).
--   2. "eventos en error hace más de N minutos" — filtrado por empresa,
--      que idx_eventos_negocio_pendientes no cubre (es global y solo
--      para estado='pendiente', pensado para el barrido del cron, no
--      para el panel por-tenant).
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_eventos_negocio_empresa_creado
  ON public.eventos_negocio(empresa_id, creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_eventos_negocio_empresa_error
  ON public.eventos_negocio(empresa_id, procesado_en)
  WHERE estado = 'error';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '435_fase8_indices_observabilidad_eventos.sql', '435', 'claude-session',
        'Fase 8 de PLAN_ERP_SINCRONIZACION_2026.md (observabilidad continua): dos índices de soporte para las consultas nuevas de lib/repos/observabilidad.js — resumen de salud por empresa/ventana de tiempo y listado de eventos en error prolongado por empresa. No se toca el esquema de eventos_negocio, solo se agregan índices.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
