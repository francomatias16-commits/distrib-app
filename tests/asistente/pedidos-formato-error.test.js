// tests/asistente/pedidos-formato-error.test.js
//
// Fase 3 (continuacion) -- tercer lote, sobre lib/asistente-tools/pedidos.js.
// A diferencia de los lotes de stock.js y clientes.js, acá la migración no
// se hizo en pedidos.js sino en los DOS resolvers de _helpers.js que
// comparten las tools de este archivo:
//
//   - buscarPedidoSugeridoPropio (usada por confirmar_pedido_sugerido y
//     descartar_pedido_sugerido): "Falta la referencia del pedido
//     sugerido" pasó a faltaDato(); "Ese pedido está en estado X, no
//     sugerido" pasó a bloqueado(motivo, salida). Esta función devuelve
//     `{ error: <string> }` en vez de tirar (los call sites en pedidos.js
//     hacen `if (pedido.error) throw new Error(pedido.error)`), así que
//     se migró extrayendo `.message` de faltaDato()/bloqueado() — el
//     Error real que llega al usuario sigue siendo un Error genérico sin
//     `.opciones`, pero con el mismo texto que producen esas funciones.
//   - buscarPedidoBorradorPorTexto (usada por modificar_pedido_no_confirmado):
//     mismo criterio, pero esta función SÍ tira directo, así que acá se
//     tira faltaDato()/bloqueado() sin envolver.
//
// Qué NO se migró a propósito (documentado en el CHANGELOG): los otros
// dos casos de esas mismas funciones ("no se encontró ningún pedido" y
// "esa referencia coincide con más de uno") no son ni "falta un dato"
// (el usuario sí dio una referencia) ni "bloqueado" (no es una regla de
// negocio, es que no matcheó nada) — no encajan limpio en el contrato de
// 3 tipos de _respuestas.js, mismo criterio que llevó a no migrar
// crear_producto/editar_producto en el lote de stock.js. Tampoco se
// tocaron crear_pedido/crear_presupuesto/registrar_devolucion_pedido:
// esas reenvían `resultado.error` de handlers compartidos con el portal
// HTTP del cliente (crear-pedido.js, presupuestos.js, devoluciones), no
// son mensajes de autoría de este archivo — forzarlos al molde
// implicaría adivinar el tipo por el contenido del string.
//
// Mismo patrón de mock que los lotes anteriores: solo se mockea
// lib/repos/_db.js (from + rpc), dejando correr los resolvers reales de
// _helpers.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_PEDIDOS } = await import('../../lib/asistente-tools/pedidos.js');

const confirmarSugerido = TOOLS_PEDIDOS.find((t) => t.name === 'confirmar_pedido_sugerido');
const descartarSugerido = TOOLS_PEDIDOS.find((t) => t.name === 'descartar_pedido_sugerido');
const modificarBorrador = TOOLS_PEDIDOS.find((t) => t.name === 'modificar_pedido_no_confirmado');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

function mockDiagnostico(resultado) {
  dbMock.rpc.mockImplementation((rpc) => {
    if (rpc === 'diagnosticar_pedido') return Promise.resolve({ data: resultado, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

describe.each([
  ['confirmar_pedido_sugerido', () => confirmarSugerido, 'sugerido'],
  ['descartar_pedido_sugerido', () => descartarSugerido, 'sugerido'],
])('%s — vía buscarPedidoSugeridoPropio: faltaDato y bloqueado migrados', (_nombre, getTool, estadoEsperado) => {
  it('sin referencia: tira faltaDato (mensaje "Me falta ... para seguir.", sin `.opciones`)', async () => {
    const tool = getTool();
    const err = await tool.resumen({ empresaId: EMPRESA_ID, args: { referencia: '' } }).catch((e) => e);
    expect(err.message).toBe('Me falta la referencia del pedido sugerido para seguir.');
    expect(err.opciones).toBeUndefined();
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });

  it(`pedido en otro estado (no "${estadoEsperado}"): tira bloqueado citando el estado real, sin .opciones`, async () => {
    mockDiagnostico({ encontrado: true, estado_pedido: 'confirmado', pedido_id: 'p1', referencia_corta: 'ABC123', cliente: 'Kiosco Sur', total: 500 });
    const tool = getTool();
    const err = await tool.resumen({ empresaId: EMPRESA_ID, args: { referencia: 'ABC123' } }).catch((e) => e);
    expect(err.message).toBe('Ese pedido está en estado "confirmado", no "sugerido". No se puede confirmar ni descartar con esta herramienta.');
    expect(err.opciones).toBeUndefined();
  });
});

describe('modificar_pedido_no_confirmado — vía buscarPedidoBorradorPorTexto: faltaDato y bloqueado migrados', () => {
  it('sin referencia de pedido: tira faltaDato, sin tocar la DB', async () => {
    const err = await modificarBorrador.resumen({
      empresaId: EMPRESA_ID,
      args: { pedido: '', notas_internas: 'urgente' },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta la referencia del pedido para seguir.');
    expect(err.opciones).toBeUndefined();
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });

  it('pedido ya confirmado (no en borrador): tira bloqueado explicando por qué no se puede tocar, sin `.opciones`', async () => {
    mockDiagnostico({ encontrado: true, estado_pedido: 'confirmado', pedido_id: 'p1', referencia_corta: 'ABC123', cliente: 'Kiosco Sur' });
    const err = await modificarBorrador.resumen({
      empresaId: EMPRESA_ID,
      args: { pedido: 'ABC123', notas_internas: 'urgente' },
    }).catch((e) => e);
    expect(err.message).toBe('Ese pedido está en estado "confirmado", no en borrador. Ya fue confirmado y esta tool no permite tocarlo.');
    expect(err.opciones).toBeUndefined();
  });
});
