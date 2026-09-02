// lib/asistente-tools/proveedores.js
// Tools del asistente — dominio: proveedores.
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

const TOOLS_PROVEEDORES = [
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
];

export { TOOLS_PROVEEDORES };
