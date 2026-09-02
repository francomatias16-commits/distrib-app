// lib/asistente-tools/stock.js
// Tools del asistente — dominio: stock.
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

const TOOLS_STOCK = [
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
];

export { TOOLS_STOCK };
