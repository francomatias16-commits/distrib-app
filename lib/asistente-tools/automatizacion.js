// lib/asistente-tools/automatizacion.js
// Tools del asistente — dominio: automatizacion.
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

const TOOLS_AUTOMATIZACION = [
  {
    name: 'listar_reglas_automatizacion_asistente',
    description: 'Lista las reglas de automatización configuradas (automatizacion.html): qué evento las dispara, la condición (si tienen), qué acción ejecutan (notificación push, WhatsApp o tarea) y si están activas. Usar para "qué reglas de automatización hay", "mostrame las alertas automáticas configuradas".',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        solo_activas: { type: 'boolean', description: 'true para traer solo las reglas activas. Si no se aclara, trae todas.' },
        evento_disparador: { type: 'string', enum: EVENTOS_DISPONIBLES_ASISTENTE, description: 'Filtrar solo las reglas que se disparan con este evento. Opcional.' },
      },
    },
    async execute({ empresaId, args }) {
      const data = await listarReglasAutomatizacion(empresaId, {
        activa: args.solo_activas === true ? true : undefined,
        evento_disparador: args.evento_disparador,
      });
      return (data || []).map((r) => ({
        nombre: r.nombre,
        descripcion: r.descripcion || null,
        evento: EVENTOS_LABELS_ASISTENTE[r.evento_disparador] || r.evento_disparador,
        condicion: describirCondicionRegla(r.condicion),
        accion: describirAccionRegla(r.accion),
        activa: r.activa,
      }));
    },
  },
  {
    name: 'crear_regla_automatizacion_asistente',
    description: 'Crea una regla de automatización nueva: cuando ocurre un evento del sistema (se crea un pedido, se factura, se anula una factura, un cliente entra en mora, un cheque está por vencer), opcionalmente solo si se cumple una condición, dispara una acción (mandar notificación push, mandar un WhatsApp con una plantilla, o crear una tarea para ciertos roles). Usar cuando el usuario pida explícitamente "creá una regla que cuando pase X haga Y" o similar. Si no aclara qué acción debe ejecutar, preguntarle antes de asumir.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre descriptivo de la regla (ej. "Avisar cheques por vencer").' },
        descripcion: { type: 'string', description: 'Descripción opcional de qué hace la regla.' },
        evento_disparador: { type: 'string', enum: EVENTOS_DISPONIBLES_ASISTENTE, description: 'Evento del sistema que dispara la regla.' },
        condicion_campo: { type: 'string', description: 'Nombre del campo a evaluar en la condición (ej. "total", "dias_mora"), si la regla debe dispararse solo bajo cierta condición. Si no se aclara, la regla dispara siempre que ocurre el evento.' },
        condicion_operador: { type: 'string', enum: ['=', '!=', '>', '>=', '<', '<='], description: 'Operador de comparación de la condición. Requerido si se da condicion_campo.' },
        condicion_valor: { type: 'string', description: 'Valor contra el que se compara el campo de la condición. Requerido si se da condicion_campo.' },
        accion_tipo: { type: 'string', enum: ['notificar_push', 'enviar_whatsapp', 'crear_tarea'], description: 'Qué debe hacer la regla cuando se dispara.' },
        accion_titulo: { type: 'string', description: 'Título de la notificación push o de la tarea. Requerido si accion_tipo es notificar_push o crear_tarea.' },
        accion_mensaje: { type: 'string', description: 'Mensaje de la notificación push. Requerido si accion_tipo es notificar_push.' },
        accion_descripcion: { type: 'string', description: 'Descripción opcional de la tarea, si accion_tipo es crear_tarea.' },
        accion_roles: { type: 'array', items: { type: 'string', enum: ROLES_NOTIFICACION_VALIDOS }, description: 'Roles internos que reciben la notificación push o la tarea. Si no se aclara, queda dueño/admin.' },
        accion_template: { type: 'string', enum: TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE, description: 'Plantilla de WhatsApp a enviar. Requerido si accion_tipo es enviar_whatsapp (se manda al cliente del evento, no a un rol interno).' },
      },
      required: ['nombre', 'evento_disparador', 'accion_tipo'],
    },
    async resumen({ args }) {
      const campos = armarCamposReglaAutomatizacion({ args });
      return `Crear la regla de automatización "${campos.nombre}": ${describirReglaAutomatizacion(campos)}.`;
    },
    async execute({ empresaId, args }) {
      const campos = armarCamposReglaAutomatizacion({ args });
      try {
        const data = await crearReglaAutomatizacion(empresaId, campos);
        return { ok: true, id: data.id, nombre: data.nombre };
      } catch (error) {
        throw new Error(`crear_regla_automatizacion_asistente: ${error.message}`);
      }
    },
  },
  {
    name: 'editar_regla_automatizacion_asistente',
    description: 'Modifica una regla de automatización ya existente (nombre, descripción, evento disparador, condición, acción) o la activa/desactiva sin borrarla. Solo cambia los campos que el usuario pidió; el resto queda igual. Usar "referencia" con el nombre actual de la regla para ubicarla.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'Nombre (o parte del nombre) actual de la regla a editar.' },
        nombre: { type: 'string', description: 'Nuevo nombre, si lo piden cambiar.' },
        descripcion: { type: 'string', description: 'Nueva descripción, si la piden cambiar.' },
        evento_disparador: { type: 'string', enum: EVENTOS_DISPONIBLES_ASISTENTE, description: 'Nuevo evento disparador, si lo piden cambiar.' },
        condicion_campo: { type: 'string', description: 'Nuevo campo de la condición, si la piden cambiar. Mandar junto con condicion_operador y condicion_valor.' },
        condicion_operador: { type: 'string', enum: ['=', '!=', '>', '>=', '<', '<='], description: 'Nuevo operador de la condición.' },
        condicion_valor: { type: 'string', description: 'Nuevo valor de la condición.' },
        accion_tipo: { type: 'string', enum: ['notificar_push', 'enviar_whatsapp', 'crear_tarea'], description: 'Nuevo tipo de acción, si lo piden cambiar. Mandar junto con los campos de esa acción.' },
        accion_titulo: { type: 'string', description: 'Nuevo título de la notificación o tarea, si accion_tipo es notificar_push o crear_tarea.' },
        accion_mensaje: { type: 'string', description: 'Nuevo mensaje de la notificación, si accion_tipo es notificar_push.' },
        accion_descripcion: { type: 'string', description: 'Nueva descripción de la tarea, si accion_tipo es crear_tarea.' },
        accion_roles: { type: 'array', items: { type: 'string', enum: ROLES_NOTIFICACION_VALIDOS }, description: 'Nuevos roles que reciben la notificación o tarea.' },
        accion_template: { type: 'string', enum: TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE, description: 'Nueva plantilla de WhatsApp, si accion_tipo es enviar_whatsapp.' },
        activa: { type: 'boolean', description: 'true para activarla, false para pausarla sin borrarla.' },
      },
      required: ['referencia'],
    },
    async resumen({ empresaId, args }) {
      const regla = await buscarReglaAutomatizacionPorTexto({ empresaId, texto: args.referencia });
      const { cambios, resumenCambios } = await armarCambiosReglaAutomatizacion({ empresaId, args });
      if (!resumenCambios.length) throw new Error('No especificaste ningún dato para cambiar de la regla.');
      return `Actualizar la regla de automatización "${regla.nombre}": ${resumenCambios.join(', ')}.`;
    },
    async execute({ empresaId, args }) {
      const regla = await buscarReglaAutomatizacionPorTexto({ empresaId, texto: args.referencia });
      const { cambios, resumenCambios } = await armarCambiosReglaAutomatizacion({ empresaId, args });
      if (!resumenCambios.length) throw new Error('No especificaste ningún dato para cambiar de la regla.');
      try {
        const data = await actualizarReglaAutomatizacion(empresaId, regla.id, cambios);
        return { ok: true, id: data.id, nombre: data.nombre };
      } catch (error) {
        throw new Error(`editar_regla_automatizacion_asistente: ${error.message}`);
      }
    },
  },
  {
    name: 'consultar_cola_financiera_pendiente',
    description: 'Muestra cuántas tareas hay pendientes (o en error) en la cola financiera de la empresa, agrupadas por tipo: facturar (auto-facturación de pedidos entregados), notif_vencimiento (recordatorios de pago por vencer) y bloquear (bloqueo de clientes por deuda vencida). No ejecuta nada, solo informa. Usar para "cuánto falta procesar del cierre", "hay algo trabado en la cola financiera".',
    roles: ['dueno', 'admin'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const { data, error } = await db.from('cola_financiera')
        .select('tipo, estado')
        .eq('empresa_id', empresaId)
        .in('estado', ['pendiente', 'error', 'dead_letter']);
      if (error) throw new Error(`consultar_cola_financiera_pendiente: ${error.message}`);

      const resumen = {};
      for (const t of (data || [])) {
        resumen[t.tipo] ??= { pendiente: 0, error: 0, dead_letter: 0 };
        resumen[t.tipo][t.estado] = (resumen[t.tipo][t.estado] || 0) + 1;
      }
      return { total: (data || []).length, por_tipo: resumen };
    },
  },
  {
    name: 'ejecutar_cierre_financiero_pendiente',
    description: 'Procesa AHORA la cola financiera pendiente de la empresa (lo mismo que el cron automático haría en su próxima corrida): factura pedidos entregados, manda recordatorios de vencimiento por email/WhatsApp, y bloquea clientes con deuda vencida. ⚠️ Tiene efectos reales e irreversibles: puede emitir facturas electrónicas de verdad contra ARCA/AFIP. Usar solo cuando el usuario lo pida explícitamente ("procesá el cierre ahora", "facturá lo que esté pendiente"), nunca de forma proactiva.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: { type: 'object', properties: {} },
    async resumen({ empresaId }) {
      const { data, error } = await db.from('cola_financiera')
        .select('tipo')
        .eq('empresa_id', empresaId)
        .in('estado', ['pendiente', 'error'])
        .lte('proximo_intento', new Date().toISOString())
        .lt('intentos', 4);
      if (error) throw new Error(`ejecutar_cierre_financiero_pendiente: ${error.message}`);

      if (!data || !data.length) return 'No hay tareas pendientes en la cola financiera en este momento. No hace falta ejecutar nada.';

      const conteo = data.reduce((acc, t) => { acc[t.tipo] = (acc[t.tipo] || 0) + 1; return acc; }, {});
      const partes = [];
      if (conteo.facturar) partes.push(`${conteo.facturar} facturación(es) — puede emitir factura(s) real(es) contra ARCA/AFIP`);
      if (conteo.notif_vencimiento) partes.push(`${conteo.notif_vencimiento} recordatorio(s) de vencimiento por email/WhatsApp`);
      if (conteo.bloquear) partes.push(`${conteo.bloquear} bloqueo(s) de cliente por deuda vencida`);
      return `Procesar ahora la cola financiera pendiente: ${partes.join('; ')}. Esta acción no se puede deshacer.`;
    },
    async execute({ empresaId }) {
      const procesados = await procesarColaFinancieraEmpresa(empresaId);
      return { ok: true, procesados };
    },
  },
  {
    name: 'ejecutar_motor_automatizacion',
    description: 'Ejecuta AHORA, para esta empresa, uno de los motores de automatización del panel (lo mismo que el botón "Ejecutar ahora" de cada motor en /admin/automatizacion): piloto (genera sugerencias de pedido a partir de los ciclos de compra), cierre (procesa la cola financiera: factura pedidos entregados, manda recordatorios de vencimiento, bloquea clientes con deuda vencida), stock (analiza stock y genera órdenes de compra automáticas a proveedores si hace falta), score (recalcula el score de todos los clientes y ofrece plan de pago por WhatsApp a los que caen en riesgo) o auditoria (corre la detección de anomalías y avisa si encuentra algo nuevo). ⚠️ Cada motor tiene efectos reales e irreversibles: puede crear órdenes de compra, emitir facturas electrónicas de verdad contra ARCA/AFIP, o mandar WhatsApp/email/push a clientes. Usar solo cuando el usuario lo pida explícitamente para UN motor puntual ("corré el piloto ahora", "ejecutá el cierre", "analizá el stock ya", "recalculá el score", "corré la auditoría"), nunca de forma proactiva.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        motor: {
          type: 'string',
          enum: ['piloto', 'cierre', 'stock', 'score', 'auditoria'],
          description: 'Qué motor correr: piloto (sugerencias de pedido), cierre (cola financiera), stock (análisis y reposición autónoma), score (recalculo de score y ofertas de plan de pago), auditoria (detección de anomalías).',
        },
      },
      required: ['motor'],
    },
    async resumen({ args }) {
      const detalle = {
        piloto:    'generar sugerencias de pedido nuevas a partir de los ciclos de compra de los clientes',
        cierre:    'procesar la cola financiera pendiente — puede emitir factura(s) real(es) contra ARCA/AFIP, mandar recordatorios de vencimiento y bloquear clientes con deuda vencida',
        stock:     'analizar el stock y generar automáticamente órdenes de compra a proveedores para lo que esté bajo mínimo o por vencer',
        score:     'recalcular el score de todos los clientes y ofrecer plan de pago por WhatsApp a los que caigan en riesgo o bloqueado',
        auditoria: 'correr la detección de anomalías (descuentos repetidos, ajustes de stock sin respaldo, etc.) y avisar si aparece algo nuevo',
      };
      const texto = detalle[args.motor];
      if (!texto) throw new Error(`Motor inválido: ${args.motor}`);
      return `Ejecutar el motor "${args.motor}" ahora: ${texto}. Esta acción no se puede deshacer.`;
    },
    async execute({ empresaId, args }) {
      switch (args.motor) {
        case 'piloto': {
          const generados = await generarSugerenciasPilotoEmpresa(empresaId);
          return { ok: true, motor: 'piloto', generados };
        }
        case 'cierre': {
          const procesados = await procesarColaFinancieraEmpresa(empresaId);
          return { ok: true, motor: 'cierre', procesados };
        }
        case 'stock': {
          const ordenes_generadas = await analizarStockAutonomoEmpresa(empresaId);
          return { ok: true, motor: 'stock', ordenes_generadas };
        }
        case 'score': {
          const resultado = await recalcularScoreEmpresa(empresaId);
          return { ok: true, motor: 'score', ...resultado };
        }
        case 'auditoria': {
          const anomalias = await detectarAnomaliasAuditoriaEmpresa(empresaId, 1, true);
          return { ok: true, motor: 'auditoria', anomalias_detectadas: anomalias.length };
        }
        default:
          throw new Error(`Motor inválido: ${args.motor}`);
      }
    },
  },
];

export { TOOLS_AUTOMATIZACION };
