-- ============================================================================
-- 053_portal_proveedor.sql
-- Innovación #10 (roadmap): Autogestión de Proveedores — "Vidriera Inversa"
--
-- Permite generar un link firmado, sin login, para que el proveedor vea sus
-- propias OCs (todas las de su cuenta, no una OC puntual) sin entrar al panel
-- admin. El link expira a los 30 días desde que se genera.
--
-- Seguridad: el token NUNCA se guarda en texto plano (mismo patrón que los
-- refresh tokens de chofer en lib/auth-helpers.js: crypto.randomBytes +
-- sha256). RLS queda DENY-ALL: la tabla solo se lee/escribe desde el handler
-- serverless con SUPABASE_SERVICE_ROLE_KEY. La anon key del frontend (que
-- vive en env-config.js, visible públicamente) nunca debe poder leer esto.
-- ============================================================================

CREATE TABLE public.proveedor_portal_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id      uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    proveedor_id    uuid NOT NULL REFERENCES public.proveedores(id) ON DELETE CASCADE,
    token_hash      text NOT NULL UNIQUE,          -- sha256 del token; el token crudo solo existe en la URL entregada
    creado_por      uuid REFERENCES public.usuarios(id),
    creado_at       timestamp with time zone NOT NULL DEFAULT now(),
    expira_at       timestamp with time zone NOT NULL,
    revocado_at     timestamp with time zone,
    ultimo_uso_at   timestamp with time zone,
    usos            integer NOT NULL DEFAULT 0
);

CREATE INDEX idx_portal_tokens_hash       ON public.proveedor_portal_tokens (token_hash);
CREATE INDEX idx_portal_tokens_proveedor  ON public.proveedor_portal_tokens (proveedor_id);

COMMENT ON TABLE public.proveedor_portal_tokens IS
  'Tokens de acceso sin login para que un proveedor consulte/gestione sus propias OCs. Ver lib/handlers/proveedores.js (_svc=portal).';
COMMENT ON COLUMN public.proveedor_portal_tokens.token_hash IS
  'sha256(token). El token crudo se entrega una sola vez en la URL y no se persiste.';

-- RLS: deny-all. Toda la lógica de autorización vive en el handler serverless
-- (verifica el hash, chequea expira_at/revocado_at) usando SERVICE_ROLE_KEY,
-- que bypassea RLS. Esto evita que la anon key pueda leer o falsificar tokens.
ALTER TABLE public.proveedor_portal_tokens ENABLE ROW LEVEL SECURITY;

-- (Sin políticas = ninguna fila visible/escribible vía anon/authenticated key)

-- ── RPC: validar token de portal de proveedor ─────────────────────────────
-- Centraliza la lógica de validación (existe, no vencido, no revocado) y
-- registra el uso. Devuelve el proveedor_id/empresa_id si es válido.
CREATE OR REPLACE FUNCTION public.validar_token_portal_proveedor(p_token_hash text)
RETURNS TABLE (
    valido        boolean,
    motivo        text,
    proveedor_id  uuid,
    empresa_id    uuid,
    token_id      uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.proveedor_portal_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.proveedor_portal_tokens
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no_encontrado', NULL::uuid, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  IF v_row.revocado_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'revocado', v_row.proveedor_id, v_row.empresa_id, v_row.id;
    RETURN;
  END IF;

  IF v_row.expira_at < now() THEN
    RETURN QUERY SELECT false, 'expirado', v_row.proveedor_id, v_row.empresa_id, v_row.id;
    RETURN;
  END IF;

  UPDATE public.proveedor_portal_tokens
  SET usos = usos + 1, ultimo_uso_at = now()
  WHERE id = v_row.id;

  RETURN QUERY SELECT true, 'ok', v_row.proveedor_id, v_row.empresa_id, v_row.id;
END;
$$;

COMMENT ON FUNCTION public.validar_token_portal_proveedor IS
  'Valida un token de portal de proveedor (hash sha256) y registra el uso. Usar SIEMPRE vía SERVICE_ROLE desde el handler, nunca exponer a la anon key.';
