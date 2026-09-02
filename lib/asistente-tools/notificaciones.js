// lib/asistente-tools/notificaciones.js
// Tools del asistente — dominio: notificaciones.
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

const TOOLS_NOTIFICACIONES = [
  {
    name: 'consultar_preferencias_notificaciones',
    description: 'Muestra qué notificaciones automáticas (push/email) están prendidas o apagadas para la empresa: sugerencias del piloto, cliente bloqueado al cerrar, error en la cola financiera, quiebre de stock, orden de compra automática por stock, caída crítica de score, anomalía de auditoría, error de sesión de migración, stock sin proveedor asignado, y resumen semanal de rentabilidad por zona.',
    roles: ['dueno', 'admin'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const { data, error } = await db.from('notif_prefs_auto')
        .select('piloto_sugerencia, cierre_cliente_bloqueado, cierre_error_cola, stock_quiebre, stock_orden_auto, score_caida_critica, auditoria_anomalia, migracion_sesion_error, stock_sin_proveedor, rentabilidad_zona_semanal')
        .eq('empresa_id', empresaId)
        .maybeSingle();
      if (error) throw new Error(`consultar_preferencias_notificaciones: ${error.message}`);
      if (!data) throw new Error('Esta empresa todavía no tiene preferencias de notificaciones configuradas.');
      return { preferencias: data };
    },
  },
  {
    name: 'actualizar_preferencia_notificacion',
    description: 'Prende o apaga UNA notificación automática puntual de la empresa (ver consultar_preferencias_notificaciones para la lista completa y sus nombres). Usar solo cuando el usuario lo pida explícitamente ("dejá de avisarme cuando...", "avisame cuando...").',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        preferencia: {
          type: 'string',
          enum: [
            'piloto_sugerencia', 'cierre_cliente_bloqueado', 'cierre_error_cola', 'stock_quiebre',
            'stock_orden_auto', 'score_caida_critica', 'auditoria_anomalia', 'migracion_sesion_error',
            'stock_sin_proveedor', 'rentabilidad_zona_semanal',
          ],
          description: 'Cuál notificación tocar: piloto_sugerencia (nueva sugerencia del piloto de compras), cierre_cliente_bloqueado (se intentó facturar a un cliente bloqueado), cierre_error_cola (falló un item de la cola financiera), stock_quiebre (un producto se quedó sin stock), stock_orden_auto (se generó una orden de compra automática por stock bajo), score_caida_critica (el score de un cliente cayó fuerte), auditoria_anomalia (se detectó una anomalía de auditoría), migracion_sesion_error (falló una sesión de migración de datos), stock_sin_proveedor (hay stock bajo de un producto sin proveedor asignado), rentabilidad_zona_semanal (resumen semanal de rentabilidad por zona).',
        },
        activar: { type: 'boolean', description: 'true para prenderla, false para apagarla.' },
      },
      required: ['preferencia', 'activar'],
    },
    async resumen({ empresaId, args }) {
      const actual = await obtenerPreferenciaNotificacionActual({ empresaId, preferencia: args.preferencia });
      const activar = Boolean(args.activar);
      if (actual === activar) return `La notificación "${args.preferencia}" ya está ${activar ? 'prendida' : 'apagada'}. No hace falta cambiar nada.`;
      return `${activar ? 'Prender' : 'Apagar'} la notificación "${args.preferencia}".`;
    },
    async execute({ empresaId, args }) {
      const activar = Boolean(args.activar);
      const columna = validarColumnaPreferenciaNotificacion(args.preferencia);
      const { error } = await db.from('notif_prefs_auto')
        .update({ [columna]: activar })
        .eq('empresa_id', empresaId);
      if (error) throw new Error(`actualizar_preferencia_notificacion: ${error.message}`);
      return { ok: true, preferencia: columna, valor: activar };
    },
  },
];

export { TOOLS_NOTIFICACIONES };
