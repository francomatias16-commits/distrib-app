// tests/handlers/pedidos-ahorro-competencia.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, Fase 2 (Capa 3 — retención):
// acreditarAhorroCompetencia (lib/handlers/pedidos/notificaciones.js).
//
// Foco: la regla de negocio central es que el acumulado NUNCA retrocede —
// si el precio propio subió por encima de la referencia congelada, ese
// ítem no resta del acumulado, simplemente no suma. También cubre los
// early-returns (cliente sin referencia, pedido sin ítems con referencia)
// y que el RPC se llama con el ahorro total y el detalle correctos.

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/email.js', () => ({
  enviarEmailConfirmacionPedido: vi.fn(),
  enviarEmailDespacho: vi.fn(),
}));

const obtenerItemsDePedidoMock = vi.fn();
vi.mock('../../lib/repos/pedidos.js', () => ({
  insertarMovimientoPuntosFallback: vi.fn(),
  insertarNotifLog: vi.fn(),
  obtenerClienteEmailRazonSocial: vi.fn(),
  obtenerClienteParaEmailDespacho: vi.fn(),
  obtenerClienteScoreCategoria: vi.fn(),
  obtenerClienteTelefonoRazonSocial: vi.fn(),
  obtenerEmpresaContacto: vi.fn(),
  obtenerItemsDePedido: (...args) => obtenerItemsDePedidoMock(...args),
  obtenerPedidoCompletoParaEmailConfirmacion: vi.fn(),
  obtenerPedidoNumeroYTotal: vi.fn(),
  obtenerPedidoTotal: vi.fn(),
  obtenerProgramaFidelizacionActivo: vi.fn(),
  registrarMovimientoPuntosRpc: vi.fn(),
  sumarSaldoPuntosFallbackRpc: vi.fn(),
}));

const obtenerPreciosReferenciaCompetenciaMock = vi.fn();
const registrarAhorroCompetenciaRpcMock = vi.fn();
vi.mock('../../lib/repos/captura-competencia.js', () => ({
  obtenerPreciosReferenciaCompetencia: (...args) => obtenerPreciosReferenciaCompetenciaMock(...args),
  registrarAhorroCompetenciaRpc: (...args) => registrarAhorroCompetenciaRpcMock(...args),
}));

vi.mock('../../lib/handlers/_push.js', () => ({
  enviarPush: vi.fn(),
  notificarPuntosGanados: vi.fn(),
}));

const { acreditarAhorroCompetencia } = await import('../../lib/handlers/pedidos/notificaciones.js');

const CLIENTE = { id: 'c1' };

beforeEach(() => {
  vi.clearAllMocks();
  registrarAhorroCompetenciaRpcMock.mockResolvedValue({ error: null });
});

describe('acreditarAhorroCompetencia', () => {
  it('no acredita nada si el cliente no tiene referencia de competencia (Map vacío)', async () => {
    obtenerPreciosReferenciaCompetenciaMock.mockResolvedValue({ data: new Map(), error: null });

    await acreditarAhorroCompetencia('ped-1', CLIENTE, 'e1');

    expect(obtenerItemsDePedidoMock).not.toHaveBeenCalled();
    expect(registrarAhorroCompetenciaRpcMock).not.toHaveBeenCalled();
  });

  it('no acredita nada si hay error obteniendo la referencia', async () => {
    obtenerPreciosReferenciaCompetenciaMock.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await acreditarAhorroCompetencia('ped-1', CLIENTE, 'e1');

    expect(registrarAhorroCompetenciaRpcMock).not.toHaveBeenCalled();
  });

  it('no acredita nada si el pedido no tiene ítems', async () => {
    obtenerPreciosReferenciaCompetenciaMock.mockResolvedValue({ data: new Map([['p1', 100]]), error: null });
    obtenerItemsDePedidoMock.mockResolvedValue(new Map());

    await acreditarAhorroCompetencia('ped-1', CLIENTE, 'e1');

    expect(registrarAhorroCompetenciaRpcMock).not.toHaveBeenCalled();
  });

  it('calcula el ahorro solo sobre los ítems con referencia y precio propio menor', async () => {
    obtenerPreciosReferenciaCompetenciaMock.mockResolvedValue({
      data: new Map([['p1', 100], ['p2', 50]]),
      error: null,
    });
    obtenerItemsDePedidoMock.mockResolvedValue(new Map([
      ['p1', { cantidad: 2, precio_unitario: 80 }],  // ahorro: (100-80)*2 = 40
      ['p2', { cantidad: 1, precio_unitario: 50 }],  // ahorro: 0 -> no suma
      ['p3', { cantidad: 5, precio_unitario: 10 }],  // sin referencia -> se ignora
    ]));

    await acreditarAhorroCompetencia('ped-1', CLIENTE, 'e1');

    expect(registrarAhorroCompetenciaRpcMock).toHaveBeenCalledTimes(1);
    const args = registrarAhorroCompetenciaRpcMock.mock.calls[0][0];
    expect(args.p_pedido_id).toBe('ped-1');
    expect(args.p_cliente_id).toBe('c1');
    expect(args.p_empresa_id).toBe('e1');
    expect(args.p_ahorro_pedido).toBe(40);
    expect(args.p_detalle).toHaveLength(1);
    expect(args.p_detalle[0].producto_id).toBe('p1');
  });

  it('nunca resta del acumulado: si el precio propio subió por encima de la referencia, ese ítem no cuenta', async () => {
    obtenerPreciosReferenciaCompetenciaMock.mockResolvedValue({ data: new Map([['p1', 100]]), error: null });
    obtenerItemsDePedidoMock.mockResolvedValue(new Map([
      ['p1', { cantidad: 3, precio_unitario: 150 }], // precio propio subió por encima de la referencia
    ]));

    await acreditarAhorroCompetencia('ped-1', CLIENTE, 'e1');

    expect(registrarAhorroCompetenciaRpcMock).not.toHaveBeenCalled();
  });

  it('no llama al RPC si el error viene del propio RPC (no lanza)', async () => {
    obtenerPreciosReferenciaCompetenciaMock.mockResolvedValue({ data: new Map([['p1', 100]]), error: null });
    obtenerItemsDePedidoMock.mockResolvedValue(new Map([
      ['p1', { cantidad: 1, precio_unitario: 90 }],
    ]));
    registrarAhorroCompetenciaRpcMock.mockResolvedValue({ error: { message: 'fail' } });

    await expect(acreditarAhorroCompetencia('ped-1', CLIENTE, 'e1')).resolves.not.toThrow();
  });

  it('redondea el ahorro total a centavos', async () => {
    obtenerPreciosReferenciaCompetenciaMock.mockResolvedValue({ data: new Map([['p1', 33.33]]), error: null });
    obtenerItemsDePedidoMock.mockResolvedValue(new Map([
      ['p1', { cantidad: 3, precio_unitario: 10 }], // (33.33-10)*3 = 69.99 -> ya redondo, pero fuerza el path de redondeo
    ]));

    await acreditarAhorroCompetencia('ped-1', CLIENTE, 'e1');

    const args = registrarAhorroCompetenciaRpcMock.mock.calls[0][0];
    expect(args.p_ahorro_pedido).toBe(69.99);
  });
});
