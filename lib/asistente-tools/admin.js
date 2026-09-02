// lib/asistente-tools/admin.js
// Tools del asistente — dominio: admin.
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

const TOOLS_ADMIN = [
  {
    name: 'consultar_anomalias_auditoria',
    description: 'Anomalías detectadas en el log de auditoría de los últimos N días (ej. descuentos repetidos, anulaciones seguidas, movimientos fuera de horario, mismo usuario tocando algo muchas veces). Usar para "hubo algo raro esta semana", "detectaste alguna anomalía". No mostrar a roles que no sean dueño/admin: es información sensible sobre el comportamiento de otros usuarios.',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: 'Ventana de días hacia atrás. Si no lo dicen, usar 7.' },
      },
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('detectar_anomalias_auditoria', {
        p_empresa_id: empresaId,
        p_dias_lookback: args.dias ?? 7,
      });
      if (error) throw new Error(`consultar_anomalias_auditoria: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_datos_empresa',
    description: 'Muestra los datos editables de la empresa: razón social, CUIT, domicilio, teléfono, email, logo y si el catálogo público está habilitado. Usar para "cuáles son los datos de mi empresa", "qué CUIT tenemos cargado", "está prendido el catálogo público".',
    roles: ['dueno', 'admin'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const empresa = await obtenerDatosEmpresaActual({ empresaId });
      const { config, ...datosPublicos } = empresa;
      return {
        ...datosPublicos,
        catalogo_publico_habilitado: config?.catalogo_publico_habilitado === true,
      };
    },
  },
  {
    name: 'actualizar_datos_empresa',
    description: 'Actualiza los datos editables de la empresa (razón social, CUIT, domicilio, teléfono, email). Usar solo cuando el usuario pida explícitamente cambiar alguno de estos datos. No permite tocar el logo (eso se hace desde el panel, no por chat). Los campos que no se mandan quedan sin tocar, EXCEPTO que el handler real siempre pide nombre y CUIT juntos — si el usuario solo quiere cambiar un campo (ej. el teléfono), hay que completar el resto con los valores actuales.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Razón social. Si no se manda, se usa la actual.' },
        cuit: { type: 'string', description: 'CUIT de la empresa (11 dígitos, con o sin guiones). Si no se manda, se usa el actual.' },
        domicilio: { type: 'string', description: 'Domicilio fiscal, si lo dan.' },
        telefono: { type: 'string', description: 'Teléfono de contacto, si lo dan.' },
        email: { type: 'string', description: 'Email de contacto, si lo dan.' },
      },
    },
    async resumen({ empresaId, args }) {
      const actual = await obtenerDatosEmpresaActual({ empresaId });
      const update = armarUpdateDatosEmpresa({ actual, args });
      const cambios = [];
      if (update.nombre !== actual.nombre) cambios.push(`razón social: "${actual.nombre}" → "${update.nombre}"`);
      if (update.cuit !== actual.cuit) cambios.push(`CUIT: "${actual.cuit || '—'}" → "${update.cuit}"`);
      if (update.domicilio !== actual.domicilio) cambios.push(`domicilio: "${actual.domicilio || '—'}" → "${update.domicilio || '—'}"`);
      if (update.telefono !== actual.telefono) cambios.push(`teléfono: "${actual.telefono || '—'}" → "${update.telefono || '—'}"`);
      if (update.email !== actual.email) cambios.push(`email: "${actual.email || '—'}" → "${update.email || '—'}"`);
      if (!cambios.length) return 'No hay ningún cambio real respecto a los datos actuales de la empresa. No hace falta guardar nada.';
      return `Actualizar los datos de la empresa: ${cambios.join('; ')}.`;
    },
    async execute({ empresaId, args }) {
      const actual = await obtenerDatosEmpresaActual({ empresaId });
      const update = armarUpdateDatosEmpresa({ actual, args });
      const { data, error } = await db.from('empresas')
        .update(update)
        .eq('id', empresaId)
        .select('nombre, cuit, domicilio, telefono, email, logo_url')
        .single();
      if (error) {
        if (error.code === '23505') throw new Error('Ese CUIT ya está registrado por otra empresa.');
        throw new Error(`actualizar_datos_empresa: ${error.message}`);
      }
      return { ok: true, empresa: data };
    },
  },
  {
    name: 'actualizar_catalogo_publico_empresa',
    description: 'Prende o apaga el catálogo público de productos (la vista externa, sin login, que pueden ver clientes o cualquiera con el link). Usar solo cuando el usuario lo pida explícitamente ("activá el catálogo público", "sacá el catálogo público"). Al prenderlo, los productos y precios quedan visibles para cualquiera con el link — no es un cambio solo interno.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        activar: { type: 'boolean', description: 'true para habilitarlo, false para deshabilitarlo.' },
      },
      required: ['activar'],
    },
    async resumen({ empresaId, args }) {
      const empresa = await obtenerDatosEmpresaActual({ empresaId });
      const actual = empresa.config?.catalogo_publico_habilitado === true;
      const activar = Boolean(args.activar);
      if (actual === activar) return `El catálogo público ya está ${activar ? 'habilitado' : 'deshabilitado'}. No hace falta cambiar nada.`;
      return activar
        ? 'Habilitar el catálogo público: los productos y precios de la empresa van a quedar visibles para cualquiera con el link, sin necesidad de iniciar sesión.'
        : 'Deshabilitar el catálogo público: deja de ser accesible sin login.';
    },
    async execute({ empresaId, args }) {
      const activar = Boolean(args.activar);
      const empresa = await obtenerDatosEmpresaActual({ empresaId });
      const nuevoConfig = { ...(empresa.config || {}), catalogo_publico_habilitado: activar };
      const { error } = await db.from('empresas').update({ config: nuevoConfig }).eq('id', empresaId);
      if (error) throw new Error(`actualizar_catalogo_publico_empresa: ${error.message}`);
      return { ok: true, catalogo_publico_habilitado: activar };
    },
  },
  {
    name: 'consultar_historial_migraciones',
    description: 'Lista las últimas sesiones de migración de datos (clientes/productos/pedidos/etc. importados desde Excel/CSV): entidad, estado, cantidad de filas válidas/con error, cuándo. Usar para "qué migraciones corrí", "el historial de importaciones".',
    roles: ROLES_MIGRACION,
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const resultado = await listarSesionesMigracion({ empresa_id: empresaId });
      if (!resultado.ok) throw new Error(`consultar_historial_migraciones: ${resultado.error}`);
      return { sesiones: resultado.sesiones };
    },
  },
  {
    name: 'consultar_estado_migracion',
    description: 'Muestra el estado de una sesión de migración puntual (entidad, estado, filas válidas/con error, resumen de errores). Si no se pasa sesion_id, muestra la más reciente. Usar para "cómo quedó la migración", "por qué falló la última importación".',
    roles: ROLES_MIGRACION,
    parameters: {
      type: 'object',
      properties: {
        sesion_id: { type: 'string', description: 'ID de la sesión (ver consultar_historial_migraciones). Si se omite, se usa la más reciente.' },
      },
    },
    async execute({ empresaId, args }) {
      const resultado = await obtenerEstadoSesionMigracion({ empresa_id: empresaId, sesion_id: args.sesion_id });
      if (!resultado.ok) throw new Error(`consultar_estado_migracion: ${resultado.error}`);
      return { sesion: resultado.sesion };
    },
  },
  {
    name: 'consultar_usuarios_equipo',
    description: 'Lista el equipo interno de la empresa (nombre, email, rol, teléfono, activo/inactivo) — dueño, admins, vendedores, depositeros, choferes, contadores. No incluye clientes del portal. Usar para "quién tiene acceso al sistema", "qué rol tiene tal persona", "quién está desactivado".',
    roles: ROLES_USUARIOS,
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const resultado = await listarUsuariosEquipo({ empresa_id: empresaId });
      if (!resultado.ok) throw new Error(`consultar_usuarios_equipo: ${resultado.error}`);
      return { usuarios: resultado.usuarios };
    },
  },
];

export { TOOLS_ADMIN };
