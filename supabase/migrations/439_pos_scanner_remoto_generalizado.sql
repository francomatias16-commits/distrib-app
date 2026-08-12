-- ============================================================================
-- 439_pos_scanner_remoto_generalizado.sql
-- Generaliza pos_scanner_tokens (438) de "solo caja de POS" a un vínculo de
-- escaneo remoto multi-contexto: además de vender en POS, ahora también se
-- puede vincular el celular desde alta/edición de producto y desde ajuste
-- de stock (ver CONTEXTOS en lib/handlers/pos-scanner.js).
--
-- caja_id (FK fija a cajas_pos) pasa a ser entidad_id (uuid libre, sin FK):
-- según el contexto identifica una caja, un depósito, o nada (alta_producto
-- no necesita entidad puntual). La validación de que esa entidad existe y
-- pertenece a la empresa ya no vive en la base — la resuelve el handler
-- contra la tabla que corresponda (CONTEXTOS[contexto].entidadValida).
-- ============================================================================

ALTER TABLE public.pos_scanner_tokens
  DROP CONSTRAINT IF EXISTS pos_scanner_tokens_caja_id_fkey;

ALTER TABLE public.pos_scanner_tokens
  RENAME COLUMN caja_id TO entidad_id;

ALTER TABLE public.pos_scanner_tokens
  ALTER COLUMN entidad_id DROP NOT NULL;

ALTER TABLE public.pos_scanner_tokens
  ADD COLUMN contexto text NOT NULL DEFAULT 'pos';

ALTER TABLE public.pos_scanner_tokens
  ALTER COLUMN contexto DROP DEFAULT;

ALTER TABLE public.pos_scanner_tokens
  ADD CONSTRAINT pos_scanner_tokens_contexto_check
  CHECK (contexto IN ('pos', 'alta_producto', 'ajuste_stock'));

ALTER INDEX IF EXISTS idx_pos_scanner_tok_caja RENAME TO idx_pos_scanner_tok_entidad;

COMMENT ON COLUMN public.pos_scanner_tokens.contexto IS
  'Qué pantalla generó el vínculo — ver CONTEXTOS en lib/handlers/pos-scanner.js.';
COMMENT ON COLUMN public.pos_scanner_tokens.entidad_id IS
  'Caja (contexto=pos) o depósito (contexto=ajuste_stock); NULL en alta_producto. Sin FK: cada contexto valida contra su propia tabla en el handler, no acá.';

-- ── RPC: validar (sin consumir) un token de escaneo remoto ────────────────
-- Reemplaza la versión de 438: ahora devuelve `contexto` y una `etiqueta`
-- genérica (nombre de caja o de depósito según corresponda) en vez de
-- `caja_id`/`caja_nombre` fijos.
CREATE OR REPLACE FUNCTION public.validar_token_scanner_pos(p_token_hash text)
RETURNS TABLE (
    valido          boolean,
    motivo          text,
    token_id        uuid,
    empresa_id      uuid,
    contexto        text,
    entidad_id      uuid,
    empresa_nombre  text,
    etiqueta        text,
    expira_at       timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pos_scanner_tokens%ROWTYPE;
  v_empresa_nombre text;
  v_etiqueta       text;
BEGIN
  SELECT * INTO v_row
  FROM public.pos_scanner_tokens
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no_encontrado', NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_row.revocado_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'revocado', v_row.id, v_row.empresa_id, v_row.contexto, v_row.entidad_id, NULL::text, NULL::text, v_row.expira_at;
    RETURN;
  END IF;

  IF v_row.expira_at < now() THEN
    RETURN QUERY SELECT false, 'expirado', v_row.id, v_row.empresa_id, v_row.contexto, v_row.entidad_id, NULL::text, NULL::text, v_row.expira_at;
    RETURN;
  END IF;

  SELECT nombre INTO v_empresa_nombre FROM public.empresas WHERE id = v_row.empresa_id;

  IF v_row.contexto = 'pos' THEN
    SELECT nombre INTO v_etiqueta FROM public.cajas_pos WHERE id = v_row.entidad_id;
  ELSIF v_row.contexto = 'ajuste_stock' THEN
    SELECT nombre INTO v_etiqueta FROM public.depositos WHERE id = v_row.entidad_id;
  ELSE
    v_etiqueta := NULL;
  END IF;

  RETURN QUERY SELECT true, 'ok', v_row.id, v_row.empresa_id, v_row.contexto, v_row.entidad_id, v_empresa_nombre, v_etiqueta, v_row.expira_at;
END;
$$;

COMMENT ON FUNCTION public.validar_token_scanner_pos IS
  'Valida (sin consumir) un token de escaneo remoto multi-contexto (pos/alta_producto/ajuste_stock). Usar SIEMPRE vía SERVICE_ROLE, nunca exponer a la anon key.';

REVOKE ALL ON FUNCTION public.validar_token_scanner_pos(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validar_token_scanner_pos(text) TO authenticated, service_role;
