-- 501_empresa_slug_link_catalogo.sql
--
-- Contexto: el link del catálogo público (/cliente/catalogo?empresa_id=uuid)
-- usa el UUID crudo de la empresa. A diferencia del link de portal de
-- proveedor (099), acá el "secreto" no es tal — cualquier cliente de la
-- empresa comparte el mismo link, no da acceso a nada que no sea el
-- catálogo público — así que no hay razón de seguridad para que sea
-- ilegible. Se agrega un slug editable (ej. "delsol") para que el dueño
-- pueda pasarlo de palabra, imprimirlo en un cartel, etc.
--
-- Alcance: solo agrega la columna + resolución. El resto (endpoint admin
-- para editarlo, RPC pública) va en el mismo archivo por ser un cambio
-- chico y acoplado.

-- ── 1. Columna + índice único (case-insensitive por convención: se guarda
--       siempre en minúsculas, ver validación en el handler) ──────────────
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS slug text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_slug ON public.empresas (slug)
  WHERE slug IS NOT NULL;

COMMENT ON COLUMN public.empresas.slug IS
  'Identificador legible y editable para compartir el link del catálogo público (/cliente/catalogo?e=<slug>) en vez del UUID crudo. No es un secreto — mismo criterio que empresa_id en la URL, solo que fácil de tipear/dictar.';

-- ── 2. Backfill de las empresas existentes sin slug ────────────────────────
-- Deriva el slug del nombre: minúsculas, sin acentos, solo [a-z0-9-],
-- recortado a 30 chars, con sufijo numérico si hay colisión.
DO $$
DECLARE
  v_empresa   RECORD;
  v_base      text;
  v_candidato text;
  v_sufijo    int;
BEGIN
  FOR v_empresa IN SELECT id, nombre FROM public.empresas WHERE slug IS NULL ORDER BY created_at
  LOOP
    v_base := lower(v_empresa.nombre);
    v_base := translate(v_base,
      'áéíóúüñàèìòùâêîôûäëïöü',
      'aeiouunaeiouaeiouaeiou');
    v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
    v_base := regexp_replace(v_base, '(^-+|-+$)', '', 'g');
    v_base := left(v_base, 30);
    IF v_base = '' OR v_base IS NULL THEN
      v_base := 'empresa';
    END IF;

    v_candidato := v_base;
    v_sufijo := 1;
    WHILE EXISTS (SELECT 1 FROM public.empresas WHERE slug = v_candidato) LOOP
      v_sufijo := v_sufijo + 1;
      v_candidato := left(v_base, 27) || '-' || v_sufijo;
    END LOOP;

    UPDATE public.empresas SET slug = v_candidato WHERE id = v_empresa.id;
  END LOOP;
END $$;

-- ── 3. RPC pública: resolver por slug (mismo gateo que empresa_publica_por_id,
--       476) — solo expone id/nombre/logo_url, y solo si catalogo_publico_
--       habilitado = true (o si el caller ya pertenece a esa empresa). ───────
CREATE OR REPLACE FUNCTION public.empresa_publica_por_slug(p_slug text)
RETURNS TABLE(id uuid, nombre text, logo_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  SELECT e.id INTO v_empresa_id FROM public.empresas e WHERE e.slug = lower(p_slug);
  IF v_empresa_id IS NULL THEN
    RETURN;
  END IF;

  IF auth.role() <> 'service_role'
     AND public.get_empresa_id() IS DISTINCT FROM v_empresa_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.empresas e
       WHERE e.id = v_empresa_id
         AND COALESCE((e.config->>'catalogo_publico_habilitado')::boolean, false) = true
    ) THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT e.id, e.nombre, e.logo_url
  FROM public.empresas e
  WHERE e.id = v_empresa_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.empresa_publica_por_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.empresa_publica_por_slug(text) TO anon, authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '501_empresa_slug_link_catalogo.sql', '501', 'claude-session',
  'Agrega empresas.slug (editable, único, backfill automático desde nombre) y RPC empresa_publica_por_slug — permite un link de catálogo legible (/cliente/catalogo?e=slug) en vez del UUID crudo, mismo gateo de catalogo_publico_habilitado que empresa_publica_por_id (476).')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
