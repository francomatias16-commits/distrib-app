-- FAC-001: un CAE otorgado por ARCA cuya persistencia local falló no puede
-- quedar como pendiente/error_afip ni permitir una emisión duplicada.
ALTER TYPE public.estado_factura ADD VALUE IF NOT EXISTS 'cae_obtenido_sin_persistir';
