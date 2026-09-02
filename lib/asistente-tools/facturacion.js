// lib/asistente-tools/facturacion.js
// Tools del asistente — dominio: facturacion.
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

const TOOLS_FACTURACION = [
  {
    name: 'anular_factura',
    description: 'Anula UNA factura puntual ya EMITIDA con CAE real de ARCA/AFIP: emite una Nota de Crédito real contra ARCA/AFIP para anularla fiscalmente. NO sirve para facturas en estado "pendiente" (sin CAE, sin efecto fiscal real todavía — para esas alcanza con cancelar el pedido o la venta que las generó, no hace falta esta tool). Usar solo cuando el usuario pida explícitamente anular/dar de baja una factura puntual, dando su ID corto de 6 caracteres o el nombre del cliente. Necesita también un motivo: si el usuario no lo dio, pedíselo antes de llamar la tool.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'ID corto de 6 caracteres mostrado en el panel (con o sin "#") o UUID completo de la factura, si lo tenés.' },
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente, para buscar la factura sin el ID. Usar cuando no tengas la referencia.' },
        motivo: { type: 'string', description: 'Motivo de la anulación, tal como lo dio el usuario. Obligatorio.' },
      },
      required: ['motivo'],
    },
    roles: ['dueno', 'admin', 'contador'], // mismos roles que valida anularFacturaHandler en lib/handlers/facturas.js
    requiereConfirmacion: true,
    async resumen({ empresaId, args }) {
      const factura = await resolverFacturaParaAnular({ empresaId, args });
      if (factura.ambiguo) return factura;
      return `Anular la factura ${factura.tipo}-${factura.numero ?? factura.referencia_corta} de ${factura.cliente} por $${factura.total}. Emite una Nota de Crédito real contra ARCA/AFIP. Motivo: "${args.motivo}". Esto no se puede deshacer.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Reconfirma la referencia y el estado en el momento de ejecutar (no
      // solo cuando se armó el resumen) — pudo haberse anulado, reintentado,
      // o cambiado de estado desde que se propuso.
      const resuelto = await resolverFacturaParaAnular({ empresaId, args });
      if (resuelto.ambiguo) throw new Error('La referencia sigue siendo ambigua; pedile al usuario que elija una de las opciones mostradas.');

      const motivo = String(args.motivo || '').trim();
      if (!motivo) throw new Error('Falta el motivo de la anulación');

      // Trae la fila completa (mismo criterio que FacturasRepo.obtenerFacturaCompleta
      // en lib/repos/facturas.js) porque anularFactura() necesita empresa_id/
      // cliente_id/pedido_id/venta_pos_id, no solo lo que expone
      // resolverFacturaParaAnular para el resumen.
      const { data: facturaCompleta, error: errFactura } = await db.from('facturas')
        .select('*')
        .eq('id', resuelto.id)
        .eq('empresa_id', empresaId)
        .single();
      if (errFactura || !facturaCompleta) throw new Error('No se pudo releer la factura para anularla.');
      if (facturaCompleta.estado !== 'emitida') {
        throw new Error(`La factura ${facturaCompleta.numero ?? facturaCompleta.id} ya no está en estado "emitida" (ahora: "${facturaCompleta.estado}") — no se puede anular.`);
      }

      const { anularFactura } = await import('./facturas.js');
      const resultado = await anularFactura(facturaCompleta, motivo, usuarioId);
      if (!resultado.ok) throw new Error(resultado.error || 'No se pudo anular la factura');

      return {
        ok: true,
        factura_original_id: facturaCompleta.id,
        factura_original_numero: facturaCompleta.numero,
        nota_credito: resultado.nota_credito,
      };
    },
  },
  {
    name: 'emitir_factura',
    description: 'Genera (o reintenta) el comprobante de venta de UN pedido puntual — el mismo botón "Generar/Reintentar Comprobante de Venta" del panel de pedidos. Emite un comprobante fiscal REAL contra ARCA/AFIP y asienta el débito en la cuenta corriente del cliente; no es reversible con un simple cambio de estado (para anular una factura ya emitida existe la tool anular_factura, esta no sirve para eso). Solo funciona si el pedido está confirmado/en curso (no borrador, no cancelado) y todavía no tiene una factura EMITIDA con CAE — si el intento anterior falló (pendiente/error ARCA), esta misma tool lo reintenta. Usar cuando el usuario pida explícitamente facturar/generar el comprobante de un pedido puntual, dando su ID corto de 6 caracteres o el nombre del cliente.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'ID corto de 6 caracteres mostrado en el panel (con o sin "#") o UUID completo del pedido, si lo tenés.' },
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente, para buscar el pedido sin el ID. Usar cuando no tengas la referencia.' },
      },
    },
    roles: ['dueno', 'admin', 'contador'], // mismo gate que emitirFacturaHandler: puede(perfil, 'acceder', 'facturas')
    requiereConfirmacion: true,
    async resumen({ empresaId, args }) {
      const pedido = await resolverPedidoParaFacturar({ empresaId, args });
      if (pedido.ambiguo) return pedido;
      const accion = pedido.es_reintento ? 'Reintentar' : 'Generar';
      const contextoError = pedido.es_reintento && pedido.factura_error_detalle
        ? ` (el intento anterior falló: "${pedido.factura_error_detalle}")` : '';
      return `${accion} el comprobante de venta del pedido #${pedido.referencia_corta} de ${pedido.cliente} por $${pedido.total}${contextoError}. Emite un comprobante fiscal real contra ARCA/AFIP y asienta el débito en su cuenta corriente. Esta acción no se puede deshacer con un simple cambio de estado.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Reconfirma referencia + elegibilidad en el momento de ejecutar —
      // mismo criterio que anular_factura/anular_venta_pos: pudo haber
      // cambiado de estado, o ya haberse facturado por otra vía (cierre
      // automático, otro usuario) desde que se armó el resumen.
      const resuelto = await resolverPedidoParaFacturar({ empresaId, args });
      if (resuelto.ambiguo) throw new Error('La referencia sigue siendo ambigua; pedile al usuario que elija una de las opciones mostradas.');

      // Ver comentario arriba (FIX FACTURAS-002): confirmación explícita de
      // pertenencia a empresa justo antes de llamar emitirFactura(), no
      // solo al resolver el pedido.
      const { data: pedidoCheck, error: pedidoCheckErr } = await db.from('pedidos')
        .select('id, empresa_id').eq('id', resuelto.id).single();
      if (pedidoCheckErr || !pedidoCheck || pedidoCheck.empresa_id !== empresaId) {
        throw new Error('No se pudo confirmar el pedido para facturar.');
      }

      const { emitirFactura } = await import('./facturas.js');
      const resultado = await emitirFactura(resuelto.id, usuarioId);

      if (!resultado?.ok) {
        // Mismo caso especial que generarFactura() en pedidos.js: falta
        // configuración de facturación, no es una falla del sistema.
        if (resultado?.codigo === 'sin_configuracion_facturacion') {
          throw new Error('Todavía no configuraste la facturación electrónica (ARCA/AFIP) de esta empresa — hay que cargar el CUIT, el punto de venta y el certificado desde Configuración > Facturación antes de poder emitir comprobantes.');
        }
        throw new Error(resultado?.error || 'No se pudo generar el comprobante');
      }

      return {
        ok: true,
        pedido_id: resuelto.id,
        referencia_corta: resuelto.referencia_corta,
        factura_id: resultado.factura?.id,
        factura_numero: resultado.factura?.numero,
        factura_cae: resultado.factura?.cae,
      };
    },
  },
  {
    name: 'listar_notas_credito',
    description: 'Historial de notas de crédito emitidas a clientes de los últimos N días, opcionalmente filtrado por cliente y/o estado. Usar para "qué notas de crédito emitimos esta semana", "cuántas notas de crédito tiene tal cliente", "hay alguna nota de crédito con error de AFIP". Estados posibles: pendiente, emitida, aplicada, anulada, error_afip. Máximo 20 filas mostradas; si total_notas supera eso, aclarárselo al usuario. monto_total es la suma de TODO el período filtrado, no solo las filas mostradas.',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre (o parte del nombre) del cliente para filtrar. Opcional.' },
        estado: { type: 'string', description: 'Estado exacto a filtrar: pendiente, emitida, aplicada, anulada o error_afip. Opcional.' },
        dias: { type: 'integer', description: 'Ventana de días hacia atrás. Si no lo dicen, usar 30.' },
      },
    },
    async execute({ empresaId, args }) {
      const dias = Math.min(parseInt(args.dias, 10) || 30, 180);
      const { data, error } = await db.rpc('listar_notas_credito', {
        p_empresa_id: empresaId,
        p_cliente: args.cliente || null,
        p_estado: args.estado || null,
        p_dias: dias,
      });
      if (error) throw new Error(`listar_notas_credito: ${error.message}`);
      return data;
    },
  },
];

export { TOOLS_FACTURACION };
