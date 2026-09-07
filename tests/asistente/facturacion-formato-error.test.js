// tests/asistente/facturacion-formato-error.test.js
//
// Fase 3 (continuacion) -- quinto lote, sobre lib/asistente-tools/facturacion.js
// y (de paso, mismo criterio de siempre) los resolvers compartidos
// buscarFacturaPorReferencia / buscarPedidoFacturable en _helpers.js, que
// solo usan las dos tools de este archivo:
//
//   - anular_factura: "Falta el motivo de la anulación" pasó a
//     faltaDato('el motivo de la anulación'); el re-chequeo de estado en
//     execute() ("la factura ya no está en estado emitida") pasó a
//     bloqueado(). Dentro de buscarFacturaPorReferencia: "ya está anulada"
//     y "está en estado X (sin CAE)" pasaron a bloqueado(), el segundo
//     con motivo+salida separados en el "—" para reproducir el string
//     original carácter por carácter.
//   - emitir_factura: dentro de buscarPedidoFacturable, "está en estado X
//     — todavía no se puede facturar" y "ya tiene una factura emitida"
//     pasaron a bloqueado() (el segundo con motivo+salida). El caso
//     "sin_configuracion_facturacion" en execute() también pasó a
//     bloqueado(motivo, salida), partido en el guión "—" del texto
//     original.
//
// Qué NO se migró a propósito (documentado en el CHANGELOG):
//   - "La referencia sigue siendo ambigua; pedile al usuario que elija
//     una de las opciones mostradas." (en execute(), ambas tools): a
//     diferencia de pedidos.js (que hace `return resuelto.ambiguo` para
//     preservar los candidatos), acá se descarta el shape
//     `{ambiguo:true, candidatos}` y se tira un string genérico. Es una
//     inconsistencia real preexistente, pero corregirla cambia
//     comportamiento (recuperar los candidatos para pintarlos), no solo
//     formato — queda fuera del alcance de esta migración, señalado acá
//     para una pasada futura.
//   - "No se pudo releer la factura para anularla." / "No se pudo
//     confirmar el pedido para facturar.": chequeos de consistencia
//     interna (la fila desapareció entre el resolve y el re-read), no
//     "falta un dato" ni "bloqueado" de negocio.
//   - Los `resultado.error`/`resultado?.error` que reenvían
//     anularFactura()/emitirFactura() (lib/facturas.js) y el wrapper de
//     listar_notas_credito: mismo criterio de siempre, no son de autoría
//     de este archivo.
//   - "Esa referencia coincide con más de una factura/uno un pedido.
//     Pedile el UUID completo." (en buscarFacturaPorReferencia/
//     buscarPedidoFacturable): mismo patrón repetido en ~8 lugares más de
//     _helpers.js, ninguno migrado en ningún lote anterior — no hay
//     candidatos con label distinguible, no encaja limpio en ambiguo().
//
// REGRESIÓN aparte (no es Fase 3, se encontró de paso): el import
// dinámico `await import('./facturas.js')` en anular_factura/
// emitir_factura apuntaba, desde lib/asistente-tools/facturacion.js, a
// un archivo inexistente (lib/asistente-tools/facturas.js) — el resto
// del archivo importa con '../' (sube a lib/), pero estas dos líneas se
// quedaron con './' de cuando el código vivía directo en lib/. Ambas
// tools reventaban con ERR_MODULE_NOT_FOUND en cuanto se ejecutaban de
// verdad (nunca en resumen(), que no llega a esa línea). Corregido a
// '../facturas.js'. Los tests "regresión: no explota" de abajo cubren
// justo esto: llegan hasta la línea del import dinámico con
// lib/facturas.js mockeado, así que si la ruta estuviera rota de nuevo
// fallarían con ERR_MODULE_NOT_FOUND en vez de con el bloqueado()
// esperado.
//
// Mismo patrón de mock que los lotes anteriores: solo se mockea
// lib/repos/_db.js (from), dejando correr los resolvers reales de
// _helpers.js. lib/facturas.js se mockea aparte porque es un import
// dinámico con efectos reales (ARCA/AFIP) fuera del alcance de este test.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const facturasLibMock = vi.hoisted(() => ({
  anularFactura: vi.fn(),
  emitirFactura: vi.fn(),
}));
vi.mock('../../lib/facturas.js', () => facturasLibMock);

const { TOOLS_FACTURACION } = await import('../../lib/asistente-tools/facturacion.js');

const anularFacturaTool = TOOLS_FACTURACION.find((t) => t.name === 'anular_factura');
const emitirFacturaTool = TOOLS_FACTURACION.find((t) => t.name === 'emitir_factura');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
  facturasLibMock.anularFactura.mockReset();
  facturasLibMock.emitirFactura.mockReset();
});

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    ilike: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

// Encola una fakeQuery por llamada sucesiva a db.from(tabla), en orden.
function mockFromSecuencial(tabla, resultados) {
  let i = 0;
  dbMock.from.mockImplementation((t) => {
    if (t !== tabla) throw new Error(`tabla no mockeada en este test: ${t}`);
    const r = resultados[Math.min(i, resultados.length - 1)];
    i += 1;
    return fakeQuery(r);
  });
}

describe('anular_factura — faltaDato y bloqueado migrados', () => {
  it('sin motivo: tira faltaDato antes de releer la factura', async () => {
    mockFromSecuencial('facturas', [
      { data: [{ id: 'ABC123', numero: 'F001', tipo: 'A', estado: 'emitida', total: 500, clientes: { razon_social: 'Cliente X' } }], error: null },
    ]);
    const err = await anularFacturaTool.execute({
      empresaId: EMPRESA_ID, usuarioId: 'u1', args: { referencia: 'ABC123' },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el motivo de la anulación para seguir.');
    expect(err.opciones).toBeUndefined();
    expect(dbMock.from).toHaveBeenCalledTimes(1); // no llegó a releer
  });

  it('factura ya anulada: bloqueado sin salida (vía buscarFacturaPorReferencia)', async () => {
    mockFromSecuencial('facturas', [
      { data: [{ id: 'ABC123', numero: 'F001', tipo: 'A', estado: 'anulada', total: 500, clientes: null }], error: null },
    ]);
    const err = await anularFacturaTool.resumen({
      empresaId: EMPRESA_ID, args: { referencia: 'ABC123', motivo: 'x' },
    }).catch((e) => e);
    expect(err.message).toBe('La factura F001 ya está anulada.');
    expect(err.opciones).toBeUndefined();
  });

  it('factura sin CAE (pendiente): bloqueado con motivo + salida', async () => {
    mockFromSecuencial('facturas', [
      { data: [{ id: 'ABC123', numero: 'F001', tipo: 'A', estado: 'pendiente', total: 500, clientes: null }], error: null },
    ]);
    const err = await anularFacturaTool.resumen({
      empresaId: EMPRESA_ID, args: { referencia: 'ABC123', motivo: 'x' },
    }).catch((e) => e);
    expect(err.message).toBe(
      'La factura F001 está en estado "pendiente" (sin CAE) — solo se pueden anular comprobantes emitidos. '
      + 'No hace falta anularla fiscalmente: alcanza con cancelar el pedido o la venta que la generó.',
    );
    expect(err.opciones).toBeUndefined();
  });

  it('regresión: la factura cambió de estado entre resumen y execute → bloqueado (y NO ERR_MODULE_NOT_FOUND)', async () => {
    mockFromSecuencial('facturas', [
      { data: [{ id: 'ABC123', numero: 'F001', tipo: 'A', estado: 'emitida', total: 500, clientes: { razon_social: 'Cliente X' } }], error: null },
      { data: { id: 'ABC123', numero: 'F001', estado: 'anulada' }, error: null },
    ]);
    const err = await anularFacturaTool.execute({
      empresaId: EMPRESA_ID, usuarioId: 'u1', args: { referencia: 'ABC123', motivo: 'error de carga' },
    }).catch((e) => e);
    expect(err.message).toBe('La factura F001 ya no está en estado "emitida" (ahora: "anulada") — no se puede anular.');
    expect(err.opciones).toBeUndefined();
    expect(facturasLibMock.anularFactura).not.toHaveBeenCalled(); // nunca llegó a esa línea
  });

  it('regresión: camino feliz llega hasta el import dinámico de lib/facturas.js sin explotar', async () => {
    mockFromSecuencial('facturas', [
      { data: [{ id: 'ABC123', numero: 'F001', tipo: 'A', estado: 'emitida', total: 500, clientes: { razon_social: 'Cliente X' } }], error: null },
      { data: { id: 'ABC123', numero: 'F001', estado: 'emitida', empresa_id: EMPRESA_ID }, error: null },
    ]);
    facturasLibMock.anularFactura.mockResolvedValue({ ok: true, nota_credito: { id: 'nc1' } });
    const resultado = await anularFacturaTool.execute({
      empresaId: EMPRESA_ID, usuarioId: 'u1', args: { referencia: 'ABC123', motivo: 'error de carga' },
    });
    expect(resultado.ok).toBe(true);
    expect(facturasLibMock.anularFactura).toHaveBeenCalledTimes(1);
  });
});

describe('emitir_factura — bloqueado migrado (vía buscarPedidoFacturable)', () => {
  it('pedido en borrador: bloqueado sin salida', async () => {
    mockFromSecuencial('pedidos', [
      { data: [{ id: 'DEF456', estado: 'borrador', total: 1000, factura_id: null, clientes: { razon_social: 'Cliente Y' }, facturas: null }], error: null },
    ]);
    const err = await emitirFacturaTool.resumen({
      empresaId: EMPRESA_ID, args: { referencia: 'DEF456' },
    }).catch((e) => e);
    expect(err.message).toBe('El pedido DEF456 está en estado "borrador" — todavía no se puede facturar.');
    expect(err.opciones).toBeUndefined();
  });

  it('pedido ya facturado: bloqueado con motivo + salida', async () => {
    mockFromSecuencial('pedidos', [
      { data: [{ id: 'DEF456', estado: 'confirmado', total: 1000, factura_id: 'f1', clientes: { razon_social: 'Cliente Y' }, facturas: { estado: 'emitida' } }], error: null },
    ]);
    const err = await emitirFacturaTool.resumen({
      empresaId: EMPRESA_ID, args: { referencia: 'DEF456' },
    }).catch((e) => e);
    expect(err.message).toBe(
      'El pedido DEF456 ya tiene una factura emitida (estado "emitida") — no hace falta volver a facturarlo. '
      + 'Para anularla, usar la tool anular_factura.',
    );
    expect(err.opciones).toBeUndefined();
  });

  it('regresión: sin_configuracion_facturacion → bloqueado (y NO ERR_MODULE_NOT_FOUND)', async () => {
    mockFromSecuencial('pedidos', [
      { data: [{ id: 'DEF456', estado: 'confirmado', total: 1000, factura_id: null, clientes: { razon_social: 'Cliente Y' }, facturas: null }], error: null },
      { data: { id: 'DEF456', empresa_id: EMPRESA_ID }, error: null },
    ]);
    facturasLibMock.emitirFactura.mockResolvedValue({ ok: false, codigo: 'sin_configuracion_facturacion' });
    const err = await emitirFacturaTool.execute({
      empresaId: EMPRESA_ID, usuarioId: 'u1', args: { referencia: 'DEF456' },
    }).catch((e) => e);
    expect(err.message).toBe(
      'Todavía no configuraste la facturación electrónica (ARCA/AFIP) de esta empresa — '
      + 'hay que cargar el CUIT, el punto de venta y el certificado desde Configuración > Facturación antes de poder emitir comprobantes.',
    );
    expect(err.opciones).toBeUndefined();
    expect(facturasLibMock.emitirFactura).toHaveBeenCalledTimes(1);
  });
});
