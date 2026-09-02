// lib/asistente-tools/export-contable.js
// Tools del asistente — dominio: export-contable.
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

const TOOLS_EXPORT_CONTABLE = [
  {
    name: 'consultar_configuracion_export_contable',
    description: 'Muestra la configuración de exportación contable de la empresa: proveedor (tango/bejerman/contabilium/generico_csv), si tiene plan de cuentas cargado, separador decimal y formato de fecha. Usar para "cómo está configurado el export contable", "qué proveedor contable tenemos cargado".',
    roles: ['dueno', 'admin', 'contador'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const { data, error } = await db.from('export_contable_config')
        .select('proveedor, plan_cuentas, separador_decimal, formato_fecha, activo')
        .eq('empresa_id', empresaId)
        .maybeSingle();
      if (error) throw new Error(`consultar_configuracion_export_contable: ${error.message}`);
      if (!data) return { configurado: false };
      const { plan_cuentas, ...resto } = data;
      return { configurado: true, ...resto, cuentas_cargadas: Object.keys(plan_cuentas || {}).length };
    },
  },
  {
    name: 'configurar_export_contable',
    description: 'Configura el proveedor contable al que se exporta (tango, bejerman, contabilium o generico_csv) y sus opciones de formato. NO carga el plan de cuentas (mapeo cuenta por cuenta) — eso requiere una pantalla dedicada, no tiene sentido dictarlo por chat. Usar solo cuando el usuario lo pida explícitamente.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        proveedor: { type: 'string', enum: ['tango', 'bejerman', 'contabilium', 'generico_csv'], description: 'Proveedor contable. Tango/Bejerman/Contabilium todavía no generan el archivo real (falta confirmar el layout) — igual se puede dejar configurado para cuando estén.' },
        separador_decimal: { type: 'string', enum: [',', '.'], description: 'Separador decimal a usar en los montos exportados. Default: ",".' },
        formato_fecha: { type: 'string', enum: ['DD/MM/YYYY', 'YYYY-MM-DD'], description: 'Formato de fecha a usar. Default: "DD/MM/YYYY".' },
        activo: { type: 'boolean', description: 'Si el export contable está habilitado. Default: true.' },
      },
    },
    async resumen({ args }) {
      const proveedor = args.proveedor || 'generico_csv';
      return `Configurar el export contable con proveedor "${proveedor}"${args.separador_decimal ? `, separador decimal "${args.separador_decimal}"` : ''}${args.formato_fecha ? `, formato de fecha "${args.formato_fecha}"` : ''}.`;
    },
    async execute({ empresaId, args }) {
      const { data: actual } = await db.from('export_contable_config')
        .select('plan_cuentas')
        .eq('empresa_id', empresaId)
        .maybeSingle();

      const { data, error } = await db.from('export_contable_config')
        .upsert({
          empresa_id: empresaId,
          proveedor: args.proveedor || 'generico_csv',
          plan_cuentas: actual?.plan_cuentas || {},
          separador_decimal: args.separador_decimal || ',',
          formato_fecha: args.formato_fecha || 'DD/MM/YYYY',
          activo: args.activo ?? true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'empresa_id' })
        .select('proveedor, separador_decimal, formato_fecha, activo')
        .single();
      if (error) throw new Error(`configurar_export_contable: ${error.message}`);
      return { ok: true, config: data };
    },
  },
  {
    name: 'consultar_historial_exportaciones_contables',
    description: 'Muestra las últimas exportaciones contables generadas (proveedor, tipo, período, cantidad de registros, cuándo). Usar para "cuándo fue la última exportación contable", "qué se exportó a Tango último".',
    roles: ['dueno', 'admin', 'contador'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const { data, error } = await db.from('export_contable_log')
        .select('proveedor, tipo, fecha_desde, fecha_hasta, cantidad_registros, archivo_nombre, created_at')
        .eq('empresa_id', empresaId)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw new Error(`consultar_historial_exportaciones_contables: ${error.message}`);
      return { historial: data || [] };
    },
  },
  {
    name: 'generar_export_contable',
    description: 'Genera un export contable (ventas, compras o cobranzas) de un período y devuelve el contenido. Solo el proveedor "generico_csv" está implementado hoy — si se pide tango/bejerman/contabilium y todavía no está implementado, se avisa en vez de fallar genérico. Si el período tiene muchos registros, no se manda el archivo completo: se avisa la cantidad y se sugiere acotar el rango (o generarlo desde el panel para descargar el archivo entero). No requiere confirmación: no modifica pedidos, facturas ni ningún dato de negocio, solo lee y arma un archivo (deja un registro en el historial, igual que el botón del panel).',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['ventas', 'compras', 'cobranzas'], description: 'Qué exportar.' },
        desde: { type: 'string', description: 'Fecha desde, YYYY-MM-DD.' },
        hasta: { type: 'string', description: 'Fecha hasta, YYYY-MM-DD.' },
        proveedor: { type: 'string', enum: ['tango', 'bejerman', 'contabilium', 'generico_csv'], description: 'Si no se manda, usa el proveedor configurado (o generico_csv si no hay ninguno configurado).' },
      },
      required: ['tipo', 'desde', 'hasta'],
    },
    async execute({ empresaId, args }) {
      const { tipo, desde, hasta } = args;
      if (new Date(desde) > new Date(hasta)) throw new Error('"desde" no puede ser posterior a "hasta".');

      const { data: config } = await db.from('export_contable_config')
        .select('proveedor, plan_cuentas, separador_decimal, formato_fecha')
        .eq('empresa_id', empresaId)
        .maybeSingle();

      const proveedor = args.proveedor || config?.proveedor || 'generico_csv';

      if (tipo !== 'cobranzas' && proveedor !== 'generico_csv') {
        const claves = Object.keys(config?.plan_cuentas || {});
        if (claves.length === 0) {
          throw new Error(`Falta configurar el plan de cuentas antes de exportar ${tipo} a ${proveedor}.`);
        }
      }

      let vista;
      if (tipo === 'ventas')  vista = 'v_comprobantes_contables_venta';
      if (tipo === 'compras') vista = 'v_comprobantes_contables_compra';

      let comprobantes = [];
      if (vista) {
        const { data, error } = await db.from(vista)
          .select('*')
          .eq('empresa_id', empresaId)
          .gte('fecha', desde)
          .lte('fecha', hasta)
          .order('fecha');
        if (error) throw new Error(`generar_export_contable: ${error.message}`);
        comprobantes = data || [];
      }

      // `params` se pasa por referencia: para 'cobranzas' generarExport()
      // reasigna params.comprobantes leyendo `cobros` directo (ver
      // lib/export-contable/index.js) — leer params.comprobantes.length
      // DESPUÉS del llamado (no la variable local `comprobantes`) es lo
      // que da el conteo real en ese caso.
      const params = {
        tipo, proveedor, comprobantes, desde, hasta,
        config: config || {},
        empresa_id: empresaId,
        supabase: db,
      };

      let resultado;
      try {
        resultado = await generarExport(params);
      } catch (err) {
        if (err.code === 'FORMATO_NO_IMPLEMENTADO') {
          throw new Error(`El formato "${proveedor}" todavía no está implementado (falta confirmar el layout exacto contra un caso real). Por ahora solo funciona "generico_csv".`);
        }
        throw new Error(`generar_export_contable: ${err.message}`);
      }

      const cantidadRegistros = params.comprobantes.length;

      await db.from('export_contable_log').insert({
        empresa_id: empresaId,
        proveedor,
        tipo,
        fecha_desde: desde,
        fecha_hasta: hasta,
        cantidad_registros: cantidadRegistros,
        archivo_nombre: resultado.nombreArchivo,
      }).catch(() => {});

      const LIMITE_REGISTROS_CHAT = 300;
      if (cantidadRegistros > LIMITE_REGISTROS_CHAT) {
        return {
          ok: true,
          demasiados_registros: true,
          cantidad_registros: cantidadRegistros,
          mensaje: `El período tiene ${cantidadRegistros} registros — es mucho para mostrar acá. Acotá el rango de fechas, o generalo desde el panel para descargar el archivo completo.`,
        };
      }

      return {
        ok: true,
        nombre_archivo: resultado.nombreArchivo,
        cantidad_registros: cantidadRegistros,
        contenido: resultado.contenido,
      };
    },
  },
];

export { TOOLS_EXPORT_CONTABLE };
