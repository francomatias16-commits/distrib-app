-- ════════════════════════════════════════════════════════════════════
-- 633_saas_alertas_actividad_empresa.sql
--
-- Permite al superadmin (francomatias16) pedir que se le avise por
-- email cuando una empresa puntual vuelve a tener actividad (pedidos,
-- ventas, facturas, movimientos de stock, productos editados o login).
-- Reutiliza la infraestructura ya existente de saas_email_log +
-- Edge Function saas-email-sender (cron hourly, 131_fix_cron_email_
-- sender_no_vault), sumando un tipo nuevo: 'actividad_empresa'.
--
-- NOTA: esta migración ya fue aplicada directamente contra la base de
-- producción vía el MCP de Supabase. Este archivo es para mantener el
-- repo sincronizado con la base real — no hace falta volver a correrlo.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.saas_alertas_actividad_empresa (
  empresa_id                  uuid PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  email_destino                text NOT NULL,
  ultima_actividad_notificada  timestamptz NOT NULL DEFAULT now(),
  activo                       boolean NOT NULL DEFAULT true,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.saas_alertas_actividad_empresa IS
  'v633: watchlist manual del superadmin. fn_chequear_actividad_empresas() (cron) compara la última actividad real de cada empresa acá listada contra ultima_actividad_notificada; si hay algo más nuevo, encola un email tipo actividad_empresa en saas_email_log y actualiza el watermark.';

-- Sin RLS de tenant: esta tabla es de uso interno del superadmin, no se
-- expone a authenticated/anon.
ALTER TABLE public.saas_alertas_actividad_empresa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.saas_alertas_actividad_empresa FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.saas_alertas_actividad_empresa TO service_role;

-- ── Función que chequea actividad y encola el email si corresponde ────
CREATE OR REPLACE FUNCTION public.fn_chequear_actividad_empresas()
RETURNS TABLE(empresa_id uuid, aviso_encolado boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_ultima timestamptz;
BEGIN
  FOR r IN
    SELECT a.empresa_id, a.email_destino, a.ultima_actividad_notificada, e.nombre AS empresa_nombre
    FROM public.saas_alertas_actividad_empresa a
    JOIN public.empresas e ON e.id = a.empresa_id
    WHERE a.activo
  LOOP
    SELECT GREATEST(
      COALESCE((SELECT MAX(p.updated_at)    FROM public.pedidos p    WHERE p.empresa_id = r.empresa_id), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(v.created_at)    FROM public.ventas_pos v WHERE v.empresa_id = r.empresa_id), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(f.updated_at)    FROM public.facturas f   WHERE f.empresa_id = r.empresa_id), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(pr.updated_at)   FROM public.productos pr WHERE pr.empresa_id = r.empresa_id), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(c.fecha)         FROM public.cobros c     WHERE c.empresa_id = r.empresa_id), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(ms.created_at)
                  FROM public.movimientos_stock ms
                  JOIN public.productos pp ON pp.id = ms.producto_id
                 WHERE pp.empresa_id = r.empresa_id), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(u.last_sign_in_at)
                  FROM auth.users u
                  JOIN public.usuarios uu ON uu.id = u.id
                 WHERE uu.empresa_id = r.empresa_id), 'epoch'::timestamptz)
    ) INTO v_ultima;

    IF v_ultima > r.ultima_actividad_notificada THEN
      INSERT INTO public.saas_email_log (empresa_id, tipo, destinatario, enviado_at)
      VALUES (r.empresa_id, 'actividad_empresa', r.email_destino, now());

      UPDATE public.saas_alertas_actividad_empresa
         SET ultima_actividad_notificada = v_ultima, updated_at = now()
       WHERE empresa_id = r.empresa_id;

      empresa_id := r.empresa_id;
      aviso_encolado := true;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.fn_chequear_actividad_empresas() IS
  'v633: recorre saas_alertas_actividad_empresa (watchlist manual), calcula la última actividad real de cada empresa (pedidos/ventas/facturas/productos/cobros/stock/login) y encola un email tipo actividad_empresa en saas_email_log si hay algo posterior al último aviso. Pensada para correr por pg_cron cada 10-15 min.';

REVOKE EXECUTE ON FUNCTION public.fn_chequear_actividad_empresas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_chequear_actividad_empresas() TO service_role;

-- ── Cron: chequea actividad y dispara el envío cada 10 minutos ────────
SELECT cron.unschedule('chequeo_actividad_empresas') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'chequeo_actividad_empresas'
);

SELECT cron.schedule(
  'chequeo_actividad_empresas',
  '*/10 * * * *',
  $$
    SELECT public.fn_chequear_actividad_empresas();
    SELECT net.http_post(
      url     := 'https://jgiquzjwoedmzwqgzubr.supabase.co/functions/v1/saas-email-sender',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := '{}'::jsonb
    );
  $$
);

-- ── Alta de Leonardo (Sirius Limpieza) en la watchlist ─────────────────
-- Watermark = ahora: solo avisa de actividad NUEVA a partir de este momento,
-- no repite la actividad de ayer a la noche que ya se revisó a mano.
INSERT INTO public.saas_alertas_actividad_empresa (empresa_id, email_destino, ultima_actividad_notificada)
VALUES ('04719696-104a-4a41-9ceb-a13c8cb1d5e6', 'francomatias16@gmail.com', now())
ON CONFLICT (empresa_id) DO UPDATE SET
  email_destino = EXCLUDED.email_destino,
  activo = true,
  ultima_actividad_notificada = now(),
  updated_at = now();

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '633_saas_alertas_actividad_empresa.sql', '633', 'claude-session',
  'Watchlist de actividad por empresa para avisos manuales del superadmin por email. Alta inicial: empresa de Leonardo (Sirius Limpieza), avisa a francomatias16@gmail.com. Cron cada 10 min via fn_chequear_actividad_empresas() + saas-email-sender.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
