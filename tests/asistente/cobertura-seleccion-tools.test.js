// tests/asistente/cobertura-seleccion-tools.test.js
//
// Por qué existe: la suite de tests del asistente (el resto de
// tests/asistente/*.test.js) prueba que cada tool EJECUTA bien una vez que
// el modelo la elige. Nada probaba que fuera a elegirse en primer lugar.
// De ahí salieron 2 bugs reales en la sesión de v1066/v1067:
//   1. Una tool nueva (listar_clientes_por_deuda) que el modelo no
//      encontraba porque no existía ninguna tool de consulta agregada de
//      deuda — esto lo hubiera agarrado un test de este archivo si hubiera
//      existido antes.
//   2. Una repregunta corta ("y 20000") que en el fallback Groq/OpenRouter
//      perdía la tool porque seleccionarToolsRelevantes() solo mira la
//      última pregunta, sin contexto — sección "Repreguntas cortas" abajo.
//
// Este test NO llama a ningún modelo ni a Supabase: seleccionarToolsRelevantes
// es una función pura (scoring por palabras clave), así que corre en
// milisegundos y no cuesta cuota. Es la mitad "¿el catálogo filtrado
// contiene lo que hace falta?" — la otra mitad, "¿la RPC que llama existe
// de verdad?", la cubre scripts/audit-asistente-tools.js (correr aparte,
// necesita conexión a Supabase).
//
// Cómo agregar un caso: cuando una tool nueva no aparezca en una consulta
// real que debería resolver, agregar la pregunta (o la repregunta corta)
// acá con su tool esperada, ANTES de arreglar la description/keywords de
// la tool — así el test falla primero y confirma el fix después.
//
// Capa 1 de PLAN_QA_ASISTENTE.md (2026-09-08): CASOS de abajo prueba una
// sola redacción "prolija" por tool. En producción las preguntas no vienen
// así — hay errores de tipeo/sin tildes, sinónimos y jerga rioplatense.
// CASOS_VARIANTES (más abajo, después de CASOS) suma 2 variantes por cada
// una de las 53 tools con caso en CASOS: una de tipeo/sin tildes y una de
// sinónimo/forma coloquial. CASOS_SEGUIMIENTO (al final del archivo) suma
// 9 repreguntas cortas más a las 3 que ya existían.

import { describe, it, expect } from 'vitest';
import { TOOLS, seleccionarToolsRelevantes } from '../../lib/asistente-tools.js';

function toolsDelRol(rol) {
  return TOOLS.filter((t) => !t.roles || t.roles.includes(rol));
}

function nombresElegidos(rol, pregunta) {
  return seleccionarToolsRelevantes(toolsDelRol(rol), pregunta).map((t) => t.name);
}

// { rol, pregunta, esperada } — "esperada" tiene que aparecer entre las
// tools que devuelve el selector para que el modelo pueda llamarla. No
// exige que sea la primera (el modelo elige entre las que le llegan), solo
// que esté disponible.
const CASOS = [
  // clientes
  { rol: 'dueno', pregunta: 'cuántos clientes tienen más de 150000 en deuda', esperada: 'listar_clientes_por_deuda' },
  { rol: 'dueno', pregunta: 'ranking de deudores', esperada: 'listar_clientes_por_deuda' },
  { rol: 'vendedor', pregunta: 'juan perez está bloqueado?', esperada: 'consultar_bloqueo_cliente' },
  { rol: 'vendedor', pregunta: 'cuántos puntos tiene la cliente maría gonzalez', esperada: 'consultar_puntos_cliente' },
  { rol: 'admin', pregunta: 'dar de baja al cliente distribuidora sur', esperada: 'dar_de_baja_cliente_asistente' },
  { rol: 'admin', pregunta: 'crear un cliente nuevo', esperada: 'crear_cliente' },
  { rol: 'contador', pregunta: 'cuál es la situación en bcra del cliente rodriguez', esperada: 'consultar_situacion_bcra_cliente' },

  // pedidos
  { rol: 'vendedor', pregunta: 'cuántos pedidos pendientes hay', esperada: 'contar_pedidos_pendientes' },
  { rol: 'admin', pregunta: 'por qué falló el pedido 4521', esperada: 'diagnosticar_pedido' },
  { rol: 'admin', pregunta: 'cancelar el pedido de la panaderia del centro', esperada: 'cancelar_pedido_asistente' },
  { rol: 'vendedor', pregunta: 'crear un pedido para el cliente juan perez', esperada: 'crear_pedido' },

  // stock
  { rol: 'depositero', pregunta: 'qué productos tienen stock crítico', esperada: 'consultar_stock_critico' },
  { rol: 'depositero', pregunta: 'qué lotes vencen esta semana', esperada: 'listar_lotes_por_vencer' },
  { rol: 'depositero', pregunta: 'transferir stock del depósito centro al depósito norte', esperada: 'transferir_stock_asistente' },
  { rol: 'admin', pregunta: 'buscá si tengo detergente en stock', esperada: 'consultar_stock_por_texto_asistente' },

  // pos
  { rol: 'vendedor', pregunta: 'por qué no cerró la venta de pos numero 88', esperada: 'diagnosticar_venta_pos' },
  { rol: 'admin', pregunta: 'anular la venta pos A1B2C3', esperada: 'anular_venta_pos' },

  // facturación
  { rol: 'contador', pregunta: 'emitir factura para el pedido 900', esperada: 'emitir_factura' },
  { rol: 'contador', pregunta: 'anular la factura 0001-00004521', esperada: 'anular_factura' },
  { rol: 'contador', pregunta: 'notas de crédito emitidas este mes', esperada: 'listar_notas_credito' },

  // cobranzas
  { rol: 'vendedor', pregunta: 'registrar un cobro del cliente lopez', esperada: 'registrar_cobro_cliente' },
  { rol: 'admin', pregunta: 'movimientos de caja de hoy', esperada: 'listar_movimientos_caja' },
  { rol: 'contador', pregunta: 'listado de cobros de la semana', esperada: 'listar_cobros' },

  // cheques / bcra
  { rol: 'contador', pregunta: 'qué cheques están por vencer', esperada: 'listar_cheques_alerta' },
  { rol: 'contador', pregunta: 'el cheque 12345 figura denunciado en el bcra', esperada: 'consultar_cheque_denunciado_bcra' },

  // precios
  { rol: 'admin', pregunta: 'qué reglas de precio hay activas', esperada: 'listar_reglas_precio_asistente' },
  { rol: 'admin', pregunta: 'crear una regla de precio nueva', esperada: 'crear_regla_precio_asistente' },

  // automatización
  { rol: 'admin', pregunta: 'qué reglas de automatización tengo configuradas', esperada: 'listar_reglas_automatizacion_asistente' },
  { rol: 'admin', pregunta: 'ejecutar el motor de automatización ahora', esperada: 'ejecutar_motor_automatizacion' },

  // conciliación bancaria
  { rol: 'admin', pregunta: 'qué movimientos bancarios están pendientes de conciliar', esperada: 'listar_movimientos_bancarios_pendientes' },
  { rol: 'admin', pregunta: 'candidatos para conciliar este movimiento bancario', esperada: 'consultar_candidatos_conciliacion' },

  // proveedores
  { rol: 'contador', pregunta: 'cuánto le debo al proveedor distrilac', esperada: 'consultar_deuda_proveedor' },
  { rol: 'contador', pregunta: 'facturas de proveedores por vencer', esperada: 'listar_facturas_proveedor_por_vencer' },
  { rol: 'admin', pregunta: 'crear un proveedor nuevo', esperada: 'crear_proveedor' },
  { rol: 'contador', pregunta: 'ranking de ahorro entre proveedores', esperada: 'consultar_ranking_ahorro_proveedores' },

  // logística
  { rol: 'depositero', pregunta: 'cuál es la ruta de hoy del chofer diego', esperada: 'consultar_ruta_dia' },
  { rol: 'admin', pregunta: 'invitar a un chofer nuevo', esperada: 'invitar_chofer_nuevo' },

  // admin / equipo
  { rol: 'admin', pregunta: 'quién tiene acceso al sistema', esperada: 'consultar_usuarios_equipo' },
  { rol: 'dueno', pregunta: 'hubo anomalías en la auditoría', esperada: 'consultar_anomalias_auditoria' },

  // export contable / liquidación
  { rol: 'contador', pregunta: 'exportar los datos contables del mes', esperada: 'generar_export_contable' },
  { rol: 'vendedor', pregunta: 'qué ofertas de liquidación hay activas', esperada: 'consultar_ofertas_liquidacion_asistente' },

  // notificaciones
  { rol: 'admin', pregunta: 'qué notificaciones tengo configuradas', esperada: 'consultar_preferencias_notificaciones' },

  // reportes / resúmenes de negocio (2026-09-07)
  { rol: 'dueno', pregunta: 'dame un resumen ejecutivo del negocio', esperada: 'consultar_resumen_ejecutivo' },
  { rol: 'dueno', pregunta: 'cómo venimos este mes contra el mes pasado', esperada: 'consultar_comparativa_mensual' },
  { rol: 'admin', pregunta: 'cómo se reparten las ventas por canal', esperada: 'consultar_ventas_por_canal' },
  { rol: 'contador', pregunta: 'cuánto le compramos a los proveedores este mes', esperada: 'consultar_resumen_compras_proveedor' },
  { rol: 'contador', pregunta: 'cuánto gastamos este mes', esperada: 'consultar_resumen_gastos_generales' },
  { rol: 'dueno', pregunta: 'cuál es nuestro patrimonio neto', esperada: 'consultar_estado_financiero_integral' },

  // clientes en fuga (frente 2, 2026-09-07)
  { rol: 'dueno', pregunta: 'qué clientes dejaron de comprarnos', esperada: 'consultar_clientes_en_fuga' },
  { rol: 'vendedor', pregunta: 'clientes en fuga que tengo que llamar', esperada: 'consultar_clientes_en_fuga' },

  // stock: valorización y distribución (frente 3, 2026-09-07)
  { rol: 'dueno', pregunta: 'cuánto vale mi stock total', esperada: 'consultar_stock_valorizacion' },
  { rol: 'depositero', pregunta: 'valorización de stock por depósito', esperada: 'consultar_stock_valorizacion' },
  { rol: 'admin', pregunta: 'cómo se distribuye el valor del stock por categoría', esperada: 'consultar_stock_distribucion' },

  // facturación: listado general (frente 4, 2026-09-07)
  { rol: 'contador', pregunta: 'cuánto facturamos este mes', esperada: 'consultar_resumen_facturacion' },
  { rol: 'dueno', pregunta: 'cuántas facturas están pendientes con error afip', esperada: 'consultar_resumen_facturacion' },
  { rol: 'contador', pregunta: 'facturas del mes pasado', esperada: 'listar_facturas' },
  { rol: 'admin', pregunta: 'facturas de la distribuidora sur', esperada: 'listar_facturas' },

  // pedidos: filtros más allá de "pendientes" (frente 5, 2026-09-07)
  { rol: 'vendedor', pregunta: 'pedidos entregados esta semana', esperada: 'listar_pedidos_por_filtro' },
  { rol: 'admin', pregunta: 'historial de pedidos de tal cliente', esperada: 'listar_pedidos_por_filtro' },
  { rol: 'dueno', pregunta: 'pedidos cancelados del mes', esperada: 'listar_pedidos_por_filtro' },
];

describe('cobertura del selector de tools (seleccionarToolsRelevantes)', () => {
  it.each(CASOS)('rol=$rol · "$pregunta" → incluye $esperada', ({ rol, pregunta, esperada }) => {
    const elegidas = nombresElegidos(rol, pregunta);
    expect(elegidas).toContain(esperada);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Capa 1 de PLAN_QA_ASISTENTE.md: variantes más realistas por cada tool de
// CASOS de arriba — error de tipeo/sin tildes, y sinónimo o forma
// coloquial rioplatense. Cada variante se validó a mano contra el
// selector real antes de sumarla acá (no se tocó ninguna description de
// tool para "hacerla pasar" — donde una variante rompía sola por
// ambigüedad real del vocabulario, se reformuló la pregunta, no la tool).
// Un caso de esta lista en rojo es señal real de un hueco de selección:
// sumar la palabra que falta a la description de la tool, siguiendo la
// misma regla de alta que ya declara el comentario de cabecera del
// archivo (Capa 3 → caso acá primero, fix después).
const CASOS_VARIANTES = [
  // clientes
  { rol: 'dueno', pregunta: 'cuantos clientes tienen mas de 150000 en deudaa', esperada: 'listar_clientes_por_deuda' }, // tipeo
  { rol: 'dueno', pregunta: 'quiénes son los clientes que más me deben', esperada: 'listar_clientes_por_deuda' }, // sinonimo
  { rol: 'vendedor', pregunta: 'juan peres esta bloqueado?', esperada: 'consultar_bloqueo_cliente' }, // tipeo
  { rol: 'vendedor', pregunta: 'le puedo vender a juan perez o está bloqueado', esperada: 'consultar_bloqueo_cliente' }, // sinonimo
  { rol: 'vendedor', pregunta: 'cuantos puntos tiene la clienta maria gonzales', esperada: 'consultar_puntos_cliente' }, // tipeo
  { rol: 'vendedor', pregunta: 'maría gonzalez puede canjear puntos de fidelización', esperada: 'consultar_puntos_cliente' }, // sinonimo
  { rol: 'admin', pregunta: 'dar de vaja al cliente distribuidora sur', esperada: 'dar_de_baja_cliente_asistente' }, // tipeo
  { rol: 'admin', pregunta: 'eliminá el cliente distribuidora sur', esperada: 'dar_de_baja_cliente_asistente' }, // sinonimo
  { rol: 'admin', pregunta: 'crear un cliene nuevo', esperada: 'crear_cliente' }, // tipeo
  { rol: 'admin', pregunta: 'cargame un cliente nuevo', esperada: 'crear_cliente' }, // sinonimo
  { rol: 'contador', pregunta: 'cual es la situacion en el bcar del cliente rodriguez', esperada: 'consultar_situacion_bcra_cliente' }, // tipeo
  { rol: 'contador', pregunta: 'el cliente rodriguez tiene cheques rechazados', esperada: 'consultar_situacion_bcra_cliente' }, // sinonimo

  // pedidos
  { rol: 'vendedor', pregunta: 'cuantos pedidos pendiente hay', esperada: 'contar_pedidos_pendientes' }, // tipeo
  { rol: 'vendedor', pregunta: 'cuál es el número total de pedidos que tengo pendientes', esperada: 'contar_pedidos_pendientes' }, // sinonimo
  { rol: 'admin', pregunta: 'porque fallo el pedido 4521', esperada: 'diagnosticar_pedido' }, // tipeo
  { rol: 'admin', pregunta: 'qué pasó con el pedido de la panadería del centro', esperada: 'diagnosticar_pedido' }, // sinonimo
  { rol: 'admin', pregunta: 'cancelar el pedido de la panaderia del sentro', esperada: 'cancelar_pedido_asistente' }, // tipeo
  { rol: 'admin', pregunta: 'anulá el pedido de la panadería del centro', esperada: 'cancelar_pedido_asistente' }, // sinonimo
  { rol: 'vendedor', pregunta: 'crear un pedido para el cliente juan peres', esperada: 'crear_pedido' }, // tipeo
  { rol: 'vendedor', pregunta: 'cargame un pedido nuevo para juan perez', esperada: 'crear_pedido' }, // sinonimo

  // stock
  { rol: 'depositero', pregunta: 'que productos tienen stock critico', esperada: 'consultar_stock_critico' }, // tipeo
  { rol: 'depositero', pregunta: 'cuántos productos tengo por debajo del mínimo de stock', esperada: 'consultar_stock_critico' }, // sinonimo
  { rol: 'depositero', pregunta: 'que lotes bencen esta semana', esperada: 'listar_lotes_por_vencer' }, // tipeo
  { rol: 'depositero', pregunta: 'qué productos están por vencer pronto', esperada: 'listar_lotes_por_vencer' }, // sinonimo
  { rol: 'depositero', pregunta: 'trasnferir stock del deposito centro al deposito norte', esperada: 'transferir_stock_asistente' }, // tipeo
  { rol: 'depositero', pregunta: 'pasá 50 unidades de fideos del depósito centro al norte', esperada: 'transferir_stock_asistente' }, // sinonimo
  { rol: 'admin', pregunta: 'busca si tengo detergnte en stock', esperada: 'consultar_stock_por_texto_asistente' }, // tipeo
  { rol: 'admin', pregunta: 'qué aceites tengo disponibles', esperada: 'consultar_stock_por_texto_asistente' }, // sinonimo

  // pos
  { rol: 'vendedor', pregunta: 'porque no serro la venta de pos numero 88', esperada: 'diagnosticar_venta_pos' }, // tipeo
  { rol: 'vendedor', pregunta: 'la venta de mostrador 88 no tiene factura', esperada: 'diagnosticar_venta_pos' }, // sinonimo
  { rol: 'admin', pregunta: 'anular la benta pos A1B2C3', esperada: 'anular_venta_pos' }, // tipeo
  { rol: 'admin', pregunta: 'cancelá la venta de mostrador A1B2C3', esperada: 'anular_venta_pos' }, // sinonimo

  // facturación
  { rol: 'contador', pregunta: 'emitir factuar para el pedido 900', esperada: 'emitir_factura' }, // tipeo
  { rol: 'contador', pregunta: 'generá el comprobante de venta del pedido 900', esperada: 'emitir_factura' }, // sinonimo
  { rol: 'contador', pregunta: 'anular la fatura 0001-00004521', esperada: 'anular_factura' }, // tipeo
  { rol: 'contador', pregunta: 'dá de baja la factura 0001-00004521', esperada: 'anular_factura' }, // sinonimo
  { rol: 'contador', pregunta: 'notas de credito emitidas este mez', esperada: 'listar_notas_credito' }, // tipeo
  { rol: 'contador', pregunta: 'hay alguna nota de crédito con error de afip', esperada: 'listar_notas_credito' }, // sinonimo

  // cobranzas
  { rol: 'vendedor', pregunta: 'registrar un covro del cliente lopez', esperada: 'registrar_cobro_cliente' }, // tipeo
  { rol: 'vendedor', pregunta: 'cargame un pago que hizo el cliente lopez', esperada: 'registrar_cobro_cliente' }, // sinonimo
  { rol: 'admin', pregunta: 'movimientos de kaja de oy', esperada: 'listar_movimientos_caja' }, // tipeo
  { rol: 'admin', pregunta: 'qué entradas y salidas de caja hubo hoy', esperada: 'listar_movimientos_caja' }, // sinonimo
  { rol: 'contador', pregunta: 'listado de covros de la semana', esperada: 'listar_cobros' }, // tipeo
  { rol: 'contador', pregunta: 'qué pagos recibimos esta semana', esperada: 'listar_cobros' }, // sinonimo

  // cheques / bcra
  { rol: 'contador', pregunta: 'que cheqes estan por vencer', esperada: 'listar_cheques_alerta' }, // tipeo
  { rol: 'contador', pregunta: 'qué cheques tenemos en cartera a punto de caer', esperada: 'listar_cheques_alerta' }, // sinonimo
  { rol: 'contador', pregunta: 'el cheke 12345 figura denunciado en el bcra', esperada: 'consultar_cheque_denunciado_bcra' }, // tipeo
  { rol: 'contador', pregunta: 'el cheque 12345 está reportado como robado o denunciado', esperada: 'consultar_cheque_denunciado_bcra' }, // sinonimo

  // precios
  { rol: 'admin', pregunta: 'que reglas de presio hay activas', esperada: 'listar_reglas_precio_asistente' }, // tipeo
  { rol: 'admin', pregunta: 'qué descuentos automáticos tengo configurados', esperada: 'listar_reglas_precio_asistente' }, // sinonimo
  { rol: 'admin', pregunta: 'crear una regla de presio nueva', esperada: 'crear_regla_precio_asistente' }, // tipeo
  { rol: 'admin', pregunta: 'armame un descuento nuevo por categoría', esperada: 'crear_regla_precio_asistente' }, // sinonimo

  // automatización
  { rol: 'admin', pregunta: 'que reglas de automatisacion tengo configuradas', esperada: 'listar_reglas_automatizacion_asistente' }, // tipeo
  { rol: 'admin', pregunta: 'qué automatizaciones tengo armadas', esperada: 'listar_reglas_automatizacion_asistente' }, // sinonimo
  { rol: 'admin', pregunta: 'ejecutar el motr de automatizacion aora', esperada: 'ejecutar_motor_automatizacion' }, // tipeo
  { rol: 'admin', pregunta: 'corré las automatizaciones ahora', esperada: 'ejecutar_motor_automatizacion' }, // sinonimo

  // conciliación bancaria
  { rol: 'admin', pregunta: 'que movimientos vancarios estan pendientes de conciliar', esperada: 'listar_movimientos_bancarios_pendientes' }, // tipeo
  { rol: 'admin', pregunta: 'qué movimientos del banco todavía no concilié', esperada: 'listar_movimientos_bancarios_pendientes' }, // sinonimo
  { rol: 'admin', pregunta: 'candidatos para conciliar este movimeinto bancario', esperada: 'consultar_candidatos_conciliacion' }, // tipeo
  { rol: 'admin', pregunta: 'con qué movimiento interno puedo emparejar este movimiento bancario', esperada: 'consultar_candidatos_conciliacion' }, // sinonimo

  // proveedores
  { rol: 'contador', pregunta: 'cuanto le devo al proveedor distrilac', esperada: 'consultar_deuda_proveedor' }, // tipeo
  { rol: 'contador', pregunta: 'cuál es nuestra deuda con el proveedor distrilac', esperada: 'consultar_deuda_proveedor' }, // sinonimo
  { rol: 'contador', pregunta: 'facturas de provedores por vencer', esperada: 'listar_facturas_proveedor_por_vencer' }, // tipeo
  { rol: 'contador', pregunta: 'qué facturas de proveedores tenemos que pagar pronto', esperada: 'listar_facturas_proveedor_por_vencer' }, // sinonimo
  { rol: 'admin', pregunta: 'crear un provedor nuevo', esperada: 'crear_proveedor' }, // tipeo
  { rol: 'admin', pregunta: 'cargame un proveedor nuevo', esperada: 'crear_proveedor' }, // sinonimo
  { rol: 'contador', pregunta: 'ranking de aorro entre provedores', esperada: 'consultar_ranking_ahorro_proveedores' }, // tipeo
  { rol: 'contador', pregunta: 'con qué proveedor ahorramos más comprando', esperada: 'consultar_ranking_ahorro_proveedores' }, // sinonimo

  // logística
  { rol: 'depositero', pregunta: 'cual es la ruta de oy del chofer diego', esperada: 'consultar_ruta_dia' }, // tipeo
  { rol: 'depositero', pregunta: 'qué entregas tiene diego para hoy', esperada: 'consultar_ruta_dia' }, // sinonimo
  { rol: 'admin', pregunta: 'invitar a un chofer nuebo', esperada: 'invitar_chofer_nuevo' }, // tipeo
  { rol: 'admin', pregunta: 'sumá un chofer nuevo al sistema', esperada: 'invitar_chofer_nuevo' }, // sinonimo

  // admin / equipo
  { rol: 'admin', pregunta: 'quien tiene aceso al sistema', esperada: 'consultar_usuarios_equipo' }, // tipeo
  { rol: 'admin', pregunta: 'qué usuarios de mi equipo tienen cuenta', esperada: 'consultar_usuarios_equipo' }, // sinonimo
  { rol: 'dueno', pregunta: 'hubo anomalias en la auditoria', esperada: 'consultar_anomalias_auditoria' }, // tipeo
  { rol: 'dueno', pregunta: 'detectaste algo raro o sospechoso en el sistema', esperada: 'consultar_anomalias_auditoria' }, // sinonimo

  // export contable / liquidación
  { rol: 'contador', pregunta: 'exportar los datos contable del mez', esperada: 'generar_export_contable' }, // tipeo
  { rol: 'contador', pregunta: 'necesito el archivo contable para el contador', esperada: 'generar_export_contable' }, // sinonimo
  { rol: 'vendedor', pregunta: 'que ofertas de liquidasion hay activas', esperada: 'consultar_ofertas_liquidacion_asistente' }, // tipeo
  { rol: 'vendedor', pregunta: 'qué productos están en promoción por liquidación', esperada: 'consultar_ofertas_liquidacion_asistente' }, // sinonimo

  // notificaciones
  { rol: 'admin', pregunta: 'qe notificaciones tengo configuradas', esperada: 'consultar_preferencias_notificaciones' }, // tipeo
  { rol: 'admin', pregunta: 'tengo prendidas las notificaciones automáticas de la empresa', esperada: 'consultar_preferencias_notificaciones' }, // sinonimo

  // reportes / resúmenes de negocio
  { rol: 'dueno', pregunta: 'dame un resumen egecutivo del negosio', esperada: 'consultar_resumen_ejecutivo' }, // tipeo
  { rol: 'dueno', pregunta: 'dame un pantallazo general de cómo viene el negocio', esperada: 'consultar_resumen_ejecutivo' }, // sinonimo
  { rol: 'dueno', pregunta: 'como venimos este mez contra el mes pasado', esperada: 'consultar_comparativa_mensual' }, // tipeo
  { rol: 'dueno', pregunta: 'mejoramos o empeoramos respecto al mes anterior', esperada: 'consultar_comparativa_mensual' }, // sinonimo
  { rol: 'admin', pregunta: 'como se reparten las bentas por canal', esperada: 'consultar_ventas_por_canal' }, // tipeo
  { rol: 'admin', pregunta: 'qué porcentaje de ventas viene de whatsapp vs mostrador', esperada: 'consultar_ventas_por_canal' }, // sinonimo
  { rol: 'contador', pregunta: 'cuanto le compramos a los provedores este mez', esperada: 'consultar_resumen_compras_proveedor' }, // tipeo
  { rol: 'contador', pregunta: 'total de compras a proveedores del mes', esperada: 'consultar_resumen_compras_proveedor' }, // sinonimo
  { rol: 'contador', pregunta: 'cuanto gastamos este mez', esperada: 'consultar_resumen_gastos_generales' }, // tipeo
  { rol: 'contador', pregunta: 'cuáles son nuestros gastos generales del mes', esperada: 'consultar_resumen_gastos_generales' }, // sinonimo
  { rol: 'dueno', pregunta: 'cual es nuestro patrimonio nero', esperada: 'consultar_estado_financiero_integral' }, // tipeo
  { rol: 'dueno', pregunta: 'cuál es la situación financiera integral de la empresa', esperada: 'consultar_estado_financiero_integral' }, // sinonimo

  // clientes en fuga
  { rol: 'dueno', pregunta: 'que clientes dejaron de comprarnos', esperada: 'consultar_clientes_en_fuga' }, // tipeo
  { rol: 'vendedor', pregunta: 'qué clientes se me están yendo con la competencia', esperada: 'consultar_clientes_en_fuga' }, // sinonimo

  // stock: valorización y distribución
  { rol: 'dueno', pregunta: 'cuanto bale mi stock total', esperada: 'consultar_stock_valorizacion' }, // tipeo
  { rol: 'depositero', pregunta: 'cuál es el valor total de la mercadería que tengo', esperada: 'consultar_stock_valorizacion' }, // sinonimo
  { rol: 'admin', pregunta: 'como se distribuie el valor del stock por categoria', esperada: 'consultar_stock_distribucion' }, // tipeo
  { rol: 'admin', pregunta: 'en qué categorías está concentrado el valor de mi stock', esperada: 'consultar_stock_distribucion' }, // sinonimo

  // facturación: listado general
  { rol: 'contador', pregunta: 'cuanto facturamos este mez', esperada: 'consultar_resumen_facturacion' }, // tipeo
  { rol: 'dueno', pregunta: 'cuántas facturas quedaron con error de afip', esperada: 'consultar_resumen_facturacion' }, // sinonimo
  { rol: 'contador', pregunta: 'facturas del mez pasado', esperada: 'listar_facturas' }, // tipeo
  { rol: 'admin', pregunta: 'facturas emitidas a la distribuidora sur', esperada: 'listar_facturas' }, // sinonimo

  // pedidos: filtros más allá de pendientes
  { rol: 'vendedor', pregunta: 'pedidos entregados esta semama', esperada: 'listar_pedidos_por_filtro' }, // tipeo
  { rol: 'dueno', pregunta: 'qué pedidos se cancelaron en el mes', esperada: 'listar_pedidos_por_filtro' }, // sinonimo
];

describe('cobertura del selector — variantes de tipeo y sinónimo (Capa 1)', () => {
  it.each(CASOS_VARIANTES)('rol=$rol · "$pregunta" → incluye $esperada', ({ rol, pregunta, esperada }) => {
    const elegidas = nombresElegidos(rol, pregunta);
    expect(elegidas).toContain(esperada);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Repreguntas cortas: mismo bug que resolvió v1067 en
// lib/handlers/asistente.js. seleccionarToolsRelevantes() en sí NO tiene
// memoria de conversación — el fix vive en el handler, que le concatena el
// último mensaje del usuario antes de llamar a esta función. Estos tests
// simulan exactamente esa concatenación para dejar registrado el contrato:
// si el handler alguna vez deja de armar ese contexto, este test lo va a
// mostrar como "sin contexto se pierde la tool" — y confirma que CON
// contexto (como arma el handler real) se recupera.
// ────────────────────────────────────────────────────────────────────────
describe('repreguntas cortas — requieren el contexto de la pregunta anterior', () => {
  // OJO al agregar casos acá: si la tool esperada está en
  // TOOLS_NUCLEO_FALLBACK (arriba en index.js), el caso "sola" va a
  // aparecer igual aunque no haya match real de keywords — porque
  // CUALQUIER pregunta sin match cae a ese set fijo. Eso no prueba nada
  // sobre el bug de contexto perdido. Elegí una tool que NO esté en el
  // fallback para que "sola" de verdad falle y "con contexto" de verdad
  // la recupere.
  const CASOS_SEGUIMIENTO = [
    { rol: 'dueno', anterior: 'cuántos clientes tienen más de 150000 en deuda', repregunta: 'y 20000', esperada: 'listar_clientes_por_deuda' },
    { rol: 'admin', anterior: 'qué lotes vencen esta semana', repregunta: 'y el mes que viene', esperada: 'listar_lotes_por_vencer' },
    { rol: 'contador', anterior: 'el cheque 12345 figura denunciado en el bcra', repregunta: 'y el 67890', esperada: 'consultar_cheque_denunciado_bcra' },

    // sumados en Capa 1 (PLAN_QA_ASISTENTE.md) — mismo criterio: tool que
    // NO está en TOOLS_NUCLEO_FALLBACK, repregunta corta sin ninguna
    // palabra propia del vocabulario de esa tool cuando va sola.
    { rol: 'vendedor', anterior: 'cuántos puntos tiene la cliente maría gonzalez', repregunta: 'y juan perez?', esperada: 'consultar_puntos_cliente' },
    { rol: 'contador', anterior: 'notas de crédito emitidas este mes', repregunta: 'y en marzo?', esperada: 'listar_notas_credito' },
    { rol: 'admin', anterior: 'movimientos de caja de hoy', repregunta: 'y ayer?', esperada: 'listar_movimientos_caja' },
    { rol: 'contador', anterior: 'listado de cobros de la semana', repregunta: 'y del mes?', esperada: 'listar_cobros' },
    { rol: 'admin', anterior: 'qué reglas de precio hay activas', repregunta: 'y las inactivas?', esperada: 'listar_reglas_precio_asistente' },
    { rol: 'admin', anterior: 'qué movimientos bancarios están pendientes de conciliar', repregunta: 'y los de la semana pasada?', esperada: 'listar_movimientos_bancarios_pendientes' },
    { rol: 'contador', anterior: 'ranking de ahorro entre proveedores', repregunta: 'y el mes pasado?', esperada: 'consultar_ranking_ahorro_proveedores' },
    { rol: 'contador', anterior: 'facturas del mes pasado', repregunta: 'y las de la semana pasada?', esperada: 'listar_facturas' },
    { rol: 'vendedor', anterior: 'pedidos entregados esta semana', repregunta: 'y en abril?', esperada: 'listar_pedidos_por_filtro' },
  ];

  it.each(CASOS_SEGUIMIENTO)(
    'rol=$rol · repregunta sola "$repregunta" pierde la tool (documenta el problema que arregla el handler)',
    ({ rol, repregunta, esperada }) => {
      const elegidas = nombresElegidos(rol, repregunta);
      expect(elegidas).not.toContain(esperada);
    },
  );

  it.each(CASOS_SEGUIMIENTO)(
    'rol=$rol · "$anterior" + "$repregunta" (como arma el handler) SÍ incluye $esperada',
    ({ rol, anterior, repregunta, esperada }) => {
      const preguntaConContexto = `${anterior} ${repregunta}`;
      const elegidas = nombresElegidos(rol, preguntaConContexto);
      expect(elegidas).toContain(esperada);
    },
  );
});
