-- Fix ARCA-AUDIT-01: emitirComprobanteARCA() y emitirNotaCreditoARCA() calculan
-- el próximo número de comprobante (nroCbte = ultimoNro + 1) consultando
-- FECompUltimoAutorizado a la AFIP — una llamada externa, sin ningún lock en
-- la base. Si dos facturas (o dos NC) del mismo punto de venta + tipo de
-- comprobante se emiten casi en simultáneo (dos pedidos confirmándose a la
-- vez, ambos disparando el listener pedido_creado, o un doble-click),
-- ambas pueden leer el mismo ultimoNro y pedir CAE con el mismo número.
-- El cliente Supabase acá es supabase-js sobre PostgREST (sin conexión
-- persistente por request), así que un pg_advisory_lock de sesión no sirve
-- de forma confiable — se implementa como lock por fila con detección de
-- lock "stale" (de un proceso que crasheó a mitad de camino y nunca liberó).
--
-- Clave del lock: (empresa_id, punto_venta, tipo_cbte) — mismo criterio que
-- usa AFIP para numerar (cada combinación tiene su propia numeración
-- correlativa), así que facturas y notas de crédito (tipo_cbte distinto)
-- nunca se bloquean entre sí innecesariamente, pero dos facturas del mismo
-- tipo sí se serializan.

CREATE TABLE IF NOT EXISTS public.arca_lock_emision (
  empresa_id    uuid NOT NULL,
  punto_venta   integer NOT NULL,
  tipo_cbte     integer NOT NULL,
  locked_at     timestamptz NOT NULL DEFAULT now(),
  locked_token  uuid NOT NULL,
  PRIMARY KEY (empresa_id, punto_venta, tipo_cbte)
);

COMMENT ON TABLE public.arca_lock_emision IS
  'Lock de aplicación (no de sesión de Postgres) para serializar la emisión '
  'de comprobantes ARCA por empresa+punto_venta+tipo_cbte, evitando que dos '
  'emisiones concurrentes pidan CAE con el mismo número de comprobante. '
  'Ver migración 487.';

CREATE OR REPLACE FUNCTION public.arca_lock_adquirir(
  p_empresa_id   uuid,
  p_punto_venta  integer,
  p_tipo_cbte    integer,
  p_stale_seconds integer DEFAULT 90
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_token uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO public.arca_lock_emision (empresa_id, punto_venta, tipo_cbte, locked_at, locked_token)
    VALUES (p_empresa_id, p_punto_venta, p_tipo_cbte, now(), v_token);
    RETURN v_token;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.arca_lock_emision
       SET locked_at = now(), locked_token = v_token
     WHERE empresa_id = p_empresa_id
       AND punto_venta = p_punto_venta
       AND tipo_cbte = p_tipo_cbte
       AND locked_at < now() - (p_stale_seconds || ' seconds')::interval;

    IF FOUND THEN
      RETURN v_token;
    END IF;

    RETURN NULL;
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.arca_lock_liberar(
  p_empresa_id  uuid,
  p_punto_venta integer,
  p_tipo_cbte   integer,
  p_token       uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  DELETE FROM public.arca_lock_emision
   WHERE empresa_id = p_empresa_id
     AND punto_venta = p_punto_venta
     AND tipo_cbte = p_tipo_cbte
     AND locked_token = p_token;
$function$;

ALTER TABLE public.arca_lock_emision ENABLE ROW LEVEL SECURITY;
