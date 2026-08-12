-- SEC-011 (auditoría 2026, encontrado durante integración dashboard-v3):
-- v_rentabilidad_zona_ruta (migración 069) quedó con los grants por
-- defecto de Postgres sobre una vista nueva (anon/authenticated con
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER), pese a que la
-- vista está documentada como "SIN security_invoker ni RLS propia, consumir
-- SOLO desde handler backend con SERVICE_ROLE_KEY, nunca exponer directo
-- por PostgREST al browser". En la práctica cualquier usuario (incluso
-- anon, sin login) podía leer margen/facturación/km recorridos de rutas de
-- TODAS las empresas via PostgREST directo, sin pasar por el filtro
-- empresa_id de /api/rutas-live. No se detectó explotación, solo el gap de
-- grants. Único consumidor real es lib/handlers/rutas-live.js con
-- SERVICE_ROLE_KEY (confirmado: sin usos de esta vista en frontend/).
--
-- NOTA: este archivo documenta un cambio que ya fue APLICADO directo en la
-- base de producción (jgiquzjwoedmzwqgzubr) durante la sesión de
-- integración de dashboard-v3, vía Supabase:apply_migration con este mismo
-- contenido. Se agrega acá para que el historial de migraciones del repo
-- quede consistente con lo que ya corre en producción.

REVOKE ALL ON public.v_rentabilidad_zona_ruta FROM anon, authenticated, public;
GRANT SELECT ON public.v_rentabilidad_zona_ruta TO service_role;
