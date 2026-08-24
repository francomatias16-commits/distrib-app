// lib/repos/gastos-generales.js
// Acceso a datos de `gastos_generales` (migración 479_gastos_generales.sql).
// Carga manual de gastos fijos del negocio (alquiler, sueldos, servicios,
// impuestos, otros) para que Ganancia Neta = Margen Bruto - Gastos Generales
// del período (ver reportes-financieros.js) y la tab "Gastos" del Panel
// principal (dashboard.html) tengan de dónde leer.

import { db } from './_db.js';

export const CATEGORIAS_GASTO = ['alquiler', 'sueldos', 'servicios', 'impuestos', 'otros'];

/**
 * Lista los gastos generales de la empresa, más recientes primero.
 */
export async function listarGastosGenerales(empresa_id, opts = {}) {
  const { activo, categoria, desde, hasta, busqueda } = opts;

  let q = db
    .from('gastos_generales')
    .select('id, empresa_id, categoria, descripcion, monto, fecha, recurrente, notas, activo, created_by, created_at, updated_at')
    .eq('empresa_id', empresa_id)
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(2000);

  if (activo === 'true' || activo === true)   q = q.eq('activo', true);
  if (activo === 'false' || activo === false) q = q.eq('activo', false);
  if (categoria && CATEGORIAS_GASTO.includes(categoria)) q = q.eq('categoria', categoria);
  if (desde) q = q.gte('fecha', desde);
  if (hasta) q = q.lte('fecha', hasta);

  const { data, error } = await q;
  if (error) throw new Error(`[GastosGeneralesRepo.listar] ${error.message}`);

  let rows = data || [];
  if (busqueda) {
    const b = String(busqueda).trim().toLowerCase();
    rows = rows.filter(r =>
      r.descripcion?.toLowerCase().includes(b) ||
      r.notas?.toLowerCase().includes(b) ||
      r.categoria?.toLowerCase().includes(b)
    );
  }
  return rows;
}

export async function obtenerGastoGeneral(empresa_id, id) {
  const { data, error } = await db
    .from('gastos_generales')
    .select('*')
    .eq('empresa_id', empresa_id)
    .eq('id', id)
    .single();
  if (error || !data) throw new Error('No encontrado');
  return data;
}

/** Resumen del período (total + desglose por categoría) — RPC migración 479. */
export async function obtenerResumenGastosGenerales(empresa_id, { desde, hasta }) {
  const { data, error } = await db.rpc('obtener_resumen_gastos_generales', {
    p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta,
  });
  if (error) throw new Error(`[GastosGeneralesRepo.resumen] ${error.message}`);
  return data;
}

function validarCampos(campos) {
  const { categoria, descripcion, monto, fecha } = campos;
  if (!CATEGORIAS_GASTO.includes(categoria)) {
    throw new Error(`categoria debe ser una de: ${CATEGORIAS_GASTO.join(', ')}`);
  }
  if (!descripcion || !String(descripcion).trim()) throw new Error('La descripción es obligatoria');
  if (monto === undefined || monto === null || Number(monto) < 0) {
    throw new Error('El monto es inválido');
  }
  if (!fecha) throw new Error('La fecha es obligatoria');
}

export async function crearGastoGeneral(empresa_id, usuario_id, campos) {
  validarCampos(campos);
  const { categoria, descripcion, monto, fecha, recurrente, notas } = campos;

  const { data, error } = await db
    .from('gastos_generales')
    .insert({
      empresa_id,
      categoria,
      descripcion: String(descripcion).trim(),
      monto: Number(monto),
      fecha,
      recurrente: !!recurrente,
      notas: notas || null,
      activo: true,
      created_by: usuario_id || null,
    })
    .select()
    .single();

  if (error) throw new Error(`[GastosGeneralesRepo.crear] ${error.message}`);
  return data;
}

export async function actualizarGastoGeneral(empresa_id, id, cambios) {
  const antes = await obtenerGastoGeneral(empresa_id, id);

  const permitidos = ['categoria', 'descripcion', 'monto', 'fecha', 'recurrente', 'notas', 'activo'];
  const patch = {};
  for (const k of permitidos) {
    if (cambios[k] !== undefined) patch[k] = cambios[k];
  }

  // Valida el resultado combinado (antes + patch), no solo lo que vino en el body.
  validarCampos({ ...antes, ...patch });
  if (patch.descripcion) patch.descripcion = String(patch.descripcion).trim();
  if (patch.monto !== undefined) patch.monto = Number(patch.monto);

  const { data: despues, error } = await db
    .from('gastos_generales')
    .update(patch)
    .eq('empresa_id', empresa_id)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`[GastosGeneralesRepo.actualizar] ${error.message}`);
  return { antes, despues };
}

/** Soft-delete: activo = false (mismo criterio que maestros.js/notas_credito). */
export async function eliminarGastoGeneral(empresa_id, id) {
  const antes = await obtenerGastoGeneral(empresa_id, id);
  const { error } = await db
    .from('gastos_generales')
    .update({ activo: false })
    .eq('empresa_id', empresa_id)
    .eq('id', id);
  if (error) throw new Error(`[GastosGeneralesRepo.eliminar] ${error.message}`);
  return { antes };
}
