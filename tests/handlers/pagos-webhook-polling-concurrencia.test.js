// tests/handlers/pagos-webhook-polling-concurrencia.test.js
//
// FIX BUG-01 (doble acreditación en cta_cte): manejarWebhook (vía
// procesarEventoMP) y verificarPago (polling desde el cliente mientras
// espera el checkout) pueden confirmar el mismo pago de Mercado Pago casi
// al mismo tiempo. El fix real ya está aplicado en lib/handlers/pagos.js y
// lib/repos/pagos.js, con dos capas:
//
//   1. CAS de aplicación: actualizarTransaccionPorId(..., { soloSiNoCompletada:
//      true }) agrega `.neq('estado', 'completado')` al UPDATE — si el otro
//      caller ya completó la transacción, este UPDATE afecta 0 filas y el
//      caller se retira sin duplicar nada.
//   2. Idempotencia de base: registrar_cobro_completo dedupea por
//      offline_local_id (`mp:{payment_id}`) contra el índice único
//      idx_cobros_offline_local_id (migración 508).
//
// Este archivo mockea lib/repos/pagos.js con un estado en memoria que
// replica el CONTRATO exacto de esas dos capas (no una DB real — eso lo
// cubre scripts/test-integration.js, grupo concurrencia-pagos T48-T50,
// corriendo las RPCs de verdad contra Postgres) y corre procesarEventoMP(body)
// y verificarPago(req, res) con Promise.all para que sus await intercalen
// de verdad, en vez de simular la carrera con mocks secuenciales.

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/crypto-secrets.js', () => ({
  cifrar:   (v) => v,
  descifrar: (v) => v,
}));

vi.mock('../../lib/repos/audit.js', () => ({
  registrarAuditoriaFinancieraDurable: vi.fn(() => Promise.resolve()),
  registrarAuditoriaSilenciosa:        vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/repos/facturas.js', () => ({
  encolarConciliacionFinanciera: vi.fn(() => Promise.resolve({ error: null })),
}));

vi.mock('../../lib/repos/pedidos.js', () => ({
  obtenerPedidoParaPagoPublico: vi.fn(() => Promise.resolve({ data: null, error: null })),
}));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false,
}));

vi.mock('../../lib/auth-helpers.js', () => ({
  getUserSeguro: vi.fn(() => Promise.resolve({ data: { user: { id: 'usuario-test' } }, error: null })),
}));

// El pago que ambos caminos van a "consultar" contra la API de MP —
// siempre aprobado, mismo monto. Estado real de MP no cambia entre
// llamadas (a diferencia de nuestra propia BD, que es lo que se está
// probando acá).
const PAYMENT_ID   = 999888777;
const PAGO_MP_MOCK = {
  id: PAYMENT_ID,
  status: 'approved',
  payment_method_id: 'account_money',
  transaction_amount: 1500,
  external_reference: 'pedido-concurrencia-1',
};

vi.mock('node-fetch', () => ({
  default: vi.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(PAGO_MP_MOCK)),
  })),
}));

// ────────────────────────────────────────────────────────────────────────
// Estado en memoria que replica el contrato real de lib/repos/pagos.js:
// una única fila de transacción, y un Set de offline_local_id ya usados
// (equivalente al índice único idx_cobros_offline_local_id).
// ────────────────────────────────────────────────────────────────────────
const estado = vi.hoisted(() => ({
  tx: null,
  cobrosPorOfflineId: new Map(),
  llamadasRegistrarCobro: 0,
}));

function resetEstado() {
  estado.tx = {
    id: 'tx-1',
    empresa_id: 'empresa-1',
    cliente_id: 'cliente-1',
    pedido_id: 'pedido-concurrencia-1',
    estado: 'pendiente',
    monto: 1500,
  };
  estado.cobrosPorOfflineId = new Map();
  estado.llamadasRegistrarCobro = 0;
}

vi.mock('../../lib/repos/pagos.js', () => ({
  obtenerPerfilUsuarioPago: vi.fn(() =>
    Promise.resolve({ rol: 'admin', empresa_id: 'empresa-1', cliente_id: null })
  ),

  obtenerTransaccionParaVerificar: vi.fn(() =>
    Promise.resolve({ data: { ...estado.tx }, error: null })
  ),

  obtenerTransaccionPorPedido: vi.fn((pedido_id, empresa_id) => {
    if (estado.tx.pedido_id !== pedido_id || estado.tx.empresa_id !== empresa_id) {
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: { ...estado.tx }, error: null });
  }),

  obtenerIntegracionMPAccessToken: vi.fn(() =>
    Promise.resolve({ conectado_via: 'manual', access_token: 'token-fake' })
  ),

  obtenerIntegracionMPPorMpUserId: vi.fn(() =>
    Promise.resolve({
      data: { empresa_id: 'empresa-1', conectado_via: 'manual', access_token: 'token-fake' },
      error: null,
    })
  ),

  // Réplica del CAS real: `UPDATE ... SET estado = X WHERE id = tx.id AND
  // estado != 'completado'`. Atómico porque JS es single-threaded y no hay
  // ningún `await` entre el chequeo y la escritura — exactamente la misma
  // garantía que da Postgres con una sola sentencia UPDATE.
  actualizarTransaccionPorId: vi.fn((id, cambios, opts) => {
    if (opts?.soloSiNoCompletada && estado.tx.estado === 'completado') {
      return Promise.resolve({ data: [], error: null }); // 0 filas afectadas
    }
    estado.tx = { ...estado.tx, ...cambios };
    return Promise.resolve({ data: [{ ...estado.tx }], error: null });
  }),

  confirmarPedidoPagado: vi.fn(() =>
    Promise.resolve({
      data: { empresa_id: estado.tx.empresa_id, cliente_id: estado.tx.cliente_id },
      error: null,
    })
  ),

  // Réplica del índice único idx_cobros_offline_local_id: la primera
  // llamada con un offline_local_id dado crea el cobro; cualquier otra
  // con el MISMO offline_local_id devuelve el cobro ya existente
  // (ya_existia: true) en vez de crear uno nuevo — nunca se duplica.
  registrarCobroCompletoRpc: vi.fn(({ p_offline_local_id, p_monto }) => {
    estado.llamadasRegistrarCobro += 1;
    if (estado.cobrosPorOfflineId.has(p_offline_local_id)) {
      const existente = estado.cobrosPorOfflineId.get(p_offline_local_id);
      return Promise.resolve({ data: { ok: true, ya_existia: true, cobro_id: existente.cobro_id }, error: null });
    }
    const cobro = { ok: true, ya_existia: false, cobro_id: `cobro-${estado.cobrosPorOfflineId.size + 1}`, monto: p_monto };
    estado.cobrosPorOfflineId.set(p_offline_local_id, cobro);
    return Promise.resolve({ data: cobro, error: null });
  }),
}));

import { procesarEventoMP, verificarPago } from '../../lib/handlers/pagos.js';

function armarResMock() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json   = (payload) => { res.body = payload; return res; };
  return res;
}

function armarReqVerificarPago() {
  return {
    query: { payment_id: String(PAYMENT_ID) },
    headers: { authorization: 'Bearer token-cliente' },
  };
}

describe('Carrera webhook MP + polling del cliente sobre el mismo pago (FIX BUG-01)', () => {
  beforeEach(() => {
    resetEstado();
    vi.clearAllMocks();
  });

  it('procesarEventoMP y verificarPago en paralelo: solo se crea un cobro en cta_cte', async () => {
    const bodyWebhook = { type: 'payment', data: { id: PAYMENT_ID }, user_id: 'mp-user-1' };
    const res = armarResMock();

    const [resultadoWebhook] = await Promise.all([
      procesarEventoMP(bodyWebhook),
      verificarPago(armarReqVerificarPago(), res),
    ]);

    // Ambos caminos deben terminar en éxito (uno gana el CAS, el otro
    // detecta "ya completado" y se retira sin error).
    expect(resultadoWebhook.status).toBe(200);
    expect(res.statusCode).toBe(200);

    // La transacción quedó completada exactamente una vez.
    expect(estado.tx.estado).toBe('completado');

    // El punto del fix: nunca se creó más de un cobro en cta_cte, aunque
    // ambos caminos hayan intentado registrar_cobro_completo.
    const cobrosReales = [...estado.cobrosPorOfflineId.values()];
    expect(cobrosReales).toHaveLength(1);
  });

  it('caso secuencial: si el webhook ya completó la transacción, el polling no la reprocesa', async () => {
    const bodyWebhook = { type: 'payment', data: { id: PAYMENT_ID }, user_id: 'mp-user-1' };

    const resultadoWebhook = await procesarEventoMP(bodyWebhook);
    expect(resultadoWebhook.status).toBe(200);
    expect(estado.tx.estado).toBe('completado');
    expect(estado.llamadasRegistrarCobro).toBe(1);

    const res = armarResMock();
    await verificarPago(armarReqVerificarPago(), res);

    // El polling encuentra la transacción ya completada en caché y
    // devuelve directo, sin volver a llamar a registrar_cobro_completo.
    expect(res.statusCode).toBe(200);
    expect(estado.llamadasRegistrarCobro).toBe(1);
    expect([...estado.cobrosPorOfflineId.values()]).toHaveLength(1);
  });

  it('reintento del mismo webhook (MP reenvía la notificación): no duplica el cobro', async () => {
    const bodyWebhook = { type: 'payment', data: { id: PAYMENT_ID }, user_id: 'mp-user-1' };

    const primero = await procesarEventoMP(bodyWebhook);
    expect(primero.status).toBe(200);
    expect(estado.llamadasRegistrarCobro).toBe(1);

    const segundo = await procesarEventoMP(bodyWebhook);
    expect(segundo.status).toBe(200);

    // Idempotencia de aplicación: manejarWebhook ve tx.estado === 'completado'
    // y ni siquiera llega a llamar a actualizarTransaccionPorId/registrar_cobro_completo
    // de nuevo.
    expect(estado.llamadasRegistrarCobro).toBe(1);
    expect([...estado.cobrosPorOfflineId.values()]).toHaveLength(1);
  });
});
