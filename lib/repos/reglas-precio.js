// lib/repos/reglas-precio.js
// Acceso a datos de `reglas_precio` (migración 243_etapa2_motor_reglas_precio.sql).
// Motor de reglas de precio por volumen/zona/temporada — este repo es el CRUD
// de administración de esas reglas; la resolución en tiempo de venta/pedido la
// hace la función SQL resolver_precios_cliente(), no se toca acá.

import { db } from './_db.js';

/**
 * Lista las reglas de precio de la empresa, con los nombres de producto/
 * categoría/zona resueltos para mostrar en la tabla (sin joins manuales
 * en el frontend).
 */
export async function listarReglasPrecio(empresa_id, opts = {}) {
  const { activa, busqueda } = opts;

  // reglas_precio es una tabla de configuración chica (0-cientos de filas
  // por tenant, cargada a mano por el dueño/admin) — no tiene el mismo
  // perfil de crecimiento que clientes/productos/pedidos, así que no hace
  // falta paginación de UI acá. Pero antes esta query no tenía NINGÚN
  // límite (ni siquiera un "tope de seguridad" fijo) — una consulta 100%
  // sin cota es lo mismo que confiar en que el volumen nunca va a crecer.
  // Se agrega un límite explícito generoso en vez de dejarla sin cota.
  let q = db
    .from('reglas_precio')
    .select(`
      id, empresa_id, nombre, producto_id, categoria_id, zona_id,
      cantidad_minima, tipo_descuento, valor, fecha_desde, fecha_hasta,
      prioridad, activa, created_at, updated_at,
      productos(nombre, codigo),
      categorias(nombre),
      zonas(nombre)
    `)
    .eq('empresa_id', empresa_id)
    .order('prioridad', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(2000);

  if (activa === 'true' || activa === true)   q = q.eq('activa', true);
  if (activa === 'false' || activa === false) q = q.eq('activa', false);

  const { data, error } = await q;
  if (error) throw new Error(`[ReglasPrecioRepo.listar] ${error.message}`);

  // El texto de búsqueda matchea contra nombre propio Y contra nombres de
  // producto/categoría/zona (tablas relacionadas) — PostgREST no resuelve
  // bien un ilike cruzado sobre columnas de tablas embebidas en un solo
  // .or(), así que ese filtro queda en Node, pero sobre el conjunto ya
  // acotado por el .limit(2000) de arriba (nunca sobre una tabla sin cota).
  let rows = data || [];
  if (busqueda) {
    const b = String(busqueda).trim().toLowerCase();
    rows = rows.filter(r =>
      r.nombre?.toLowerCase().includes(b) ||
      r.productos?.nombre?.toLowerCase().includes(b) ||
      r.categorias?.nombre?.toLowerCase().includes(b) ||
      r.zonas?.nombre?.toLowerCase().includes(b)
    );
  }
  return rows;
}

/**
 * REGLAS-001: confirma que producto_id/categoria_id/zona_id (si vienen)
 * pertenezcan a `empresa_id` antes de insertar/actualizar una regla. El
 * client de este repo usa SERVICE_ROLE_KEY (bypassea RLS), así que esta
 * validación de aplicación es la única barrera real de tenant acá.
 */
async function validarEntidadesPropias(empresa_id, { producto_id, categoria_id, zona_id }) {
  const checks = [];
  if (producto_id) {
    checks.push(
      db.from('productos').select('id').eq('id', producto_id).eq('empresa_id', empresa_id).single()
        .then(({ data }) => { if (!data) throw new Error('Producto no encontrado'); })
    );
  }
  if (categoria_id) {
    checks.push(
      db.from('categorias').select('id').eq('id', categoria_id).eq('empresa_id', empresa_id).single()
        .then(({ data }) => { if (!data) throw new Error('Categoría no encontrada'); })
    );
  }
  if (zona_id) {
    checks.push(
      db.from('zonas').select('id').eq('id', zona_id).eq('empresa_id', empresa_id).single()
        .then(({ data }) => { if (!data) throw new Error('Zona no encontrada'); })
    );
  }
  await Promise.all(checks);
}

function validarCampos(campos) {
  const {
    nombre, producto_id, categoria_id, tipo_descuento, valor,
    cantidad_minima, fecha_desde, fecha_hasta,
  } = campos;

  if (!nombre || !String(nombre).trim()) throw new Error('El nombre de la regla es obligatorio');
  if (producto_id && categoria_id) throw new Error('Elegí producto o categoría, no ambos a la vez');
  if (!['porcentaje', 'precio_fijo'].includes(tipo_descuento)) {
    throw new Error('tipo_descuento debe ser "porcentaje" o "precio_fijo"');
  }
  if (valor === undefined || valor === null || Number(valor) < 0) {
    throw new Error('El valor del descuento es inválido');
  }
  if (tipo_descuento === 'porcentaje' && Number(valor) > 100) {
    throw new Error('Un descuento porcentual no puede superar el 100%');
  }
  if (cantidad_minima !== undefined && cantidad_minima !== null && Number(cantidad_minima) < 1) {
    throw new Error('La cantidad mínima debe ser 1 o mayor');
  }
  if (fecha_desde && fecha_hasta && fecha_desde > fecha_hasta) {
    throw new Error('La fecha "desde" no puede ser posterior a la fecha "hasta"');
  }
}

/**
 * Crea una regla de precio nueva.
 */
export async function crearReglaPrecio(empresa_id, campos) {
  validarCampos(campos);

  const {
    nombre, producto_id, categoria_id, zona_id,
    cantidad_minima, tipo_descuento, valor,
    fecha_desde, fecha_hasta, prioridad, activa,
  } = campos;

  // REGLAS-001: producto_id/categoria_id/zona_id venían del body sin
  // confirmar que pertenecieran a esta empresa — mismo tipo de gap que
  // CLIENTES-002 (cliente_id/producto_id de precios_clientes). Acá era
  // más grave porque el `.select()` de vuelta embebe productos(nombre,
  // codigo)/categorias(nombre)/zonas(nombre): permitía crear una regla
  // apuntando a una entidad de OTRO tenant y que la respuesta de la API
  // devolviera su nombre/código, filtrando datos de otra empresa.
  await validarEntidadesPropias(empresa_id, { producto_id, categoria_id, zona_id });

  const { data, error } = await db
    .from('reglas_precio')
    .insert({
      empresa_id,
      nombre: String(nombre).trim(),
      producto_id: producto_id || null,
      categoria_id: categoria_id || null,
      zona_id: zona_id || null,
      cantidad_minima: cantidad_minima ?? 1,
      tipo_descuento,
      valor,
      fecha_desde: fecha_desde || null,
      fecha_hasta: fecha_hasta || null,
      prioridad: prioridad ?? 0,
      activa: activa ?? true,
    })
    .select(`
      id, empresa_id, nombre, producto_id, categoria_id, zona_id,
      cantidad_minima, tipo_descuento, valor, fecha_desde, fecha_hasta,
      prioridad, activa, created_at, updated_at,
      productos(nombre, codigo), categorias(nombre), zonas(nombre)
    `)
    .single();

  if (error) throw new Error(`[ReglasPrecioRepo.crear] ${error.message}`);
  return data;
}

/**
 * Actualiza una regla existente (con filtro de tenant).
 */
export async function actualizarReglaPrecio(empresa_id, id, campos) {
  if (!id) throw new Error('id requerido');

  // Sólo valida los campos que efectivamente vienen en el patch, salvo
  // nombre/tipo_descuento/valor que son siempre requeridos por la regla de
  // negocio (evita dejar una regla a medio completar).
  const merged = { tipo_descuento: campos.tipo_descuento, valor: campos.valor, nombre: campos.nombre, ...campos };
  validarCampos(merged);

  // REGLAS-001: mismo chequeo que en crearReglaPrecio, solo para los
  // campos de FK que efectivamente vienen en este patch.
  await validarEntidadesPropias(empresa_id, {
    producto_id: 'producto_id' in campos ? campos.producto_id : null,
    categoria_id: 'categoria_id' in campos ? campos.categoria_id : null,
    zona_id: 'zona_id' in campos ? campos.zona_id : null,
  });

  const patch = {};
  for (const k of [
    'nombre', 'producto_id', 'categoria_id', 'zona_id', 'cantidad_minima',
    'tipo_descuento', 'valor', 'fecha_desde', 'fecha_hasta', 'prioridad', 'activa',
  ]) {
    if (k in campos) patch[k] = campos[k] === '' ? null : campos[k];
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('reglas_precio')
    .update(patch)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select(`
      id, empresa_id, nombre, producto_id, categoria_id, zona_id,
      cantidad_minima, tipo_descuento, valor, fecha_desde, fecha_hasta,
      prioridad, activa, created_at, updated_at,
      productos(nombre, codigo), categorias(nombre), zonas(nombre)
    `)
    .single();

  if (error) throw new Error(`[ReglasPrecioRepo.actualizar] ${error.message}`);
  if (!data) throw new Error('Regla no encontrada');
  return data;
}

/**
 * Activa/desactiva una regla sin borrarla (para pausar una promo estacional
 * y poder reactivarla después, en vez de tener que volver a cargar todo).
 */
export async function toggleActivaReglaPrecio(empresa_id, id, activa) {
  const { data, error } = await db
    .from('reglas_precio')
    .update({ activa: !!activa, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select('id, activa')
    .single();

  if (error) throw new Error(`[ReglasPrecioRepo.toggleActiva] ${error.message}`);
  if (!data) throw new Error('Regla no encontrada');
  return data;
}

/**
 * Elimina una regla de precio (con filtro de tenant).
 */
export async function eliminarReglaPrecio(empresa_id, id) {
  const { error } = await db
    .from('reglas_precio')
    .delete()
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  if (error) throw new Error(`[ReglasPrecioRepo.eliminar] ${error.message}`);
  return { ok: true };
}
