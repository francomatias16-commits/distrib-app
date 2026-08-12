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
        update: () => obj,
        eq: () => obj,
        neq: () => obj,
        in: () => obj,
        limit: () => obj,
        order: () => obj,
        not: () => obj,
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

const { procesarMensajeTexto, procesarMensajeNoSoportado } = await import('../../lib/handlers/notif.js');

const TELEFONO = '5493400000000';
const EMPRESA_ID = 'empresa-1';
const CLIENTE_ID = 'cliente-1';
const CONVERSACION_ID = 'conv-1';

beforeEach(() => {
  pushMock.llamadas = [];
  dbMock.colas = {};
  dbMock.rpcColas = {};
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
      // FIX (2026-08-04): MAX_TURNOS_SIN_CONFIRMAR subió de 8 a 20 —
      // el conteo mockeado tiene que superar el umbral nuevo, no el viejo.
      { count: 21, error: null },  // conteo de turnos > 20
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
