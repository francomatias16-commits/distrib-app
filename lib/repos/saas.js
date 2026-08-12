// lib/repos/saas.js
// Acceso a datos del panel superadmin de suscripciones SaaS. Migrado desde
// lib/handlers/saas.js — mismo criterio que los demás repos: acá solo
// queda I/O contra Supabase (tabla `usuarios`, `saas_config`,
// `eventos_negocio`, y los RPCs de administración SaaS). El gate de
// autorización (superadmin / dueño de la empresa raíz) y el contrato HTTP
// se quedan en el handler.

import { db } from './_db.js';

export async function obtenerPerfilConEmpresa(usuario_id) {
  const { data } = await db
    .from('usuarios')
    .select('id, rol, empresa_id, empresas(nombre)')
    .eq('id', usuario_id)
    .single();
  return data;
}

export async function obtenerSaasConfig(campos) {
  return db
    .from('saas_config')
    .select(campos)
    .eq('id', 1)
    .single();
}

export async function saasDashboardKpisRpc() {
  return db.rpc('saas_dashboard_kpis');
}

export async function saasPanelListarRpc() {
  return db.rpc('saas_panel_listar');
}

export async function saasConfigActualizarRpc(params) {
  return db.rpc('saas_config_actualizar', params);
}

export async function saasConfirmarPagoRpc({ factura_id, admin_user_id }) {
  return db.rpc('saas_confirmar_pago', {
    p_factura_id:    factura_id,
    p_admin_user_id: admin_user_id,
  });
}

export async function saasEmpresaReactivarRpc({ empresa_id, dias_extra }) {
  return db.rpc('saas_empresa_reactivar', {
    p_empresa_id: empresa_id,
    p_dias_extra: dias_extra,
  });
}

export async function saasSuspenderEmpresaRpc(empresa_id) {
  return db.rpc('saas_suspender_empresa', { p_empresa_id: empresa_id });
}

export async function saasEmpresaCancelarRpc(empresa_id) {
  return db.rpc('saas_empresa_cancelar', { p_empresa_id: empresa_id });
}

export async function saasEmpresaCambiarPrecioRpc({ empresa_id, precio }) {
  return db.rpc('saas_empresa_cambiar_precio', {
    p_empresa_id: empresa_id,
    p_precio:     precio,
  });
}

export async function fnResetDemoV2Rpc(empresa_id) {
  return db.rpc('fn_reset_demo_v2', { p_empresa_id: empresa_id ?? null });
}

export async function fnSnapshotDemoV2Rpc(empresa_id) {
  return db.rpc('fn_snapshot_demo_v2', { p_empresa_id: empresa_id ?? null });
}

export async function migracionSuperadminResumenRpc() {
  return db.rpc('migracion_superadmin_resumen');
}

export async function listarEventosNegocio({ empresaId, tipoEvento, estado, offset, limite }) {
  let query = db
    .from('eventos_negocio')
    .select('id, empresa_id, tipo_evento, payload, origen, estado, creado_en, procesado_en, empresas(nombre)', { count: 'exact' })
    .order('creado_en', { ascending: false })
    .range(offset, offset + limite - 1);

  if (empresaId)  query = query.eq('empresa_id', empresaId);
  if (tipoEvento) query = query.eq('tipo_evento', tipoEvento);
  if (estado)     query = query.eq('estado', estado);

  return query;
}
