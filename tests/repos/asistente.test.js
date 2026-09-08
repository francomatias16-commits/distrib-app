// tests/repos/asistente.test.js
//
// Capa 3 de PLAN_QA_ASISTENTE.md (migración 600): insertarUsoAsistente
// suma conversacion_id y tools_usadas al insert de asistente_uso. Foco
// puntual: que se manden tal cual cuando el llamador los pasa, y que los
// defaults (null / []) sigan andando para no romper ningún llamador
// viejo que no los pase todavía.

import { vi, describe, it, expect } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { insertarUsoAsistente } = await import('../../lib/repos/asistente.js');

function fakeQuery(result) {
  const obj = {
    insert: vi.fn(() => obj),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

describe('insertarUsoAsistente', () => {
  it('inserta conversacion_id y tools_usadas cuando el llamador los pasa', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await insertarUsoAsistente({
      usuario_id: 'user-1',
      empresa_id: 'empresa-1',
      pregunta: 'cuántos clientes tienen deuda',
      proveedor_usado: 'gemini',
      articulos_encontrados: 0,
      latencia_ms: 850,
      conversacion_id: 'conv-1',
      tools_usadas: ['listar_clientes_por_deuda'],
    });

    expect(dbMock.from).toHaveBeenCalledWith('asistente_uso');
    expect(query.insert).toHaveBeenCalledWith({
      usuario_id: 'user-1',
      empresa_id: 'empresa-1',
      pregunta: 'cuántos clientes tienen deuda',
      proveedor_usado: 'gemini',
      articulos_encontrados: 0,
      latencia_ms: 850,
      conversacion_id: 'conv-1',
      tools_usadas: ['listar_clientes_por_deuda'],
    });
  });

  it('usa conversacion_id null y tools_usadas [] si el llamador no los pasa', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await insertarUsoAsistente({
      usuario_id: 'user-1',
      empresa_id: 'empresa-1',
      pregunta: 'hola',
      proveedor_usado: 'gemini',
      articulos_encontrados: 0,
      latencia_ms: 500,
    });

    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({ conversacion_id: null, tools_usadas: [] }),
    );
  });

  it('propaga el error de insert sin lanzar (el handler decide qué hacer y loguea)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'boom' } }));
    const { error } = await insertarUsoAsistente({ usuario_id: 'u', empresa_id: 'e' });
    expect(error).toEqual({ message: 'boom' });
  });
});
