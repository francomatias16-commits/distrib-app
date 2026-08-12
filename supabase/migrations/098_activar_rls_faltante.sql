-- ============================================================================
-- 052_activar_rls_faltante.sql
-- Activa RLS en 21 tablas que ya tenían políticas creadas (CREATE POLICY)
-- pero NUNCA tuvieron ENABLE ROW LEVEL SECURITY ejecutado.
--
-- Sin este ALTER, las políticas existen en el catálogo de Postgres pero NO
-- se aplican: las tablas quedan accesibles sin restricción vía la API REST
-- de Supabase (PostgREST) usando la anon key, que vive en el frontend
-- (env-config.js). Esto incluye integraciones_pago (credenciales de
-- Mercado Pago por empresa) y todas las tablas operativas core.
--
-- Verificado contra backup.sql (dump real de producción) el 19/06/2026.
-- ============================================================================

ALTER TABLE public.canjes_recompensas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cheques                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobros                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cta_cte                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.depositos               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispositivos_push       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entregas                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integraciones_pago      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_puntos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_stock       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notificaciones_push     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.precios_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programas_fidelizacion  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recompensas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rutas                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saldo_puntos            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sugerencias_pedido      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transacciones_pago      ENABLE ROW LEVEL SECURITY;
