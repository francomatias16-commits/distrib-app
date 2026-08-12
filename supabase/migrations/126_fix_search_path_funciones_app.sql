-- 126_fix_search_path_funciones_app.sql
-- Fija search_path en todas las funciones SECURITY DEFINER de la app
-- para eliminar la vulnerabilidad de search_path mutable.
-- Aplicado en sesión anterior — idempotente.

DO $$
DECLARE
  func_name TEXT;
  func_names TEXT[] := ARRAY[
    'get_empresa_id',
    'saas_confirmar_pago',
    'saas_crear_factura',
    'saas_cron_trial_check',
    'saas_cron_facturacion_mensual',
    'saas_cron_suspender_morosos',
    'saas_suspender_empresa',
    'saas_trigger_nuevo_empresa',
    'saas_generar_numero_factura',
    'saas_facturas_set_updated_at',
    'setup_inicial_empresa',
    'registrar_empresa_saas',
    'calcular_score_cliente',
    'importar_productos_lote',
    'crear_pedido_v2',
    'registrar_cobro_completo',
    'emitir_nota_cta_cte',
    'ajustar_stock_v2'
  ];
BEGIN
  FOREACH func_name IN ARRAY func_names
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER FUNCTION public.%I SET search_path = ''public''',
        func_name
      );
    EXCEPTION WHEN undefined_function THEN
      -- La función no existe en este entorno, ignorar
      NULL;
    WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END;
$$;
