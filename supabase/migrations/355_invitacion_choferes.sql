-- ============================================================================
-- 355_invitacion_choferes.sql
-- Repartos → "Invitar chofer": permite al admin invitar por link (WhatsApp)
-- a un chofer para que active su propio acceso a la app /chofer, en vez de
-- que el admin le asigne email+password a mano desde /admin/usuarios.html.
--
-- Dos modos, según si el chofer ya existe como fila en `usuarios`:
--   - usuario_id NOT NULL → chofer ya existente (rol='chofer') sin acceso
--     activado todavía (o al que se le quiere resetear el acceso). El
--     token, al aceptarse, solo define/resetea su password.
--   - usuario_id NULL     → alta nueva. Los datos (nombre/telefono) quedan
--     en borrador en esta tabla hasta que el chofer acepta la invitación;
--     recién ahí se crea el usuario en Supabase Auth + tabla `usuarios`.
--
-- Mismo patrón de seguridad que proveedor_portal_tokens (migración 099):
-- token crudo nunca se persiste (solo sha256), RLS deny-all, toda la
-- lógica de autorización vive en el handler serverless con SERVICE_ROLE_KEY.
-- Ver lib/handlers/chofer_invitacion.js.
-- ============================================================================

CREATE TABLE public.chofer_invitaciones (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id      uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    usuario_id      uuid REFERENCES public.usuarios(id) ON DELETE CASCADE, -- NULL = alta nueva (borrador)
    nombre          text NOT NULL,
    telefono        text NOT NULL,
    token_hash      text NOT NULL UNIQUE,
    creado_por      uuid REFERENCES public.usuarios(id),
    creado_at       timestamp with time zone NOT NULL DEFAULT now(),
    expira_at       timestamp with time zone NOT NULL,
    revocado_at     timestamp with time zone,
    usado_at        timestamp with time zone
);

CREATE INDEX idx_chofer_inv_hash     ON public.chofer_invitaciones (token_hash);
CREATE INDEX idx_chofer_inv_empresa  ON public.chofer_invitaciones (empresa_id);
CREATE INDEX idx_chofer_inv_usuario  ON public.chofer_invitaciones (usuario_id);

COMMENT ON TABLE public.chofer_invitaciones IS
  'Invitaciones (token de un solo uso) para que un chofer active su acceso a /chofer. Ver lib/handlers/chofer_invitacion.js.';
COMMENT ON COLUMN public.chofer_invitaciones.token_hash IS
  'sha256(token). El token crudo se entrega una sola vez en la URL/WhatsApp y no se persiste.';
COMMENT ON COLUMN public.chofer_invitaciones.usuario_id IS
  'NULL = alta nueva (nombre/telefono son borrador hasta aceptar). NOT NULL = chofer existente activando/reseteando su acceso.';

-- RLS: deny-all — misma justificación que proveedor_portal_tokens (099).
ALTER TABLE public.chofer_invitaciones ENABLE ROW LEVEL SECURITY;

-- ── RPC: validar token de invitación de chofer ─────────────────────────────
CREATE OR REPLACE FUNCTION public.validar_token_invitacion_chofer(p_token_hash text)
RETURNS TABLE (
    valido        boolean,
    motivo        text,
    invitacion_id uuid,
    empresa_id    uuid,
    usuario_id    uuid,
    nombre        text,
    telefono      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.chofer_invitaciones%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.chofer_invitaciones
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no_encontrado', NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_row.usado_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'usado', v_row.id, v_row.empresa_id, v_row.usuario_id, v_row.nombre, v_row.telefono;
    RETURN;
  END IF;

  IF v_row.revocado_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'revocado', v_row.id, v_row.empresa_id, v_row.usuario_id, v_row.nombre, v_row.telefono;
    RETURN;
  END IF;

  IF v_row.expira_at < now() THEN
    RETURN QUERY SELECT false, 'expirado', v_row.id, v_row.empresa_id, v_row.usuario_id, v_row.nombre, v_row.telefono;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'ok', v_row.id, v_row.empresa_id, v_row.usuario_id, v_row.nombre, v_row.telefono;
END;
$$;

COMMENT ON FUNCTION public.validar_token_invitacion_chofer IS
  'Valida (sin consumir) un token de invitación de chofer. El consumo (usado_at) lo hace el handler recién al completar el alta/reset de password, ya con SERVICE_ROLE. Usar SIEMPRE vía SERVICE_ROLE, nunca exponer a la anon key.';

REVOKE ALL ON FUNCTION public.validar_token_invitacion_chofer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validar_token_invitacion_chofer(text) TO authenticated, service_role;
