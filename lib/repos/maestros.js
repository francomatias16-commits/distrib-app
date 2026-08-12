// lib/repos/maestros.js
// Acceso a datos de los 4 "maestros" por empresa: zonas de reparto,
// depósitos, listas de precio y categorías. Migrado desde
// lib/handlers/maestros.js (mismo patrón que reglas-precio.js): la config
// por recurso (RECURSOS) y las reglas de negocio de "único" (principal/
// default) y de baja quedan acá; el handler solo hace auth + mapeo HTTP.
//
// <recurso> ∈ {'zonas', 'depositos', 'listas-precios', 'categorias'}

import { db } from './_db.js';

// ── Config por recurso: tabla real, campos editables y reglas propias ────
export const RECURSOS = {
  'zonas': {
    tabla: 'zonas',
    orden: 'nombre',
    campos: ['nombre', 'dias_reparto'],
    normalizar(body) {
      return {
        nombre:       (body.nombre || '').trim(),
        dias_reparto: Array.isArray(body.dias_reparto) ? body.dias_reparto : null,
      };
    },
  },
  'depositos': {
    tabla: 'depositos',
    orden: 'nombre',
    campos: ['nombre', 'direccion', 'responsable', 'es_principal'],
    unico: 'es_principal',   // solo puede haber un depósito principal por empresa
    normalizar(body) {
      return {
        nombre:       (body.nombre || '').trim(),
        direccion:    body.direccion?.trim() || null,
        responsable:  body.responsable?.trim() || null,
        es_principal: !!body.es_principal,
      };
    },
  },
  'listas-precios': {
    tabla: 'listas_precios',
    orden: 'nombre',
    campos: ['nombre', 'es_default'],
    unico: 'es_default',     // solo puede haber una lista por defecto por empresa
    normalizar(body) {
      return {
        nombre:     (body.nombre || '').trim(),
        es_default: !!body.es_default,
      };
    },
  },
  'categorias': {
    tabla: 'categorias',
    orden: 'orden',
    campos: ['nombre', 'orden', 'descripcion'],
    normalizar(body) {
      return {
        nombre:      (body.nombre || '').trim(),
        orden:       Number.isFinite(+body.orden) ? +body.orden : 0,
        descripcion: body.descripcion?.trim() || null,
      };
    },
  },
};

function cfgDe(recurso) {
  const cfg = RECURSOS[recurso];
  if (!cfg) throw new Error('recurso inválido. Usá: zonas, depositos, listas-precios o categorias');
  return cfg;
}

/**
 * Lista los registros de un recurso maestro para la empresa (filtro opcional
 * ?activa=true|false).
 */
export async function listarMaestros(recurso, empresa_id, opts = {}) {
  const cfg = cfgDe(recurso);
  const { activa } = opts;

  let q = db.from(cfg.tabla).select('*').eq('empresa_id', empresa_id).order(cfg.orden);
  if (activa === 'true')  q = q.eq('activa', true);
  if (activa === 'false') q = q.eq('activa', false);

  const { data, error } = await q;
  if (error) throw new Error(`[MaestrosRepo.listar] ${error.message}`);
  return data || [];
}

/**
 * Detalle de un registro (con filtro de tenant).
 */
export async function obtenerMaestro(recurso, empresa_id, id) {
  const cfg = cfgDe(recurso);
  const { data, error } = await db
    .from(cfg.tabla).select('*')
    .eq('id', id).eq('empresa_id', empresa_id).single();
  if (error || !data) throw new Error('No encontrado');
  return data;
}

/**
 * Crea un registro nuevo. Si es el primer registro activo de la empresa
 * para este recurso, se marca automáticamente como el "único" (principal/
 * default) — así nunca queda un depósito o lista de precio sin uno marcado.
 */
export async function crearMaestro(recurso, empresa_id, body) {
  const cfg = cfgDe(recurso);
  const valores = cfg.normalizar(body || {});
  if (!valores.nombre) throw new Error('Nombre requerido');

  if (cfg.unico) {
    const { count } = await db
      .from(cfg.tabla).select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id).eq('activa', true);
    if (!count) valores[cfg.unico] = true;
    if (valores[cfg.unico]) await desmarcarUnico(cfg, empresa_id);
  }

  const { data, error } = await db
    .from(cfg.tabla)
    .insert({ empresa_id, activa: true, ...valores })
    .select().single();

  if (error) throw new Error(`[MaestrosRepo.crear] ${error.message}`);
  return data;
}

/**
 * Edita un registro existente (con filtro de tenant). Devuelve tanto el
 * registro anterior como el actualizado para que el handler arme el audit
 * log — el repo no conoce quién es el usuario que hace el cambio.
 */
export async function actualizarMaestro(recurso, empresa_id, id, cambios) {
  const cfg = cfgDe(recurso);
  if (!id) throw new Error('id requerido');

  const { data: antes } = await db
    .from(cfg.tabla).select('*').eq('id', id).eq('empresa_id', empresa_id).single();
  if (!antes) throw new Error('No encontrado');

  const update = {};
  for (const k of cfg.campos) if (k in cambios) update[k] = cambios[k];
  if ('activa' in cambios) update.activa = !!cambios.activa;
  if ('nombre' in update) update.nombre = (update.nombre || '').trim();
  if (!('nombre' in update ? update.nombre : antes.nombre))
    throw new Error('Nombre requerido');

  if (cfg.unico && update[cfg.unico]) await desmarcarUnico(cfg, empresa_id, id);

  // Guard: no permitir dar de baja el único registro activo, ni el
  // marcado como principal/default sin que haya otro para reemplazarlo.
  if (update.activa === false) {
    const motivo = await validarBaja(cfg, empresa_id, antes);
    if (motivo) throw new Error(motivo);
  }

  const { data, error } = await db
    .from(cfg.tabla).update(update).eq('id', id).eq('empresa_id', empresa_id)
    .select().single();

  if (error) throw new Error(`[MaestrosRepo.actualizar] ${error.message}`);
  return { antes, despues: data };
}

/**
 * Da de baja un registro (soft-delete: activa=false), con las mismas
 * validaciones de "no dejar el módulo sin ningún activo" que el update.
 */
export async function eliminarMaestro(recurso, empresa_id, id) {
  const cfg = cfgDe(recurso);
  if (!id) throw new Error('id requerido');

  const { data: antes } = await db
    .from(cfg.tabla).select('*').eq('id', id).eq('empresa_id', empresa_id).single();
  if (!antes) throw new Error('No encontrado');

  const motivo = await validarBaja(cfg, empresa_id, antes);
  if (motivo) throw new Error(motivo);

  const { error } = await db
    .from(cfg.tabla).update({ activa: false }).eq('id', id).eq('empresa_id', empresa_id);
  if (error) throw new Error(`[MaestrosRepo.eliminar] ${error.message}`);

  return { antes };
}

// Desmarca el registro "único" (es_principal / es_default) anterior de la
// empresa, salvo el que se está guardando ahora mismo (excluirId).
async function desmarcarUnico(cfg, empresa_id, excluirId) {
  let q = db.from(cfg.tabla).update({ [cfg.unico]: false }).eq('empresa_id', empresa_id);
  if (excluirId) q = q.neq('id', excluirId);
  await q;
}

// Evita dejar el módulo sin ningún registro activo, y evita dar de baja
// el principal/default sin que quede otro para tomar su lugar.
async function validarBaja(cfg, empresa_id, registro) {
  const { count: activos } = await db
    .from(cfg.tabla).select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id).eq('activa', true);

  if ((activos || 0) <= 1)
    return `No podés dar de baja el único registro activo. Cargá otro antes de dar de baja este.`;

  if (cfg.unico && registro[cfg.unico]) {
    const { count: otros } = await db
      .from(cfg.tabla).select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id).eq('activa', true).neq('id', registro.id);
    if (!otros)
      return `Este registro está marcado como principal/predeterminado. Marcá otro como principal antes de dar de baja este.`;
  }
  return null;
}
