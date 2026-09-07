// tests/asistente/facturacion-ambiguedad-execute.test.js
//
// Fix de comportamiento (no de formato) señalado en el CHANGELOG del
// quinto lote y en facturacion-formato-error.test.js: en execute() de
// anular_factura/emitir_factura, cuando resolverFacturaParaAnular /
// resolverPedidoParaFacturar vuelven a encontrar ambigüedad (pudo
// cambiar entre resumen() y el click de Confirmar — ej. el cliente tiene
// ahora 2+ facturas/pedidos recientes en vez de 1), se tiraba un string
// genérico ("La referencia sigue siendo ambigua; pedile al usuario que
// elija una de las opciones mostradas.") que NO incluye la lista real de
// candidatos — a diferencia de pedidos.js, que en sus tools de solo
// lectura (diagnosticar_pedido/presupuesto) hace `return resuelto.ambiguo`
// para preservarla.
//
// Por qué acá NO alcanza con copiar ese mismo `return resuelto.ambiguo`:
// anular_factura/emitir_factura son `requiereConfirmacion: true`, así que
// execute() se llama desde resolverAccionPendiente() (lib/asistente-tools/
// index.js), que interpreta CUALQUIER valor devuelto sin `throw` como
// éxito y arma el mensaje "Listo, hecho: <resumen>" sin mirar el
// contenido real — devolver el objeto `{ambiguo:true, candidatos}` ahí
// haría creer al usuario que la factura se anuló / el pedido se facturó,
// cuando en realidad no pasó nada. Por eso el fix tiene que seguir
// tirando (no retornando), pero con un error `ambiguo()` real —el mismo
// tipo 2 del contrato de _respuestas.js— que arma la lista de candidatos
// en el propio mensaje (numerada, con la instrucción de mostrarla tal
// cual) en vez del string ciego de antes.
//
// Nota (documentado también en el fix, no es alcance de esta migración):
// la rama de confirmación (resolverAccionPendiente + el catch de
// lib/handlers/asistente.js) todavía no propaga `.opciones` como sí hace
// el loop normal del modelo (ver extraerOpcionesAmbiguas) — así que en
// esta rama puntual el usuario ve la lista como texto plano dentro del
// mensaje de error, no como botones tappable. Eso requeriría tocar la
// capa de handlers/frontend, fuera del alcance de la capa de tools.

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
});

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    order: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

// El cliente se resuelve por RPC (buscar_clientes_asistente); un solo
// candidato alcanza para que elegirMejorCandidato lo dé por bueno sin
// pedir nada más — la ambigüedad real está en los DOCUMENTOS del
// cliente, no en el cliente mismo.
function mockClienteUnico() {
  dbMock.rpc.mockResolvedValue({
    data: [{ id: 'cli1', razon_social: 'Cliente X', activo: true }],
    error: null,
  });
}

describe('anular_factura — execute() con ambigüedad real: ambiguo() con candidatos, no string ciego', () => {
  it('el cliente tiene 2+ facturas recientes: tira ambiguo() con .opciones y las facturas en el mensaje', async () => {
    mockClienteUnico();
    dbMock.from.mockImplementation((tabla) => {
      if (tabla !== 'facturas') throw new Error(`tabla no mockeada en este test: ${tabla}`);
      return fakeQuery({
        data: [
          { id: 'AAAAAA111111', fecha_emision: '2026-08-20', total: 500 },
          { id: 'BBBBBB222222', fecha_emision: '2026-08-15', total: 300 },
        ],
        error: null,
      });
    });

    const err = await anularFacturaTool.execute({
      empresaId: EMPRESA_ID, usuarioId: 'u1', args: { cliente: 'Cliente X', motivo: 'error de carga' },
    }).catch((e) => e);

    // Ya NO es el string genérico de antes:
    expect(err.message).not.toMatch(/La referencia sigue siendo ambigua/);
    // Es un ambiguo() real: trae .opciones con los 2 candidatos reales.
    expect(err.opciones).toHaveLength(2);
    expect(err.opciones.map((o) => o.id)).toEqual(['AAAAAA111111', 'BBBBBB222222']);
    // El mensaje en sí incluye la lista (para cuando no hay botones, ver
    // la rama de confirmación en lib/handlers/asistente.js).
    expect(err.message).toContain('111111');
    expect(err.message).toContain('222222');
    expect(err.message).toContain('Mostrale esta lista tal cual');
    // Nunca llegó a tocar lib/facturas.js: no se anuló nada.
    expect(facturasLibMock.anularFactura).not.toHaveBeenCalled();
  });
});

describe('emitir_factura — execute() con ambigüedad real: ambiguo() con candidatos, no string ciego', () => {
  it('el cliente tiene 2+ pedidos recientes: tira ambiguo() con .opciones y los pedidos en el mensaje', async () => {
    mockClienteUnico();
    dbMock.from.mockImplementation((tabla) => {
      if (tabla !== 'pedidos') throw new Error(`tabla no mockeada en este test: ${tabla}`);
      return fakeQuery({
        data: [
          { id: 'CCCCCC333333', fecha_pedido: '2026-08-20', total: 1000 },
          { id: 'DDDDDD444444', fecha_pedido: '2026-08-18', total: 750 },
        ],
        error: null,
      });
    });

    const err = await emitirFacturaTool.execute({
      empresaId: EMPRESA_ID, usuarioId: 'u1', args: { cliente: 'Cliente X' },
    }).catch((e) => e);

    expect(err.message).not.toMatch(/La referencia sigue siendo ambigua/);
    expect(err.opciones).toHaveLength(2);
    expect(err.opciones.map((o) => o.id)).toEqual(['CCCCCC333333', 'DDDDDD444444']);
    expect(err.message).toContain('333333');
    expect(err.message).toContain('444444');
    expect(facturasLibMock.emitirFactura).not.toHaveBeenCalled();
  });
});
