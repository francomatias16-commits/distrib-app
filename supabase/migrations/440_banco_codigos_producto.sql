-- =============================================================
-- 440_banco_codigos_producto.sql
-- Banco de códigos de barras COMPARTIDO entre todas las empresas del SaaS.
--
-- Contexto: al dar de alta un producto, /api/auto-imagenes y el escaneo
-- remoto (productos-scanner-remoto.js) ya consultaban Open Food Facts /
-- Open Products Facts para autocompletar nombre y foto a partir del
-- código de barras. Cobertura real para productos de bazar/limpieza
-- mayorista: 0% (ver CHANGELOG_v398). Se agregan dos fuentes más:
--   1. Mercado Libre (site_id MLA, búsqueda pública por GTIN) — sin key.
--   2. Este banco propio: cuando UNA empresa carga a mano un producto
--      (o lo confirma desde OFF/OPF/Mercado Libre), el dato queda
--      guardado acá para que CUALQUIER otra empresa del SaaS que
--      escanee el mismo código de barras lo tenga gratis, sin depender
--      de que la fuente externa lo tenga.
--
-- Es intencionalmente una tabla SIN empresa_id: el código de barras
-- (EAN/UPC) identifica un producto físico, no algo propio de una
-- empresa — dos distribuidoras que venden la misma gaseosa comparten
-- el mismo código. Por eso NO lleva RLS por empresa como el resto de
-- las tablas del proyecto: se lee libremente entre todas las empresas
-- autenticadas y se escribe únicamente vía service_role (handler
-- lib/handlers/banco-codigos.js, gateado por permisos-service.js con
-- el recurso 'banco_codigos_producto').
-- =============================================================

CREATE TABLE IF NOT EXISTS public.banco_codigos_producto (
  codigo            TEXT PRIMARY KEY,
  nombre            TEXT,
  foto_url          TEXT,
  fuente            TEXT NOT NULL DEFAULT 'manual'
                      CHECK (fuente IN ('manual', 'openfoodfacts', 'openproductsfacts', 'mercadolibre')),
  veces_confirmado  INT NOT NULL DEFAULT 1,
  aportado_por      UUID REFERENCES public.empresas(id) ON DELETE SET NULL,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT banco_codigos_producto_algo_check
    CHECK (nombre IS NOT NULL OR foto_url IS NOT NULL)
);

COMMENT ON TABLE public.banco_codigos_producto IS
  'Banco compartido entre TODAS las empresas del SaaS: código de barras -> nombre/foto. Sin empresa_id a propósito (el código identifica un producto físico, no algo propio de una empresa). Se aporta automáticamente al guardar un producto con código+nombre (ver guardarProducto en productos.js) y se consulta antes de salir a Open Food Facts / Open Products Facts / Mercado Libre.';
COMMENT ON COLUMN public.banco_codigos_producto.veces_confirmado IS
  'Cuántas empresas distintas (o cargas distintas) aportaron el mismo código con datos — señal simple de confianza, no se usa todavía para resolver conflictos entre nombres distintos.';
COMMENT ON COLUMN public.banco_codigos_producto.aportado_por IS
  'Empresa que hizo el último aporte/confirmación. Solo informativo (soporte/depuración) — no filtra lectura, cualquier empresa ve el registro completo.';

CREATE INDEX IF NOT EXISTS idx_banco_codigos_producto_actualizado
  ON public.banco_codigos_producto(actualizado_en DESC);

-- ── Trigger: mantener actualizado_en al día en cada UPDATE ────────────────
CREATE OR REPLACE FUNCTION public.banco_codigos_producto_set_actualizado_en()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_banco_codigos_producto_actualizado_en ON public.banco_codigos_producto;
CREATE TRIGGER trg_banco_codigos_producto_actualizado_en
  BEFORE UPDATE ON public.banco_codigos_producto
  FOR EACH ROW
  EXECUTE FUNCTION public.banco_codigos_producto_set_actualizado_en();

-- ── RLS: lectura libre entre empresas autenticadas, escritura solo por ────
-- service_role (el handler ya valida permiso 'escribir' sobre
-- 'banco_codigos_producto' vía permisos-service.js antes de tocar la tabla).
ALTER TABLE public.banco_codigos_producto ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS banco_codigos_producto_select_todas ON public.banco_codigos_producto;
CREATE POLICY banco_codigos_producto_select_todas ON public.banco_codigos_producto
  FOR SELECT USING (true);

REVOKE ALL ON public.banco_codigos_producto FROM anon, authenticated;
GRANT SELECT ON public.banco_codigos_producto TO authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '440_banco_codigos_producto.sql', '440', 'claude-session',
        'Banco de códigos de barras compartido entre empresas (tabla sin empresa_id, RLS de solo lectura para authenticated, escritura vía service_role en lib/handlers/banco-codigos.js). Complementa Open Food Facts / Open Products Facts / Mercado Libre como fuente de nombre+foto al escanear un código en alta de producto.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
