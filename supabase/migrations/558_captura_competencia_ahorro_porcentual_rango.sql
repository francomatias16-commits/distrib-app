-- =============================================================
-- 558_captura_competencia_ahorro_porcentual_rango.sql
--
-- Fix: "Cerrar cotización" en captura-competencia devolvía el genérico
-- "No se pudo procesar la captura de competencia." sin motivo. Causa raíz:
-- captura_competencia.ahorro_porcentual es numeric(5,2) (rango -999.99 a
-- 999.99), y cuando un renglón queda matcheado contra el producto propio
-- equivocado (ej. otra presentación/peso) el % de ahorro calculado puede
-- irse muy por fuera de ese rango (visto en producción: ~-2035%), lo que
-- hace explotar el UPDATE con un error de Postgres que el catch genérico
-- del handler no traduce a un mensaje útil.
--
-- El fix principal (validación de precios sospechosos antes de guardar,
-- con mensaje accionable para el vendedor) va en el handler
-- (lib/handlers/captura-competencia.js, accionCerrar). Esta migración es
-- la segunda capa: ensancha la columna para que un % de ahorro legítimo
-- pero grande (o cualquier caso no contemplado) no vuelva a romper el
-- guardado con un error opaco.
-- =============================================================

ALTER TABLE public.captura_competencia
  ALTER COLUMN ahorro_porcentual TYPE numeric(9,2);

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '558_captura_competencia_ahorro_porcentual_rango.sql', '558', 'claude-session',
  'Fix bug "Cerrar cotización" sin motivo: ahorro_porcentual pasa de numeric(5,2) a numeric(9,2) para que un % de ahorro fuera de rango (por matching de producto equivocado) no reviente el UPDATE con un error opaco. Fix principal (validación de precios sospechosos) en el handler.')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
