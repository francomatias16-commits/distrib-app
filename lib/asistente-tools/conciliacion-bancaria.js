// lib/asistente-tools/conciliacion-bancaria.js
// Tools del asistente — dominio: conciliacion-bancaria.
// Parte del split de lib/asistente-tools.js (25/08/2026). Se copió acá
// el bloque de imports original completo (por seguridad, aunque queden
// algunos sin usar) para no romper nada por una referencia no detectada.
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

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
import {
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
} from './_helpers.js';

const TOOLS_CONCILIACION_BANCARIA = [
  {
    name: 'listar_movimientos_bancarios_pendientes',
    description: 'Lista los movimientos del extracto bancario importado que todavía no fueron conciliados con ningún cobro, más recientes primero, con su referencia corta de 6 caracteres para usar en consultar_candidatos_conciliacion. Usar para "qué movimientos bancarios faltan conciliar", "mostrame el extracto pendiente".',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: 'Cuántos mostrar como máximo. Default 15, tope 30.' },
      },
    },
    async execute({ empresaId, args }) {
      const limite = Math.min(Math.max(Number(args.limite) || 15, 1), 30);
      const { data, error } = await db.from('conciliacion_bancaria_movimientos')
        .select('id, fecha, descripcion, monto, tipo')
        .eq('empresa_id', empresaId)
        .eq('estado', 'pendiente')
        .order('fecha', { ascending: false })
        .limit(limite);
      if (error) throw new Error(`listar_movimientos_bancarios_pendientes: ${error.message}`);
      return {
        movimientos: (data || []).map((m) => ({
          referencia: m.id.slice(-6).toUpperCase(),
          fecha: m.fecha,
          descripcion: m.descripcion,
          monto: m.monto,
          tipo: m.tipo,
        })),
      };
    },
  },
  {
    name: 'consultar_candidatos_conciliacion',
    description: 'Para UN movimiento bancario pendiente (dado por su referencia corta de 6 caracteres, ver listar_movimientos_bancarios_pendientes), busca qué cobros sin conciliar podrían corresponderle, ordenados por score de coincidencia (fecha y monto). Usar antes de confirmar_conciliacion_bancaria, nunca inventar un cobro sin haber consultado esto primero.',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'Referencia corta de 6 caracteres del movimiento bancario (con o sin "#").' },
      },
      required: ['referencia'],
    },
    async execute({ empresaId, args }) {
      const movimiento = await buscarMovimientoBancarioPorReferencia({ empresaId, referencia: args.referencia });
      const candidatos = await buscarCandidatosDeMovimiento({ empresaId, movimientoId: movimiento.id });
      return {
        movimiento: { referencia: movimiento.referencia, fecha: movimiento.fecha, descripcion: movimiento.descripcion, monto: movimiento.monto },
        candidatos: candidatos.map((c) => ({
          cobro_referencia: c.cobro_id.slice(-6).toUpperCase(),
          cliente: c.cliente_nombre,
          fecha: c.fecha,
          monto: c.monto,
          medio: c.medio,
          diff_dias: c.diff_dias,
          diff_monto: c.diff_monto,
          score: c.score,
        })),
      };
    },
  },
  {
    name: 'confirmar_conciliacion_bancaria',
    description: 'Confirma que un movimiento bancario pendiente corresponde a un cobro puntual, marcando ambos como conciliados. Los dos se identifican por su referencia corta de 6 caracteres. El cobro TIENE que venir de un candidato ya mostrado por consultar_candidatos_conciliacion para ese mismo movimiento — nunca inventar una referencia de cobro sin haberla visto ahí.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        referencia_movimiento: { type: 'string', description: 'Referencia corta de 6 caracteres del movimiento bancario.' },
        referencia_cobro: { type: 'string', description: 'Referencia corta de 6 caracteres del cobro candidato (visto en consultar_candidatos_conciliacion).' },
      },
      required: ['referencia_movimiento', 'referencia_cobro'],
    },
    async resumen({ empresaId, args }) {
      const { movimiento, candidato } = await resolverMatchConciliacion({ empresaId, args });
      return `Conciliar el movimiento del ${movimiento.fecha} por $${movimiento.monto} ("${movimiento.descripcion}") con el cobro de ${candidato.cliente_nombre} por $${candidato.monto} del ${candidato.fecha}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Se resuelve de nuevo (no se reusa lo que vio resumen()): si cambió
      // algo entre la propuesta y el click de Confirmar —por ejemplo el
      // cobro se conciliÓ con otro movimiento por otra vía mientras
      // tanto— conciliacion_confirmar_match lo rechaza solo (ver su
      // FOR UPDATE + chequeo de conciliado_bancario), pero además acá se
      // vuelve a exigir que el cobro siga siendo un candidato vigente.
      const { movimiento, candidato } = await resolverMatchConciliacion({ empresaId, args });
      const { data, error } = await db.rpc('conciliacion_confirmar_match', {
        p_movimiento_id: movimiento.id,
        p_cobro_id: candidato.cobro_id,
        p_empresa_id: empresaId,
        p_usuario_id: usuarioId,
      });
      if (error) throw new Error(`confirmar_conciliacion_bancaria: ${error.message}`);
      return data;
    },
  },
  {
    name: 'deshacer_conciliacion_bancaria',
    description: 'Deshace la conciliación de un movimiento bancario ya conciliado, dejándolo pendiente de nuevo y liberando el cobro asociado para que pueda conciliarse con otro movimiento. Usar solo cuando el usuario pida explícitamente deshacer/corregir una conciliación puntual, dando la referencia corta del movimiento.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        referencia_movimiento: { type: 'string', description: 'Referencia corta de 6 caracteres del movimiento bancario ya conciliado.' },
      },
      required: ['referencia_movimiento'],
    },
    async resumen({ empresaId, args }) {
      const movimiento = await buscarMovimientoBancarioPorReferencia({ empresaId, referencia: args.referencia_movimiento, estadoRequerido: 'conciliado' });
      return `Deshacer la conciliación del movimiento del ${movimiento.fecha} por $${movimiento.monto} ("${movimiento.descripcion}"). Vuelve a quedar pendiente, y el cobro que tenía asociado queda libre de nuevo.`;
    },
    async execute({ empresaId, args }) {
      const movimiento = await buscarMovimientoBancarioPorReferencia({ empresaId, referencia: args.referencia_movimiento, estadoRequerido: 'conciliado' });
      const { data, error } = await db.rpc('conciliacion_deshacer_match', {
        p_movimiento_id: movimiento.id,
        p_empresa_id: empresaId,
      });
      if (error) throw new Error(`deshacer_conciliacion_bancaria: ${error.message}`);
      return data;
    },
  },
  {
    name: 'listar_lotes_conciliacion_bancaria',
    description: 'Lista los lotes de extracto bancario importados, con cuántos movimientos tienen en total y cuántos siguen pendientes de conciliar. Usar para "qué lotes bancarios hay", "cuál extracto falta terminar de conciliar".',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: 'Cuántos mostrar como máximo. Default 10, tope 20.' },
      },
    },
    async execute({ empresaId, args }) {
      const limite = Math.min(Math.max(Number(args.limite) || 10, 1), 20);
      const { data, error } = await db.from('conciliacion_bancaria_lotes')
        .select('id, nombre_archivo, cantidad_movimientos, cantidad_conciliados, created_at')
        .eq('empresa_id', empresaId)
        .order('created_at', { ascending: false })
        .limit(limite);
      if (error) throw new Error(`listar_lotes_conciliacion_bancaria: ${error.message}`);
      return {
        lotes: (data || []).map((l) => ({
          referencia: l.id.slice(-6).toUpperCase(),
          archivo: l.nombre_archivo,
          movimientos: l.cantidad_movimientos,
          conciliados: l.cantidad_conciliados,
          pendientes: Math.max((l.cantidad_movimientos || 0) - (l.cantidad_conciliados || 0), 0),
          fecha: l.created_at,
        })),
      };
    },
  },
  {
    name: 'conciliar_lote_automatico',
    description: 'Concilia automáticamente todos los movimientos pendientes de UN lote de extracto bancario que tengan un único cobro candidato posible (match inequívoco por fecha y monto). Los que tengan cero candidatos o más de uno quedan igual, para revisar a mano con consultar_candidatos_conciliacion. Usar solo cuando el usuario lo pida explícitamente para un lote completo, no para un movimiento puntual (para eso está confirmar_conciliacion_bancaria).',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        lote: { type: 'string', description: 'Nombre del archivo importado, o ID corto de 6 caracteres del lote (ver listar_lotes_conciliacion_bancaria).' },
        tolerancia_dias: { type: 'number', description: 'Diferencia máxima de días entre movimiento y cobro para considerarlos el mismo pago. Default 1.' },
        tolerancia_monto: { type: 'number', description: 'Diferencia máxima de monto en $ entre movimiento y cobro. Default 0.5.' },
      },
      required: ['lote'],
    },
    async resumen({ empresaId, args }) {
      const lote = await buscarLoteConciliacionPorReferencia({ empresaId, referencia: args.lote });
      const { toleranciaDias, toleranciaMonto } = resolverToleranciasAutoMatch(args);
      const { totalPendientes, conUnico } = await contarMatchesAutomaticosLote({ empresaId, loteId: lote.id, toleranciaDias, toleranciaMonto });
      if (!totalPendientes) throw new Error(`El lote "${lote.nombre_archivo}" no tiene movimientos pendientes de conciliar.`);
      return `Conciliar automáticamente ${conUnico} de ${totalPendientes} movimientos pendientes del lote "${lote.nombre_archivo}" (los que tengan un único cobro candidato, con tolerancia de ${toleranciaDias} día(s) y $${toleranciaMonto}). El resto queda pendiente para revisar a mano.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const lote = await buscarLoteConciliacionPorReferencia({ empresaId, referencia: args.lote });
      const { toleranciaDias, toleranciaMonto } = resolverToleranciasAutoMatch(args);
      const { data, error } = await db.rpc('conciliacion_auto_matchear_lote', {
        p_lote_id: lote.id,
        p_empresa_id: empresaId,
        p_usuario_id: usuarioId,
        p_tolerancia_dias: toleranciaDias,
        p_tolerancia_monto: toleranciaMonto,
      });
      if (error) throw new Error(`conciliar_lote_automatico: ${error.message}`);
      return { conciliados: data };
    },
  },
];

export { TOOLS_CONCILIACION_BANCARIA };
