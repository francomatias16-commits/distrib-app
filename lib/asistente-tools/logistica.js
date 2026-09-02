// lib/asistente-tools/logistica.js
// Tools del asistente — dominio: logistica.
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

const TOOLS_LOGISTICA = [
  {
    name: 'consultar_ruta_dia',
    description: 'Rutas de entrega de una fecha (por defecto hoy), opcionalmente filtradas por chofer, con resumen de entregas pendientes/confirmadas. Usar para "cómo va la ruta de hoy", "qué le falta entregar a tal chofer".',
    roles: ['dueno', 'admin', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD. Si no la dicen, usar la fecha de hoy.' },
        chofer: { type: 'string', description: 'Nombre del chofer, si lo mencionan.' },
      },
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('consultar_ruta_dia', {
        p_empresa_id: empresaId,
        p_fecha: args.fecha || new Date().toISOString().slice(0, 10),
        p_chofer_nombre: args.chofer || null,
      });
      if (error) throw new Error(`consultar_ruta_dia: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_invitaciones_chofer',
    description: 'Lista las invitaciones de acceso a choferes emitidas (nombre, teléfono, estado: activo/aceptada/expirado/revocado). Usar para "qué choferes invité", "el link del chofer X sigue activo".',
    roles: ROLES_CHOFER_INVITACION,
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const resultado = await listarInvitacionesChofer({ empresa_id: empresaId });
      if (!resultado.ok) throw new Error(`consultar_invitaciones_chofer: ${resultado.error}`);
      return { invitaciones: resultado.invitaciones };
    },
  },
  {
    name: 'invitar_chofer_nuevo',
    description: 'Da de alta un chofer nuevo (crea su usuario, ya activo) y genera el link de WhatsApp para que active su propio acceso. Usar cuando piden sumar/invitar a un chofer que todavía no existe en el sistema.',
    roles: ROLES_CHOFER_INVITACION,
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del chofer.' },
        telefono: { type: 'string', description: 'Teléfono del chofer (con o sin código de país/0 inicial, se normaliza).' },
      },
      required: ['nombre', 'telefono'],
    },
    async resumen({ args }) {
      return `Dar de alta al chofer "${args.nombre}" (tel. ${args.telefono}) y generarle un link de invitación por WhatsApp.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const resultado = await invitarChoferNuevo({
        empresa_id: empresaId,
        creado_por: usuarioId,
        nombre: args.nombre,
        telefono: args.telefono,
        baseUrl: APP_URL_FALLBACK,
      });
      if (!resultado.ok) throw new Error(`invitar_chofer_nuevo: ${resultado.error}`);
      return { ok: true, url: resultado.url, waLink: resultado.waLink, expira_at: resultado.expira_at };
    },
  },
  {
    name: 'invitar_chofer_existente',
    description: 'Genera un nuevo link de invitación para un chofer que ya está cargado en el sistema (reset de acceso — ej. perdió el link anterior o venció). Requiere el usuario_id del chofer; si no se conoce, primero hay que buscarlo (ej. con consultar_choferes o similar) antes de llamar esta tool.',
    roles: ROLES_CHOFER_INVITACION,
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        usuario_id: { type: 'string', description: 'ID del usuario (chofer) ya existente.' },
      },
      required: ['usuario_id'],
    },
    async resumen({ args }) {
      return `Generar un nuevo link de acceso para el chofer con id ${args.usuario_id}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const resultado = await invitarChoferExistente({
        empresa_id: empresaId,
        creado_por: usuarioId,
        usuario_id: args.usuario_id,
        baseUrl: APP_URL_FALLBACK,
      });
      if (!resultado.ok) throw new Error(`invitar_chofer_existente: ${resultado.error}`);
      return { ok: true, url: resultado.url, waLink: resultado.waLink, expira_at: resultado.expira_at };
    },
  },
  {
    name: 'revocar_invitacion_chofer',
    description: 'Revoca (desactiva) una invitación de chofer pendiente, para que el link deje de funcionar. No afecta a choferes cuyo acceso ya fue activado.',
    roles: ROLES_CHOFER_INVITACION,
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        invitacion_id: { type: 'string', description: 'ID de la invitación a revocar (ver consultar_invitaciones_chofer).' },
      },
      required: ['invitacion_id'],
    },
    async resumen({ args }) {
      return `Revocar la invitación ${args.invitacion_id} — el link dejará de funcionar.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const resultado = await revocarInvitacionChofer({ empresa_id: empresaId, invitacion_id: args.invitacion_id, revocado_por: usuarioId });
      if (!resultado.ok) throw new Error(`revocar_invitacion_chofer: ${resultado.error}`);
      return { ok: true };
    },
  },
];

export { TOOLS_LOGISTICA };
