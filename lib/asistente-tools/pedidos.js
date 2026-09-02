// lib/asistente-tools/pedidos.js
// Tools del asistente — dominio: pedidos.
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
import { obtenerDepositoRealReserva } from '../repos/pedidos.js';

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

const TOOLS_PEDIDOS = [
  {
    name: 'contar_pedidos_pendientes',
    description: 'Cantidad total de pedidos pendientes (no entregados ni cancelados), desglosados por estado. Usar SOLO cuando piden el número/total ("cuántos pedidos tengo pendientes") — si piden el detalle uno por uno ("pasame los pedidos pendientes", "cuáles son"), usar listar_pedidos_pendientes en cambio.',
    roles: ['dueno', 'admin', 'vendedor', 'depositero'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const { data, error } = await db.rpc('contar_pedidos_pendientes', { p_empresa_id: empresaId });
      if (error) throw new Error(`contar_pedidos_pendientes: ${error.message}`);
      return data;
    },
  },
  {
    name: 'listar_pedidos_pendientes',
    description: 'Lista, uno por uno, los pedidos pendientes (no entregados ni cancelados: incluye borrador, confirmado, preparando, despachado y sugerido), con cliente, cantidad de items, total y su ID corto de 6 caracteres para referenciarlos después. Usar para "pasame los pedidos pendientes", "qué pedidos tengo sin entregar", "mostrame los pedidos que faltan". Mostrale al usuario el resultado real tal cual lo devuelve la herramienta — nunca inventes clientes ni montos de ejemplo.',
    roles: ['dueno', 'admin', 'vendedor', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        limite: { type: 'integer', description: 'Cantidad máxima a devolver. Si no lo dicen, usar 15.' },
      },
    },
    async execute({ empresaId, args }) {
      const limit = Math.min(parseInt(args.limite, 10) || 15, 50);
      const { data, error } = await db.from('pedidos')
        .select(`id, estado, total, created_at,
          clientes(razon_social),
          pedido_items(cantidad)`)
        .eq('empresa_id', empresaId)
        .not('estado', 'in', '(entregado,cancelado)')
        .order('created_at', { ascending: true })
        .limit(limit);
      if (error) throw new Error(`listar_pedidos_pendientes: ${error.message}`);
      return (data || []).map((p) => ({
        referencia_corta: String(p.id).slice(-6).toUpperCase(),
        cliente: p.clientes?.razon_social || null,
        estado: p.estado,
        total: p.total,
        cantidad_items: (p.pedido_items || []).length,
        creado: p.created_at,
      }));
    },
  },
  {
    name: 'diagnosticar_pedido',
    description: 'Diagnóstico completo de UN pedido puntual: estado, si tiene factura, si esa factura se emitió o dio error en ARCA/AFIP (con el motivo), y si quedó asentada en la cuenta corriente del cliente. Usar para "por qué no facturó tal pedido", "qué pasó con el pedido de tal cliente", "por qué el pedido #XXXXXX no avanza". Pasá el ID corto de 6 caracteres si lo tenés (ej. "#A1B2C3") o el UUID completo; si no lo tenés, pasá el nombre del cliente y la tool busca sola entre sus pedidos recientes — si hay uno solo lo diagnostica directo, si hay varios te los devuelve para que el usuario elija. Nunca le pidas el ID al usuario de entrada: intentá primero con el nombre del cliente.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'ID corto de 6 caracteres mostrado en el panel (con o sin "#") o UUID completo del pedido, si lo tenés.' },
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente, para buscar el pedido sin el ID. Usar cuando no tengas la referencia.' },
      },
    },
    roles: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
    async execute({ empresaId, args }) {
      const resuelto = await resolverReferenciaParaDiagnostico({
        empresaId, args, tabla: 'pedidos', columnaFecha: 'fecha_pedido', nombreDocumento: 'pedido',
      });
      if (resuelto.ambiguo) return resuelto.ambiguo;
      const { data, error } = await db.rpc('diagnosticar_pedido', {
        p_empresa_id: empresaId,
        p_referencia: resuelto.referencia,
      });
      if (error) throw new Error(`diagnosticar_pedido: ${error.message}`);
      return data;
    },
  },
  {
    name: 'diagnosticar_presupuesto',
    description: 'Diagnóstico completo de UN presupuesto puntual: si está en borrador, enviado, vencido, rechazado, o aceptado y convertido a pedido (y si quedó "aceptado" pero sin generar el pedido, un caso de bug a revisar manualmente). Usar para "por qué no se convirtió tal presupuesto en pedido", "qué pasó con el presupuesto de tal cliente", "el presupuesto #XXXXXX no generó el pedido". Pasá el ID corto de 6 caracteres si lo tenés (ej. "#A1B2C3") o el UUID completo; si no lo tenés, pasá el nombre del cliente y la tool busca sola entre sus presupuestos recientes — si hay uno solo lo diagnostica directo, si hay varios te los devuelve para que el usuario elija. Nunca le pidas el ID al usuario de entrada: intentá primero con el nombre del cliente.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'ID corto de 6 caracteres mostrado en el panel (con o sin "#") o UUID completo del presupuesto, si lo tenés.' },
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente, para buscar el presupuesto sin el ID. Usar cuando no tengas la referencia.' },
      },
    },
    roles: ['dueno', 'admin', 'vendedor', 'depositero'],
    async execute({ empresaId, args }) {
      const resuelto = await resolverReferenciaParaDiagnostico({
        empresaId, args, tabla: 'presupuestos', columnaFecha: 'created_at', nombreDocumento: 'presupuesto',
      });
      if (resuelto.ambiguo) return resuelto.ambiguo;
      const { data, error } = await db.rpc('diagnosticar_presupuesto', {
        p_empresa_id: empresaId,
        p_referencia: resuelto.referencia,
      });
      if (error) throw new Error(`diagnosticar_presupuesto: ${error.message}`);
      return data;
    },
  },
  {
    name: 'crear_pedido',
    description: 'Propone crear un pedido nuevo para un cliente, con una lista de productos y cantidades. Antes de llamarla, asegurate de tener del usuario: a qué cliente es (nombre, razón social, CUIT o teléfono) y al menos un producto con su cantidad — si falta alguno de los dos, pedíselo primero; nunca inventes ni asumas el cliente o una cantidad. Los precios, el stock y el límite de crédito del cliente siempre se validan en el servidor: nunca calcules ni menciones un precio o total vos mismo antes de llamar esta función.',
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre, razón social, CUIT o teléfono del cliente, tal como lo dio el usuario.' },
        items: {
          type: 'array',
          description: 'Productos a pedir, con al menos uno. Cada uno con el nombre tal como lo dijo el usuario y la cantidad.',
          items: {
            type: 'object',
            properties: {
              producto: { type: 'string', description: 'Nombre o parte del nombre del producto, tal como lo dio el usuario.' },
              cantidad: { type: 'number', description: 'Cantidad pedida de ese producto.' },
            },
            required: ['producto', 'cantidad'],
          },
        },
        notas: { type: 'string', description: 'Notas u observaciones del pedido, si el usuario dio alguna. Opcional.' },
        fecha_entrega: { type: 'string', description: 'Fecha de entrega pedida, en formato YYYY-MM-DD, si el usuario dio una. Opcional.' },
      },
      required: ['cliente', 'items'],
    },
    roles: ROLES_PEDIDO, // mismos roles que crearPedidoAdminHandler en lib/handlers/pedidos.js
    requiereConfirmacion: true,
    // A diferencia de anular_venta_pos.resumen() (que devuelve el texto del
    // error como si fuera un resumen normal), acá un problema de validación
    // se tira como excepción: ejecutarTool() nunca llega a crear una fila en
    // asistente_acciones_pendientes, así que no aparece un botón Confirmar
    // para algo que no se puede confirmar — el modelo recibe el error de
    // vuelta como resultado de la función y se lo explica al usuario en
    // texto, o le pide que aclare (ver mensajes de buscarClientePorTexto/
    // buscarProductoPorTexto más abajo).
    async resumen({ empresaId, args }) {
      const { clienteId, itemsResueltos } = await resolverPedidoDesdeArgs({ empresaId, args });
      const resultado = await crearPedidoParaCliente({
        empresaId,
        clienteId,
        items: itemsResueltos,
        notas: args.notas,
        fechaEntrega: args.fecha_entrega,
        preview: true,
      });
      if (!resultado.ok) throw new Error(resultado.error);

      const detalleItems = resultado.items.map((i) => `${i.cantidad} x ${i.producto}`).join(', ');
      return `Crear un pedido para ${resultado.cliente}: ${detalleItems}. Total $${resultado.total.toLocaleString('es-AR')}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Se resuelve todo de nuevo (cliente, productos, stock, precios,
      // crédito) contra el estado actual — no se reusa nada de resumen():
      // pudo haber pasado tiempo, cambiar el stock, o cambiar el saldo del
      // cliente desde que se propuso.
      const { clienteId, itemsResueltos } = await resolverPedidoDesdeArgs({ empresaId, args });
      const resultado = await crearPedidoParaCliente({
        empresaId,
        vendedorId: usuarioId,
        clienteId,
        items: itemsResueltos,
        notas: args.notas,
        fechaEntrega: args.fecha_entrega,
        preview: false,
      });
      if (!resultado.ok) throw new Error(resultado.error);
      return resultado;
    },
  },
  {
    name: 'crear_presupuesto',
    description: 'Propone crear un presupuesto/cotización nuevo para un cliente, con una lista de productos y cantidades. A diferencia de crear_pedido, un presupuesto es solo una cotización: no reserva stock ni descuenta límite de crédito. Antes de llamarla, asegurate de tener del usuario: a qué cliente es (nombre, razón social, CUIT o teléfono) y al menos un producto con su cantidad — si falta alguno de los dos, pedíselo primero; nunca inventes ni asumas el cliente o una cantidad. Los precios siempre se validan en el servidor: nunca calcules ni menciones un precio o total vos mismo antes de llamar esta función.',
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre, razón social, CUIT o teléfono del cliente, tal como lo dio el usuario.' },
        items: {
          type: 'array',
          description: 'Productos a cotizar, con al menos uno. Cada uno con el nombre tal como lo dijo el usuario y la cantidad.',
          items: {
            type: 'object',
            properties: {
              producto: { type: 'string', description: 'Nombre o parte del nombre del producto, tal como lo dio el usuario.' },
              cantidad: { type: 'number', description: 'Cantidad a cotizar de ese producto.' },
            },
            required: ['producto', 'cantidad'],
          },
        },
        notas: { type: 'string', description: 'Notas u observaciones del presupuesto, si el usuario dio alguna. Opcional.' },
      },
      required: ['cliente', 'items'],
    },
    roles: ROLES_PRESUPUESTO, // mismos roles que handlePresupuestos en lib/handlers/pedidos.js
    requiereConfirmacion: true,
    async resumen({ empresaId, args }) {
      const { clienteId, itemsResueltos } = await resolverPedidoDesdeArgs({ empresaId, args });
      const resultado = await crearPresupuestoParaCliente({
        empresaId,
        clienteId,
        items: itemsResueltos,
        notas: args.notas,
        preview: true,
      });
      if (!resultado.ok) throw new Error(resultado.error);

      const detalleItems = resultado.items.map((i) => `${i.cantidad} x ${i.producto}`).join(', ');
      return `Crear un presupuesto para ${resultado.cliente}: ${detalleItems}. Total $${resultado.total.toLocaleString('es-AR')}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Igual que en crear_pedido: se resuelve todo de nuevo contra el
      // estado actual, no se reusa nada de resumen().
      const { clienteId, itemsResueltos } = await resolverPedidoDesdeArgs({ empresaId, args });
      const resultado = await crearPresupuestoParaCliente({
        empresaId,
        vendedorId: usuarioId,
        clienteId,
        items: itemsResueltos,
        notas: args.notas,
        preview: false,
      });
      if (!resultado.ok) throw new Error(resultado.error);
      return resultado;
    },
  },
  {
    name: 'consultar_pedidos_sugeridos_piloto',
    description: 'Lista los pedidos que el Piloto Automático armó solo (a partir de los ciclos de compra habituales de cada cliente) y que están esperando revisión: todavía no se confirmaron ni se descartaron. Usar para "qué sugirió el piloto", "hay pedidos sugeridos para revisar", "qué pedidos automáticos hay pendientes".',
    roles: ['dueno', 'admin', 'vendedor', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        limite: { type: 'integer', description: 'Cantidad máxima a devolver. Si no lo dicen, usar 10.' },
      },
    },
    async execute({ empresaId, args }) {
      const limit = Math.min(parseInt(args.limite, 10) || 10, 50);
      const { data, error } = await db.from('pedidos')
        .select(`id, total, confianza_sugerencia, created_at,
          clientes(razon_social, telefono),
          pedido_items(cantidad, precio_unitario, productos(nombre, unidad))`)
        .eq('empresa_id', empresaId)
        .eq('estado', 'sugerido')
        .eq('generado_automatico', true)
        .order('confianza_sugerencia', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`consultar_pedidos_sugeridos_piloto: ${error.message}`);
      return data;
    },
  },
  {
    name: 'generar_sugerencias_piloto',
    description: 'Dispara ahora mismo al Piloto Automático para que revise los ciclos de compra de todos los clientes y arme pedidos sugeridos nuevos donde corresponda (lo mismo que hace el cron diario, pero al momento). Usar solo cuando el usuario lo pida explícitamente, ej. "generá las sugerencias de hoy", "corré el piloto automático ahora". No crea pedidos reales: solo propuestas en estado "sugerido" que después hay que confirmar una por una.',
    roles: ['dueno', 'admin'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const { data, error } = await db.rpc('generar_pedidos_sugeridos', { p_empresa_id: empresaId });
      if (error) throw new Error(`generar_sugerencias_piloto: ${error.message}`);
      return { generados: data || 0 };
    },
  },
  {
    name: 'confirmar_pedido_sugerido',
    description: 'Confirma UN pedido sugerido puntual generado por el Piloto Automático: pasa de "sugerido" a "confirmado" y se vuelve un pedido real (a partir de ahí sigue el circuito normal de stock/facturación). Usar solo cuando el usuario pida explícitamente confirmar un sugerido, dando el cliente o el ID corto del pedido.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'ID corto de 6 caracteres mostrado en el panel (con o sin "#") o UUID completo del pedido sugerido.' },
      },
      required: ['referencia'],
    },
    roles: ['dueno', 'admin', 'vendedor'],
    requiereConfirmacion: true,
    async resumen({ empresaId, args }) {
      const pedido = await buscarPedidoSugeridoPropio({ empresaId, referencia: args.referencia });
      if (pedido.error) throw new Error(pedido.error);
      return `Confirmar el pedido sugerido #${pedido.referencia_corta} de ${pedido.cliente} por $${pedido.total.toLocaleString('es-AR')}. Pasa a ser un pedido real.`;
    },
    async execute({ empresaId, args }) {
      const pedido = await buscarPedidoSugeridoPropio({ empresaId, referencia: args.referencia });
      if (pedido.error) throw new Error(pedido.error);
      const { error } = await db.from('pedidos')
        .update({ estado: 'confirmado' })
        .eq('id', pedido.id)
        .eq('empresa_id', empresaId)
        .eq('estado', 'sugerido');
      if (error) throw new Error(`confirmar_pedido_sugerido: ${error.message}`);
      return { ok: true, pedido_id: pedido.id };
    },
  },
  {
    name: 'descartar_pedido_sugerido',
    description: 'Descarta UN pedido sugerido puntual generado por el Piloto Automático (no se confirma, no se crea ningún pedido real). Usar solo cuando el usuario pida explícitamente descartar/rechazar un sugerido, dando el cliente o el ID corto del pedido.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'ID corto de 6 caracteres mostrado en el panel (con o sin "#") o UUID completo del pedido sugerido.' },
      },
      required: ['referencia'],
    },
    roles: ['dueno', 'admin', 'vendedor'],
    requiereConfirmacion: true,
    async resumen({ empresaId, args }) {
      const pedido = await buscarPedidoSugeridoPropio({ empresaId, referencia: args.referencia });
      if (pedido.error) throw new Error(pedido.error);
      return `Descartar el pedido sugerido #${pedido.referencia_corta} de ${pedido.cliente} por $${pedido.total.toLocaleString('es-AR')}. No se crea ningún pedido real.`;
    },
    async execute({ empresaId, args }) {
      const pedido = await buscarPedidoSugeridoPropio({ empresaId, referencia: args.referencia });
      if (pedido.error) throw new Error(pedido.error);
      // Mismo criterio que ciclos.js (estado: 'cancelado'), no el delete()
      // que usa piloto.js — deja rastro en vez de borrar la fila; ver nota
      // en el changelog v503 sobre la inconsistencia entre ambos handlers.
      const { error } = await db.from('pedidos')
        .update({ estado: 'cancelado' })
        .eq('id', pedido.id)
        .eq('empresa_id', empresaId)
        .eq('estado', 'sugerido');
      if (error) throw new Error(`descartar_pedido_sugerido: ${error.message}`);
      return { ok: true, pedido_id: pedido.id };
    },
  },
  {
    name: 'modificar_pedido_no_confirmado',
    description: 'Modifica las notas internas de un pedido que TODAVÍA está en borrador (no confirmado por el cliente). No permite cambiar los productos/cantidades del pedido (esa edición no existe en el sistema todavía) ni tocar pedidos ya confirmados — para cancelar un pedido ya confirmado, usar otra vía.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        pedido: { type: 'string', description: 'Número/referencia corta del pedido, o el nombre del cliente si no hay ambigüedad.' },
        notas_internas: { type: 'string', description: 'Nuevas notas internas del pedido.' },
      },
      required: ['pedido', 'notas_internas'],
    },
    async resumen({ empresaId, args }) {
      const pedido = await buscarPedidoBorradorPorTexto({ empresaId, texto: args.pedido });
      return `Actualizar las notas internas del pedido #${pedido.numero || pedido.id.slice(0, 8)} (borrador, cliente: ${pedido.cliente_nombre || 'sin nombre'}).`;
    },
    async execute({ empresaId, args }) {
      const pedido = await buscarPedidoBorradorPorTexto({ empresaId, texto: args.pedido });
      const { data, error } = await db.from('pedidos')
        .update({ notas_internas: args.notas_internas })
        .eq('id', pedido.id)
        .eq('empresa_id', empresaId)
        .select('id, notas_internas')
        .single();
      if (error) throw new Error(`modificar_pedido_no_confirmado: ${error.message}`);
      return { ok: true, id: data.id, notas_internas: data.notas_internas };
    },
  },
  {
    name: 'registrar_devolucion_pedido',
    description: 'Registra una devolución de uno o más productos de un pedido ya entregado o despachado, con motivo. Si el motivo es "producto defectuoso", genera automáticamente una nota de débito al proveedor por defecto de cada producto (si lo tiene configurado). Queda en estado "pendiente" para que un admin la revise después — esta tool no aprueba ni rechaza la devolución, ni repone stock.',
    roles: ['dueno', 'admin', 'vendedor'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        pedido: { type: 'string', description: 'ID corto de 6 caracteres del pedido (con o sin "#") o UUID completo.' },
        motivo: {
          type: 'string',
          description: 'Motivo de la devolución. Uno de: producto_defectuoso, error_pedido, cliente_arrepentido, vencido, otro.',
        },
        items: {
          type: 'array',
          description: 'Productos devueltos con su cantidad.',
          items: {
            type: 'object',
            properties: {
              producto: { type: 'string', description: 'Nombre o parte del nombre del producto.' },
              cantidad: { type: 'number', description: 'Cantidad devuelta.' },
              precio_unitario: { type: 'number', description: 'Precio unitario del ítem, si lo dan. Si no, se usa 0.' },
            },
            required: ['producto', 'cantidad'],
          },
        },
        notas: { type: 'string', description: 'Notas adicionales, si las dan.' },
      },
      required: ['pedido', 'motivo', 'items'],
    },
    async resumen({ empresaId, args }) {
      const resuelto = await resolverDevolucionPedido({ empresaId, args });
      const detalle = resuelto.itemsResueltos.map((it) => `${it.cantidad} × ${it.nombre}`).join(', ');
      return `Registrar devolución del pedido #${resuelto.pedido.referencia_corta} (motivo: ${resuelto.motivo}): ${detalle}.${resuelto.motivo === 'producto_defectuoso' ? ' Puede generar nota(s) de débito automática(s) al proveedor.' : ''} Queda pendiente de revisión.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Se resuelve todo de nuevo (pedido, productos) contra el estado
      // actual, igual que crear_pedido y anular_venta_pos — nunca se reusa
      // nada resuelto en resumen().
      const resuelto = await resolverDevolucionPedido({ empresaId, args });

      const itemsParaCore = resuelto.itemsResueltos.map((it) => ({
        producto_id: it.id,
        cantidad: it.cantidad,
        // precio_unitario va igual en el body por prolijidad, pero
        // crearDevolucionCore() lo ignora y lo recalcula server-side
        // (del pedido vinculado o precio_base actual) — ver hallazgo #0.
        precio_unitario: it.precio_unitario || 0,
      }));

      const resultado = await crearDevolucionCore({
        empresa_id: empresaId,
        chofer_id: usuarioId,
        body: {
          pedido_id: resuelto.pedido.id,
          cliente_id: resuelto.pedido.cliente_id,
          motivo: resuelto.motivo,
          notas: args.notas || null,
          foto_url: null,
          items: itemsParaCore,
        },
      });

      if (!resultado.ok) throw new Error(resultado.error);

      return {
        ok: true,
        devolucion_id: resultado.payload.devolucion.id,
        notas_debito_creadas: resultado.payload.notas_debito,
        items_sin_proveedor_default: resultado.payload.items_sin_proveedor_default,
      };
    },
  },
  {
    name: 'cancelar_pedido_asistente',
    description: 'Cancela un pedido: libera el stock que tenía reservado, revierte los puntos de fidelización acreditados, y anula la/las factura(s) vinculadas. Si el pedido ya tiene una factura EMITIDA con CAE real de AFIP/ARCA, esto emite una Nota de Crédito real para anularla fiscalmente — no es reversible con un simple cambio de estado. No se puede cancelar un pedido ya entregado o ya cancelado.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        pedido: { type: 'string', description: 'ID corto de 6 caracteres del pedido (con o sin "#") o UUID completo.' },
      },
      required: ['pedido'],
    },
    async resumen({ empresaId, args }) {
      const info = await diagnosticoPedidoParaCancelar({ empresaId, referencia: args.pedido });
      let advertenciaFactura = '';
      if (info.factura_estado === 'emitida') {
        advertenciaFactura = ` ⚠️ Este pedido tiene una factura emitida con CAE real (N° ${info.factura_numero ?? '—'}). Cancelar el pedido va a emitir una Nota de Crédito real contra ARCA/AFIP para anularla — no es una operación solo interna.`;
      } else if (info.factura_estado === 'pendiente') {
        advertenciaFactura = ' Tiene una factura pendiente (sin CAE) que se anulará junto con el pedido, sin efecto fiscal.';
      }
      return `Cancelar el pedido #${info.referencia_corta} de ${info.cliente} (estado actual: ${info.estado_pedido}). Libera el stock reservado y revierte los puntos acreditados.${advertenciaFactura} Esta acción no se puede deshacer.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const info = await diagnosticoPedidoParaCancelar({ empresaId, referencia: args.pedido });
      const pedidoId = info.pedido_id;

      // 2. Liberar stock reservado (solo si venía de confirmado/preparando).
      if (['confirmado', 'preparando'].includes(info.estado_pedido)) {
        const { data: items } = await db.from('pedido_items')
          .select('producto_id, cantidad')
          .eq('pedido_id', pedidoId);

        for (const item of (items || [])) {
          // Multi-depósito (550): antes esto "adivinaba" el depósito
          // (principal, o el primero que apareciera) en vez de usar el
          // depósito REAL donde se hizo la reserva original — con más de
          // un depósito con stock del mismo producto, eso liberaba stock
          // en el depósito equivocado y dejaba la reserva real trabada.
          // movimientos_stock ya guarda el depósito real de esa reserva
          // (mismo helper que usa confirmarPedidoHandler al cancelar).
          let depositoId = await obtenerDepositoRealReserva(empresaId, pedidoId, item.producto_id);

          if (!depositoId) {
            // Fallback para pedidos viejos sin movimiento de reserva
            // registrado (previos a que esto se auditara): mismo criterio
            // de siempre — principal, o el primer depósito con stock.
            const { data: stockRows } = await db.from('stock')
              .select('deposito_id, depositos!inner(es_principal, empresa_id)')
              .eq('producto_id', item.producto_id)
              .eq('depositos.empresa_id', empresaId);
            if (!stockRows || stockRows.length === 0) continue;
            const principal = stockRows.find((s) => s.depositos.es_principal);
            depositoId = (principal || stockRows[0]).deposito_id;
          }

          await db.rpc('liberar_stock_reservado', {
            p_producto_id: item.producto_id,
            p_deposito_id: depositoId,
            p_cantidad: item.cantidad,
          }).catch(() => {});
        }
      }

      // 3. Marcar como cancelado.
      const { error: errCancelar } = await db.from('pedidos')
        .update({ estado: 'cancelado' })
        .eq('id', pedidoId)
        .eq('empresa_id', empresaId);
      if (errCancelar) throw new Error(`cancelar_pedido_asistente: ${errCancelar.message}`);

      // 4. Revertir puntos de fidelización — best-effort, no bloquea.
      await db.rpc('revertir_puntos_pedido_cancelado', {
        p_pedido_id: pedidoId,
        p_empresa_id: empresaId,
      }).catch((err) => {
        console.error(`[cancelar_pedido_asistente] Error revirtiendo puntos del pedido ${pedidoId}:`, err.message);
      });

      // 5. Facturas vinculadas: pendiente → anular directo; emitida → NC real.
      const { data: facturasVinculadas } = await db.from('facturas')
        .select('id, estado, numero, cae')
        .eq('pedido_id', pedidoId)
        .in('estado', ['pendiente', 'emitida']);

      const notasCreditoEmitidas = [];
      const erroresNoCriticos = [];

      for (const f of (facturasVinculadas || [])) {
        if (f.estado === 'pendiente') {
          await db.from('facturas').update({ estado: 'anulada' }).eq('id', f.id);
          continue;
        }
        try {
          const { anularFactura } = await import('./facturas.js');
          const resultado = await anularFactura(f, 'Pedido cancelado', usuarioId);
          if (resultado.ok) {
            notasCreditoEmitidas.push({ factura_original_id: f.id, factura_original_numero: f.numero, nota_credito: resultado.nota_credito });
          } else {
            erroresNoCriticos.push(`No se pudo emitir la Nota de Crédito de la factura ${f.numero ?? f.id}: ${resultado.error}`);
          }
        } catch (errAnular) {
          erroresNoCriticos.push(`Error inesperado anulando la factura ${f.numero ?? f.id}: ${errAnular.message}`);
        }
      }

      return {
        ok: true,
        pedido_id: pedidoId,
        referencia_corta: info.referencia_corta,
        estado_anterior: info.estado_pedido,
        notas_credito_emitidas: notasCreditoEmitidas,
        errores_no_criticos: erroresNoCriticos,
      };
    },
  },
];

export { TOOLS_PEDIDOS };
