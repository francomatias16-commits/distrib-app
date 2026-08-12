// tests/handlers/cliente-en-mora-listener.test.js
//
// PLAN_ERP_SINCRONIZACION_2026.md — Fase 4: listener del evento
// `cliente_en_mora`. Se mockea `crearClienteSupabaseLazy` (solo tabla
// `clientes`, es lo único que resuelve este listener) y
// `enviarAvisoDeudaVencida` (lib/handlers/notif.js) para no depender del
// módulo pesado — este test es sobre el comportamiento del listener
// (resolver cliente, decidir cuándo tirar), no sobre la lógica de WhatsApp.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  clientes: {}, // id -> fila de cliente (o undefined -> "no encontrado")
}));

const avisoMock = vi.hoisted(() => ({
  enviarAvisoDeudaVencida: vi.fn(),
}));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    from: (tabla) => {
      if (tabla !== 'clientes') throw new Error(`tests: tabla inesperada '${tabla}'`);
      return {
        select: () => ({
          eq: (_col, id) => ({
            maybeSingle: () => {
              const fila = dbMock.clientes[id];
              return Promise.resolve(
                fila ? { data: fila, error: null } : { data: null, error: null }
              );
            },
          }),
        }),
      };
    },
  }),
}));

vi.mock('../../lib/handlers/notif.js', () => ({
  enviarAvisoDeudaVencida: avisoMock.enviarAvisoDeudaVencida,
}));

const { listenersClienteEnMora } = await import('../../lib/eventos-listeners/cliente_en_mora.js');
const listener = listenersClienteEnMora[0];

describe('listener cliente_en_mora (Fase 4)', () => {
  beforeEach(() => {
    dbMock.clientes = {};
    avisoMock.enviarAvisoDeudaVencida.mockReset();
  });

  it('resuelve el cliente correcto y llama a enviarAvisoDeudaVencida con evento.empresa_id como fuente de verdad', async () => {
    dbMock.clientes.c1 = { id: 'c1', razon_social: 'Cliente Uno SRL', telefono: '+5491111111111', empresa_id: 'empresa-del-cliente' };
    avisoMock.enviarAvisoDeudaVencida.mockResolvedValue({ ok: true });

    const payload = { cliente_id: 'c1', saldo_vencido: 1500 };
    const evento = { empresa_id: 'empresa-del-evento', payload };

    await listener(payload, evento);

    expect(avisoMock.enviarAvisoDeudaVencida).toHaveBeenCalledWith({
      clienteId: 'c1',
      empresaId: 'empresa-del-evento', // no 'empresa-del-cliente'
      telefono: '+5491111111111',
      razonSocial: 'Cliente Uno SRL',
      saldoVencido: 1500,
    });
  });

  it('tira si el cliente no tiene teléfono', async () => {
    dbMock.clientes.c2 = { id: 'c2', razon_social: 'Cliente Sin Tel', telefono: null, empresa_id: 'e1' };

    await expect(
      listener({ cliente_id: 'c2', saldo_vencido: 100 }, { empresa_id: 'e1' })
    ).rejects.toThrow(/teléfono/);

    expect(avisoMock.enviarAvisoDeudaVencida).not.toHaveBeenCalled();
  });

  it('tira si enviarAvisoDeudaVencida falla', async () => {
    dbMock.clientes.c3 = { id: 'c3', razon_social: 'Cliente Tres', telefono: '+549222', empresa_id: 'e1' };
    avisoMock.enviarAvisoDeudaVencida.mockResolvedValue({ ok: false, motivo: 'error WA — algo se rompió' });

    await expect(
      listener({ cliente_id: 'c3', saldo_vencido: 200 }, { empresa_id: 'e1' })
    ).rejects.toThrow(/algo se rompió/);
  });

  it('tira si el cliente no existe', async () => {
    await expect(
      listener({ cliente_id: 'no-existe', saldo_vencido: 50 }, { empresa_id: 'e1' })
    ).rejects.toThrow(/No se pudo resolver el cliente/);

    expect(avisoMock.enviarAvisoDeudaVencida).not.toHaveBeenCalled();
  });

  it('usa listenerNombre para identificarse ante el despachador', () => {
    expect(listener.listenerNombre).toBe('enviarAvisoDeudaVencida');
  });
});
