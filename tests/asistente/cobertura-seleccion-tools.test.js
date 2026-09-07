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
];

describe('cobertura del selector de tools (seleccionarToolsRelevantes)', () => {
  it.each(CASOS)('rol=$rol · "$pregunta" → incluye $esperada', ({ rol, pregunta, esperada }) => {
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
