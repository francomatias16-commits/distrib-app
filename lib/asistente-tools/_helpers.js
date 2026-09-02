// lib/asistente-tools/_helpers.js
// Funciones auxiliares usadas por los execute() de las tools (buscar-por-
// texto, resolver-argumentos, armar-cambios, etc.). Extraídas tal cual de
// lib/asistente-tools.js en el split del 25/08/2026 — se mantienen juntas
// (en vez de repartidas por dominio) porque varias son usadas por tools de
// más de una categoría (ej. buscarClientePorTexto).

// lib/asistente-tools.js
//
// Catálogo de herramientas (function calling) del asistente de ayuda.
//
// Reemplaza el enfoque anterior de asistente-datos-vivos.js (regex a
// mano, 1 por pregunta) por tool calling real: el modelo recibe la
// lista de herramientas de abajo con su descripción y JSON Schema de
// parámetros, y decide él mismo cuál llamar (o ninguna) según la
// pregunta. Esto es lo que permite escalar a "cualquier consulta"
// sin agregar un regex nuevo por cada intención.
//
// Por qué sigue siendo seguro (mismo principio que el archivo que
// reemplaza): el modelo NUNCA arma SQL. Solo elige un nombre de una
// lista fija y un puñado de parámetros primitivos (texto, número,
// fecha) declarados en el schema. Cada handler de abajo llama SIEMPRE
// a una RPC ya escrita a mano, ya auditada, SECURITY DEFINER y
// scopeada por empresa_id — y el empresa_id nunca sale del modelo:
// lo inyecta el handler desde el perfil ya verificado (verificarToken()).
//
// Para agregar una herramienta nueva:
//   1. Escribir la RPC en Supabase (scopeada por p_empresa_id, revocada
//      de PUBLIC, otorgada a service_role — ver
//      203_asistente_tools_lectura.sql).
//   2. Agregar una entrada a TOOLS de abajo: name, description (en
//      español, clara, porque el modelo decide según esto), parameters
//      (JSON Schema), y execute().
//   3. NO agregar nada que reciba nombres de tabla/columna como
//      parámetro, ni que no filtre por empresa_id.
//
// Tools de ESCRITURA (hacen algo, no solo consultan) — DISTINTO de lo
// anterior, ver 419_asistente_acciones_pendientes.sql:
//   4. Marcar la entrada con `requiereConfirmacion: true`.
//   5. Agregar `async resumen({ empresaId, args })` que devuelva UNA
//      frase en texto plano, clara y específica, de lo que se va a
//      hacer (ej. "Anular la venta #A1B2C3 de $4.500 de Juan Pérez.
//      Esto no se puede deshacer."). Ese texto es lo único que ve el
//      usuario antes de tocar el botón Confirmar — tiene que alcanzar
//      para decidir sin adivinar nada.
//   6. `execute()` sigue siendo el que hace el cambio real — pero con
//      esta marca, ejecutarTool() JAMÁS lo llama directo: solo se llama
//      desde resolverAccionPendiente(), después del click de Confirmar
//      del usuario. Gemini nunca tiene la posibilidad de ejecutarla
//      él mismo en el mismo turno en que la "decide".

import { db } from '../repos/_db.js';
import {
  crearCliente as crearClienteRepo,
  actualizarCliente as actualizarClienteRepo,
  desactivarCliente as desactivarClienteRepo,
} from '../repos/clientes.js';
import * as AuditRepo from '../repos/audit.js';
import {
  crearPedidoParaCliente, ROLES_ADMIN as ROLES_PEDIDO,
  crearPresupuestoParaCliente, ROLES_ADMIN_PRES as ROLES_PRESUPUESTO,
  crearDevolucionCore,
} from '../handlers/pedidos.js';
import { procesarColaFinancieraEmpresa } from '../handlers/cierre.js';
import { generarSugerenciasPilotoEmpresa } from '../handlers/piloto.js';
import { analizarYGenerarOrdenes as analizarStockAutonomoEmpresa } from '../handlers/stock-auto.js';
import { recalcularScoreEmpresa } from '../handlers/score.js';
import { detectarYNotificar as detectarAnomaliasAuditoriaEmpresa } from '../handlers/auditoria.js';
import { generarExport } from '../export-contable/index.js';
import {
  listarInvitacionesChofer, invitarChoferNuevo, invitarChoferExistente,
  revocarInvitacionChofer, ROLES_GESTION as ROLES_CHOFER_INVITACION,
  APP_URL_FALLBACK,
} from '../handlers/chofer_invitacion.js';
import {
  listarSesionesMigracion, obtenerEstadoSesionMigracion, ROLES_MIGRACION,
} from '../handlers/migracion.js';
import {
  generarLinkPortalProveedor, listarLinksPortalProveedor,
  revocarLinkPortalProveedor, ROLES_ESCRITURA as ROLES_PORTAL_PROVEEDOR,
} from '../handlers/portal_proveedor.js';
import {
  listarUsuariosEquipo, ROLES_GESTION as ROLES_USUARIOS,
} from '../handlers/usuarios.js';
import {
  listarReglasPrecio, crearReglaPrecio, actualizarReglaPrecio,
} from '../repos/reglas-precio.js';
import {
  listarReglasAutomatizacion, crearReglaAutomatizacion, actualizarReglaAutomatizacion,
} from '../repos/reglas-automatizacion.js';
import {
  listarOfertasActivas as listarOfertasLiquidacion,
  obtenerReglas as obtenerReglasLiquidacion,
  guardarReglas as guardarReglasLiquidacion,
} from '../repos/stock.js';

import { TTL_CONFIRMACION_MS, EVENTOS_DISPONIBLES_ASISTENTE, EVENTOS_LABELS_ASISTENTE, TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE, ROLES_NOTIFICACION_VALIDOS } from './_constantes.js';


// empresa.js: helpers de consultar_datos_empresa / actualizar_datos_empresa /
// actualizar_catalogo_publico_empresa. `empresas.id` ES el empresa_id (no es
// una tabla con FK a empresa_id como el resto — la fila de la empresa es la
// empresa), por eso se filtra por `id`, no por `empresa_id`.
async function obtenerDatosEmpresaActual({ empresaId }) {
  const { data, error } = await db.from('empresas')
    .select('nombre, cuit, domicilio, telefono, email, logo_url, config')
    .eq('id', empresaId)
    .single();
  if (error) throw new Error(`No se pudieron obtener los datos de la empresa: ${error.message}`);
  return data;
}

// Misma validación que el handler real (PUT /api/empresa/datos): nombre y
// CUIT (11 dígitos limpios de guiones) son obligatorios, email con formato
// básico si lo mandan. Los campos no mandados se completan con el valor
// actual, para que actualizar_datos_empresa pueda usarse para cambiar un
// solo campo (ej. "cambiame el teléfono") sin que el resto se borre — el
// handler real no tiene ese "parcial" porque el form del panel siempre
// manda los 5 campos juntos.
function armarUpdateDatosEmpresa({ actual, args }) {
  const nombre = args.nombre !== undefined ? String(args.nombre).trim() : actual.nombre;
  if (!nombre) throw new Error('El nombre / razón social es requerido.');

  const cuitCrudo = args.cuit !== undefined ? args.cuit : actual.cuit;
  const cuit = String(cuitCrudo ?? '').replace(/-/g, '').trim();
  if (!/^\d{11}$/.test(cuit)) throw new Error('El CUIT debe tener 11 dígitos numéricos.');

  const domicilio = args.domicilio !== undefined ? String(args.domicilio).trim() || null : (actual.domicilio ?? null);
  const telefono  = args.telefono  !== undefined ? String(args.telefono).trim()  || null : (actual.telefono  ?? null);
  const email     = args.email     !== undefined ? String(args.email).trim()     || null : (actual.email     ?? null);

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('El email no tiene un formato válido.');
  }

  return { nombre, cuit, domicilio, telefono, email };
}

// Dedupe de "maestros" (categorías/depósitos/zonas): estas 3 tablas no
// tienen unique constraint por nombre a nivel DB (se verificó contra el
// schema real antes de escribir esto), así que crear_categoria/
// crear_deposito/crear_zona hacen el chequeo acá — un ILIKE exacto (case
// insensitive) contra el nombre dentro de la misma empresa — para que un
// "creá la categoría Bebidas" repetido dos veces no genere dos filas
// duplicadas por una transcripción de voz o un doble pedido del usuario.
async function buscarMaestroExistente({ empresaId, tabla, nombre }) {
  const n = String(nombre || '').trim();
  const { data, error } = await db.from(tabla)
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .ilike('nombre', n)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo verificar ${tabla} existentes: ${error.message}`);
  return data;
}

// Resuelve nombres de depósito en texto libre a filas reales de la
// empresa. A diferencia de buscarClientePorTexto/buscarProductoPorTexto
// (que usan una RPC de similitud por trigramas porque hay potencialmente
// cientos de filas), acá alcanza con traer TODOS los depósitos de la
// empresa de una — normalmente son pocos (un puñado, no cientos) — y
// resolver cada nombre pedido con un ILIKE "contiene" en JS. Mismo
// criterio de "nunca adivinar": 0 o 2+ coincidencias para un nombre
// dado es una excepción con la lista real de depósitos disponibles.
async function resolverDepositosPorNombre({ empresaId, nombres }) {
  const { data: todos, error } = await db.from('depositos')
    .select('id, nombre')
    .eq('empresa_id', empresaId);
  if (error) throw new Error(`No se pudieron consultar los depósitos: ${error.message}`);
  if (!todos?.length) throw new Error('Esta empresa todavía no tiene ningún depósito cargado.');

  const resueltos = [];
  for (const nombreBuscado of nombres) {
    const t = String(nombreBuscado || '').trim().toLowerCase();
    if (!t) continue;
    const coincidencias = todos.filter((d) => d.nombre.toLowerCase().includes(t));
    if (!coincidencias.length) {
      const disponibles = todos.map((d) => d.nombre).join(', ');
      throw new Error(`No encontré ningún depósito parecido a "${nombreBuscado}". Depósitos disponibles: ${disponibles}.`);
    }
    if (coincidencias.length > 1) {
      const nombresCoincidentes = coincidencias.map((d) => d.nombre).join(', ');
      throw new Error(`Hay más de un depósito parecido a "${nombreBuscado}" (${nombresCoincidentes}). Pedile al usuario que precise cuál.`);
    }
    if (!resueltos.some((r) => r.id === coincidencias[0].id)) resueltos.push(coincidencias[0]);
  }
  if (!resueltos.length) throw new Error('Falta indicar en qué depósito(s) va el producto.');
  return resueltos;
}

// Resuelve una categoría por nombre para crear_producto/editar_producto.
// A propósito NUNCA la crea sola si no existe (a diferencia de cómo
// crear_pedido resuelve cliente/producto): una categoría mal transcripta
// por voz que se auto-crea deja basura silenciosa en el catálogo — mejor
// avisarle al usuario y que use crear_categoria explícitamente si hace
// falta una nueva.
async function resolverCategoriaPorNombre({ empresaId, nombre }) {
  if (!nombre) return null;
  const existente = await buscarMaestroExistente({ empresaId, tabla: 'categorias', nombre });
  if (!existente) throw new Error(`No existe ninguna categoría llamada "${nombre}". Se puede crear primero con "creá la categoría ${nombre}", o dejar el producto sin categoría.`);
  return existente;
}

async function resolverCrearProductoDesdeArgs({ empresaId, args }) {
  const nombre = String(args.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre del producto.');

  const nombresDepositos = Array.isArray(args.depositos) ? args.depositos : [];
  if (!nombresDepositos.length) throw new Error('Falta indicar en qué depósito(s) va el producto nuevo.');
  const depositosResueltos = await resolverDepositosPorNombre({ empresaId, nombres: nombresDepositos });

  const categoriaExistente = args.categoria ? await resolverCategoriaPorNombre({ empresaId, nombre: args.categoria }) : null;

  return {
    nombre,
    depositosResueltos,
    categoriaId: categoriaExistente?.id || null,
    categoriaNombre: categoriaExistente?.nombre || null,
    precioBase: Number(args.precio_base) || 0,
    costo: Number(args.costo) || 0,
    stockMinimo: Number(args.stock_minimo) || 0,
    codigo: args.codigo ? String(args.codigo).trim() : null,
  };
}

async function resolverEditarProductoDesdeArgs({ empresaId, args }) {
  const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });

  const cambios = {};
  const cambiosTexto = [];

  if (args.precio_base !== undefined && args.precio_base !== null) {
    cambios.precio_base = Number(args.precio_base);
    cambiosTexto.push(`precio $${cambios.precio_base.toLocaleString('es-AR')}`);
  }
  if (args.costo !== undefined && args.costo !== null) {
    cambios.costo = Number(args.costo);
    cambiosTexto.push(`costo $${cambios.costo.toLocaleString('es-AR')}`);
  }
  if (args.stock_minimo !== undefined && args.stock_minimo !== null) {
    cambios.stock_minimo = Number(args.stock_minimo);
    cambiosTexto.push(`stock mínimo ${cambios.stock_minimo}`);
  }
  if (args.categoria) {
    const categoria = await resolverCategoriaPorNombre({ empresaId, nombre: args.categoria });
    cambios.categoria_id = categoria.id;
    cambiosTexto.push(`categoría "${categoria.nombre}"`);
  }
  if (args.activo !== undefined && args.activo !== null) {
    cambios.activo = Boolean(args.activo);
    cambiosTexto.push(cambios.activo ? 'reactivarlo' : 'darlo de baja');
  }

  return { producto, cambios, cambiosTexto };
}

// Días válidos para zonas.dias_reparto: se confirmaron contra los valores
// que ya existen en la tabla real (lunes/martes/miercoles/jueves/viernes/
// sabado/domingo — en español, minúscula, sin tilde). No hay un check
// constraint a nivel DB que lo obligue, así que se valida acá antes de
// insertar para no meter un valor que el resto del sistema no reconozca.
const DIAS_REPARTO_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

function normalizarDiaReparto(dia) {
  return String(dia || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function resolverDiasReparto(dias) {
  if (!Array.isArray(dias) || !dias.length) return [];
  const normalizados = [...new Set(dias.map(normalizarDiaReparto).filter(Boolean))];
  const invalidos = normalizados.filter((d) => !DIAS_REPARTO_VALIDOS.includes(d));
  if (invalidos.length) {
    throw new Error(`Día(s) de reparto no reconocido(s): ${invalidos.join(', ')}. Usar lunes, martes, miercoles, jueves, viernes, sabado o domingo.`);
  }
  return normalizados;
}

// Resuelve la recompensa de canjear_recompensa_asistente por texto libre.
// No hay una RPC de búsqueda aproximada para recompensas (a diferencia de
// clientes/productos, ver migración 420) — el universo de recompensas por
// empresa es chico, así que un ILIKE simple alcanza; mismo criterio de
// "0 o ambiguo → pedir que aclare, nunca adivinar" que el resto del archivo.
async function buscarRecompensaPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar qué recompensa canjear.');

  const { data, error } = await db.from('recompensas')
    .select('id, nombre, puntos_requeridos, activa')
    .eq('empresa_id', empresaId)
    .eq('activa', true)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la recompensa: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna recompensa activa parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((r) => r.nombre).join(', ');
    throw new Error(`Hay más de una recompensa parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// anular_venta_pos() bajo service_role NO valida por sí sola que la venta
// pertenezca a empresaId (ver comentario en la migración 416: el chequeo de
// empresa se salta explícitamente cuando auth.role() = 'service_role',
// porque asume que quien llama con esa key ya validó tenant por su cuenta
// — como hacen el resto de los handlers HTTP). Como acá SÍ llamamos con
// service_role key, esta validación la tenemos que hacer nosotros mismos
// antes de tocar nada, igual que ya hacen diagnosticar_venta_pos/pedido/etc.
async function buscarVentaPosPropia({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim();
  if (!ref) return { error: 'Falta la referencia de la venta' };

  const { data, error } = await db.rpc('diagnosticar_venta_pos', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) return { error: `No se pudo verificar la venta: ${error.message}` };
  if (!data?.encontrado) {
    return { error: data?.ambiguo ? 'Esa referencia coincide con más de una venta, pedile al usuario el ID corto completo.' : 'No se encontró ninguna venta con esa referencia en esta empresa.' };
  }
  if (data.estado_venta === 'anulada') return { error: 'Esa venta ya está anulada.' };
  if (data.tiene_factura) return { error: 'Esa venta ya tiene una factura generada; para anularla hay que emitir una Nota de Crédito, no se puede usar esta herramienta.' };

  return {
    id: data.venta_id,
    referencia_corta: data.referencia_corta,
    cliente: data.cliente,
    total: data.total,
    estado_venta: data.estado_venta,
  };
}

// Resuelve la referencia corta/UUID de confirmar_pedido_sugerido y
// descartar_pedido_sugerido reusando diagnosticar_pedido (misma RPC que ya
// hace la búsqueda segura por empresa_id + 6 caracteres finales, ver
// migración 205) en vez de reimplementar el matching acá. Solo deja pasar
// pedidos que efectivamente estén en estado "sugerido" — confirmar o
// descartar cualquier otro estado con esta tool no tiene sentido y podría
// pisar un pedido que ya se procesó por otra vía.
async function buscarPedidoSugeridoPropio({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim();
  if (!ref) return { error: 'Falta la referencia del pedido sugerido' };

  const { data, error } = await db.rpc('diagnosticar_pedido', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) return { error: `No se pudo verificar el pedido: ${error.message}` };
  if (!data?.encontrado) {
    return { error: data?.ambiguo ? 'Esa referencia coincide con más de un pedido, pedile al usuario el ID corto completo.' : 'No se encontró ningún pedido con esa referencia en esta empresa.' };
  }
  if (data.estado_pedido !== 'sugerido') {
    return { error: `Ese pedido está en estado "${data.estado_pedido}", no "sugerido" — no se puede confirmar ni descartar con esta herramienta.` };
  }

  return {
    id: data.pedido_id,
    referencia_corta: data.referencia_corta,
    cliente: data.cliente,
    total: data.total,
  };
}

// Resuelve la referencia de modificar_pedido_no_confirmado reusando
// diagnosticar_pedido (misma RPC validada contra empresa_id + 6 caracteres
// finales que ya usan diagnosticar_pedido / buscarPedidoSugeridoPropio) en
// vez de reimplementar el matching. Solo deja pasar pedidos en 'borrador'
// (el único estado "no confirmado" en ESTADOS_VALIDOS del handler real:
// borrador/confirmado/preparando/despachado/entregado/cancelado) — un
// pedido ya confirmado no se toca con esta tool.
async function buscarPedidoBorradorPorTexto({ empresaId, texto }) {
  const ref = String(texto || '').replace('#', '').trim();
  if (!ref) throw new Error('Falta la referencia del pedido.');

  const { data, error } = await db.rpc('diagnosticar_pedido', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) throw new Error(`No se pudo verificar el pedido: ${error.message}`);
  if (!data?.encontrado) {
    throw new Error(data?.ambiguo ? 'Esa referencia coincide con más de un pedido, pedile al usuario el ID corto completo.' : 'No se encontró ningún pedido con esa referencia en esta empresa.');
  }
  if (data.estado_pedido !== 'borrador') {
    throw new Error(`Ese pedido está en estado "${data.estado_pedido}", no en borrador — ya fue confirmado y esta tool no permite tocarlo.`);
  }
  return { id: data.pedido_id, numero: data.referencia_corta, cliente_nombre: data.cliente };
}

// Resuelve un pedido por referencia SIN restricción de estado (a diferencia
// de buscarPedidoBorradorPorTexto) — usada por registrar_devolucion_pedido,
// que aplica típicamente sobre pedidos ya despachados/entregados. Reusa
// diagnosticar_pedido para el matching seguro por empresa_id, y hace un
// segundo select acotado por empresa_id para traer cliente_id real (la RPC
// solo devuelve el nombre del cliente para mostrar, no el id).
async function buscarPedidoPropioPorTexto({ empresaId, texto }) {
  const ref = String(texto || '').replace('#', '').trim();
  if (!ref) throw new Error('Falta la referencia del pedido.');

  const { data, error } = await db.rpc('diagnosticar_pedido', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) throw new Error(`No se pudo verificar el pedido: ${error.message}`);
  if (!data?.encontrado) {
    throw new Error(data?.ambiguo ? 'Esa referencia coincide con más de un pedido, pedile al usuario el ID corto completo.' : 'No se encontró ningún pedido con esa referencia en esta empresa.');
  }

  const { data: pedidoRow, error: errPedido } = await db.from('pedidos')
    .select('id, cliente_id')
    .eq('id', data.pedido_id)
    .eq('empresa_id', empresaId)
    .single();
  if (errPedido) throw new Error(`No se pudo verificar el pedido: ${errPedido.message}`);
  if (!pedidoRow.cliente_id) throw new Error('Ese pedido no tiene un cliente asociado; no se puede registrar la devolución.');

  return { id: pedidoRow.id, cliente_id: pedidoRow.cliente_id, referencia_corta: data.referencia_corta, cliente_nombre: data.cliente };
}

// Resuelve y valida el pedido a cancelar. Reusa diagnosticar_pedido, que
// YA trae estado_pedido + factura_estado/numero en una sola llamada — no
// hace falta una consulta aparte para saber si hay una factura con CAE de
// por medio (necesario para el aviso de Nota de Crédito en el resumen).
// Rechaza 'entregado'/'cancelado', mismo criterio que la rama DELETE real.
async function diagnosticoPedidoParaCancelar({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim();
  if (!ref) throw new Error('Falta la referencia del pedido.');

  const { data, error } = await db.rpc('diagnosticar_pedido', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) throw new Error(`No se pudo verificar el pedido: ${error.message}`);
  if (!data?.encontrado) {
    throw new Error(data?.ambiguo ? 'Esa referencia coincide con más de un pedido, pedile al usuario el ID corto completo.' : 'No se encontró ningún pedido con esa referencia en esta empresa.');
  }
  if (['entregado', 'cancelado'].includes(data.estado_pedido)) {
    throw new Error(`No se puede cancelar un pedido ${data.estado_pedido}.`);
  }
  return data;
}

// Motivos válidos de `devoluciones.motivo` (check constraint real, se
// confirmó contra el schema antes de escribir esto — coincide con
// MOTIVOS_VALIDOS de crearDevolucionCore).
const MOTIVOS_DEVOLUCION_VALIDOS = ['producto_defectuoso', 'error_pedido', 'cliente_arrepentido', 'vencido', 'otro'];

// Resuelve TODO lo que necesita registrar_devolucion_pedido (pedido +
// motivo + cada item) a partir de los args de texto libre — se llama por
// separado desde resumen() y execute(), mismo criterio que
// resolverPedidoDesdeArgs/resolverTransferenciaStock: nunca se reusa un id
// resuelto entre la propuesta y la confirmación.
async function resolverDevolucionPedido({ empresaId, args }) {
  const motivo = String(args.motivo || '').trim();
  if (!MOTIVOS_DEVOLUCION_VALIDOS.includes(motivo)) {
    throw new Error(`Motivo inválido: "${motivo}". Debe ser uno de: ${MOTIVOS_DEVOLUCION_VALIDOS.join(', ')}.`);
  }

  const pedido = await buscarPedidoPropioPorTexto({ empresaId, texto: args.pedido });

  const itemsArg = Array.isArray(args.items) ? args.items : [];
  if (!itemsArg.length) throw new Error('La devolución necesita al menos un producto con su cantidad.');

  const itemsResueltos = [];
  for (const item of itemsArg) {
    const cantidad = Number(item.cantidad);
    if (!cantidad || cantidad <= 0) throw new Error(`Cantidad inválida para "${item.producto}".`);
    const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
    itemsResueltos.push({ id: producto.id, nombre: producto.nombre, cantidad, precio_unitario: Number(item.precio_unitario) || 0 });
  }

  return { pedido, motivo, itemsResueltos };
}

// Resuelve la referencia corta (últimos 6 caracteres del UUID, como en
// anular_venta_pos) de un movimiento bancario. No existe una RPC
// diagnosticar_movimiento_bancario, así que se filtra en JS contra los
// movimientos de ESTA empresa nada más — nunca se compara la referencia
// contra otra empresa. `estadoRequerido` deja usar el mismo helper tanto
// para conciliar (requiere 'pendiente') como para deshacer (requiere
// 'conciliado'), cada uno con su propio mensaje de error si no matchea.
async function buscarMovimientoBancarioPorReferencia({ empresaId, referencia, estadoRequerido = 'pendiente' }) {
  const ref = String(referencia || '').replace('#', '').trim().toUpperCase();
  if (!ref) throw new Error('Falta la referencia del movimiento bancario.');

  const { data, error } = await db.from('conciliacion_bancaria_movimientos')
    .select('id, fecha, descripcion, monto, tipo, estado')
    .eq('empresa_id', empresaId)
    .eq('estado', estadoRequerido);
  if (error) throw new Error(`No se pudo buscar el movimiento: ${error.message}`);

  const candidatos = (data || []).filter((m) => m.id.toUpperCase() === ref || m.id.slice(-6).toUpperCase() === ref);
  if (!candidatos.length) {
    throw new Error(
      estadoRequerido === 'pendiente'
        ? `No encontré ningún movimiento pendiente con la referencia "${ref}". Puede que ya esté conciliado, o que la referencia esté mal — pedile al usuario que confirme los 6 caracteres.`
        : `No encontré ningún movimiento conciliado con la referencia "${ref}".`,
    );
  }
  if (candidatos.length > 1) throw new Error(`Esa referencia coincide con más de un movimiento. Pedile al usuario el UUID completo.`);
  return candidatos[0];
}

// Corre conciliacion_buscar_candidatos y devuelve los candidatos crudos
// (con cobro_id real, uuid completo) — nunca se expone el uuid completo
// al modelo (ver los .slice(-6) en las tools), solo se usa acá adentro
// para el matching de resolverMatchConciliacion.
async function buscarCandidatosDeMovimiento({ empresaId, movimientoId }) {
  const { data, error } = await db.rpc('conciliacion_buscar_candidatos', {
    p_movimiento_id: movimientoId,
    p_empresa_id: empresaId,
  });
  if (error) throw new Error(`No se pudieron buscar candidatos: ${error.message}`);
  return data || [];
}

// Resuelve confirmar_conciliacion_bancaria de punta a punta: movimiento +
// candidato de cobro, EXIGIENDO que el cobro siga figurando entre los
// candidatos vigentes de conciliacion_buscar_candidatos para ese
// movimiento en este mismo instante — así nunca se concilia un cobro que
// el modelo (o el usuario) tipeó de una referencia vieja/de otra consulta
// que ya no aplica.
async function resolverMatchConciliacion({ empresaId, args }) {
  const movimiento = await buscarMovimientoBancarioPorReferencia({ empresaId, referencia: args.referencia_movimiento });
  const refCobro = String(args.referencia_cobro || '').replace('#', '').trim().toUpperCase();
  if (!refCobro) throw new Error('Falta la referencia del cobro a conciliar.');

  const candidatos = await buscarCandidatosDeMovimiento({ empresaId, movimientoId: movimiento.id });
  const candidato = candidatos.find((c) => c.cobro_id.slice(-6).toUpperCase() === refCobro);
  if (!candidato) {
    throw new Error(`El cobro "${refCobro}" ya no es un candidato vigente para este movimiento. Volvé a llamar consultar_candidatos_conciliacion y elegí uno de la lista actual.`);
  }
  return {
    movimiento: { id: movimiento.id, fecha: movimiento.fecha, descripcion: movimiento.descripcion, monto: movimiento.monto },
    candidato,
  };
}

// Resuelve conciliar_lote_automatico por texto libre: primero intenta
// contra el ID corto (6 caracteres, mismo criterio que movimientos), y si
// no matchea nada prueba un ILIKE parcial contra nombre_archivo (el único
// dato "humano" que tiene un lote — no hay una RPC de búsqueda aproximada
// para lotes). Ambigüedad en cualquiera de los dos casos → error pidiendo
// precisar, nunca se adivina cuál.
async function buscarLoteConciliacionPorReferencia({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim();
  if (!ref) throw new Error('Falta indicar qué lote de conciliación bancaria.');
  const refUpper = ref.toUpperCase();

  const { data, error } = await db.from('conciliacion_bancaria_lotes')
    .select('id, nombre_archivo, cantidad_movimientos, cantidad_conciliados, created_at')
    .eq('empresa_id', empresaId);
  if (error) throw new Error(`No se pudo buscar el lote: ${error.message}`);

  const porId = (data || []).filter((l) => l.id.toUpperCase() === refUpper || l.id.slice(-6).toUpperCase() === refUpper);
  if (porId.length === 1) return porId[0];
  if (porId.length > 1) throw new Error(`Esa referencia coincide con más de un lote. Pedile al usuario el UUID completo.`);

  const porNombre = (data || []).filter((l) => (l.nombre_archivo || '').toLowerCase().includes(ref.toLowerCase()));
  if (porNombre.length === 1) return porNombre[0];
  if (porNombre.length > 1) {
    const nombres = porNombre.slice(0, 5).map((l) => l.nombre_archivo).join(', ');
    throw new Error(`Hay más de un lote parecido a "${ref}" (${nombres}). Pedile al usuario que precise cuál, o el ID corto de 6 caracteres.`);
  }
  throw new Error(`No encontré ningún lote de conciliación bancaria parecido a "${ref}". Pedile al usuario el nombre del archivo importado, o el ID corto (ver listar_lotes_conciliacion_bancaria).`);
}

// Mismos defaults que conciliacion_auto_matchear_lote (1 día, $0.50) —
// intencionalmente más estrictos que los de conciliacion_buscar_candidatos
// (3 días, $1) porque acá no hay revisión humana antes de conciliar.
function resolverToleranciasAutoMatch(args) {
  const toleranciaDias = Number(args.tolerancia_dias) > 0 ? Number(args.tolerancia_dias) : 1;
  const toleranciaMonto = Number(args.tolerancia_monto) >= 0 ? Number(args.tolerancia_monto) : 0.5;
  return { toleranciaDias, toleranciaMonto };
}

// Dry-run del resumen de conciliar_lote_automatico: cuenta, de los
// movimientos pendientes del lote, cuántos tienen exactamente 1 candidato
// con las tolerancias dadas (que es justo el criterio que usa la RPC real
// para decidir a cuáles les entra sola) — así el resumen que ve el usuario
// antes de confirmar coincide con lo que realmente va a pasar.
async function contarMatchesAutomaticosLote({ empresaId, loteId, toleranciaDias, toleranciaMonto }) {
  const { data, error } = await db.from('conciliacion_bancaria_movimientos')
    .select('id')
    .eq('empresa_id', empresaId)
    .eq('lote_id', loteId)
    .eq('estado', 'pendiente');
  if (error) throw new Error(`No se pudo revisar el lote: ${error.message}`);

  const pendientes = data || [];
  let conUnico = 0;
  for (const m of pendientes) {
    const { data: candidatos, error: errorCand } = await db.rpc('conciliacion_buscar_candidatos', {
      p_movimiento_id: m.id,
      p_empresa_id: empresaId,
      p_tolerancia_dias: toleranciaDias,
      p_tolerancia_monto: toleranciaMonto,
    });
    if (errorCand) throw new Error(`No se pudieron revisar candidatos del lote: ${errorCand.message}`);
    if ((candidatos || []).length === 1) conUnico += 1;
  }
  return { totalPendientes: pendientes.length, conUnico };
}

// Mismo criterio de resolución que usa la RPC real consultar_deuda_proveedor
// (ILIKE contra razon_social y nombre_fantasia) — se leyó su
// pg_get_functiondef() antes de escribir esto para no usar un criterio de
// matching distinto entre las dos tools de proveedor. No hay una RPC de
// búsqueda aproximada (pg_trgm) para proveedores como sí hay para
// clientes/productos, así que un ILIKE simple alcanza (universo chico).
async function buscarProveedorPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar de qué proveedor.');

  const { data, error } = await db.from('proveedores')
    .select('id, razon_social, nombre_fantasia, activo')
    .eq('empresa_id', empresaId)
    .or(`razon_social.ilike.%${t}%,nombre_fantasia.ilike.%${t}%`);
  if (error) throw new Error(`No se pudo buscar el proveedor: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ningún proveedor parecido a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((p) => p.nombre_fantasia || p.razon_social).join(', ');
    throw new Error(`Hay más de un proveedor parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return { id: data[0].id, nombre: data[0].nombre_fantasia || data[0].razon_social };
}

// Réplica mínima de fetchBcra() de lib/handlers/bcra.js — ese archivo solo
// exporta el handler default, no la función interna, así que se reimplementa
// acá (mismo timeout, mismo manejo de 404 = "sin registros" en vez de
// error). Mismo BASE URL, sin API key (API pública gratuita del BCRA).
const BCRA_BASE = 'https://api.bcra.gob.ar';
const BCRA_TIMEOUT_MS = 8000;

async function fetchBcraDirecto(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BCRA_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BCRA_BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (resp.status === 404) return { notFound: true };
    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      throw new Error(`BCRA respondió ${resp.status}${texto ? `: ${texto.slice(0, 200)}` : ''}`);
    }
    const json = await resp.json();
    return { data: json };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('BCRA no respondió a tiempo (timeout).');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Resuelve el CUIT a consultar en BCRA: directo si lo dieron, o buscando
// por nombre en clientes/proveedores de ESTA empresa (nunca se compara
// contra otra empresa). A diferencia de buscarClientePorTexto/
// buscarProveedorPorTexto (pensados para acciones sobre ESE registro), acá
// solo hace falta el CUIT, así que se resuelve con una consulta propia en
// vez de reusar esos helpers (que no traen la columna cuit).
async function resolverCuitParaBcra({ empresaId, args }) {
  const cuitDirecto = String(args.cuit || '').replace(/\D/g, '');
  if (cuitDirecto) {
    if (cuitDirecto.length !== 11) throw new Error('El CUIT/CUIL debe tener 11 dígitos.');
    return cuitDirecto;
  }

  if (args.cliente) {
    const t = String(args.cliente).trim();
    const { data, error } = await db.from('clientes')
      .select('id, razon_social, nombre_fantasia, cuit')
      .eq('empresa_id', empresaId)
      .or(`razon_social.ilike.%${t}%,nombre_fantasia.ilike.%${t}%`);
    if (error) throw new Error(`No se pudo buscar el cliente: ${error.message}`);
    if (!data?.length) throw new Error(`No encontré ningún cliente parecido a "${t}".`);
    if (data.length > 1) throw new Error(`Hay más de un cliente parecido a "${t}". Pedile al usuario que precise cuál.`);
    if (!data[0].cuit) throw new Error(`El cliente "${t}" no tiene CUIT cargado.`);
    return String(data[0].cuit).replace(/\D/g, '');
  }

  if (args.proveedor) {
    const t = String(args.proveedor).trim();
    const { data, error } = await db.from('proveedores')
      .select('id, razon_social, nombre_fantasia, cuit')
      .eq('empresa_id', empresaId)
      .or(`razon_social.ilike.%${t}%,nombre_fantasia.ilike.%${t}%`);
    if (error) throw new Error(`No se pudo buscar el proveedor: ${error.message}`);
    if (!data?.length) throw new Error(`No encontré ningún proveedor parecido a "${t}".`);
    if (data.length > 1) throw new Error(`Hay más de un proveedor parecido a "${t}". Pedile al usuario que precise cuál.`);
    if (!data[0].cuit) throw new Error(`El proveedor "${t}" no tiene CUIT cargado.`);
    return String(data[0].cuit).replace(/\D/g, '');
  }

  throw new Error('Falta el CUIT, o el nombre de un cliente/proveedor para resolverlo.');
}

// Dedupe de crear_proveedor: sin unique constraint a nivel DB ni en
// razon_social ni en cuit (se verificó contra el schema real), así que el
// chequeo se hace acá — primero por CUIT exacto si lo dieron (es el
// identificador real del negocio y puede repetirse con razón social
// ligeramente distinta), y si no por ILIKE exacto de razón social dentro
// de la misma empresa. A diferencia de buscarProveedorPorTexto (que
// resuelve un proveedor existente para lectura), acá un resultado ambiguo
// no es error: alcanza con saber si ya existe alguno para no duplicar.
async function buscarProveedorExistente({ empresaId, razonSocial, cuit }) {
  const cuitLimpio = String(cuit || '').trim();
  if (cuitLimpio) {
    const { data, error } = await db.from('proveedores')
      .select('id, razon_social, nombre_fantasia')
      .eq('empresa_id', empresaId)
      .eq('cuit', cuitLimpio)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`No se pudo verificar proveedores existentes: ${error.message}`);
    if (data) return { id: data.id, nombre: data.nombre_fantasia || data.razon_social, motivo: 'cuit' };
  }
  const { data, error } = await db.from('proveedores')
    .select('id, razon_social, nombre_fantasia')
    .eq('empresa_id', empresaId)
    .ilike('razon_social', razonSocial)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo verificar proveedores existentes: ${error.message}`);
  if (data) return { id: data.id, nombre: data.nombre_fantasia || data.razon_social, motivo: 'razon_social' };
  return null;
}

// Dedupe de crear_cliente: mismo criterio que buscarProveedorExistente
// (arriba), contra la tabla `clientes` — CUIT exacto primero si lo dieron,
// si no ILIKE exacto de razón social dentro de la misma empresa. No usa
// buscarClientePorTexto() (la de más arriba, para resolver un cliente
// existente en crear_pedido) porque esa tira error si hay ambigüedad —
// acá un resultado ambiguo no es error: alcanza con saber si ya existe
// alguno para no duplicar.
async function buscarClienteExistente({ empresaId, razonSocial, cuit }) {
  const cuitLimpio = String(cuit || '').trim();
  if (cuitLimpio) {
    const { data, error } = await db.from('clientes')
      .select('id, razon_social, nombre_fantasia')
      .eq('empresa_id', empresaId)
      .eq('cuit', cuitLimpio)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`No se pudo verificar clientes existentes: ${error.message}`);
    if (data) return { id: data.id, nombre: data.nombre_fantasia || data.razon_social, motivo: 'cuit' };
  }
  const { data, error } = await db.from('clientes')
    .select('id, razon_social, nombre_fantasia')
    .eq('empresa_id', empresaId)
    .ilike('razon_social', razonSocial)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo verificar clientes existentes: ${error.message}`);
  if (data) return { id: data.id, nombre: data.nombre_fantasia || data.razon_social, motivo: 'razon_social' };
  return null;
}

// Fase B — helper de editar_cliente_asistente: arma el objeto `cambios`
// para actualizarClienteRepo() y un resumen legible en español para
// resumen(), a partir de los args que mandó el modelo. Solo entran los
// campos que el usuario efectivamente pidió cambiar (undefined/null/''
// se ignoran) — mismo criterio de "solo lo que se pidió" que el resto de
// las tools de edición parcial del archivo.
const CAMPOS_CLIENTE_EDITABLES = [
  ['razon_social', 'razón social'],
  ['nombre_fantasia', 'nombre de fantasía'],
  ['cuit', 'CUIT'],
  ['condicion_iva', 'condición de IVA'],
  ['telefono', 'teléfono'],
  ['email', 'email'],
  ['domicilio', 'domicilio'],
  ['localidad', 'localidad'],
  ['notas', 'notas'],
];

function construirCambiosCliente(args) {
  const cambios = {};
  const resumenCambios = [];
  for (const [campo, label] of CAMPOS_CLIENTE_EDITABLES) {
    const valor = args[campo];
    const v = typeof valor === 'string' ? valor.trim() : valor;
    if (v === undefined || v === null || v === '') continue;
    cambios[campo] = v;
    resumenCambios.push(`${label}: "${v}"`);
  }
  if (args.reactivar === true) {
    cambios.activo = true;
    resumenCambios.push('reactivar (vuelve a estar activo)');
  }
  return { cambios, resumenCambios };
}

// Resuelve un depósito por texto libre dentro de la empresa. Igual criterio
// que buscarProveedorPorTexto/buscarRecompensaPorTexto: universo chico por
// empresa (se vio en datos reales: 2-3 depósitos), no hay RPC de búsqueda
// aproximada para depósitos, así que ILIKE simple alcanza; 0 o ambiguo →
// error concreto, nunca adivinar.
async function buscarDepositoPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar el depósito.');

  const { data, error } = await db.from('depositos')
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar el depósito: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ningún depósito parecido a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((d) => d.nombre).join(', ');
    throw new Error(`Hay más de un depósito parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// Resuelve TODO lo que necesita transferir_stock_asistente: producto +
// depósito origen + depósito destino + cantidad. Se llama por separado
// desde resumen() y desde execute() (nunca se reusa un id resuelto entre
// la propuesta y la confirmación — mismo criterio que resolverPedidoDesdeArgs).
// La RPC transferir_stock() ya rechaza origen==destino y valida que ambos
// depósitos sean de la MISMA empresa entre sí, pero no valida que sean de
// ESTA empresa cuando se llama con service_role (ver comentario arriba de
// la tool) — por eso acá se resuelven ambos depósitos con
// buscarDepositoPorTexto, que ya filtra por empresaId.
async function resolverTransferenciaStock({ empresaId, args }) {
  const cantidad = Number(args.cantidad);
  if (!cantidad || cantidad <= 0) throw new Error('La cantidad a transferir debe ser mayor a cero.');

  const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
  const depOrigen = await buscarDepositoPorTexto({ empresaId, texto: args.deposito_origen });
  const depDestino = await buscarDepositoPorTexto({ empresaId, texto: args.deposito_destino });

  if (depOrigen.id === depDestino.id) {
    throw new Error('El depósito de origen y destino no pueden ser el mismo.');
  }
  return { producto, depOrigen, depDestino, cantidad };
}

// Resuelve ajustar_stock_asistente: mismo patrón que resolverTransferenciaStock
// (producto + depósito por texto libre, cantidad > 0), pero de un solo
// depósito. El motivo ya viene validado por el enum del JSON Schema de la
// tool, así que acá solo se lo devuelve tal cual para que resumen()/execute()
// decidan la rama (producir_con_insumos vs ajustar_stock).
async function resolverAjusteStock({ empresaId, args }) {
  const cantidad = Number(args.cantidad);
  if (!cantidad || cantidad <= 0) throw new Error('La cantidad debe ser mayor a cero.');

  const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
  const deposito = await buscarDepositoPorTexto({ empresaId, texto: args.deposito });
  const motivo = args.motivo || 'ajuste_manual';

  return { producto, deposito, cantidad, motivo };
}

// Resuelve registrar_conteo_stock_asistente: producto + depósito por texto
// libre, cantidad_contada >= 0 (0 es válido — "contamos que no queda nada").
async function resolverConteoStock({ empresaId, args }) {
  const cantidadContada = Number(args.cantidad_contada);
  if (args.cantidad_contada === undefined || args.cantidad_contada === null || Number.isNaN(cantidadContada) || cantidadContada < 0) {
    throw new Error('La cantidad contada debe ser un número mayor o igual a cero.');
  }

  const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
  const deposito = await buscarDepositoPorTexto({ empresaId, texto: args.deposito });

  return { producto, deposito, cantidadContada };
}

// Resuelve crear_orden_compra_asistente: proveedor por texto libre (reusa
// buscarProveedorPorTexto, ya existente para otra tool) + cada item de la
// lista resuelto contra buscar_productos_asistente (mismo criterio de
// "un candidato claro o preguntar" que el resto del asistente — nunca se le
// confía al modelo un producto_id).
async function resolverOrdenCompraDesdeArgs({ empresaId, args }) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length) throw new Error('La orden de compra necesita al menos un producto.');

  const proveedor = await buscarProveedorPorTexto({ empresaId, texto: args.proveedor });

  const itemsResueltos = [];
  for (const item of items) {
    const cantidad = Number(item.cantidad);
    if (!cantidad || cantidad <= 0) throw new Error(`La cantidad de "${item.producto}" debe ser mayor a cero.`);
    const precioCosto = Number(item.precio_costo);
    if (!precioCosto || precioCosto <= 0) throw new Error(`El precio de costo de "${item.producto}" debe ser mayor a cero.`);

    const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
    itemsResueltos.push({
      producto_id: producto.id,
      nombre: producto.nombre,
      cantidad,
      precio_costo: precioCosto,
    });
  }

  return { proveedor, itemsResueltos };
}

// Resuelve recepcionar_orden_compra_asistente: busca la OC por número
// (ilike, dentro de la empresa), el depósito destino opcional, y arma la
// lista de renglones a recepcionar — o bien lo que el usuario puntualizó
// (validado contra los renglones reales de la orden, para no aceptar un
// producto que la OC no tiene), o bien TODO lo pendiente
// (cantidad - cantidad_recibida de cada renglón) si no dio nada.
async function resolverRecepcionOrdenCompra({ empresaId, args }) {
  const numero = String(args.numero_oc || '').trim();
  if (!numero) throw new Error('Falta indicar el número de la orden de compra.');

  const { data: ordenes, error } = await db.from('ordenes_compra')
    .select('id, numero, estado, proveedor_id')
    .eq('empresa_id', empresaId)
    .ilike('numero', `%${numero}%`)
    .order('created_at', { ascending: false })
    .limit(6);
  if (error) throw new Error(`No se pudo buscar la orden de compra: ${error.message}`);
  if (!ordenes?.length) throw new Error(`No encontré ninguna orden de compra con número "${numero}".`);
  if (ordenes.length > 1) {
    const numeros = ordenes.map((o) => o.numero).join(', ');
    throw new Error(`Hay más de una orden de compra parecida a "${numero}" (${numeros}). Pedile al usuario el número exacto.`);
  }
  const orden = ordenes[0];

  if (orden.estado === 'cancelada') throw new Error(`La orden ${orden.numero} está cancelada, no se puede recepcionar.`);
  if (orden.estado === 'recibida') throw new Error(`La orden ${orden.numero} ya fue recibida por completo.`);

  const deposito = args.deposito ? await buscarDepositoPorTexto({ empresaId, texto: args.deposito }) : null;

  const { data: renglones, error: errItems } = await db.from('ordenes_compra_items')
    .select('producto_id, descripcion, cantidad, cantidad_recibida, precio_costo, productos(nombre)')
    .eq('orden_compra_id', orden.id);
  if (errItems) throw new Error(`No se pudo leer los renglones de la orden: ${errItems.message}`);

  const argItems = Array.isArray(args.items) ? args.items : [];
  let itemsAReceptionar;

  if (argItems.length) {
    itemsAReceptionar = [];
    for (const item of argItems) {
      const cantidadRecibida = Number(item.cantidad_recibida);
      if (!cantidadRecibida || cantidadRecibida <= 0) {
        throw new Error(`La cantidad recibida de "${item.producto}" debe ser mayor a cero.`);
      }
      const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
      const renglon = (renglones || []).find((r) => r.producto_id === producto.id);
      if (!renglon) {
        throw new Error(`"${producto.nombre}" no está en la orden ${orden.numero}.`);
      }
      itemsAReceptionar.push({
        producto_id: producto.id,
        nombre: producto.nombre,
        cantidad_recibida: cantidadRecibida,
        precio_costo: Number(renglon.precio_costo) || 0,
      });
    }
  } else {
    itemsAReceptionar = (renglones || [])
      .map((r) => ({
        producto_id: r.producto_id,
        nombre: r.productos?.nombre || r.descripcion || 'producto',
        cantidad_recibida: Number(r.cantidad) - Number(r.cantidad_recibida || 0),
        precio_costo: Number(r.precio_costo) || 0,
      }))
      .filter((r) => r.producto_id && r.cantidad_recibida > 0);
  }

  return { orden, deposito, itemsAReceptionar };
}

// Whitelist estricta de columnas de notif_prefs_auto que se pueden tocar
// desde el asistente: aunque `preferencia` ya viene acotado por el enum
// del JSON Schema, esto es la última barrera antes de armar el objeto de
// un `.update()` — nunca se interpola el nombre de columna de otra forma.
const COLUMNAS_PREFS_NOTIF = [
  'piloto_sugerencia', 'cierre_cliente_bloqueado', 'cierre_error_cola', 'stock_quiebre',
  'stock_orden_auto', 'score_caida_critica', 'auditoria_anomalia', 'migracion_sesion_error',
  'stock_sin_proveedor', 'rentabilidad_zona_semanal',
];

function validarColumnaPreferenciaNotificacion(preferencia) {
  if (!COLUMNAS_PREFS_NOTIF.includes(preferencia)) {
    throw new Error(`Preferencia de notificación no reconocida: "${preferencia}".`);
  }
  return preferencia;
}

async function obtenerPreferenciaNotificacionActual({ empresaId, preferencia }) {
  const columna = validarColumnaPreferenciaNotificacion(preferencia);
  const { data, error } = await db.from('notif_prefs_auto')
    .select(columna)
    .eq('empresa_id', empresaId)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer la preferencia actual: ${error.message}`);
  if (!data) throw new Error('Esta empresa todavía no tiene preferencias de notificaciones configuradas.');
  return Boolean(data[columna]);
}

// Umbral y margen para decidir si el mejor resultado de una búsqueda
// aproximada (ver buscar_clientes_asistente/buscar_productos_asistente,
// migración 420, con pg_trgm) es lo bastante claro como para elegirlo
// solo, sin pedirle al usuario que desambigüe. Pensado para el margen de
// error típico de transcribir por voz un nombre — "suena parecido" no
// siempre coincide letra por letra — sin por eso arriesgarse a adivinar
// mal a qué cliente o producto se refería si hay dos opciones parecidas
// entre sí (ahí sí conviene preguntar, nunca tirar una moneda).
const SIMILITUD_MINIMA_AUTOELEGIR = 0.35;
const MARGEN_MINIMO_SOBRE_SIGUIENTE = 0.15;

// candidatos ya viene ordenado por similitud DESC (así lo devuelven las
// funciones de la migración 420). Devuelve el candidato a usar sin
// preguntar, o null si hace falta desambiguar con el usuario.
function elegirMejorCandidato(candidatos) {
  if (candidatos.length === 1) return candidatos[0];
  const [mejor, segundo] = candidatos;
  const mejorSimilitud = mejor.similitud ?? 1; // 1 = vino de un ILIKE exacto sin similarity() de por medio
  const segundaSimilitud = segundo?.similitud ?? 0;
  const esClaro = mejorSimilitud >= SIMILITUD_MINIMA_AUTOELEGIR && (mejorSimilitud - segundaSimilitud) >= MARGEN_MINIMO_SOBRE_SIGUIENTE;
  return esClaro ? mejor : null;
}

async function buscarCandidatosAsistente({ rpc, empresaId, texto }) {
  const { data, error } = await db.rpc(rpc, { p_empresa_id: empresaId, p_texto: texto, p_limite: 6 });
  if (error) throw new Error(`No se pudo buscar: ${error.message}`);
  return data || [];
}

// Resuelve el cliente de `crear_pedido` a partir del texto libre que dio el
// usuario (nombre, razón social, CUIT, teléfono, o una versión mal
// transcripta por voz de cualquiera de esos). Nunca se le confía al modelo
// un cliente_id: si no hay ningún candidato, o hay más de uno y ninguno se
// destaca con claridad (ver elegirMejorCandidato), se tira una excepción
// con una pregunta concreta para que el modelo se la repita al usuario en
// vez de adivinar.
async function buscarClientePorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar a qué cliente es el pedido.');

  const candidatos = await buscarCandidatosAsistente({ rpc: 'buscar_clientes_asistente', empresaId, texto: t });
  if (!candidatos.length) throw new Error(`No encontré ningún cliente parecido a "${t}". Pedile al usuario el nombre, el CUIT o el teléfono.`);

  const elegido = elegirMejorCandidato(candidatos);
  if (!elegido) {
    const nombres = candidatos.slice(0, 5).map((c) => c.razon_social).join(', ');
    throw new Error(`Hay más de un cliente parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál, con el nombre completo o el CUIT.`);
  }
  if (!elegido.activo) throw new Error(`El cliente "${elegido.razon_social}" está inactivo, no se le pueden cargar pedidos.`);
  return elegido;
}

// Misma búsqueda aproximada que buscarClientePorTexto (mismo RPC, mismo
// criterio de "un candidato claro o preguntar"), pero SIN el bloqueo por
// `activo` — a diferencia de crear_pedido, cobrar una deuda vieja de un
// cliente que después se dio de baja es un caso válido (es, de hecho, la
// razón más común para terminar de cobrarle a alguien inactivo).
async function buscarClienteParaCobroPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar a qué cliente es el cobro.');

  const candidatos = await buscarCandidatosAsistente({ rpc: 'buscar_clientes_asistente', empresaId, texto: t });
  if (!candidatos.length) throw new Error(`No encontré ningún cliente parecido a "${t}". Pedile al usuario el nombre, el CUIT o el teléfono.`);

  const elegido = elegirMejorCandidato(candidatos);
  if (!elegido) {
    const nombres = candidatos.slice(0, 5).map((c) => c.razon_social).join(', ');
    throw new Error(`Hay más de un cliente parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál, con el nombre completo o el CUIT.`);
  }
  return elegido;
}

const MEDIOS_COBRO_TEXTO = {
  efectivo: 'efectivo',
  transferencia: 'transferencia',
  cheque: 'cheque',
  otro: 'otro medio',
};

// Resuelve un único item de `crear_pedido` (nombre de producto en texto
// libre + cantidad) a un producto_id real. Mismo criterio que
// buscarClientePorTexto: 0 candidatos, o varios sin uno que se destaque
// con claridad, es una excepción con pregunta concreta, nunca una
// adivinanza.
async function buscarProductoPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta el nombre de un producto en el pedido.');

  const candidatos = await buscarCandidatosAsistente({ rpc: 'buscar_productos_asistente', empresaId, texto: t });
  if (!candidatos.length) throw new Error(`No encontré ningún producto parecido a "${t}". Pedile al usuario que aclare el nombre.`);

  const elegido = elegirMejorCandidato(candidatos);
  if (!elegido) {
    const nombres = candidatos.slice(0, 5).map((p) => p.nombre).join(', ');
    throw new Error(`Hay más de un producto parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return elegido;
}

// Fase B del plan (crear/editar regla de precio y de automatización): a
// diferencia de resolverCategoriaPorNombre (match exacto, pensado para
// "creá la categoría X" donde el usuario dicta el nombre tal cual), acá
// se necesita resolver por texto parcial dictado ("la de zona norte"),
// mismo patrón ilike %texto% que buscarDepositoPorTexto/buscarProveedorPorTexto.
async function buscarCategoriaPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const { data, error } = await db.from('categorias')
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la categoría: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna categoría parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((c) => c.nombre).join(', ');
    throw new Error(`Hay más de una categoría parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

async function buscarZonaPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const { data, error } = await db.from('zonas')
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la zona: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna zona parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((z) => z.nombre).join(', ');
    throw new Error(`Hay más de una zona parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// reglas_precio/reglas_automatizacion no tienen búsqueda aproximada por
// pg_trgm (son tablas de configuración chicas, cargadas a mano — mismo
// perfil que categorías/depósitos/zonas), así que se resuelve por nombre
// con el mismo criterio ilike %texto% que el resto de los "buscarXPorTexto"
// de este archivo, en vez de reusar buscarMaestroExistente (que exige
// coincidencia exacta y está pensado para dedupe al crear, no para ubicar
// una regla existente por su nombre dictado parcialmente).
async function buscarReglaPrecioPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar el nombre de la regla de precio.');
  const { data, error } = await db.from('reglas_precio')
    .select('id, nombre, producto_id, categoria_id, zona_id, activa')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la regla de precio: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna regla de precio parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((r) => r.nombre).join(', ');
    throw new Error(`Hay más de una regla de precio parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// Arma los campos completos para crearReglaPrecio a partir de los args de
// crear_regla_precio_asistente. Resuelve producto/categoria/zona por texto
// libre (nunca por id — el modelo solo dicta nombres) y replica acá las
// mismas validaciones que validarCampos() del repo (reglas-precio.js) para
// poder devolver un error claro ANTES de llamar al repo, ya que resumen()
// necesita los campos armados (incluidos los nombres resueltos) para poder
// describir la regla sin tocar la base.
async function armarCamposReglaPrecio({ empresaId, args }) {
  const nombre = String(args.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre de la regla de precio.');
  if (!['porcentaje', 'precio_fijo'].includes(args.tipo_descuento)) {
    throw new Error('El tipo de descuento debe ser "porcentaje" o "precio_fijo".');
  }
  const valor = Number(args.valor);
  if (!Number.isFinite(valor) || valor < 0) {
    throw new Error('El valor del descuento es inválido.');
  }
  if (args.tipo_descuento === 'porcentaje' && valor > 100) {
    throw new Error('Un descuento porcentual no puede superar el 100%.');
  }
  if (args.producto && args.categoria) {
    throw new Error('Elegí producto o categoría para la regla, no las dos a la vez.');
  }
  if (args.fecha_desde && args.fecha_hasta && args.fecha_desde > args.fecha_hasta) {
    throw new Error('La fecha "desde" no puede ser posterior a la fecha "hasta".');
  }

  let producto_id = null, categoria_id = null, zona_id = null;
  let productoNombre = null, categoriaNombre = null, zonaNombre = null;

  if (args.producto) {
    const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
    producto_id = producto.id;
    productoNombre = producto.nombre;
  }
  if (args.categoria) {
    const categoria = await buscarCategoriaPorTexto({ empresaId, texto: args.categoria });
    categoria_id = categoria.id;
    categoriaNombre = categoria.nombre;
  }
  if (args.zona) {
    const zona = await buscarZonaPorTexto({ empresaId, texto: args.zona });
    zona_id = zona.id;
    zonaNombre = zona.nombre;
  }

  return {
    nombre,
    producto_id,
    categoria_id,
    zona_id,
    cantidad_minima: args.cantidad_minima !== undefined ? Number(args.cantidad_minima) : 1,
    tipo_descuento: args.tipo_descuento,
    valor,
    fecha_desde: args.fecha_desde || null,
    fecha_hasta: args.fecha_hasta || null,
    prioridad: args.prioridad !== undefined ? Number(args.prioridad) : 0,
    activa: true,
    // Nombres resueltos, solo para describirReglaPrecio(): crearReglaPrecio
    // destructura explícito los campos que le sirven e ignora el resto, así
    // que llevar estos tres de más en el mismo objeto es inofensivo.
    productoNombre,
    categoriaNombre,
    zonaNombre,
  };
}

function describirReglaPrecio(campos) {
  const alcance = campos.productoNombre
    ? `para el producto "${campos.productoNombre}"`
    : campos.categoriaNombre
      ? `para la categoría "${campos.categoriaNombre}"`
      : 'para todos los productos';
  const zonaTxt = campos.zonaNombre ? `, solo en la zona "${campos.zonaNombre}"` : '';
  const descuentoTxt = campos.tipo_descuento === 'porcentaje'
    ? `${campos.valor}% de descuento`
    : `precio final fijo de $${campos.valor}`;
  const vigenciaTxt = campos.fecha_desde || campos.fecha_hasta
    ? `, vigente ${campos.fecha_desde ? `desde ${campos.fecha_desde}` : ''}${campos.fecha_hasta ? ` hasta ${campos.fecha_hasta}` : ''}`
    : '';
  return `${descuentoTxt} a partir de ${campos.cantidad_minima} unidad(es) ${alcance}${zonaTxt}${vigenciaTxt}`;
}

// Actualizar una regla de precio exige mandar el objeto completo
// (actualizarReglaPrecio valida nombre/tipo_descuento/valor como si fuera
// una creación, aunque el patch real a la base solo escriba las claves
// presentes en `campos` — ver comentario de armarCambiosReglaAutomatizacion,
// que sigue el mismo criterio). Por eso acá se trae la fila actual completa
// y se pisa encima SOLO lo que el usuario pidió cambiar.
async function armarCambiosReglaPrecio({ empresaId, args }) {
  const actual = await buscarReglaPrecioPorTexto({ empresaId, texto: args.referencia });
  const { data: fila, error } = await db.from('reglas_precio')
    .select('nombre, producto_id, categoria_id, zona_id, cantidad_minima, tipo_descuento, valor, fecha_desde, fecha_hasta, prioridad, activa')
    .eq('id', actual.id).eq('empresa_id', empresaId).single();
  if (error || !fila) throw new Error('No se pudo leer la regla de precio actual.');

  const cambios = { ...fila };
  const resumenCambios = [];

  if (args.nombre !== undefined && String(args.nombre).trim()) {
    cambios.nombre = String(args.nombre).trim();
    resumenCambios.push(`nombre: "${cambios.nombre}"`);
  }

  if (args.producto !== undefined && args.categoria !== undefined && args.producto && args.categoria) {
    throw new Error('Elegí producto o categoría para la regla, no las dos a la vez.');
  }
  if (args.producto !== undefined) {
    if (!args.producto) {
      cambios.producto_id = null;
    } else {
      const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
      cambios.producto_id = producto.id;
      cambios.categoria_id = null;
      resumenCambios.push(`producto: "${producto.nombre}"`);
    }
  }
  if (args.categoria !== undefined) {
    if (!args.categoria) {
      cambios.categoria_id = null;
    } else {
      const categoria = await buscarCategoriaPorTexto({ empresaId, texto: args.categoria });
      cambios.categoria_id = categoria.id;
      cambios.producto_id = null;
      resumenCambios.push(`categoría: "${categoria.nombre}"`);
    }
  }
  if (cambios.producto_id && cambios.categoria_id) {
    throw new Error('Una regla de precio no puede tener producto y categoría a la vez — elegí una.');
  }

  if (args.zona !== undefined) {
    if (!args.zona) {
      cambios.zona_id = null;
    } else {
      const zona = await buscarZonaPorTexto({ empresaId, texto: args.zona });
      cambios.zona_id = zona.id;
      resumenCambios.push(`zona: "${zona.nombre}"`);
    }
  }
  if (args.cantidad_minima !== undefined) {
    cambios.cantidad_minima = Number(args.cantidad_minima);
    resumenCambios.push(`cantidad mínima: ${cambios.cantidad_minima}`);
  }
  if (args.tipo_descuento !== undefined) {
    if (!['porcentaje', 'precio_fijo'].includes(args.tipo_descuento)) {
      throw new Error('El tipo de descuento debe ser "porcentaje" o "precio_fijo".');
    }
    cambios.tipo_descuento = args.tipo_descuento;
  }
  if (args.valor !== undefined) {
    const valor = Number(args.valor);
    if (!Number.isFinite(valor) || valor < 0) throw new Error('El valor del descuento es inválido.');
    cambios.valor = valor;
  }
  if (args.tipo_descuento === 'porcentaje' && cambios.valor > 100) {
    throw new Error('Un descuento porcentual no puede superar el 100%.');
  }
  if (args.tipo_descuento !== undefined || args.valor !== undefined) {
    resumenCambios.push(
      cambios.tipo_descuento === 'porcentaje' ? `${cambios.valor}% de descuento` : `precio fijo $${cambios.valor}`
    );
  }
  if (args.fecha_desde !== undefined) {
    cambios.fecha_desde = args.fecha_desde || null;
    resumenCambios.push(`vigente desde ${cambios.fecha_desde || 'sin inicio'}`);
  }
  if (args.fecha_hasta !== undefined) {
    cambios.fecha_hasta = args.fecha_hasta || null;
    resumenCambios.push(`vigente hasta ${cambios.fecha_hasta || 'sin fin'}`);
  }
  if (cambios.fecha_desde && cambios.fecha_hasta && cambios.fecha_desde > cambios.fecha_hasta) {
    throw new Error('La fecha "desde" no puede ser posterior a la fecha "hasta".');
  }
  if (args.prioridad !== undefined) {
    cambios.prioridad = Number(args.prioridad);
    resumenCambios.push(`prioridad ${cambios.prioridad}`);
  }
  if (args.activa !== undefined) {
    cambios.activa = Boolean(args.activa);
    resumenCambios.push(cambios.activa ? 'activarla' : 'pausarla');
  }

  return { cambios, resumenCambios };
}

function resolverRolesAccion(roles) {
  if (roles === undefined) return undefined;
  if (!Array.isArray(roles) || !roles.length) throw new Error('Los roles a notificar/asignar deben ser una lista no vacía.');
  const normalizados = [...new Set(roles.map((r) => String(r || '').trim().toLowerCase()))];
  const invalidos = normalizados.filter((r) => !ROLES_NOTIFICACION_VALIDOS.includes(r));
  if (invalidos.length) {
    throw new Error(`Rol(es) no reconocido(s) para la acción: ${invalidos.join(', ')}. Usar alguno de: ${ROLES_NOTIFICACION_VALIDOS.join(', ')}.`);
  }
  return normalizados;
}

// Arma el objeto `accion` que espera reglas_automatizacion (mismo shape
// que ejecutarAccion() en lib/reglas-automatizacion.js) a partir de los
// campos "planos" que puede dictar el usuario por voz. Solo se exponen acá
// los 3 tipos que soporta el motor (notificar_push/enviar_whatsapp/
// crear_tarea) — mismo validarCampos() del repo, replicado en JS para dar
// un error hablado ANTES de llamar a Supabase, no después.
function armarAccionRegla(args) {
  const tipo = args.accion_tipo;
  if (!tipo) throw new Error('Falta indicar qué debe hacer la regla cuando se dispare (notificar_push, enviar_whatsapp o crear_tarea).');

  if (tipo === 'notificar_push') {
    const titulo = String(args.accion_titulo || '').trim();
    const mensaje = String(args.accion_mensaje || '').trim();
    if (!titulo) throw new Error('La notificación necesita un título.');
    if (!mensaje) throw new Error('La notificación necesita un mensaje.');
    const roles = resolverRolesAccion(args.accion_roles) || ['dueno', 'admin'];
    return { tipo, titulo, mensaje, roles };
  }

  if (tipo === 'crear_tarea') {
    const titulo = String(args.accion_titulo || '').trim();
    if (!titulo) throw new Error('La tarea necesita un título.');
    const roles = resolverRolesAccion(args.accion_roles) || ['dueno', 'admin'];
    return { tipo, titulo, descripcion: args.accion_descripcion?.trim() || undefined, roles };
  }

  if (tipo === 'enviar_whatsapp') {
    const template = args.accion_template;
    if (!template || !TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE.includes(template)) {
      throw new Error(`Template de WhatsApp inválido (debe ser uno de: ${TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE.join(', ')}).`);
    }
    return { tipo, template };
  }

  throw new Error(`Tipo de acción "${tipo}" no soportado. Usar notificar_push, enviar_whatsapp o crear_tarea.`);
}

function describirAccionRegla(accion) {
  if (accion.tipo === 'notificar_push') return `mandar una notificación push a ${accion.roles.join('/')} ("${accion.titulo}")`;
  if (accion.tipo === 'crear_tarea') return `crear una tarea para ${accion.roles.join('/')} ("${accion.titulo}")`;
  if (accion.tipo === 'enviar_whatsapp') return `mandar el WhatsApp "${accion.template}" al cliente del evento`;
  return 'ejecutar una acción';
}

// Condición simple (un solo campo/operador/valor) — mismo shape que arma
// leerCondicionRegla() en el frontend cuando hay una única fila cargada.
// Combinaciones con "y"/"o" de varias condiciones no se exponen por voz
// (no hay forma cómoda de dictar varias condiciones anidadas sin
// ambigüedad) — si el usuario las necesita, se lo remite al panel.
function armarCondicionRegla(args) {
  if (!args.condicion_campo) return {};
  const campo = String(args.condicion_campo).trim();
  const operador = args.condicion_operador;
  if (!['=', '!=', '>', '>=', '<', '<='].includes(operador)) {
    throw new Error('El operador de la condición debe ser uno de: =, !=, >, >=, <, <=.');
  }
  if (args.condicion_valor === undefined || args.condicion_valor === null || args.condicion_valor === '') {
    throw new Error('Falta el valor de la condición.');
  }
  const valorNumerico = Number(args.condicion_valor);
  const valor = args.condicion_valor !== '' && !Number.isNaN(valorNumerico) ? valorNumerico : args.condicion_valor;
  return { campo, operador, valor };
}

const OP_LABELS_CONDICION = { '=': 'es igual a', '!=': 'es distinto de', '>': 'es mayor que', '>=': 'es mayor o igual que', '<': 'es menor que', '<=': 'es menor o igual que' };

function describirCondicionSimpleRegla(c) {
  return `${c.campo} ${OP_LABELS_CONDICION[c.operador] || c.operador} ${c.valor}`;
}

// Por voz solo se puede CREAR una condición simple (ver armarCondicionRegla:
// no se expone combinar con "y"/"o"), pero al LISTAR reglas existentes
// puede haber alguna armada desde el panel con condicion.y/condicion.o
// (mismo shape que arma leerCondicionRegla() en automatizacion.js) — se
// describen igual que describirCondicion() del frontend para no mostrar
// "siempre" en una regla que en realidad tiene condición.
function describirCondicionRegla(condicion) {
  if (!condicion || typeof condicion !== 'object') return 'siempre (sin condición extra)';
  if (Array.isArray(condicion.y) && condicion.y.length) {
    return `solo si ${condicion.y.map(describirCondicionSimpleRegla).join(' Y ')}`;
  }
  if (Array.isArray(condicion.o) && condicion.o.length) {
    return `solo si ${condicion.o.map(describirCondicionSimpleRegla).join(' O ')}`;
  }
  if (!condicion.campo) return 'siempre (sin condición extra)';
  return `solo si ${describirCondicionSimpleRegla(condicion)}`;
}

// Arma los campos completos para crearReglaAutomatizacion. A diferencia
// de reglas_precio, acá no hace falta resolver ningún id por texto libre
// (evento_disparador es un enum fijo, no una entidad de la empresa).
function armarCamposReglaAutomatizacion({ args }) {
  const nombre = String(args.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre de la regla de automatización.');
  if (!EVENTOS_DISPONIBLES_ASISTENTE.includes(args.evento_disparador)) {
    throw new Error(`El evento disparador debe ser uno de: ${EVENTOS_DISPONIBLES_ASISTENTE.join(', ')}.`);
  }
  const accion = armarAccionRegla(args);
  const condicion = armarCondicionRegla(args);
  return {
    nombre,
    descripcion: args.descripcion?.trim() || null,
    evento_disparador: args.evento_disparador,
    condicion,
    accion,
    activa: true,
  };
}

function describirReglaAutomatizacion(campos) {
  return `cuando pase "${campos.evento_disparador}" (${describirCondicionRegla(campos.condicion)}), va a ${describirAccionRegla(campos.accion)}`;
}

// Actualizar una regla de automatización exige mandar el objeto completo
// (actualizarReglaAutomatizacion valida nombre/evento_disparador/accion
// como si fuera una creación — mismo criterio que reglas_precio, calcado
// de que el formulario real siempre manda el estado completo del form, no
// un patch parcial). Por eso acá se trae la fila actual completa y se
// pisa encima SOLO lo que el usuario pidió cambiar, igual que
// armarCambiosReglaPrecio.
// guardarReglasLiquidacion() es un upsert (onConflict empresa_id) que
// escribe TODAS las columnas del payload — a diferencia de
// actualizarReglaPrecio/actualizarReglaAutomatizacion (UPDATE parcial por
// id), acá no hay id para hacer un patch: se trae la fila actual completa
// (o los defaults que ya usa handleLiquidacion() cuando la empresa nunca
// configuró reglas — ver acción 'reglas' del handler) y se pisa encima
// SOLO lo que el usuario pidió cambiar, mismo criterio que el resto de los
// "armarCambios*" de este archivo. Valida rangos básicos (0-100 en los
// porcentajes, orden dias_nivel1 > dias_nivel2 > dias_nivel3) porque acá
// no hay ningún formulario del panel poniendo límites al valor que se
// dicta por voz, a diferencia de cuando se completa a mano.
async function armarCambiosReglaLiquidacion({ empresaId, args }) {
  const actual = (await obtenerReglasLiquidacion(empresaId)) || {
    dias_alerta: 7, dias_nivel1: 3, pct_nivel1: 10,
    dias_nivel2: 1, pct_nivel2: 15, dias_nivel3: 0, pct_nivel3: 25,
    activo: true,
  };

  const cambios = {
    activo: actual.activo !== false,
    dias_alerta: actual.dias_alerta,
    dias_nivel1: actual.dias_nivel1,
    pct_nivel1: actual.pct_nivel1,
    dias_nivel2: actual.dias_nivel2,
    pct_nivel2: actual.pct_nivel2,
    dias_nivel3: actual.dias_nivel3,
    pct_nivel3: actual.pct_nivel3,
  };
  const resumenCambios = [];

  if (args.activo !== undefined) {
    cambios.activo = !!args.activo;
    resumenCambios.push(cambios.activo ? 'activar la liquidación automática' : 'desactivar la liquidación automática');
  }
  if (args.dias_alerta !== undefined) {
    cambios.dias_alerta = Number(args.dias_alerta);
    resumenCambios.push(`radar a partir de ${cambios.dias_alerta} día(s) antes del vencimiento`);
  }

  const niveles = [1, 2, 3];
  for (const n of niveles) {
    const kDias = `dias_nivel${n}`;
    const kPct = `pct_nivel${n}`;
    if (args[kDias] !== undefined) {
      cambios[kDias] = Number(args[kDias]);
      resumenCambios.push(`nivel ${n}: hasta ${cambios[kDias]} día(s) restantes`);
    }
    if (args[kPct] !== undefined) {
      const pct = Number(args[kPct]);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new Error(`El descuento del nivel ${n} tiene que estar entre 0 y 100 (se pidió ${args[kPct]}).`);
      }
      cambios[kPct] = pct;
      resumenCambios.push(`nivel ${n}: ${pct}% de descuento`);
    }
  }

  if (!(cambios.dias_nivel1 > cambios.dias_nivel2 && cambios.dias_nivel2 > cambios.dias_nivel3)) {
    throw new Error(
      `Los días de cada nivel tienen que ir de mayor a menor (nivel 1 > nivel 2 > nivel 3): quedarían ${cambios.dias_nivel1} > ${cambios.dias_nivel2} > ${cambios.dias_nivel3}, revisá los valores.`
    );
  }

  return { cambios, resumenCambios };
}

async function armarCambiosReglaAutomatizacion({ empresaId, args }) {
  const actual = await buscarReglaAutomatizacionPorTexto({ empresaId, texto: args.referencia });
  const { data: fila, error } = await db.from('reglas_automatizacion')
    .select('nombre, descripcion, evento_disparador, condicion, accion, activa')
    .eq('id', actual.id).eq('empresa_id', empresaId).single();
  if (error || !fila) throw new Error('No se pudo leer la regla de automatización actual.');

  const cambios = { ...fila };
  const resumenCambios = [];

  if (args.nombre !== undefined && String(args.nombre).trim()) {
    cambios.nombre = String(args.nombre).trim();
    resumenCambios.push(`nombre: "${cambios.nombre}"`);
  }
  if (args.descripcion !== undefined) {
    cambios.descripcion = args.descripcion?.trim() || null;
    resumenCambios.push('descripción actualizada');
  }
  if (args.evento_disparador !== undefined) {
    if (!EVENTOS_DISPONIBLES_ASISTENTE.includes(args.evento_disparador)) {
      throw new Error(`El evento disparador debe ser uno de: ${EVENTOS_DISPONIBLES_ASISTENTE.join(', ')}.`);
    }
    cambios.evento_disparador = args.evento_disparador;
    resumenCambios.push(`evento: "${args.evento_disparador}"`);
  }
  if (args.condicion_campo !== undefined) {
    cambios.condicion = armarCondicionRegla(args);
    resumenCambios.push(`condición: ${describirCondicionRegla(cambios.condicion)}`);
  }
  if (args.accion_tipo !== undefined) {
    cambios.accion = armarAccionRegla(args);
    resumenCambios.push(`acción: ${describirAccionRegla(cambios.accion)}`);
  }
  if (args.activa !== undefined) {
    cambios.activa = Boolean(args.activa);
    resumenCambios.push(cambios.activa ? 'activarla' : 'pausarla');
  }

  return { cambios, resumenCambios };
}

async function buscarReglaAutomatizacionPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar el nombre de la regla de automatización.');
  const { data, error } = await db.from('reglas_automatizacion')
    .select('id, nombre, evento_disparador, activa')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la regla de automatización: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna regla de automatización parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((r) => r.nombre).join(', ');
    throw new Error(`Hay más de una regla de automatización parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// Resuelve un pedido/presupuesto/venta puntual a partir del NOMBRE del
// cliente en vez del ID corto — para diagnosticar_pedido/presupuesto/
// venta_pos, que hasta acá exigían el ID de entrada aunque el usuario solo
// tuviera el nombre a mano (a diferencia de diagnosticar_cheque, que ya
// buscaba por cliente porque un cheque no tiene ID visible en el panel).
// Reusa buscarClientePorTexto (misma búsqueda aproximada por trigramas que
// ya usa crear_pedido) para resolver el cliente sin adivinar, y después
// trae sus documentos más recientes en la tabla pedida. Si hay uno solo,
// el caller lo usa directo; si hay varios, se devuelven como candidatos
// (mismo shape { id, referencia_corta, cliente, fecha, total } que ya
// devuelven las RPC diagnosticar_* cuando la referencia es ambigua) para
// que el modelo se los muestre al usuario y le pida QUE ELIJA — nunca se
// adivina cuál es, se lo hace desambiguar con algo mucho más cómodo que
// "dame el ID corto de 6 caracteres".
async function buscarDocumentosRecientesPorCliente({ empresaId, texto, tabla, columnaFecha, limite = 6 }) {
  const cliente = await buscarClientePorTexto({ empresaId, texto });
  const { data, error } = await db.from(tabla)
    .select(`id, ${columnaFecha}, total`)
    .eq('empresa_id', empresaId)
    .eq('cliente_id', cliente.id)
    .order(columnaFecha, { ascending: false })
    .limit(limite);
  if (error) throw new Error(`No se pudo buscar en ${tabla}: ${error.message}`);
  return {
    cliente,
    documentos: (data || []).map((d) => ({
      id: d.id,
      referencia_corta: String(d.id).slice(-6).toUpperCase(),
      cliente: cliente.razon_social,
      fecha: d[columnaFecha],
      total: d.total,
    })),
  };
}

// Punto de entrada compartido por diagnosticar_pedido/presupuesto/venta_pos:
// si vino `referencia` se usa tal cual (comportamiento de siempre); si vino
// solo `cliente`, se resuelve con buscarDocumentosRecientesPorCliente y:
//   - 0 documentos → error concreto (no hay nada de ese cliente en esa tabla)
//   - 1 documento  → se sigue de largo con su referencia_corta, sin pedir nada
//   - 2+ documentos → se devuelve el mismo shape "ambiguo" que ya devuelven
//     las RPC diagnosticar_* cuando la referencia matchea más de un
//     registro, así el modelo lo maneja exactamente igual en los dos casos.
async function resolverReferenciaParaDiagnostico({ empresaId, args, tabla, columnaFecha, nombreDocumento }) {
  const referenciaLimpia = String(args.referencia || '').replace('#', '').trim();
  if (referenciaLimpia) return { referencia: referenciaLimpia };

  const texto = String(args.cliente || '').trim();
  if (!texto) throw new Error(`Necesito el ID corto del ${nombreDocumento} o el nombre del cliente.`);

  const { cliente, documentos } = await buscarDocumentosRecientesPorCliente({ empresaId, texto, tabla, columnaFecha });
  if (!documentos.length) throw new Error(`No encontré ningún ${nombreDocumento} de "${cliente.razon_social}".`);
  if (documentos.length > 1) return { ambiguo: { encontrado: false, ambiguo: true, candidatos: documentos } };
  return { referencia: documentos[0].referencia_corta };
}

// Resuelve anular_factura por referencia o por nombre de cliente, reusando
// resolverReferenciaParaDiagnostico tal cual (tabla `facturas`, columna
// `fecha_emision`) — no se duplica ese mecanismo. A diferencia de los
// diagnosticar_*, acá el resultado SIEMPRE se valida contra
// `estado === 'emitida'` en buscarFacturaPorReferencia, porque una factura
// pendiente o ya anulada nunca es un resultado válido para esta tool,
// aunque haya sido la más reciente del cliente.
async function resolverFacturaParaAnular({ empresaId, args }) {
  const resuelto = await resolverReferenciaParaDiagnostico({
    empresaId, args, tabla: 'facturas', columnaFecha: 'fecha_emision', nombreDocumento: 'factura',
  });
  if (resuelto.ambiguo) return resuelto.ambiguo;
  return await buscarFacturaPorReferencia({ empresaId, referencia: resuelto.referencia });
}

// lib/facturas.js:anularFactura() bajo service_role, igual que
// anular_venta_pos, no valida por sí sola que la factura pertenezca a
// empresaId — se scopea acá antes de tocar nada. No existe una RPC
// `diagnosticar_factura`, así que se filtra en JS contra las facturas de
// ESTA empresa (mismo patrón que buscarMovimientoBancarioPorReferencia).
async function buscarFacturaPorReferencia({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim().toUpperCase();
  if (!ref) throw new Error('Falta la referencia de la factura.');

  const { data, error } = await db.from('facturas')
    .select('id, numero, tipo, estado, total, clientes(razon_social)')
    .eq('empresa_id', empresaId);
  if (error) throw new Error(`No se pudo buscar la factura: ${error.message}`);

  const candidatos = (data || []).filter((f) => f.id.toUpperCase() === ref || f.id.slice(-6).toUpperCase() === ref);
  if (!candidatos.length) throw new Error(`No encontré ninguna factura con la referencia "${ref}" en esta empresa.`);
  if (candidatos.length > 1) throw new Error('Esa referencia coincide con más de una factura. Pedile al usuario el UUID completo.');

  const f = candidatos[0];
  if (f.estado === 'anulada') throw new Error(`La factura ${f.numero ?? f.id} ya está anulada.`);
  if (f.estado !== 'emitida') {
    throw new Error(`La factura ${f.numero ?? f.id} está en estado "${f.estado}" (sin CAE) — solo se pueden anular comprobantes emitidos. No hace falta anularla fiscalmente: alcanza con cancelar el pedido o la venta que la generó.`);
  }

  return {
    id: f.id,
    referencia_corta: f.id.slice(-6).toUpperCase(),
    numero: f.numero,
    tipo: f.tipo,
    total: f.total,
    cliente: f.clientes?.razon_social || 'Consumidor Final',
  };
}

// Resuelve emitir_factura por referencia o por nombre de cliente, reusando
// resolverReferenciaParaDiagnostico tal cual (tabla `pedidos`, columna
// `fecha_pedido`) — mismo mecanismo que ya usa diagnosticar_pedido, no se
// duplica. La elegibilidad para facturar SIEMPRE se valida en
// buscarPedidoFacturable, sea cual sea el origen de la referencia (directa
// o resuelta por cliente).
async function resolverPedidoParaFacturar({ empresaId, args }) {
  const resuelto = await resolverReferenciaParaDiagnostico({
    empresaId, args, tabla: 'pedidos', columnaFecha: 'fecha_pedido', nombreDocumento: 'pedido',
  });
  if (resuelto.ambiguo) return resuelto.ambiguo;
  return await buscarPedidoFacturable({ empresaId, referencia: resuelto.referencia });
}

// Resuelve el ID corto/UUID contra los pedidos de ESTA empresa (mismo
// patrón que buscarFacturaPorReferencia arriba) y valida ahí mismo la
// misma condición `puedeFacturar` que ya usa el botón real
// (frontend/admin/js/pedidos.js:802): ni borrador/pendiente/cancelado, y
// sin una factura YA emitida (una en pendiente/error_afip sí es válida —
// es un reintento, no una emisión nueva).
async function buscarPedidoFacturable({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim().toUpperCase();
  if (!ref) throw new Error('Falta la referencia del pedido.');

  const { data, error } = await db.from('pedidos')
    .select('id, estado, total, factura_id, clientes(razon_social), facturas(estado, notas_error)')
    .eq('empresa_id', empresaId);
  if (error) throw new Error(`No se pudo buscar el pedido: ${error.message}`);

  const candidatos = (data || []).filter((p) => p.id.toUpperCase() === ref || p.id.slice(-6).toUpperCase() === ref);
  if (!candidatos.length) throw new Error(`No encontré ningún pedido con la referencia "${ref}" en esta empresa.`);
  if (candidatos.length > 1) throw new Error('Esa referencia coincide con más de un pedido. Pedile al usuario el UUID completo.');

  const p = candidatos[0];
  if (['borrador', 'pendiente', 'cancelado'].includes(p.estado)) {
    throw new Error(`El pedido ${p.id.slice(-6).toUpperCase()} está en estado "${p.estado}" — todavía no se puede facturar.`);
  }

  const facturaEstado = p.facturas?.estado || null;
  const facturaSinEmitir = !p.factura_id || ['pendiente', 'error_afip'].includes(facturaEstado);
  if (!facturaSinEmitir) {
    throw new Error(`El pedido ${p.id.slice(-6).toUpperCase()} ya tiene una factura emitida (estado "${facturaEstado}") — no hace falta volver a facturarlo. Para anularla, usar la tool anular_factura.`);
  }

  return {
    id: p.id,
    referencia_corta: p.id.slice(-6).toUpperCase(),
    cliente: p.clientes?.razon_social || 'Consumidor Final',
    total: p.total,
    es_reintento: !!p.factura_id,
    factura_error_detalle: p.facturas?.notas_error || null,
  };
}

// Resuelve TODO lo que necesitan crear_pedido Y crear_presupuesto (cliente +
// cada item) a partir de los args de texto libre del modelo — es genérica
// (cliente + items), no tiene nada específico de pedido, así que la
// comparten ambas tools en vez de duplicarla. Se llama por separado desde
// resumen() y desde execute() de cada una — nunca se pasa un resultado ya
// resuelto de uno a otro, para no reusar un producto_id/cliente_id que pudo
// haber dejado de ser válido entre la propuesta y la confirmación.
async function resolverPedidoDesdeArgs({ empresaId, args }) {
  const cliente = await buscarClientePorTexto({ empresaId, texto: args.cliente });

  const itemsArg = Array.isArray(args.items) ? args.items : [];
  if (!itemsArg.length) throw new Error('El pedido necesita al menos un producto con su cantidad.');

  const itemsResueltos = [];
  for (const item of itemsArg) {
    const cantidad = Number(item.cantidad);
    if (!cantidad || cantidad <= 0) throw new Error(`Cantidad inválida para "${item.producto}".`);
    const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
    itemsResueltos.push({ producto_id: producto.id, cantidad });
  }

  return { clienteId: cliente.id, itemsResueltos };
}

// FIX (v517): antes esquemaParaGemini()/esquemaParaOpenAI() no recibían el
// rol y siempre declaraban las 68 tools completas al modelo, aunque
// ejecutarTool() ya rechazaba en tiempo de ejecución las que el rol del
// usuario no tiene permitido llamar (ver `roles` en cada tool, arriba).
// Resultado: se le mandaba a Groq/OpenRouter (y a Gemini) un catálogo más
// grande de lo necesario para ese usuario puntual — el modelo nunca podía
// usar de verdad esas tools fuera de su rol. Este filtro replica el mismo
// criterio de `roles` que ya usa ejecutarTool(), pero ANTES de armar el
// esquema, no después: menos tools declaradas = menos bytes en el body de
// cada request. Tools sin `roles` definido (abiertas a cualquier rol,
// igual que en ejecutarTool()) siempre se incluyen.
//
// Nota: para roles 'dueno'/'admin' (que ven 68/68 tools) esto solo no
// alcanza para bajar el esquema por debajo del límite de TPM de Groq — ver
// CHANGELOG_v517 para el detalle de la medición y qué quedó pendiente.

export {
  BCRA_BASE,
  BCRA_TIMEOUT_MS,
  CAMPOS_CLIENTE_EDITABLES,
  COLUMNAS_PREFS_NOTIF,
  DIAS_REPARTO_VALIDOS,
  MARGEN_MINIMO_SOBRE_SIGUIENTE,
  MEDIOS_COBRO_TEXTO,
  MOTIVOS_DEVOLUCION_VALIDOS,
  OP_LABELS_CONDICION,
  SIMILITUD_MINIMA_AUTOELEGIR,
  armarAccionRegla,
  armarCambiosReglaAutomatizacion,
  armarCambiosReglaLiquidacion,
  armarCambiosReglaPrecio,
  armarCamposReglaAutomatizacion,
  armarCamposReglaPrecio,
  armarCondicionRegla,
  armarUpdateDatosEmpresa,
  buscarCandidatosAsistente,
  buscarCandidatosDeMovimiento,
  buscarCategoriaPorTexto,
  buscarClienteExistente,
  buscarClienteParaCobroPorTexto,
  buscarClientePorTexto,
  buscarDepositoPorTexto,
  buscarDocumentosRecientesPorCliente,
  buscarFacturaPorReferencia,
  buscarLoteConciliacionPorReferencia,
  buscarMaestroExistente,
  buscarMovimientoBancarioPorReferencia,
  buscarPedidoBorradorPorTexto,
  buscarPedidoFacturable,
  buscarPedidoPropioPorTexto,
  buscarPedidoSugeridoPropio,
  buscarProductoPorTexto,
  buscarProveedorExistente,
  buscarProveedorPorTexto,
  buscarRecompensaPorTexto,
  buscarReglaAutomatizacionPorTexto,
  buscarReglaPrecioPorTexto,
  buscarVentaPosPropia,
  buscarZonaPorTexto,
  construirCambiosCliente,
  contarMatchesAutomaticosLote,
  describirAccionRegla,
  describirCondicionRegla,
  describirCondicionSimpleRegla,
  describirReglaAutomatizacion,
  describirReglaPrecio,
  diagnosticoPedidoParaCancelar,
  elegirMejorCandidato,
  fetchBcraDirecto,
  normalizarDiaReparto,
  obtenerDatosEmpresaActual,
  obtenerPreferenciaNotificacionActual,
  resolverAjusteStock,
  resolverCategoriaPorNombre,
  resolverConteoStock,
  resolverCrearProductoDesdeArgs,
  resolverCuitParaBcra,
  resolverDepositosPorNombre,
  resolverDevolucionPedido,
  resolverDiasReparto,
  resolverEditarProductoDesdeArgs,
  resolverFacturaParaAnular,
  resolverMatchConciliacion,
  resolverOrdenCompraDesdeArgs,
  resolverPedidoDesdeArgs,
  resolverPedidoParaFacturar,
  resolverRecepcionOrdenCompra,
  resolverReferenciaParaDiagnostico,
  resolverRolesAccion,
  resolverToleranciasAutoMatch,
  resolverTransferenciaStock,
  validarColumnaPreferenciaNotificacion,
};
