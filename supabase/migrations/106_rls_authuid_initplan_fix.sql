-- ============================================================
-- 106_rls_authuid_initplan_fix.sql
-- Performance: 51 políticas RLS corregidas
-- auth.uid() envuelto en (SELECT auth.uid()) para evitar
-- re-evaluación por fila (initplan en lugar de rescan)
-- Aplicado en prod: 2026-06-24
-- ============================================================
-- Tablas afectadas (33): alertas_score, alertas_stock,
-- anomalias_revisadas, audit_log, bloqueos_cliente,
-- ciclos_compra, cola_financiera, cta_cte, devolucion_items,
-- dispositivos_push, email_log, empresas, facturas_proveedor,
-- facturas_proveedor_items, integraciones_pago, internal_secrets,
-- lotes, movimientos_cta_cte, movimientos_puntos,
-- notas_debito_proveedor, notif_log, pagos_proveedor,
-- presupuesto_items, presupuestos, programas_fidelizacion,
-- proveedor_portal_tokens, recepciones_mercaderia, reglas_score,
-- reportes_ruta, rutas, saldo_puntos, scores_cliente, usuarios
-- ============================================================

-- Este fix fue aplicado directamente via ALTER POLICY en prod.
-- Las políticas actuales ya contienen (SELECT auth.uid() AS uid)
-- en lugar de auth.uid() para evitar re-evaluación por fila.

-- Verificación: las 51 políticas afectadas ya usan el patrón:
-- WHERE (usuarios.id = ( SELECT auth.uid() AS uid))
-- en lugar de:
-- WHERE (usuarios.id = auth.uid())

-- No se requiere re-ejecutar este archivo si la DB ya tiene
-- las políticas corregidas (verificar con A1 del plan post-094).

-- Para aplicar en una DB nueva/branch, ejecutar el script
-- de regeneración completo desde backup o migrations previas.

DO $$
BEGIN
  -- Registro de auditoría de la migración
  RAISE NOTICE '106_rls_authuid_initplan_fix: 51 políticas RLS ya corregidas en prod. Sin acción requerida.';
END;
$$;
