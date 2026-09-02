// lib/asistente-tools/pos.js
// Tools del asistente — dominio: pos.
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

const TOOLS_POS = [
  {
    name: 'diagnosticar_venta_pos',
    description: 'Diagnóstico completo de UNA venta de mostrador (POS) puntual: si fue anulada, si generó factura, y si esa factura se emitió, quedó pendiente, o dio error en ARCA/AFIP (con el motivo). Usar para "por qué no se facturó tal venta de mostrador/POS", "qué pasó con la venta de tal cliente en caja", "la venta #XXXXXX no tiene factura". Pasá el ID corto de 6 caracteres si lo tenés (ej. "#A1B2C3") o el UUID completo; si no lo tenés, pasá el nombre del cliente y la tool busca sola entre sus ventas recientes — si hay una sola la diagnostica directo, si hay varias te las devuelve para que el usuario elija. No sirve para "consumidor final" sin nombre cargado: ahí necesitás sí o sí el ID. Nunca le pidas el ID al usuario de entrada si dio un nombre: intentá primero con el nombre del cliente.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'ID corto de 6 caracteres mostrado en el panel (con o sin "#") o UUID completo de la venta, si lo tenés.' },
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente, para buscar la venta sin el ID. Usar cuando no tengas la referencia.' },
      },
    },
    roles: ['dueno', 'admin', 'vendedor'],
    async execute({ empresaId, args }) {
      const resuelto = await resolverReferenciaParaDiagnostico({
        empresaId, args, tabla: 'ventas_pos', columnaFecha: 'created_at', nombreDocumento: 'venta',
      });
      if (resuelto.ambiguo) return resuelto.ambiguo;
      const { data, error } = await db.rpc('diagnosticar_venta_pos', {
        p_empresa_id: empresaId,
        p_referencia: resuelto.referencia,
      });
      if (error) throw new Error(`diagnosticar_venta_pos: ${error.message}`);
      return data;
    },
  },
  {
    name: 'anular_venta_pos',
    description: 'Anula una venta de mostrador (POS) puntual: repone el stock vendido y marca la venta como anulada. NO se puede usar si la venta ya tiene una factura con CAE emitida (en ese caso hay que emitir una Nota de Crédito, esta tool no sirve para eso). Usar solo cuando el usuario pida explícitamente anular/cancelar una venta de mostrador puntual, dando su ID corto de 6 caracteres. Necesita también un motivo: si el usuario no lo dio, pedíselo antes de llamar la tool.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'ID corto de 6 caracteres mostrado en el panel (con o sin "#") o UUID completo de la venta a anular.' },
        motivo: { type: 'string', description: 'Motivo de la anulación, tal como lo dio el usuario. Obligatorio.' },
      },
      required: ['referencia', 'motivo'],
    },
    roles: ['dueno', 'admin'], // mismos roles que ROLES_ANULAR en lib/handlers/pos.js
    requiereConfirmacion: true,
    async resumen({ empresaId, args }) {
      const venta = await buscarVentaPosPropia({ empresaId, referencia: args.referencia });
      if (venta.error) throw new Error(venta.error);
      return `Anular la venta #${venta.referencia_corta} de ${venta.cliente} por $${venta.total}. Se repone el stock vendido. Motivo: "${args.motivo}". Esto no se puede deshacer.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Reconfirma la pertenencia a esta empresa en el momento de ejecutar
      // (no solo cuando se armó el resumen) — pudo haberse facturado,
      // anulado por otra vía, o simplemente pasó tiempo desde la propuesta.
      const venta = await buscarVentaPosPropia({ empresaId, referencia: args.referencia });
      if (venta.error) throw new Error(venta.error);

      const motivo = String(args.motivo || '').trim();
      if (!motivo) throw new Error('Falta el motivo de la anulación');

      // p_usuario_id: anular_venta_pos() solo lo respeta cuando el caller es
      // service_role (si no, lo pisa con auth.uid()) — acá SIEMPRE somos
      // service_role, así que este valor es el que realmente queda
      // registrado en movimientos_stock (el usuario dueño de la conversación
      // que confirmó la acción, nunca un valor que venga del texto del
      // modelo). Ver 416_anular_venta_pos_bloquea_facturadas.sql.
      const { data, error } = await db.rpc('anular_venta_pos', {
        p_venta_pos_id: venta.id,
        p_usuario_id: usuarioId,
        p_motivo: motivo,
      });
      if (error) throw new Error(`anular_venta_pos: ${error.message}`);
      if (data?.ok === false) throw new Error(data.error || 'No se pudo anular la venta');
      return data;
    },
  },
];

export { TOOLS_POS };
