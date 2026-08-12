// lib/repos/auditoria.js
// Acceso a datos de la Auditoría Predictiva de Anomalías Internas (Innovación
// #6). Migrado desde lib/handlers/auditoria.js — mismo criterio que los
// demás repos: acá solo queda I/O contra Supabase (tablas `empresas`,
// `anomalias_revisadas` y el RPC detectar_anomalias_auditoria). El armado
// del push, la idempotencia por ventana de días y el contrato HTTP se
// quedan en el handler.

import { db } from './_db.js';

export async function listarEmpresasActivas() {
  const { data } = await db.from('empresas').select('id').eq('activa', true);
  return data || [];
}

export async function detectarAnomaliasRpc(empresa_id, dias_lookback) {
  return db.rpc('detectar_anomalias_auditoria', {
    p_empresa_id: empresa_id,
    p_dias_lookback: dias_lookback,
  });
}

export async function upsertAnomaliaRevisada({ empresa_id, tipo_anomalia, usuario_id, entidad_id, resuelto_por, notas }) {
  const { error } = await db.from('anomalias_revisadas').upsert({
    empresa_id,
    tipo_anomalia,
    usuario_id: usuario_id || null,
    entidad_id: entidad_id || null,
    resuelto_por,
    notas: notas || null,
  }, {
    onConflict: 'empresa_id,tipo_anomalia,usuario_id,entidad_id',
    ignoreDuplicates: false,
  });
  return { error };
}

export async function listarAnomaliasRevisadas(empresa_id) {
  return db
    .from('anomalias_revisadas')
    .select('tipo_anomalia, usuario_id, entidad_id, notas, resuelto_por, created_at')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false });
}
