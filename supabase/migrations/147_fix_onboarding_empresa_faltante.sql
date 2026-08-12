-- =============================================================
-- MIGRACIÓN 147: fix onboarding_empresa faltante
-- Auditoría 2026-06-30
-- NOTA: La función se creó originalmente en 009_etapa6_produccion.sql
-- y figura como aplicada en schema_migrations_registry, pero no existe
-- hoy en la base (se perdió al recrear funciones con search_path fijo
-- en las migraciones de hardening 108/126). frontend/admin/superadmin.html
-- la llama al dar de alta una empresa nueva (sb.rpc('onboarding_empresa',
-- { empresa_uuid })) y rompía después del INSERT en empresas, dejando
-- la empresa a medio crear (sin depósito, lista de precios, zona ni
-- categoría base).
-- Se recrea con el mismo comportamiento original, pero hardenizada:
-- search_path fijo y tablas schema-calificadas (public.).
-- =============================================================
CREATE OR REPLACE FUNCTION public.onboarding_empresa(empresa_uuid UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    deposito_id UUID;
    lista_id    UUID;
BEGIN
    -- 0. Guard: que la empresa exista
    IF NOT EXISTS (SELECT 1 FROM public.empresas WHERE id = empresa_uuid) THEN
        RAISE EXCEPTION 'La empresa % no existe', empresa_uuid;
    END IF;

    -- 1. Crear depósito principal (solo si no tiene uno todavía -> idempotente)
    IF NOT EXISTS (SELECT 1 FROM public.depositos WHERE empresa_id = empresa_uuid) THEN
        INSERT INTO public.depositos (empresa_id, nombre, es_principal)
        VALUES (empresa_uuid, 'Depósito Central', true)
        RETURNING id INTO deposito_id;
    END IF;

    -- 2. Crear lista de precios por defecto
    IF NOT EXISTS (SELECT 1 FROM public.listas_precios WHERE empresa_id = empresa_uuid) THEN
        INSERT INTO public.listas_precios (empresa_id, nombre, es_default, activa)
        VALUES (empresa_uuid, 'Lista General', true, true)
        RETURNING id INTO lista_id;
    END IF;

    -- 3. Crear zona base
    IF NOT EXISTS (SELECT 1 FROM public.zonas WHERE empresa_id = empresa_uuid) THEN
        INSERT INTO public.zonas (empresa_id, nombre, activa)
        VALUES (empresa_uuid, 'Zona Local', true);
    END IF;

    -- 4. Crear categoría base
    IF NOT EXISTS (SELECT 1 FROM public.categorias WHERE empresa_id = empresa_uuid) THEN
        INSERT INTO public.categorias (empresa_id, nombre, orden)
        VALUES (empresa_uuid, 'General', 0);
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.onboarding_empresa(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.onboarding_empresa(UUID) TO authenticated;

-- Registrar en el log manual de migraciones aplicadas
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '147_fix_onboarding_empresa_faltante.sql', '147', 'claude-auditoria',
        'Recrea onboarding_empresa, ausente en prod pese a figurar aplicada (migración 009).')
ON CONFLICT DO NOTHING;
