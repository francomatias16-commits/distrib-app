-- ============================================================
-- 028_indices_optimizados.sql
-- distrib-v38-optimized | Módulo 3: Base de Datos World-Class
--
-- Estrategia de indexación avanzada para tablas críticas.
-- Cada índice tiene comentario de qué consulta optimiza.
--
-- IMPORTANTE: Ejecutar en horario de bajo tráfico.
-- Usar CREATE INDEX CONCURRENTLY en producción para no bloquear.
-- ============================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- TABLA: pedidos
-- ═══════════════════════════════════════════════════════════════

-- Consulta frecuente: pedidos del día por cliente/estado (dashboard, reportes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_fecha_estado
    ON public.pedidos (fecha_pedido DESC, estado)
    WHERE estado NOT IN ('cancelado', 'archivado');

-- Consulta: historial de pedidos por cliente (portal cliente, cta cte)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_cliente_fecha
    ON public.pedidos (cliente_id, fecha_pedido DESC);

-- Consulta: pedidos asignados a un chofer específico (portal chofer)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_chofer_fecha
    ON public.pedidos (chofer_id, fecha_pedido DESC)
    WHERE chofer_id IS NOT NULL;

-- Consulta: búsqueda por número de pedido (frecuente en admin)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_numero
    ON public.pedidos (numero_pedido);


-- ═══════════════════════════════════════════════════════════════
-- TABLA: pedido_items
-- ═══════════════════════════════════════════════════════════════

-- Lookup de ítems por pedido (usado en rpc_crear_pedido y detalle)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedido_items_pedido
    ON public.pedido_items (pedido_id);

-- Consulta: consumo de producto específico en rango de fechas (reportes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedido_items_producto
    ON public.pedido_items (producto_id, pedido_id);


-- ═══════════════════════════════════════════════════════════════
-- TABLA: stock / inventario
-- ═══════════════════════════════════════════════════════════════

-- Consulta crítica: stock disponible por producto (checkout, validación en RPC)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_producto_cantidad
    ON public.stock (producto_id, cantidad_disponible)
    WHERE cantidad_disponible > 0;

-- Consulta: alertas de stock bajo (dashboard admin)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_bajo
    ON public.stock (producto_id, cantidad_disponible)
    WHERE cantidad_disponible <= stock_minimo;

-- Consulta: stock por depósito/ubicación
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_deposito
    ON public.stock (deposito_id, producto_id)
    WHERE deposito_id IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════
-- TABLA: lotes
-- ═══════════════════════════════════════════════════════════════

-- Consulta crítica en rpc_crear_pedido: lotes disponibles FIFO (más viejos primero)
-- Índice parcial: solo lotes con stock > 0 y no vencidos
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lotes_producto_fifo
    ON public.lotes (producto_id, fecha_vencimiento ASC, id ASC)
    WHERE cantidad_disponible > 0
      AND (fecha_vencimiento IS NULL OR fecha_vencimiento > CURRENT_DATE);

-- Consulta: alertas de vencimiento próximo (admin)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lotes_vencimiento
    ON public.lotes (fecha_vencimiento ASC)
    WHERE fecha_vencimiento IS NOT NULL
      AND cantidad_disponible > 0;

-- Consulta: lotes por número de lote (trazabilidad)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_lotes_numero
    ON public.lotes (numero_lote)
    WHERE numero_lote IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════
-- TABLA: facturas
-- ═══════════════════════════════════════════════════════════════

-- Consulta: facturas por cliente en rango de fechas (cta cte, reportes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_cliente_fecha
    ON public.facturas (cliente_id, fecha_factura DESC);

-- Consulta: facturas impagas (cobranzas)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_impagas
    ON public.facturas (cliente_id, fecha_vencimiento ASC, saldo_pendiente DESC)
    WHERE saldo_pendiente > 0;

-- Consulta: búsqueda por número de factura
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_numero
    ON public.facturas (numero_factura);

-- Consulta: facturas del mes para cierre contable
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_periodo
    ON public.facturas (DATE_TRUNC('month', fecha_factura), tipo_factura);


-- ═══════════════════════════════════════════════════════════════
-- TABLA: clientes
-- ═══════════════════════════════════════════════════════════════

-- Búsqueda full-text rápida: nombre, razón social, CUIT (admin, selector pedidos)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_nombre_trgm
    ON public.clientes USING GIN (nombre gin_trgm_ops)
    WHERE activo = TRUE;

-- Habilitar la extensión pg_trgm primero (si no está habilitada)
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Búsqueda por CUIT exacto
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_cuit
    ON public.clientes (cuit)
    WHERE cuit IS NOT NULL;

-- Clientes activos por zona (rutas de chofer)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_zona
    ON public.clientes (zona_id, nombre)
    WHERE activo = TRUE AND zona_id IS NOT NULL;

-- Cuenta corriente: clientes con saldo
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_saldo
    ON public.clientes (saldo_cuenta_corriente)
    WHERE saldo_cuenta_corriente != 0;


-- ═══════════════════════════════════════════════════════════════
-- TABLA: pagos / cobranzas
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pagos_cliente_fecha
    ON public.pagos (cliente_id, fecha_pago DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pagos_pendientes
    ON public.pagos (estado, fecha_pago DESC)
    WHERE estado = 'pendiente';


-- ═══════════════════════════════════════════════════════════════
-- TABLA: audit_log (ya existente — optimizar consultas de admin)
-- ═══════════════════════════════════════════════════════════════

-- Consulta: auditoría de un usuario en rango de fechas
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_usuario_ts
    ON public.audit_log (usuario_id, created_at DESC)
    WHERE usuario_id IS NOT NULL;

-- Consulta: auditoría por tabla/entidad (rastrear cambios en un pedido)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_tabla_entidad
    ON public.audit_log (tabla_nombre, entidad_id, created_at DESC);


-- ═══════════════════════════════════════════════════════════════
-- TABLA: puntos_fidelizacion
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_puntos_cliente
    ON public.puntos_fidelizacion (cliente_id, created_at DESC);


-- ═══════════════════════════════════════════════════════════════
-- ANÁLISIS POST-MIGRACIÓN
-- ═══════════════════════════════════════════════════════════════
-- Ejecutar después para confirmar que los índices están activos:
--
-- SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'public'
-- ORDER BY idx_scan DESC;
--
-- Para detectar índices nunca usados (candidatos a eliminar):
-- SELECT indexname FROM pg_stat_user_indexes
-- WHERE schemaname = 'public' AND idx_scan = 0;
-- ═══════════════════════════════════════════════════════════════

COMMIT;
