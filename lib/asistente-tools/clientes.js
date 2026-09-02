// lib/asistente-tools/clientes.js
// Tools del asistente — dominio: clientes.
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

const TOOLS_CLIENTES = [
  {
    name: 'consultar_bloqueo_cliente',
    description: 'Estado de bloqueo, score y deuda de un cliente puntual, dado su nombre. Usar cuando preguntan si tal cliente está bloqueado, por qué, o cuál es su score/deuda.',
    roles: ['dueno', 'admin', 'vendedor', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre o parte del nombre del cliente, tal como lo escribió el usuario.' },
      },
      required: ['nombre'],
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('consultar_bloqueo_cliente', {
        p_empresa_id: empresaId,
        p_nombre: args.nombre,
      });
      if (error) throw new Error(`consultar_bloqueo_cliente: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_ciclo_compra_cliente',
    description: 'Ciclo de compra habitual de UN cliente puntual: cada cuánto y cuánto suele pedir de cada producto, y si ya hay un pedido sugerido pendiente para él generado por el Piloto Automático. Usar para "cada cuánto compra tal cliente", "cuál es el pedido habitual de tal cliente".',
    roles: ['dueno', 'admin', 'vendedor'],
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente, tal como lo escribió el usuario.' },
      },
      required: ['cliente'],
    },
    async execute({ empresaId, args }) {
      // buscarClientePorTexto tira excepción (con un mensaje pensado para
      // que el modelo se lo repita al usuario) si no encuentra o es
      // ambiguo — no hace falta chequear un {error} acá, se propaga solo.
      const cliente = await buscarClientePorTexto({ empresaId, texto: args.cliente });

      const [{ data: ciclos, error: eCiclos }, { data: sugeridos, error: eSug }] = await Promise.all([
        db.from('ciclos_compra')
          .select('id, cantidad_promedio, intervalo_dias, ultima_compra, proximo_pedido, confianza, productos(nombre, unidad)')
          .eq('empresa_id', empresaId)
          .eq('cliente_id', cliente.id)
          .eq('activo', true)
          .order('proximo_pedido', { ascending: true }),
        db.from('pedidos')
          .select('id, total, confianza_sugerencia, fecha_pedido')
          .eq('empresa_id', empresaId)
          .eq('cliente_id', cliente.id)
          .eq('estado', 'sugerido')
          .eq('generado_automatico', true)
          .gte('fecha_pedido', new Date(Date.now() - 36 * 3600 * 1000).toISOString())
          .order('fecha_pedido', { ascending: false })
          .limit(1),
      ]);
      if (eCiclos) throw new Error(`consultar_ciclo_compra_cliente: ${eCiclos.message}`);
      if (eSug) throw new Error(`consultar_ciclo_compra_cliente: ${eSug.message}`);
      return { cliente: cliente.razon_social, ciclos: ciclos || [], sugerido_pendiente: sugeridos?.[0] || null };
    },
  },
  {
    name: 'consultar_score_cliente',
    description: 'Score de salud/comportamiento de pago de UN cliente puntual (numérico, 0-100) y su categoría de riesgo, dado su nombre. Usar para "cuál es el score de tal cliente", "qué categoría de riesgo tiene". Para saber si está bloqueado o cuánto debe, usar consultar_bloqueo_cliente en cambio.',
    roles: ['dueno', 'admin', 'vendedor', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente, tal como lo escribió el usuario.' },
      },
      required: ['cliente'],
    },
    async execute({ empresaId, args }) {
      const cliente = await buscarClientePorTexto({ empresaId, texto: args.cliente });
      const { data, error } = await db.from('clientes')
        .select('score_actual, score_categoria, score_actualizado')
        .eq('id', cliente.id)
        .eq('empresa_id', empresaId)
        .single();
      if (error) throw new Error(`consultar_score_cliente: ${error.message}`);
      return { cliente: cliente.razon_social, ...data };
    },
  },
  {
    name: 'consultar_puntos_cliente',
    description: 'Saldo de puntos de fidelización de UN cliente puntual: disponibles, canjeados y totales. Usar para "cuántos puntos tiene tal cliente", "puede canjear tal cliente".',
    roles: ['dueno', 'admin', 'vendedor'],
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente.' },
      },
      required: ['cliente'],
    },
    async execute({ empresaId, args }) {
      const cliente = await buscarClientePorTexto({ empresaId, texto: args.cliente });
      const { data, error } = await db.from('saldo_puntos')
        .select('puntos_disponibles, puntos_canjeados, puntos_totales, ultimo_movimiento')
        .eq('cliente_id', cliente.id)
        .eq('empresa_id', empresaId)
        .maybeSingle();
      if (error) throw new Error(`consultar_puntos_cliente: ${error.message}`);
      return {
        cliente: cliente.razon_social,
        puntos_disponibles: data?.puntos_disponibles ?? 0,
        puntos_canjeados: data?.puntos_canjeados ?? 0,
        puntos_totales: data?.puntos_totales ?? 0,
      };
    },
  },
  {
    name: 'canjear_recompensa_asistente',
    description: 'Canjea una recompensa del programa de fidelización a nombre de un cliente puntual, descontándole los puntos correspondientes. Usar solo cuando el usuario lo pida explícitamente, dando el cliente y la recompensa.',
    roles: ['dueno', 'admin', 'vendedor'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente.' },
        recompensa: { type: 'string', description: 'Nombre o parte del nombre de la recompensa a canjear.' },
      },
      required: ['cliente', 'recompensa'],
    },
    async resumen({ empresaId, args }) {
      const cliente = await buscarClientePorTexto({ empresaId, texto: args.cliente });
      const recompensa = await buscarRecompensaPorTexto({ empresaId, texto: args.recompensa });
      return `Canjear "${recompensa.nombre}" (${recompensa.puntos_requeridos} puntos) para ${cliente.razon_social}.`;
    },
    async execute({ empresaId, args }) {
      const cliente = await buscarClientePorTexto({ empresaId, texto: args.cliente });
      const recompensa = await buscarRecompensaPorTexto({ empresaId, texto: args.recompensa });
      const { data, error } = await db.rpc('canjear_recompensa', {
        p_empresa_id: empresaId,
        p_cliente_id: cliente.id,
        p_recompensa_id: recompensa.id,
      });
      if (error) throw new Error(`canjear_recompensa_asistente: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_precio_producto_cliente',
    description: 'Precio final que le corresponde a UN cliente puntual por uno o varios productos, ya aplicando precio especial de ese cliente, la lista de precios que tenga asignada, y las reglas de descuento por cantidad/categoría/zona vigentes. Usar para "a cuánto le vendo tal producto a tal cliente", "qué precio le corresponde a fulano por N unidades de tal cosa".',
    roles: ['dueno', 'admin', 'vendedor'],
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente.' },
        items: {
          type: 'array',
          description: 'Productos a cotizar, cada uno con su cantidad (afecta qué regla de descuento por volumen aplica).',
          items: {
            type: 'object',
            properties: {
              producto: { type: 'string', description: 'Nombre o parte del nombre del producto.' },
              cantidad: { type: 'number', description: 'Cantidad a cotizar. Si no se aclara, se asume 1.' },
            },
            required: ['producto'],
          },
        },
      },
      required: ['cliente', 'items'],
    },
    async execute({ empresaId, args }) {
      const cliente = await buscarClientePorTexto({ empresaId, texto: args.cliente });

      const itemsArg = Array.isArray(args.items) ? args.items : [];
      if (!itemsArg.length) throw new Error('Falta indicar al menos un producto para cotizar.');

      const productos = [];
      for (const item of itemsArg) {
        const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
        const cantidad = Number(item.cantidad) > 0 ? Number(item.cantidad) : 1;
        productos.push({ producto, cantidad });
      }

      const { data, error } = await db.rpc('resolver_precios_cliente', {
        p_cliente_id: cliente.id,
        p_producto_ids: productos.map((p) => p.producto.id),
        p_empresa_id: empresaId,
        p_cantidades: productos.map((p) => p.cantidad),
      });
      if (error) throw new Error(`consultar_precio_producto_cliente: ${error.message}`);

      const porId = new Map((data || []).map((r) => [r.producto_id, r]));
      return {
        cliente: cliente.razon_social,
        precios: productos.map(({ producto, cantidad }) => {
          const r = porId.get(producto.id);
          return {
            producto: producto.nombre,
            cantidad,
            precio: r?.precio ?? null,
            origen: r?.origen ?? null, // 'especial' | 'lista' | 'base' | 'regla'
            regla_aplicada: r?.regla_nombre ?? null,
          };
        }),
      };
    },
  },
  {
    name: 'crear_recompensa_asistente',
    description: 'Crea una recompensa nueva en el catálogo de fidelización por puntos (fidelizacion.html): descuento fijo, descuento porcentual, envío gratis o producto gratis, a cambio de una cantidad de puntos. Usar cuando el usuario pida explícitamente crear una recompensa/premio para el programa de puntos.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre de la recompensa (ej. "10% off en tu próxima compra").' },
        descripcion: { type: 'string', description: 'Descripción opcional, más detalle para el cliente.' },
        puntos_requeridos: { type: 'number', description: 'Cuántos puntos cuesta canjearla.' },
        tipo: { type: 'string', enum: ['descuento_fijo', 'descuento_porcentaje', 'envio_gratis', 'producto_gratis'], description: 'Tipo de recompensa.' },
        valor: { type: 'number', description: 'Monto del descuento fijo, porcentaje de descuento, o valor de referencia del producto gratis. No aplica a envio_gratis.' },
        cantidad_disponible: { type: 'number', description: 'Cupo máximo de canjes totales. Si no se aclara, queda ilimitada.' },
        fecha_inicio: { type: 'string', description: 'Fecha desde la que está disponible (YYYY-MM-DD). Opcional.' },
        fecha_fin: { type: 'string', description: 'Fecha hasta la que está disponible (YYYY-MM-DD). Opcional.' },
      },
      required: ['nombre', 'puntos_requeridos', 'tipo'],
    },
    async resumen({ args }) {
      const campos = validarCamposRecompensa(args);
      return `Crear la recompensa "${campos.nombre}": ${describirRecompensa(campos)}.`;
    },
    async execute({ empresaId, args }) {
      const campos = validarCamposRecompensa(args);
      const { data, error } = await db.from('recompensas')
        .insert({ empresa_id: empresaId, ...campos, activa: true })
        .select('id, nombre')
        .single();
      if (error) throw new Error(`crear_recompensa_asistente: ${error.message}`);
      return { ok: true, id: data.id, nombre: data.nombre };
    },
  },
  {
    name: 'editar_recompensa_asistente',
    description: 'Modifica una recompensa existente del catálogo de fidelización (nombre, descripción, puntos requeridos, tipo, valor, cupo, vigencia) o la activa/pausa sin borrarla. Solo cambia lo que el usuario pidió. Usar "referencia" con el nombre actual de la recompensa para ubicarla.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'Nombre (o parte del nombre) actual de la recompensa a editar.' },
        nombre: { type: 'string', description: 'Nuevo nombre, si lo piden cambiar.' },
        descripcion: { type: 'string', description: 'Nueva descripción, si la piden cambiar.' },
        puntos_requeridos: { type: 'number', description: 'Nuevo costo en puntos, si lo piden cambiar.' },
        tipo: { type: 'string', enum: ['descuento_fijo', 'descuento_porcentaje', 'envio_gratis', 'producto_gratis'], description: 'Nuevo tipo, si lo piden cambiar.' },
        valor: { type: 'number', description: 'Nuevo valor, si lo piden cambiar.' },
        cantidad_disponible: { type: 'number', description: 'Nuevo cupo total, si lo piden cambiar.' },
        fecha_inicio: { type: 'string', description: 'Nueva fecha de inicio (YYYY-MM-DD), si la piden cambiar.' },
        fecha_fin: { type: 'string', description: 'Nueva fecha de fin (YYYY-MM-DD), si la piden cambiar.' },
        activa: { type: 'boolean', description: 'true para activarla, false para pausarla sin borrarla.' },
      },
      required: ['referencia'],
    },
    async resumen({ empresaId, args }) {
      const recompensa = await buscarRecompensaPorTexto({ empresaId, texto: args.referencia });
      const { cambios, resumenCambios } = construirCambiosRecompensa(args);
      if (!resumenCambios.length) throw new Error('No especificaste ningún dato para cambiar de la recompensa.');
      return `Actualizar la recompensa "${recompensa.nombre}": ${resumenCambios.join(', ')}.`;
    },
    async execute({ empresaId, args }) {
      const recompensa = await buscarRecompensaPorTexto({ empresaId, texto: args.referencia });
      const { cambios, resumenCambios } = construirCambiosRecompensa(args);
      if (!resumenCambios.length) throw new Error('No especificaste ningún dato para cambiar de la recompensa.');
      cambios.updated_at = new Date().toISOString();
      const { data, error } = await db.from('recompensas')
        .update(cambios)
        .eq('id', recompensa.id)
        .eq('empresa_id', empresaId)
        .select('id, nombre')
        .single();
      if (error) throw new Error(`editar_recompensa_asistente: ${error.message}`);
      return { ok: true, id: data.id, nombre: data.nombre };
    },
  },
  {
    name: 'crear_cliente',
    description: 'Da de alta un cliente nuevo. Usar solo cuando el usuario lo pida explícitamente ("cargá un cliente nuevo llamado X", "creame el cliente tal"), o cuando crear_pedido/crear_presupuesto no encontraron un cliente parecido y el usuario confirma que es nuevo. Si ya existe uno con esa razón social o ese CUIT, no se crea de nuevo.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        razon_social: { type: 'string', description: 'Nombre o razón social del cliente (obligatorio).' },
        nombre_fantasia: { type: 'string', description: 'Nombre de fantasía, si lo dan (ej. el nombre del local).' },
        cuit: { type: 'string', description: 'CUIT del cliente, si lo dan.' },
        condicion_iva: {
          type: 'string',
          description: 'Condición ante el IVA. Si no la dan, usar "consumidor_final" (default de la tabla). Valores usados en el sistema: responsable_inscripto, monotributo, exento, consumidor_final.',
        },
        telefono: { type: 'string', description: 'Teléfono de contacto, si lo dan.' },
        email: { type: 'string', description: 'Email de contacto, si lo dan.' },
        domicilio: { type: 'string', description: 'Domicilio, si lo dan.' },
        localidad: { type: 'string', description: 'Localidad, si la dan.' },
        notas: { type: 'string', description: 'Notas internas, si las dan (ej. de dónde salió el dato — "pedido recibido por foto/WhatsApp").' },
      },
      required: ['razon_social'],
    },
    async resumen({ empresaId, args }) {
      const razonSocial = String(args.razon_social || '').trim();
      if (!razonSocial) throw new Error('Falta el nombre o razón social del cliente.');
      const existente = await buscarClienteExistente({ empresaId, razonSocial, cuit: args.cuit });
      if (existente) throw new Error(`Ya existe un cliente con ese${existente.motivo === 'cuit' ? ' CUIT' : 'a razón social'}: "${existente.nombre}". No hace falta crearlo de nuevo.`);
      return `Dar de alta al cliente "${razonSocial}"${args.cuit ? ` (CUIT ${args.cuit})` : ''}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const razonSocial = String(args.razon_social || '').trim();
      const existente = await buscarClienteExistente({ empresaId, razonSocial, cuit: args.cuit });
      if (existente) return { ok: true, id: existente.id, ya_existia: true };

      try {
        const data = await crearClienteRepo(empresaId, {
          razon_social: razonSocial,
          nombre_fantasia: args.nombre_fantasia?.trim() || null,
          cuit: args.cuit?.trim() || null,
          condicion_iva: args.condicion_iva || 'consumidor_final',
          telefono: args.telefono?.trim() || null,
          email: args.email?.trim() || null,
          domicilio: args.domicilio?.trim() || null,
          localidad: args.localidad?.trim() || null,
          notas: args.notas?.trim() || null,
        });
        await AuditRepo.registrarAuditoriaSilenciosa(empresaId, usuarioId, 'clientes', 'INSERT', data.id, null, data);
        return { ok: true, id: data.id };
      } catch (error) {
        // exigirLimitePlan() (dentro de crearClienteRepo) tira con
        // code: 'LIMITE_PLAN_ALCANZADO' cuando ya se llegó al cupo de
        // clientes del plan contratado — se traduce a un mensaje que el
        // usuario entienda, en vez del código interno.
        if (error.code === 'LIMITE_PLAN_ALCANZADO') {
          throw new Error('No se pudo crear el cliente: se llegó al límite de clientes del plan contratado. Hay que ampliar el plan para poder cargar más.');
        }
        throw new Error(`crear_cliente: ${error.message}`);
      }
    },
  },
  {
    name: 'editar_cliente_asistente',
    description: 'Modifica datos de un cliente ya existente (razón social, nombre de fantasía, CUIT, condición de IVA, teléfono, email, domicilio, localidad, notas) o lo reactiva si estaba inactivo. NO usar para dar de baja (eso es dar_de_baja_cliente_asistente) ni para crear uno nuevo (eso es crear_cliente). Solo pasar los campos que el usuario pidió cambiar; el resto queda igual.',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'Nombre, parte del nombre, CUIT o teléfono del cliente a editar.' },
        razon_social: { type: 'string', description: 'Nuevo nombre o razón social, si lo piden cambiar.' },
        nombre_fantasia: { type: 'string', description: 'Nuevo nombre de fantasía, si lo piden cambiar.' },
        cuit: { type: 'string', description: 'Nuevo CUIT, si lo piden cambiar.' },
        condicion_iva: { type: 'string', description: 'Nueva condición ante el IVA (responsable_inscripto, monotributo, exento, consumidor_final), si la piden cambiar.' },
        telefono: { type: 'string', description: 'Nuevo teléfono, si lo piden cambiar.' },
        email: { type: 'string', description: 'Nuevo email, si lo piden cambiar.' },
        domicilio: { type: 'string', description: 'Nuevo domicilio, si lo piden cambiar.' },
        localidad: { type: 'string', description: 'Nueva localidad, si la piden cambiar.' },
        notas: { type: 'string', description: 'Nuevas notas internas, si las piden cambiar.' },
        reactivar: { type: 'boolean', description: 'true si el usuario pide reactivar/dar de alta de nuevo a un cliente que estaba inactivo.' },
      },
      required: ['referencia'],
    },
    roles: ['dueno', 'admin', 'vendedor'], // mismo gate que PATCH /api/clientes: puede(perfil,'acceder','clientes')
    requiereConfirmacion: true,
    async resumen({ empresaId, args }) {
      const { cambios, resumenCambios } = construirCambiosCliente(args);
      if (!Object.keys(cambios).length) throw new Error('No especificaste ningún dato para cambiar del cliente.');
      const cliente = await buscarClienteParaCobroPorTexto({ empresaId, texto: args.referencia });
      if (cambios.activo === true && cliente.activo) throw new Error(`El cliente "${cliente.razon_social}" ya está activo.`);
      return `Actualizar al cliente "${cliente.razon_social}": ${resumenCambios.join(', ')}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const { cambios } = construirCambiosCliente(args);
      if (!Object.keys(cambios).length) throw new Error('No especificaste ningún dato para cambiar del cliente.');
      const cliente = await buscarClienteParaCobroPorTexto({ empresaId, texto: args.referencia });
      if (cambios.activo === true && cliente.activo) throw new Error(`El cliente "${cliente.razon_social}" ya está activo.`);

      try {
        const data = await actualizarClienteRepo(empresaId, cliente.id, cambios);
        await AuditRepo.registrarAuditoriaSilenciosa(empresaId, usuarioId, 'clientes', 'UPDATE', cliente.id, cliente, data);
        return { ok: true, id: data.id, razon_social: data.razon_social };
      } catch (error) {
        throw new Error(`editar_cliente_asistente: ${error.message}`);
      }
    },
  },
  {
    name: 'dar_de_baja_cliente_asistente',
    description: 'Da de baja (desactiva) UN cliente puntual. El cliente deja de aparecer en las búsquedas normales pero sus datos y su historial no se borran; se puede reactivar después con editar_cliente_asistente. Usar solo cuando el usuario lo pida explícitamente ("dá de baja a fulano", "eliminá el cliente tal").',
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'Nombre, parte del nombre, CUIT o teléfono del cliente a dar de baja.' },
      },
      required: ['referencia'],
    },
    roles: ['dueno', 'admin'], // ver nota arriba: más restrictivo a propósito que el botón directo del panel
    requiereConfirmacion: true,
    async resumen({ empresaId, args }) {
      const cliente = await buscarClienteParaCobroPorTexto({ empresaId, texto: args.referencia });
      if (!cliente.activo) throw new Error(`El cliente "${cliente.razon_social}" ya está inactivo.`);
      return `Dar de baja al cliente "${cliente.razon_social}". Queda inactivo pero no se borra su historial; se puede reactivar después.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const cliente = await buscarClienteParaCobroPorTexto({ empresaId, texto: args.referencia });
      if (!cliente.activo) throw new Error(`El cliente "${cliente.razon_social}" ya está inactivo.`);

      try {
        await desactivarClienteRepo(empresaId, cliente.id);
        await AuditRepo.registrarAuditoriaSilenciosa(empresaId, usuarioId, 'clientes', 'UPDATE', cliente.id, cliente, { activo: false });
        return { ok: true, id: cliente.id, razon_social: cliente.razon_social };
      } catch (error) {
        throw new Error(`dar_de_baja_cliente_asistente: ${error.message}`);
      }
    },
  },
  {
    name: 'consultar_situacion_bcra_cliente',
    description: 'Consulta la situación crediticia oficial ante el BCRA (Central de Deudores) y los cheques rechazados de un cliente o proveedor, a partir de su nombre o de su CUIT directo. Usar para "este cliente/proveedor está complicado con el banco", "tiene cheques rechazados", "qué situación crediticia tiene tal CUIT". Es información pública regulatoria, no un dato interno de la empresa.',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        cuit: { type: 'string', description: 'CUIT/CUIL de 11 dígitos, si lo tienen directo.' },
        cliente: { type: 'string', description: 'Nombre o parte del nombre de un cliente existente, si no dan el CUIT directo.' },
        proveedor: { type: 'string', description: 'Nombre o parte del nombre de un proveedor existente, si no dan el CUIT directo.' },
      },
    },
    async execute({ empresaId, args }) {
      const cuit = await resolverCuitParaBcra({ empresaId, args });

      const [situacionRes, rechazadosRes] = await Promise.allSettled([
        fetchBcraDirecto(`/centraldedeudores/v1.0/Deudas/${cuit}`),
        fetchBcraDirecto(`/centraldedeudores/v1.0/Deudas/ChequesRechazados/${cuit}`),
      ]);

      const situacion = situacionRes.status === 'fulfilled' && !situacionRes.value.notFound
        ? situacionRes.value.data?.results : null;
      const rechazados = rechazadosRes.status === 'fulfilled' && !rechazadosRes.value.notFound
        ? rechazadosRes.value.data?.results : null;

      return {
        cuit,
        situacion,
        cheques_rechazados: rechazados,
        errores: {
          situacion: situacionRes.status === 'rejected' ? 'No se pudo consultar la situación crediticia.' : null,
          cheques_rechazados: rechazadosRes.status === 'rejected' ? 'No se pudo consultar los cheques rechazados.' : null,
        },
      };
    },
  },
];

export { TOOLS_CLIENTES };
