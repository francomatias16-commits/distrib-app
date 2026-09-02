// tests/repos/webhooks.test.js
//
// Motor de Integraciones (577_webhooks_recibidos.sql) — cubre
// lib/repos/webhooks.js, la capa de datos detrás del log/dedupe/reintento
// genérico entre integraciones (Mercado Pago, WhatsApp). No tenía tests
// propios. Mismo query builder falso que tests/repos/depositos.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  registrarWebhookEntrante, marcarWebhookError, listarWebhooksParaReintentar,
} = await import('../../lib/repos/webhooks.js');

function fakeInsertQuery(result) {
  const obj = {
    insert: vi.fn(() => obj),
    select: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
  };
  return obj;
}

function fakeSelectQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq:     vi.fn(() => obj),
    lt:     vi.fn(() => obj),
    order:  vi.fn(() => obj),
    limit:  vi.fn(() => obj),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('registrarWebhookEntrante', () => {
  it('registra el evento y devuelve su id cuando la escritura sale bien', async () => {
    const query = fakeInsertQuery({ data: { id: 'log-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const resultado = await registrarWebhookEntrante({
      integracion: 'mercadopago',
      eventoExternoId: '12345',
      tipo: 'payment',
      payload: { data: { id: '12345' } },
    });

    expect(resultado).toEqual({ id: 'log-1', yaProcesado: false });
    expect(dbMock.from).toHaveBeenCalledWith('webhooks_recibidos');
    expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({
      integracion: 'mercadopago',
      evento_externo_id: '12345',
      tipo: 'payment',
      firma_valida: true, // default
    }));
  });

  it('detecta un duplicado por la unique constraint (23505) y no lo trata como error', async () => {
    const query = fakeInsertQuery({ data: null, error: { code: '23505', message: 'duplicate key' } });
    dbMock.from.mockReturnValue(query);

    const resultado = await registrarWebhookEntrante({
      integracion: 'whatsapp',
      eventoExternoId: 'hash-abc',
      payload: {},
    });

    expect(resultado).toEqual({ id: null, yaProcesado: true });
  });

  it('un error de escritura que no es dedupe no bloquea el procesamiento (best-effort)', async () => {
    const query = fakeInsertQuery({ data: null, error: { code: '42P01', message: 'la tabla no existe todavía' } });
    dbMock.from.mockReturnValue(query);

    const resultado = await registrarWebhookEntrante({
      integracion: 'mercadopago',
      eventoExternoId: '999',
      payload: {},
    });

    // No se cae ni se marca como "ya procesado" — sigue de largo sin log.
    expect(resultado).toEqual({ id: null, yaProcesado: false });
  });
});

describe('marcarWebhookError', () => {
  it('llama al RPC atómico con el id y el mensaje recortado a 2000 caracteres', async () => {
    dbMock.rpc.mockResolvedValue({ error: null });

    await marcarWebhookError('log-1', 'x'.repeat(3000));

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_webhook_marcar_error', {
      p_id: 'log-1',
      p_error: 'x'.repeat(2000),
    });
  });

  it('no llama al RPC si no hay id (el registro inicial pudo haber fallado)', async () => {
    await marcarWebhookError(null, 'no importa');
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });
});

describe('listarWebhooksParaReintentar', () => {
  it('filtra por integración cuando se especifica', async () => {
    const query = fakeSelectQuery({ data: [{ id: 'wh-1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const resultado = await listarWebhooksParaReintentar({ integracion: 'mercadopago', maxIntentos: 5, limite: 10 });

    expect(resultado).toEqual([{ id: 'wh-1' }]);
    expect(query.eq).toHaveBeenCalledWith('estado', 'error');
    expect(query.eq).toHaveBeenCalledWith('integracion', 'mercadopago');
    expect(query.lt).toHaveBeenCalledWith('intentos', 5);
  });

  it('sin integración, no filtra por esa columna (trae de todas)', async () => {
    const query = fakeSelectQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarWebhooksParaReintentar({});

    const llamadasEq = query.eq.mock.calls.map((args) => args[0]);
    expect(llamadasEq).toEqual(['estado']); // nunca se llamó eq('integracion', ...)
  });

  it('devuelve una lista vacía (no lanza) si la consulta falla', async () => {
    const query = fakeSelectQuery({ data: null, error: { message: 'timeout' } });
    dbMock.from.mockReturnValue(query);

    const resultado = await listarWebhooksParaReintentar({ integracion: 'whatsapp' });

    expect(resultado).toEqual([]);
  });
});
