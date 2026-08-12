// tests/webhooks/whatsapp-firma.test.js
//
// Plan 3.2, punto 3: mismo criterio que el webhook de Mercado Pago —
// "sin firma → debe rechazar". Acá además fail-closed si falta
// WA_APP_SECRET (mismo patrón que se usó como referencia para corregir
// SEC-013 en el webhook de Mercado Pago).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { firmaValidaDeMeta } from '../../lib/handlers/notif.js';

const SECRET = 'test-secret-whatsapp';

function firmar(rawBody, secret = SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

function reqValido({ body = '{"entry":[]}', secret = SECRET } = {}) {
  const rawBody = Buffer.from(body);
  return {
    headers: { 'x-hub-signature-256': firmar(rawBody, secret) },
    rawBody,
  };
}

describe('firmaValidaDeMeta', () => {
  const originalSecret = process.env.WA_APP_SECRET;

  beforeEach(() => {
    process.env.WA_APP_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.WA_APP_SECRET;
    else process.env.WA_APP_SECRET = originalSecret;
  });

  it('acepta una firma válida calculada sobre el rawBody exacto', () => {
    expect(firmaValidaDeMeta(reqValido())).toBe(true);
  });

  it('rechaza (fail-closed) cuando WA_APP_SECRET no está configurado', () => {
    delete process.env.WA_APP_SECRET;
    expect(firmaValidaDeMeta(reqValido())).toBe(false);
  });

  it('rechaza cuando falta el header X-Hub-Signature-256', () => {
    const req = reqValido();
    delete req.headers['x-hub-signature-256'];
    expect(firmaValidaDeMeta(req)).toBe(false);
  });

  it('rechaza un header que no tiene el prefijo "sha256="', () => {
    const req = reqValido();
    req.headers['x-hub-signature-256'] = createHmac('sha256', SECRET).update(req.rawBody).digest('hex');
    expect(firmaValidaDeMeta(req)).toBe(false);
  });

  it('rechaza cuando el body fue alterado después de firmarlo', () => {
    const req = reqValido({ body: '{"entry":[{"id":1}]}' });
    req.rawBody = Buffer.from('{"entry":[{"id":2}]}'); // body distinto al firmado
    expect(firmaValidaDeMeta(req)).toBe(false);
  });

  it('rechaza cuando la firma fue calculada con un App Secret distinto', () => {
    const req = reqValido({ secret: 'otro-secreto-cualquiera' });
    expect(firmaValidaDeMeta(req)).toBe(false);
  });

  it('rechaza cuando falta rawBody (bodyParser se comió el body crudo)', () => {
    const req = reqValido();
    delete req.rawBody;
    expect(firmaValidaDeMeta(req)).toBe(false);
  });
});
