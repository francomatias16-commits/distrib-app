CREATE FUNCTION auth.email() RETURNS text
CREATE FUNCTION auth.jwt() RETURNS jsonb
CREATE FUNCTION auth.role() RETURNS text
CREATE FUNCTION auth.uid() RETURNS uuid
CREATE FUNCTION extensions.grant_pg_cron_access() RETURNS event_trigger
CREATE FUNCTION extensions.grant_pg_graphql_access() RETURNS event_trigger
CREATE FUNCTION extensions.grant_pg_net_access() RETURNS event_trigger
CREATE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger
CREATE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger
CREATE FUNCTION extensions.set_graphql_placeholder() RETURNS event_trigger
CREATE FUNCTION graphql_public.graphql("operationName" text DEFAULT NULL::text, query text DEFAULT NULL::text, variables jsonb DEFAULT NULL::jsonb, extensions jsonb DEFAULT NULL::jsonb) RETURNS jsonb
CREATE FUNCTION pgbouncer.get_auth(p_usename text) RETURNS TABLE(username text, password text)
CREATE FUNCTION public._audit_productos_precio() RETURNS trigger
CREATE FUNCTION public._notif_push_async(p_empresa_id uuid, p_tipo text, p_titulo text, p_cuerpo text, p_datos jsonb DEFAULT '{}'::jsonb) RETURNS void
CREATE FUNCTION public._trigger_notif_nuevo_pedido() RETURNS trigger
CREATE FUNCTION public._trigger_notif_stock_critico() RETURNS trigger
CREATE FUNCTION public.acreditar_puntos(p_empresa_id uuid, p_cliente_id uuid, p_puntos integer, p_concepto text DEFAULT 'Acreditación manual'::text, p_ref_tipo text DEFAULT 'manual'::text, p_usuario_id uuid DEFAULT NULL::uuid, p_usuario_nombre text DEFAULT NULL::text) RETURNS json
CREATE FUNCTION public.analizar_stock_autonomo(p_empresa_id uuid) RETURNS TABLE(producto_id uuid, nombre text, stock_actual numeric, velocidad_dia numeric, dias_restantes numeric, lead_time integer, necesita_reponer boolean, cantidad_sugerida numeric, proveedor_id uuid)
CREATE FUNCTION public.auth_empresa_id() RETURNS uuid
CREATE FUNCTION public.auth_usuario_id() RETURNS uuid
CREATE FUNCTION public.auth_usuario_rol() RETURNS text
CREATE FUNCTION public.calcular_ciclos_cliente(p_empresa_id uuid) RETURNS void
CREATE FUNCTION public.calcular_puntos_compra(p_cliente_id uuid, p_monto numeric, p_empresa_id uuid) RETURNS numeric
CREATE FUNCTION public.calcular_score_cliente(p_cliente_id uuid, p_empresa_id uuid, p_motivo text DEFAULT 'recalculo'::text) RETURNS numeric
CREATE FUNCTION public.cancelar_pedido(p_pedido_id uuid, p_usuario_id uuid, p_motivo text DEFAULT NULL::text) RETURNS json
CREATE FUNCTION public.canjear_puntos(p_empresa_id uuid, p_cliente_id uuid, p_puntos integer, p_concepto text DEFAULT 'Canje manual'::text, p_ref_tipo text DEFAULT 'manual'::text, p_usuario_id uuid DEFAULT NULL::uuid, p_usuario_nombre text DEFAULT NULL::text) RETURNS json
CREATE FUNCTION public.confirmar_despacho_stock(p_producto_id uuid, p_deposito_id uuid, p_cantidad numeric) RETURNS void
CREATE FUNCTION public.confirmar_pedido(p_pedido_id uuid, p_usuario_id uuid) RETURNS json
CREATE FUNCTION public.crear_pedido_cliente(p_empresa_id uuid, p_cliente_id uuid, p_vendedor_id uuid, p_items jsonb, p_subtotal numeric, p_iva_total numeric, p_total numeric, p_notas_cliente text DEFAULT NULL::text, p_fecha_entrega date DEFAULT NULL::date) RETURNS json
CREATE FUNCTION public.es_admin() RETURNS boolean
CREATE FUNCTION public.es_chofer() RETURNS boolean
CREATE FUNCTION public.fn_audit_generic() RETURNS trigger
CREATE FUNCTION public.generar_pedidos_sugeridos(p_empresa_id uuid) RETURNS integer
CREATE FUNCTION public.get_empresa_id() RETURNS uuid
CREATE FUNCTION public.get_rol_usuario() RETURNS public.rol_usuario
CREATE FUNCTION public.importar_productos_lote(p_empresa_id uuid, p_filas jsonb, p_lista_precio_id uuid DEFAULT NULL::uuid, p_lista_nombre text DEFAULT NULL::text, p_deposito_id uuid DEFAULT NULL::uuid) RETURNS jsonb
CREATE FUNCTION public.incrementar_stock_reservado(p_producto_id uuid, p_deposito_id uuid, p_cantidad numeric) RETURNS void
CREATE FUNCTION public.liberar_stock_reservado(p_producto_id uuid, p_deposito_id uuid, p_cantidad numeric) RETURNS void
CREATE FUNCTION public.marcar_preparado(p_pedido_id uuid, p_usuario_id uuid) RETURNS json
CREATE FUNCTION public.registrar_movimiento_puntos(p_cliente_id uuid, p_empresa_id uuid, p_tipo character varying, p_cantidad numeric, p_motivo text DEFAULT NULL::text, p_referencia_id uuid DEFAULT NULL::uuid) RETURNS uuid
CREATE FUNCTION public.trigger_crear_saldo_puntos() RETURNS trigger
CREATE FUNCTION public.trigger_force_empresa_id_etapa7() RETURNS trigger
CREATE FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer DEFAULT (1024 * 1024)) RETURNS SETOF realtime.wal_rls
CREATE FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text DEFAULT 'ROW'::text) RETURNS void
CREATE FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) RETURNS text
CREATE FUNCTION realtime."cast"(val text, type_ regtype) RETURNS jsonb
CREATE FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) RETURNS boolean
CREATE FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) RETURNS boolean
CREATE FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) RETURNS TABLE(wal jsonb, is_rls_enabled boolean, subscription_ids uuid[], errors text[], slot_changes_count bigint)
CREATE FUNCTION realtime.quote_wal2json(entity regclass) RETURNS text
CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void
CREATE FUNCTION realtime.send_binary(payload bytea, event text, topic text, private boolean DEFAULT true) RETURNS void
CREATE FUNCTION realtime.subscription_check_filters() RETURNS trigger
CREATE FUNCTION realtime.to_regrole(role_name text) RETURNS regrole
CREATE FUNCTION realtime.topic() RETURNS text
CREATE FUNCTION realtime.wal2json_escape_identifier(name text) RETURNS text
CREATE FUNCTION storage.allow_any_operation(expected_operations text[]) RETURNS boolean
CREATE FUNCTION storage.allow_only_operation(expected_operation text) RETURNS boolean
CREATE FUNCTION storage.can_insert_object(bucketid text, name text, owner uuid, metadata jsonb) RETURNS void
CREATE FUNCTION storage.enforce_bucket_name_length() RETURNS trigger
CREATE FUNCTION storage.extension(name text) RETURNS text
CREATE FUNCTION storage.filename(name text) RETURNS text
CREATE FUNCTION storage.foldername(name text) RETURNS text[]
CREATE FUNCTION storage.get_common_prefix(p_key text, p_prefix text, p_delimiter text) RETURNS text
CREATE FUNCTION storage.get_size_by_bucket() RETURNS TABLE(size bigint, bucket_id text)
CREATE FUNCTION storage.list_multipart_uploads_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, next_key_token text DEFAULT ''::text, next_upload_token text DEFAULT ''::text) RETURNS TABLE(key text, id text, created_at timestamp with time zone)
CREATE FUNCTION storage.list_objects_with_delimiter(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, start_after text DEFAULT ''::text, next_token text DEFAULT ''::text, sort_order text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, metadata jsonb, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone)
CREATE FUNCTION storage.operation() RETURNS text
CREATE FUNCTION storage.protect_delete() RETURNS trigger
CREATE FUNCTION storage.search(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
CREATE FUNCTION storage.search_by_timestamp(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) RETURNS TABLE(key text, name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
CREATE FUNCTION storage.search_v2(prefix text, bucket_name text, limits integer DEFAULT 100, levels integer DEFAULT 1, start_after text DEFAULT ''::text, sort_order text DEFAULT 'asc'::text, sort_column text DEFAULT 'name'::text, sort_column_after text DEFAULT ''::text) RETURNS TABLE(key text, name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
CREATE FUNCTION storage.update_updated_at_column() RETURNS trigger
