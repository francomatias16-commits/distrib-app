-- ═══════════════════════════════════════════════════════════════════════════
-- 052_saneamiento_final_v54.sql
-- Objetivo: Unificar esquema real con código v54 y corregir inconsistencias críticas.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. UNIFICACIÓN DE TABLA CHEQUES
-- El backup tiene fecha_vto y vencimiento. El código prefiere vencimiento (según busqueda.js).
-- Sincronizamos y eliminamos la redundancia.
UPDATE public.cheques SET vencimiento = fecha_vto WHERE vencimiento IS NULL;
UPDATE public.cheques SET fecha_vto = vencimiento WHERE fecha_vto IS NULL;
-- Mantenemos ambas por compatibilidad pero aseguramos que sean idénticas.

-- 2. UNIFICACIÓN DE TABLA CTA_CTE
-- El código usa 'monto' y 'importe' indistintamente. Estandarizamos a 'monto' (real en backup).
-- Si existe código viejo que use 'importe', el backend debe ser corregido.
-- Aseguramos que existan las columnas de descripción para auditoría.
ALTER TABLE public.cta_cte ADD COLUMN IF NOT EXISTS descripcion TEXT;

-- 3. TABLA USUARIOS: Relación con Clientes para Notificaciones
-- Necesario para que enviarPush(usuario_id) funcione desde el contexto de un cliente.
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL;

-- 4. TABLA DISPOSITIVOS_PUSH: Soporte para Web Push y FCM
-- El backup tiene token_push (FCM). El panel de automatización busca endpoint/auth (Web Push).
-- Agregamos las columnas faltantes para que el Panel de Automatización no falle.
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS endpoint TEXT;
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS p256dh TEXT;
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS auth TEXT;
-- Crear índice único para evitar duplicados de suscripciones web
DROP INDEX IF EXISTS idx_dispositivos_push_endpoint;
CREATE UNIQUE INDEX idx_dispositivos_push_endpoint ON public.dispositivos_push(endpoint) WHERE (endpoint IS NOT NULL);

-- 5. CORRECCIÓN DE RPC: generar_pedidos_sugeridos
-- Cambiar listas_precios_detalle por precios_items (nombre real).
-- Cambiar c.vendedor_id por p.vendedor_id si es necesario (en el loop).
CREATE OR REPLACE FUNCTION public.generar_pedidos_sugeridos(p_empresa_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ciclo    RECORD;
  v_count    INT := 0;
  v_pedido   UUID;
  v_vendedor UUID;
BEGIN
  -- Recalcular ciclos primero
  PERFORM public.calcular_ciclos_cliente(p_empresa_id);

  -- Generar pedidos sugeridos para ciclos que vencen en próximos 3 días
  FOR v_ciclo IN
    SELECT cc.*, c.id as cid
    FROM public.ciclos_compra cc
    JOIN public.clientes c ON c.id = cc.cliente_id
    WHERE cc.empresa_id = p_empresa_id
      AND cc.activo = true
      AND cc.proximo_pedido <= CURRENT_DATE + INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.pedidos p
        WHERE p.cliente_id = cc.cliente_id
          AND p.estado = 'sugerido'
          AND p.ciclo_referencia_id = cc.id
      )
  LOOP
    -- Obtener vendedor asignado al cliente o el primero de la empresa
    SELECT vendedor_id INTO v_vendedor FROM public.clientes WHERE id = v_ciclo.cid;
    IF v_vendedor IS NULL THEN
        SELECT vendedor_id INTO v_vendedor FROM public.pedidos WHERE cliente_id = v_ciclo.cid ORDER BY created_at DESC LIMIT 1;
    END IF;
    IF v_vendedor IS NULL THEN
        SELECT id INTO v_vendedor FROM public.usuarios WHERE empresa_id = p_empresa_id AND rol = 'vendedor' LIMIT 1;
    END IF;

    -- Crear pedido sugerido
    INSERT INTO public.pedidos (
      empresa_id, cliente_id, vendedor_id, estado,
      generado_automatico, confianza_sugerencia, ciclo_referencia_id,
      fecha_pedido, total
    ) VALUES (
      p_empresa_id, v_ciclo.cliente_id, v_vendedor, 'sugerido',
      true, v_ciclo.confianza, v_ciclo.id,
      now(), 0
    ) RETURNING id INTO v_pedido;

    -- Agregar item sugerido (usando precios_items en lugar de listas_precios_detalle)
    INSERT INTO public.pedido_items (pedido_id, producto_id, cantidad, precio_unitario, subtotal)
    SELECT v_pedido, v_ciclo.producto_id, v_ciclo.cantidad_promedio,
           COALESCE(pi.precio, pr.precio_base, 0),
           (v_ciclo.cantidad_promedio * COALESCE(pi.precio, pr.precio_base, 0))
    FROM public.productos pr
    LEFT JOIN public.precios_items pi
      ON pi.producto_id = pr.id
      AND pi.lista_id = (
        SELECT lista_precio_id FROM public.clientes WHERE id = v_ciclo.cliente_id
      )
    WHERE pr.id = v_ciclo.producto_id;

    -- Actualizar total del pedido
    UPDATE public.pedidos SET total = (
      SELECT COALESCE(SUM(subtotal), 0) FROM public.pedido_items WHERE pedido_id = v_pedido
    ) WHERE id = v_pedido;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 6. TABLA FACTURAS: Asegurar columnas para el Cierre Financiero
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS notif_15d_enviada BOOLEAN DEFAULT false;
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE;

-- 7. TABLA COLA_FINANCIERA: Crear si no existe (v54 depende de ella)
CREATE TABLE IF NOT EXISTS public.cola_financiera (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL, -- 'facturar', 'notif_vencimiento', 'bloquear'
    estado TEXT DEFAULT 'pendiente',
    payload JSONB DEFAULT '{}',
    referencia_id UUID,
    intentos INTEGER DEFAULT 0,
    error_msg TEXT,
    proximo_intento TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Tablas de Órdenes de Compra (Sincronizadas con REQ-01 y stock-auto.js)
CREATE TABLE IF NOT EXISTS public.ordenes_compra (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    proveedor_id UUID NOT NULL REFERENCES public.proveedores(id),
    numero TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'borrador' 
      CHECK (estado IN ('borrador','enviada','confirmada','recibida_parcial','recibida','cancelada','pendiente_aprobacion')),
    fecha_pedido DATE NOT NULL DEFAULT CURRENT_DATE,
    fecha_esperada DATE,
    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    iva_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,
    notas TEXT,
    auto_generada BOOLEAN DEFAULT false,
    velocidad_venta_snapshot JSONB,
    created_by UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ordenes_compra_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    orden_compra_id UUID NOT NULL REFERENCES public.ordenes_compra(id) ON DELETE CASCADE,
    producto_id UUID REFERENCES public.productos(id) ON DELETE SET NULL,
    descripcion TEXT,
    cantidad NUMERIC(12,3) NOT NULL,
    precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0, -- alias de precio_costo para compatibilidad
    iva_pct NUMERIC(5,2) NOT NULL DEFAULT 21,
    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    cantidad_recibida NUMERIC(12,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS para Órdenes de Compra
ALTER TABLE public.ordenes_compra ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ordenes_compra_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oc_select_v54 ON public.ordenes_compra;
CREATE POLICY oc_select_v54 ON public.ordenes_compra
  FOR SELECT USING (empresa_id = public.get_empresa_id());

DROP POLICY IF EXISTS oc_modify_v54 ON public.ordenes_compra;
CREATE POLICY oc_modify_v54 ON public.ordenes_compra
  FOR ALL USING (empresa_id = public.get_empresa_id() AND public.get_rol_usuario() IN ('dueno','admin','depositero'));

-- 9. Índices y Optimización
CREATE INDEX IF NOT EXISTS idx_cta_cte_cliente_fecha ON public.cta_cte(cliente_id, fecha);
CREATE INDEX IF NOT EXISTS idx_pedidos_empresa_estado ON public.pedidos(empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_lotes_vencimiento ON public.lotes(fecha_vencimiento) WHERE cantidad > 0;
CREATE INDEX IF NOT EXISTS idx_dispositivos_push_usuario ON public.dispositivos_push(usuario_id) WHERE activo = true;
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_empresa ON public.ordenes_compra(empresa_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_proveedor ON public.ordenes_compra(proveedor_id);

-- 10. REPARACIÓN DE PILOTO AUTOMÁTICO (Corrección de nombres de tablas y columnas)
CREATE OR REPLACE FUNCTION public.generar_pedidos_sugeridos(p_empresa_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_rec       RECORD;
  v_pedido_id UUID;
  v_contador  INT := 0;
  v_existe    BOOLEAN;
BEGIN
  PERFORM public.calcular_ciclos_cliente(p_empresa_id);

  FOR v_rec IN
    SELECT cc.id AS ciclo_id, cc.cliente_id, cc.producto_id,
           cc.cantidad_promedio, cc.confianza, pr.precio AS precio_unitario
    FROM public.ciclos_compra cc
    JOIN public.clientes c ON c.id = cc.cliente_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        (SELECT pi2.precio FROM public.precios_items pi2
         WHERE pi2.producto_id = cc.producto_id AND pi2.lista_id = c.lista_precio_id LIMIT 1),
        (SELECT precio_base FROM public.productos WHERE id = cc.producto_id)
      ) AS precio
    ) pr ON true
    WHERE cc.empresa_id = p_empresa_id
      AND cc.activo = true
      AND cc.confianza >= 0.4
      AND cc.proximo_pedido BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '2 days'
  LOOP
    -- Verificar si ya existe sugerido reciente
    SELECT EXISTS(
      SELECT 1 FROM public.pedidos p JOIN public.pedido_items pi2 ON pi2.pedido_id = p.id
      WHERE p.cliente_id = v_rec.cliente_id AND p.empresa_id = p_empresa_id
        AND p.estado = 'sugerido' AND pi2.producto_id = v_rec.producto_id
        AND p.created_at >= now() - INTERVAL '3 days'
    ) INTO v_existe;
    IF v_existe THEN CONTINUE; END IF;

    -- Verificar stock disponible
    IF NOT EXISTS (
      SELECT 1 FROM public.stock s WHERE s.producto_id = v_rec.producto_id
        AND (s.cantidad - s.cantidad_reservada) >= v_rec.cantidad_promedio
    ) THEN CONTINUE; END IF;

    INSERT INTO public.pedidos (empresa_id, cliente_id, estado, generado_automatico,
      confianza_sugerencia, ciclo_referencia_id, subtotal, total)
    VALUES (p_empresa_id, v_rec.cliente_id, 'sugerido', true, v_rec.confianza, v_rec.ciclo_id,
      v_rec.cantidad_promedio * v_rec.precio_unitario,
      v_rec.cantidad_promedio * v_rec.precio_unitario)
    RETURNING id INTO v_pedido_id;

    INSERT INTO public.pedido_items (pedido_id, producto_id, cantidad, precio_unitario, subtotal)
    VALUES (v_pedido_id, v_rec.producto_id, v_rec.cantidad_promedio, v_rec.precio_unitario,
      v_rec.cantidad_promedio * v_rec.precio_unitario);

    v_contador := v_contador + 1;
  END LOOP;
  RETURN v_contador;
END;
$$;

-- 11. REPARACIÓN DE SCORE (Cálculo dinámico de saldo)
CREATE OR REPLACE FUNCTION public.calcular_score_cliente(
  p_cliente_id UUID, p_empresa_id UUID, p_motivo TEXT DEFAULT 'recalculo'
)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pagos      NUMERIC := 0;
  v_frecuencia NUMERIC := 0;
  v_deuda      NUMERIC := 0;
  v_devol      NUMERIC := 0;
  v_total      NUMERIC := 0;
  v_anterior   NUMERIC;
  v_categoria  TEXT;
  v_reglas     RECORD;
  v_dias_prom  NUMERIC;
  v_deuda_act  NUMERIC;
  v_lim_cred   NUMERIC;
  v_pct_devol  NUMERIC;
  v_pedidos90  INT;
  v_nuevos_dias INT;
BEGIN
  -- Componente Pagos (0-40 pts)
  SELECT AVG(EXTRACT(EPOCH FROM (co.fecha - f.fecha_vencimiento)) / 86400.0) INTO v_dias_prom
  FROM public.cobros co
  JOIN public.facturas f ON f.pedido_id = (SELECT pedido_id FROM public.cta_cte WHERE cobro_id = co.id LIMIT 1)
  WHERE co.cliente_id = p_cliente_id AND co.fecha >= now() - INTERVAL '90 days';

  v_pagos := CASE
    WHEN v_dias_prom IS NULL  THEN 20
    WHEN v_dias_prom <= -5    THEN 40
    WHEN v_dias_prom <= 0     THEN 35
    WHEN v_dias_prom <= 7     THEN 25
    WHEN v_dias_prom <= 15    THEN 15
    WHEN v_dias_prom <= 30    THEN 5
    ELSE 0 END;

  -- Componente Frecuencia (0-25 pts)
  SELECT COUNT(*) INTO v_pedidos90 FROM public.pedidos
  WHERE cliente_id = p_cliente_id AND empresa_id = p_empresa_id
    AND estado IN ('entregado','despachado','confirmado')
    AND fecha_pedido >= now() - INTERVAL '90 days';
  v_frecuencia := LEAST(25, v_pedidos90 * 3);

  -- Componente Deuda (0-20 pts) - USANDO CÁLCULO DINÁMICO DE SALDO
  SELECT COALESCE(SUM(CASE WHEN tipo = 'debito' THEN monto ELSE -monto END), 0) INTO v_deuda_act 
  FROM public.cta_cte WHERE cliente_id = p_cliente_id;
  
  SELECT COALESCE(limite_credito, 0) INTO v_lim_cred FROM public.clientes WHERE id = p_cliente_id;

  v_deuda := CASE
    WHEN v_lim_cred = 0                          THEN 10
    WHEN v_deuda_act <= 0                        THEN 20
    WHEN (v_deuda_act / v_lim_cred) <= 0.3      THEN 18
    WHEN (v_deuda_act / v_lim_cred) <= 0.6      THEN 12
    WHEN (v_deuda_act / v_lim_cred) <= 0.9      THEN 6
    ELSE 0 END;

  -- Componente Devoluciones (0-15 pts)
  SELECT CASE WHEN SUM(pi2.cantidad) > 0
    THEN COALESCE(SUM(CASE WHEN e.estado = 'devolucion' THEN pi2.cantidad ELSE 0 END) / SUM(pi2.cantidad), 0) * 100
    ELSE 0 END INTO v_pct_devol
  FROM public.pedidos p
  JOIN public.pedido_items pi2 ON pi2.pedido_id = p.id
  LEFT JOIN public.entregas e ON e.pedido_id = p.id
  WHERE p.cliente_id = p_cliente_id AND p.empresa_id = p_empresa_id
    AND p.fecha_pedido >= now() - INTERVAL '90 days';

  v_devol := CASE
    WHEN v_pct_devol = 0   THEN 15
    WHEN v_pct_devol < 5   THEN 12
    WHEN v_pct_devol < 10  THEN 8
    WHEN v_pct_devol < 20  THEN 4
    ELSE 0 END;

  v_total := v_pagos + v_frecuencia + v_deuda + v_devol;

  -- Guardar e Historial
  INSERT INTO public.scores_cliente (cliente_id, empresa_id, score, score_pagos, score_frecuencia, score_deuda, score_devolucion, motivo_cambio)
  VALUES (p_cliente_id, p_empresa_id, v_total, v_pagos, v_frecuencia, v_deuda, v_devol, p_motivo);

  -- Categoría y Crédito
  SELECT * INTO v_reglas FROM public.reglas_score WHERE empresa_id = p_empresa_id;
  v_categoria := CASE
    WHEN v_total >= COALESCE(v_reglas.umbral_premium, 80) THEN 'premium'
    WHEN v_total >= COALESCE(v_reglas.umbral_bueno,   65) THEN 'bueno'
    WHEN v_total >= COALESCE(v_reglas.umbral_normal,  45) THEN 'normal'
    WHEN v_total >= COALESCE(v_reglas.umbral_riesgo,  30) THEN 'riesgo'
    ELSE 'bloqueado' END;

  v_nuevos_dias := COALESCE(CASE v_categoria
    WHEN 'premium'  THEN v_reglas.dias_cred_premium
    WHEN 'bueno'    THEN v_reglas.dias_cred_bueno
    WHEN 'normal'   THEN v_reglas.dias_cred_normal
    WHEN 'riesgo'   THEN v_reglas.dias_cred_riesgo
    ELSE 0 END, 0);

  UPDATE public.clientes SET
    score_actual = v_total, score_categoria = v_categoria, score_actualizado = now(),
    dias_credito = v_nuevos_dias, bloqueado = (v_categoria = 'bloqueado'),
    bloqueado_motivo = CASE WHEN v_categoria = 'bloqueado' THEN 'Score crediticio insuficiente (' || v_total::INT || '/100)' ELSE NULL END
  WHERE id = p_cliente_id;

  RETURN v_total;
END;
$$;

COMMIT;
