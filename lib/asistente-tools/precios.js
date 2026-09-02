// lib/asistente-tools/precios.js
// Tools del asistente — dominio: precios.
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

const TOOLS_PRECIOS = [
  {
    name: 'listar_reglas_precio_asistente',
    description: 'Lista las reglas de descuento por cantidad/producto/categoría/zona configuradas (reglas-precio.html), con a qué producto o categoría y zona aplican, el tipo y valor del descuento, y si están activas. Usar para "qué reglas de precio hay cargadas", "mostrame los descuentos por volumen".',
    roles: ['dueno', 'admin', 'contador', 'vendedor'],
    parameters: {
      type: 'object',
      properties: {
        solo_activas: { type: 'boolean', description: 'true para traer solo las reglas activas. Si no se aclara, trae todas.' },
        busqueda: { type: 'string', description: 'Texto libre para filtrar por nombre de la regla, del producto, de la categoría o de la zona.' },
      },
    },
    async execute({ empresaId, args }) {
      const data = await listarReglasPrecio(empresaId, {
        activa: args.solo_activas === true ? true : undefined,
        busqueda: args.busqueda,
      });
      return (data || []).map((r) => ({
        nombre: r.nombre,
        producto: r.productos?.nombre || null,
        categoria: r.categorias?.nombre || null,
        zona: r.zonas?.nombre || null,
        cantidad_minima: r.cantidad_minima,
        tipo_descuento: r.tipo_descuento,
        valor: r.valor,
        vigencia: r.fecha_desde || r.fecha_hasta ? `${r.fecha_desde || 'sin inicio'} a ${r.fecha_hasta || 'sin fin'}` : 'sin fecha límite',
        prioridad: r.prioridad,
        activa: r.activa,
      }));
    },
  },
  {
    name: 'crear_regla_precio_asistente',
    description: 'Crea una regla de descuento nueva: un porcentaje o monto fijo de descuento que aplica a partir de una cantidad mínima, para un producto puntual O una categoría entera (nunca ambos a la vez), opcionalmente limitado a una zona y a un rango de fechas. Usar cuando el usuario pida explícitamente "creá un descuento de X% para tal producto desde Y unidades" o similar. Si no aclara el tipo de descuento (porcentaje o monto fijo), preguntarle antes de asumir.',
    roles: ['dueno', 'admin', 'contador'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre descriptivo de la regla (ej. "Descuento mayorista gaseosas").' },
        producto: { type: 'string', description: 'Nombre del producto al que aplica. No usar junto con categoria.' },
        categoria: { type: 'string', description: 'Nombre de la categoría a la que aplica. No usar junto con producto.' },
        zona: { type: 'string', description: 'Nombre de la zona a la que se limita la regla, si aplica solo ahí. Opcional.' },
        cantidad_minima: { type: 'number', description: 'Cantidad mínima de unidades para que el descuento empiece a aplicar. Default 1 si no se aclara.' },
        tipo_descuento: { type: 'string', enum: ['porcentaje', 'precio_fijo'], description: '"porcentaje" (descuento en % sobre el precio) o "precio_fijo" (precio final fijo).' },
        valor: { type: 'number', description: 'Valor del descuento: porcentaje (0-100) si tipo_descuento es porcentaje, o el precio final si es precio_fijo.' },
        fecha_desde: { type: 'string', description: 'Fecha desde la que empieza a regir (YYYY-MM-DD), si el usuario da una vigencia limitada. Opcional.' },
        fecha_hasta: { type: 'string', description: 'Fecha hasta la que rige (YYYY-MM-DD). Opcional.' },
        prioridad: { type: 'number', description: 'Prioridad frente a otras reglas que puedan superponerse (mayor número = se aplica primero). Opcional, default 0.' },
      },
      required: ['nombre', 'tipo_descuento', 'valor'],
    },
    async resumen({ empresaId, args }) {
      const campos = await armarCamposReglaPrecio({ empresaId, args });
      return `Crear la regla de precio "${campos.nombre}": ${describirReglaPrecio(campos)}.`;
    },
    async execute({ empresaId, args }) {
      const campos = await armarCamposReglaPrecio({ empresaId, args });
      try {
        const data = await crearReglaPrecio(empresaId, campos);
        return { ok: true, id: data.id, nombre: data.nombre };
      } catch (error) {
        throw new Error(`crear_regla_precio_asistente: ${error.message}`);
      }
    },
  },
  {
    name: 'editar_regla_precio_asistente',
    description: 'Modifica una regla de precio ya existente (nombre, producto, categoría, zona, cantidad mínima, tipo y valor de descuento, vigencia, prioridad) o la activa/desactiva sin borrarla. Solo cambia los campos que el usuario pidió; el resto queda igual. Usar "referencia" con el nombre actual de la regla para ubicarla.',
    roles: ['dueno', 'admin', 'contador'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'Nombre (o parte del nombre) actual de la regla a editar.' },
        nombre: { type: 'string', description: 'Nuevo nombre, si lo piden cambiar.' },
        producto: { type: 'string', description: 'Nuevo producto al que aplica, si lo piden cambiar.' },
        categoria: { type: 'string', description: 'Nueva categoría a la que aplica, si la piden cambiar.' },
        zona: { type: 'string', description: 'Nueva zona a la que se limita, si la piden cambiar.' },
        cantidad_minima: { type: 'number', description: 'Nueva cantidad mínima, si la piden cambiar.' },
        tipo_descuento: { type: 'string', enum: ['porcentaje', 'precio_fijo'], description: 'Nuevo tipo de descuento, si lo piden cambiar.' },
        valor: { type: 'number', description: 'Nuevo valor del descuento, si lo piden cambiar.' },
        fecha_desde: { type: 'string', description: 'Nueva fecha de inicio (YYYY-MM-DD), si la piden cambiar.' },
        fecha_hasta: { type: 'string', description: 'Nueva fecha de fin (YYYY-MM-DD), si la piden cambiar.' },
        prioridad: { type: 'number', description: 'Nueva prioridad, si la piden cambiar.' },
        activa: { type: 'boolean', description: 'true para activarla, false para pausarla sin borrarla.' },
      },
      required: ['referencia'],
    },
    async resumen({ empresaId, args }) {
      const regla = await buscarReglaPrecioPorTexto({ empresaId, texto: args.referencia });
      const { cambios, resumenCambios } = await armarCambiosReglaPrecio({ empresaId, args });
      if (!resumenCambios.length) throw new Error('No especificaste ningún dato para cambiar de la regla.');
      return `Actualizar la regla de precio "${regla.nombre}": ${resumenCambios.join(', ')}.`;
    },
    async execute({ empresaId, args }) {
      const regla = await buscarReglaPrecioPorTexto({ empresaId, texto: args.referencia });
      const { cambios, resumenCambios } = await armarCambiosReglaPrecio({ empresaId, args });
      if (!resumenCambios.length) throw new Error('No especificaste ningún dato para cambiar de la regla.');
      try {
        const data = await actualizarReglaPrecio(empresaId, regla.id, cambios);
        return { ok: true, id: data.id, nombre: data.nombre };
      } catch (error) {
        throw new Error(`editar_regla_precio_asistente: ${error.message}`);
      }
    },
  },
];

export { TOOLS_PRECIOS };
