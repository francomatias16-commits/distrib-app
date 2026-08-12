-- ============================================================================
-- 438_pos_scanner_remoto.sql
-- POS → "Vincular celular": el celular funciona como lector remoto del POS.
-- El cajero escanea con la cámara del teléfono y el código le llega en
-- tiempo real (Supabase Realtime Broadcast) a la sesión del POS que está
-- corriendo en la compu del mostrador — sin pasar por el backend en cada
-- escaneo y sin persistir los códigos escaneados en ningún lado.
--
-- Esta tabla NO guarda los códigos escaneados: solo la sesión de vínculo
-- (el token que identifica, para ambos lados, el canal Realtime a usar).
--
-- Mismo patrón de seguridad que proveedor_portal_tokens (099) y
-- chofer_invitaciones (355): token de un solo uso hasheado (nunca se
-- persiste el token crudo), RLS deny-all, toda la autorización resuelta
-- server-side con SERVICE_ROLE_KEY. Ver lib/handlers/pos-scanner.js.
-- ============================================================================

CREATE TABLE public.pos_scanner_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id      uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    caja_id         uuid NOT NULL REFERENCES public.cajas_pos(id) ON DELETE CASCADE,
    creado_por      uuid REFERENCES public.usuarios(id),
    token_hash      text NOT NULL UNIQUE,
    creado_at       timestamp with time zone NOT NULL DEFAULT now(),
    expira_at       timestamp with time zone NOT NULL,
    revocado_at     timestamp with time zone
);

CREATE INDEX idx_pos_scanner_tok_hash    ON public.pos_scanner_tokens (token_hash);
CREATE INDEX idx_pos_scanner_tok_empresa ON public.pos_scanner_tokens (empresa_id);
CREATE INDEX idx_pos_scanner_tok_caja    ON public.pos_scanner_tokens (caja_id);

COMMENT ON TABLE public.pos_scanner_tokens IS
  'Sesiones de escaneo remoto (celular como lector del POS vía QR). Ver lib/handlers/pos-scanner.js.';
COMMENT ON COLUMN public.pos_scanner_tokens.token_hash IS
  'sha256(token). El token crudo viaja una sola vez en la URL del QR y no se persiste. También identifica el canal de Supabase Realtime Broadcast usado para relayar los códigos escaneados.';
COMMENT ON COLUMN public.pos_scanner_tokens.expira_at IS
  'Vencimiento corto (ver DURACION_MINUTOS en el handler) — es una sesión de mostrador, no un link para reusar después.';

-- RLS: deny-all — misma justificación que proveedor_portal_tokens (099) y
-- chofer_invitaciones (355). Todo el acceso pasa por SERVICE_ROLE_KEY.
ALTER TABLE public.pos_scanner_tokens ENABLE ROW LEVEL SECURITY;

-- ── RPC: validar (sin consumir) un token de escaneo remoto ────────────────
CREATE OR REPLACE FUNCTION public.validar_token_scanner_pos(p_token_hash text)
RETURNS TABLE (
    valido          boolean,
    motivo          text,
    token_id        uuid,
    empresa_id      uuid,
    caja_id         uuid,
    empresa_nombre  text,
    caja_nombre     text,
    expira_at       timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pos_scanner_tokens%ROWTYPE;
  v_empresa_nombre text;
  v_caja_nombre    text;
BEGIN
  SELECT * INTO v_row
  FROM public.pos_scanner_tokens
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no_encontrado', NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_row.revocado_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'revocado', v_row.id, v_row.empresa_id, v_row.caja_id, NULL::text, NULL::text, v_row.expira_at;
    RETURN;
  END IF;

  IF v_row.expira_at < now() THEN
    RETURN QUERY SELECT false, 'expirado', v_row.id, v_row.empresa_id, v_row.caja_id, NULL::text, NULL::text, v_row.expira_at;
    RETURN;
  END IF;

  SELECT nombre INTO v_empresa_nombre FROM public.empresas  WHERE id = v_row.empresa_id;
  SELECT nombre INTO v_caja_nombre    FROM public.cajas_pos WHERE id = v_row.caja_id;

  RETURN QUERY SELECT true, 'ok', v_row.id, v_row.empresa_id, v_row.caja_id, v_empresa_nombre, v_caja_nombre, v_row.expira_at;
END;
$$;

COMMENT ON FUNCTION public.validar_token_scanner_pos IS
  'Valida (sin consumir) un token de escaneo remoto del POS. Usar SIEMPRE vía SERVICE_ROLE, nunca exponer a la anon key.';

REVOKE ALL ON FUNCTION public.validar_token_scanner_pos(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validar_token_scanner_pos(text) TO authenticated, service_role;
