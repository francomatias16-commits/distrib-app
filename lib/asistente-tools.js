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

import { db } from './repos/_db.js';
import {
  crearCliente as crearClienteRepo,
  actualizarCliente as actualizarClienteRepo,
  desactivarCliente as desactivarClienteRepo,
} from './repos/clientes.js';
import * as AuditRepo from './repos/audit.js';
import {
  crearPedidoParaCliente, ROLES_ADMIN as ROLES_PEDIDO,
  crearPresupuestoParaCliente, ROLES_ADMIN_PRES as ROLES_PRESUPUESTO,
} from './handlers/pedidos.js';
import { procesarColaFinancieraEmpresa } from './handlers/cierre.js';
import { generarSugerenciasPilotoEmpresa } from './handlers/piloto.js';
import { analizarYGenerarOrdenes as analizarStockAutonomoEmpresa } from './handlers/stock-auto.js';
import { recalcularScoreEmpresa } from './handlers/score.js';
import { detectarYNotificar as detectarAnomaliasAuditoriaEmpresa } from './handlers/auditoria.js';
import { generarExport } from './export-contable/index.js';
import {
  listarInvitacionesChofer, invitarChoferNuevo, invitarChoferExistente,
  revocarInvitacionChofer, ROLES_GESTION as ROLES_CHOFER_INVITACION,
  APP_URL_FALLBACK,
} from './handlers/chofer_invitacion.js';
import {
  listarSesionesMigracion, obtenerEstadoSesionMigracion, ROLES_MIGRACION,
} from './handlers/migracion.js';
import {
  generarLinkPortalProveedor, listarLinksPortalProveedor,
  revocarLinkPortalProveedor, ROLES_ESCRITURA as ROLES_PORTAL_PROVEEDOR,
} from './handlers/portal_proveedor.js';
import {
  listarUsuariosEquipo, ROLES_GESTION as ROLES_USUARIOS,
} from './handlers/usuarios.js';
import {
  listarReglasPrecio, crearReglaPrecio, actualizarReglaPrecio,
} from './repos/reglas-precio.js';
import {
  listarReglasAutomatizacion, crearReglaAutomatizacion, actualizarReglaAutomatizacion,
} from './repos/reglas-automatizacion.js';
import {
  listarOfertasActivas as listarOfertasLiquidacion,
  obtenerReglas as obtenerReglasLiquidacion,
  guardarReglas as guardarReglasLiquidacion,
} from './repos/stock.js';

// liquidacion.html (Fase D — plan §2/§6, CHANGELOG_v716): a diferencia del
// resto de filas 🔴 del inventario original, esta SÍ tenía handler +
// repo + RPC completos desde antes (lib/handlers/stock.js →
// handleLiquidacion(), lib/repos/stock.js, RPC generar_ofertas_liquidacion)
// — el diagnóstico de "sin RPC server-side, hay que construir handler
// primero" en §2 estaba mal, mismo tipo de error que ya se había
// encontrado con facturación en v715. Roles de lectura calcados de
// `stock: { acceder: [...] }` en lib/permisos-service.js, que es el
// gate real que usa handleLiquidacion() para listar ofertas y reglas.
// Roles de escritura (generar ahora / guardar reglas) más restrictivos
// a propósito, calcados del chequeo explícito `['dueno','admin']` que
// hace el handler para esas dos acciones puntuales (vendedor/depositero
// pueden VER pero no tocar reglas ni disparar la generación manual).

// Cuánto tiempo queda vigente una acción propuesta esperando el click
// de Confirmar/Cancelar. Pasado esto, un click tardío no ejecuta nada
// (se le pide al usuario que repita el pedido para generar un resumen
// fresco, por si mientras tanto cambió algo — ej. el pedido que se
// iba a anular ya se facturó).
const TTL_CONFIRMACION_MS = 10 * 60_000;

// Eventos y templates de WhatsApp disponibles para armar una regla de
// automatización por voz — deben coincidir exacto con EVENTOS_DISPONIBLES
// y TEMPLATES_WHATSAPP_DISPONIBLES de lib/repos/reglas-automatizacion.js
// (son la fuente de verdad; acá se duplican como arrays porque el schema
// de la tool necesita el `enum` en JS plano, no importado del repo, mismo
// criterio que TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE ya usa el resto
// del archivo para otros catálogos chicos). Si se agrega un evento o
// template nuevo en el repo, hay que sumarlo acá también.
// NOTA (fix v455): estas 4 constantes se movieron acá arriba, antes del
// array TOOLS, porque varias tools referencian el `enum` directamente en
// el objeto `parameters` (no dentro de un `execute`), y ese objeto se
// evalúa apenas se importa el módulo. Declaradas más abajo en el archivo,
// TOOLS explotaba con "Cannot access before initialization" (TDZ) al
// cargar /api/index, tirando 500 en todos los endpoints — incluido
// /api/admin/kpis, por eso el dashboard cargaba con todo en 0.
const EVENTOS_DISPONIBLES_ASISTENTE = [
  'pedido_creado',
  'pedido_facturado',
  'factura_anulada',
  'cliente_en_mora',
  'cheques_por_vencer',
];

const EVENTOS_LABELS_ASISTENTE = {
  pedido_creado: 'se crea un pedido',
  pedido_facturado: 'se factura un pedido',
  factura_anulada: 'se anula una factura',
  cliente_en_mora: 'un cliente entra en mora',
  cheques_por_vencer: 'un cheque está por vencer',
};

const TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE = [
  'confirmacion_pedido',
  'pedido_despachado',
  'pedido_cancelado',
  'deuda_vencida',
  'pedido_entregado',
  'pedido_no_entregado',
  'pedido_por_llegar',
  'cheques_por_vencer',
  'oferta_plan_pago',
  'ruta_asignada',
];

// Roles internos válidos para accion.roles (notificar_push/crear_tarea) de
// una regla de automatización — mismos checkboxes que ra-roles-grid/
// ra-tarea-roles-grid en frontend/admin/js/automatizacion.js. 'cliente'
// queda afuera a propósito (no es un rol interno, ver usuarios.js).
const ROLES_NOTIFICACION_VALIDOS = ['dueno', 'admin', 'vendedor', 'depositero', 'chofer', 'contador'];

const TOOLS = [
  {
    name: 'consultar_deuda_proveedor',
    description: 'Saldo pendiente de pago con un proveedor puntual, dado su nombre. Usar cuando preguntan cuánto se le debe a tal proveedor.',
    // Mismos roles que ven "Proveedores"/"Lo que le debo a mis proveedores" en el nav (ver nav-data.js).
    roles: ['dueno', 'admin', 'contador', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre o parte del nombre del proveedor, tal como lo escribió el usuario.' },
      },
      required: ['nombre'],
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('consultar_deuda_proveedor', {
        p_empresa_id: empresaId,
        p_nombre: args.nombre,
      });
      if (error) throw new Error(`consultar_deuda_proveedor: ${error.message}`);
      return data;
    },
  },
  {
    name: 'listar_facturas_proveedor_por_vencer',
    description: 'Facturas de proveedores pendientes o parciales que vencen en los próximos N días. Usar para "qué facturas de proveedor vencen esta semana/mes", "cuánto tengo que pagar próximamente".',
    roles: ['dueno', 'admin', 'contador', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: 'Ventana de días hacia adelante. Si no lo dicen, usar 7.' },
      },
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('listar_facturas_proveedor_por_vencer', {
        p_empresa_id: empresaId,
        p_dias: args.dias ?? 7,
      });
      if (error) throw new Error(`listar_facturas_proveedor_por_vencer: ${error.message}`);
      return data;
    },
  },
  {
    name: 'listar_lotes_por_vencer',
    description: 'Lotes de stock con fecha de vencimiento próxima (riesgo de liquidación/vencimiento). Usar para "qué productos están por vencer", "riesgo de vencimiento de stock".',
    roles: ['dueno', 'admin', 'depositero', 'vendedor'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: 'Ventana de días hacia adelante. Si no lo dicen, usar 15.' },
      },
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('listar_lotes_por_vencer', {
        p_empresa_id: empresaId,
        p_dias: args.dias ?? 15,
      });
      if (error) throw new Error(`listar_lotes_por_vencer: ${error.message}`);
      return data;
    },
  },
  {
    name: 'listar_cheques_alerta',
    description: 'Cheques de clientes rechazados o por vencer en los próximos N días. Usar para "qué cheques se rechazaron", "qué cheques tengo que depositar/cobrar pronto".',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: 'Ventana de días hacia adelante para los que vencen (los rechazados siempre se incluyen). Si no lo dicen, usar 7.' },
      },
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('listar_cheques_alerta', {
        p_empresa_id: empresaId,
        p_dias: args.dias ?? 7,
      });
      if (error) throw new Error(`listar_cheques_alerta: ${error.message}`);
      return data;
    },
  },
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
    name: 'consultar_ruta_dia',
    description: 'Rutas de entrega de una fecha (por defecto hoy), opcionalmente filtradas por chofer, con resumen de entregas pendientes/confirmadas. Usar para "cómo va la ruta de hoy", "qué le falta entregar a tal chofer".',
    roles: ['dueno', 'admin', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD. Si no la dicen, usar la fecha de hoy.' },
        chofer: { type: 'string', description: 'Nombre del chofer, si lo mencionan.' },
      },
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('consultar_ruta_dia', {
        p_empresa_id: empresaId,
        p_fecha: args.fecha || new Date().toISOString().slice(0, 10),
        p_chofer_nombre: args.chofer || null,
      });
      if (error) throw new Error(`consultar_ruta_dia: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_stock_critico',
    description: 'Cantidad total de productos en stock crítico o por debajo del mínimo, sin el detalle de cuáles. Usar SOLO cuando piden el número ("cuántos productos tengo en stock crítico") — si piden CUÁLES son o cuánto conviene reponer ("qué productos tienen poco stock", "qué me conviene reponer"), usar consultar_analisis_stock_predictivo en cambio, que da el detalle producto por producto.',
    roles: ['dueno', 'admin', 'depositero'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const ahora = new Date().toISOString();
      const { data, error } = await db.rpc('obtener_kpis_dashboard_v2', {
        p_empresa_id: empresaId,
        p_desde: ahora,
        p_hasta: ahora,
        p_desde_anterior: ahora,
      });
      if (error) throw new Error(`obtener_kpis_dashboard_v2: ${error.message}`);
      return { stock_critico_count: data?.stock_critico_count ?? null };
    },
  },
  // La tabla movimientos_stock (kardex de ingresos/egresos/ajustes/
  // transferencias/reservas/liberaciones) existe y se usa en varios
  // handlers del sistema, pero no había ninguna tool para consultarla
  // desde el asistente. RPC 423 (listar_movimientos_stock), scopeada
  // vía deposito_id -> depositos.empresa_id, cap 20 filas mostradas
  // (total_movimientos trae el conteo real).
  {
    name: 'listar_movimientos_stock',
    description: 'Historial de movimientos de stock (ingresos, egresos, ajustes, transferencias, reservas y liberaciones) de los últimos N días, opcionalmente filtrado por producto y/o tipo. Usar para "qué movimientos de stock hubo", "pasame el kardex", "qué entró/salió del depósito", "movimientos del producto X". Máximo 20 filas mostradas; si total_movimientos supera eso, aclarárselo al usuario.',
    roles: ['dueno', 'admin', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre (o parte del nombre) del producto para filtrar. Opcional.' },
        tipo: { type: 'string', description: 'Tipo de movimiento a filtrar: ingreso, egreso, ajuste, transferencia, reserva o liberacion. Opcional.' },
        dias: { type: 'integer', description: 'Ventana de días hacia atrás. Si no lo dicen, usar 7.' },
      },
    },
    async execute({ empresaId, args }) {
      const dias = Math.min(parseInt(args.dias, 10) || 7, 90);
      const { data, error } = await db.rpc('listar_movimientos_stock', {
        p_empresa_id: empresaId,
        p_producto: args.producto || null,
        p_tipo: args.tipo || null,
        p_dias: dias,
      });
      if (error) throw new Error(`listar_movimientos_stock: ${error.message}`);
      return data;
    },
  },
  {
    name: 'listar_conteos_stock',
    description: 'Historial de conteos físicos de inventario (cantidad de sistema vs cantidad contada, con la diferencia y el motivo) de los últimos N días, opcionalmente filtrado por producto y/o solo mostrando los que tuvieron diferencia. Usar para "hubo faltantes en el último inventario", "qué diferencias dio el conteo de tal producto", "pasame los conteos de stock de esta semana". Máximo 20 filas mostradas; si total_conteos supera eso, aclarárselo al usuario. total_con_diferencia y suma_diferencias son sobre TODO el período filtrado, no solo las filas mostradas.',
    roles: ['dueno', 'admin', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre (o parte del nombre) del producto para filtrar. Opcional.' },
        soloConDiferencia: { type: 'boolean', description: 'Si es true, muestra solo los conteos donde cantidad_contada difirió de cantidad_sistema. Si no lo piden explícitamente, usar false.' },
        dias: { type: 'integer', description: 'Ventana de días hacia atrás. Si no lo dicen, usar 30.' },
      },
    },
    async execute({ empresaId, args }) {
      const dias = Math.min(parseInt(args.dias, 10) || 30, 180);
      const { data, error } = await db.rpc('listar_conteos_stock', {
        p_empresa_id: empresaId,
        p_producto: args.producto || null,
        p_solo_con_dif: args.soloConDiferencia === true,
        p_dias: dias,
      });
      if (error) throw new Error(`listar_conteos_stock: ${error.message}`);
      return data;
    },
  },
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
  // No hace falta ninguna RPC nueva: mismo criterio de "pendiente" que ya
  // usa la RPC contar_pedidos_pendientes (196) — todo pedido que no llegó a
  // 'entregado' ni fue 'cancelado' — pero acá se trae el detalle fila por
  // fila en vez de un agregado, con el mismo patrón de query directa
  // (db.from + service role, scopeada por empresa_id) que ya usa
  // consultar_pedidos_sugeridos_piloto más abajo. Se agregó porque antes NO
  // existía ninguna tool que devolviera esta lista con nombre de cliente e
  // items — el modelo, al no tener con qué responder "pasame los pedidos
  // pendientes", inventaba clientes de ejemplo (Cliente XXX/YYY/ZZZ) en vez
  // de admitir que no tenía el dato. La referencia_corta (últimos 6
  // caracteres del id, mismo formato que se ve en el panel) permite que,
  // si después preguntan "por qué no facturó el segundo", el modelo pueda
  // usar diagnosticar_pedido con esa referencia sin tener que volver a
  // pedírsela al usuario.
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
    name: 'diagnosticar_cheque',
    description: 'Diagnóstico completo de UN cheque puntual de un cliente: si está en cartera, depositado, cobrado, rechazado, endosado a un proveedor o anulado. Usar para "por qué se rechazó tal cheque", "qué pasó con el cheque de tal cliente", "el cheque de tal cliente sigue en cartera". A diferencia de pedidos/presupuestos/ventas, un cheque no tiene un ID corto visible en el panel: se busca por el nombre del cliente y, si hay más de un cheque de ese cliente, por el número de cheque para desambiguar (pedíselo al usuario si la respuesta es ambigua, no adivines cuál es).',
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre o parte del nombre del cliente dueño del cheque, tal como lo escribió el usuario.' },
        numero: { type: 'string', description: 'Número de cheque, solo si el usuario lo mencionó o si una respuesta previa fue ambigua y ya se lo pediste.' },
      },
      required: ['cliente'],
    },
    roles: ['dueno', 'admin', 'contador'],
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('diagnosticar_cheque', {
        p_empresa_id: empresaId,
        p_cliente_nombre: args.cliente,
        p_numero: args.numero || null,
      });
      if (error) throw new Error(`diagnosticar_cheque: ${error.message}`);
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
  // facturas.js (PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md, Fase A, ítem 3):
  // mismo perfil de riesgo que anular_venta_pos de arriba, pero de mayor
  // severidad todavía — acá SÍ hay de por medio un comprobante fiscal real
  // con CAE de ARCA/AFIP. Se investigó el flujo real completo
  // (facturacion.js → anularFacturaHandler → lib/facturas.js:anularFactura
  // → emitirNotaCreditoARCA) antes de escribir esto: NO se llama por RPC
  // (no existe una `anular_factura` en la base, es lógica JS en
  // lib/facturas.js), así que se reusa directo el mismo import relativo
  // `./facturas.js` que ya usa cancelar_pedido_asistente para el mismo
  // caso (factura con CAE vinculada a un pedido cancelado) — es EL MISMO
  // camino, nunca se pisa `facturas.estado` a mano. Roles y el chequeo
  // `estado !== 'emitida'` calcados de anularFacturaHandler
  // (lib/handlers/facturas.js): mismo gate ['dueno','admin','contador'].
  //
  // No existe RPC `diagnosticar_factura` (a diferencia de pedido/
  // presupuesto/venta_pos), así que la resolución por referencia se hace
  // en JS contra las facturas de esta empresa (buscarFacturaPorReferencia,
  // mismo patrón que buscarMovimientoBancarioPorReferencia) y la
  // resolución por nombre de cliente reusa resolverReferenciaParaDiagnostico
  // tal cual (tabla `facturas`, columna `fecha_emision`) — no se duplica
  // ese mecanismo.
  //
  // Riesgo de timeout NO resuelto acá, documentado a propósito: la emisión
  // ARCA puede tardar >30s (ver el AbortController de 45s del propio admin
  // en facturacion.js) y api/index.js entero corre bajo un único
  // maxDuration de 60s (vercel.json). Mismo riesgo ya asumido sin
  // mitigación especial por ejecutar_cierre_financiero_pendiente y
  // ejecutar_motor_automatizacion (motor 'cierre'), que también pueden
  // emitir facturas ARCA reales desde este mismo dispatcher — no se
  // inventa una mitigación nueva solo para esta tool.
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
  // facturas.js (PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md, Fase A, ítem 3
  // — segunda mitad, cierra el ítem junto con anular_factura de arriba).
  // Decisión de alcance confirmada con el usuario: replica el botón manual
  // tal cual existe hoy (no un caso acotado a "un pedido puntual" nada
  // más) — el botón real NO vive en facturacion.html (se buscó ahí primero
  // y no hay ningún "nueva factura"/"generar factura" — ver comentario de
  // anular_factura arriba), vive en pedidos.html:
  // `generarFactura(pedidoId)` (frontend/admin/js/pedidos.js) → POST
  // /api/facturas → `emitirFactura(pedido_id)` (lib/facturas.js, MISMO
  // módulo que ya usa anular_factura). El botón se muestra por pedido, no
  // como selector de una lista — "elegir cualquier pedido facturable" se
  // traduce acá a resolver el pedido por referencia o por nombre de
  // cliente (como el resto de las tools del archivo), no a una tool de
  // listado nueva: ya existen `listar_pedidos_pendientes`/
  // `diagnosticar_pedido` para que el usuario ubique cuál quiere facturar
  // antes de pedir esta acción.
  //
  // Elegibilidad calcada EXACTA del `puedeFacturar` real
  // (frontend/admin/js/pedidos.js:802): pedido no `borrador`/`pendiente`/
  // `cancelado`, y (sin factura vinculada O con una en `pendiente`/
  // `error_afip` — ahí el botón dice "Reintentar" en vez de "Generar", y
  // esta tool distingue lo mismo en su resumen()). Si el pedido ya tiene
  // una factura `emitida`, esta tool no sirve — para anularla está
  // anular_factura, arriba.
  //
  // Antes de llamar a emitirFactura() se repite la MISMA verificación de
  // pertenencia a empresa que agregó el FIX (FACTURAS-002, auditoría
  // 2026-07-26, ver comentario en lib/handlers/facturas.js): esa función
  // bajo service_role no filtra sola por empresa_id (traerOrigenPedido no
  // tiene `.eq('empresa_id', ...)`), así que sin este chequeo cualquier
  // rol facturador de una empresa podría facturar el pedido de OTRA
  // empresa con el certificado/CUIT equivocado.
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
  // ── Piloto Automático (lib/handlers/piloto.js) + Ciclos de compra
  // (lib/handlers/ciclos.js) — v503. No hace falta ninguna RPC nueva: son
  // los mismos SELECT/UPDATE/DELETE que ya hacen esos dos handlers HTTP,
  // scopeados igual por empresa_id vía el perfil ya verificado.
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
  // ── Siguiente tanda del roadmap v4 (score.js, stock-auto.js,
  // auditoria.js, proveedores.js — lectura). Todas envuelven RPCs ya
  // existentes; ninguna requiere confirmación por ser de solo lectura.
  // NOTA sobre comparar_precios_proveedores/ranking_ahorro_proveedores:
  // antes de agregar estas dos tools se encontró que ambas RPCs eran
  // funciones SQL planas sin SECURITY DEFINER ni chequeo de tenant,
  // otorgadas incluso a `anon` — cualquiera con la anon key pública podía
  // pedir p_empresa_id de OTRA empresa y ver sus precios de compra reales.
  // Se corrigió en la migración 422 (mismo patrón que assert_empresa_access
  // ya usa el resto de la base) ANTES de exponerlas acá como tool.
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
  // Fase A del plan de cobertura por voz (PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md):
  // cablea sobre registrar_cobro_completo, la MISMA RPC que ya usa
  // rutas.html ("Registrar cobro" del resumen del día) — no se creó RPC
  // nueva ni se tocó la existente. Deliberadamente NO admite aplicar el
  // cobro a una factura puntual (p_facturas_aplicadas): eso requiere que
  // el usuario elija entre varias facturas abiertas, que es exactamente
  // el tipo de decisión con varias opciones ambiguas que no conviene
  // resolver por voz sin una lista visual — se deja para la pantalla de
  // Cuenta corriente. Este cobro queda como cobro general de cuenta
  // corriente, igual que "Registrar cobro" en Rutas del día.
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
  {
    name: 'consultar_analisis_stock_predictivo',
    description: 'Análisis predictivo de stock: qué productos conviene reponer pronto, cantidad sugerida y días hasta quiebre, considerando demanda comprometida y oferta en camino (órdenes de compra ya emitidas). Usar para "qué me conviene reponer esta semana", "qué productos se están por quedar sin stock".',
    roles: ['dueno', 'admin', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        soloUrgentes: { type: 'boolean', description: 'Si es true (default), devuelve solo productos que necesitan reposición. Si es false, trae el panorama completo.' },
        limite: { type: 'integer', description: 'Cantidad máxima a devolver. Si no lo dicen, usar 15.' },
      },
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('analizar_stock_predictivo', { p_empresa_id: empresaId });
      if (error) throw new Error(`consultar_analisis_stock_predictivo: ${error.message}`);
      const soloUrgentes = args.soloUrgentes !== false;
      const limite = Math.min(parseInt(args.limite, 10) || 15, 50);
      let filas = data || [];
      if (soloUrgentes) filas = filas.filter((f) => f.necesita_reponer);
      return filas
        .sort((a, b) => (a.dias_hasta_quiebre ?? Infinity) - (b.dias_hasta_quiebre ?? Infinity))
        .slice(0, limite);
    },
  },
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
    name: 'comparar_precios_proveedor_producto',
    description: 'Compara el precio pagado a cada proveedor por UN producto puntual (o todos, si no se especifica) en los últimos N meses: último precio, mínimo, máximo y promedio por proveedor. Usar para "a qué proveedor le compro más barato tal producto", "compará precios de proveedores para tal producto".',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre del producto, si lo mencionan. Si no lo dan, se comparan todos los productos con más de un proveedor.' },
        meses: { type: 'integer', description: 'Ventana en meses hacia atrás. Si no lo dicen, usar 12.' },
      },
    },
    async execute({ empresaId, args }) {
      let productoId = null;
      if (args.producto) {
        const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
        productoId = producto.id;
      }
      const { data, error } = await db.rpc('comparar_precios_proveedores', {
        p_empresa_id: empresaId,
        p_producto_id: productoId,
        p_meses: args.meses ?? 12,
      });
      if (error) throw new Error(`comparar_precios_proveedor_producto: ${error.message}`);
      return data;
    },
  },
  {
    name: 'listar_ordenes_compra',
    description: 'Historial de órdenes de compra a proveedores de los últimos N días, opcionalmente filtrado por proveedor y/o estado. Usar para "qué órdenes de compra tenemos pendientes", "qué le compramos a tal proveedor", "pasame las compras de este mes". Estados posibles: borrador, pendiente_aprobacion, enviada, confirmada, recibida_parcial, recibida, cancelada. Máximo 20 filas mostradas; si total_ordenes supera eso, aclarárselo al usuario.',
    roles: ['dueno', 'admin', 'depositero'],
    parameters: {
      type: 'object',
      properties: {
        proveedor: { type: 'string', description: 'Nombre (o parte del nombre) del proveedor para filtrar. Opcional.' },
        estado: { type: 'string', description: 'Estado exacto a filtrar: borrador, pendiente_aprobacion, enviada, confirmada, recibida_parcial, recibida o cancelada. Opcional.' },
        dias: { type: 'integer', description: 'Ventana de días hacia atrás. Si no lo dicen, usar 30.' },
      },
    },
    async execute({ empresaId, args }) {
      const dias = Math.min(parseInt(args.dias, 10) || 30, 180);
      const { data, error } = await db.rpc('listar_ordenes_compra', {
        p_empresa_id: empresaId,
        p_proveedor: args.proveedor || null,
        p_estado: args.estado || null,
        p_dias: dias,
      });
      if (error) throw new Error(`listar_ordenes_compra: ${error.message}`);
      return data;
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
  {
    name: 'consultar_ranking_ahorro_proveedores',
    description: 'Ranking de productos con mayor ahorro potencial si se comprara siempre al proveedor más barato en vez del más usado (solo productos con más de un proveedor disponible en el período). Usar para "dónde puedo ahorrar más cambiando de proveedor", "qué productos me conviene comparar entre proveedores".',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        meses: { type: 'integer', description: 'Ventana en meses hacia atrás. Si no lo dicen, usar 12.' },
        limite: { type: 'integer', description: 'Cantidad máxima a devolver. Si no lo dicen, usar 15.' },
      },
    },
    async execute({ empresaId, args }) {
      const { data, error } = await db.rpc('ranking_ahorro_proveedores', {
        p_empresa_id: empresaId,
        p_meses: args.meses ?? 12,
        p_limit: Math.min(parseInt(args.limite, 10) || 15, 50),
      });
      if (error) throw new Error(`consultar_ranking_ahorro_proveedores: ${error.message}`);
      return data;
    },
  },
  // ── maestros.js (categorías/depósitos/zonas) + fidelizacion.js — v505.
  // Antes de escribir estas tools se leyó el schema real de las 3 tablas
  // de maestros (sin unique constraint por nombre — el dedupe lo hace acá
  // buscarMaestroExistente, ILIKE exacto) y el body de canjear_recompensa
  // ya existente: la base tiene tablas de puntos duplicadas/legacy
  // (saldo_puntos vs. puntos_saldo, movimientos_puntos vs. puntos_log) —
  // se confirmó que la RPC usa saldo_puntos/movimientos_puntos, así que
  // consultar_puntos_cliente lee de ahí y no de las otras dos.
  {
    name: 'crear_categoria',
    description: 'Crea una categoría de productos nueva. Usar solo cuando el usuario lo pida explícitamente ("creá una categoría llamada X"). Si ya existe una con ese nombre, no se crea de nuevo.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre de la categoría.' },
        descripcion: { type: 'string', description: 'Descripción opcional.' },
      },
      required: ['nombre'],
    },
    async resumen({ empresaId, args }) {
      const nombre = String(args.nombre || '').trim();
      if (!nombre) throw new Error('Falta el nombre de la categoría.');
      const existente = await buscarMaestroExistente({ empresaId, tabla: 'categorias', nombre });
      if (existente) throw new Error(`Ya existe una categoría llamada "${existente.nombre}". No hace falta crearla de nuevo.`);
      return `Crear la categoría "${nombre}".`;
    },
    async execute({ empresaId, args }) {
      const nombre = String(args.nombre || '').trim();
      const existente = await buscarMaestroExistente({ empresaId, tabla: 'categorias', nombre });
      if (existente) return { ok: true, id: existente.id, ya_existia: true };
      const { data, error } = await db.from('categorias')
        .insert({ empresa_id: empresaId, nombre, descripcion: args.descripcion || null })
        .select('id')
        .single();
      if (error) throw new Error(`crear_categoria: ${error.message}`);
      return { ok: true, id: data.id };
    },
  },
  {
    name: 'crear_deposito',
    description: 'Crea un depósito nuevo. Al crearlo se generan automáticamente filas de stock en cero para todos los productos existentes en ese depósito (trigger trg_deposito_crear_stock_inicial). Usar solo cuando el usuario lo pida explícitamente. Nunca lo marca como depósito principal — eso se maneja desde el panel.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del depósito.' },
        direccion: { type: 'string', description: 'Dirección física, si la dan.' },
        responsable: { type: 'string', description: 'Nombre de la persona responsable, si la dan.' },
      },
      required: ['nombre'],
    },
    async resumen({ empresaId, args }) {
      const nombre = String(args.nombre || '').trim();
      if (!nombre) throw new Error('Falta el nombre del depósito.');
      const existente = await buscarMaestroExistente({ empresaId, tabla: 'depositos', nombre });
      if (existente) throw new Error(`Ya existe un depósito llamado "${existente.nombre}". No hace falta crearlo de nuevo.`);
      return `Crear el depósito "${nombre}". Se generan automáticamente filas de stock en cero para todos los productos existentes.`;
    },
    async execute({ empresaId, args }) {
      const nombre = String(args.nombre || '').trim();
      const existente = await buscarMaestroExistente({ empresaId, tabla: 'depositos', nombre });
      if (existente) return { ok: true, id: existente.id, ya_existia: true };
      const { data, error } = await db.from('depositos')
        .insert({ empresa_id: empresaId, nombre, direccion: args.direccion || null, responsable: args.responsable || null })
        .select('id')
        .single();
      if (error) throw new Error(`crear_deposito: ${error.message}`);
      return { ok: true, id: data.id };
    },
  },
  {
    name: 'crear_zona',
    description: 'Crea una zona de reparto nueva, opcionalmente con los días de la semana en que se reparte ahí. Usar solo cuando el usuario lo pida explícitamente.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre de la zona.' },
        dias: {
          type: 'array',
          items: { type: 'string' },
          description: 'Días de reparto, si los dan (lunes a domingo, en español y sin tildes).',
        },
      },
      required: ['nombre'],
    },
    async resumen({ empresaId, args }) {
      const nombre = String(args.nombre || '').trim();
      if (!nombre) throw new Error('Falta el nombre de la zona.');
      const existente = await buscarMaestroExistente({ empresaId, tabla: 'zonas', nombre });
      if (existente) throw new Error(`Ya existe una zona llamada "${existente.nombre}". No hace falta crearla de nuevo.`);
      const dias = resolverDiasReparto(args.dias);
      return `Crear la zona "${nombre}"${dias.length ? ` con reparto los ${dias.join(', ')}` : ''}.`;
    },
    async execute({ empresaId, args }) {
      const nombre = String(args.nombre || '').trim();
      const existente = await buscarMaestroExistente({ empresaId, tabla: 'zonas', nombre });
      if (existente) return { ok: true, id: existente.id, ya_existia: true };
      const dias = resolverDiasReparto(args.dias);
      const { data, error } = await db.from('zonas')
        .insert({ empresa_id: empresaId, nombre, dias_reparto: dias.length ? dias : null })
        .select('id')
        .single();
      if (error) throw new Error(`crear_zona: ${error.message}`);
      return { ok: true, id: data.id };
    },
  },
  // Fase A, ítem 2 del plan de cobertura por voz
  // (PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md): a diferencia del ítem 1
  // (registrar_cobro_cliente, cableado directo sobre una RPC ya apta para
  // service_role), acá NO se pudo cablear tal cual sobre `fn_crear_producto`
  // — esa función resuelve la empresa con `public.get_empresa_id()`, que
  // depende del JWT de sesión del usuario en el request (RLS), y el
  // asistente llama siempre con la service role key (ver lib/repos/_db.js),
  // sin esa sesión: `get_empresa_id()` devolvería NULL y la función volaría
  // por el `RAISE EXCEPTION` de guarda. En vez de tocar esa RPC (la sigue
  // usando `productos.html` en producción y no se puede probar el cambio
  // desde este entorno), se replica su misma lógica acá con el mismo
  // criterio ya usado por `actualizar_preferencia_notificacion` y el resto
  // del cluster de maestros de arriba: operaciones directas sobre la tabla
  // con `empresa_id` explícito en cada filtro, sin RPC intermedia.
  //
  // La edición (`editar_producto`) sí es un UPDATE directo — así es como
  // ya lo hace `productos.html` (`guardarProducto()`), sin RPC de por
  // medio, solo que ahí se apoya en RLS + el JWT de sesión; acá se
  // reemplaza ese scoping implícito por `.eq('empresa_id', empresaId)`
  // explícito, exactamente igual que el resto de los tools de escritura
  // de este archivo.
  //
  // Límite conocido (documentado, no oculto): la búsqueda de producto por
  // texto reusa `buscar_productos_asistente`, que solo indexa productos
  // ACTIVOS (mismo criterio que usa crear_pedido). Por eso `editar_producto`
  // puede dar de baja un producto activo, pero no puede encontrar por voz
  // un producto YA inactivo para reactivarlo o tocarle el precio — ese
  // caso puntual sigue siendo manual desde el panel. No se tocó la RPC de
  // búsqueda para no arriesgar el resto de tools que dependen de ella
  // (crear_pedido, crear_presupuesto, diagnosticar_*) sin poder probarlo.
  {
    name: 'crear_producto',
    description: 'Crea un producto nuevo en el catálogo, con stock inicial en cero en uno o más depósitos. Usar solo cuando el usuario lo pida explícitamente ("dame de alta un producto nuevo", "creá el producto X"). Si no aclara en qué depósito(s) va, preguntale — no asumas "todos los depósitos".',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del producto.' },
        depositos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Nombre (o parte del nombre) de cada depósito donde debe existir stock inicial en cero. Al menos uno.',
        },
        codigo: { type: 'string', description: 'Código o código de barras, si lo dan. Opcional.' },
        categoria: { type: 'string', description: 'Nombre de la categoría, si la dan. Tiene que ser una categoría ya existente (si no existe, avisale al usuario en vez de inventar una). Opcional.' },
        precio_base: { type: 'number', description: 'Precio de venta base. Opcional, default 0.' },
        costo: { type: 'number', description: 'Costo del producto. Opcional, default 0.' },
        stock_minimo: { type: 'number', description: 'Stock mínimo antes de avisar quiebre. Opcional, default 0.' },
      },
      required: ['nombre', 'depositos'],
    },
    async resumen({ empresaId, args }) {
      const { nombre, depositosResueltos, categoriaId, categoriaNombre, precioBase, costo, stockMinimo, codigo } =
        await resolverCrearProductoDesdeArgs({ empresaId, args });
      const depNombres = depositosResueltos.map((d) => d.nombre).join(', ');
      let texto = `Crear el producto "${nombre}" con stock inicial en cero en: ${depNombres}.`;
      if (codigo) texto += ` Código ${codigo}.`;
      if (categoriaNombre) texto += ` Categoría "${categoriaNombre}".`;
      if (precioBase) texto += ` Precio $${precioBase.toLocaleString('es-AR')}.`;
      if (costo) texto += ` Costo $${costo.toLocaleString('es-AR')}.`;
      if (stockMinimo) texto += ` Stock mínimo ${stockMinimo}.`;
      return texto;
    },
    async execute({ empresaId, args }) {
      const { nombre, depositosResueltos, categoriaId, precioBase, costo, stockMinimo, codigo } =
        await resolverCrearProductoDesdeArgs({ empresaId, args });

      const { data: producto, error: errorInsert } = await db.from('productos')
        .insert({
          empresa_id: empresaId,
          codigo: codigo || null,
          nombre,
          categoria_id: categoriaId,
          precio_base: precioBase,
          costo,
          stock_minimo: stockMinimo,
          activo: true,
        })
        .select('id')
        .single();
      if (errorInsert) throw new Error(`crear_producto: ${errorInsert.message}`);

      const filasStock = depositosResueltos.map((d) => ({
        producto_id: producto.id,
        deposito_id: d.id,
        cantidad: 0,
        cantidad_reservada: 0,
        costo_promedio: costo,
      }));
      const { error: errorStock } = await db.from('stock').insert(filasStock);
      if (errorStock) throw new Error(`crear_producto (stock inicial): ${errorStock.message}`);

      return { ok: true, id: producto.id, nombre, depositos: depositosResueltos.map((d) => d.nombre) };
    },
  },
  {
    name: 'editar_producto',
    description: 'Edita precio, costo, stock mínimo, categoría o el estado activo/inactivo de UN producto existente, dado su nombre. Usar para "cambiale el precio a X producto", "dá de baja tal producto", "reactivá tal producto" (ver limitación: reactivar uno YA inactivo no se puede resolver por voz, hay que hacerlo desde el panel — avisale eso al usuario si te lo pide). Solo aplica los campos que el usuario mencionó explícitamente, nunca inventes un valor para uno que no dijo.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre o parte del nombre del producto, tal como lo dio el usuario.' },
        precio_base: { type: 'number', description: 'Precio de venta nuevo, si lo dan. Opcional.' },
        costo: { type: 'number', description: 'Costo nuevo, si lo dan. Opcional.' },
        stock_minimo: { type: 'number', description: 'Stock mínimo nuevo, si lo dan. Opcional.' },
        categoria: { type: 'string', description: 'Nombre de la categoría nueva, si la dan. Tiene que ser una categoría ya existente. Opcional.' },
        activo: { type: 'boolean', description: 'false para dar de baja el producto, true para reactivarlo (ver limitación en la descripción de la tool). Opcional.' },
      },
      required: ['producto'],
    },
    async resumen({ empresaId, args }) {
      const { producto, cambios, cambiosTexto } = await resolverEditarProductoDesdeArgs({ empresaId, args });
      if (!cambiosTexto.length) throw new Error('No indicaste ningún cambio para aplicar — decime qué querés modificar (precio, costo, stock mínimo, categoría, o si querés darlo de baja).');
      return `Producto "${producto.nombre}": ${cambiosTexto.join('; ')}.`;
    },
    async execute({ empresaId, args }) {
      const { producto, cambios } = await resolverEditarProductoDesdeArgs({ empresaId, args });
      if (!Object.keys(cambios).length) throw new Error('No indicaste ningún cambio para aplicar.');
      const { error } = await db.from('productos')
        .update(cambios)
        .eq('id', producto.id)
        .eq('empresa_id', empresaId);
      if (error) throw new Error(`editar_producto: ${error.message}`);
      return { ok: true, id: producto.id, nombre: producto.nombre, cambios };
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
  // reglas-precio.js: solo lectura, sin requiereConfirmacion. Reusa
  // buscarClientePorTexto/buscarProductoPorTexto (mismas que crear_pedido)
  // y llama a resolver_precios_cliente(), la RPC que ya usa el panel para
  // resolver precio especial > lista de precios > precio base, con las
  // reglas de descuento por cantidad/categoría/zona vigentes encima. Se
  // leyó pg_get_functiondef() de la RPC real antes de escribir esto para
  // confirmar el orden de prioridad y la forma de p_cantidades[] (mismo
  // índice que p_producto_ids[], default 1 si no se manda).
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
  // reglas-precio.js — Fase B del plan (crear/editar regla de precio).
  // A diferencia de consultar_precio_producto_cliente (arriba, solo lee el
  // resultado ya resuelto), estas 3 tools tocan la tabla `reglas_precio`
  // en sí (mismo repo/handler que usa reglas-precio.html: lib/repos/
  // reglas-precio.js, ya con validación de pertenencia de producto/
  // categoría/zona a la empresa — REGLAS-001 — y con el mismo gate de rol
  // que el handler real: `puede(perfil,'escribir','reglas_precio')` =
  // dueno/admin/contador). No se resuelve producto_id/categoria_id/zona_id
  // por id — nunca se le confía un id al modelo — se buscan por texto
  // libre con buscarProductoPorTexto/buscarCategoriaPorTexto/
  // buscarZonaPorTexto, igual que el resto del archivo. crearReglaPrecio
  // valida que no vengan producto y categoría a la vez (son alcances
  // excluyentes; zona es un eje aparte y puede combinarse con cualquiera
  // de los dos, o ir sola para "toda la zona sin importar producto").
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
  // reglas-automatizacion.html — Fase B del plan (crear/editar regla de
  // automatización). Mismo handler+repo ya cableado (lib/repos/
  // reglas-automatizacion.js, gate `puede(perfil,'leer'|'escribir',
  // 'reglas_automatizacion')` = dueno/admin únicamente en los dos casos —
  // más restrictivo que reglas_precio, que además deja pasar
  // contador/vendedor para lectura — ver lib/permisos-service.js). No se
  // expone por voz la combinación de condiciones con "y"/"o" (ver
  // armarCondicionRegla más abajo): solo una condición simple, o ninguna
  // (dispara siempre que ocurra el evento).
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
  // fidelizacion.js — Fase B del plan (crear/editar campaña de fidelización).
  // A diferencia de reglas-precio/reglas-automatizacion (que ya tienen
  // handler+repo propios), el ABM de `recompensas` desde
  // frontend/admin/js/fidelizacion.js pega DIRECTO contra Supabase
  // (sb.from('recompensas').insert/update) — no hay handler ni repo que
  // cablear (brecha 1.B del plan, igual que productos.html en Fase A,
  // ítem 2). Se replica acá el mismo patrón que crear_categoria/
  // crear_deposito: operación directa sobre la tabla, filtrada siempre por
  // empresa_id explícito, sin RPC intermedia. Roles dueno/admin (no hay
  // entrada propia en permisos-service.js para esto porque nunca pasó por
  // un handler — se usa el mismo criterio que el resto de ABMs de
  // configuración/campañas de este archivo, más restrictivo que "vendedor"
  // porque define condiciones económicas del programa de puntos).
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
  // conciliacion-bancaria.js: se leyó pg_get_functiondef() de las 4 RPCs
  // reales (conciliacion_buscar_candidatos, conciliacion_confirmar_match,
  // conciliacion_deshacer_match, y se descartó conciliacion_auto_matchear_lote
  // por ahora — actúa sobre un lote entero de una, y todavía no hay una
  // forma de resolver "lote" por texto libre) antes de escribir esto. No
  // hay RPC de búsqueda aproximada para movimientos bancarios (no son un
  // nombre de cliente/producto, son una línea de extracto), así que se
  // usa el mismo patrón de "referencia corta" (últimos 6 caracteres del
  // UUID, mayúsculas) que ya usan anular_venta_pos/confirmar_pedido_sugerido
  // vía diagnosticar_venta_pos/diagnosticar_pedido — solo que acá, al no
  // existir una RPC diagnosticar_movimiento_bancario, se resuelve en JS
  // contra los movimientos 'pendiente' de la empresa (ver
  // buscarMovimientoBancarioPorReferencia más abajo).
  {
    name: 'listar_movimientos_bancarios_pendientes',
    description: 'Lista los movimientos del extracto bancario importado que todavía no fueron conciliados con ningún cobro, más recientes primero, con su referencia corta de 6 caracteres para usar en consultar_candidatos_conciliacion. Usar para "qué movimientos bancarios faltan conciliar", "mostrame el extracto pendiente".',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: 'Cuántos mostrar como máximo. Default 15, tope 30.' },
      },
    },
    async execute({ empresaId, args }) {
      const limite = Math.min(Math.max(Number(args.limite) || 15, 1), 30);
      const { data, error } = await db.from('conciliacion_bancaria_movimientos')
        .select('id, fecha, descripcion, monto, tipo')
        .eq('empresa_id', empresaId)
        .eq('estado', 'pendiente')
        .order('fecha', { ascending: false })
        .limit(limite);
      if (error) throw new Error(`listar_movimientos_bancarios_pendientes: ${error.message}`);
      return {
        movimientos: (data || []).map((m) => ({
          referencia: m.id.slice(-6).toUpperCase(),
          fecha: m.fecha,
          descripcion: m.descripcion,
          monto: m.monto,
          tipo: m.tipo,
        })),
      };
    },
  },
  {
    name: 'consultar_candidatos_conciliacion',
    description: 'Para UN movimiento bancario pendiente (dado por su referencia corta de 6 caracteres, ver listar_movimientos_bancarios_pendientes), busca qué cobros sin conciliar podrían corresponderle, ordenados por score de coincidencia (fecha y monto). Usar antes de confirmar_conciliacion_bancaria, nunca inventar un cobro sin haber consultado esto primero.',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        referencia: { type: 'string', description: 'Referencia corta de 6 caracteres del movimiento bancario (con o sin "#").' },
      },
      required: ['referencia'],
    },
    async execute({ empresaId, args }) {
      const movimiento = await buscarMovimientoBancarioPorReferencia({ empresaId, referencia: args.referencia });
      const candidatos = await buscarCandidatosDeMovimiento({ empresaId, movimientoId: movimiento.id });
      return {
        movimiento: { referencia: movimiento.referencia, fecha: movimiento.fecha, descripcion: movimiento.descripcion, monto: movimiento.monto },
        candidatos: candidatos.map((c) => ({
          cobro_referencia: c.cobro_id.slice(-6).toUpperCase(),
          cliente: c.cliente_nombre,
          fecha: c.fecha,
          monto: c.monto,
          medio: c.medio,
          diff_dias: c.diff_dias,
          diff_monto: c.diff_monto,
          score: c.score,
        })),
      };
    },
  },
  {
    name: 'confirmar_conciliacion_bancaria',
    description: 'Confirma que un movimiento bancario pendiente corresponde a un cobro puntual, marcando ambos como conciliados. Los dos se identifican por su referencia corta de 6 caracteres. El cobro TIENE que venir de un candidato ya mostrado por consultar_candidatos_conciliacion para ese mismo movimiento — nunca inventar una referencia de cobro sin haberla visto ahí.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        referencia_movimiento: { type: 'string', description: 'Referencia corta de 6 caracteres del movimiento bancario.' },
        referencia_cobro: { type: 'string', description: 'Referencia corta de 6 caracteres del cobro candidato (visto en consultar_candidatos_conciliacion).' },
      },
      required: ['referencia_movimiento', 'referencia_cobro'],
    },
    async resumen({ empresaId, args }) {
      const { movimiento, candidato } = await resolverMatchConciliacion({ empresaId, args });
      return `Conciliar el movimiento del ${movimiento.fecha} por $${movimiento.monto} ("${movimiento.descripcion}") con el cobro de ${candidato.cliente_nombre} por $${candidato.monto} del ${candidato.fecha}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      // Se resuelve de nuevo (no se reusa lo que vio resumen()): si cambió
      // algo entre la propuesta y el click de Confirmar —por ejemplo el
      // cobro se conciliÓ con otro movimiento por otra vía mientras
      // tanto— conciliacion_confirmar_match lo rechaza solo (ver su
      // FOR UPDATE + chequeo de conciliado_bancario), pero además acá se
      // vuelve a exigir que el cobro siga siendo un candidato vigente.
      const { movimiento, candidato } = await resolverMatchConciliacion({ empresaId, args });
      const { data, error } = await db.rpc('conciliacion_confirmar_match', {
        p_movimiento_id: movimiento.id,
        p_cobro_id: candidato.cobro_id,
        p_empresa_id: empresaId,
        p_usuario_id: usuarioId,
      });
      if (error) throw new Error(`confirmar_conciliacion_bancaria: ${error.message}`);
      return data;
    },
  },
  {
    name: 'deshacer_conciliacion_bancaria',
    description: 'Deshace la conciliación de un movimiento bancario ya conciliado, dejándolo pendiente de nuevo y liberando el cobro asociado para que pueda conciliarse con otro movimiento. Usar solo cuando el usuario pida explícitamente deshacer/corregir una conciliación puntual, dando la referencia corta del movimiento.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        referencia_movimiento: { type: 'string', description: 'Referencia corta de 6 caracteres del movimiento bancario ya conciliado.' },
      },
      required: ['referencia_movimiento'],
    },
    async resumen({ empresaId, args }) {
      const movimiento = await buscarMovimientoBancarioPorReferencia({ empresaId, referencia: args.referencia_movimiento, estadoRequerido: 'conciliado' });
      return `Deshacer la conciliación del movimiento del ${movimiento.fecha} por $${movimiento.monto} ("${movimiento.descripcion}"). Vuelve a quedar pendiente, y el cobro que tenía asociado queda libre de nuevo.`;
    },
    async execute({ empresaId, args }) {
      const movimiento = await buscarMovimientoBancarioPorReferencia({ empresaId, referencia: args.referencia_movimiento, estadoRequerido: 'conciliado' });
      const { data, error } = await db.rpc('conciliacion_deshacer_match', {
        p_movimiento_id: movimiento.id,
        p_empresa_id: empresaId,
      });
      if (error) throw new Error(`deshacer_conciliacion_bancaria: ${error.message}`);
      return data;
    },
  },
  {
    name: 'listar_lotes_conciliacion_bancaria',
    description: 'Lista los lotes de extracto bancario importados, con cuántos movimientos tienen en total y cuántos siguen pendientes de conciliar. Usar para "qué lotes bancarios hay", "cuál extracto falta terminar de conciliar".',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: 'Cuántos mostrar como máximo. Default 10, tope 20.' },
      },
    },
    async execute({ empresaId, args }) {
      const limite = Math.min(Math.max(Number(args.limite) || 10, 1), 20);
      const { data, error } = await db.from('conciliacion_bancaria_lotes')
        .select('id, nombre_archivo, cantidad_movimientos, cantidad_conciliados, created_at')
        .eq('empresa_id', empresaId)
        .order('created_at', { ascending: false })
        .limit(limite);
      if (error) throw new Error(`listar_lotes_conciliacion_bancaria: ${error.message}`);
      return {
        lotes: (data || []).map((l) => ({
          referencia: l.id.slice(-6).toUpperCase(),
          archivo: l.nombre_archivo,
          movimientos: l.cantidad_movimientos,
          conciliados: l.cantidad_conciliados,
          pendientes: Math.max((l.cantidad_movimientos || 0) - (l.cantidad_conciliados || 0), 0),
          fecha: l.created_at,
        })),
      };
    },
  },
  {
    name: 'conciliar_lote_automatico',
    description: 'Concilia automáticamente todos los movimientos pendientes de UN lote de extracto bancario que tengan un único cobro candidato posible (match inequívoco por fecha y monto). Los que tengan cero candidatos o más de uno quedan igual, para revisar a mano con consultar_candidatos_conciliacion. Usar solo cuando el usuario lo pida explícitamente para un lote completo, no para un movimiento puntual (para eso está confirmar_conciliacion_bancaria).',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        lote: { type: 'string', description: 'Nombre del archivo importado, o ID corto de 6 caracteres del lote (ver listar_lotes_conciliacion_bancaria).' },
        tolerancia_dias: { type: 'number', description: 'Diferencia máxima de días entre movimiento y cobro para considerarlos el mismo pago. Default 1.' },
        tolerancia_monto: { type: 'number', description: 'Diferencia máxima de monto en $ entre movimiento y cobro. Default 0.5.' },
      },
      required: ['lote'],
    },
    async resumen({ empresaId, args }) {
      const lote = await buscarLoteConciliacionPorReferencia({ empresaId, referencia: args.lote });
      const { toleranciaDias, toleranciaMonto } = resolverToleranciasAutoMatch(args);
      const { totalPendientes, conUnico } = await contarMatchesAutomaticosLote({ empresaId, loteId: lote.id, toleranciaDias, toleranciaMonto });
      if (!totalPendientes) throw new Error(`El lote "${lote.nombre_archivo}" no tiene movimientos pendientes de conciliar.`);
      return `Conciliar automáticamente ${conUnico} de ${totalPendientes} movimientos pendientes del lote "${lote.nombre_archivo}" (los que tengan un único cobro candidato, con tolerancia de ${toleranciaDias} día(s) y $${toleranciaMonto}). El resto queda pendiente para revisar a mano.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const lote = await buscarLoteConciliacionPorReferencia({ empresaId, referencia: args.lote });
      const { toleranciaDias, toleranciaMonto } = resolverToleranciasAutoMatch(args);
      const { data, error } = await db.rpc('conciliacion_auto_matchear_lote', {
        p_lote_id: lote.id,
        p_empresa_id: empresaId,
        p_usuario_id: usuarioId,
        p_tolerancia_dias: toleranciaDias,
        p_tolerancia_monto: toleranciaMonto,
      });
      if (error) throw new Error(`conciliar_lote_automatico: ${error.message}`);
      return { conciliados: data };
    },
  },
  // notif.js: singleton por empresa (empresa_id es PK de notif_prefs_auto,
  // se crea sola con crear_notif_prefs_auto_default al crear la empresa —
  // se confirmó contra el schema real que las 2 empresas existentes ya
  // tienen su fila), así que no hace falta ninguna RPC: un UPDATE
  // filtrado por empresa_id alcanza y es tan seguro como el resto de los
  // helpers de "maestros". Solo prende/apaga notificaciones push/email
  // automáticas — no toca plata ni stock, por eso no lleva
  // requiereConfirmacion mucho más estricto que crear_categoria, pero se
  // deja el patrón de confirmación igual porque cambia un comportamiento
  // del sistema (deja de avisar algo) y no es trivialmente reversible por
  // el usuario sin saber que existe esta tool.
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
  // cc_proveedores.js: no existe una tabla de cuenta corriente de
  // proveedor análoga a `cta_cte` (esa es solo de clientes — se verificó
  // que no tiene proveedor_id). El extracto se arma en JS combinando
  // facturas_proveedor (debe) + notas_debito_proveedor (debe) +
  // pagos_proveedor (haber), excluyendo estado='anulada' en las dos
  // primeras (constraint real: pendiente/parcial/pagada/anulada y
  // pendiente/aplicada/anulada respectivamente). consultar_deuda_proveedor
  // ya da el saldo agregado; esta tool da el detalle movimiento por
  // movimiento con saldo corrido, como el extracto de cliente.
  {
    name: 'consultar_cuenta_corriente_proveedor',
    description: 'Extracto de cuenta corriente de UN proveedor puntual: cada factura, nota de débito y pago, en orden cronológico, con el saldo corrido después de cada movimiento. Usar para "mostrame el estado de cuenta de tal proveedor", "qué le pagamos y qué le debemos a tal proveedor últimamente" — para solo el saldo total, usar consultar_deuda_proveedor en cambio.',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        proveedor: { type: 'string', description: 'Nombre o parte del nombre del proveedor.' },
        dias: { type: 'integer', description: 'Ventana de días hacia atrás a mostrar. Default 180, tope 730.' },
      },
      required: ['proveedor'],
    },
    async execute({ empresaId, args }) {
      const proveedor = await buscarProveedorPorTexto({ empresaId, texto: args.proveedor });
      const dias = Math.min(Math.max(Number(args.dias) || 180, 1), 730);
      const desde = new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);

      const [facturasRes, notasRes, pagosRes] = await Promise.all([
        db.from('facturas_proveedor')
          .select('id, numero_factura, tipo, fecha_factura, total, estado')
          .eq('empresa_id', empresaId).eq('proveedor_id', proveedor.id)
          .neq('estado', 'anulada').gte('fecha_factura', desde),
        db.from('notas_debito_proveedor')
          .select('id, motivo, monto, estado, created_at')
          .eq('empresa_id', empresaId).eq('proveedor_id', proveedor.id)
          .neq('estado', 'anulada').gte('created_at', desde),
        db.from('pagos_proveedor')
          .select('id, monto, medio_pago, referencia, fecha_pago')
          .eq('empresa_id', empresaId).eq('proveedor_id', proveedor.id)
          .gte('fecha_pago', desde),
      ]);
      if (facturasRes.error) throw new Error(`consultar_cuenta_corriente_proveedor (facturas): ${facturasRes.error.message}`);
      if (notasRes.error) throw new Error(`consultar_cuenta_corriente_proveedor (notas débito): ${notasRes.error.message}`);
      if (pagosRes.error) throw new Error(`consultar_cuenta_corriente_proveedor (pagos): ${pagosRes.error.message}`);

      const movimientos = [
        ...(facturasRes.data || []).map((f) => ({
          fecha: f.fecha_factura, tipo: 'factura', comprobante: `${f.tipo}-${f.numero_factura}`,
          detalle: `Factura ${f.estado}`, debe: Number(f.total), haber: 0,
        })),
        ...(notasRes.data || []).map((n) => ({
          fecha: n.created_at.slice(0, 10), tipo: 'nota_debito', comprobante: null,
          detalle: n.motivo || 'Nota de débito', debe: Number(n.monto), haber: 0,
        })),
        ...(pagosRes.data || []).map((p) => ({
          fecha: p.fecha_pago, tipo: 'pago', comprobante: p.referencia || null,
          detalle: `Pago (${p.medio_pago})`, debe: 0, haber: Number(p.monto),
        })),
      ].sort((a, b) => a.fecha.localeCompare(b.fecha));

      let saldo = 0;
      const extracto = movimientos.map((m) => {
        saldo += m.debe - m.haber;
        return { ...m, saldo: Math.round(saldo * 100) / 100 };
      });

      return {
        proveedor: proveedor.nombre,
        desde,
        movimientos: extracto,
        saldo_final: extracto.length ? extracto[extracto.length - 1].saldo : 0,
      };
    },
  },
  // proveedores.js: crear_proveedor — se leyó el handler real (POST
  // /api/proveedores) antes de escribir esto: es un insert directo, sin
  // RPC. Se verificó el schema real de `proveedores` (sin check constraint
  // en condicion_iva, sin unique en cuit/razon_social a nivel DB), así que
  // el dedupe se hace acá igual que en maestros.js: ILIKE exacto por
  // razon_social dentro de la empresa, y además por cuit si lo dieron
  // (evita cargar dos veces al mismo proveedor con nombres ligeramente
  // distintos pero el mismo CUIT).
  {
    name: 'crear_proveedor',
    description: 'Da de alta un proveedor nuevo. Usar solo cuando el usuario lo pida explícitamente ("cargá un proveedor nuevo llamado X", "agregá a tal proveedor"). Si ya existe uno con esa razón social o ese CUIT, no se crea de nuevo.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        razon_social: { type: 'string', description: 'Razón social del proveedor (obligatorio).' },
        nombre_fantasia: { type: 'string', description: 'Nombre de fantasía, si lo dan.' },
        cuit: { type: 'string', description: 'CUIT del proveedor, si lo dan.' },
        condicion_iva: {
          type: 'string',
          description: 'Condición ante el IVA. Si no la dan, usar "responsable_inscripto". Valores usados en el sistema: responsable_inscripto, monotributo, exento, consumidor_final.',
        },
        contacto: { type: 'string', description: 'Nombre de la persona de contacto, si lo dan.' },
        telefono: { type: 'string', description: 'Teléfono de contacto, si lo dan.' },
        email: { type: 'string', description: 'Email de contacto, si lo dan.' },
        dias_pago: { type: 'integer', description: 'Días de pago acordados, si los dan. Default 0.' },
        domicilio: { type: 'string', description: 'Domicilio, si lo dan.' },
        localidad: { type: 'string', description: 'Localidad, si la dan.' },
        notas: { type: 'string', description: 'Notas internas, si las dan.' },
      },
      required: ['razon_social'],
    },
    async resumen({ empresaId, args }) {
      const razonSocial = String(args.razon_social || '').trim();
      if (!razonSocial) throw new Error('Falta la razón social del proveedor.');
      const existente = await buscarProveedorExistente({ empresaId, razonSocial, cuit: args.cuit });
      if (existente) throw new Error(`Ya existe un proveedor con ese${existente.motivo === 'cuit' ? ' CUIT' : 'a razón social'}: "${existente.nombre}". No hace falta crearlo de nuevo.`);
      return `Dar de alta al proveedor "${razonSocial}"${args.cuit ? ` (CUIT ${args.cuit})` : ''}.`;
    },
    async execute({ empresaId, args }) {
      const razonSocial = String(args.razon_social || '').trim();
      const existente = await buscarProveedorExistente({ empresaId, razonSocial, cuit: args.cuit });
      if (existente) return { ok: true, id: existente.id, ya_existia: true };

      const { data, error } = await db.from('proveedores')
        .insert({
          empresa_id: empresaId,
          razon_social: razonSocial,
          nombre_fantasia: args.nombre_fantasia?.trim() || null,
          cuit: args.cuit?.trim() || null,
          condicion_iva: args.condicion_iva || 'responsable_inscripto',
          contacto: args.contacto?.trim() || null,
          telefono: args.telefono?.trim() || null,
          email: args.email?.trim() || null,
          dias_pago: Number.isFinite(Number(args.dias_pago)) ? parseInt(args.dias_pago, 10) : 0,
          domicilio: args.domicilio?.trim() || null,
          localidad: args.localidad?.trim() || null,
          notas: args.notas?.trim() || null,
        })
        .select('id')
        .single();
      if (error) throw new Error(`crear_proveedor: ${error.message}`);
      return { ok: true, id: data.id };
    },
  },
  // FIX (v523): reportado por el usuario probando el flujo de imagen — el
  // asistente ya sabía leer un pedido en una foto y resolver los productos,
  // pero si el cliente no existía todavía no tenía forma de darlo de alta:
  // "En este momento no dispongo de una herramienta para crear clientes
  // nuevos". Es correcto que no existía como tool (se confirmó recorriendo
  // las 68 tools del catálogo), pero la función de fondo (`crearCliente()`,
  // usada por la pantalla normal de Clientes) ya estaba — solo faltaba
  // conectarla acá. A diferencia de crear_proveedor (que inserta directo
  // contra `db`), esta reusa `crearCliente()` del repo para no duplicar el
  // chequeo de `exigirLimitePlan()` (cupo de clientes del plan contratado).
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
  // Fase B del plan (editar/dar de baja cliente). Releído antes de escribir:
  // - PATCH /api/clientes (lib/handlers/clientes.js:380) solo exige
  //   puede(perfil,'acceder','clientes') = dueno/admin/vendedor (mismo que
  //   RLS `clientes_update` en 012_fase1_roles_rls.sql) — sin restricción
  //   de rol adicional para editar. actualizarCliente() (lib/repos/
  //   clientes.js:262) es un .update() de tabla sin allowlist propia; el
  //   allowlist real lo pone el formulario (frontend/admin/js/clientes.js,
  //   guardarCliente()). Se replican acá los mismos campos que ya expone
  //   crear_cliente (mismo criterio: sin zona_id/lista_precio_id/
  //   vendedor_id_default/lat/lng, que son FKs que no tiene sentido resolver
  //   por texto libre dictado).
  // - A diferencia de crear_producto/editar_producto (Fase A, ítem 2), acá
  //   SÍ se puede reactivar un cliente inactivo por voz: buscar_clientes_
  //   asistente (420_asistente_busqueda_aproximada_pg_trgm.sql) NO filtra
  //   por `activo` (a diferencia de buscar_productos_asistente, que sí) —
  //   por eso se reusa buscarClienteParaCobroPorTexto (ya existía, sin
  //   bloqueo de activo) en vez de buscarClientePorTexto (que sí bloquea).
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
  // Tool separada de editar_cliente_asistente a propósito (mismo criterio
  // que anular_factura/emitir_factura, Fase A ítem 3): "dar de baja" es una
  // acción puntual y de mayor cautela, más fácil de reconocer por voz sola
  // que como un campo más de un editar genérico.
  //
  // Hallazgo (no corregido, solo documentado): el botón "Dar de baja" real
  // del modal de clientes (frontend/admin/js/clientes.js, confirmarBaja())
  // pega DIRECTO contra Supabase con la sesión del usuario, sin pasar por
  // DELETE /api/clientes — así que en la práctica queda habilitado por la
  // policy RLS `clientes_update` (dueno/admin/VENDEDOR, ver
  // 012_fase1_roles_rls.sql), no por la policy `clientes_delete` (solo
  // dueno/admin) ni por el chequeo explícito del handler DELETE
  // ('Solo admin puede eliminar clientes', lib/handlers/clientes.js:395).
  // Es decir: hoy un vendedor SÍ puede dar de baja un cliente desde ese
  // botón, aunque el handler oficial se lo negaría. Para esta tool se optó
  // por el criterio más restrictivo y explícito del handler (dueno/admin)
  // en vez de replicar lo que parece una inconsistencia del botón directo.
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
  // stock.js: transferir_stock_asistente. El propio changelog de v505 lo
  // dejaba pendiente porque había 2 RPCs candidatas y no se sabía cuál usa
  // el panel real sin ver el handler — con el proyecto completo ya se vio:
  // el endpoint POST /api/stock solo cubre ingreso/egreso/ajuste (vía
  // ajustar_stock()); las transferencias entre depósitos las hace el
  // FRONTEND directo contra la RPC transferir_stock(), que desde v342 es
  // transaccional (débito+crédito atómico) y desde v400 guarda el
  // movimiento con signo (negativo en origen, positivo en destino). Se leyó
  // su pg_get_functiondef() completo: es SECURITY DEFINER y, cuando quien
  // llama es 'service_role' (nuestro caso), SALTEA su propio chequeo de
  // empresa/rol — confía en que quien invoca ya validó tenant, igual que
  // anular_venta_pos (ver comentario de buscarVentaPosPropia más abajo). Por
  // eso acá se valida a mano, ANTES de llamar a la RPC, que producto y
  // ambos depósitos sean de empresaId.
  {
    name: 'transferir_stock_asistente',
    description: 'Transfiere stock de un producto entre dos depósitos de la empresa, en una sola operación atómica. Usar para "pasá tantas unidades de tal producto del depósito X al Y". No usar para ingresos/egresos simples sin depósito de contraparte (eso es un ajuste, no una transferencia).',
    roles: ['dueno', 'admin', 'depositero'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre o parte del nombre del producto.' },
        deposito_origen: { type: 'string', description: 'Nombre o parte del nombre del depósito de origen.' },
        deposito_destino: { type: 'string', description: 'Nombre o parte del nombre del depósito de destino.' },
        cantidad: { type: 'number', description: 'Cantidad a transferir. Debe ser mayor a cero.' },
        motivo: { type: 'string', description: 'Motivo de la transferencia, si lo dan.' },
      },
      required: ['producto', 'deposito_origen', 'deposito_destino', 'cantidad'],
    },
    async resumen({ empresaId, args }) {
      const { producto, depOrigen, depDestino, cantidad } = await resolverTransferenciaStock({ empresaId, args });
      const { data: stockOrigen } = await db.from('stock')
        .select('cantidad')
        .eq('producto_id', producto.id).eq('deposito_id', depOrigen.id)
        .maybeSingle();
      const disponible = Number(stockOrigen?.cantidad || 0);
      if (cantidad > disponible) {
        throw new Error(`No hay suficiente stock en "${depOrigen.nombre}": disponible ${disponible}, se pidió transferir ${cantidad}.`);
      }
      return `Transferir ${cantidad} de "${producto.nombre}" desde "${depOrigen.nombre}" (disponible: ${disponible}) hacia "${depDestino.nombre}".`;
    },
    async execute({ empresaId, args }) {
      const { producto, depOrigen, depDestino, cantidad } = await resolverTransferenciaStock({ empresaId, args });
      const { data, error } = await db.rpc('transferir_stock', {
        p_producto_id: producto.id,
        p_deposito_origen: depOrigen.id,
        p_deposito_destino: depDestino.id,
        p_cantidad: cantidad,
        p_motivo: args.motivo || 'transferencia_manual',
        p_notas: args.motivo || null,
      });
      if (error) throw new Error(`transferir_stock_asistente: ${error.message}`);
      if (!data?.ok) throw new Error(data?.error || 'No se pudo transferir el stock.');
      return {
        ok: true,
        producto: producto.nombre,
        deposito_origen: depOrigen.nombre,
        deposito_destino: depDestino.nombre,
        stock_origen_nuevo: data.stock_origen_nuevo,
        stock_destino_nuevo: data.stock_destino_nuevo,
      };
    },
  },
  // stock.js: ajustar_stock_asistente. Cubre ingreso/egreso simple del mismo
  // modal "Ajustar stock" que ya usa transferir_stock_asistente arriba.
  // Réplica EXACTA de la única rama de guardarAjuste() que el usuario puede
  // pedir por voz sin ambigüedad: motivo 'compra' se bloquea igual que en el
  // frontend (ese ingreso tiene que pasar por recepcionar_orden_compra_
  // asistente, que además actualiza la OC y el costo del producto — permitir
  // acá un ingreso libre con motivo compra dejaría una OC pendiente que
  // nunca se marca recibida). Motivo 'produccion' con tipo ingreso también
  // se replica igual que el frontend: en vez de sumar stock del terminado
  // sin más, redirige internamente a producir_con_insumos (RPC que descuenta
  // insumos de la receta en la misma transacción) — así el modelo no
  // necesita saber que existen dos RPCs distintas detrás de un solo modal.
  {
    name: 'ajustar_stock_asistente',
    description: 'Registra un ingreso o egreso manual de stock de un producto en un depósito (no un movimiento entre dos depósitos — para eso existe transferir_stock_asistente). Usar para "sumá/restá tantas unidades de tal producto en tal depósito por [motivo]". Motivos de ingreso: devolucion_cliente, produccion (producción propia, descuenta insumos de la receta si el producto tiene una cargada), ajuste_manual. Motivos de egreso: venta_manual, merma, rotura, muestra, ajuste_manual. NO usar para ingresos por compra a un proveedor (motivo "compra") — para eso el usuario tiene que recepcionar la orden de compra correspondiente (ver recepcionar_orden_compra_asistente); si el usuario pide cargar una compra acá, explicarle eso en vez de llamar esta función.',
    roles: ['dueno', 'admin', 'depositero'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre o parte del nombre del producto.' },
        deposito: { type: 'string', description: 'Nombre o parte del nombre del depósito.' },
        tipo: { type: 'string', enum: ['ingreso', 'egreso'], description: 'Si el movimiento suma o resta stock.' },
        cantidad: { type: 'number', description: 'Cantidad a mover. Debe ser mayor a cero (el signo lo define "tipo", no la cantidad).' },
        motivo: {
          type: 'string',
          enum: ['devolucion_cliente', 'produccion', 'venta_manual', 'merma', 'rotura', 'muestra', 'ajuste_manual'],
          description: 'Motivo del movimiento. Si el usuario no da ninguno que encaje, usar "ajuste_manual".',
        },
        notas: { type: 'string', description: 'Notas adicionales, si el usuario dio alguna. Opcional.' },
      },
      required: ['producto', 'deposito', 'tipo', 'cantidad'],
    },
    async resumen({ empresaId, args }) {
      const { producto, deposito, cantidad, motivo } = await resolverAjusteStock({ empresaId, args });
      const { data: stockFila } = await db.from('stock')
        .select('cantidad')
        .eq('producto_id', producto.id).eq('deposito_id', deposito.id)
        .maybeSingle();
      const actual = Number(stockFila?.cantidad || 0);
      const verbo = args.tipo === 'egreso' ? 'Restar' : 'Sumar';
      if (args.tipo === 'egreso' && cantidad > actual) {
        throw new Error(`No hay suficiente stock de "${producto.nombre}" en "${deposito.nombre}": disponible ${actual}, se pidió restar ${cantidad}.`);
      }
      const nuevo = args.tipo === 'egreso' ? actual - cantidad : actual + cantidad;
      const aviso = motivo === 'produccion' && args.tipo === 'ingreso'
        ? ' (producción propia: si el producto tiene receta cargada, se descontarán los insumos correspondientes)'
        : '';
      return `${verbo} ${cantidad} de "${producto.nombre}" en "${deposito.nombre}" por motivo "${motivo}"${aviso}. Stock: ${actual} → ${nuevo}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const { producto, deposito, cantidad, motivo } = await resolverAjusteStock({ empresaId, args });

      if (motivo === 'produccion' && args.tipo === 'ingreso') {
        const { data, error } = await db.rpc('producir_con_insumos', {
          p_producto_id: producto.id,
          p_deposito_id: deposito.id,
          p_cantidad: cantidad,
          p_motivo: motivo,
          p_notas: args.notas || null,
          p_usuario_id: usuarioId,
        });
        if (error) throw new Error(`ajustar_stock_asistente: ${error.message}`);
        if (!data?.ok) throw new Error(data?.error || 'No se pudo registrar la producción.');
        return {
          ok: true,
          producto: producto.nombre,
          deposito: deposito.nombre,
          stock_nuevo: data.stock_nuevo,
          tiene_receta: data.tiene_receta,
          insumos_consumidos: data.insumos_consumidos,
        };
      }

      const delta = args.tipo === 'egreso' ? -cantidad : cantidad;
      const { data, error } = await db.rpc('ajustar_stock', {
        p_producto_id: producto.id,
        p_deposito_id: deposito.id,
        p_delta: delta,
        p_tipo: args.tipo,
        p_motivo: motivo,
        p_notas: args.notas || null,
        p_usuario_id: usuarioId,
      });
      if (error) throw new Error(`ajustar_stock_asistente: ${error.message}`);
      if (!data?.ok) throw new Error(data?.error || 'No se pudo registrar el movimiento de stock.');
      return { ok: true, producto: producto.nombre, deposito: deposito.nombre, stock_nuevo: data.stock_nuevo };
    },
  },
  // stock.js: registrar_conteo_stock_asistente. A diferencia de
  // ajustar_stock_asistente (que recibe una CANTIDAD A MOVER), esta recibe
  // el CONTEO FÍSICO TOTAL — "contamos 40" fija el stock en 40, sea cual sea
  // el valor previo — igual que el tipo "ajuste" del modal (input "Stock
  // total resultante"). No se manda p_offline_local_id ni
  // p_stock_sistema_esperado (son del plan offline del dispositivo, sin
  // sentido para una llamada síncrona del asistente).
  {
    name: 'registrar_conteo_stock_asistente',
    description: 'Registra un conteo físico de stock: fija el stock de un producto en un depósito al valor CONTADO, sea cual sea el valor que tenía antes (no suma ni resta, REEMPLAZA). Usar para "contamos tantas unidades de tal producto en tal depósito", "el conteo físico dio tanto". No confundir con ajustar_stock_asistente, que mueve una cantidad relativa.',
    roles: ['dueno', 'admin', 'depositero'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre o parte del nombre del producto.' },
        deposito: { type: 'string', description: 'Nombre o parte del nombre del depósito.' },
        cantidad_contada: { type: 'number', description: 'Cantidad física contada. Debe ser mayor o igual a cero.' },
        notas: { type: 'string', description: 'Notas adicionales del conteo, si el usuario dio alguna. Opcional.' },
      },
      required: ['producto', 'deposito', 'cantidad_contada'],
    },
    async resumen({ empresaId, args }) {
      const { producto, deposito, cantidadContada } = await resolverConteoStock({ empresaId, args });
      const { data: stockFila } = await db.from('stock')
        .select('cantidad')
        .eq('producto_id', producto.id).eq('deposito_id', deposito.id)
        .maybeSingle();
      const sistema = Number(stockFila?.cantidad || 0);
      const diferencia = cantidadContada - sistema;
      const textoDif = diferencia === 0
        ? 'sin diferencia'
        : `diferencia ${diferencia > 0 ? '+' : ''}${diferencia}`;
      return `Registrar conteo físico de "${producto.nombre}" en "${deposito.nombre}": sistema ${sistema} → contado ${cantidadContada} (${textoDif}).`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const { producto, deposito, cantidadContada } = await resolverConteoStock({ empresaId, args });
      const { data, error } = await db.rpc('registrar_conteo_stock', {
        p_producto_id: producto.id,
        p_deposito_id: deposito.id,
        p_cantidad_contada: cantidadContada,
        p_motivo: 'conteo_fisico',
        p_notas: args.notas || null,
        p_usuario_id: usuarioId,
      });
      if (error) throw new Error(`registrar_conteo_stock_asistente: ${error.message}`);
      if (!data?.ok) throw new Error(data?.error || 'No se pudo registrar el conteo.');
      return {
        ok: true,
        producto: producto.nombre,
        deposito: deposito.nombre,
        stock_nuevo: data.stock_nuevo,
        cantidad_sistema: data.cantidad_sistema,
        diferencia: data.diferencia,
      };
    },
  },
  // compras.html: crear_orden_compra_asistente. crear_orden_compra() no
  // valida rol internamente (solo assert_empresa_access, no-op con
  // service_role) — el gate de rol lo pone acá `roles`, igual que en el
  // resto de tools de escritura, para no dejar el service role del
  // asistente ejecutando algo que un depositero no podría hacer desde el
  // panel (compras.html está restringido a dueno/admin en el panel real).
  {
    name: 'crear_orden_compra_asistente',
    description: 'Crea una orden de compra nueva a un proveedor, con una lista de productos, cantidades y precio de costo. Usar para "hacé un pedido/orden de compra a tal proveedor de tantas unidades de tal producto". Antes de llamarla asegurate de tener el proveedor y al menos un producto con cantidad y precio de costo — si falta el precio de costo, pedíselo primero (no lo inventes ni uses el último precio de venta).',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        proveedor: { type: 'string', description: 'Nombre o razón social del proveedor, tal como lo dio el usuario.' },
        items: {
          type: 'array',
          description: 'Productos a pedir, con al menos uno.',
          items: {
            type: 'object',
            properties: {
              producto: { type: 'string', description: 'Nombre o parte del nombre del producto.' },
              cantidad: { type: 'number', description: 'Cantidad a pedir. Debe ser mayor a cero.' },
              precio_costo: { type: 'number', description: 'Precio de costo unitario acordado con el proveedor. Debe ser mayor a cero.' },
            },
            required: ['producto', 'cantidad', 'precio_costo'],
          },
        },
        fecha_esperada: { type: 'string', description: 'Fecha esperada de entrega, en formato YYYY-MM-DD, si el usuario dio una. Opcional.' },
        notas: { type: 'string', description: 'Notas de la orden, si el usuario dio alguna. Opcional.' },
      },
      required: ['proveedor', 'items'],
    },
    async resumen({ empresaId, args }) {
      const { proveedor, itemsResueltos } = await resolverOrdenCompraDesdeArgs({ empresaId, args });
      const subtotal = itemsResueltos.reduce((acc, it) => acc + it.cantidad * it.precio_costo, 0);
      const detalle = itemsResueltos.map((it) => `${it.cantidad} × ${it.nombre} ($${it.precio_costo.toLocaleString('es-AR')} c/u)`).join(', ');
      return `Crear orden de compra a "${proveedor.nombre}": ${detalle}. Subtotal $${subtotal.toLocaleString('es-AR')} (más IVA).`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const { proveedor, itemsResueltos } = await resolverOrdenCompraDesdeArgs({ empresaId, args });
      const { data, error } = await db.rpc('crear_orden_compra', {
        p_empresa_id: empresaId,
        p_proveedor_id: proveedor.id,
        p_fecha_esperada: args.fecha_esperada || null,
        p_notas: args.notas || null,
        p_created_by: usuarioId,
        p_items: itemsResueltos.map((it) => ({
          producto_id: it.producto_id,
          cantidad: it.cantidad,
          precio_costo: it.precio_costo,
        })),
      });
      if (error) throw new Error(`crear_orden_compra_asistente: ${error.message}`);
      if (data && data.ok === false) throw new Error(data.error || 'No se pudo crear la orden de compra.');
      return { ok: true, proveedor: proveedor.nombre, numero: data.numero, orden_id: data.orden_id };
    },
  },
  // compras.html: recepcionar_orden_compra_asistente. Se leyó el handler
  // real (RPC recepcionar_orden_compra, migración 341): NO valida rol
  // internamente más allá de que la OC pertenezca a la empresa — mismo
  // motivo que arriba, el gate de rol lo pone `roles` acá. Si el usuario no
  // da items puntuales, se recepciona TODO lo pendiente de la OC (cantidad
  // - cantidad_recibida de cada renglón, al precio_costo ya pactado en la
  // orden) — cubre el caso más común ("llegó la mercadería de la OC tal,
  // recepcionala") sin obligar a redictar cada línea por voz.
  {
    name: 'recepcionar_orden_compra_asistente',
    description: 'Recepciona (total o parcialmente) una orden de compra ya creada, sumando la mercadería recibida al stock de un depósito. Usar para "llegó/recepcioná la orden de compra tal", "recibimos tantas unidades de tal producto de la OC tal". Si el usuario no especifica productos ni cantidades, se recepciona TODO lo que esté pendiente de la orden. Si el usuario da productos/cantidades puntuales, se recepciona solo eso (recepción parcial).',
    roles: ['dueno', 'admin', 'depositero'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        numero_oc: { type: 'string', description: 'Número de la orden de compra (ej. "OC-000185"), tal como lo dio el usuario.' },
        deposito: { type: 'string', description: 'Depósito donde ingresa la mercadería. Si no lo dan, se usa el depósito principal de la empresa.' },
        items: {
          type: 'array',
          description: 'Productos y cantidades a recepcionar puntualmente. Opcional — si se omite, se recepciona todo lo pendiente de la orden.',
          items: {
            type: 'object',
            properties: {
              producto: { type: 'string', description: 'Nombre o parte del nombre del producto.' },
              cantidad_recibida: { type: 'number', description: 'Cantidad recibida de ese producto. Debe ser mayor a cero.' },
            },
            required: ['producto', 'cantidad_recibida'],
          },
        },
      },
      required: ['numero_oc'],
    },
    async resumen({ empresaId, args }) {
      const { orden, deposito, itemsAReceptionar } = await resolverRecepcionOrdenCompra({ empresaId, args });
      if (!itemsAReceptionar.length) throw new Error(`La orden ${orden.numero} no tiene renglones pendientes de recepción.`);
      const detalle = itemsAReceptionar.map((it) => `${it.cantidad_recibida} × ${it.nombre}`).join(', ');
      const depTexto = deposito ? ` en "${deposito.nombre}"` : ' en el depósito principal de la empresa';
      return `Recepcionar orden ${orden.numero}${depTexto}: ${detalle}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const { orden, deposito, itemsAReceptionar } = await resolverRecepcionOrdenCompra({ empresaId, args });
      if (!itemsAReceptionar.length) throw new Error(`La orden ${orden.numero} no tiene renglones pendientes de recepción.`);
      const { data, error } = await db.rpc('recepcionar_orden_compra', {
        p_empresa_id: empresaId,
        p_orden_id: orden.id,
        p_items: itemsAReceptionar.map((it) => ({
          producto_id: it.producto_id,
          cantidad_recibida: it.cantidad_recibida,
          precio_costo: it.precio_costo,
        })),
        p_usuario_id: usuarioId,
        p_deposito_id: deposito?.id || null,
      });
      if (error) throw new Error(`recepcionar_orden_compra_asistente: ${error.message}`);
      if (data && data.ok === false) throw new Error(data.error || 'No se pudo recepcionar la orden de compra.');
      return { ok: true, numero: orden.numero, ...data };
    },
  },
  // pedidos.js: modificar_pedido_no_confirmado. Se leyó el handler real
  // (PATCH /api/pedidos) antes de escribir esto: NO existe un endpoint que
  // reemplace ítems/cantidades de un pedido — el PATCH real solo cambia
  // `estado` (dentro de ESTADOS_VALIDOS) y `notas_internas`. Inventar edición
  // de renglones acá sería agregar una funcionalidad que el sistema no
  // tiene, así que esta tool se acota exactamente a lo que el handler real
  // permite, restringido además a pedidos que TODAVÍA no se confirmaron
  // (estado='borrador') — para pedidos ya confirmados en adelante, cambiar
  // el estado es una decisión operativa distinta (despacho, entrega, etc.),
  // no una "modificación" en el sentido de este tool.
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
  // pedidos.js: registrar_devolucion_pedido. Se leyó crearDevolucionCore()
  // completo (usada tanto por la app del chofer como por POST /api/pedidos-
  // devoluciones sin `accion`, que es explícitamente el "alta manual desde
  // el admin, sin pasar por la app del chofer" — esa es la vía que
  // corresponde acá). No es una RPC: es lógica en JS que hace 1) insert en
  // `devoluciones`, 2) insert en `devolucion_items`, 3) SI el motivo es
  // 'producto_defectuoso', agrupa por producto.proveedor_id_default y crea
  // una nota de débito automática al proveedor por cada uno (se replica
  // igual acá), y 4) dispara recalculo de score del cliente (RPC
  // calcular_score_cliente, best-effort). Deliberadamente NO se replica el
  // notifAuto() de push al admin: ninguna otra tool de este archivo intenta
  // reproducir ese side-effect (está atado a infraestructura de push del
  // servidor, no a una RPC), así que se deja fuera igual que en el resto.
  // Importante: esta tool NO toca stock — el handler real tampoco lo hace;
  // una devolución solo queda "pendiente" para revisión manual en
  // /admin/devoluciones, que es quien decide si repone stock o no.
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
    async execute({ empresaId, args }) {
      const resuelto = await resolverDevolucionPedido({ empresaId, args });

      const { data: devolucion, error: errDev } = await db.from('devoluciones')
        .insert({
          empresa_id: empresaId,
          pedido_id: resuelto.pedido.id,
          cliente_id: resuelto.pedido.cliente_id,
          motivo: resuelto.motivo,
          notas: args.notas || null,
          estado: 'pendiente',
        })
        .select('id')
        .single();
      if (errDev) throw new Error(`registrar_devolucion_pedido: ${errDev.message}`);

      const itemsPayload = resuelto.itemsResueltos.map((it) => ({
        devolucion_id: devolucion.id,
        producto_id: it.id,
        cantidad: it.cantidad,
        precio_unitario: it.precio_unitario || 0,
      }));
      const { error: errItems } = await db.from('devolucion_items').insert(itemsPayload);
      if (errItems) throw new Error(`registrar_devolucion_pedido (items): ${errItems.message}`);

      let notasDebitoCreadas = [];
      let itemsSinProveedorDefault = [];
      if (resuelto.motivo === 'producto_defectuoso') {
        const productoIds = [...new Set(resuelto.itemsResueltos.map((it) => it.id))];
        const { data: productos, error: errProd } = await db.from('productos')
          .select('id, nombre, proveedor_id_default')
          .in('id', productoIds);
        if (errProd) throw new Error(`registrar_devolucion_pedido (productos): ${errProd.message}`);

        const proveedorPorProducto = new Map((productos || []).map((p) => [p.id, p.proveedor_id_default]));
        const montoPorProveedor = new Map();

        for (const it of resuelto.itemsResueltos) {
          const proveedorId = proveedorPorProducto.get(it.id);
          if (!proveedorId) {
            itemsSinProveedorDefault.push({ producto_id: it.id, nombre: it.nombre, cantidad: it.cantidad });
            continue;
          }
          const monto = (Number(it.cantidad) || 0) * (Number(it.precio_unitario) || 0);
          montoPorProveedor.set(proveedorId, (montoPorProveedor.get(proveedorId) || 0) + monto);
        }

        for (const [proveedorId, monto] of montoPorProveedor.entries()) {
          const { data: nd, error: errNd } = await db.from('notas_debito_proveedor')
            .insert({
              empresa_id: empresaId,
              proveedor_id: proveedorId,
              devolucion_id: devolucion.id,
              motivo: `Producto defectuoso — devolución de cliente (ref. ${devolucion.id.slice(0, 8)})`,
              monto,
              estado: 'pendiente',
            })
            .select('id, proveedor_id, monto')
            .single();
          if (errNd) throw new Error(`registrar_devolucion_pedido (nota de débito): ${errNd.message}`);
          if (nd) notasDebitoCreadas.push(nd);
        }
      }

      db.rpc('calcular_score_cliente', {
        p_cliente_id: resuelto.pedido.cliente_id, p_empresa_id: empresaId, p_motivo: 'devolucion_registrada',
      }).then(() => {}).catch(() => {});

      return {
        ok: true,
        devolucion_id: devolucion.id,
        notas_debito_creadas: notasDebitoCreadas,
        items_sin_proveedor_default: itemsSinProveedorDefault,
      };
    },
  },
  // pedidos.js: cancelar_pedido_asistente. Este es el más delicado del
  // archivo — se leyó completa la rama DELETE (sin ?accion=eliminar, que
  // es un borrado físico distinto y no se toca acá) antes de escribir
  // esto. NO es un solo RPC: son ~5 pasos JS encadenados, replicados uno
  // por uno, en el mismo orden, con el mismo criterio "best-effort no
  // bloqueante" que usa el handler real para los pasos 2 y 4:
  //   1. Rechazar si el pedido ya está 'entregado' o 'cancelado'.
  //   2. Si estaba 'confirmado'/'preparando': liberar el stock reservado
  //      de cada ítem (RPC liberar_stock_reservado), depósito principal
  //      primero o el primero disponible si no hay principal — best-effort,
  //      un fallo acá no frena la cancelación (igual que el handler real).
  //   3. Marcar el pedido como 'cancelado'.
  //   4. Revertir puntos de fidelización ya acreditados (RPC
  //      revertir_puntos_pedido_cancelado) — best-effort.
  //   5. Facturas vinculadas en 'pendiente' → se anulan directo (sin
  //      efecto fiscal real, nunca se emitió CAE). Facturas en 'emitida'
  //      (CON CAE real de ARCA/AFIP) → NO se pisa el estado a mano: se
  //      llama a anularFactura() de lib/facturas.js (el MISMO módulo que
  //      usa el handler HTTP — asistente-tools.js vive en lib/, igual que
  //      facturas.js, mismo import relativo `./facturas.js` que usa
  //      pedidos.js con `../facturas.js` desde lib/handlers/), que emite
  //      una Nota de Crédito C real contra ARCA vía WSFEv1. Por eso el
  //      resumen() de esta tool avisa ESO explícitamente antes de
  //      confirmar — no es una cancelación "solo interna" si hay factura
  //      con CAE de por medio.
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
          const { data: stockRows } = await db.from('stock')
            .select('deposito_id, cantidad, cantidad_reservada, depositos!inner(es_principal, empresa_id)')
            .eq('producto_id', item.producto_id)
            .eq('depositos.empresa_id', empresaId);

          if (!stockRows || stockRows.length === 0) continue;

          const principal = stockRows.find((s) => s.depositos.es_principal);
          const elegido = principal || stockRows[0];

          await db.rpc('liberar_stock_reservado', {
            p_producto_id: item.producto_id,
            p_deposito_id: elegido.deposito_id,
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
  // bcra.js: consultar_situacion_bcra_cliente. Distinto de TODO lo demás en
  // este archivo: no hay ninguna RPC ni tabla de por medio — el handler
  // real llama directo a las APIs públicas y gratuitas del Banco Central
  // (api.bcra.gob.ar), sin API key. Se replica acá la misma llamada que
  // hace `accion=verificar-cliente` (situación crediticia + cheques
  // rechazados en paralelo para un mismo CUIT), agregando la resolución
  // por nombre de cliente/proveedor que no tenía el handler (que recibe el
  // CUIT ya resuelto desde el frontend).
  //
  // El propio bcra.js trae una advertencia explícita en su cabecera: se
  // escribió en base a la documentación pública, SIN poder probarlo contra
  // la API real (el entorno de desarrollo no tuvo salida a internet). Este
  // sandbox tampoco tiene salida a api.bcra.gob.ar, así que TAMPOCO se pudo
  // probar acá — se devuelve el `results` crudo de BCRA tal cual, sin
  // reinterpretar nombres de campo, por la misma razón que ya explica el
  // handler: si BCRA cambió algo, hay que ajustar el parseo viendo la
  // primera respuesta real en producción, no adivinar.
  //
  // No se marca `requiereConfirmacion` porque es de solo lectura (no
  // escribe nada) — coincide con que el handler real es todo GET.
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
  {
    name: 'consultar_cheque_denunciado_bcra',
    description: 'Verifica ante el BCRA si un cheque puntual (por código de entidad bancaria y número de cheque) está denunciado como robado, extraviado o adulterado. Distinto de un cheque "rechazado" (sin fondos) — para eso usar consultar_situacion_bcra_cliente. Usar antes de aceptar un cheque de terceros, cuando el usuario da el banco y el número.',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        codigo_entidad: { type: 'integer', description: 'Código numérico de la entidad bancaria (BCRA). Si no lo tienen, primero hay que consultar el listado de entidades.' },
        numero_cheque: { type: 'integer', description: 'Número del cheque.' },
      },
      required: ['codigo_entidad', 'numero_cheque'],
    },
    async execute({ args }) {
      const codigoEntidad = parseInt(args.codigo_entidad, 10);
      const numeroCheque = parseInt(args.numero_cheque, 10);
      if (!codigoEntidad || !numeroCheque) {
        throw new Error('Faltan codigo_entidad y numero_cheque, ambos son requeridos.');
      }
      const { data, notFound } = await fetchBcraDirecto(`/cheques/v1.0/denunciados/${codigoEntidad}/${numeroCheque}`);
      if (notFound) return { encontrado: false };
      return { encontrado: true, resultado: data?.results || null };
    },
  },
  // empresa.js: se leyó el handler completo (api/empresa/index.js). De sus
  // 5 rutas solo 3 tienen sentido como tool de chat:
  //   - GET  datos            → consultar_datos_empresa (lectura)
  //   - PUT  datos             → actualizar_datos_empresa (escritura)
  //   - PUT  catalogo-publico → actualizar_catalogo_publico_empresa (escritura)
  // Deliberadamente AFUERA:
  //   - POST logo  → requiere mandar un archivo binario (base64 + sharp
  //     para redimensionar/convertir a WebP); no hay forma razonable de
  //     que el usuario le "diga" un logo al asistente en un chat de texto.
  //   - GET  icon  → solo hace un redirect al logo actual (o al ícono
  //     estático de fallback); no aporta nada que consultar_datos_empresa
  //     no devuelva ya en logo_url.
  // Los 3 handlers reales de arriba comparten el mismo gate de rol
  // (['dueno','admin'], sin contador) — se replica igual acá, ya que ni el
  // nav ni el resto del sistema le dan a contador acceso a "Datos de la
  // empresa".
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
  // cierre.js: se encontró y arregló un bug real en el propio handler
  // (no solo acá) antes de agregar la tool de escritura: procesarFacturacion()
  // chequeaba `empresas.config.facturacion.api_key`/`.usertoken` —
  // integración vieja (FacturAPI) ya reemplazada por ARCA/WSFEv1 (ver
  // lib/facturas.js). Se verificó contra la base real: 0 de 2 empresas
  // tienen ese config viejo, así que esa rama nunca facturaba — el cierre
  // asentaba el débito en cta_cte pero NUNCA emitía la factura electrónica
  // real. Se corrigió cierre.js para que chequee `facturacion_config` (la
  // tabla real) y llame a emitirFactura() — la misma función que usa el
  // botón "Facturar" manual — en vez de reimplementar ARCA acá. De paso se
  // exportó `procesarColaFinancieraEmpresa(empresaId)` desde cierre.js
  // (scopeada, sin tocar detectarVencimientosYBloquear() que es global a
  // todas las empresas) para que la tool de abajo reuse el mismo código
  // que corre el cron real, en vez de duplicar el loop acá.
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
  // automatizacion.js: la rama POST ?accion=ejecutar del handler original
  // hacía un fetch HTTP interno a cada motor reenviando el Bearer del
  // usuario (AUTOMATIZACION-001), algo que ejecutarTool() no puede hacer
  // porque no recibe el request original ni el token — solo empresaId, rol,
  // usuarioId. Se resolvió refactorizando los 4 handlers que todavía no
  // exponían su lógica como función reusable (piloto, stock-auto, score,
  // auditoria — cierre.js ya tenía procesarColaFinancieraEmpresa) para que
  // esta tool los llame directo, igual que la tool de arriba. Es UNA tool
  // parametrizada por `motor` (no 5 tools separadas) porque las 5 acciones
  // comparten el mismo perfil de riesgo (re-disparar manualmente, sobre la
  // propia empresa, algo que ya existe como botón en el panel) y el mismo
  // patrón de confirmación — separar en 5 tools solo duplicaría el resumen.
  // 'cierre' no es un motor nuevo acá: reusa procesarColaFinancieraEmpresa,
  // la misma función que ya usa ejecutar_cierre_financiero_pendiente arriba,
  // para no tener dos caminos distintos al mismo código.
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
  // export-contable.js: 4 tools. Reusa generarExport() de
  // lib/export-contable/index.js (mismo dispatcher que usa el handler
  // HTTP) en vez de reimplementar los formateadores acá. De los 4
  // proveedores documentados solo generico_csv está implementado —
  // tango/bejerman/contabilium tiran FORMATO_NO_IMPLEMENTADO a propósito
  // (ver comentario en formato-tango.js: sin un archivo de ejemplo real
  // del contador, el riesgo es generar un archivo que el sistema contable
  // "importa" con las cuentas cruzadas, peor que no exportar nada). Se
  // verificaron contra la base real las 4 tablas/vistas que usa este
  // grupo: export_contable_config, export_contable_log,
  // v_comprobantes_contables_venta/compra — existen las 4.
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

  // ── Invitación de choferes (lib/handlers/chofer_invitacion.js) ──────────
  // Reusan las mismas funciones que el handler HTTP (listarInvitacionesChofer/
  // invitarChoferNuevo/invitarChoferExistente/revocarInvitacionChofer), nunca
  // arman el token ni tocan chofer_invitaciones/usuarios/auth directo acá.
  //
  // OJO — accion "impersonar" del handler NO tiene tool acá a propósito:
  // genera un magic link que da acceso real e inmediato a la cuenta de un
  // tercero (el chofer), sin que el chofer se entere. Exponerlo como tool
  // significa que un mensaje de chat ambiguo ("necesito entrar como Fulano")
  // + un click de Confirmar alcanzarían para loguearse como esa persona.
  // Es una decisión de producto (¿vale la pena el atajo?), no un olvido —
  // lo dejo afuera hasta que se decida explícitamente incluirla.
  {
    name: 'consultar_invitaciones_chofer',
    description: 'Lista las invitaciones de acceso a choferes emitidas (nombre, teléfono, estado: activo/aceptada/expirado/revocado). Usar para "qué choferes invité", "el link del chofer X sigue activo".',
    roles: ROLES_CHOFER_INVITACION,
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const resultado = await listarInvitacionesChofer({ empresa_id: empresaId });
      if (!resultado.ok) throw new Error(`consultar_invitaciones_chofer: ${resultado.error}`);
      return { invitaciones: resultado.invitaciones };
    },
  },
  {
    name: 'invitar_chofer_nuevo',
    description: 'Da de alta un chofer nuevo (crea su usuario, ya activo) y genera el link de WhatsApp para que active su propio acceso. Usar cuando piden sumar/invitar a un chofer que todavía no existe en el sistema.',
    roles: ROLES_CHOFER_INVITACION,
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del chofer.' },
        telefono: { type: 'string', description: 'Teléfono del chofer (con o sin código de país/0 inicial, se normaliza).' },
      },
      required: ['nombre', 'telefono'],
    },
    async resumen({ args }) {
      return `Dar de alta al chofer "${args.nombre}" (tel. ${args.telefono}) y generarle un link de invitación por WhatsApp.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const resultado = await invitarChoferNuevo({
        empresa_id: empresaId,
        creado_por: usuarioId,
        nombre: args.nombre,
        telefono: args.telefono,
        baseUrl: APP_URL_FALLBACK,
      });
      if (!resultado.ok) throw new Error(`invitar_chofer_nuevo: ${resultado.error}`);
      return { ok: true, url: resultado.url, waLink: resultado.waLink, expira_at: resultado.expira_at };
    },
  },
  {
    name: 'invitar_chofer_existente',
    description: 'Genera un nuevo link de invitación para un chofer que ya está cargado en el sistema (reset de acceso — ej. perdió el link anterior o venció). Requiere el usuario_id del chofer; si no se conoce, primero hay que buscarlo (ej. con consultar_choferes o similar) antes de llamar esta tool.',
    roles: ROLES_CHOFER_INVITACION,
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        usuario_id: { type: 'string', description: 'ID del usuario (chofer) ya existente.' },
      },
      required: ['usuario_id'],
    },
    async resumen({ args }) {
      return `Generar un nuevo link de acceso para el chofer con id ${args.usuario_id}.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const resultado = await invitarChoferExistente({
        empresa_id: empresaId,
        creado_por: usuarioId,
        usuario_id: args.usuario_id,
        baseUrl: APP_URL_FALLBACK,
      });
      if (!resultado.ok) throw new Error(`invitar_chofer_existente: ${resultado.error}`);
      return { ok: true, url: resultado.url, waLink: resultado.waLink, expira_at: resultado.expira_at };
    },
  },
  {
    name: 'revocar_invitacion_chofer',
    description: 'Revoca (desactiva) una invitación de chofer pendiente, para que el link deje de funcionar. No afecta a choferes cuyo acceso ya fue activado.',
    roles: ROLES_CHOFER_INVITACION,
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        invitacion_id: { type: 'string', description: 'ID de la invitación a revocar (ver consultar_invitaciones_chofer).' },
      },
      required: ['invitacion_id'],
    },
    async resumen({ args }) {
      return `Revocar la invitación ${args.invitacion_id} — el link dejará de funcionar.`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const resultado = await revocarInvitacionChofer({ empresa_id: empresaId, invitacion_id: args.invitacion_id, revocado_por: usuarioId });
      if (!resultado.ok) throw new Error(`revocar_invitacion_chofer: ${resultado.error}`);
      return { ok: true };
    },
  },

  // ── Migración asistida (lib/handlers/migracion.js) ──────────────────────
  // SOLO lectura, a propósito. El wizard entero gira en torno a un archivo
  // CSV/Excel parseado client-side y subido por lotes (crear/mapear/precheck/
  // confirmar/reintentar/deshacer): no hay forma sensata de que un mensaje de
  // chat traiga esas filas, y "confirmar"/"deshacer" son operaciones masivas
  // sobre clientes/productos/pedidos/etc. — no algo para gatillar por texto
  // ambiguo aunque haya confirmación de por medio. Si en algún momento se
  // quiere que el asistente DISPARE una migración ya subida desde el panel
  // (ej. "confirmá la migración que dejé pendiente"), eso es una tool nueva
  // a diseñar con cuidado, no una extensión de esto.
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

  // ── Portal de autogestión de proveedores (lib/handlers/portal_proveedor.js) ─
  // Mismas 3 acciones que chofer_invitacion (generar/listar/revocar), sin
  // análogo a "impersonar" acá — el link del portal solo da acceso de LECTURA
  // + carga de sus propias OCs/facturas, nunca a una cuenta de usuario real.
  {
    name: 'consultar_links_portal_proveedor',
    description: 'Lista los links de portal de autogestión emitidos para un proveedor (activo/expirado/revocado, último uso). Usar para "el link del portal de tal proveedor sigue activo", "cuándo entró tal proveedor al portal".',
    roles: ROLES_PORTAL_PROVEEDOR,
    parameters: {
      type: 'object',
      properties: {
        proveedor: { type: 'string', description: 'Nombre o parte del nombre del proveedor.' },
      },
      required: ['proveedor'],
    },
    async execute({ empresaId, args }) {
      const proveedor = await buscarProveedorPorTexto({ empresaId, texto: args.proveedor });
      const resultado = await listarLinksPortalProveedor({ empresa_id: empresaId, proveedor_id: proveedor.id });
      if (!resultado.ok) throw new Error(`consultar_links_portal_proveedor: ${resultado.error}`);
      return { proveedor: proveedor.nombre, links: resultado.links };
    },
  },
  {
    name: 'generar_link_portal_proveedor',
    description: 'Genera (o regenera) el link de portal de autogestión para un proveedor, donde puede ver sus órdenes de compra, confirmar fechas de entrega y subir facturas. Usar cuando piden "mandale el link del portal a tal proveedor" o similar.',
    roles: ROLES_PORTAL_PROVEEDOR,
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        proveedor: { type: 'string', description: 'Nombre o parte del nombre del proveedor.' },
      },
      required: ['proveedor'],
    },
    async resumen({ empresaId, args }) {
      const proveedor = await buscarProveedorPorTexto({ empresaId, texto: args.proveedor });
      return `Generar un link de portal de autogestión para "${proveedor.nombre}" (válido 30 días).`;
    },
    async execute({ empresaId, usuarioId, args }) {
      const proveedor = await buscarProveedorPorTexto({ empresaId, texto: args.proveedor });
      const resultado = await generarLinkPortalProveedor({
        empresa_id: empresaId, creado_por: usuarioId,
        proveedor_id: proveedor.id, baseUrl: APP_URL_FALLBACK,
      });
      if (!resultado.ok) throw new Error(`generar_link_portal_proveedor: ${resultado.error}`);
      return { ok: true, proveedor: resultado.proveedor, url: resultado.url, expira_at: resultado.expira_at };
    },
  },
  {
    name: 'revocar_link_portal_proveedor',
    description: 'Revoca un link de portal de proveedor ya emitido, para que deje de funcionar. Requiere el token_id (ver consultar_links_portal_proveedor).',
    roles: ROLES_PORTAL_PROVEEDOR,
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        token_id: { type: 'string', description: 'ID del link/token a revocar (ver consultar_links_portal_proveedor).' },
      },
      required: ['token_id'],
    },
    async resumen({ args }) {
      return `Revocar el link de portal de proveedor ${args.token_id} — dejará de funcionar.`;
    },
    async execute({ empresaId, args }) {
      const resultado = await revocarLinkPortalProveedor({ empresa_id: empresaId, token_id: args.token_id });
      if (!resultado.ok) throw new Error(`revocar_link_portal_proveedor: ${resultado.error}`);
      return { ok: true };
    },
  },

  // ── Usuarios internos del equipo (lib/handlers/usuarios.js) ─────────────
  // SOLO lectura, a propósito — más tajante que con chofer_invitacion/
  // portal_proveedor, donde solo UNA acción puntual (impersonar) quedaba
  // afuera. Acá no hay una acción "inocente" que separar: alta (crea
  // usuario + contraseña real), cambio de rol (incluye ascender a alguien a
  // admin/dueño — escalación de privilegios) y activar/desactivar (corta o
  // habilita el acceso real de una persona) son, las tres, exactamente el
  // tipo de acción que se dejó afuera en los otros archivos. No tiene
  // sentido que un mensaje de chat ambiguo + un click de Confirmar alcancen
  // para, por ejemplo, hacer admin a alguien.
  // ── liquidacion.html (Fase D — cierre, CHANGELOG_v716) ───────────────────
  // 2 tools de lectura (roles = stock.acceder, igual que el resto de la
  // pantalla) + 2 de escritura (roles = ['dueno','admin'], igual que el
  // chequeo explícito que hace handleLiquidacion() para 'generar' disparo
  // manual y 'guardar-reglas'). Ver comentario junto al import de
  // repos/stock.js más arriba.
  {
    name: 'consultar_ofertas_liquidacion_asistente',
    description: 'Lista las ofertas de liquidación activas (productos con descuento por vencimiento próximo de su lote): producto, lote, precio de oferta, porcentaje de descuento, cantidad disponible y cuándo vence la oferta. Usar para "qué productos están en liquidación", "qué ofertas de liquidación hay activas", "qué descuentos por vencimiento tengo corriendo".',
    roles: ['dueno', 'admin', 'vendedor', 'depositero'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const { data, error } = await listarOfertasLiquidacion(empresaId);
      if (error) throw new Error(`consultar_ofertas_liquidacion_asistente: ${error.message}`);
      return (data || []).map((o) => ({
        producto: o.productos?.nombre || null,
        codigo: o.productos?.codigo || null,
        lote: o.lotes?.numero_lote || null,
        vencimiento_lote: o.lotes?.fecha_vencimiento || null,
        precio_base: o.productos?.precio_base ?? null,
        precio_oferta: o.precio_oferta,
        descuento_pct: o.descuento_pct,
        cantidad_disponible: o.cantidad_snapshot,
        dias_restantes_al_crear: o.dias_restantes_al_crear,
        vence_oferta_at: o.vence_oferta_at,
      }));
    },
  },
  {
    name: 'consultar_reglas_liquidacion_asistente',
    description: 'Reglas configuradas para generar ofertas de liquidación automáticas: si el sistema está activo, cada cuántos días antes del vencimiento se empieza a considerar un lote (dias_alerta), y los 3 niveles de descuento según días restantes al vencimiento (nivel 1 = el más lejano/leve, nivel 3 = el más cercano/agresivo). Usar para "qué reglas de liquidación tengo configuradas", "a partir de cuántos días se genera un descuento", "está activa la liquidación automática".',
    roles: ['dueno', 'admin', 'vendedor', 'depositero'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const r = (await obtenerReglasLiquidacion(empresaId)) || {
        dias_alerta: 7, dias_nivel1: 3, pct_nivel1: 10,
        dias_nivel2: 1, pct_nivel2: 15, dias_nivel3: 0, pct_nivel3: 25,
        activo: true,
      };
      return {
        activo: r.activo !== false,
        dias_alerta: r.dias_alerta,
        nivel1: { dias_restantes_maximo: r.dias_nivel1, descuento_pct: r.pct_nivel1 },
        nivel2: { dias_restantes_maximo: r.dias_nivel2, descuento_pct: r.pct_nivel2 },
        nivel3: { dias_restantes_maximo: r.dias_nivel3, descuento_pct: r.pct_nivel3 },
      };
    },
  },
  // generar_ofertas_liquidacion (RPC) acepta p_dry_run desde antes (la usa
  // el propio cron para simular, aunque handleLiquidacion nunca lo manda en
  // true para el disparo manual admin). Se aprovecha acá para que resumen()
  // muestre lo que va a pasar de verdad (cuántas ofertas se crean/
  // actualizan, cuántas se desactivan) en vez de una frase genérica —
  // resumen() corre en modo dry_run (no escribe nada), execute() corre la
  // versión real después del click de Confirmar.
  {
    name: 'generar_ofertas_liquidacion_asistente',
    description: 'Dispara ahora mismo la generación de ofertas de liquidación: revisa los lotes por vencer según las reglas configuradas, crea o actualiza las ofertas correspondientes, y desactiva las que ya vencieron o se quedaron sin stock. Es la misma acción que el botón "Generar ahora" de la pantalla de liquidación (normalmente corre sola, una vez por día, por cron). Usar cuando el usuario pida explícitamente disparar la generación ahora, sin esperar al cron diario.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: { type: 'object', properties: {} },
    async resumen({ empresaId }) {
      const { data, error } = await db.rpc('generar_ofertas_liquidacion', {
        p_empresa_id: empresaId,
        p_dry_run: true,
      });
      if (error) throw new Error(`generar_ofertas_liquidacion_asistente: ${error.message}`);
      if (!data?.ok) throw new Error(data?.error || 'No se pudo evaluar la generación de ofertas de liquidación.');
      const creadas = data.creadas?.length || 0;
      const desactivadas = data.desactivadas || 0;
      if (!creadas && !desactivadas) {
        return 'Generar ofertas de liquidación ahora: no habría cambios (ningún lote nuevo dentro de la ventana configurada, ni ofertas para desactivar).';
      }
      const partes = [];
      if (creadas) partes.push(`crear o actualizar ${creadas} oferta(s)`);
      if (desactivadas) partes.push(`desactivar ${desactivadas} oferta(s) vencida(s) o sin stock`);
      return `Generar ofertas de liquidación ahora: ${partes.join(' y ')}.`;
    },
    async execute({ empresaId }) {
      const { data, error } = await db.rpc('generar_ofertas_liquidacion', {
        p_empresa_id: empresaId,
        p_dry_run: false,
      });
      if (error) throw new Error(`generar_ofertas_liquidacion_asistente: ${error.message}`);
      if (!data?.ok) throw new Error(data?.error || 'No se pudo generar las ofertas de liquidación.');
      return { ok: true, creadas: data.creadas?.length || 0, desactivadas: data.desactivadas || 0 };
    },
  },
  {
    name: 'guardar_reglas_liquidacion_asistente',
    description: 'Modifica las reglas de liquidación automática (activar/desactivar el sistema, días de anticipación para empezar a alertar, y los 3 niveles de descuento por cercanía al vencimiento). Solo cambia los campos que el usuario pidió; el resto queda igual que estaba. Usar cuando pidan "cambiá el descuento del nivel 3 a 30%", "activá/desactivá la liquidación automática", "que el radar empiece a 10 días", o similar.',
    roles: ['dueno', 'admin'],
    requiereConfirmacion: true,
    parameters: {
      type: 'object',
      properties: {
        activo: { type: 'boolean', description: 'true para activar la generación automática de ofertas de liquidación, false para desactivarla (deja de crear ofertas nuevas; no borra ni desactiva las ya generadas).' },
        dias_alerta: { type: 'integer', description: 'Días antes del vencimiento en que un lote empieza a considerarse para liquidación.' },
        dias_nivel1: { type: 'integer', description: 'Días restantes al vencimiento por debajo de los cuales aplica el descuento de nivel 1 (el más leve). Debe ser mayor que dias_nivel2.' },
        pct_nivel1: { type: 'number', description: 'Porcentaje de descuento del nivel 1 (0 a 100).' },
        dias_nivel2: { type: 'integer', description: 'Días restantes al vencimiento por debajo de los cuales aplica el descuento de nivel 2 (intermedio). Debe ser menor que dias_nivel1 y mayor que dias_nivel3.' },
        pct_nivel2: { type: 'number', description: 'Porcentaje de descuento del nivel 2 (0 a 100).' },
        dias_nivel3: { type: 'integer', description: 'Días restantes al vencimiento por debajo de los cuales aplica el descuento de nivel 3 (el más agresivo). Debe ser menor que dias_nivel2.' },
        pct_nivel3: { type: 'number', description: 'Porcentaje de descuento del nivel 3 (0 a 100).' },
      },
    },
    async resumen({ empresaId, args }) {
      const { resumenCambios } = await armarCambiosReglaLiquidacion({ empresaId, args });
      if (!resumenCambios.length) throw new Error('No especificaste ningún dato para cambiar de las reglas de liquidación.');
      return `Actualizar las reglas de liquidación: ${resumenCambios.join(', ')}.`;
    },
    async execute({ empresaId, args }) {
      const { cambios } = await armarCambiosReglaLiquidacion({ empresaId, args });
      const { data, error } = await guardarReglasLiquidacion({
        empresa_id: empresaId,
        ...cambios,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(`guardar_reglas_liquidacion_asistente: ${error.message}`);
      return { ok: true, reglas: data };
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

// empresa.js: helpers de consultar_datos_empresa / actualizar_datos_empresa /
// actualizar_catalogo_publico_empresa. `empresas.id` ES el empresa_id (no es
// una tabla con FK a empresa_id como el resto — la fila de la empresa es la
// empresa), por eso se filtra por `id`, no por `empresa_id`.
async function obtenerDatosEmpresaActual({ empresaId }) {
  const { data, error } = await db.from('empresas')
    .select('nombre, cuit, domicilio, telefono, email, logo_url, config')
    .eq('id', empresaId)
    .single();
  if (error) throw new Error(`No se pudieron obtener los datos de la empresa: ${error.message}`);
  return data;
}

// Misma validación que el handler real (PUT /api/empresa/datos): nombre y
// CUIT (11 dígitos limpios de guiones) son obligatorios, email con formato
// básico si lo mandan. Los campos no mandados se completan con el valor
// actual, para que actualizar_datos_empresa pueda usarse para cambiar un
// solo campo (ej. "cambiame el teléfono") sin que el resto se borre — el
// handler real no tiene ese "parcial" porque el form del panel siempre
// manda los 5 campos juntos.
function armarUpdateDatosEmpresa({ actual, args }) {
  const nombre = args.nombre !== undefined ? String(args.nombre).trim() : actual.nombre;
  if (!nombre) throw new Error('El nombre / razón social es requerido.');

  const cuitCrudo = args.cuit !== undefined ? args.cuit : actual.cuit;
  const cuit = String(cuitCrudo ?? '').replace(/-/g, '').trim();
  if (!/^\d{11}$/.test(cuit)) throw new Error('El CUIT debe tener 11 dígitos numéricos.');

  const domicilio = args.domicilio !== undefined ? String(args.domicilio).trim() || null : (actual.domicilio ?? null);
  const telefono  = args.telefono  !== undefined ? String(args.telefono).trim()  || null : (actual.telefono  ?? null);
  const email     = args.email     !== undefined ? String(args.email).trim()     || null : (actual.email     ?? null);

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('El email no tiene un formato válido.');
  }

  return { nombre, cuit, domicilio, telefono, email };
}

// Dedupe de "maestros" (categorías/depósitos/zonas): estas 3 tablas no
// tienen unique constraint por nombre a nivel DB (se verificó contra el
// schema real antes de escribir esto), así que crear_categoria/
// crear_deposito/crear_zona hacen el chequeo acá — un ILIKE exacto (case
// insensitive) contra el nombre dentro de la misma empresa — para que un
// "creá la categoría Bebidas" repetido dos veces no genere dos filas
// duplicadas por una transcripción de voz o un doble pedido del usuario.
async function buscarMaestroExistente({ empresaId, tabla, nombre }) {
  const n = String(nombre || '').trim();
  const { data, error } = await db.from(tabla)
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .ilike('nombre', n)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo verificar ${tabla} existentes: ${error.message}`);
  return data;
}

// Resuelve nombres de depósito en texto libre a filas reales de la
// empresa. A diferencia de buscarClientePorTexto/buscarProductoPorTexto
// (que usan una RPC de similitud por trigramas porque hay potencialmente
// cientos de filas), acá alcanza con traer TODOS los depósitos de la
// empresa de una — normalmente son pocos (un puñado, no cientos) — y
// resolver cada nombre pedido con un ILIKE "contiene" en JS. Mismo
// criterio de "nunca adivinar": 0 o 2+ coincidencias para un nombre
// dado es una excepción con la lista real de depósitos disponibles.
async function resolverDepositosPorNombre({ empresaId, nombres }) {
  const { data: todos, error } = await db.from('depositos')
    .select('id, nombre')
    .eq('empresa_id', empresaId);
  if (error) throw new Error(`No se pudieron consultar los depósitos: ${error.message}`);
  if (!todos?.length) throw new Error('Esta empresa todavía no tiene ningún depósito cargado.');

  const resueltos = [];
  for (const nombreBuscado of nombres) {
    const t = String(nombreBuscado || '').trim().toLowerCase();
    if (!t) continue;
    const coincidencias = todos.filter((d) => d.nombre.toLowerCase().includes(t));
    if (!coincidencias.length) {
      const disponibles = todos.map((d) => d.nombre).join(', ');
      throw new Error(`No encontré ningún depósito parecido a "${nombreBuscado}". Depósitos disponibles: ${disponibles}.`);
    }
    if (coincidencias.length > 1) {
      const nombresCoincidentes = coincidencias.map((d) => d.nombre).join(', ');
      throw new Error(`Hay más de un depósito parecido a "${nombreBuscado}" (${nombresCoincidentes}). Pedile al usuario que precise cuál.`);
    }
    if (!resueltos.some((r) => r.id === coincidencias[0].id)) resueltos.push(coincidencias[0]);
  }
  if (!resueltos.length) throw new Error('Falta indicar en qué depósito(s) va el producto.');
  return resueltos;
}

// Resuelve una categoría por nombre para crear_producto/editar_producto.
// A propósito NUNCA la crea sola si no existe (a diferencia de cómo
// crear_pedido resuelve cliente/producto): una categoría mal transcripta
// por voz que se auto-crea deja basura silenciosa en el catálogo — mejor
// avisarle al usuario y que use crear_categoria explícitamente si hace
// falta una nueva.
async function resolverCategoriaPorNombre({ empresaId, nombre }) {
  if (!nombre) return null;
  const existente = await buscarMaestroExistente({ empresaId, tabla: 'categorias', nombre });
  if (!existente) throw new Error(`No existe ninguna categoría llamada "${nombre}". Se puede crear primero con "creá la categoría ${nombre}", o dejar el producto sin categoría.`);
  return existente;
}

async function resolverCrearProductoDesdeArgs({ empresaId, args }) {
  const nombre = String(args.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre del producto.');

  const nombresDepositos = Array.isArray(args.depositos) ? args.depositos : [];
  if (!nombresDepositos.length) throw new Error('Falta indicar en qué depósito(s) va el producto nuevo.');
  const depositosResueltos = await resolverDepositosPorNombre({ empresaId, nombres: nombresDepositos });

  const categoriaExistente = args.categoria ? await resolverCategoriaPorNombre({ empresaId, nombre: args.categoria }) : null;

  return {
    nombre,
    depositosResueltos,
    categoriaId: categoriaExistente?.id || null,
    categoriaNombre: categoriaExistente?.nombre || null,
    precioBase: Number(args.precio_base) || 0,
    costo: Number(args.costo) || 0,
    stockMinimo: Number(args.stock_minimo) || 0,
    codigo: args.codigo ? String(args.codigo).trim() : null,
  };
}

async function resolverEditarProductoDesdeArgs({ empresaId, args }) {
  const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });

  const cambios = {};
  const cambiosTexto = [];

  if (args.precio_base !== undefined && args.precio_base !== null) {
    cambios.precio_base = Number(args.precio_base);
    cambiosTexto.push(`precio $${cambios.precio_base.toLocaleString('es-AR')}`);
  }
  if (args.costo !== undefined && args.costo !== null) {
    cambios.costo = Number(args.costo);
    cambiosTexto.push(`costo $${cambios.costo.toLocaleString('es-AR')}`);
  }
  if (args.stock_minimo !== undefined && args.stock_minimo !== null) {
    cambios.stock_minimo = Number(args.stock_minimo);
    cambiosTexto.push(`stock mínimo ${cambios.stock_minimo}`);
  }
  if (args.categoria) {
    const categoria = await resolverCategoriaPorNombre({ empresaId, nombre: args.categoria });
    cambios.categoria_id = categoria.id;
    cambiosTexto.push(`categoría "${categoria.nombre}"`);
  }
  if (args.activo !== undefined && args.activo !== null) {
    cambios.activo = Boolean(args.activo);
    cambiosTexto.push(cambios.activo ? 'reactivarlo' : 'darlo de baja');
  }

  return { producto, cambios, cambiosTexto };
}

// Días válidos para zonas.dias_reparto: se confirmaron contra los valores
// que ya existen en la tabla real (lunes/martes/miercoles/jueves/viernes/
// sabado/domingo — en español, minúscula, sin tilde). No hay un check
// constraint a nivel DB que lo obligue, así que se valida acá antes de
// insertar para no meter un valor que el resto del sistema no reconozca.
const DIAS_REPARTO_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

function normalizarDiaReparto(dia) {
  return String(dia || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function resolverDiasReparto(dias) {
  if (!Array.isArray(dias) || !dias.length) return [];
  const normalizados = [...new Set(dias.map(normalizarDiaReparto).filter(Boolean))];
  const invalidos = normalizados.filter((d) => !DIAS_REPARTO_VALIDOS.includes(d));
  if (invalidos.length) {
    throw new Error(`Día(s) de reparto no reconocido(s): ${invalidos.join(', ')}. Usar lunes, martes, miercoles, jueves, viernes, sabado o domingo.`);
  }
  return normalizados;
}

// Resuelve la recompensa de canjear_recompensa_asistente por texto libre.
// No hay una RPC de búsqueda aproximada para recompensas (a diferencia de
// clientes/productos, ver migración 420) — el universo de recompensas por
// empresa es chico, así que un ILIKE simple alcanza; mismo criterio de
// "0 o ambiguo → pedir que aclare, nunca adivinar" que el resto del archivo.
async function buscarRecompensaPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar qué recompensa canjear.');

  const { data, error } = await db.from('recompensas')
    .select('id, nombre, puntos_requeridos, activa')
    .eq('empresa_id', empresaId)
    .eq('activa', true)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la recompensa: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna recompensa activa parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((r) => r.nombre).join(', ');
    throw new Error(`Hay más de una recompensa parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// anular_venta_pos() bajo service_role NO valida por sí sola que la venta
// pertenezca a empresaId (ver comentario en la migración 416: el chequeo de
// empresa se salta explícitamente cuando auth.role() = 'service_role',
// porque asume que quien llama con esa key ya validó tenant por su cuenta
// — como hacen el resto de los handlers HTTP). Como acá SÍ llamamos con
// service_role key, esta validación la tenemos que hacer nosotros mismos
// antes de tocar nada, igual que ya hacen diagnosticar_venta_pos/pedido/etc.
async function buscarVentaPosPropia({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim();
  if (!ref) return { error: 'Falta la referencia de la venta' };

  const { data, error } = await db.rpc('diagnosticar_venta_pos', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) return { error: `No se pudo verificar la venta: ${error.message}` };
  if (!data?.encontrado) {
    return { error: data?.ambiguo ? 'Esa referencia coincide con más de una venta, pedile al usuario el ID corto completo.' : 'No se encontró ninguna venta con esa referencia en esta empresa.' };
  }
  if (data.estado_venta === 'anulada') return { error: 'Esa venta ya está anulada.' };
  if (data.tiene_factura) return { error: 'Esa venta ya tiene una factura generada; para anularla hay que emitir una Nota de Crédito, no se puede usar esta herramienta.' };

  return {
    id: data.venta_id,
    referencia_corta: data.referencia_corta,
    cliente: data.cliente,
    total: data.total,
    estado_venta: data.estado_venta,
  };
}

// Resuelve la referencia corta/UUID de confirmar_pedido_sugerido y
// descartar_pedido_sugerido reusando diagnosticar_pedido (misma RPC que ya
// hace la búsqueda segura por empresa_id + 6 caracteres finales, ver
// migración 205) en vez de reimplementar el matching acá. Solo deja pasar
// pedidos que efectivamente estén en estado "sugerido" — confirmar o
// descartar cualquier otro estado con esta tool no tiene sentido y podría
// pisar un pedido que ya se procesó por otra vía.
async function buscarPedidoSugeridoPropio({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim();
  if (!ref) return { error: 'Falta la referencia del pedido sugerido' };

  const { data, error } = await db.rpc('diagnosticar_pedido', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) return { error: `No se pudo verificar el pedido: ${error.message}` };
  if (!data?.encontrado) {
    return { error: data?.ambiguo ? 'Esa referencia coincide con más de un pedido, pedile al usuario el ID corto completo.' : 'No se encontró ningún pedido con esa referencia en esta empresa.' };
  }
  if (data.estado_pedido !== 'sugerido') {
    return { error: `Ese pedido está en estado "${data.estado_pedido}", no "sugerido" — no se puede confirmar ni descartar con esta herramienta.` };
  }

  return {
    id: data.pedido_id,
    referencia_corta: data.referencia_corta,
    cliente: data.cliente,
    total: data.total,
  };
}

// Resuelve la referencia de modificar_pedido_no_confirmado reusando
// diagnosticar_pedido (misma RPC validada contra empresa_id + 6 caracteres
// finales que ya usan diagnosticar_pedido / buscarPedidoSugeridoPropio) en
// vez de reimplementar el matching. Solo deja pasar pedidos en 'borrador'
// (el único estado "no confirmado" en ESTADOS_VALIDOS del handler real:
// borrador/confirmado/preparando/despachado/entregado/cancelado) — un
// pedido ya confirmado no se toca con esta tool.
async function buscarPedidoBorradorPorTexto({ empresaId, texto }) {
  const ref = String(texto || '').replace('#', '').trim();
  if (!ref) throw new Error('Falta la referencia del pedido.');

  const { data, error } = await db.rpc('diagnosticar_pedido', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) throw new Error(`No se pudo verificar el pedido: ${error.message}`);
  if (!data?.encontrado) {
    throw new Error(data?.ambiguo ? 'Esa referencia coincide con más de un pedido, pedile al usuario el ID corto completo.' : 'No se encontró ningún pedido con esa referencia en esta empresa.');
  }
  if (data.estado_pedido !== 'borrador') {
    throw new Error(`Ese pedido está en estado "${data.estado_pedido}", no en borrador — ya fue confirmado y esta tool no permite tocarlo.`);
  }
  return { id: data.pedido_id, numero: data.referencia_corta, cliente_nombre: data.cliente };
}

// Resuelve un pedido por referencia SIN restricción de estado (a diferencia
// de buscarPedidoBorradorPorTexto) — usada por registrar_devolucion_pedido,
// que aplica típicamente sobre pedidos ya despachados/entregados. Reusa
// diagnosticar_pedido para el matching seguro por empresa_id, y hace un
// segundo select acotado por empresa_id para traer cliente_id real (la RPC
// solo devuelve el nombre del cliente para mostrar, no el id).
async function buscarPedidoPropioPorTexto({ empresaId, texto }) {
  const ref = String(texto || '').replace('#', '').trim();
  if (!ref) throw new Error('Falta la referencia del pedido.');

  const { data, error } = await db.rpc('diagnosticar_pedido', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) throw new Error(`No se pudo verificar el pedido: ${error.message}`);
  if (!data?.encontrado) {
    throw new Error(data?.ambiguo ? 'Esa referencia coincide con más de un pedido, pedile al usuario el ID corto completo.' : 'No se encontró ningún pedido con esa referencia en esta empresa.');
  }

  const { data: pedidoRow, error: errPedido } = await db.from('pedidos')
    .select('id, cliente_id')
    .eq('id', data.pedido_id)
    .eq('empresa_id', empresaId)
    .single();
  if (errPedido) throw new Error(`No se pudo verificar el pedido: ${errPedido.message}`);
  if (!pedidoRow.cliente_id) throw new Error('Ese pedido no tiene un cliente asociado; no se puede registrar la devolución.');

  return { id: pedidoRow.id, cliente_id: pedidoRow.cliente_id, referencia_corta: data.referencia_corta, cliente_nombre: data.cliente };
}

// Resuelve y valida el pedido a cancelar. Reusa diagnosticar_pedido, que
// YA trae estado_pedido + factura_estado/numero en una sola llamada — no
// hace falta una consulta aparte para saber si hay una factura con CAE de
// por medio (necesario para el aviso de Nota de Crédito en el resumen).
// Rechaza 'entregado'/'cancelado', mismo criterio que la rama DELETE real.
async function diagnosticoPedidoParaCancelar({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim();
  if (!ref) throw new Error('Falta la referencia del pedido.');

  const { data, error } = await db.rpc('diagnosticar_pedido', {
    p_empresa_id: empresaId,
    p_referencia: ref,
  });
  if (error) throw new Error(`No se pudo verificar el pedido: ${error.message}`);
  if (!data?.encontrado) {
    throw new Error(data?.ambiguo ? 'Esa referencia coincide con más de un pedido, pedile al usuario el ID corto completo.' : 'No se encontró ningún pedido con esa referencia en esta empresa.');
  }
  if (['entregado', 'cancelado'].includes(data.estado_pedido)) {
    throw new Error(`No se puede cancelar un pedido ${data.estado_pedido}.`);
  }
  return data;
}

// Motivos válidos de `devoluciones.motivo` (check constraint real, se
// confirmó contra el schema antes de escribir esto — coincide con
// MOTIVOS_VALIDOS de crearDevolucionCore).
const MOTIVOS_DEVOLUCION_VALIDOS = ['producto_defectuoso', 'error_pedido', 'cliente_arrepentido', 'vencido', 'otro'];

// Resuelve TODO lo que necesita registrar_devolucion_pedido (pedido +
// motivo + cada item) a partir de los args de texto libre — se llama por
// separado desde resumen() y execute(), mismo criterio que
// resolverPedidoDesdeArgs/resolverTransferenciaStock: nunca se reusa un id
// resuelto entre la propuesta y la confirmación.
async function resolverDevolucionPedido({ empresaId, args }) {
  const motivo = String(args.motivo || '').trim();
  if (!MOTIVOS_DEVOLUCION_VALIDOS.includes(motivo)) {
    throw new Error(`Motivo inválido: "${motivo}". Debe ser uno de: ${MOTIVOS_DEVOLUCION_VALIDOS.join(', ')}.`);
  }

  const pedido = await buscarPedidoPropioPorTexto({ empresaId, texto: args.pedido });

  const itemsArg = Array.isArray(args.items) ? args.items : [];
  if (!itemsArg.length) throw new Error('La devolución necesita al menos un producto con su cantidad.');

  const itemsResueltos = [];
  for (const item of itemsArg) {
    const cantidad = Number(item.cantidad);
    if (!cantidad || cantidad <= 0) throw new Error(`Cantidad inválida para "${item.producto}".`);
    const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
    itemsResueltos.push({ id: producto.id, nombre: producto.nombre, cantidad, precio_unitario: Number(item.precio_unitario) || 0 });
  }

  return { pedido, motivo, itemsResueltos };
}

// Resuelve la referencia corta (últimos 6 caracteres del UUID, como en
// anular_venta_pos) de un movimiento bancario. No existe una RPC
// diagnosticar_movimiento_bancario, así que se filtra en JS contra los
// movimientos de ESTA empresa nada más — nunca se compara la referencia
// contra otra empresa. `estadoRequerido` deja usar el mismo helper tanto
// para conciliar (requiere 'pendiente') como para deshacer (requiere
// 'conciliado'), cada uno con su propio mensaje de error si no matchea.
async function buscarMovimientoBancarioPorReferencia({ empresaId, referencia, estadoRequerido = 'pendiente' }) {
  const ref = String(referencia || '').replace('#', '').trim().toUpperCase();
  if (!ref) throw new Error('Falta la referencia del movimiento bancario.');

  const { data, error } = await db.from('conciliacion_bancaria_movimientos')
    .select('id, fecha, descripcion, monto, tipo, estado')
    .eq('empresa_id', empresaId)
    .eq('estado', estadoRequerido);
  if (error) throw new Error(`No se pudo buscar el movimiento: ${error.message}`);

  const candidatos = (data || []).filter((m) => m.id.toUpperCase() === ref || m.id.slice(-6).toUpperCase() === ref);
  if (!candidatos.length) {
    throw new Error(
      estadoRequerido === 'pendiente'
        ? `No encontré ningún movimiento pendiente con la referencia "${ref}". Puede que ya esté conciliado, o que la referencia esté mal — pedile al usuario que confirme los 6 caracteres.`
        : `No encontré ningún movimiento conciliado con la referencia "${ref}".`,
    );
  }
  if (candidatos.length > 1) throw new Error(`Esa referencia coincide con más de un movimiento. Pedile al usuario el UUID completo.`);
  return candidatos[0];
}

// Corre conciliacion_buscar_candidatos y devuelve los candidatos crudos
// (con cobro_id real, uuid completo) — nunca se expone el uuid completo
// al modelo (ver los .slice(-6) en las tools), solo se usa acá adentro
// para el matching de resolverMatchConciliacion.
async function buscarCandidatosDeMovimiento({ empresaId, movimientoId }) {
  const { data, error } = await db.rpc('conciliacion_buscar_candidatos', {
    p_movimiento_id: movimientoId,
    p_empresa_id: empresaId,
  });
  if (error) throw new Error(`No se pudieron buscar candidatos: ${error.message}`);
  return data || [];
}

// Resuelve confirmar_conciliacion_bancaria de punta a punta: movimiento +
// candidato de cobro, EXIGIENDO que el cobro siga figurando entre los
// candidatos vigentes de conciliacion_buscar_candidatos para ese
// movimiento en este mismo instante — así nunca se concilia un cobro que
// el modelo (o el usuario) tipeó de una referencia vieja/de otra consulta
// que ya no aplica.
async function resolverMatchConciliacion({ empresaId, args }) {
  const movimiento = await buscarMovimientoBancarioPorReferencia({ empresaId, referencia: args.referencia_movimiento });
  const refCobro = String(args.referencia_cobro || '').replace('#', '').trim().toUpperCase();
  if (!refCobro) throw new Error('Falta la referencia del cobro a conciliar.');

  const candidatos = await buscarCandidatosDeMovimiento({ empresaId, movimientoId: movimiento.id });
  const candidato = candidatos.find((c) => c.cobro_id.slice(-6).toUpperCase() === refCobro);
  if (!candidato) {
    throw new Error(`El cobro "${refCobro}" ya no es un candidato vigente para este movimiento. Volvé a llamar consultar_candidatos_conciliacion y elegí uno de la lista actual.`);
  }
  return {
    movimiento: { id: movimiento.id, fecha: movimiento.fecha, descripcion: movimiento.descripcion, monto: movimiento.monto },
    candidato,
  };
}

// Resuelve conciliar_lote_automatico por texto libre: primero intenta
// contra el ID corto (6 caracteres, mismo criterio que movimientos), y si
// no matchea nada prueba un ILIKE parcial contra nombre_archivo (el único
// dato "humano" que tiene un lote — no hay una RPC de búsqueda aproximada
// para lotes). Ambigüedad en cualquiera de los dos casos → error pidiendo
// precisar, nunca se adivina cuál.
async function buscarLoteConciliacionPorReferencia({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim();
  if (!ref) throw new Error('Falta indicar qué lote de conciliación bancaria.');
  const refUpper = ref.toUpperCase();

  const { data, error } = await db.from('conciliacion_bancaria_lotes')
    .select('id, nombre_archivo, cantidad_movimientos, cantidad_conciliados, created_at')
    .eq('empresa_id', empresaId);
  if (error) throw new Error(`No se pudo buscar el lote: ${error.message}`);

  const porId = (data || []).filter((l) => l.id.toUpperCase() === refUpper || l.id.slice(-6).toUpperCase() === refUpper);
  if (porId.length === 1) return porId[0];
  if (porId.length > 1) throw new Error(`Esa referencia coincide con más de un lote. Pedile al usuario el UUID completo.`);

  const porNombre = (data || []).filter((l) => (l.nombre_archivo || '').toLowerCase().includes(ref.toLowerCase()));
  if (porNombre.length === 1) return porNombre[0];
  if (porNombre.length > 1) {
    const nombres = porNombre.slice(0, 5).map((l) => l.nombre_archivo).join(', ');
    throw new Error(`Hay más de un lote parecido a "${ref}" (${nombres}). Pedile al usuario que precise cuál, o el ID corto de 6 caracteres.`);
  }
  throw new Error(`No encontré ningún lote de conciliación bancaria parecido a "${ref}". Pedile al usuario el nombre del archivo importado, o el ID corto (ver listar_lotes_conciliacion_bancaria).`);
}

// Mismos defaults que conciliacion_auto_matchear_lote (1 día, $0.50) —
// intencionalmente más estrictos que los de conciliacion_buscar_candidatos
// (3 días, $1) porque acá no hay revisión humana antes de conciliar.
function resolverToleranciasAutoMatch(args) {
  const toleranciaDias = Number(args.tolerancia_dias) > 0 ? Number(args.tolerancia_dias) : 1;
  const toleranciaMonto = Number(args.tolerancia_monto) >= 0 ? Number(args.tolerancia_monto) : 0.5;
  return { toleranciaDias, toleranciaMonto };
}

// Dry-run del resumen de conciliar_lote_automatico: cuenta, de los
// movimientos pendientes del lote, cuántos tienen exactamente 1 candidato
// con las tolerancias dadas (que es justo el criterio que usa la RPC real
// para decidir a cuáles les entra sola) — así el resumen que ve el usuario
// antes de confirmar coincide con lo que realmente va a pasar.
async function contarMatchesAutomaticosLote({ empresaId, loteId, toleranciaDias, toleranciaMonto }) {
  const { data, error } = await db.from('conciliacion_bancaria_movimientos')
    .select('id')
    .eq('empresa_id', empresaId)
    .eq('lote_id', loteId)
    .eq('estado', 'pendiente');
  if (error) throw new Error(`No se pudo revisar el lote: ${error.message}`);

  const pendientes = data || [];
  let conUnico = 0;
  for (const m of pendientes) {
    const { data: candidatos, error: errorCand } = await db.rpc('conciliacion_buscar_candidatos', {
      p_movimiento_id: m.id,
      p_empresa_id: empresaId,
      p_tolerancia_dias: toleranciaDias,
      p_tolerancia_monto: toleranciaMonto,
    });
    if (errorCand) throw new Error(`No se pudieron revisar candidatos del lote: ${errorCand.message}`);
    if ((candidatos || []).length === 1) conUnico += 1;
  }
  return { totalPendientes: pendientes.length, conUnico };
}

// Mismo criterio de resolución que usa la RPC real consultar_deuda_proveedor
// (ILIKE contra razon_social y nombre_fantasia) — se leyó su
// pg_get_functiondef() antes de escribir esto para no usar un criterio de
// matching distinto entre las dos tools de proveedor. No hay una RPC de
// búsqueda aproximada (pg_trgm) para proveedores como sí hay para
// clientes/productos, así que un ILIKE simple alcanza (universo chico).
async function buscarProveedorPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar de qué proveedor.');

  const { data, error } = await db.from('proveedores')
    .select('id, razon_social, nombre_fantasia, activo')
    .eq('empresa_id', empresaId)
    .or(`razon_social.ilike.%${t}%,nombre_fantasia.ilike.%${t}%`);
  if (error) throw new Error(`No se pudo buscar el proveedor: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ningún proveedor parecido a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((p) => p.nombre_fantasia || p.razon_social).join(', ');
    throw new Error(`Hay más de un proveedor parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return { id: data[0].id, nombre: data[0].nombre_fantasia || data[0].razon_social };
}

// Réplica mínima de fetchBcra() de lib/handlers/bcra.js — ese archivo solo
// exporta el handler default, no la función interna, así que se reimplementa
// acá (mismo timeout, mismo manejo de 404 = "sin registros" en vez de
// error). Mismo BASE URL, sin API key (API pública gratuita del BCRA).
const BCRA_BASE = 'https://api.bcra.gob.ar';
const BCRA_TIMEOUT_MS = 8000;

async function fetchBcraDirecto(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BCRA_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BCRA_BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (resp.status === 404) return { notFound: true };
    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      throw new Error(`BCRA respondió ${resp.status}${texto ? `: ${texto.slice(0, 200)}` : ''}`);
    }
    const json = await resp.json();
    return { data: json };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('BCRA no respondió a tiempo (timeout).');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Resuelve el CUIT a consultar en BCRA: directo si lo dieron, o buscando
// por nombre en clientes/proveedores de ESTA empresa (nunca se compara
// contra otra empresa). A diferencia de buscarClientePorTexto/
// buscarProveedorPorTexto (pensados para acciones sobre ESE registro), acá
// solo hace falta el CUIT, así que se resuelve con una consulta propia en
// vez de reusar esos helpers (que no traen la columna cuit).
async function resolverCuitParaBcra({ empresaId, args }) {
  const cuitDirecto = String(args.cuit || '').replace(/\D/g, '');
  if (cuitDirecto) {
    if (cuitDirecto.length !== 11) throw new Error('El CUIT/CUIL debe tener 11 dígitos.');
    return cuitDirecto;
  }

  if (args.cliente) {
    const t = String(args.cliente).trim();
    const { data, error } = await db.from('clientes')
      .select('id, razon_social, nombre_fantasia, cuit')
      .eq('empresa_id', empresaId)
      .or(`razon_social.ilike.%${t}%,nombre_fantasia.ilike.%${t}%`);
    if (error) throw new Error(`No se pudo buscar el cliente: ${error.message}`);
    if (!data?.length) throw new Error(`No encontré ningún cliente parecido a "${t}".`);
    if (data.length > 1) throw new Error(`Hay más de un cliente parecido a "${t}". Pedile al usuario que precise cuál.`);
    if (!data[0].cuit) throw new Error(`El cliente "${t}" no tiene CUIT cargado.`);
    return String(data[0].cuit).replace(/\D/g, '');
  }

  if (args.proveedor) {
    const t = String(args.proveedor).trim();
    const { data, error } = await db.from('proveedores')
      .select('id, razon_social, nombre_fantasia, cuit')
      .eq('empresa_id', empresaId)
      .or(`razon_social.ilike.%${t}%,nombre_fantasia.ilike.%${t}%`);
    if (error) throw new Error(`No se pudo buscar el proveedor: ${error.message}`);
    if (!data?.length) throw new Error(`No encontré ningún proveedor parecido a "${t}".`);
    if (data.length > 1) throw new Error(`Hay más de un proveedor parecido a "${t}". Pedile al usuario que precise cuál.`);
    if (!data[0].cuit) throw new Error(`El proveedor "${t}" no tiene CUIT cargado.`);
    return String(data[0].cuit).replace(/\D/g, '');
  }

  throw new Error('Falta el CUIT, o el nombre de un cliente/proveedor para resolverlo.');
}

// Dedupe de crear_proveedor: sin unique constraint a nivel DB ni en
// razon_social ni en cuit (se verificó contra el schema real), así que el
// chequeo se hace acá — primero por CUIT exacto si lo dieron (es el
// identificador real del negocio y puede repetirse con razón social
// ligeramente distinta), y si no por ILIKE exacto de razón social dentro
// de la misma empresa. A diferencia de buscarProveedorPorTexto (que
// resuelve un proveedor existente para lectura), acá un resultado ambiguo
// no es error: alcanza con saber si ya existe alguno para no duplicar.
async function buscarProveedorExistente({ empresaId, razonSocial, cuit }) {
  const cuitLimpio = String(cuit || '').trim();
  if (cuitLimpio) {
    const { data, error } = await db.from('proveedores')
      .select('id, razon_social, nombre_fantasia')
      .eq('empresa_id', empresaId)
      .eq('cuit', cuitLimpio)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`No se pudo verificar proveedores existentes: ${error.message}`);
    if (data) return { id: data.id, nombre: data.nombre_fantasia || data.razon_social, motivo: 'cuit' };
  }
  const { data, error } = await db.from('proveedores')
    .select('id, razon_social, nombre_fantasia')
    .eq('empresa_id', empresaId)
    .ilike('razon_social', razonSocial)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo verificar proveedores existentes: ${error.message}`);
  if (data) return { id: data.id, nombre: data.nombre_fantasia || data.razon_social, motivo: 'razon_social' };
  return null;
}

// Dedupe de crear_cliente: mismo criterio que buscarProveedorExistente
// (arriba), contra la tabla `clientes` — CUIT exacto primero si lo dieron,
// si no ILIKE exacto de razón social dentro de la misma empresa. No usa
// buscarClientePorTexto() (la de más arriba, para resolver un cliente
// existente en crear_pedido) porque esa tira error si hay ambigüedad —
// acá un resultado ambiguo no es error: alcanza con saber si ya existe
// alguno para no duplicar.
async function buscarClienteExistente({ empresaId, razonSocial, cuit }) {
  const cuitLimpio = String(cuit || '').trim();
  if (cuitLimpio) {
    const { data, error } = await db.from('clientes')
      .select('id, razon_social, nombre_fantasia')
      .eq('empresa_id', empresaId)
      .eq('cuit', cuitLimpio)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`No se pudo verificar clientes existentes: ${error.message}`);
    if (data) return { id: data.id, nombre: data.nombre_fantasia || data.razon_social, motivo: 'cuit' };
  }
  const { data, error } = await db.from('clientes')
    .select('id, razon_social, nombre_fantasia')
    .eq('empresa_id', empresaId)
    .ilike('razon_social', razonSocial)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo verificar clientes existentes: ${error.message}`);
  if (data) return { id: data.id, nombre: data.nombre_fantasia || data.razon_social, motivo: 'razon_social' };
  return null;
}

// Fase B — helper de editar_cliente_asistente: arma el objeto `cambios`
// para actualizarClienteRepo() y un resumen legible en español para
// resumen(), a partir de los args que mandó el modelo. Solo entran los
// campos que el usuario efectivamente pidió cambiar (undefined/null/''
// se ignoran) — mismo criterio de "solo lo que se pidió" que el resto de
// las tools de edición parcial del archivo.
const CAMPOS_CLIENTE_EDITABLES = [
  ['razon_social', 'razón social'],
  ['nombre_fantasia', 'nombre de fantasía'],
  ['cuit', 'CUIT'],
  ['condicion_iva', 'condición de IVA'],
  ['telefono', 'teléfono'],
  ['email', 'email'],
  ['domicilio', 'domicilio'],
  ['localidad', 'localidad'],
  ['notas', 'notas'],
];

function construirCambiosCliente(args) {
  const cambios = {};
  const resumenCambios = [];
  for (const [campo, label] of CAMPOS_CLIENTE_EDITABLES) {
    const valor = args[campo];
    const v = typeof valor === 'string' ? valor.trim() : valor;
    if (v === undefined || v === null || v === '') continue;
    cambios[campo] = v;
    resumenCambios.push(`${label}: "${v}"`);
  }
  if (args.reactivar === true) {
    cambios.activo = true;
    resumenCambios.push('reactivar (vuelve a estar activo)');
  }
  return { cambios, resumenCambios };
}

// Resuelve un depósito por texto libre dentro de la empresa. Igual criterio
// que buscarProveedorPorTexto/buscarRecompensaPorTexto: universo chico por
// empresa (se vio en datos reales: 2-3 depósitos), no hay RPC de búsqueda
// aproximada para depósitos, así que ILIKE simple alcanza; 0 o ambiguo →
// error concreto, nunca adivinar.
async function buscarDepositoPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar el depósito.');

  const { data, error } = await db.from('depositos')
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar el depósito: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ningún depósito parecido a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((d) => d.nombre).join(', ');
    throw new Error(`Hay más de un depósito parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// Resuelve TODO lo que necesita transferir_stock_asistente: producto +
// depósito origen + depósito destino + cantidad. Se llama por separado
// desde resumen() y desde execute() (nunca se reusa un id resuelto entre
// la propuesta y la confirmación — mismo criterio que resolverPedidoDesdeArgs).
// La RPC transferir_stock() ya rechaza origen==destino y valida que ambos
// depósitos sean de la MISMA empresa entre sí, pero no valida que sean de
// ESTA empresa cuando se llama con service_role (ver comentario arriba de
// la tool) — por eso acá se resuelven ambos depósitos con
// buscarDepositoPorTexto, que ya filtra por empresaId.
async function resolverTransferenciaStock({ empresaId, args }) {
  const cantidad = Number(args.cantidad);
  if (!cantidad || cantidad <= 0) throw new Error('La cantidad a transferir debe ser mayor a cero.');

  const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
  const depOrigen = await buscarDepositoPorTexto({ empresaId, texto: args.deposito_origen });
  const depDestino = await buscarDepositoPorTexto({ empresaId, texto: args.deposito_destino });

  if (depOrigen.id === depDestino.id) {
    throw new Error('El depósito de origen y destino no pueden ser el mismo.');
  }
  return { producto, depOrigen, depDestino, cantidad };
}

// Resuelve ajustar_stock_asistente: mismo patrón que resolverTransferenciaStock
// (producto + depósito por texto libre, cantidad > 0), pero de un solo
// depósito. El motivo ya viene validado por el enum del JSON Schema de la
// tool, así que acá solo se lo devuelve tal cual para que resumen()/execute()
// decidan la rama (producir_con_insumos vs ajustar_stock).
async function resolverAjusteStock({ empresaId, args }) {
  const cantidad = Number(args.cantidad);
  if (!cantidad || cantidad <= 0) throw new Error('La cantidad debe ser mayor a cero.');

  const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
  const deposito = await buscarDepositoPorTexto({ empresaId, texto: args.deposito });
  const motivo = args.motivo || 'ajuste_manual';

  return { producto, deposito, cantidad, motivo };
}

// Resuelve registrar_conteo_stock_asistente: producto + depósito por texto
// libre, cantidad_contada >= 0 (0 es válido — "contamos que no queda nada").
async function resolverConteoStock({ empresaId, args }) {
  const cantidadContada = Number(args.cantidad_contada);
  if (args.cantidad_contada === undefined || args.cantidad_contada === null || Number.isNaN(cantidadContada) || cantidadContada < 0) {
    throw new Error('La cantidad contada debe ser un número mayor o igual a cero.');
  }

  const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
  const deposito = await buscarDepositoPorTexto({ empresaId, texto: args.deposito });

  return { producto, deposito, cantidadContada };
}

// Resuelve crear_orden_compra_asistente: proveedor por texto libre (reusa
// buscarProveedorPorTexto, ya existente para otra tool) + cada item de la
// lista resuelto contra buscar_productos_asistente (mismo criterio de
// "un candidato claro o preguntar" que el resto del asistente — nunca se le
// confía al modelo un producto_id).
async function resolverOrdenCompraDesdeArgs({ empresaId, args }) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length) throw new Error('La orden de compra necesita al menos un producto.');

  const proveedor = await buscarProveedorPorTexto({ empresaId, texto: args.proveedor });

  const itemsResueltos = [];
  for (const item of items) {
    const cantidad = Number(item.cantidad);
    if (!cantidad || cantidad <= 0) throw new Error(`La cantidad de "${item.producto}" debe ser mayor a cero.`);
    const precioCosto = Number(item.precio_costo);
    if (!precioCosto || precioCosto <= 0) throw new Error(`El precio de costo de "${item.producto}" debe ser mayor a cero.`);

    const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
    itemsResueltos.push({
      producto_id: producto.id,
      nombre: producto.nombre,
      cantidad,
      precio_costo: precioCosto,
    });
  }

  return { proveedor, itemsResueltos };
}

// Resuelve recepcionar_orden_compra_asistente: busca la OC por número
// (ilike, dentro de la empresa), el depósito destino opcional, y arma la
// lista de renglones a recepcionar — o bien lo que el usuario puntualizó
// (validado contra los renglones reales de la orden, para no aceptar un
// producto que la OC no tiene), o bien TODO lo pendiente
// (cantidad - cantidad_recibida de cada renglón) si no dio nada.
async function resolverRecepcionOrdenCompra({ empresaId, args }) {
  const numero = String(args.numero_oc || '').trim();
  if (!numero) throw new Error('Falta indicar el número de la orden de compra.');

  const { data: ordenes, error } = await db.from('ordenes_compra')
    .select('id, numero, estado, proveedor_id')
    .eq('empresa_id', empresaId)
    .ilike('numero', `%${numero}%`)
    .order('created_at', { ascending: false })
    .limit(6);
  if (error) throw new Error(`No se pudo buscar la orden de compra: ${error.message}`);
  if (!ordenes?.length) throw new Error(`No encontré ninguna orden de compra con número "${numero}".`);
  if (ordenes.length > 1) {
    const numeros = ordenes.map((o) => o.numero).join(', ');
    throw new Error(`Hay más de una orden de compra parecida a "${numero}" (${numeros}). Pedile al usuario el número exacto.`);
  }
  const orden = ordenes[0];

  if (orden.estado === 'cancelada') throw new Error(`La orden ${orden.numero} está cancelada, no se puede recepcionar.`);
  if (orden.estado === 'recibida') throw new Error(`La orden ${orden.numero} ya fue recibida por completo.`);

  const deposito = args.deposito ? await buscarDepositoPorTexto({ empresaId, texto: args.deposito }) : null;

  const { data: renglones, error: errItems } = await db.from('ordenes_compra_items')
    .select('producto_id, descripcion, cantidad, cantidad_recibida, precio_costo, productos(nombre)')
    .eq('orden_compra_id', orden.id);
  if (errItems) throw new Error(`No se pudo leer los renglones de la orden: ${errItems.message}`);

  const argItems = Array.isArray(args.items) ? args.items : [];
  let itemsAReceptionar;

  if (argItems.length) {
    itemsAReceptionar = [];
    for (const item of argItems) {
      const cantidadRecibida = Number(item.cantidad_recibida);
      if (!cantidadRecibida || cantidadRecibida <= 0) {
        throw new Error(`La cantidad recibida de "${item.producto}" debe ser mayor a cero.`);
      }
      const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
      const renglon = (renglones || []).find((r) => r.producto_id === producto.id);
      if (!renglon) {
        throw new Error(`"${producto.nombre}" no está en la orden ${orden.numero}.`);
      }
      itemsAReceptionar.push({
        producto_id: producto.id,
        nombre: producto.nombre,
        cantidad_recibida: cantidadRecibida,
        precio_costo: Number(renglon.precio_costo) || 0,
      });
    }
  } else {
    itemsAReceptionar = (renglones || [])
      .map((r) => ({
        producto_id: r.producto_id,
        nombre: r.productos?.nombre || r.descripcion || 'producto',
        cantidad_recibida: Number(r.cantidad) - Number(r.cantidad_recibida || 0),
        precio_costo: Number(r.precio_costo) || 0,
      }))
      .filter((r) => r.producto_id && r.cantidad_recibida > 0);
  }

  return { orden, deposito, itemsAReceptionar };
}

// Whitelist estricta de columnas de notif_prefs_auto que se pueden tocar
// desde el asistente: aunque `preferencia` ya viene acotado por el enum
// del JSON Schema, esto es la última barrera antes de armar el objeto de
// un `.update()` — nunca se interpola el nombre de columna de otra forma.
const COLUMNAS_PREFS_NOTIF = [
  'piloto_sugerencia', 'cierre_cliente_bloqueado', 'cierre_error_cola', 'stock_quiebre',
  'stock_orden_auto', 'score_caida_critica', 'auditoria_anomalia', 'migracion_sesion_error',
  'stock_sin_proveedor', 'rentabilidad_zona_semanal',
];

function validarColumnaPreferenciaNotificacion(preferencia) {
  if (!COLUMNAS_PREFS_NOTIF.includes(preferencia)) {
    throw new Error(`Preferencia de notificación no reconocida: "${preferencia}".`);
  }
  return preferencia;
}

async function obtenerPreferenciaNotificacionActual({ empresaId, preferencia }) {
  const columna = validarColumnaPreferenciaNotificacion(preferencia);
  const { data, error } = await db.from('notif_prefs_auto')
    .select(columna)
    .eq('empresa_id', empresaId)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer la preferencia actual: ${error.message}`);
  if (!data) throw new Error('Esta empresa todavía no tiene preferencias de notificaciones configuradas.');
  return Boolean(data[columna]);
}

// Umbral y margen para decidir si el mejor resultado de una búsqueda
// aproximada (ver buscar_clientes_asistente/buscar_productos_asistente,
// migración 420, con pg_trgm) es lo bastante claro como para elegirlo
// solo, sin pedirle al usuario que desambigüe. Pensado para el margen de
// error típico de transcribir por voz un nombre — "suena parecido" no
// siempre coincide letra por letra — sin por eso arriesgarse a adivinar
// mal a qué cliente o producto se refería si hay dos opciones parecidas
// entre sí (ahí sí conviene preguntar, nunca tirar una moneda).
const SIMILITUD_MINIMA_AUTOELEGIR = 0.35;
const MARGEN_MINIMO_SOBRE_SIGUIENTE = 0.15;

// candidatos ya viene ordenado por similitud DESC (así lo devuelven las
// funciones de la migración 420). Devuelve el candidato a usar sin
// preguntar, o null si hace falta desambiguar con el usuario.
function elegirMejorCandidato(candidatos) {
  if (candidatos.length === 1) return candidatos[0];
  const [mejor, segundo] = candidatos;
  const mejorSimilitud = mejor.similitud ?? 1; // 1 = vino de un ILIKE exacto sin similarity() de por medio
  const segundaSimilitud = segundo?.similitud ?? 0;
  const esClaro = mejorSimilitud >= SIMILITUD_MINIMA_AUTOELEGIR && (mejorSimilitud - segundaSimilitud) >= MARGEN_MINIMO_SOBRE_SIGUIENTE;
  return esClaro ? mejor : null;
}

async function buscarCandidatosAsistente({ rpc, empresaId, texto }) {
  const { data, error } = await db.rpc(rpc, { p_empresa_id: empresaId, p_texto: texto, p_limite: 6 });
  if (error) throw new Error(`No se pudo buscar: ${error.message}`);
  return data || [];
}

// Resuelve el cliente de `crear_pedido` a partir del texto libre que dio el
// usuario (nombre, razón social, CUIT, teléfono, o una versión mal
// transcripta por voz de cualquiera de esos). Nunca se le confía al modelo
// un cliente_id: si no hay ningún candidato, o hay más de uno y ninguno se
// destaca con claridad (ver elegirMejorCandidato), se tira una excepción
// con una pregunta concreta para que el modelo se la repita al usuario en
// vez de adivinar.
async function buscarClientePorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar a qué cliente es el pedido.');

  const candidatos = await buscarCandidatosAsistente({ rpc: 'buscar_clientes_asistente', empresaId, texto: t });
  if (!candidatos.length) throw new Error(`No encontré ningún cliente parecido a "${t}". Pedile al usuario el nombre, el CUIT o el teléfono.`);

  const elegido = elegirMejorCandidato(candidatos);
  if (!elegido) {
    const nombres = candidatos.slice(0, 5).map((c) => c.razon_social).join(', ');
    throw new Error(`Hay más de un cliente parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál, con el nombre completo o el CUIT.`);
  }
  if (!elegido.activo) throw new Error(`El cliente "${elegido.razon_social}" está inactivo, no se le pueden cargar pedidos.`);
  return elegido;
}

// Misma búsqueda aproximada que buscarClientePorTexto (mismo RPC, mismo
// criterio de "un candidato claro o preguntar"), pero SIN el bloqueo por
// `activo` — a diferencia de crear_pedido, cobrar una deuda vieja de un
// cliente que después se dio de baja es un caso válido (es, de hecho, la
// razón más común para terminar de cobrarle a alguien inactivo).
async function buscarClienteParaCobroPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar a qué cliente es el cobro.');

  const candidatos = await buscarCandidatosAsistente({ rpc: 'buscar_clientes_asistente', empresaId, texto: t });
  if (!candidatos.length) throw new Error(`No encontré ningún cliente parecido a "${t}". Pedile al usuario el nombre, el CUIT o el teléfono.`);

  const elegido = elegirMejorCandidato(candidatos);
  if (!elegido) {
    const nombres = candidatos.slice(0, 5).map((c) => c.razon_social).join(', ');
    throw new Error(`Hay más de un cliente parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál, con el nombre completo o el CUIT.`);
  }
  return elegido;
}

const MEDIOS_COBRO_TEXTO = {
  efectivo: 'efectivo',
  transferencia: 'transferencia',
  cheque: 'cheque',
  otro: 'otro medio',
};

// Resuelve un único item de `crear_pedido` (nombre de producto en texto
// libre + cantidad) a un producto_id real. Mismo criterio que
// buscarClientePorTexto: 0 candidatos, o varios sin uno que se destaque
// con claridad, es una excepción con pregunta concreta, nunca una
// adivinanza.
async function buscarProductoPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta el nombre de un producto en el pedido.');

  const candidatos = await buscarCandidatosAsistente({ rpc: 'buscar_productos_asistente', empresaId, texto: t });
  if (!candidatos.length) throw new Error(`No encontré ningún producto parecido a "${t}". Pedile al usuario que aclare el nombre.`);

  const elegido = elegirMejorCandidato(candidatos);
  if (!elegido) {
    const nombres = candidatos.slice(0, 5).map((p) => p.nombre).join(', ');
    throw new Error(`Hay más de un producto parecido a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return elegido;
}

// Fase B del plan (crear/editar regla de precio y de automatización): a
// diferencia de resolverCategoriaPorNombre (match exacto, pensado para
// "creá la categoría X" donde el usuario dicta el nombre tal cual), acá
// se necesita resolver por texto parcial dictado ("la de zona norte"),
// mismo patrón ilike %texto% que buscarDepositoPorTexto/buscarProveedorPorTexto.
async function buscarCategoriaPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const { data, error } = await db.from('categorias')
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la categoría: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna categoría parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((c) => c.nombre).join(', ');
    throw new Error(`Hay más de una categoría parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

async function buscarZonaPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const { data, error } = await db.from('zonas')
    .select('id, nombre')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la zona: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna zona parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((z) => z.nombre).join(', ');
    throw new Error(`Hay más de una zona parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// reglas_precio/reglas_automatizacion no tienen búsqueda aproximada por
// pg_trgm (son tablas de configuración chicas, cargadas a mano — mismo
// perfil que categorías/depósitos/zonas), así que se resuelve por nombre
// con el mismo criterio ilike %texto% que el resto de los "buscarXPorTexto"
// de este archivo, en vez de reusar buscarMaestroExistente (que exige
// coincidencia exacta y está pensado para dedupe al crear, no para ubicar
// una regla existente por su nombre dictado parcialmente).
async function buscarReglaPrecioPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar el nombre de la regla de precio.');
  const { data, error } = await db.from('reglas_precio')
    .select('id, nombre, producto_id, categoria_id, zona_id, activa')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la regla de precio: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna regla de precio parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((r) => r.nombre).join(', ');
    throw new Error(`Hay más de una regla de precio parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// Arma los campos completos para crearReglaPrecio a partir de los args de
// crear_regla_precio_asistente. Resuelve producto/categoria/zona por texto
// libre (nunca por id — el modelo solo dicta nombres) y replica acá las
// mismas validaciones que validarCampos() del repo (reglas-precio.js) para
// poder devolver un error claro ANTES de llamar al repo, ya que resumen()
// necesita los campos armados (incluidos los nombres resueltos) para poder
// describir la regla sin tocar la base.
async function armarCamposReglaPrecio({ empresaId, args }) {
  const nombre = String(args.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre de la regla de precio.');
  if (!['porcentaje', 'precio_fijo'].includes(args.tipo_descuento)) {
    throw new Error('El tipo de descuento debe ser "porcentaje" o "precio_fijo".');
  }
  const valor = Number(args.valor);
  if (!Number.isFinite(valor) || valor < 0) {
    throw new Error('El valor del descuento es inválido.');
  }
  if (args.tipo_descuento === 'porcentaje' && valor > 100) {
    throw new Error('Un descuento porcentual no puede superar el 100%.');
  }
  if (args.producto && args.categoria) {
    throw new Error('Elegí producto o categoría para la regla, no las dos a la vez.');
  }
  if (args.fecha_desde && args.fecha_hasta && args.fecha_desde > args.fecha_hasta) {
    throw new Error('La fecha "desde" no puede ser posterior a la fecha "hasta".');
  }

  let producto_id = null, categoria_id = null, zona_id = null;
  let productoNombre = null, categoriaNombre = null, zonaNombre = null;

  if (args.producto) {
    const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
    producto_id = producto.id;
    productoNombre = producto.nombre;
  }
  if (args.categoria) {
    const categoria = await buscarCategoriaPorTexto({ empresaId, texto: args.categoria });
    categoria_id = categoria.id;
    categoriaNombre = categoria.nombre;
  }
  if (args.zona) {
    const zona = await buscarZonaPorTexto({ empresaId, texto: args.zona });
    zona_id = zona.id;
    zonaNombre = zona.nombre;
  }

  return {
    nombre,
    producto_id,
    categoria_id,
    zona_id,
    cantidad_minima: args.cantidad_minima !== undefined ? Number(args.cantidad_minima) : 1,
    tipo_descuento: args.tipo_descuento,
    valor,
    fecha_desde: args.fecha_desde || null,
    fecha_hasta: args.fecha_hasta || null,
    prioridad: args.prioridad !== undefined ? Number(args.prioridad) : 0,
    activa: true,
    // Nombres resueltos, solo para describirReglaPrecio(): crearReglaPrecio
    // destructura explícito los campos que le sirven e ignora el resto, así
    // que llevar estos tres de más en el mismo objeto es inofensivo.
    productoNombre,
    categoriaNombre,
    zonaNombre,
  };
}

function describirReglaPrecio(campos) {
  const alcance = campos.productoNombre
    ? `para el producto "${campos.productoNombre}"`
    : campos.categoriaNombre
      ? `para la categoría "${campos.categoriaNombre}"`
      : 'para todos los productos';
  const zonaTxt = campos.zonaNombre ? `, solo en la zona "${campos.zonaNombre}"` : '';
  const descuentoTxt = campos.tipo_descuento === 'porcentaje'
    ? `${campos.valor}% de descuento`
    : `precio final fijo de $${campos.valor}`;
  const vigenciaTxt = campos.fecha_desde || campos.fecha_hasta
    ? `, vigente ${campos.fecha_desde ? `desde ${campos.fecha_desde}` : ''}${campos.fecha_hasta ? ` hasta ${campos.fecha_hasta}` : ''}`
    : '';
  return `${descuentoTxt} a partir de ${campos.cantidad_minima} unidad(es) ${alcance}${zonaTxt}${vigenciaTxt}`;
}

// Actualizar una regla de precio exige mandar el objeto completo
// (actualizarReglaPrecio valida nombre/tipo_descuento/valor como si fuera
// una creación, aunque el patch real a la base solo escriba las claves
// presentes en `campos` — ver comentario de armarCambiosReglaAutomatizacion,
// que sigue el mismo criterio). Por eso acá se trae la fila actual completa
// y se pisa encima SOLO lo que el usuario pidió cambiar.
async function armarCambiosReglaPrecio({ empresaId, args }) {
  const actual = await buscarReglaPrecioPorTexto({ empresaId, texto: args.referencia });
  const { data: fila, error } = await db.from('reglas_precio')
    .select('nombre, producto_id, categoria_id, zona_id, cantidad_minima, tipo_descuento, valor, fecha_desde, fecha_hasta, prioridad, activa')
    .eq('id', actual.id).eq('empresa_id', empresaId).single();
  if (error || !fila) throw new Error('No se pudo leer la regla de precio actual.');

  const cambios = { ...fila };
  const resumenCambios = [];

  if (args.nombre !== undefined && String(args.nombre).trim()) {
    cambios.nombre = String(args.nombre).trim();
    resumenCambios.push(`nombre: "${cambios.nombre}"`);
  }

  if (args.producto !== undefined && args.categoria !== undefined && args.producto && args.categoria) {
    throw new Error('Elegí producto o categoría para la regla, no las dos a la vez.');
  }
  if (args.producto !== undefined) {
    if (!args.producto) {
      cambios.producto_id = null;
    } else {
      const producto = await buscarProductoPorTexto({ empresaId, texto: args.producto });
      cambios.producto_id = producto.id;
      cambios.categoria_id = null;
      resumenCambios.push(`producto: "${producto.nombre}"`);
    }
  }
  if (args.categoria !== undefined) {
    if (!args.categoria) {
      cambios.categoria_id = null;
    } else {
      const categoria = await buscarCategoriaPorTexto({ empresaId, texto: args.categoria });
      cambios.categoria_id = categoria.id;
      cambios.producto_id = null;
      resumenCambios.push(`categoría: "${categoria.nombre}"`);
    }
  }
  if (cambios.producto_id && cambios.categoria_id) {
    throw new Error('Una regla de precio no puede tener producto y categoría a la vez — elegí una.');
  }

  if (args.zona !== undefined) {
    if (!args.zona) {
      cambios.zona_id = null;
    } else {
      const zona = await buscarZonaPorTexto({ empresaId, texto: args.zona });
      cambios.zona_id = zona.id;
      resumenCambios.push(`zona: "${zona.nombre}"`);
    }
  }
  if (args.cantidad_minima !== undefined) {
    cambios.cantidad_minima = Number(args.cantidad_minima);
    resumenCambios.push(`cantidad mínima: ${cambios.cantidad_minima}`);
  }
  if (args.tipo_descuento !== undefined) {
    if (!['porcentaje', 'precio_fijo'].includes(args.tipo_descuento)) {
      throw new Error('El tipo de descuento debe ser "porcentaje" o "precio_fijo".');
    }
    cambios.tipo_descuento = args.tipo_descuento;
  }
  if (args.valor !== undefined) {
    const valor = Number(args.valor);
    if (!Number.isFinite(valor) || valor < 0) throw new Error('El valor del descuento es inválido.');
    cambios.valor = valor;
  }
  if (args.tipo_descuento === 'porcentaje' && cambios.valor > 100) {
    throw new Error('Un descuento porcentual no puede superar el 100%.');
  }
  if (args.tipo_descuento !== undefined || args.valor !== undefined) {
    resumenCambios.push(
      cambios.tipo_descuento === 'porcentaje' ? `${cambios.valor}% de descuento` : `precio fijo $${cambios.valor}`
    );
  }
  if (args.fecha_desde !== undefined) {
    cambios.fecha_desde = args.fecha_desde || null;
    resumenCambios.push(`vigente desde ${cambios.fecha_desde || 'sin inicio'}`);
  }
  if (args.fecha_hasta !== undefined) {
    cambios.fecha_hasta = args.fecha_hasta || null;
    resumenCambios.push(`vigente hasta ${cambios.fecha_hasta || 'sin fin'}`);
  }
  if (cambios.fecha_desde && cambios.fecha_hasta && cambios.fecha_desde > cambios.fecha_hasta) {
    throw new Error('La fecha "desde" no puede ser posterior a la fecha "hasta".');
  }
  if (args.prioridad !== undefined) {
    cambios.prioridad = Number(args.prioridad);
    resumenCambios.push(`prioridad ${cambios.prioridad}`);
  }
  if (args.activa !== undefined) {
    cambios.activa = Boolean(args.activa);
    resumenCambios.push(cambios.activa ? 'activarla' : 'pausarla');
  }

  return { cambios, resumenCambios };
}

function resolverRolesAccion(roles) {
  if (roles === undefined) return undefined;
  if (!Array.isArray(roles) || !roles.length) throw new Error('Los roles a notificar/asignar deben ser una lista no vacía.');
  const normalizados = [...new Set(roles.map((r) => String(r || '').trim().toLowerCase()))];
  const invalidos = normalizados.filter((r) => !ROLES_NOTIFICACION_VALIDOS.includes(r));
  if (invalidos.length) {
    throw new Error(`Rol(es) no reconocido(s) para la acción: ${invalidos.join(', ')}. Usar alguno de: ${ROLES_NOTIFICACION_VALIDOS.join(', ')}.`);
  }
  return normalizados;
}

// Arma el objeto `accion` que espera reglas_automatizacion (mismo shape
// que ejecutarAccion() en lib/reglas-automatizacion.js) a partir de los
// campos "planos" que puede dictar el usuario por voz. Solo se exponen acá
// los 3 tipos que soporta el motor (notificar_push/enviar_whatsapp/
// crear_tarea) — mismo validarCampos() del repo, replicado en JS para dar
// un error hablado ANTES de llamar a Supabase, no después.
function armarAccionRegla(args) {
  const tipo = args.accion_tipo;
  if (!tipo) throw new Error('Falta indicar qué debe hacer la regla cuando se dispare (notificar_push, enviar_whatsapp o crear_tarea).');

  if (tipo === 'notificar_push') {
    const titulo = String(args.accion_titulo || '').trim();
    const mensaje = String(args.accion_mensaje || '').trim();
    if (!titulo) throw new Error('La notificación necesita un título.');
    if (!mensaje) throw new Error('La notificación necesita un mensaje.');
    const roles = resolverRolesAccion(args.accion_roles) || ['dueno', 'admin'];
    return { tipo, titulo, mensaje, roles };
  }

  if (tipo === 'crear_tarea') {
    const titulo = String(args.accion_titulo || '').trim();
    if (!titulo) throw new Error('La tarea necesita un título.');
    const roles = resolverRolesAccion(args.accion_roles) || ['dueno', 'admin'];
    return { tipo, titulo, descripcion: args.accion_descripcion?.trim() || undefined, roles };
  }

  if (tipo === 'enviar_whatsapp') {
    const template = args.accion_template;
    if (!template || !TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE.includes(template)) {
      throw new Error(`Template de WhatsApp inválido (debe ser uno de: ${TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE.join(', ')}).`);
    }
    return { tipo, template };
  }

  throw new Error(`Tipo de acción "${tipo}" no soportado. Usar notificar_push, enviar_whatsapp o crear_tarea.`);
}

function describirAccionRegla(accion) {
  if (accion.tipo === 'notificar_push') return `mandar una notificación push a ${accion.roles.join('/')} ("${accion.titulo}")`;
  if (accion.tipo === 'crear_tarea') return `crear una tarea para ${accion.roles.join('/')} ("${accion.titulo}")`;
  if (accion.tipo === 'enviar_whatsapp') return `mandar el WhatsApp "${accion.template}" al cliente del evento`;
  return 'ejecutar una acción';
}

// Condición simple (un solo campo/operador/valor) — mismo shape que arma
// leerCondicionRegla() en el frontend cuando hay una única fila cargada.
// Combinaciones con "y"/"o" de varias condiciones no se exponen por voz
// (no hay forma cómoda de dictar varias condiciones anidadas sin
// ambigüedad) — si el usuario las necesita, se lo remite al panel.
function armarCondicionRegla(args) {
  if (!args.condicion_campo) return {};
  const campo = String(args.condicion_campo).trim();
  const operador = args.condicion_operador;
  if (!['=', '!=', '>', '>=', '<', '<='].includes(operador)) {
    throw new Error('El operador de la condición debe ser uno de: =, !=, >, >=, <, <=.');
  }
  if (args.condicion_valor === undefined || args.condicion_valor === null || args.condicion_valor === '') {
    throw new Error('Falta el valor de la condición.');
  }
  const valorNumerico = Number(args.condicion_valor);
  const valor = args.condicion_valor !== '' && !Number.isNaN(valorNumerico) ? valorNumerico : args.condicion_valor;
  return { campo, operador, valor };
}

const OP_LABELS_CONDICION = { '=': 'es igual a', '!=': 'es distinto de', '>': 'es mayor que', '>=': 'es mayor o igual que', '<': 'es menor que', '<=': 'es menor o igual que' };

function describirCondicionSimpleRegla(c) {
  return `${c.campo} ${OP_LABELS_CONDICION[c.operador] || c.operador} ${c.valor}`;
}

// Por voz solo se puede CREAR una condición simple (ver armarCondicionRegla:
// no se expone combinar con "y"/"o"), pero al LISTAR reglas existentes
// puede haber alguna armada desde el panel con condicion.y/condicion.o
// (mismo shape que arma leerCondicionRegla() en automatizacion.js) — se
// describen igual que describirCondicion() del frontend para no mostrar
// "siempre" en una regla que en realidad tiene condición.
function describirCondicionRegla(condicion) {
  if (!condicion || typeof condicion !== 'object') return 'siempre (sin condición extra)';
  if (Array.isArray(condicion.y) && condicion.y.length) {
    return `solo si ${condicion.y.map(describirCondicionSimpleRegla).join(' Y ')}`;
  }
  if (Array.isArray(condicion.o) && condicion.o.length) {
    return `solo si ${condicion.o.map(describirCondicionSimpleRegla).join(' O ')}`;
  }
  if (!condicion.campo) return 'siempre (sin condición extra)';
  return `solo si ${describirCondicionSimpleRegla(condicion)}`;
}

// Arma los campos completos para crearReglaAutomatizacion. A diferencia
// de reglas_precio, acá no hace falta resolver ningún id por texto libre
// (evento_disparador es un enum fijo, no una entidad de la empresa).
function armarCamposReglaAutomatizacion({ args }) {
  const nombre = String(args.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre de la regla de automatización.');
  if (!EVENTOS_DISPONIBLES_ASISTENTE.includes(args.evento_disparador)) {
    throw new Error(`El evento disparador debe ser uno de: ${EVENTOS_DISPONIBLES_ASISTENTE.join(', ')}.`);
  }
  const accion = armarAccionRegla(args);
  const condicion = armarCondicionRegla(args);
  return {
    nombre,
    descripcion: args.descripcion?.trim() || null,
    evento_disparador: args.evento_disparador,
    condicion,
    accion,
    activa: true,
  };
}

function describirReglaAutomatizacion(campos) {
  return `cuando pase "${campos.evento_disparador}" (${describirCondicionRegla(campos.condicion)}), va a ${describirAccionRegla(campos.accion)}`;
}

// Actualizar una regla de automatización exige mandar el objeto completo
// (actualizarReglaAutomatizacion valida nombre/evento_disparador/accion
// como si fuera una creación — mismo criterio que reglas_precio, calcado
// de que el formulario real siempre manda el estado completo del form, no
// un patch parcial). Por eso acá se trae la fila actual completa y se
// pisa encima SOLO lo que el usuario pidió cambiar, igual que
// armarCambiosReglaPrecio.
// guardarReglasLiquidacion() es un upsert (onConflict empresa_id) que
// escribe TODAS las columnas del payload — a diferencia de
// actualizarReglaPrecio/actualizarReglaAutomatizacion (UPDATE parcial por
// id), acá no hay id para hacer un patch: se trae la fila actual completa
// (o los defaults que ya usa handleLiquidacion() cuando la empresa nunca
// configuró reglas — ver acción 'reglas' del handler) y se pisa encima
// SOLO lo que el usuario pidió cambiar, mismo criterio que el resto de los
// "armarCambios*" de este archivo. Valida rangos básicos (0-100 en los
// porcentajes, orden dias_nivel1 > dias_nivel2 > dias_nivel3) porque acá
// no hay ningún formulario del panel poniendo límites al valor que se
// dicta por voz, a diferencia de cuando se completa a mano.
async function armarCambiosReglaLiquidacion({ empresaId, args }) {
  const actual = (await obtenerReglasLiquidacion(empresaId)) || {
    dias_alerta: 7, dias_nivel1: 3, pct_nivel1: 10,
    dias_nivel2: 1, pct_nivel2: 15, dias_nivel3: 0, pct_nivel3: 25,
    activo: true,
  };

  const cambios = {
    activo: actual.activo !== false,
    dias_alerta: actual.dias_alerta,
    dias_nivel1: actual.dias_nivel1,
    pct_nivel1: actual.pct_nivel1,
    dias_nivel2: actual.dias_nivel2,
    pct_nivel2: actual.pct_nivel2,
    dias_nivel3: actual.dias_nivel3,
    pct_nivel3: actual.pct_nivel3,
  };
  const resumenCambios = [];

  if (args.activo !== undefined) {
    cambios.activo = !!args.activo;
    resumenCambios.push(cambios.activo ? 'activar la liquidación automática' : 'desactivar la liquidación automática');
  }
  if (args.dias_alerta !== undefined) {
    cambios.dias_alerta = Number(args.dias_alerta);
    resumenCambios.push(`radar a partir de ${cambios.dias_alerta} día(s) antes del vencimiento`);
  }

  const niveles = [1, 2, 3];
  for (const n of niveles) {
    const kDias = `dias_nivel${n}`;
    const kPct = `pct_nivel${n}`;
    if (args[kDias] !== undefined) {
      cambios[kDias] = Number(args[kDias]);
      resumenCambios.push(`nivel ${n}: hasta ${cambios[kDias]} día(s) restantes`);
    }
    if (args[kPct] !== undefined) {
      const pct = Number(args[kPct]);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new Error(`El descuento del nivel ${n} tiene que estar entre 0 y 100 (se pidió ${args[kPct]}).`);
      }
      cambios[kPct] = pct;
      resumenCambios.push(`nivel ${n}: ${pct}% de descuento`);
    }
  }

  if (!(cambios.dias_nivel1 > cambios.dias_nivel2 && cambios.dias_nivel2 > cambios.dias_nivel3)) {
    throw new Error(
      `Los días de cada nivel tienen que ir de mayor a menor (nivel 1 > nivel 2 > nivel 3): quedarían ${cambios.dias_nivel1} > ${cambios.dias_nivel2} > ${cambios.dias_nivel3}, revisá los valores.`
    );
  }

  return { cambios, resumenCambios };
}

async function armarCambiosReglaAutomatizacion({ empresaId, args }) {
  const actual = await buscarReglaAutomatizacionPorTexto({ empresaId, texto: args.referencia });
  const { data: fila, error } = await db.from('reglas_automatizacion')
    .select('nombre, descripcion, evento_disparador, condicion, accion, activa')
    .eq('id', actual.id).eq('empresa_id', empresaId).single();
  if (error || !fila) throw new Error('No se pudo leer la regla de automatización actual.');

  const cambios = { ...fila };
  const resumenCambios = [];

  if (args.nombre !== undefined && String(args.nombre).trim()) {
    cambios.nombre = String(args.nombre).trim();
    resumenCambios.push(`nombre: "${cambios.nombre}"`);
  }
  if (args.descripcion !== undefined) {
    cambios.descripcion = args.descripcion?.trim() || null;
    resumenCambios.push('descripción actualizada');
  }
  if (args.evento_disparador !== undefined) {
    if (!EVENTOS_DISPONIBLES_ASISTENTE.includes(args.evento_disparador)) {
      throw new Error(`El evento disparador debe ser uno de: ${EVENTOS_DISPONIBLES_ASISTENTE.join(', ')}.`);
    }
    cambios.evento_disparador = args.evento_disparador;
    resumenCambios.push(`evento: "${args.evento_disparador}"`);
  }
  if (args.condicion_campo !== undefined) {
    cambios.condicion = armarCondicionRegla(args);
    resumenCambios.push(`condición: ${describirCondicionRegla(cambios.condicion)}`);
  }
  if (args.accion_tipo !== undefined) {
    cambios.accion = armarAccionRegla(args);
    resumenCambios.push(`acción: ${describirAccionRegla(cambios.accion)}`);
  }
  if (args.activa !== undefined) {
    cambios.activa = Boolean(args.activa);
    resumenCambios.push(cambios.activa ? 'activarla' : 'pausarla');
  }

  return { cambios, resumenCambios };
}

async function buscarReglaAutomatizacionPorTexto({ empresaId, texto }) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta indicar el nombre de la regla de automatización.');
  const { data, error } = await db.from('reglas_automatizacion')
    .select('id, nombre, evento_disparador, activa')
    .eq('empresa_id', empresaId)
    .ilike('nombre', `%${t}%`);
  if (error) throw new Error(`No se pudo buscar la regla de automatización: ${error.message}`);
  if (!data?.length) throw new Error(`No encontré ninguna regla de automatización parecida a "${t}".`);
  if (data.length > 1) {
    const nombres = data.map((r) => r.nombre).join(', ');
    throw new Error(`Hay más de una regla de automatización parecida a "${t}" (${nombres}). Pedile al usuario que precise cuál.`);
  }
  return data[0];
}

// Resuelve un pedido/presupuesto/venta puntual a partir del NOMBRE del
// cliente en vez del ID corto — para diagnosticar_pedido/presupuesto/
// venta_pos, que hasta acá exigían el ID de entrada aunque el usuario solo
// tuviera el nombre a mano (a diferencia de diagnosticar_cheque, que ya
// buscaba por cliente porque un cheque no tiene ID visible en el panel).
// Reusa buscarClientePorTexto (misma búsqueda aproximada por trigramas que
// ya usa crear_pedido) para resolver el cliente sin adivinar, y después
// trae sus documentos más recientes en la tabla pedida. Si hay uno solo,
// el caller lo usa directo; si hay varios, se devuelven como candidatos
// (mismo shape { id, referencia_corta, cliente, fecha, total } que ya
// devuelven las RPC diagnosticar_* cuando la referencia es ambigua) para
// que el modelo se los muestre al usuario y le pida QUE ELIJA — nunca se
// adivina cuál es, se lo hace desambiguar con algo mucho más cómodo que
// "dame el ID corto de 6 caracteres".
async function buscarDocumentosRecientesPorCliente({ empresaId, texto, tabla, columnaFecha, limite = 6 }) {
  const cliente = await buscarClientePorTexto({ empresaId, texto });
  const { data, error } = await db.from(tabla)
    .select(`id, ${columnaFecha}, total`)
    .eq('empresa_id', empresaId)
    .eq('cliente_id', cliente.id)
    .order(columnaFecha, { ascending: false })
    .limit(limite);
  if (error) throw new Error(`No se pudo buscar en ${tabla}: ${error.message}`);
  return {
    cliente,
    documentos: (data || []).map((d) => ({
      id: d.id,
      referencia_corta: String(d.id).slice(-6).toUpperCase(),
      cliente: cliente.razon_social,
      fecha: d[columnaFecha],
      total: d.total,
    })),
  };
}

// Punto de entrada compartido por diagnosticar_pedido/presupuesto/venta_pos:
// si vino `referencia` se usa tal cual (comportamiento de siempre); si vino
// solo `cliente`, se resuelve con buscarDocumentosRecientesPorCliente y:
//   - 0 documentos → error concreto (no hay nada de ese cliente en esa tabla)
//   - 1 documento  → se sigue de largo con su referencia_corta, sin pedir nada
//   - 2+ documentos → se devuelve el mismo shape "ambiguo" que ya devuelven
//     las RPC diagnosticar_* cuando la referencia matchea más de un
//     registro, así el modelo lo maneja exactamente igual en los dos casos.
async function resolverReferenciaParaDiagnostico({ empresaId, args, tabla, columnaFecha, nombreDocumento }) {
  const referenciaLimpia = String(args.referencia || '').replace('#', '').trim();
  if (referenciaLimpia) return { referencia: referenciaLimpia };

  const texto = String(args.cliente || '').trim();
  if (!texto) throw new Error(`Necesito el ID corto del ${nombreDocumento} o el nombre del cliente.`);

  const { cliente, documentos } = await buscarDocumentosRecientesPorCliente({ empresaId, texto, tabla, columnaFecha });
  if (!documentos.length) throw new Error(`No encontré ningún ${nombreDocumento} de "${cliente.razon_social}".`);
  if (documentos.length > 1) return { ambiguo: { encontrado: false, ambiguo: true, candidatos: documentos } };
  return { referencia: documentos[0].referencia_corta };
}

// Resuelve anular_factura por referencia o por nombre de cliente, reusando
// resolverReferenciaParaDiagnostico tal cual (tabla `facturas`, columna
// `fecha_emision`) — no se duplica ese mecanismo. A diferencia de los
// diagnosticar_*, acá el resultado SIEMPRE se valida contra
// `estado === 'emitida'` en buscarFacturaPorReferencia, porque una factura
// pendiente o ya anulada nunca es un resultado válido para esta tool,
// aunque haya sido la más reciente del cliente.
async function resolverFacturaParaAnular({ empresaId, args }) {
  const resuelto = await resolverReferenciaParaDiagnostico({
    empresaId, args, tabla: 'facturas', columnaFecha: 'fecha_emision', nombreDocumento: 'factura',
  });
  if (resuelto.ambiguo) return resuelto.ambiguo;
  return await buscarFacturaPorReferencia({ empresaId, referencia: resuelto.referencia });
}

// lib/facturas.js:anularFactura() bajo service_role, igual que
// anular_venta_pos, no valida por sí sola que la factura pertenezca a
// empresaId — se scopea acá antes de tocar nada. No existe una RPC
// `diagnosticar_factura`, así que se filtra en JS contra las facturas de
// ESTA empresa (mismo patrón que buscarMovimientoBancarioPorReferencia).
async function buscarFacturaPorReferencia({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim().toUpperCase();
  if (!ref) throw new Error('Falta la referencia de la factura.');

  const { data, error } = await db.from('facturas')
    .select('id, numero, tipo, estado, total, clientes(razon_social)')
    .eq('empresa_id', empresaId);
  if (error) throw new Error(`No se pudo buscar la factura: ${error.message}`);

  const candidatos = (data || []).filter((f) => f.id.toUpperCase() === ref || f.id.slice(-6).toUpperCase() === ref);
  if (!candidatos.length) throw new Error(`No encontré ninguna factura con la referencia "${ref}" en esta empresa.`);
  if (candidatos.length > 1) throw new Error('Esa referencia coincide con más de una factura. Pedile al usuario el UUID completo.');

  const f = candidatos[0];
  if (f.estado === 'anulada') throw new Error(`La factura ${f.numero ?? f.id} ya está anulada.`);
  if (f.estado !== 'emitida') {
    throw new Error(`La factura ${f.numero ?? f.id} está en estado "${f.estado}" (sin CAE) — solo se pueden anular comprobantes emitidos. No hace falta anularla fiscalmente: alcanza con cancelar el pedido o la venta que la generó.`);
  }

  return {
    id: f.id,
    referencia_corta: f.id.slice(-6).toUpperCase(),
    numero: f.numero,
    tipo: f.tipo,
    total: f.total,
    cliente: f.clientes?.razon_social || 'Consumidor Final',
  };
}

// Resuelve emitir_factura por referencia o por nombre de cliente, reusando
// resolverReferenciaParaDiagnostico tal cual (tabla `pedidos`, columna
// `fecha_pedido`) — mismo mecanismo que ya usa diagnosticar_pedido, no se
// duplica. La elegibilidad para facturar SIEMPRE se valida en
// buscarPedidoFacturable, sea cual sea el origen de la referencia (directa
// o resuelta por cliente).
async function resolverPedidoParaFacturar({ empresaId, args }) {
  const resuelto = await resolverReferenciaParaDiagnostico({
    empresaId, args, tabla: 'pedidos', columnaFecha: 'fecha_pedido', nombreDocumento: 'pedido',
  });
  if (resuelto.ambiguo) return resuelto.ambiguo;
  return await buscarPedidoFacturable({ empresaId, referencia: resuelto.referencia });
}

// Resuelve el ID corto/UUID contra los pedidos de ESTA empresa (mismo
// patrón que buscarFacturaPorReferencia arriba) y valida ahí mismo la
// misma condición `puedeFacturar` que ya usa el botón real
// (frontend/admin/js/pedidos.js:802): ni borrador/pendiente/cancelado, y
// sin una factura YA emitida (una en pendiente/error_afip sí es válida —
// es un reintento, no una emisión nueva).
async function buscarPedidoFacturable({ empresaId, referencia }) {
  const ref = String(referencia || '').replace('#', '').trim().toUpperCase();
  if (!ref) throw new Error('Falta la referencia del pedido.');

  const { data, error } = await db.from('pedidos')
    .select('id, estado, total, factura_id, clientes(razon_social), facturas(estado, notas_error)')
    .eq('empresa_id', empresaId);
  if (error) throw new Error(`No se pudo buscar el pedido: ${error.message}`);

  const candidatos = (data || []).filter((p) => p.id.toUpperCase() === ref || p.id.slice(-6).toUpperCase() === ref);
  if (!candidatos.length) throw new Error(`No encontré ningún pedido con la referencia "${ref}" en esta empresa.`);
  if (candidatos.length > 1) throw new Error('Esa referencia coincide con más de un pedido. Pedile al usuario el UUID completo.');

  const p = candidatos[0];
  if (['borrador', 'pendiente', 'cancelado'].includes(p.estado)) {
    throw new Error(`El pedido ${p.id.slice(-6).toUpperCase()} está en estado "${p.estado}" — todavía no se puede facturar.`);
  }

  const facturaEstado = p.facturas?.estado || null;
  const facturaSinEmitir = !p.factura_id || ['pendiente', 'error_afip'].includes(facturaEstado);
  if (!facturaSinEmitir) {
    throw new Error(`El pedido ${p.id.slice(-6).toUpperCase()} ya tiene una factura emitida (estado "${facturaEstado}") — no hace falta volver a facturarlo. Para anularla, usar la tool anular_factura.`);
  }

  return {
    id: p.id,
    referencia_corta: p.id.slice(-6).toUpperCase(),
    cliente: p.clientes?.razon_social || 'Consumidor Final',
    total: p.total,
    es_reintento: !!p.factura_id,
    factura_error_detalle: p.facturas?.notas_error || null,
  };
}

// Resuelve TODO lo que necesitan crear_pedido Y crear_presupuesto (cliente +
// cada item) a partir de los args de texto libre del modelo — es genérica
// (cliente + items), no tiene nada específico de pedido, así que la
// comparten ambas tools en vez de duplicarla. Se llama por separado desde
// resumen() y desde execute() de cada una — nunca se pasa un resultado ya
// resuelto de uno a otro, para no reusar un producto_id/cliente_id que pudo
// haber dejado de ser válido entre la propuesta y la confirmación.
async function resolverPedidoDesdeArgs({ empresaId, args }) {
  const cliente = await buscarClientePorTexto({ empresaId, texto: args.cliente });

  const itemsArg = Array.isArray(args.items) ? args.items : [];
  if (!itemsArg.length) throw new Error('El pedido necesita al menos un producto con su cantidad.');

  const itemsResueltos = [];
  for (const item of itemsArg) {
    const cantidad = Number(item.cantidad);
    if (!cantidad || cantidad <= 0) throw new Error(`Cantidad inválida para "${item.producto}".`);
    const producto = await buscarProductoPorTexto({ empresaId, texto: item.producto });
    itemsResueltos.push({ producto_id: producto.id, cantidad });
  }

  return { clienteId: cliente.id, itemsResueltos };
}

// FIX (v517): antes esquemaParaGemini()/esquemaParaOpenAI() no recibían el
// rol y siempre declaraban las 68 tools completas al modelo, aunque
// ejecutarTool() ya rechazaba en tiempo de ejecución las que el rol del
// usuario no tiene permitido llamar (ver `roles` en cada tool, arriba).
// Resultado: se le mandaba a Groq/OpenRouter (y a Gemini) un catálogo más
// grande de lo necesario para ese usuario puntual — el modelo nunca podía
// usar de verdad esas tools fuera de su rol. Este filtro replica el mismo
// criterio de `roles` que ya usa ejecutarTool(), pero ANTES de armar el
// esquema, no después: menos tools declaradas = menos bytes en el body de
// cada request. Tools sin `roles` definido (abiertas a cualquier rol,
// igual que en ejecutarTool()) siempre se incluyen.
//
// Nota: para roles 'dueno'/'admin' (que ven 68/68 tools) esto solo no
// alcanza para bajar el esquema por debajo del límite de TPM de Groq — ver
// CHANGELOG_v517 para el detalle de la medición y qué quedó pendiente.
function toolsParaRol(rol) {
  return TOOLS.filter((t) => !Array.isArray(t.roles) || t.roles.includes(rol));
}

/** Formato que espera la API de Gemini para declarar funciones (function_declarations). */
function esquemaParaGemini(rol) {
  return toolsParaRol(rol).map((t) => ({
    name: t.name,
    description: t.requiereConfirmacion
      // El modelo tiene que saber, desde la descripción misma, que llamar
      // esta función NO ejecuta nada todavía — así no le promete al
      // usuario "listo, ya lo anulé" antes de que exista la confirmación.
      ? `${t.description} IMPORTANTE: llamar esta función solo PROPONE la acción, no la ejecuta. El resultado te va a dar un resumen que tenés que mostrarle tal cual al usuario pidiéndole que confirme con el botón — nunca digas que ya se hizo, y nunca vuelvas a llamar esta función para la misma acción.`
      : t.description,
    parameters: t.parameters,
  }));
}

// FIX (v514): Groq y OpenRouter usan la API "Chat Completions" (formato
// OpenAI), que declara funciones distinto a Gemini — envueltas en
// { type: 'function', function: {...} } en vez de una lista plana. Antes
// esos dos proveedores no recibían tools en absoluto (ver comentario
// viejo más abajo en asistente-providers.js): con la cuota gratuita de
// Gemini agotándose rápido, eso significaba que apenas Gemini fallaba el
// asistente dejaba de poder consultar datos reales de la cuenta. Ahora
// Groq (gratis, ~1000 solicitudes/día para el modelo de texto configurado
// en GROQ_MODEL — ver FIX v520 en asistente-providers.js para el modelo
// vigente, que sí soporta tool calling) y OpenRouter (con el router `openrouter/free`, que
// elige automáticamente un modelo gratuito compatible con tool calling)
// también pueden ejecutar las mismas tools — mismo texto de `description`
// que ve Gemini, mismo `parameters` (ambos formatos usan JSON Schema).
// FIX (v518): el filtro por rol (v517) no alcanza para dueno/admin — ven
// las 68 tools igual, porque su `roles` las incluye casi todas. Para esos
// roles, el esquema completo YA pesa ~13.860 tokens estimados él solo,
// por encima del límite de 12.000 TPM de Groq, sin sumar system prompt,
// artículos ni historial. Acá se agrega una segunda pasada, aplicada solo
// para los proveedores con ese límite chico (Groq/OpenRouter — ver
// esquemaParaOpenAI más abajo): de las tools que el rol puede ver, se
// seleccionan solo las relevantes para ESA pregunta puntual por
// coincidencia de palabras clave (nombre de la tool pesa más que la
// descripción), con un tope duro de tools declaradas. Si la pregunta es
// tan genérica que no matchea ninguna palabra con ninguna tool (ej. "hola,
// ¿cómo estás?"), se cae a un set "núcleo" curado con las tools de
// consulta más pedidas, para no dejar al asistente sin ninguna
// herramienta en ese caso.
//
// Gemini NO pasa por este segundo filtro: su falla observada fue 429 de
// cuota diaria, no un límite de tamaño de request — reducirle el catálogo
// no resuelve nada ahí y sí le sacaría capacidad real sin necesidad.

const TOOLS_MAX_PROVEEDOR_TPM_CHICO = 20;

const TOOLS_NUCLEO_FALLBACK = [
  'contar_pedidos_pendientes',
  'listar_pedidos_pendientes',
  'consultar_stock_critico',
  'consultar_analisis_stock_predictivo',
  'listar_cheques_alerta',
  'consultar_deuda_proveedor',
  'listar_facturas_proveedor_por_vencer',
  'listar_lotes_por_vencer',
  'consultar_bloqueo_cliente',
  'consultar_ruta_dia',
  'diagnosticar_pedido',
  'diagnosticar_venta_pos',
  'consultar_cuenta_corriente_proveedor',
  'consultar_cola_financiera_pendiente',
  'consultar_datos_empresa',
];

const STOPWORDS_PREGUNTA = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'a', 'en',
  'por', 'para', 'que', 'con', 'sin', 'sobre', 'me', 'te', 'se', 'su', 'sus', 'mi', 'mis',
  'tu', 'tus', 'al', 'lo', 'le', 'les', 'es', 'son', 'esta', 'este', 'estan', 'como', 'cual',
  'cuales', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'dame', 'decime', 'pasame', 'porfa',
  'favor', 'podes', 'puedes', 'quiero', 'quisiera', 'necesito', 'tengo', 'hay', 'todo',
  'todos', 'toda', 'todas', 'perdon', 'digo',
]);

// Normaliza a minúsculas sin tildes y separa en palabras "significativas"
// (largo >= 3, sin stopwords). No es un tokenizador lingüístico real: es
// deliberadamente simple, a propósito de que solo tiene que aproximar
// coincidencias tool-pregunta, no entender la pregunta.
function palabrasSignificativas(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length >= 3 && !STOPWORDS_PREGUNTA.has(p))
    .map(raizAproximada);
}

// Achica plurales/variantes simples ("pedidos" -> "pedido", "facturas" ->
// "factura") para que matcheen contra el singular usado en los nombres de
// tools. Heurística a propósito, no un stemmer real.
function raizAproximada(palabra) {
  if (palabra.length > 5 && palabra.endsWith('es')) return palabra.slice(0, -2);
  if (palabra.length > 4 && palabra.endsWith('s')) return palabra.slice(0, -1);
  return palabra;
}

function seleccionarToolsRelevantes(toolsDelRol, pregunta) {
  const palabrasPregunta = new Set(palabrasSignificativas(pregunta));

  const puntuadas = toolsDelRol.map((t) => {
    const palabrasNombre = new Set(t.name.split('_').map(raizAproximada));
    const palabrasDesc = new Set(palabrasSignificativas(t.description));
    let score = 0;
    for (const p of palabrasPregunta) {
      if (palabrasNombre.has(p)) score += 3; // coincidencia en el nombre pesa más
      else if (palabrasDesc.has(p)) score += 1;
    }
    return { t, score };
  });

  const conMatch = puntuadas.filter((p) => p.score > 0).sort((a, b) => b.score - a.score);

  if (conMatch.length === 0) {
    return TOOLS_NUCLEO_FALLBACK
      .map((nombre) => toolsDelRol.find((t) => t.name === nombre))
      .filter(Boolean)
      .slice(0, TOOLS_MAX_PROVEEDOR_TPM_CHICO);
  }

  return conMatch.slice(0, TOOLS_MAX_PROVEEDOR_TPM_CHICO).map((p) => p.t);
}

function esquemaParaOpenAI(rol, pregunta) {
  const toolsDelRol = toolsParaRol(rol);
  const toolsAEnviar = pregunta ? seleccionarToolsRelevantes(toolsDelRol, pregunta) : toolsDelRol;
  return toolsAEnviar.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.requiereConfirmacion
        ? `${t.description} IMPORTANTE: llamar esta función solo PROPONE la acción, no la ejecuta. El resultado te va a dar un resumen que tenés que mostrarle tal cual al usuario pidiéndole que confirme con el botón — nunca digas que ya se hizo, y nunca vuelvas a llamar esta función para la misma acción.`
        : t.description,
      parameters: t.parameters,
    },
  }));
}

async function ejecutarTool(nombre, { empresaId, rol, usuarioId, conversacionId, args }) {
  const tool = TOOLS.find((t) => t.name === nombre);
  if (!tool) throw new Error(`Tool desconocida: ${nombre}`);
  if (!empresaId) throw new Error('No hay empresa asociada al usuario, no se puede ejecutar la tool');

  // ASISTENTE-001 (auditoría 2026-07-26): el chat-widget se inyecta en TODAS
  // las pantallas del admin (ver nav.js) sin distinguir rol, y hasta acá las
  // tools de este archivo solo validaban empresa_id — nunca el rol de negocio
  // del caller. Resultado: un vendedor/contador/depositero podía preguntarle
  // al asistente por datos que su propio menú (nav-data.js) le oculta en la
  // UI — ej. un vendedor sin acceso a "Proveedores"/"Cheques" podía obtener
  // esos mismos datos por chat. `roles` en cada tool replica exactamente los
  // roles que ya tienen esa pantalla habilitada en nav-data.js. Tools sin
  // `roles` definido (ninguna sensible a día de hoy) quedan abiertas a
  // cualquier rol autenticado, como antes.
  if (Array.isArray(tool.roles) && !tool.roles.includes(rol)) {
    throw new Error('No tenés permiso para consultar ese dato con tu rol actual. Pedíselo a un administrador.');
  }

  if (!tool.requiereConfirmacion) {
    return tool.execute({ empresaId, args: args || {} });
  }

  // Tool de escritura: nunca se ejecuta acá. Se guarda como propuesta
  // pendiente y se le devuelve al modelo solo el resumen + el id para
  // que el usuario confirme por fuera de este mismo turno.
  if (!conversacionId || !usuarioId) {
    throw new Error(`${nombre} requiere confirmación y no se pudo registrar (falta conversación o usuario)`);
  }

  const resumen = await tool.resumen({ empresaId, args: args || {} });

  const { data, error } = await db
    .from('asistente_acciones_pendientes')
    .insert({
      conversacion_id: conversacionId,
      usuario_id: usuarioId,
      empresa_id: empresaId,
      tool_nombre: nombre,
      tool_args: args || {},
      resumen,
    })
    .select('id')
    .single();

  if (error) throw new Error(`No se pudo preparar la confirmación de ${nombre}: ${error.message}`);

  return {
    pendiente_confirmacion: true,
    id_confirmacion: data.id,
    resumen,
  };
}

/**
 * Resuelve (confirma o cancela) una acción pendiente creada por
 * ejecutarTool() para una tool con requiereConfirmacion:true.
 *
 * Se llama desde lib/handlers/asistente.js cuando el usuario clickea
 * Confirmar/Cancelar en el chat-widget — NUNCA desde el loop de Gemini.
 * Valida dueño + empresa + conversación + vigencia antes de tocar nada,
 * y usa un UPDATE atómico con `estado = 'pendiente'` en el WHERE para
 * que un doble click (o una carrera de dos tabs) no ejecute la acción
 * dos veces: el segundo UPDATE no afecta ninguna fila.
 */
async function resolverAccionPendiente({ id, usuarioId, empresaId, conversacionId, confirmar }) {
  if (!id) throw new Error('Falta el id de la acción a confirmar');

  const { data: fila, error: errorLectura } = await db
    .from('asistente_acciones_pendientes')
    .select('id, tool_nombre, tool_args, resumen, estado, usuario_id, empresa_id, conversacion_id, creado_en')
    .eq('id', id)
    .maybeSingle();

  if (errorLectura) throw new Error(`No se pudo leer la acción pendiente: ${errorLectura.message}`);
  if (!fila) return { encontrada: false };

  // Nunca resolver una acción de otro usuario, otra empresa, u otra
  // conversación aunque alguien adivine/reutilice el UUID.
  if (fila.usuario_id !== usuarioId || fila.empresa_id !== empresaId || fila.conversacion_id !== conversacionId) {
    throw new Error('Esa acción pendiente no corresponde a esta conversación');
  }

  if (fila.estado !== 'pendiente') {
    return { encontrada: true, estado: fila.estado, resumen: fila.resumen, yaResuelta: true };
  }

  const vencida = Date.now() - new Date(fila.creado_en).getTime() > TTL_CONFIRMACION_MS;
  if (vencida) {
    await db.from('asistente_acciones_pendientes')
      .update({ estado: 'expirada', resuelto_en: new Date().toISOString() })
      .eq('id', id)
      .eq('estado', 'pendiente');
    return { encontrada: true, estado: 'expirada', resumen: fila.resumen };
  }

  if (!confirmar) {
    await db.from('asistente_acciones_pendientes')
      .update({ estado: 'cancelada', resuelto_en: new Date().toISOString() })
      .eq('id', id)
      .eq('estado', 'pendiente');
    return { encontrada: true, estado: 'cancelada', resumen: fila.resumen };
  }

  // Reclamo atómico: si dos requests llegan casi juntas (doble click),
  // solo una gana esta UPDATE (la otra afecta 0 filas porque ya no
  // encuentra estado='pendiente').
  const { data: reclamada, error: errorReclamo } = await db
    .from('asistente_acciones_pendientes')
    .update({ estado: 'confirmada', resuelto_en: new Date().toISOString() })
    .eq('id', id)
    .eq('estado', 'pendiente')
    .select('id')
    .maybeSingle();

  if (errorReclamo) throw new Error(`No se pudo confirmar la acción: ${errorReclamo.message}`);
  if (!reclamada) return { encontrada: true, estado: 'ejecutada_por_otro_click', resumen: fila.resumen };

  const tool = TOOLS.find((t) => t.name === fila.tool_nombre);
  if (!tool) {
    await db.from('asistente_acciones_pendientes').update({ estado: 'error', resultado: { error: 'tool desconocida' } }).eq('id', id);
    throw new Error(`Tool desconocida al ejecutar la acción confirmada: ${fila.tool_nombre}`);
  }

  try {
    const resultado = await tool.execute({ empresaId, usuarioId, args: fila.tool_args || {} });
    await db.from('asistente_acciones_pendientes').update({ estado: 'ejecutada', resultado }).eq('id', id);
    return { encontrada: true, estado: 'ejecutada', resumen: fila.resumen, resultado };
  } catch (error) {
    await db.from('asistente_acciones_pendientes').update({ estado: 'error', resultado: { error: error.message } }).eq('id', id);
    throw new Error(`Se confirmó pero falló al ejecutar "${fila.resumen}": ${error.message}`);
  }
}

export { TOOLS, esquemaParaGemini, esquemaParaOpenAI, seleccionarToolsRelevantes, ejecutarTool, resolverAccionPendiente };
