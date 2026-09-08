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
import { TOOLS, seleccionarToolsRelevantes, esquemaParaOpenAI } from '../../lib/asistente-tools.js';

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

// ────────────────────────────────────────────────────────────────────────
// Frente 3 de PLAN_OPTIMIZACION_ASISTENTE_2026.md (logging de fallas de
// selección): seleccionarToolsRelevantes() acepta un 3er parámetro
// opcional `metaOut` que muta con { cayoEnNucleoFallback,
// cantidadToolsConMatch } — lib/handlers/asistente.js lo usa para
// registrar esos datos en asistente_uso. Se prueba acá, no en un test de
// handler, porque toda la lógica de scoring vive en esta función pura.
// ────────────────────────────────────────────────────────────────────────
describe('metaOut de seleccionarToolsRelevantes() — Frente 3 (logging)', () => {
  it('pregunta sin ningún match: metaOut marca cayoEnNucleoFallback=true y cantidadToolsConMatch=0', () => {
    const meta = {};
    const elegidas = seleccionarToolsRelevantes(toolsDelRol('dueno'), 'hola, ¿cómo estás?', meta);
    expect(meta.cayoEnNucleoFallback).toBe(true);
    expect(meta.cantidadToolsConMatch).toBe(0);
    expect(elegidas.length).toBeGreaterThan(0); // igual devuelve el set núcleo, no vacío
  });

  it('pregunta con match real: metaOut marca cayoEnNucleoFallback=false y cuenta los matches', () => {
    const meta = {};
    seleccionarToolsRelevantes(toolsDelRol('dueno'), 'cuánto vale mi stock total', meta);
    expect(meta.cayoEnNucleoFallback).toBe(false);
    expect(meta.cantidadToolsConMatch).toBeGreaterThan(0);
  });

  it('sin pasar metaOut, no rompe nada (parámetro opcional)', () => {
    expect(() => seleccionarToolsRelevantes(toolsDelRol('dueno'), 'qué lotes vencen esta semana')).not.toThrow();
  });

  it('esquemaParaOpenAI propaga metaOut a seleccionarToolsRelevantes() sin cambiar su forma de retorno', () => {
    const meta = {};
    const esquema = esquemaParaOpenAI('dueno', 'hola', meta);
    expect(meta.cayoEnNucleoFallback).toBe(true);
    expect(Array.isArray(esquema)).toBe(true);
    expect(esquema[0]).toHaveProperty('type', 'function');
  });

  it('metodoSeleccion queda en "keywords" cuando matcheó por palabra clave', () => {
    const meta = {};
    seleccionarToolsRelevantes(toolsDelRol('dueno'), 'cuánto vale mi stock total', meta);
    expect(meta.metodoSeleccion).toBe('keywords');
  });

  it('metodoSeleccion queda en "nucleo_fallback" cuando no matcheó nada', () => {
    const meta = {};
    seleccionarToolsRelevantes(toolsDelRol('dueno'), 'hola, ¿cómo estás?', meta);
    expect(meta.metodoSeleccion).toBe('nucleo_fallback');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Frente 2 de PLAN_OPTIMIZACION_ASISTENTE_2026.md (selección semántica):
// seleccionarToolsRelevantes()/esquemaParaOpenAI() aceptan un 4to
// parámetro opcional `sugerenciasSemanticas` — un array de tool_nombre ya
// ordenado por similitud (la salida cruda, sin el objeto {similarity}, de
// buscar_tools_asistente_rpc()). Estos tests documentan PRIMERO los casos
// de sinónimo que el matcheo por keyword no resuelve (mismo criterio que
// pide el propio plan: "documentarlos ANTES de arreglar"), y después
// confirman que, pasando la sugerencia semántica que en producción vendría
// de la RPC, el caso SÍ se resuelve. No se llama a Gemini ni a Supabase
// acá: `sugerenciasSemanticas` se simula a mano, la función que la
// consume es pura.
// ────────────────────────────────────────────────────────────────────────
describe('sinónimos que el matcheo por keyword no resuelve (documentado ANTES del Frente 2)', () => {
  const CASOS_SINONIMO = [
    // "moroso"/"morosos" no aparece en ningún lado de
    // listar_clientes_por_deuda (ni nombre ni description) — ver
    // lib/asistente-tools/clientes.js. Keyword no lo encuentra.
    // OJO: tiene que ser la palabra sola ("morosos"), sin "clientes" —
    // "clientes morosos" SÍ matchea igual por keyword, pero por la
    // palabra "clientes" (aparece literal en el nombre de la tool,
    // listar_CLIENTES_por_deuda), no por ningún sinónimo de "moroso". Eso
    // haría que el caso "documentara" un gap que en realidad no existe.
    { rol: 'dueno', pregunta: 'morosos', esperada: 'listar_clientes_por_deuda' },
  ];

  it.each(CASOS_SINONIMO)(
    'rol=$rol · "$pregunta" → SIN sugerencia semántica, NO incluye $esperada (matchea por keyword, sin sinónimo)',
    ({ rol, pregunta, esperada }) => {
      const elegidas = nombresElegidos(rol, pregunta);
      expect(elegidas).not.toContain(esperada);
    },
  );

  it.each(CASOS_SINONIMO)(
    'rol=$rol · "$pregunta" → CON sugerencia semántica (como la traería la RPC), SÍ incluye $esperada',
    ({ rol, pregunta, esperada }) => {
      const elegidas = seleccionarToolsRelevantes(toolsDelRol(rol), pregunta, undefined, [esperada]).map((t) => t.name);
      expect(elegidas).toContain(esperada);
    },
  );
});

describe('sugerenciasSemanticas de seleccionarToolsRelevantes() — Frente 2', () => {
  it('con sugerencia semántica válida para el rol: la usa directamente, sin evaluar keywords, metodoSeleccion="semantica"', () => {
    const meta = {};
    // Pregunta irrelevante a propósito (no matchea nada por keyword) para
    // dejar en claro que lo que decide acá es la sugerencia, no el texto.
    const elegidas = seleccionarToolsRelevantes(
      toolsDelRol('dueno'),
      'xyz sin relación alguna',
      meta,
      ['listar_clientes_por_deuda', 'consultar_stock_critico'],
    );
    expect(elegidas.map((t) => t.name)).toEqual(['listar_clientes_por_deuda', 'consultar_stock_critico']);
    expect(meta.cayoEnNucleoFallback).toBe(false);
    expect(meta.cantidadToolsConMatch).toBe(2);
    expect(meta.metodoSeleccion).toBe('semantica');
  });

  it('respeta el orden por similitud recibido (no reordena)', () => {
    const elegidas = seleccionarToolsRelevantes(
      toolsDelRol('dueno'),
      'algo',
      undefined,
      ['consultar_stock_critico', 'listar_clientes_por_deuda'],
    ).map((t) => t.name);
    expect(elegidas).toEqual(['consultar_stock_critico', 'listar_clientes_por_deuda']);
  });

  it('sugerencia con una tool que el rol actual no puede ver: se descarta esa entrada, se queda con el resto', () => {
    // consultar_situacion_bcra_cliente no está en los roles de 'vendedor'
    // (ver clientes.js) — no debería colarse aunque la RPC la sugiera.
    const elegidas = seleccionarToolsRelevantes(
      toolsDelRol('vendedor'),
      'algo',
      undefined,
      ['consultar_situacion_bcra_cliente', 'consultar_bloqueo_cliente'],
    ).map((t) => t.name);
    expect(elegidas).not.toContain('consultar_situacion_bcra_cliente');
    expect(elegidas).toContain('consultar_bloqueo_cliente');
  });

  it('sugerencia semántica sin NINGUNA tool válida para el rol: cae al matcheo por keyword (no rompe, no devuelve vacío si hay match)', () => {
    const meta = {};
    // 'depositero' (no 'vendedor'): consultar_stock_critico tiene
    // roles ['dueno','admin','depositero'] — con 'vendedor' la tool ni
    // siquiera está en toolsDelRol, así que nunca podría aparecer pase
    // lo que pase con la selección, y el test no probaría nada real.
    const elegidas = seleccionarToolsRelevantes(
      toolsDelRol('depositero'),
      'qué productos tienen stock crítico',
      meta,
      ['consultar_situacion_bcra_cliente'], // única sugerencia, y no es del rol
    ).map((t) => t.name);
    expect(elegidas).toContain('consultar_stock_critico'); // lo resolvió el keyword, no la semántica
    expect(meta.metodoSeleccion).toBe('keywords');
  });

  it('sugerenciasSemanticas vacío ([]) : se comporta como si no se hubiera pasado, usa keyword', () => {
    const meta = {};
    seleccionarToolsRelevantes(toolsDelRol('dueno'), 'cuánto vale mi stock total', meta, []);
    expect(meta.metodoSeleccion).toBe('keywords');
  });

  it('sugerenciasSemanticas null/undefined: no rompe, mismo comportamiento que antes del Frente 2', () => {
    expect(() => seleccionarToolsRelevantes(toolsDelRol('dueno'), 'qué lotes vencen esta semana', undefined, null)).not.toThrow();
  });

  it('esquemaParaOpenAI propaga sugerenciasSemanticas (4to parámetro) sin cambiar la forma del esquema', () => {
    const meta = {};
    const esquema = esquemaParaOpenAI('dueno', 'algo sin relación', meta, ['listar_clientes_por_deuda']);
    expect(meta.metodoSeleccion).toBe('semantica');
    expect(esquema.some((f) => f.function.name === 'listar_clientes_por_deuda')).toBe(true);
  });

  it('respeta el tope TOOLS_MAX_PROVEEDOR_TPM_CHICO también en la rama semántica', () => {
    const nombresDeSobra = toolsDelRol('dueno').map((t) => t.name); // todas, de sobra para pasar el tope
    const meta = {};
    const elegidas = seleccionarToolsRelevantes(toolsDelRol('dueno'), 'algo', meta, nombresDeSobra);
    expect(elegidas.length).toBeLessThanOrEqual(20);
    expect(meta.cantidadToolsConMatch).toBeLessThanOrEqual(20);
  });
});
