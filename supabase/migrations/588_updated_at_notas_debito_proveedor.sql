-- 588_updated_at_notas_debito_proveedor.sql
-- Cuarto lote de la regla "ítem modificado sube al tope".
--
-- notas_debito_proveedor: columna updated_at ya existía, faltaba el
-- trigger. No tiene un listado propio para reordenar (se consulta
-- puntualmente por devolucion_id, sin paginación ni ORDER BY relevante),
-- pero el registro sí se modifica después de creado (estado -> anulada),
-- así que se agrega el trigger por consistencia con el resto — mismo
-- criterio que se usó con entregas/pagos_proveedor en el lote anterior.
--
-- Relevamiento de esta tanda (combos, saas_facturas, cobros_qr_pos,
-- conciliacion_bancaria_movimientos, gastos_generales,
-- notas_debito_proveedor, bloqueos_cliente, ciclos_compra, saldo_puntos,
-- programas_fidelizacion, config_etiquetas, integraciones_pago):
-- todas ya tenían la columna updated_at. Del resto, se dejan afuera por
-- ser génuinamente logs/listas con orden de negocio o configuración sin
-- listado (mismo criterio que movimientos_stock/lotes/cheques/cta_cte):
-- bloqueos_cliente (historial de eventos), ciclos_compra (por próximo
-- pedido), conciliacion_bancaria_movimientos (por fecha del extracto),
-- saldo_puntos (ranking por puntos), integraciones_pago/config_etiquetas/
-- programas_fidelizacion (configuración por empresa, sin listado).
--
-- gastos_generales ya tenía columna + trigger de antes; solo faltaba
-- corregir el ORDER BY en el repo (lib/repos/gastos-generales.js), sin
-- cambios de base — se corrige en el mismo commit que esta migración.
--
-- Reutiliza la función genérica set_updated_at() (existe desde
-- 006_logistica.sql, search_path fijado en 126_fix_search_path).

DROP TRIGGER IF EXISTS trg_notas_debito_proveedor_updated_at ON public.notas_debito_proveedor;
CREATE TRIGGER trg_notas_debito_proveedor_updated_at
  BEFORE UPDATE ON public.notas_debito_proveedor
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Registro manual de versionado (mismo patrón que el resto del proyecto)
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '588_updated_at_notas_debito_proveedor.sql',
  '588',
  'claude-session',
  'Cuarto lote de la regla "ítem modificado sube al tope": trigger set_updated_at() faltante en notas_debito_proveedor (columna ya existía, sin listado propio, se agrega por consistencia). Relevada tanda de 12 tablas (combos, saas_facturas, cobros_qr_pos, conciliacion_bancaria_movimientos, gastos_generales, notas_debito_proveedor, bloqueos_cliente, ciclos_compra, saldo_puntos, programas_fidelizacion, config_etiquetas, integraciones_pago); el resto queda afuera por ser logs/orden de negocio/configuración sin listado. gastos_generales ya tenía trigger, solo se corrigió el ORDER BY en el repo.'
);
