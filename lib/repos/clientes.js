// lib/repos/clientes.js
// Capa de acceso a datos para la entidad `clientes`.
//
// REGLA: ningún handler importa `db` directamente para operar sobre clientes.
//        Toda query sobre `clientes` (incluyendo cta_cte relacionada) pasa por aquí.
//
// Las funciones reciben siempre `empresa_id` explícito como primer parámetro
// de contexto. Nunca se ejecuta una query sin el filtro de tenant.

import { db } from './_db.js';
import { exigirLimitePlan } from '../plan-limits.js';

// ── Lectura ───────────────────────────────────────────────────────────────────

/**
 * Lista clientes de una empresa con filtros opcionales.
 * @param {string} empresa_id
 * @param {{ busqueda?, zona_id?, activo?, limit?, offset? }} opts
 */
/**
 * CUIT de todos los clientes de la empresa, para el dedupe de mapeo de
 * migracion.js (unifica 8 llamadas idénticas que había en el handler).
 */
export async function listarCuitClientesPorEmpresa(empresa_id) {
  const { data } = await db.from('clientes').select('id, cuit').eq('empresa_id', empresa_id);
  return data || [];
}

export async function listarClientes(empresa_id, opts = {}) {
  const { busqueda, zona_id, activo, limit = 200, offset = 0 } = opts;

  let q = db
    .from('clientes')
    .select(`
      id, razon_social, nombre_fantasia, telefono, email, localidad,
      activo, lista_precio_id, zona_id,
      zonas(nombre), listas_precios(nombre)
    `)
    .eq('empresa_id', empresa_id)
    .order('razon_social')
    .range(offset, offset + limit - 1);

  if (busqueda)           q = q.ilike('razon_social', `%${busqueda}%`);
  if (zona_id)            q = q.eq('zona_id', zona_id);
  if (activo !== undefined) q = q.eq('activo', activo);

  const { data, error } = await q;
  if (error) throw new Error(`[ClienteRepo.listar] ${error.message}`);
  return data;
}

// ── Precios especiales por cliente ──────────────────────────────────────────

/**
 * Lista global de precios especiales (todos los clientes) con datos de
 * cliente y producto embebidos, para la vista admin de "Precios especiales".
 * @param {string} empresa_id
 * @param {{ cliente_id?, producto_id?, busqueda?, limit?, offset? }} opts
 */
export async function listarPreciosClientesGlobal(empresa_id, opts = {}) {
  const { cliente_id, producto_id, busqueda, limit = 200, offset = 0 } = opts;

  let q = db
    .from('precios_clientes')
    .select(`
      id, cliente_id, producto_id, precio, notas, created_at, updated_at,
      clientes(razon_social, nombre_fantasia),
      productos(nombre, codigo)
    `)
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (cliente_id)  q = q.eq('cliente_id', cliente_id);
  if (producto_id) q = q.eq('producto_id', producto_id);

  const { data, error } = await q;
  if (error) throw new Error(`[ClienteRepo.listarPreciosGlobal] ${error.message}`);

  let rows = data || [];
  if (busqueda) {
    const b = busqueda.toLowerCase();
    rows = rows.filter(r =>
      (r.clientes?.razon_social || '').toLowerCase().includes(b) ||
      (r.clientes?.nombre_fantasia || '').toLowerCase().includes(b) ||
      (r.productos?.nombre || '').toLowerCase().includes(b) ||
      (r.productos?.codigo || '').toLowerCase().includes(b)
    );
  }
  return rows;
}

/**
 * Crea o actualiza (upsert por cliente_id+producto_id) un precio especial.
 */
export async function upsertPrecioCliente(empresa_id, campos) {
  const { cliente_id, producto_id, precio, notas } = campos;
  if (!cliente_id || !producto_id) throw new Error('cliente_id y producto_id requeridos');
  if (precio === undefined || precio === null || Number(precio) < 0) {
    throw new Error('precio inválido');
  }

  // CLIENTES-002: antes se insertaba con el cliente_id/producto_id tal cual
  // vinieran del body, sin confirmar que pertenecieran a esta empresa —
  // permitía crear un precio especial "huérfano" apuntando a un cliente o
  // producto de otro tenant (mismo tipo de gap que el deposito_id de lotes,
  // ver Etapa 2 Hallazgo 2 en lib/handlers/stock.js).
  const [{ data: cliente }, { data: producto }] = await Promise.all([
    db.from('clientes').select('id').eq('id', cliente_id).eq('empresa_id', empresa_id).single(),
    db.from('productos').select('id').eq('id', producto_id).eq('empresa_id', empresa_id).single(),
  ]);
  if (!cliente) throw new Error('Cliente no encontrado');
  if (!producto) throw new Error('Producto no encontrado');

  const { data, error } = await db
    .from('precios_clientes')
    .upsert(
      { empresa_id, cliente_id, producto_id, precio, notas: notas || null, updated_at: new Date().toISOString() },
      { onConflict: 'cliente_id,producto_id' }
    )
    .select()
    .single();
  if (error) throw new Error(`[ClienteRepo.upsertPrecio] ${error.message}`);
  return data;
}

/**
 * Elimina un precio especial por id (con filtro de tenant).
 */
export async function eliminarPrecioCliente(empresa_id, id) {
  const { error } = await db
    .from('precios_clientes')
    .delete()
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  if (error) throw new Error(`[ClienteRepo.eliminarPrecio] ${error.message}`);
  return { ok: true };
}

/**
 * Obtiene un cliente por ID con cta_cte embebida.
 */
export async function obtenerCliente(empresa_id, cliente_id) {
  const { data, error } = await db
    .from('clientes')
    .select(`
      *,
      zonas(nombre),
      listas_precios(nombre),
      cta_cte(tipo, monto, fecha, facturas(numero))
    `)
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .single();

  if (error) return null;
  return data;
}

/**
 * Busca un cliente por email dentro de una empresa (portal cliente).
 */
export async function obtenerClientePorEmail(empresa_id, email) {
  const { data } = await db
    .from('clientes')
    .select('id, razon_social, telefono, email, activo, lista_precio_id, zona_id')
    .eq('empresa_id', empresa_id)
    .eq('email', email)
    .maybeSingle();
  return data;
}

/**
 * Obtiene datos mínimos de score de un cliente.
 */
export async function obtenerScoreCliente(empresa_id, cliente_id) {
  const { data } = await db
    .from('clientes')
    .select('score_actual, score_categoria, score_actualizado, limite_credito, dias_credito')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/**
 * Datos mínimos de un cliente para armar/enviar la oferta de plan de pago
 * por WhatsApp (score.js: acción `ofrecer-plan-pago`).
 */
export async function obtenerClienteParaOfertaPlanPago(empresa_id, cliente_id) {
  const { data } = await db
    .from('clientes')
    .select('id, razon_social, telefono, score_categoria')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/**
 * Deuda actual del cliente (función SQL `calcular_deuda_cliente`).
 */
export async function calcularDeudaCliente(cliente_id) {
  const { data, error } = await db.rpc('calcular_deuda_cliente', { p_cliente_id: cliente_id });
  if (error) throw new Error(`[ClienteRepo.calcularDeuda] ${error.message}`);
  return +data || 0;
}

/**
 * Lista clientes en una categoría de score dada.
 */
export async function listarClientesPorScore(empresa_id, categorias = []) {
  const { data } = await db
    .from('clientes')
    .select('id, razon_social, telefono, score_categoria')
    .eq('empresa_id', empresa_id)
    .in('score_categoria', categorias)
    .eq('activo', true);
  return data || [];
}

/**
 * Ranking de clientes por score (top N).
 */
export async function rankingScore(empresa_id, limit = 50) {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, score_actual, score_categoria, score_actualizado')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .order('score_actual', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`[ClienteRepo.rankingScore] ${error.message}`);
  return data;
}

// ── Escritura ─────────────────────────────────────────────────────────────────

/**
 * Crea un cliente nuevo.
 * @param {string} empresa_id
 * @param {object} campos  — todos los campos editables
 */
export async function crearCliente(empresa_id, campos) {
  // Plan 3.3: no permitir superar el cupo de clientes del plan contratado.
  await exigirLimitePlan(db, empresa_id, 'clientes');

  const { data, error } = await db
    .from('clientes')
    .insert({ ...campos, empresa_id })
    .select()
    .single();

  if (error) throw new Error(`[ClienteRepo.crear] ${error.message}`);
  return data;
}

/**
 * Actualiza campos de un cliente.
 */
export async function actualizarCliente(empresa_id, cliente_id, cambios) {
  const { data, error } = await db
    .from('clientes')
    .update(cambios)
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .select()
    .single();

  if (error) throw new Error(`[ClienteRepo.actualizar] ${error.message}`);
  return data;
}

/**
 * Lista clientes activos que tienen domicilio cargado pero no coordenadas
 * (lat/lng), candidatos a geocodificación automática. Usado por el botón
 * "Geocodificar direcciones pendientes" del panel de clientes y por el
 * fallback del mapa de rutas.
 */
export async function listarClientesSinCoordenadas(empresa_id, { limit = 50 } = {}) {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, domicilio, localidad')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .not('domicilio', 'is', null)
    .or('lat.is.null,lng.is.null')
    .order('razon_social')
    .limit(limit);

  if (error) throw new Error(`[ClienteRepo.listarSinCoordenadas] ${error.message}`);
  return data;
}

/**
 * Desactiva (soft-delete) un cliente.
 */
export async function desactivarCliente(empresa_id, cliente_id) {
  const { error } = await db
    .from('clientes')
    .update({ activo: false })
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id);

  if (error) throw new Error(`[ClienteRepo.desactivar] ${error.message}`);
}

/**
 * Registra un bloqueo de cliente.
 */
export async function bloquearCliente(empresa_id, cliente_id, motivo) {
  const { error } = await db
    .from('bloqueos_cliente')
    .insert({ empresa_id, cliente_id, motivo });

  if (error) throw new Error(`[ClienteRepo.bloquear] ${error.message}`);
}

/**
 * Desbloquea manualmente un cliente (override de admin).
 *
 * Hallazgo AUDITORIA_CRUD_TABLAS_2026: existía bloquearCliente() (motor
 * automático de mora, cierre.js) pero ninguna función simétrica de
 * desbloqueo manual — el único desbloqueo automático ocurre al saldar la
 * deuda vía registrar_cobro_completo (migración 199). Un admin no tenía
 * forma de revertir un bloqueo a mano (ej. acuerdo de pago, error de carga).
 *
 * Mismo criterio de "las dos tablas" que usa registrar_cobro_completo:
 * clientes.bloqueado/bloqueado_motivo + bloqueos_cliente.activo.
 */
export async function desbloquearCliente(empresa_id, cliente_id) {
  const { data: cliente, error: errCliente } = await db
    .from('clientes')
    .select('id, bloqueado')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  if (errCliente) throw new Error(`[ClienteRepo.desbloquear] ${errCliente.message}`);
  if (!cliente) throw new Error('No encontrado');
  if (!cliente.bloqueado) throw new Error('El cliente no está bloqueado');

  const { error: err1 } = await db
    .from('clientes')
    .update({ bloqueado: false, bloqueado_motivo: null })
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id);
  if (err1) throw new Error(`[ClienteRepo.desbloquear] ${err1.message}`);

  const { error: err2 } = await db
    .from('bloqueos_cliente')
    .update({ activo: false })
    .eq('cliente_id', cliente_id)
    .eq('empresa_id', empresa_id)
    .eq('activo', true);
  if (err2) throw new Error(`[ClienteRepo.desbloquear] ${err2.message}`);
}
