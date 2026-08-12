// tests/webhooks/mp-firma.test.js
//
// Plan 3.2, punto 3: "un test que force 'sin firma → debe rechazar' evita
// que alguien reintroduzca el bug sin querer". Este es el caso SEC-013:
// antes, si WEBHOOK_SECRET_MP no estaba configurado, el webhook aceptaba
// cualquier request sin firma (fail-open). Se corrigió a fail-closed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { verificarFirmaMP } from '../../lib/handlers/pagos.js';

const SECRET = 'test-secret-mp';

function firmarManifest({ dataId, requestId, ts, secret = SECRET }) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts}`;
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

function reqValido({ dataId = 'pago-123', requestId = 'req-1', ts = '1700000000', secret = SECRET } = {}) {
  const v1 = firmarManifest({ dataId, requestId, ts, secret });
  return {
    headers: {
      'x-signature':  `ts=${ts},v1=${v1}`,
      'x-request-id': requestId,
    },
    body: { data: { id: dataId } },
  };
}

describe('verificarFirmaMP', () => {
  const originalSecret = process.env.WEBHOOK_SECRET_MP;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET_MP = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.WEBHOOK_SECRET_MP;
    else process.env.WEBHOOK_SECRET_MP = originalSecret;
  });

  it('acepta una firma válida calculada con el secreto correcto', () => {
    expect(verificarFirmaMP(reqValido())).toBe(true);
  });

  it('rechaza (fail-closed) cuando WEBHOOK_SECRET_MP no está configurado — SEC-013', () => {
    delete process.env.WEBHOOK_SECRET_MP;
    expect(verificarFirmaMP(reqValido())).toBe(false);
  });

  it('rechaza cuando falta el header x-signature', () => {
    const req = reqValido();
    delete req.headers['x-signature'];
    expect(verificarFirmaMP(req)).toBe(false);
  });

  it('rechaza un header x-signature malformado (sin ts o sin v1)', () => {
    const req = reqValido();
    req.headers['x-signature'] = 'ts=1700000000'; // falta v1
    expect(verificarFirmaMP(req)).toBe(false);
  });

  it('rechaza cuando la firma fue calculada con un secreto distinto', () => {
    const req = reqValido({ secret: 'otro-secreto-cualquiera' });
    expect(verificarFirmaMP(req)).toBe(false);
  });

  it('rechaza cuando el data.id del body no coincide con el firmado', () => {
    const req = reqValido({ dataId: 'pago-123' });
    req.body.data.id = 'pago-999'; // alguien alteró el body después de firmarlo
    expect(verificarFirmaMP(req)).toBe(false);
  });

  it('rechaza cuando el x-request-id no coincide con el firmado', () => {
    const req = reqValido({ requestId: 'req-1' });
    req.headers['x-request-id'] = 'req-otro';
    expect(verificarFirmaMP(req)).toBe(false);
  });
});
