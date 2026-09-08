-- =============================================================
-- 603_asistente_frente4_vistas_revision.sql
--
-- Dos vistas de solo lectura para la revisión de datos reales que pide
-- PLAN_OPTIMIZACION_ASISTENTE_2026.md, mismo criterio que la vista
-- asistente_candidatos_sinonimo de la migración 601 (no es un
-- dashboard, es la query mínima para no tener que armar el reporte a
-- mano cada vez).
--
--   1) asistente_metodo_seleccion_resumen — Frente 2: una vez aplicada
--      la migración 602 y cargados los embeddings de tools
--      (`npm run cargar-embeddings-tools`), esta vista muestra semana a
--      semana cuánto se resolvió por selección semántica vs. keywords
--      vs. núcleo de fallback (columna metodo_seleccion_tools). Sirve
--      para confirmar que la capa semántica efectivamente reduce los
--      casos de nucleo_fallback en producción, no solo en los tests.
--
--   2) asistente_fase_a_uso_semanal — Frente 4, tarea "Datos de uso
--      real de la Fase A (tool por voz vs. a mano) antes de encarar la
--      Fase B": cuenta, semana a semana, cuántas veces se ejecutó
--      efectivamente cada una de las tools de escritura de la Fase A de
--      PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md
--      (registrar_cobro_cliente, crear_producto, editar_producto,
--      anular_factura, emitir_factura) vía el asistente. Comparar esos
--      números contra el uso manual de las mismas acciones desde el
--      panel (fuera de esta vista — no hay un log unificado de "acción
--      manual" para cruzar automáticamente todavía) es lo que decide si
--      conviene encarar la Fase B.
-- =============================================================

-- ============================================================
-- VISTA: asistente_metodo_seleccion_resumen
-- ============================================================
CREATE OR REPLACE VIEW public.asistente_metodo_seleccion_resumen AS
SELECT
  date_trunc('week', u.creado_en)  AS semana,
  u.metodo_seleccion_tools,
  COUNT(*)                          AS cantidad
FROM public.asistente_uso u
WHERE u.metodo_seleccion_tools IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

COMMENT ON VIEW public.asistente_metodo_seleccion_resumen IS
  'Frente 2 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: cantidad de requests por semana según metodo_seleccion_tools (semantica|keywords|nucleo_fallback). Útil recién después de aplicar la migración 602 y correr scripts/generar-embeddings-tools.js — antes de eso, metodo_seleccion_tools nunca vale ''semantica'' porque buscar_tools_asistente_rpc() no tiene ninguna fila para comparar.';

-- ============================================================
-- VISTA: asistente_fase_a_uso_semanal
-- ============================================================
CREATE OR REPLACE VIEW public.asistente_fase_a_uso_semanal AS
SELECT
  date_trunc('week', u.creado_en)  AS semana,
  u.tool_finalmente_usada,
  COUNT(*)                          AS cantidad
FROM public.asistente_uso u
WHERE u.tool_finalmente_usada IN (
  'registrar_cobro_cliente',
  'crear_producto',
  'editar_producto',
  'anular_factura',
  'emitir_factura'
)
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

COMMENT ON VIEW public.asistente_fase_a_uso_semanal IS
  'Frente 4 de PLAN_OPTIMIZACION_ASISTENTE_2026.md (PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md, Fase A): uso real por voz de las 5 tools de escritura de la Fase A, semana a semana. Se compara a mano contra el uso manual de las mismas acciones desde el panel — no hay un log unificado de "acción manual" para cruzar automáticamente todavía.';

-- Mismo criterio de acceso que asistente_candidatos_sinonimo (migración
-- 601): RLS heredado de asistente_uso, security_invoker por defecto.
GRANT SELECT ON public.asistente_metodo_seleccion_resumen TO authenticated;
GRANT SELECT ON public.asistente_fase_a_uso_semanal       TO authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '603_asistente_frente4_vistas_revision.sql', '603', 'claude-session',
        'Vistas de revisión para PLAN_OPTIMIZACION_ASISTENTE_2026.md: asistente_metodo_seleccion_resumen (impacto real del Frente 2, semantica vs keywords vs nucleo_fallback por semana) y asistente_fase_a_uso_semanal (Frente 4, uso real por voz de las 5 tools de escritura de la Fase A de PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
