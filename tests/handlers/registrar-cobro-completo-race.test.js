// tests/handlers/registrar-cobro-completo-race.test.js
//
// Etapa 3 del plan de auditoría — gap gemelo al de registrar_venta_pos:
// `registrar_cobro_completo` solo estaba verificado bajo concurrencia por
// la corrida de carga real puntual de la Etapa 6
// (scripts/load-test-etapa4.js, escenarioCobroConcurrente, 2026-09-12: 8
// cobros disparados en paralelo por el saldo completo de una factura real
// de $12.329,90 — exactamente 1 se aplicó, los otros 7 rechazados por
// "factura ya saldada"). No había un `.test.js` que quedara corriendo en
// `npm test`/CI para este RPC.
//
// A diferencia de registrar_venta_pos, no hay un endpoint HTTP propio de
// `/api/pagos` ni `/api/admin` para el cobro manual — el frontend admin
// llama al RPC de Supabase directo (ver comentario en
// scripts/load-test-etapa4.js). El único código de aplicación que sí
// envuelve esta RPC es `registrarCobroCompletoRpc`
// (lib/repos/pagos.js:363, también expuesta desde lib/repos/pedidos.js) —
// consumida por el webhook/polling de MP (ya cubierto por
// tests/handlers/pagos-webhook-polling-concurrencia.test.js), por
// lib/handlers/cierre.js y por el cobro-en-entrega del chofer
// (lib/handlers/pedidos/chofer.js). Este test ejercita la función real
// `registrarCobroCompletoRpc` (sin mockearla — es un passthrough de una
// línea a `db.rpc`) contra un `db` mockeado que replica el contrato exacto
// del RPC en Postgres.
//
// Contrato real replicado acá (migración
// 20260818_p1_sec03_sec08_sync03_sync05_rpcs_financieras.sql):
//
//   SELECT id, total, COALESCE(total_cobrado,0) AS total_cobrado, estado
//     FROM facturas
//    WHERE id = v_fact_id AND empresa_id = ... AND cliente_id = ...
//    FOR UPDATE;
//
//   IF (total - total_cobrado) <= 0 THEN
//     RETURN {ok:false, error:'Una de las facturas ya está saldada'};
//   END IF;
//
//   v_total_aplicado := LEAST(monto_pedido, total - total_cobrado, restante);
//   ... INSERT cobro, UPDATE facturas SET total_cobrado = total_cobrado + aplicado ...
//
// Dedupe por `offline_local_id` (índice único `idx_cobros_offline_local_id`,
// migración 508): si ya existe un cobro con ese id, se devuelve
// `{ok:true, ya_existia:true}` sin tocar la factura de nuevo — es la
// primera línea de la función real, ANTES del FOR UPDATE.
//
// Como en los otros tests de carrera, no hay Postgres real acá — el mock
// de `db.rpc` hace el chequeo-y-escritura sin ningún `await` en el medio,
// misma garantía de atomicidad que da el FOR UPDATE real, y se dispara
// `registrarCobroCompletoRpc` en paralelo con `Promise.all`.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const EMPRESA_ID = 'empresa-1';
const CLIENTE_ID = 'cliente-1';
const FACTURA_ID = 'factura-1';

const estado = vi.hoisted(() => ({
  factura: null,
  cobrosPorOfflineId: new Map(),
  cobrosCreados: [],
}));

function resetEstado({ total, totalCobrado = 0 }) {
  estado.factura = { id: FACTURA_ID, empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID, total, total_cobrado: totalCobrado, estado: totalCobrado > 0 ? 'parcial' : 'emitida' };
  estado.cobrosPorOfflineId = new Map();
  estado.cobrosCreados = [];
}

vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    // Réplica del RPC real completo: dedupe por offline_local_id, FOR
    // UPDATE + chequeo de saldo, luego INSERT/UPDATE — todo en un único
    // tick de JS (sin await intermedio), la misma garantía de atomicidad
    // que da el lock de Postgres.
    rpc: vi.fn((nombre, params) => {
      if (nombre !== 'registrar_cobro_completo') {
        throw new Error(`RPC no mockeada en este test: ${nombre}`);
      }

      const { p_cliente_id, p_monto, p_factura_id, p_offline_local_id } = params;

      if (p_offline_local_id && estado.cobrosPorOfflineId.has(p_offline_local_id)) {
        const existente = estado.cobrosPorOfflineId.get(p_offline_local_id);
        return Promise.resolve({ data: { ok: true, cobro_id: existente.cobro_id, ya_existia: true }, error: null });
      }

      if (p_cliente_id !== estado.factura.cliente_id) {
        return Promise.resolve({ data: { ok: false, error: 'Cliente no encontrado en la empresa' }, error: null });
      }

      const factura = estado.factura;
      if (p_factura_id && p_factura_id !== factura.id) {
        return Promise.resolve({ data: { ok: false, error: 'Una factura indicada no existe o no pertenece a este cliente' }, error: null });
      }

      const saldo = factura.total - factura.total_cobrado;
      if (p_factura_id && saldo <= 0) {
        return Promise.resolve({ data: { ok: false, error: 'Una de las facturas ya está saldada' }, error: null });
      }

      const aplicado = p_factura_id ? Math.min(p_monto, saldo) : 0;
      if (p_factura_id) {
        factura.total_cobrado += aplicado;
        factura.estado = factura.total_cobrado >= factura.total ? 'emitida' : 'parcial';
      }

      const cobro = {
        cobro_id: `cobro-${estado.cobrosCreados.length + 1}`,
        ok: true,
        ya_existia: false,
        factura_saldada: p_factura_id ? factura.total_cobrado >= factura.total : null,
        monto_aplicado: aplicado,
      };
      estado.cobrosCreados.push(cobro);
      if (p_offline_local_id) estado.cobrosPorOfflineId.set(p_offline_local_id, cobro);

      return Promise.resolve({ data: cobro, error: null });
    }),
  },
}));

const { registrarCobroCompletoRpc } = await import('../../lib/repos/pagos.js');

function armarPayload(overrides = {}) {
  return {
    p_empresa_id: EMPRESA_ID,
    p_cliente_id: CLIENTE_ID,
    p_monto: 12329.9,
    p_medio: 'transferencia',
    p_factura_id: FACTURA_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registrarCobroCompletoRpc — condición de carrera sobre registrar_cobro_completo (Etapa 3)', () => {
  it('replica la corrida real de la Etapa 6: 8 cobros concurrentes por el saldo COMPLETO de la misma factura — exactamente 1 se aplica, total_cobrado nunca supera total', async () => {
    resetEstado({ total: 12329.9 });

    const llamadas = Array.from({ length: 8 }, () =>
      registrarCobroCompletoRpc(armarPayload({ p_offline_local_id: undefined }))
    );
    const resultados = await Promise.all(llamadas);

    const exitosos = resultados.filter(r => r.data?.ok && r.data.monto_aplicado > 0);
    const rechazados = resultados.filter(r => r.data && !r.data.ok);

    expect(exitosos).toHaveLength(1);
    expect(rechazados).toHaveLength(7);
    rechazados.forEach(r => expect(r.data.error).toBe('Una de las facturas ya está saldada'));

    // El punto central del hallazgo de la Etapa 6: total_cobrado nunca
    // superó total, ni siquiera transitoriamente.
    expect(estado.factura.total_cobrado).toBe(12329.9);
    expect(estado.factura.total_cobrado).toBeLessThanOrEqual(estado.factura.total);
    expect(estado.factura.estado).toBe('emitida');
  });

  it('2 cobros concurrentes que juntos cubren exactamente el saldo (mitad y mitad): los dos se aplican, ninguno se rechaza, total_cobrado cierra exacto', async () => {
    resetEstado({ total: 1000 });

    const [r1, r2] = await Promise.all([
      registrarCobroCompletoRpc(armarPayload({ p_monto: 500 })),
      registrarCobroCompletoRpc(armarPayload({ p_monto: 500 })),
    ]);

    expect(r1.data.ok).toBe(true);
    expect(r2.data.ok).toBe(true);
    expect(r1.data.monto_aplicado + r2.data.monto_aplicado).toBe(1000);
    expect(estado.factura.total_cobrado).toBe(1000);
    expect(estado.factura.estado).toBe('emitida');
  });

  it('2 cobros concurrentes que juntos EXCEDEN el saldo (600+600 contra 1000 de deuda): el segundo en aplicarse queda parcial, nunca se supera el total', async () => {
    resetEstado({ total: 1000 });

    const [r1, r2] = await Promise.all([
      registrarCobroCompletoRpc(armarPayload({ p_monto: 600 })),
      registrarCobroCompletoRpc(armarPayload({ p_monto: 600 })),
    ]);

    // Ambos "ok" (ninguno ve la factura ya saldada al momento de entrar),
    // pero el LEAST(monto, saldo, restante) del RPC real recorta lo que
    // se aplica de más — nunca se pasa del total.
    expect(r1.data.ok).toBe(true);
    expect(r2.data.ok).toBe(true);
    expect(r1.data.monto_aplicado + r2.data.monto_aplicado).toBe(1000);
    expect(estado.factura.total_cobrado).toBe(1000);
    expect(estado.factura.total_cobrado).toBeLessThanOrEqual(estado.factura.total);
  });

  it('mismo offline_local_id disparado 2 veces en paralelo (doble tap / reintento de red): dedupe — un solo cobro real, la 2da llamada devuelve ya_existia', async () => {
    resetEstado({ total: 12329.9 });

    const payload = armarPayload({ p_offline_local_id: 'cobro-manual-abc123' });
    const [r1, r2] = await Promise.all([
      registrarCobroCompletoRpc(payload),
      registrarCobroCompletoRpc(payload),
    ]);

    const resultados = [r1, r2];
    const ganador = resultados.find(r => r.data.ya_existia === false);
    const replay = resultados.find(r => r !== ganador);

    expect(ganador).toBeDefined();
    expect(replay).toBeDefined();
    expect(replay.data.ya_existia).toBe(true);
    expect(replay.data.cobro_id).toBe(ganador.data.cobro_id);

    expect(estado.cobrosCreados).toHaveLength(1);
    expect(estado.factura.total_cobrado).toBe(12329.9);
  });
});
