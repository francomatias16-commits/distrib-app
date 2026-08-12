-- ═══════════════════════════════════════════════════════════════════════════
-- 232_fix_auditoria_etapa2_rls_empresas_activo_grants.sql
-- Ejecutar en Supabase SQL Editor contra el proyecto jgiquzjwoedmzwqgzubr.
--
-- Corrige los hallazgos de "Auditoría Técnica End-to-End — distrib · Módulo:
-- Topbar / Reloj / Avatar · Etapa 2 (build auditado v232)":
--
--   [Crítica] empresas_select_propio (introducida en 050_fix_activo_rls_v53)
--             agregó "OR activa = true", lo que permite leer TODAS las
--             columnas de TODAS las empresas activas del SaaS —incluyendo
--             saas_cbu / saas_alias (datos bancarios)— con solo la anon key
--             pública, sin autenticación.
--   [Alta]    get_empresa_id() / get_rol_usuario() no filtran por
--             usuarios.activo → un usuario desactivado sigue operando el
--             panel completo hasta que expira su JWT.
--   [Media]   anon/authenticated tienen GRANT completo (INSERT/UPDATE/
--             DELETE/TRUNCATE/...) sobre empresas y usuarios, sin ningún
--             caso de uso legítimo que lo requiera; hoy están "protegidos"
--             solo por default-deny de RLS, sin una segunda capa.
--
-- Requisito previo (ya aplicado en el código de esta release, v233):
--   frontend/admin/login.html y frontend/cliente/login.html ahora leen
--   nombre/logo_url desde v_empresas_publico (creada acá) en vez de la
--   tabla empresas directa, porque esas pantallas se ven sin sesión.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. [Crítica] Revertir el OR inseguro de empresas_select_propio ────────
-- La policy original de 002_rls.sql (id = get_empresa_id()) era correcta;
-- 050_fix_activo_rls_v53 la reemplazó agregando "OR activa = true" y ese
-- es el agujero. Volvemos a la versión estricta.
DROP POLICY IF EXISTS "empresas_select_propio" ON public.empresas;
DROP POLICY IF EXISTS "empresas_select" ON public.empresas;

CREATE POLICY "empresas_select_propio" ON public.empresas
  FOR SELECT
  USING (id = public.get_empresa_id());

-- ── 2. Vista pública whitelisteada para pantallas sin sesión ──────────────
-- login admin y login cliente necesitan mostrar nombre/logo antes de que
-- exista sesión. En vez de relajar la policy de la tabla completa, se
-- expone una vista mínima con SOLO las columnas no sensibles.
CREATE OR REPLACE VIEW public.v_empresas_publico AS
  SELECT id, nombre, logo_url
  FROM public.empresas
  WHERE activa = true;

GRANT SELECT ON public.v_empresas_publico TO anon, authenticated;

-- ── 3. [Alta] get_empresa_id() / get_rol_usuario() deben exigir activo ────
-- Estas dos funciones SECURITY DEFINER son la base de TODAS las policies
-- de RLS del sistema. Sin el filtro activo=true, desactivar un usuario no
-- lo saca del sistema hasta que expire su JWT (no hay revocación de sesión
-- automática al desactivar).
CREATE OR REPLACE FUNCTION public.get_empresa_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT empresa_id FROM public.usuarios
  WHERE id = auth.uid() AND activo = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_rol_usuario()
RETURNS rol_usuario
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rol FROM public.usuarios
  WHERE id = auth.uid() AND activo = true
  LIMIT 1;
$$;

-- ── 4. [Media] Endurecer GRANTs de anon/authenticated ──────────────────────
-- anon no tiene ningún caso de uso legítimo que requiera escribir en estas
-- tablas; authenticated escribe siempre a través de las policies de RLS
-- (que ya exigen empresa propia + rol), así que tampoco necesita el GRANT
-- amplio de nivel de rol — pero acá solo tocamos anon para no romper
-- flujos de authenticated que dependan hoy de UPDATE/INSERT vía RLS.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.empresas, public.usuarios
  FROM anon;

-- ── 5. Verificación manual post-deploy ─────────────────────────────────────
-- Correr SIN estar logueado (o con la anon key desde curl/Postman):
--   GET /rest/v1/empresas?select=*            → debe devolver [] (antes: todas las activas)
--   GET /rest/v1/v_empresas_publico?select=*  → debe devolver solo id/nombre/logo_url
-- Correr con un usuario que tenga activo=false:
--   login en /admin/login → debe rechazar con error=usuario_inactivo
