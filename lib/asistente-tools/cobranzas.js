// lib/asistente-tools/cobranzas.js
// Tools del asistente — dominio: cobranzas.
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

const TOOLS_COBRANZAS = [
  {
    name: 'listar_cobros',
    description: 'Historial de cobros a clientes de los últimos N días, opcionalmente filtrado por cliente y/o medio de pago, incluyendo el detalle de a qué facturas se aplicó cada cobro. Usar para "qué cobros hicimos esta semana", "cuánto cobramos de tal cliente", "pasame los cobros en efectivo". Máximo 20 filas mostradas; si total_cobros supera eso, aclarárselo al usuario. monto_total es la suma de TODO el período filtrado, no solo las filas mostradas.',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre (o parte del nombre) del cliente para filtrar. Opcional.' },
        medio: { type: 'string', description: 'Medio de pago a filtrar (ej. efectivo, transferencia, cheque), tal como se registra en el sistema. Opcional.' },
        dias: { type: 'integer', description: 'Ventana de días hacia atrás. Si no lo dicen, usar 30.' },
      },
    },
    async execute({ empresaId, args }) {
      const dias = Math.min(parseInt(args.dias, 10) || 30, 180);
      const { data, error } = await db.rpc('listar_cobros', {
        p_empresa_id: empresaId,
        p_cliente: args.cliente || null,
        p_medio: args.medio || null,
        p_dias: dias,
      });
      if (error) throw new Error(`listar_cobros: ${error.message}`);
      return data;
    },
  },
  {
    name: 'registrar_cobro_cliente',
    description: 'Propone registrar un cobro (pago recibido) de un cliente puntual, por un medio de pago dado — el mismo cobro general de cuenta corriente que el botón "Registrar cobro" de Rutas del día, no aplicado a ninguna factura en particular. Usar para "cobré $X en efectivo a tal cliente", "registrame una transferencia de $X de tal cliente". Si el usuario pide aplicar el cobro a una factura específica, aclarale que eso se hace desde Cuenta corriente porque hay que elegir entre las facturas abiertas.',
    roles: ['dueno', 'admin', 'vendedor'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre, razón social, CUIT o teléfono del cliente, tal como lo dio el usuario.' },
        monto: { type: 'number', description: 'Monto cobrado, mayor a cero.' },
        medio: {
          type: 'string',
          enum: ['efectivo', 'transferencia', 'cheque', 'otro'],
          description: 'Medio de pago. Si el usuario dice algo que no es exactamente uno de estos (ej. "Mercado Pago", "débito", "QR"), usar "otro" y poner el detalle real en referencia.',
        },
        referencia: { type: 'string', description: 'Referencia del pago si el usuario dio alguna (ej. número de operación, últimos dígitos de un cheque, "Mercado Pago"). Opcional.' },
        notas: { type: 'string', description: 'Notas adicionales del cobro, si el usuario dio alguna. Opcional.' },
      },
      required: ['cliente', 'monto', 'medio'],
    },
    async resumen({ empresaId, args }) {
      const monto = Number(args.monto);
      if (!(monto > 0)) throw new Error('El monto del cobro tiene que ser mayor a cero.');
      const cliente = await buscarClienteParaCobroPorTexto({ empresaId, texto: args.cliente });
      const { data: c, error } = await db.from('clientes')
        .select('saldo_deuda')
        .eq('id', cliente.id)
        .eq('empresa_id', empresaId)
        .single();
      if (error) throw new Error(`registrar_cobro_cliente: ${error.message}`);

      const medioTexto = MEDIOS_COBRO_TEXTO[args.medio] || args.medio;
      const montoTexto = monto.toLocaleString('es-AR');
      let texto = `Registrar un cobro de $${montoTexto} en ${medioTexto} a ${cliente.razon_social}${cliente.activo ? '' : ' (inactivo)'}.`;

      const saldoActual = Number(c?.saldo_deuda || 0);
      if (saldoActual > 0) {
        const saldoDespues = saldoActual - monto;
        texto += saldoDespues > 0
          ? ` Debía $${saldoActual.toLocaleString('es-AR')}, queda debiendo $${saldoDespues.toLocaleString('es-AR')}.`
          : saldoDespues < 0
            ? ` Salda toda la deuda ($${saldoActual.toLocaleString('es-AR')}) y queda a favor $${Math.abs(saldoDespues).toLocaleString('es-AR')}.`
            : ` Salda toda la deuda actual ($${saldoActual.toLocaleString('es-AR')}).`;
      } else {
        texto += ' Actualmente no tiene deuda registrada.';
      }
      return texto;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Se resuelve el cliente de nuevo (no se reusa lo de resumen()) por
      // el mismo motivo que crear_pedido: pudo pasar tiempo entre proponer
      // y confirmar, y el nombre tiene que volver a resolverse contra el
      // estado actual.
      const monto = Number(args.monto);
      if (!(monto > 0)) throw new Error('El monto del cobro tiene que ser mayor a cero.');
      const cliente = await buscarClienteParaCobroPorTexto({ empresaId, texto: args.cliente });

      const { data, error } = await db.rpc('registrar_cobro_completo', {
        p_empresa_id: empresaId,
        p_cliente_id: cliente.id,
        p_monto: monto,
        p_medio: args.medio,
        p_referencia: args.referencia || null,
        p_notas: args.notas || 'Cobro registrado por voz desde el asistente IA.',
        p_usuario_id: usuarioId,
      });
      if (error) throw new Error(`registrar_cobro_cliente: ${error.message}`);
      if (data && data.ok === false) throw new Error(data.error || 'No se pudo registrar el cobro.');
      return { ok: true, cliente: cliente.razon_social, monto, medio: args.medio, ...data };
    },
  },
  {
    name: 'listar_movimientos_caja',
    description: 'Historial de movimientos de caja (sangrías, refuerzos, retiros finales) del POS de los últimos N días, opcionalmente filtrado por tipo y/o usuario. Usar para "cuánto se sacó de caja esta semana", "hubo refuerzos de caja hoy", "qué sangrías hizo tal empleado". Tipos posibles: sangria, refuerzo, retiro_final. Máximo 20 filas mostradas; si total_movimientos supera eso, aclarárselo al usuario. Incluye totales acumulados por tipo (total_sangrias, total_refuerzos, total_retiros_finales) sobre TODO el período filtrado, no solo las filas mostradas.',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'Tipo exacto a filtrar: sangria, refuerzo o retiro_final. Opcional.' },
        usuario: { type: 'string', description: 'Nombre (o parte del nombre) del usuario/empleado que hizo el movimiento. Opcional.' },
        dias: { type: 'integer', description: 'Ventana de días hacia atrás. Si no lo dicen, usar 30.' },
      },
    },
    async execute({ empresaId, args }) {
      const dias = Math.min(parseInt(args.dias, 10) || 30, 180);
      const { data, error } = await db.rpc('listar_movimientos_caja', {
        p_empresa_id: empresaId,
        p_tipo: args.tipo || null,
        p_usuario: args.usuario || null,
        p_dias: dias,
      });
      if (error) throw new Error(`listar_movimientos_caja: ${error.message}`);
      return data;
    },
  },
];

export { TOOLS_COBRANZAS };
