// lib/asistente-tools/reportes.js
// Tools del asistente — dominio: reportes / resúmenes de negocio.
//
// Por qué existe (2026-09-07): auditoría sistemática del catálogo de
// tools contra las RPC reales de la base (mismo método que encontró el
// hueco puntual de "buscá si tengo detergente en stock" en
// consultar-stock-por-texto) mostró que el rol dueño/admin no tenía
// NINGUNA tool de nivel agregado — "¿cómo van las ventas este mes contra
// el anterior?" o "dame un resumen ejecutivo" caían siempre al fallback
// genérico, aunque las RPC ya existían y ya estaban en uso por el Panel
// administrativo (lib/handlers/admin.js + lib/repos/admin.js).
//
// Las 6 tools de acá son wrappers finos 1:1 sobre esas RPC ya existentes,
// probadas y en producción — no se agrega lógica de negocio nueva, solo
// se expone lo que ya calculaba el dashboard:
//   consultar_resumen_ejecutivo        → obtener_dashboard_ejecutivo_resumen (243)
//   consultar_comparativa_mensual      → obtener_comparativa_mensual (243b)
//   consultar_ventas_por_canal         → obtener_ventas_por_canal (478)
//   consultar_resumen_compras_proveedor→ obtener_resumen_compras_proveedor (478)
//   consultar_resumen_gastos_generales → obtener_resumen_gastos_generales (479)
//   consultar_estado_financiero_integral → obtener_estado_financiero_integral (565)
//
// Todas de solo lectura (sin requiereConfirmacion) — mismo criterio del
// resto del catálogo: el modelo nunca arma SQL, solo elige el nombre y
// parámetros primitivos (días/agrupación), y cada RPC ya está scopeada
// por p_empresa_id, revocada de PUBLIC y otorgada a service_role.

import { db } from '../repos/_db.js';

const DIAS_DEFAULT = 30;
const DIAS_TOPE = 365;
const AGRUPACIONES_VALIDAS = ['dia', 'mes', 'anio'];

/** Arma { desde, hasta } en ISO a partir de una ventana de días hacia atrás desde ahora, con default y tope — mismo criterio que periodoAFechas() en lib/handlers/admin.js. */
function armarRangoFechas(dias) {
  const diasNumero = Number.isFinite(dias) && dias > 0 ? Math.min(dias, DIAS_TOPE) : DIAS_DEFAULT;
  const hasta = new Date();
  const desde = new Date(hasta);
  desde.setDate(desde.getDate() - diasNumero);
  return { desde: desde.toISOString(), hasta: hasta.toISOString() };
}

const TOOLS_REPORTES = [
  {
    name: 'consultar_resumen_ejecutivo',
    description: 'Resumen ejecutivo del negocio: cobranza, rentabilidad y stock consolidados en un solo panel, con urgencias destacadas. Usar para "dame un resumen ejecutivo", "cómo está el negocio en general", "resumen del negocio", "dashboard ejecutivo". Es el mismo resumen que ve el dueño en el Panel administrativo.',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: `Ventana de días hacia atrás. Si no lo dicen, usar ${DIAS_DEFAULT}. Tope ${DIAS_TOPE}.` },
      },
    },
    async execute({ empresaId, args }) {
      const { desde, hasta } = armarRangoFechas(args.dias);
      const { data, error } = await db.rpc('obtener_dashboard_ejecutivo_resumen', {
        p_empresa_id: empresaId,
        p_desde: desde,
        p_hasta: hasta,
      });
      if (error) throw new Error(`consultar_resumen_ejecutivo: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_comparativa_mensual',
    description: 'Compara las ventas del mes actual contra el mismo tramo del mes anterior, día por día. Usar para "cómo venimos este mes contra el mes pasado", "comparativa mensual", "cómo va el mes comparado con el anterior". La RPC resuelve sola la fecha de referencia (hoy), no hace falta pasar ningún parámetro de fecha.',
    roles: ['dueno', 'admin'],
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId }) {
      const { data, error } = await db.rpc('obtener_comparativa_mensual', { p_empresa_id: empresaId });
      if (error) throw new Error(`consultar_comparativa_mensual: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_ventas_por_canal',
    description: 'Desglose de las ventas del período por canal (pedidos según su canal de origen + ventas de mostrador/POS), con total, cantidad y porcentaje de cada uno. Usar para "cómo se reparten las ventas por canal", "cuánto vendimos por mostrador vs por pedidos", "ventas por canal este mes".',
    roles: ['dueno', 'admin'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: `Ventana de días hacia atrás. Si no lo dicen, usar ${DIAS_DEFAULT}. Tope ${DIAS_TOPE}.` },
      },
    },
    async execute({ empresaId, args }) {
      const { desde, hasta } = armarRangoFechas(args.dias);
      const { data, error } = await db.rpc('obtener_ventas_por_canal', {
        p_empresa_id: empresaId,
        p_desde: desde,
        p_hasta: hasta,
      });
      if (error) throw new Error(`consultar_ventas_por_canal: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_resumen_compras_proveedor',
    description: 'Resumen de compras y deuda a proveedores del período: total facturado y ranking de proveedores por deuda. Usar para "cuánto le compramos a los proveedores este mes", "cuánto debemos en total a proveedores", "resumen de compras a proveedores".',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: `Ventana de días hacia atrás. Si no lo dicen, usar ${DIAS_DEFAULT}. Tope ${DIAS_TOPE}.` },
      },
    },
    async execute({ empresaId, args }) {
      const { desde, hasta } = armarRangoFechas(args.dias);
      const { data, error } = await db.rpc('obtener_resumen_compras_proveedor', {
        p_empresa_id: empresaId,
        p_desde: desde,
        p_hasta: hasta,
      });
      if (error) throw new Error(`consultar_resumen_compras_proveedor: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_resumen_gastos_generales',
    description: 'Total de gastos generales del período (alquiler, sueldos, servicios, etc.) desglosado por categoría. Usar para "cuánto gastamos este mes", "gastos generales del período", "en qué categoría gastamos más".',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: `Ventana de días hacia atrás. Si no lo dicen, usar ${DIAS_DEFAULT}. Tope ${DIAS_TOPE}.` },
      },
    },
    async execute({ empresaId, args }) {
      const { desde, hasta } = armarRangoFechas(args.dias);
      const { data, error } = await db.rpc('obtener_resumen_gastos_generales', {
        p_empresa_id: empresaId,
        p_desde: desde,
        p_hasta: hasta,
      });
      if (error) throw new Error(`consultar_resumen_gastos_generales: ${error.message}`);
      return data;
    },
  },
  {
    name: 'consultar_estado_financiero_integral',
    description: 'Estado financiero integral: ingresos por canal, egresos por categoría, serie de resultado y patrimonio neto aproximado del período. Usar para "cuál es nuestro patrimonio neto", "estado financiero", "cómo está la situación financiera general", "resultado del período agrupado por mes/año". Es el reporte más completo, para preguntas de nivel dueño sobre la salud financiera general (no para un dato puntual como una factura o un cobro).',
    roles: ['dueno', 'admin', 'contador'],
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: `Ventana de días hacia atrás. Si no lo dicen, usar ${DIAS_DEFAULT}. Tope ${DIAS_TOPE}.` },
        agrupacion: { type: 'string', enum: AGRUPACIONES_VALIDAS, description: 'Cómo agrupar la serie de resultado: "dia", "mes" o "anio". Si no lo dicen, usar "mes".' },
      },
    },
    async execute({ empresaId, args }) {
      const { desde, hasta } = armarRangoFechas(args.dias);
      const agrupacion = AGRUPACIONES_VALIDAS.includes(args.agrupacion) ? args.agrupacion : 'mes';
      const { data, error } = await db.rpc('obtener_estado_financiero_integral', {
        p_empresa_id: empresaId,
        p_desde: desde,
        p_hasta: hasta,
        p_agrupacion: agrupacion,
      });
      if (error) throw new Error(`consultar_estado_financiero_integral: ${error.message}`);
      return data;
    },
  },
];

export { TOOLS_REPORTES };
