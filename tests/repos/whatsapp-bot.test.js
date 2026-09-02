// tests/repos/whatsapp-bot.test.js
//
// Fase 7, paso 7, lote 4 — cubre las funciones de `lib/repos/whatsapp-bot.js`
// (repo nuevo, ver su cabecera). Mismo query builder falso que
// tests/repos/notif.test.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  obtenerCredencialesWhatsapp, guardarCredencialesWhatsapp,
  buscarConversacionAbiertaPorTelefono, obtenerEmpresaPorPhoneNumberId,
  buscarClientePorTelefonoEnEmpresa, resolverClientePorTelefonoRpc,
  buscarConversacionAbiertaId, crearConversacion,
  obtenerEstadoYBorrador, marcarConversacionActiva,
  reiniciarBorradorConversacion, cerrarConversacionConPedido,
  marcarConversacionDerivada, obtenerConversacionEmpresaTelefono,
  obtenerConversacionParaAccion, tomarConversacion, liberarConversacion,
  registrarMensajeWhatsapp, obtenerHistorialMensajes, contarMensajesEntrantes,
  obtenerClienteParaPedidoWhatsapp,
  resolverPreciosClienteRpc, crearPedidoClienteRpc, obtenerNumeroPedido,
  obtenerSalientesPendientes, marcarSalienteEnviado, marcarSalienteFallido,
  MAX_INTENTOS_SALIENTE,
} = await import('../../lib/repos/whatsapp-bot.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    upsert:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    neq:         vi.fn(() => obj),
    in:          vi.fn(() => obj),
    not:         vi.fn(() => obj),
    order:       vi.fn(() => obj),
    limit:       vi.fn(() => obj),
    single:      vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then:        (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

// ── Credenciales ──────────────────────────────────────────────────────────

describe('obtenerCredencialesWhatsapp', () => {
  it('consulta empresa_whatsapp por empresa_id y devuelve { data, error } tal cual', async () => {
    const query = fakeQuery({ data: { phone_number_id: 'p1', access_token: 'enc', envios_habilitados: true }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerCredencialesWhatsapp('e1');

    expect(dbMock.from).toHaveBeenCalledWith('empresa_whatsapp');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(res).toEqual({ data: { phone_number_id: 'p1', access_token: 'enc', envios_habilitados: true }, error: null });
  });

  it('devuelve data null si la empresa no tiene número propio', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    const res = await obtenerCredencialesWhatsapp('e1');
    expect(res.data).toBeNull();
  });
});

describe('guardarCredencialesWhatsapp', () => {
  it('hace upsert con onConflict empresa_id', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    const payload = { empresa_id: 'e1', waba_id: 'w1', phone_number_id: 'p1' };
    const res = await guardarCredencialesWhatsapp(payload);

    expect(dbMock.from).toHaveBeenCalledWith('empresa_whatsapp');
    expect(query.upsert).toHaveBeenCalledWith(payload, { onConflict: 'empresa_id' });
    expect(res).toEqual({ error: null });
  });
});

// ── Matching teléfono → empresa/cliente ──────────────────────────────────

describe('buscarConversacionAbiertaPorTelefono', () => {
  it('filtra por telefono y estado != cerrada', async () => {
    const query = fakeQuery({ data: { empresa_id: 'e1', cliente_id: 'c1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await buscarConversacionAbiertaPorTelefono('5491100000000');

    expect(dbMock.from).toHaveBeenCalledWith('whatsapp_conversaciones');
    expect(query.eq).toHaveBeenCalledWith('telefono', '5491100000000');
    expect(query.neq).toHaveBeenCalledWith('estado', 'cerrada');
    expect(res).toEqual({ empresa_id: 'e1', cliente_id: 'c1' });
  });

  it('devuelve undefined/null si no hay conversación abierta', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    expect(await buscarConversacionAbiertaPorTelefono('5491100000000')).toBeNull();
  });
});

describe('obtenerEmpresaPorPhoneNumberId', () => {
  it('busca en empresa_whatsapp por phone_number_id', async () => {
    const query = fakeQuery({ data: { empresa_id: 'e1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerEmpresaPorPhoneNumberId('p1');

    expect(query.eq).toHaveBeenCalledWith('phone_number_id', 'p1');
    expect(res).toEqual({ empresa_id: 'e1' });
  });
});

describe('buscarClientePorTelefonoEnEmpresa', () => {
  it('filtra por empresa_id y telefono', async () => {
    const query = fakeQuery({ data: { id: 'c1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await buscarClientePorTelefonoEnEmpresa('e1', '5491100000000');

    expect(dbMock.from).toHaveBeenCalledWith('clientes');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('telefono', '5491100000000');
    expect(res).toEqual({ id: 'c1' });
  });
});

describe('resolverClientePorTelefonoRpc', () => {
  it('llama al rpc con p_telefono y devuelve { data, error } tal cual', async () => {
    dbMock.rpc.mockResolvedValue({ data: [{ empresa_id: 'e1', cliente_id: 'c1' }], error: null });

    const res = await resolverClientePorTelefonoRpc('5491100000000');

    expect(dbMock.rpc).toHaveBeenCalledWith('resolver_cliente_por_telefono', { p_telefono: '5491100000000' });
    expect(res).toEqual({ data: [{ empresa_id: 'e1', cliente_id: 'c1' }], error: null });
  });

  it('propaga el error sin lanzar', async () => {
    dbMock.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await resolverClientePorTelefonoRpc('5491100000000');
    expect(res.error).toEqual({ message: 'boom' });
  });
});

// ── Conversación ──────────────────────────────────────────────────────────

describe('buscarConversacionAbiertaId', () => {
  it('solo pide el id, telefono y estado != cerrada', async () => {
    const query = fakeQuery({ data: { id: 'conv1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await buscarConversacionAbiertaId('5491100000000');

    expect(query.select).toHaveBeenCalledWith('id');
    expect(res).toEqual({ id: 'conv1' });
  });
});

describe('crearConversacion', () => {
  it('inserta con estado activa y borrador vacío, devuelve el id', async () => {
    const query = fakeQuery({ data: { id: 'conv1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const id = await crearConversacion({ telefono: '5491100000000', empresa_id: 'e1', cliente_id: 'c1' });

    const arg = query.insert.mock.calls[0][0];
    expect(arg).toMatchObject({
      telefono: '5491100000000', empresa_id: 'e1', cliente_id: 'c1',
      estado: 'activa', pedido_borrador: { items: [] },
    });
    expect(typeof arg.turno_desde).toBe('string');
    expect(id).toBe('conv1');
  });

  it('lanza con prefijo [WhatsappBotRepo.crearConversacion] si falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    await expect(crearConversacion({ telefono: 't', empresa_id: 'e1', cliente_id: 'c1' }))
      .rejects.toThrow('[WhatsappBotRepo.crearConversacion] boom');
  });
});

describe('obtenerEstadoYBorrador', () => {
  it('trae estado y pedido_borrador por id', async () => {
    const query = fakeQuery({
      data: { estado: 'activa', pedido_borrador: { items: [] }, ultima_interaccion: null, turno_desde: '2026-08-07T12:00:00.000Z' },
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerEstadoYBorrador('conv1');

    expect(query.select).toHaveBeenCalledWith('estado, pedido_borrador, ultima_interaccion, turno_desde');
    expect(query.eq).toHaveBeenCalledWith('id', 'conv1');
    expect(res).toEqual({
      estado: 'activa', pedido_borrador: { items: [] }, ultima_interaccion: null, turno_desde: '2026-08-07T12:00:00.000Z',
    });
  });
});

describe('marcarConversacionActiva', () => {
  it('actualiza estado a activa y resetea turno_desde (FIX 2026-08-04: evita que el corte de MAX_TURNOS_SIN_CONFIRMAR arrastre mensajes de rondas viejas)', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await marcarConversacionActiva('conv1');

    const arg = query.update.mock.calls[0][0];
    expect(arg.estado).toBe('activa');
    expect(typeof arg.turno_desde).toBe('string');
    expect(query.eq).toHaveBeenCalledWith('id', 'conv1');
  });
});

describe('reiniciarBorradorConversacion', () => {
  it('vuelve a activa con borrador vacío y actualiza ultima_interaccion', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await reiniciarBorradorConversacion('conv1');

    const arg = query.update.mock.calls[0][0];
    expect(arg.estado).toBe('activa');
    expect(arg.pedido_borrador).toEqual({ items: [] });
    expect(typeof arg.ultima_interaccion).toBe('string');
    // FIX (2026-08-04): mismo motivo que marcarConversacionActiva.
    expect(typeof arg.turno_desde).toBe('string');
    expect(arg.turno_desde).toBe(arg.ultima_interaccion);
  });
});

describe('cerrarConversacionConPedido', () => {
  it('cierra la conversación con el pedido_creado_id', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await cerrarConversacionConPedido('conv1', 'ped1');

    const arg = query.update.mock.calls[0][0];
    expect(arg.estado).toBe('cerrada');
    expect(arg.pedido_creado_id).toBe('ped1');
  });
});

describe('marcarConversacionDerivada', () => {
  it('marca derivada_humano con el motivo', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await marcarConversacionDerivada('conv1', 'no entiende');

    const arg = query.update.mock.calls[0][0];
    expect(arg.estado).toBe('derivada_humano');
    expect(arg.motivo_derivacion).toBe('no entiende');
  });
});

describe('obtenerConversacionEmpresaTelefono', () => {
  it('trae empresa_id y telefono por id', async () => {
    const query = fakeQuery({ data: { empresa_id: 'e1', telefono: 't1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerConversacionEmpresaTelefono('conv1');

    expect(query.select).toHaveBeenCalledWith('empresa_id, telefono');
    expect(res).toEqual({ empresa_id: 'e1', telefono: 't1' });
  });
});

describe('obtenerConversacionParaAccion', () => {
  it('trae los 4 campos que usa el panel admin, devuelve { data, error }', async () => {
    const query = fakeQuery({ data: { id: 'conv1', empresa_id: 'e1', estado: 'derivada_humano', tomada_por: null }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerConversacionParaAccion('conv1');

    expect(query.select).toHaveBeenCalledWith('id, empresa_id, estado, tomada_por');
    expect(res.data.empresa_id).toBe('e1');
    expect(res.error).toBeNull();
  });
});

describe('tomarConversacion', () => {
  it('setea tomada_por y tomada_en', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    const res = await tomarConversacion('conv1', 'u1');

    const arg = query.update.mock.calls[0][0];
    expect(arg.tomada_por).toBe('u1');
    expect(typeof arg.tomada_en).toBe('string');
    expect(res).toEqual({ error: null });
  });
});

describe('liberarConversacion', () => {
  it('resetea tomada_por y tomada_en a null', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await liberarConversacion('conv1');

    expect(query.update).toHaveBeenCalledWith({ tomada_por: null, tomada_en: null });
  });
});

// ── Mensajes ──────────────────────────────────────────────────────────────

describe('registrarMensajeWhatsapp', () => {
  it('inserta el mensaje con tipo/wa_message_id/metadata default', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await registrarMensajeWhatsapp({ conversacion_id: 'conv1', direccion: 'in', texto: 'hola' });

    expect(dbMock.from).toHaveBeenCalledWith('whatsapp_mensajes');
    expect(query.insert).toHaveBeenCalledWith({
      conversacion_id: 'conv1', direccion: 'in', wa_message_id: null, texto: 'hola', tipo: 'text', metadata: null,
    });
  });

  it('inserta metadata cuando se pasa (outbox de salientes, Etapa 5 punto 3 — v657)', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await registrarMensajeWhatsapp({
      conversacion_id: 'conv1', direccion: 'out', texto: 'hola', metadata: { estado_envio: 'pendiente' },
    });

    expect(query.insert).toHaveBeenCalledWith({
      conversacion_id: 'conv1', direccion: 'out', wa_message_id: null, texto: 'hola', tipo: 'text',
      metadata: { estado_envio: 'pendiente' },
    });
  });

  it('propaga { error } tal cual (incluido conflicto 23505 de duplicado)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { code: '23505', message: 'dup' } }));
    const res = await registrarMensajeWhatsapp({ conversacion_id: 'conv1', direccion: 'in', texto: 'hola' });
    expect(res.error.code).toBe('23505');
  });
});

describe('obtenerHistorialMensajes', () => {
  it('ordena por created_at desc y respeta el límite', async () => {
    const query = fakeQuery({ data: [{ direccion: 'in', texto: 'hola' }], error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerHistorialMensajes('conv1', { limite: 5 });

    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(5);
    expect(res).toEqual([{ direccion: 'in', texto: 'hola' }]);
  });

  it('usa límite default 10 y devuelve [] si no hay data', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerHistorialMensajes('conv1');

    expect(query.limit).toHaveBeenCalledWith(10);
    expect(res).toEqual([]);
  });
});

describe('contarMensajesEntrantes', () => {
  it('cuenta con head:true filtrando conversacion_id y direccion=in', async () => {
    const query = fakeQuery({ count: 4, error: null });
    dbMock.from.mockReturnValue(query);

    const n = await contarMensajesEntrantes('conv1');

    expect(query.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(query.eq).toHaveBeenCalledWith('conversacion_id', 'conv1');
    expect(query.eq).toHaveBeenCalledWith('direccion', 'in');
    expect(n).toBe(4);
  });

  it('devuelve 0 si count viene null', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ count: null, error: null }));
    expect(await contarMensajesEntrantes('conv1')).toBe(0);
  });
});

// ── Creación de pedido desde el bot ──────────────────────────────────────

describe('obtenerClienteParaPedidoWhatsapp', () => {
  it('filtra por id y empresa_id, devuelve { data, error } con deposito_id', async () => {
    const query = fakeQuery({ data: { id: 'c1', activo: true, limite_credito: 1000, saldo_deuda: 0, deposito_id: 'd1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerClienteParaPedidoWhatsapp('c1', 'e1');

    expect(dbMock.from).toHaveBeenCalledWith('clientes');
    expect(query.eq).toHaveBeenCalledWith('id', 'c1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(res.data.activo).toBe(true);
    expect(res.data.deposito_id).toBe('d1');
  });
});

// obtenerStockParaPedidoWhatsapp (miraba solo es_principal) fue reemplazada
// por resolverDepositoParaPedido + obtenerStockPorDeposito en
// lib/repos/depositos.js — ver tests/repos/depositos.test.js.

describe('resolverPreciosClienteRpc', () => {
  it('llama al rpc con los p_ params esperados', async () => {
    dbMock.rpc.mockResolvedValue({ data: [{ producto_id: 'p1', precio: 100 }], error: null });

    await resolverPreciosClienteRpc({ cliente_id: 'c1', producto_ids: ['p1'], empresa_id: 'e1' });

    expect(dbMock.rpc).toHaveBeenCalledWith('resolver_precios_cliente', {
      p_cliente_id: 'c1', p_producto_ids: ['p1'], p_empresa_id: 'e1',
    });
  });
});

describe('crearPedidoClienteRpc', () => {
  it('pasa el payload tal cual al rpc crear_pedido_cliente', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, pedido_id: 'ped1' }, error: null });

    const payload = { p_empresa_id: 'e1', p_cliente_id: 'c1', p_canal: 'whatsapp' };
    const res = await crearPedidoClienteRpc(payload);

    expect(dbMock.rpc).toHaveBeenCalledWith('crear_pedido_cliente', payload);
    expect(res.data.pedido_id).toBe('ped1');
  });
});

describe('obtenerNumeroPedido', () => {
  it('trae numero_pedido por id', async () => {
    const query = fakeQuery({ data: { numero_pedido: 42 }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerNumeroPedido('ped1');

    expect(dbMock.from).toHaveBeenCalledWith('pedidos');
    expect(query.select).toHaveBeenCalledWith('numero_pedido');
    expect(res).toEqual({ numero_pedido: 42 });
  });
});

// ── Outbox de salientes (Etapa 5 offline, punto 3 — v657) ─────────────────
// Hueco identificado en PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md,
// sección 0: hasta v657 estas 3 funciones no tenían ningún test, pese a
// ser las que sostienen el cron diario de reintento
// (`handleWhatsappSalientesReprocesarCron`, lib/handlers/notif.js).

describe('obtenerSalientesPendientes', () => {
  it('filtra direccion=out y estado_envio=pendiente, ordena por más viejo primero, límite default 200', async () => {
    const filas = [
      { id: 'm1', texto: 'hola', metadata: { estado_envio: 'pendiente' }, conversacion_id: 'c1',
        whatsapp_conversaciones: { telefono: '549341...', empresa_id: 'e1' } },
    ];
    const query = fakeQuery({ data: filas, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerSalientesPendientes();

    expect(dbMock.from).toHaveBeenCalledWith('whatsapp_mensajes');
    expect(query.select).toHaveBeenCalledWith(
      'id, texto, metadata, conversacion_id, whatsapp_conversaciones!inner(telefono, empresa_id)'
    );
    expect(query.eq).toHaveBeenCalledWith('direccion', 'out');
    expect(query.eq).toHaveBeenCalledWith('metadata->>estado_envio', 'pendiente');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(query.limit).toHaveBeenCalledWith(200);
    expect(res).toEqual({ data: filas, error: null });
  });

  it('respeta un límite explícito distinto del default', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerSalientesPendientes(50);

    expect(query.limit).toHaveBeenCalledWith(50);
  });

  it('devuelve [] (no null/undefined) si data viene vacío, para que el caller pueda iterar sin chequear', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerSalientesPendientes();

    expect(res.data).toEqual([]);
  });

  it('propaga el error tal cual si la consulta falla', async () => {
    const query = fakeQuery({ data: null, error: { message: 'timeout' } });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerSalientesPendientes();

    expect(res.error).toEqual({ message: 'timeout' });
  });
});

describe('marcarSalienteEnviado', () => {
  it('guarda el wa_message_id real y pasa estado_envio a enviado', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await marcarSalienteEnviado('m1', 'wamid.ABC123');

    expect(dbMock.from).toHaveBeenCalledWith('whatsapp_mensajes');
    expect(query.update).toHaveBeenCalledWith({
      wa_message_id: 'wamid.ABC123',
      metadata: { estado_envio: 'enviado' },
    });
    expect(query.eq).toHaveBeenCalledWith('id', 'm1');
  });

  it('graba wa_message_id null si el envío no devolvió id (no debe romper)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await marcarSalienteEnviado('m1', undefined);

    expect(query.update).toHaveBeenCalledWith({
      wa_message_id: null,
      metadata: { estado_envio: 'enviado' },
    });
  });
});

describe('marcarSalienteFallido', () => {
  it('suma un intento y mantiene estado_envio=pendiente por debajo del tope', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await marcarSalienteFallido('m1', 3, 'timeout de Meta');

    expect(query.update).toHaveBeenCalledWith({
      metadata: { estado_envio: 'pendiente', intentos: 4, ultimo_error: 'timeout de Meta' },
    });
    expect(query.eq).toHaveBeenCalledWith('id', 'm1');
  });

  it('pasa a agotado justo al llegar a MAX_INTENTOS_SALIENTE (no antes, no después)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    // intentosPrevios = MAX_INTENTOS_SALIENTE - 1 ⇒ este intento llega justo al tope.
    await marcarSalienteFallido('m1', MAX_INTENTOS_SALIENTE - 1, 'sigue caído');

    expect(query.update).toHaveBeenCalledWith({
      metadata: { estado_envio: 'agotado', intentos: MAX_INTENTOS_SALIENTE, ultimo_error: 'sigue caído' },
    });
  });

  it('el intento anterior al tope todavía queda pendiente (guarda contra off-by-one)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await marcarSalienteFallido('m1', MAX_INTENTOS_SALIENTE - 2, 'timeout');

    expect(query.update).toHaveBeenCalledWith({
      metadata: { estado_envio: 'pendiente', intentos: MAX_INTENTOS_SALIENTE - 1, ultimo_error: 'timeout' },
    });
  });

  it('trata intentosPrevios undefined/null como 0 (primer fallo real)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await marcarSalienteFallido('m1', undefined, 'primer intento falló');

    expect(query.update).toHaveBeenCalledWith({
      metadata: { estado_envio: 'pendiente', intentos: 1, ultimo_error: 'primer intento falló' },
    });
  });

  it('graba ultimo_error null si no se pasa motivo', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await marcarSalienteFallido('m1', 0, undefined);

    expect(query.update).toHaveBeenCalledWith({
      metadata: { estado_envio: 'pendiente', intentos: 1, ultimo_error: null },
    });
  });
});
