// lib/repos/reglas-automatizacion.js
// Acceso a datos de `reglas_automatizacion` (migración
// 432_fase6_reglas_automatizacion.sql). Este repo es el CRUD de
// administración de las reglas desde automatizacion.html; la evaluación
// en tiempo real (matching de condición + ejecución de acción) la hace
// lib/reglas-automatizacion.js, llamado desde eventos-dispatcher.js — no
// se toca acá.

import { db } from './_db.js';

// Tipos de evento sobre los que hoy se puede armar una regla — deben
// coincidir con las claves de REGISTRO_LISTENERS en eventos-dispatcher.js
// (las reglas corren para cualquiera de ellos, tengan o no listener fijo).
export const EVENTOS_DISPONIBLES = [
  'pedido_creado',
  'pedido_facturado',
  'factura_anulada',
  'cliente_en_mora',
  'cheques_por_vencer',
];

// Tipos de acción soportados (ver lib/reglas-automatizacion.js:ejecutarAccion).
const TIPOS_ACCION_SOPORTADOS = ['notificar_push', 'enviar_whatsapp', 'crear_tarea'];

// Debe coincidir con TEMPLATES_WHATSAPP_DISPONIBLES en
// lib/reglas-automatizacion.js y con WA_TEMPLATE_LABELS en
// frontend/admin/js/automatizacion.js.
const TEMPLATES_WHATSAPP_DISPONIBLES = [
  'confirmacion_pedido',
  'pedido_despachado',
  'pedido_cancelado',
  'deuda_vencida',
  'pedido_entregado',
  'pedido_no_entregado',
  'pedido_por_llegar',
  'cheques_por_vencer',
  'oferta_plan_pago',
  'ruta_asignada',
];

function validarCampos(campos) {
  const { nombre, evento_disparador, accion } = campos;

  if (!nombre || !String(nombre).trim()) {
    throw new Error('El nombre de la regla es obligatorio');
  }
  if (!EVENTOS_DISPONIBLES.includes(evento_disparador)) {
    throw new Error(`evento_disparador inválido (debe ser uno de: ${EVENTOS_DISPONIBLES.join(', ')})`);
  }
  if (!accion || typeof accion !== 'object' || Array.isArray(accion)) {
    throw new Error('La acción de la regla es obligatoria');
  }
  if (!accion.tipo) {
    throw new Error('La acción no tiene "tipo"');
  }
  if (!TIPOS_ACCION_SOPORTADOS.includes(accion.tipo)) {
    throw new Error(`Tipo de acción "${accion.tipo}" no soportado`);
  }
  if (accion.tipo === 'notificar_push') {
    if (!accion.titulo || !String(accion.titulo).trim()) {
      throw new Error('La notificación necesita un título');
    }
    if (!accion.mensaje || !String(accion.mensaje).trim()) {
      throw new Error('La notificación necesita un mensaje');
    }
  }

  if (accion.tipo === 'enviar_whatsapp') {
    if (!accion.template || !TEMPLATES_WHATSAPP_DISPONIBLES.includes(accion.template)) {
      throw new Error(`Template de WhatsApp inválido (debe ser uno de: ${TEMPLATES_WHATSAPP_DISPONIBLES.join(', ')})`);
    }
  }

  if (accion.tipo === 'crear_tarea') {
    if (!accion.titulo || !String(accion.titulo).trim()) {
      throw new Error('La tarea necesita un título');
    }
  }
}

/**
 * Lista las reglas de automatización de la empresa. Tabla de
 * configuración chica (cargada a mano por el dueño/admin) — mismo
 * criterio que reglas_precio: sin paginación de UI, pero con un límite
 * explícito de seguridad.
 */
export async function listarReglasAutomatizacion(empresa_id, opts = {}) {
  const { activa, evento_disparador } = opts;

  let q = db
    .from('reglas_automatizacion')
    .select('id, empresa_id, nombre, descripcion, evento_disparador, condicion, accion, activa, created_at, updated_at')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(500);

  if (activa === 'true' || activa === true)   q = q.eq('activa', true);
  if (activa === 'false' || activa === false) q = q.eq('activa', false);
  if (evento_disparador) q = q.eq('evento_disparador', evento_disparador);

  const { data, error } = await q;
  if (error) throw new Error(`[ReglasAutomatizacionRepo.listar] ${error.message}`);
  return data || [];
}

export async function crearReglaAutomatizacion(empresa_id, campos) {
  validarCampos(campos);

  const { nombre, descripcion, evento_disparador, condicion, accion, activa } = campos;

  const { data, error } = await db
    .from('reglas_automatizacion')
    .insert({
      empresa_id,
      nombre: String(nombre).trim(),
      descripcion: descripcion ? String(descripcion).trim() : null,
      evento_disparador,
      condicion: condicion && typeof condicion === 'object' ? condicion : {},
      accion,
      activa: activa ?? true,
    })
    .select('id, empresa_id, nombre, descripcion, evento_disparador, condicion, accion, activa, created_at, updated_at')
    .single();

  if (error) throw new Error(`[ReglasAutomatizacionRepo.crear] ${error.message}`);
  return data;
}

export async function actualizarReglaAutomatizacion(empresa_id, id, campos) {
  if (!id) throw new Error('id requerido');

  const merged = {
    nombre: campos.nombre,
    evento_disparador: campos.evento_disparador,
    accion: campos.accion,
    ...campos,
  };
  validarCampos(merged);

  const patch = {};
  for (const k of ['nombre', 'descripcion', 'evento_disparador', 'condicion', 'accion', 'activa']) {
    if (k in campos) patch[k] = campos[k] === '' ? null : campos[k];
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('reglas_automatizacion')
    .update(patch)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select('id, empresa_id, nombre, descripcion, evento_disparador, condicion, accion, activa, created_at, updated_at')
    .single();

  if (error) throw new Error(`[ReglasAutomatizacionRepo.actualizar] ${error.message}`);
  if (!data) throw new Error('Regla no encontrada');
  return data;
}

export async function toggleActivaReglaAutomatizacion(empresa_id, id, activa) {
  const { data, error } = await db
    .from('reglas_automatizacion')
    .update({ activa: !!activa, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select('id, activa')
    .single();

  if (error) throw new Error(`[ReglasAutomatizacionRepo.toggleActiva] ${error.message}`);
  if (!data) throw new Error('Regla no encontrada');
  return data;
}

export async function eliminarReglaAutomatizacion(empresa_id, id) {
  const { error } = await db
    .from('reglas_automatizacion')
    .delete()
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  if (error) throw new Error(`[ReglasAutomatizacionRepo.eliminar] ${error.message}`);
  return { ok: true };
}

// ── Tareas creadas por la acción 'crear_tarea' (migración 433) ─────────
// A diferencia del CRUD de reglas de arriba (solo dueño/admin), estas
// las puede ver y completar cualquier rol interno al que la regla se las
// haya asignado — ver ROLES_TAREAS_LECTURA en
// lib/handlers/reglas-automatizacion.js.

/**
 * Lista las tareas pendientes de la empresa que le corresponden al rol
 * del usuario (dueño/admin ven además las que no tienen ningún rol
 * asignado, caso raro pero por las dudas). Tabla operativa chica —
 * mismo criterio sin paginación de UI que el resto del módulo, con
 * límite explícito.
 */
export async function listarTareasAutomatizacion(empresa_id, rol) {
  const { data, error } = await db
    .from('tareas_automatizacion')
    .select('id, empresa_id, regla_id, evento_disparador, titulo, descripcion, roles, estado, completada_por, completada_en, created_at')
    .eq('empresa_id', empresa_id)
    .eq('estado', 'pendiente')
    .contains('roles', [rol])
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) throw new Error(`[ReglasAutomatizacionRepo.listarTareas] ${error.message}`);
  return data || [];
}

/**
 * Marca una tarea como completada. Cualquier rol interno al que la tarea
 * le haya sido asignada puede completarla (no hace falta ser quien la
 * "tomó" primero) — igual que el resto de las tareas operativas del
 * panel (pedidos, cobranzas).
 */
export async function completarTareaAutomatizacion(empresa_id, id, usuarioId) {
  if (!id) throw new Error('id requerido');

  const { data, error } = await db
    .from('tareas_automatizacion')
    .update({ estado: 'completada', completada_por: usuarioId || null, completada_en: new Date().toISOString() })
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .eq('estado', 'pendiente')
    .select('id, estado')
    .single();

  if (error) throw new Error(`[ReglasAutomatizacionRepo.completarTarea] ${error.message}`);
  if (!data) throw new Error('Tarea no encontrada o ya estaba completada');
  return data;
}
