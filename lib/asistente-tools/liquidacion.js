// lib/asistente-tools/liquidacion.js
// Tools del asistente — dominio: liquidacion.
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

const TOOLS_LIQUIDACION = [
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
];

export { TOOLS_LIQUIDACION };
