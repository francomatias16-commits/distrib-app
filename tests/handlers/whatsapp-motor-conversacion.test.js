// tests/handlers/whatsapp-motor-conversacion.test.js
//
// Etapa 6, plan de pruebas guiado (PLAN_whatsapp_bidireccional_seguimiento.md):
// hasta esta entrega, `procesarMensajeTexto`/`procesarMensajeNoSoportado` no
// tenían ningún test — sólo `crearPedidoDesdeItemsWhatsapp` (el motor de
// precios/stock) y, desde v555, las tools de `whatsapp-pedido-tools.js`
// estaban cubiertas. Faltaba la máquina de estados que las conecta. Se
// exportaron ambas funciones (mismo criterio que crearPedidoDesdeItemsWhatsapp,
// "plan 3.2") para poder testearlas directamente acá.
//
// Cubre 5 de los 8 casos del checklist de Etapa 6:
//   - Cliente no identificado
//   - Reintento de Meta / mensaje duplicado
//   - Arrepentirse a mitad de camino
//   - Corte por exceso de turnos
//   - Mensaje no soportado
// Quedan afuera "Pedido simple" (cubierto indirectamente por
// crearPedidoDesdeItemsWhatsapp) y "Stock insuficiente" (ídem) — ambos ya
// tenían cobertura en whatsapp-pedido-borrador.test.js. "Derivación manual"
// ya quedó cubierta en whatsapp-pedido-tools.test.js.
//
// Se fuerza `esEmpresaDemo` a `true` (mock de demo-mode.js) para que
// enviarTextoWhatsApp tome el camino de whatsappSimulado() y nunca dispare
// un fetch real a la API de Meta ni necesite credenciales — no es lo que se
// está probando acá, sólo el ruteo de estados.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  colas: {},     // tabla -> array de respuestas, se consumen en orden (shift)
  rpcColas: {},  // rpc -> array de respuestas
}));

const pushMock = vi.hoisted(() => ({ llamadas: [] }));

function siguiente(cola, tabla) {
  if (!cola.length) throw new Error(`tests: se quedó sin respuestas encoladas para from('${tabla}')`);
  return cola.shift();
}

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    from: (tabla) => {
      const obj = {
        select: () => obj,
        insert: (payload) => {
          const resultado = siguiente(dbMock.colas[tabla] || [], tabla);
          obj.__ultimoInsert = payload;
          obj.__resultado = typeof resultado === 'function' ? resultado(payload) : resultado;
          return obj;
        },
        update: () => obj,
        eq: () => obj,
        neq: () => obj,
        in: () => obj,
        limit: () => obj,
        order: () => obj,
        not: () => obj,
        is: () => obj,
        single: () => Promise.resolve(siguiente(dbMock.colas[tabla] || [], tabla)),
        maybeSingle: () => Promise.resolve(siguiente(dbMock.colas[tabla] || [], tabla)),
        then: (resolve, reject) =>
          Promise.resolve(obj.__resultado ?? siguiente(dbMock.colas[tabla] || [], tabla)).then(resolve, reject),
      };
      return obj;
    },
    rpc: (nombre, params) => {
      const cola = dbMock.rpcColas[nombre];
      if (!cola || !cola.length) throw new Error(`tests: no hay respuesta encolada para rpc('${nombre}')`);
      const resultado = cola.shift();
      return Promise.resolve(typeof resultado === 'function' ? resultado(params) : resultado);
    },
  }),
}));

// Lote 4: el motor conversacional (whatsapp_conversaciones, whatsapp_mensajes)
// y el aviso a admins/vendedores (usuarios, vía listarUsuariosPorRoles de
// lib/repos/notif.js) pasaron de `supabase` (crearClienteSupabaseLazy,
// mockeado arriba) a lib/repos/whatsapp-bot.js y lib/repos/notif.js, que
// usan `db` de _db.js — mismo mock de colas, duplicado porque las reglas
// de hoisting de vi.mock no dejan compartir la función entre los dos.
vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    from: (tabla) => {
      const obj = {
        select: () => obj,
        insert: (payload) => {
          const resultado = siguiente(dbMock.colas[tabla] || [], tabla);
          obj.__ultimoInsert = payload;
          obj.__resultado = typeof resultado === 'function' ? resultado(payload) : resultado;
          return obj;
        },
        update: (payload) => {
          // Lock de procesamiento (adquirirLockConversacion/liberarLockConversacion,
          // migración 577): se resuelve directo, sin consumir la cola compartida
          // de whatsapp_conversaciones — si no, cada test de este archivo
          // tendría que encolar también estas 2 escrituras nuevas del lock, sin
          // relación con lo que cada caso está probando en realidad. Por
          // defecto el claim siempre gana; `dbMock.lockOcupado` (usado en el
          // describe de "lock ocupado" más abajo) simula que otra invocación
          // ya lo tiene tomado.
          if (payload && Object.prototype.hasOwnProperty.call(payload, 'procesando_desde')) {
            const intentandoTomar = payload.procesando_desde !== null;
            obj.__resultado = (intentandoTomar && dbMock.lockOcupado)
              ? { data: null, error: null }
              : { data: { id: 'lock-ok' }, error: null };
          }
          return obj;
        },
        eq: () => obj,
        neq: () => obj,
        in: () => obj,
        or: () => obj,
        limit: () => obj,
        order: () => obj,
        not: () => obj,
        is: () => obj,
        single: () => Promise.resolve(siguiente(dbMock.colas[tabla] || [], tabla)),
        maybeSingle: () => Promise.resolve(obj.__resultado ?? siguiente(dbMock.colas[tabla] || [], tabla)),
        then: (resolve, reject) =>
          Promise.resolve(obj.__resultado ?? siguiente(dbMock.colas[tabla] || [], tabla)).then(resolve, reject),
      };
      return obj;
    },
    rpc: (nombre, params) => {
      const cola = dbMock.rpcColas[nombre];
      if (!cola || !cola.length) throw new Error(`tests: no hay respuesta encolada para rpc('${nombre}')`);
      const resultado = cola.shift();
      return Promise.resolve(typeof resultado === 'function' ? resultado(params) : resultado);
    },
  },
}));

vi.mock('../../lib/demo-mode.js', () => ({
  esEmpresaDemo: async () => true, // fuerza el camino simulado, sin pegarle a Meta real
  whatsappSimulado: () => ({ message_id: 'wamid-simulado' }),
}));

vi.mock('../../lib/handlers/_push.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    enviarPush: (usuarioId, titulo, cuerpo, datos) => {
      pushMock.llamadas.push({ usuarioId, titulo, cuerpo, datos });
      return Promise.resolve();
    },
  };
});

const { procesarMensajeTexto, procesarMensajeNoSoportado, resolverEmpresaCliente } = await import('../../lib/handlers/notif.js');

const TELEFONO = '5493400000000';
const EMPRESA_ID = 'empresa-1';
const CLIENTE_ID = 'cliente-1';
const CONVERSACION_ID = 'conv-1';

beforeEach(() => {
  pushMock.llamadas = [];
  dbMock.colas = {};
  dbMock.rpcColas = {};
  dbMock.lockOcupado = false;
});

describe('procesarMensajeTexto — cliente no identificado', () => {
  it('no responde nada ni crea conversación si el teléfono no matchea ningún cliente', async () => {
    dbMock.colas.whatsapp_conversaciones = [{ data: null, error: null }]; // sin conversación abierta
    dbMock.rpcColas.resolver_cliente_por_telefono = [{ data: [], error: null }]; // sin matches

    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'hola', waMessageId: 'wamid-1' });

    expect(pushMock.llamadas).toHaveLength(0);
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0); // se consumió la única query esperada, nada más
  });
});

describe('procesarMensajeTexto — reintento de Meta / mensaje duplicado', () => {
  it('corta el flujo sin volver a procesar cuando wa_message_id ya existe', async () => {
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta
      { data: { id: CONVERSACION_ID }, error: null }, // existente
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: { code: '23505', message: 'duplicate key' } }, // insert 'in' choca con el unique
    ];

    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'hola', waMessageId: 'wamid-dup' });

    // Si siguiera de largo, la próxima llamada a whatsapp_conversaciones
    // (leer estado/pedido_borrador) reventaría por falta de respuesta
    // encolada — no reventó, así que efectivamente cortó acá.
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
  });
});

// FIX (v1054 → v1055, Bloque 4): dos mensajes del mismo cliente solapados no
// deben pisarse el borrador entre sí (ver migración 577 y el comentario de
// adquirirLockConversacion en lib/repos/whatsapp-bot.js). Este test cubre el
// caso límite: la otra invocación nunca suelta el lock dentro del
// presupuesto de espera (LOCK_CONVERSACION_TIMEOUT_MS) y el mensaje actual
// corta sin tocar el borrador ni pasar por el asistente.
describe('procesarMensajeTexto — lock de procesamiento ocupado', () => {
  it('avisa que sigue procesando el mensaje anterior y no llama al asistente si no logra tomar el lock', async () => {
    vi.useFakeTimers();
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta
      { data: { id: CONVERSACION_ID }, error: null }, // existente
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el 'in'
      { data: null, error: null }, // registrar el 'out' (aviso de "todavía procesando")
    ];
    dbMock.lockOcupado = true; // otra invocación nunca suelta el lock

    const promesa = procesarMensajeTexto({ telefono: TELEFONO, texto: 'y esto?', waMessageId: 'wamid-lock-ocupado' });
    await vi.advanceTimersByTimeAsync(9000); // supera LOCK_CONVERSACION_TIMEOUT_MS (8s)
    await promesa;

    // Si hubiera seguido de largo pese a no tener el lock, la próxima
    // llamada a whatsapp_conversaciones (leer estado/pedido_borrador)
    // reventaría por falta de respuesta encolada.
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
    expect(pushMock.llamadas).toHaveLength(0); // no deriva, solo pide paciencia

    vi.useRealTimers();
  });
});

describe('procesarMensajeTexto — arrepentirse a mitad de camino', () => {
  it('cancela el borrador y vuelve a estado activa cuando el cliente contesta "no"', async () => {
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta
      { data: { id: CONVERSACION_ID }, error: null }, // existente
      { data: { estado: 'esperando_confirmacion', pedido_borrador: { items: [{ producto_id: 'p1', cantidad: 2 }] } }, error: null }, // select estado
      { error: null }, // update a 'activa' + borrador vacío
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el 'in'
      { data: null, error: null }, // registrar el 'out' (mensaje de cancelación)
    ];

    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'cancelar', waMessageId: 'wamid-cancela' });

    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
    // No debe derivar ni avisar a nadie — es un flujo normal, no un problema.
    expect(pushMock.llamadas).toHaveLength(0);
  });
});

describe('procesarMensajeTexto — corte por exceso de turnos', () => {
  it('deriva a un humano y avisa por push si supera MAX_TURNOS_SIN_CONFIRMAR sin confirmar', async () => {
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta
      { data: { id: CONVERSACION_ID }, error: null }, // existente
      { data: { estado: 'activa', pedido_borrador: { items: [] } }, error: null }, // select estado (no está en confirmación)
      { error: null }, // update a derivada_humano (marcarDerivada)
      { data: { empresa_id: EMPRESA_ID, telefono: TELEFONO }, error: null }, // select empresa_id/telefono (marcarDerivada)
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el 'in'
      // FIX (2026-08-30): MAX_TURNOS_SIN_CONFIRMAR subió de 20 a 50 —
      // el conteo mockeado tiene que superar el umbral nuevo, no el viejo.
      { count: 51, error: null },  // conteo de turnos > 50
      // FIX (2026-08-03): responderYRegistrar ahora registra también el
      // mensaje 'out' de derivación (antes se mandaba con enviarTextoWhatsApp
      // directo, sin dejar rastro en whatsapp_mensajes).
      { data: null, error: null }, // registrar el 'out' ("Te paso con un vendedor...")
    ];
    dbMock.colas.usuarios = [
      { data: [{ id: 'admin-1' }, { id: 'vendedor-1' }], error: null },
    ];

    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'quiero 3kg de algo', waMessageId: 'wamid-turno-9' });

    expect(pushMock.llamadas).toHaveLength(2);
    expect(pushMock.llamadas[0].cuerpo).toBe(`Muchos mensajes sin llegar a confirmar un pedido (${TELEFONO})`);
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
    expect(dbMock.colas.usuarios).toHaveLength(0);
  });
});

// FIX (2026-08-30, atajo por palabra clave para pedir un humano): ver
// comentario de REGEX_HABLAR_HUMANO en notif.js. Antes la única vía de
// derivación por pedido explícito del cliente era que el LLM llamara a la
// tool derivar_humano (cubierto en whatsapp-pedido-tools.test.js) — acá se
// cubre el atajo determinístico que corre ANTES de tocar el LLM.
describe('procesarMensajeTexto — atajo por palabra clave ("hablar con una persona")', () => {
  it('deriva a un humano sin pasar por el LLM cuando el mensaje pide explícitamente una persona', async () => {
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta
      { data: { id: CONVERSACION_ID }, error: null }, // existente
      { data: { estado: 'activa', pedido_borrador: { items: [] } }, error: null }, // select estado
      { error: null }, // update a derivada_humano (marcarDerivada)
      { data: { empresa_id: EMPRESA_ID, telefono: TELEFONO }, error: null }, // select empresa_id/telefono (marcarDerivada)
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el 'in'
      { data: null, error: null }, // registrar el 'out' ("Dale, ya te paso...")
    ];
    dbMock.colas.usuarios = [
      { data: [{ id: 'admin-1' }], error: null },
    ];

    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'quiero hablar con una persona', waMessageId: 'wamid-humano-1' });

    expect(pushMock.llamadas).toHaveLength(1);
    expect(pushMock.llamadas[0].cuerpo).toBe(`El cliente pidió hablar con una persona (${TELEFONO})`);
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
    expect(dbMock.colas.usuarios).toHaveLength(0);
  });

  it('gana por sobre un borrador esperando_confirmacion (se deriva en vez de intentar confirmar)', async () => {
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta
      { data: { id: CONVERSACION_ID }, error: null }, // existente
      { data: { estado: 'esperando_confirmacion', pedido_borrador: { items: [{ producto_id: 'p1', cantidad: 2 }] } }, error: null }, // select estado
      { error: null }, // update a derivada_humano (marcarDerivada)
      { data: { empresa_id: EMPRESA_ID, telefono: TELEFONO }, error: null }, // select empresa_id/telefono (marcarDerivada)
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el 'in'
      { data: null, error: null }, // registrar el 'out' ("Dale, ya te paso...")
    ];
    dbMock.colas.usuarios = [
      { data: [{ id: 'admin-1' }], error: null },
    ];

    // Si esto NO cortara antes de REGEX_CONFIRMA, intentaría confirmar el
    // pedido (rpc crear_pedido_cliente) sin nada encolado para esa rpc, y
    // el test reventaría con "no hay respuesta encolada para rpc(...)".
    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'mejor pasame con un vendedor', waMessageId: 'wamid-humano-2' });

    expect(pushMock.llamadas).toHaveLength(1);
    expect(pushMock.llamadas[0].cuerpo).toBe(`El cliente pidió hablar con una persona (${TELEFONO})`);
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
  });
});

// FIX (2026-08-30, conversación derivada que bloqueaba mensajes nuevos para
// siempre): ver comentario de UMBRAL_CONVERSACION_DERIVADA_EXPIRA_HORAS en
// notif.js. Antes, una conversación 'derivada_humano' vieja y nunca tomada
// por nadie quedaba reusándose para siempre — cualquier mensaje nuevo del
// cliente, sin importar cuántos días pasaran, recibía el mismo mensaje
// enlatado de "ya avisamos, esperá a un vendedor" en vez de que el bot
// arrancara de cero.
describe('procesarMensajeTexto — expiración de conversación derivada vieja', () => {
  const HACE_13_HORAS = new Date(Date.now() - 13 * 3_600_000).toISOString();
  const NUEVA_CONVERSACION_ID = 'conv-nueva-tras-expirar';

  it('cierra la conversación derivada vieja y sin tomar, y arranca una nueva desde cero', async () => {
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta (global)
      // buscarConversacionAbiertaIdPorEmpresa: derivada, sin tomar, de hace 13hs (> umbral de 12hs)
      { data: { id: CONVERSACION_ID, estado: 'derivada_humano', tomada_por: null, ultima_interaccion: HACE_13_HORAS }, error: null },
      { error: null }, // update a 'cerrada' (cerrarConversacionPorExpiracion)
      { error: null }, // insert() de crearConversacion (valor descartado — el mock consume un item acá y otro en el .single() de abajo)
      { data: { id: NUEVA_CONVERSACION_ID }, error: null }, // .single() de crearConversacion — el id que realmente se usa
      { data: { estado: 'activa', pedido_borrador: { items: [] } }, error: null }, // obtenerEstadoYBorrador de la NUEVA conversación
      { error: null }, // update a derivada_humano (marcarDerivada, por el atajo de palabra clave más abajo)
      { data: { empresa_id: EMPRESA_ID, telefono: TELEFONO }, error: null }, // select empresa_id/telefono (marcarDerivada)
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el 'in' — ya contra la conversación NUEVA
      { data: null, error: null }, // registrar el 'out' ("Dale, ya te paso...")
    ];
    dbMock.colas.usuarios = [
      { data: [{ id: 'admin-1' }], error: null },
    ];

    // Un mensaje que dispara el atajo de "hablar con una persona" — sirve
    // para confirmar que, tras expirar la conversación vieja, el flujo
    // sigue normal en la NUEVA (no vuelve a caer en el camino de
    // 'derivada_humano' de la vieja).
    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'quiero hablar con una persona', waMessageId: 'wamid-expira-1' });

    expect(pushMock.llamadas).toHaveLength(1);
    expect(pushMock.llamadas[0].cuerpo).toBe(`El cliente pidió hablar con una persona (${TELEFONO})`);
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
    expect(dbMock.colas.usuarios).toHaveLength(0);
  });

  it('NO cierra la conversación si un vendedor ya la tomó (tomada_por), aunque sea vieja', async () => {
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta (global)
      // buscarConversacionAbiertaIdPorEmpresa: derivada, TOMADA por un vendedor, de hace 13hs
      { data: { id: CONVERSACION_ID, estado: 'derivada_humano', tomada_por: 'vendedor-1', ultima_interaccion: HACE_13_HORAS }, error: null },
      // Si expirara igual, la próxima query sería el update a 'cerrada' —
      // en vez de eso, sigue directo a obtenerEstadoYBorrador de la MISMA
      // conversación (CONVERSACION_ID), que es lo que se espera acá.
      { data: { estado: 'derivada_humano', pedido_borrador: null, ultima_interaccion: HACE_13_HORAS }, error: null },
      { error: null }, // update de actualizarUltimaInteraccion (manejarMensajeEnConversacionDerivada)
      { data: { empresa_id: EMPRESA_ID, telefono: TELEFONO }, error: null }, // select empresa_id/telefono (obtenerConversacionEmpresaTelefono)
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el 'in'
      { data: null, error: null }, // registrar el 'out' ("Ya le avisé a nuestro equipo...")
    ];
    dbMock.colas.usuarios = [
      { data: [{ id: 'vendedor-1' }], error: null },
    ];

    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'hola, sigo esperando', waMessageId: 'wamid-expira-2' });

    // Re-avisa (pasaron 13hs, bien por encima de UMBRAL_REAVISO_DERIVADA_MIN)
    // pero sobre la MISMA conversación — nunca se creó ni se cerró nada.
    expect(pushMock.llamadas).toHaveLength(1);
    expect(pushMock.llamadas[0].titulo).toBe('Cliente esperando respuesta');
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
  });

  it('NO cierra la conversación derivada si todavía está dentro del umbral (12hs)', async () => {
    const HACE_5_MINUTOS = new Date(Date.now() - 5 * 60_000).toISOString();
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta (global)
      { data: { id: CONVERSACION_ID, estado: 'derivada_humano', tomada_por: null, ultima_interaccion: HACE_5_MINUTOS }, error: null },
      // Reusa la MISMA conversación — con solo 5min de inactividad no expiró
      // (muy por debajo del umbral de 12hs).
      { data: { estado: 'derivada_humano', pedido_borrador: null, ultima_interaccion: HACE_5_MINUTOS }, error: null },
      // manejarMensajeEnConversacionDerivada: también está dentro de
      // UMBRAL_REAVISO_DERIVADA_MIN (10min), así que solo actualiza
      // ultima_interaccion y corta ahí — no debe llegar a avisar ni a
      // responderYRegistrar.
      { error: null }, // update de actualizarUltimaInteraccion
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el 'in'
    ];

    await procesarMensajeTexto({ telefono: TELEFONO, texto: 'hola', waMessageId: 'wamid-expira-3' });

    // Si hubiera intentado cerrar/crear una conversación nueva, o
    // re-avisar de más, alguna cola se habría quedado corta y el test
    // hubiera reventado con "se quedó sin respuestas encoladas".
    expect(pushMock.llamadas).toHaveLength(0);
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
  });
});

describe('procesarMensajeNoSoportado', () => {
  it('deriva a un humano y avisa por push cuando llega un tipo de mensaje no soportado (ej. foto)', async () => {
    dbMock.colas.whatsapp_conversaciones = [
      { data: { empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // abierta
      { data: { id: CONVERSACION_ID }, error: null }, // existente
      { error: null }, // update a derivada_humano (marcarDerivada)
      { data: { empresa_id: EMPRESA_ID, telefono: TELEFONO }, error: null }, // select empresa_id/telefono (marcarDerivada)
    ];
    dbMock.colas.whatsapp_mensajes = [
      { data: null, error: null }, // registrar el mensaje entrante (tipo image, texto null)
      // FIX (Etapa 6, drift de v657): procesarMensajeNoSoportado ahora pasa
      // por responderYRegistrar (antes llamaba a enviarTextoWhatsApp
      // directo, sin dejar rastro — ver comentario en notif.js), que
      // registra también el mensaje 'out' de derivación. Mismo patrón que
      // el FIX 2026-08-03 ya aplicado más arriba en este archivo para
      // procesarMensajeTexto.
      { data: null, error: null }, // registrar el 'out' ("Recibimos tu mensaje...")
    ];
    dbMock.colas.usuarios = [
      { data: [{ id: 'admin-1' }], error: null },
    ];

    await procesarMensajeNoSoportado({ from: TELEFONO, id: 'wamid-foto', type: 'image' }, null);

    expect(pushMock.llamadas).toHaveLength(1);
    expect(pushMock.llamadas[0].cuerpo).toBe(`Mensaje tipo "image" no soportado por el asistente automático (${TELEFONO})`);
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.whatsapp_mensajes).toHaveLength(0);
  });
});

// FIX (v965): antes, una conversación empresa-scoped (Etapa 7, Embedded
// Signup — identificada sin ambigüedad por phoneNumberIdReceptor) que ya
// estaba abierta con cliente_id null (típico de un chat importado por el
// historial/eco de Coexistencia antes de que ese contacto existiera como
// cliente) quedaba pegada a ese null para siempre: el bot nunca volvía a
// intentar el match contra `clientes`, ni aunque el cliente se diera de
// alta después. Reportado por CLAY probando Fluxo en vivo.
describe('resolverEmpresaCliente — re-match de cliente en conversación ya abierta sin cliente_id (v965)', () => {
  it('vincula el cliente recién matcheado a la conversación existente en vez de quedar pegado a null', async () => {
    dbMock.colas.empresa_whatsapp = [
      { data: { empresa_id: EMPRESA_ID }, error: null }, // obtenerEmpresaPorPhoneNumberId
    ];
    dbMock.colas.whatsapp_conversaciones = [
      { data: { id: CONVERSACION_ID, empresa_id: EMPRESA_ID, cliente_id: null }, error: null }, // abierta, sin cliente (ej. historial importado)
      { error: null }, // update de vincularClienteAConversacion
    ];
    dbMock.colas.clientes = [
      { data: { id: CLIENTE_ID }, error: null }, // buscarClientePorTelefonoEnEmpresa matchea ahora
    ];

    const resultado = await resolverEmpresaCliente(TELEFONO, 'phone-number-id-1');

    expect(resultado).toEqual({ empresaId: EMPRESA_ID, clienteId: CLIENTE_ID });
    expect(dbMock.colas.empresa_whatsapp).toHaveLength(0);
    expect(dbMock.colas.whatsapp_conversaciones).toHaveLength(0);
    expect(dbMock.colas.clientes).toHaveLength(0);
  });

  it('no pisa un cliente_id ya resuelto (conversación abierta con cliente_id no nulo)', async () => {
    dbMock.colas.empresa_whatsapp = [
      { data: { empresa_id: EMPRESA_ID }, error: null },
    ];
    dbMock.colas.whatsapp_conversaciones = [
      { data: { id: CONVERSACION_ID, empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }, error: null }, // ya tenía cliente
    ];

    const resultado = await resolverEmpresaCliente(TELEFONO, 'phone-number-id-1');

    expect(resultado).toEqual({ empresaId: EMPRESA_ID, clienteId: CLIENTE_ID });
    // No debe tocar `clientes` para nada — el camino corto de siempre.
    expect(dbMock.colas.clientes ?? []).toHaveLength(0);
  });

  it('sigue sin responder si la conversación abierta no tiene cliente y el teléfono tampoco matchea ninguno', async () => {
    dbMock.colas.empresa_whatsapp = [
      { data: { empresa_id: EMPRESA_ID }, error: null },
    ];
    dbMock.colas.whatsapp_conversaciones = [
      { data: { id: CONVERSACION_ID, empresa_id: EMPRESA_ID, cliente_id: null }, error: null },
    ];
    dbMock.colas.clientes = [
      { data: null, error: null }, // sigue sin haber cliente con ese teléfono
    ];

    const resultado = await resolverEmpresaCliente(TELEFONO, 'phone-number-id-1');

    expect(resultado).toEqual({ empresaId: EMPRESA_ID, clienteId: null });
    expect(dbMock.colas.clientes).toHaveLength(0);
  });
});
