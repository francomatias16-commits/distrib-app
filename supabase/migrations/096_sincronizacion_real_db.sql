-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 047: Sincronización DB real (bddistri) con código v47
-- Ejecutar en Supabase SQL Editor ANTES de desplegar el código v47
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Columnas faltantes en clientes
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS bloqueado boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS bloqueado_motivo text,
  ADD COLUMN IF NOT EXISTS saldo_cuenta_corriente numeric(12,2) DEFAULT 0;
UPDATE public.clientes SET saldo_cuenta_corriente = saldo_deuda WHERE saldo_cuenta_corriente = 0;

-- 2. stock_minimo en productos
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS stock_minimo numeric(12,3) DEFAULT 0;

-- 3. cantidad_entregada en pedido_items
ALTER TABLE public.pedido_items
  ADD COLUMN IF NOT EXISTS cantidad_entregada numeric(12,3);

-- 4. Tabla lotes
CREATE TABLE IF NOT EXISTS public.lotes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  producto_id uuid REFERENCES public.productos(id) ON DELETE CASCADE,
  deposito_id uuid REFERENCES public.depositos(id),
  numero_lote text,
  cantidad numeric(12,3) NOT NULL DEFAULT 0,
  costo_unitario numeric(12,2) DEFAULT 0,
  fecha_fabricacion date,
  fecha_vencimiento date,
  estado text DEFAULT 'activo' CHECK (estado IN ('activo','agotado','vencido')),
  created_at timestamp with time zone DEFAULT now()
);
ALTER TABLE public.lotes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='lotes' AND policyname='lotes_empresa') THEN
    CREATE POLICY lotes_empresa ON public.lotes USING (empresa_id = public.get_empresa_id());
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_lotes_vencimiento ON public.lotes(empresa_id, fecha_vencimiento);

-- 5. Tabla ordenes_compra
CREATE TABLE IF NOT EXISTS public.ordenes_compra (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  proveedor_id uuid,
  numero text,
  estado text DEFAULT 'borrador' CHECK (estado IN ('borrador','enviada','recibida','cancelada')),
  total numeric(12,2) DEFAULT 0,
  notas text,
  fecha_pedido timestamp with time zone DEFAULT now(),
  fecha_recepcion timestamp with time zone,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ordenes_compra_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  orden_id uuid REFERENCES public.ordenes_compra(id) ON DELETE CASCADE,
  producto_id uuid REFERENCES public.productos(id),
  descripcion text,
  cantidad numeric(12,3) NOT NULL,
  precio_unitario numeric(12,2) DEFAULT 0,
  subtotal numeric(12,2) DEFAULT 0
);
ALTER TABLE public.ordenes_compra ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ordenes_compra_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ordenes_compra' AND policyname='ordenes_compra_empresa') THEN
    CREATE POLICY ordenes_compra_empresa ON public.ordenes_compra USING (empresa_id = public.get_empresa_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ordenes_compra_items' AND policyname='oc_items_empresa') THEN
    CREATE POLICY oc_items_empresa ON public.ordenes_compra_items
      USING (orden_id IN (SELECT id FROM public.ordenes_compra WHERE empresa_id = public.get_empresa_id()));
  END IF;
END $$;

-- 6. Tabla notas_internas
CREATE TABLE IF NOT EXISTS public.notas_internas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id uuid REFERENCES public.usuarios(id),
  tabla text NOT NULL,
  entidad_id uuid NOT NULL,
  contenido text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
ALTER TABLE public.notas_internas ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='notas_internas' AND policyname='notas_internas_empresa') THEN
    CREATE POLICY notas_internas_empresa ON public.notas_internas USING (empresa_id = public.get_empresa_id());
  END IF;
END $$;

-- 7. Tabla presupuestos
CREATE TABLE IF NOT EXISTS public.presupuestos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id uuid REFERENCES public.clientes(id),
  vendedor_id uuid REFERENCES public.usuarios(id),
  numero text,
  estado text DEFAULT 'borrador' CHECK (estado IN ('borrador','enviado','aceptado','rechazado','vencido')),
  subtotal numeric(12,2) DEFAULT 0,
  iva_total numeric(12,2) DEFAULT 0,
  total numeric(12,2) DEFAULT 0,
  notas_cliente text,
  notas_admin text,
  fecha_vencimiento date,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.presupuesto_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  presupuesto_id uuid REFERENCES public.presupuestos(id) ON DELETE CASCADE,
  producto_id uuid REFERENCES public.productos(id),
  cantidad numeric(12,3) NOT NULL,
  precio_unitario numeric(12,2) NOT NULL,
  descuento_pct numeric(5,2) DEFAULT 0,
  subtotal numeric(12,2) NOT NULL
);
ALTER TABLE public.presupuestos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presupuesto_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='presupuestos' AND policyname='presupuestos_empresa') THEN
    CREATE POLICY presupuestos_empresa ON public.presupuestos USING (empresa_id = public.get_empresa_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='presupuesto_items' AND policyname='presupuesto_items_empresa') THEN
    CREATE POLICY presupuesto_items_empresa ON public.presupuesto_items
      USING (presupuesto_id IN (SELECT id FROM public.presupuestos WHERE empresa_id = public.get_empresa_id()));
  END IF;
END $$;

-- 8. Contadores de empresa
CREATE TABLE IF NOT EXISTS public.contadores_empresa (
  empresa_id uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  ultimo integer DEFAULT 0,
  PRIMARY KEY (empresa_id, tipo)
);

-- 9. Vista cta_cte con empresa_id (la tabla real no tiene empresa_id)
CREATE OR REPLACE VIEW public.cta_cte_empresa AS
SELECT cc.id, cc.cliente_id, cc.tipo, cc.monto, cc.factura_id,
       cc.cobro_id, cc.saldo, cc.fecha, c.empresa_id
FROM public.cta_cte cc
JOIN public.clientes c ON c.id = cc.cliente_id;

-- 10. RPCs faltantes
CREATE OR REPLACE FUNCTION public.confirmar_pedido(p_pedido_id uuid, p_usuario_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.pedidos SET estado = 'confirmado' WHERE id = p_pedido_id;
  RETURN json_build_object('ok', true, 'pedido_id', p_pedido_id);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $$;

CREATE OR REPLACE FUNCTION public.cancelar_pedido(p_pedido_id uuid, p_usuario_id uuid, p_motivo text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.pedidos
     SET estado = 'cancelado', notas_internas = COALESCE(p_motivo, notas_internas)
   WHERE id = p_pedido_id;
  RETURN json_build_object('ok', true, 'pedido_id', p_pedido_id);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $$;

CREATE OR REPLACE FUNCTION public.marcar_preparado(p_pedido_id uuid, p_usuario_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.pedidos SET estado = 'preparando' WHERE id = p_pedido_id;
  RETURN json_build_object('ok', true, 'pedido_id', p_pedido_id);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $$;

-- 11. Índices útiles
CREATE INDEX IF NOT EXISTS idx_clientes_bloqueado   ON public.clientes(empresa_id, bloqueado) WHERE bloqueado = true;
CREATE INDEX IF NOT EXISTS idx_pedidos_estado_fecha ON public.pedidos(empresa_id, estado, fecha_pedido);
CREATE INDEX IF NOT EXISTS idx_cheques_fecha_vto    ON public.cheques(empresa_id, fecha_vto);

-- FIN MIGRACIÓN 047
