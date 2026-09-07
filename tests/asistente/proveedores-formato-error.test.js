// tests/asistente/proveedores-formato-error.test.js
//
// Fase 3 (continuacion) -- cuarto lote, sobre lib/asistente-tools/proveedores.js:
//   - crear_proveedor: mismo patrón exacto que crear_cliente (segundo
//     lote) — "falta la razón social" pasó a faltaDato(); "ya existe un
//     proveedor con ese CUIT/esa razón social" pasó a
//     bloqueado(motivo, salida). No tenía test propio hasta ahora.
//
// Las otras dos migraciones de este lote (recepcionar_orden_compra_asistente:
// "sin renglones pendientes" y, dentro de resolverRecepcionOrdenCompra en
// _helpers.js, "orden cancelada"/"orden ya recibida") ya tenían test
// cubriendo la redacción exacta en tests/asistente/orden-compra.test.js —
// se extendieron esos tests in situ (agregando el check de `.opciones`)
// en vez de duplicarlos acá. Los 3 casos se migraron a bloqueado()
// preservando la redacción carácter por carácter (mismo truco que
// ajustar_stock_asistente en el primer lote: motivo terminado justo antes
// de la coma/punto para que motivo + ' ' + salida dé el string original).
//
// Qué NO se migró (a propósito, documentado en el CHANGELOG):
//   - "Falta indicar el número de la orden de compra." (resolverRecepcionOrdenCompra):
//     el test existente lo asserta literal y faltaDato() no puede
//     reproducir esa redacción exacta (su plantilla fija es "Me falta
//     ... para seguir.") — se deja sin migrar en vez de romper el
//     contrato de ese test o cambiarle la redacción sin pedirlo.
//   - Los wrappers de error de DB/RPC del resto del archivo, y los
//     `data.error` que reenvían crear_orden_compra_asistente/
//     recepcionar_orden_compra_asistente cuando la RPC devuelve
//     `{ ok: false }` — mismo criterio que crear_pedido en el lote de
//     pedidos.js: el string viene de una RPC de SQL, no es de autoría de
//     este archivo.
//   - consultar_links_portal_proveedor / generar_link_portal_proveedor /
//     revocar_link_portal_proveedor: reenvían `resultado.error` de
//     lib/handlers/portal_proveedor.js, compartido con el panel admin —
//     mismo criterio que crear-pedido.js en el lote de pedidos.js.
//
// Mismo patrón de mock que clientes-formato-error.test.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_PROVEEDORES } = await import('../../lib/asistente-tools/proveedores.js');

const crearProveedor = TOOLS_PROVEEDORES.find((t) => t.name === 'crear_proveedor');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
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

describe('crear_proveedor — resumen(): faltaDato y bloqueado migrados', () => {
  it('sin razón social: tira faltaDato, sin tocar la DB', async () => {
    const err = await crearProveedor.resumen({ empresaId: EMPRESA_ID, args: {} }).catch((e) => e);
    expect(err.message).toBe('Me falta la razón social del proveedor para seguir.');
    expect(err.opciones).toBeUndefined();
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('ya existe por razón social: tira bloqueado citando el nombre, sin `.opciones`', async () => {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'proveedores') {
        return fakeQuery({ data: { id: 'p1', razon_social: 'Distribuidora SRL', nombre_fantasia: null }, error: null });
      }
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    const err = await crearProveedor.resumen({
      empresaId: EMPRESA_ID,
      args: { razon_social: 'Distribuidora SRL' },
    }).catch((e) => e);
    // Mismo bug de concordancia preexistente que en crear_cliente
    // ("esea razón social" en vez de "esa razón social") — se preserva
    // tal cual, no se toca redacción fuera del alcance de esta migración.
    expect(err.message).toContain('Ya existe un proveedor con esea razón social: "Distribuidora SRL".');
    expect(err.message).toContain('No hace falta crearlo de nuevo.');
    expect(err.opciones).toBeUndefined();
  });

  it('ya existe por CUIT: el motivo del mensaje distingue "ese CUIT" de "esa razón social"', async () => {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'proveedores') {
        return fakeQuery({ data: { id: 'p1', razon_social: 'Distribuidora SRL', nombre_fantasia: null }, error: null });
      }
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    const err = await crearProveedor.resumen({
      empresaId: EMPRESA_ID,
      args: { razon_social: 'Distribuidora SRL', cuit: '20304050607' },
    }).catch((e) => e);
    expect(err.message).toContain('Ya existe un proveedor con ese CUIT: "Distribuidora SRL".');
    expect(err.opciones).toBeUndefined();
  });
});
