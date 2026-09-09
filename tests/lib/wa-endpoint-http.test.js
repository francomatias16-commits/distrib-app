// tests/lib/wa-endpoint-http.test.js
//
// Cobertura nueva para lib/wa-endpoint-http.js (fix retomando
// PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md, sep 2026): el guard de
// WA_ENDPOINT no configurado (mismo criterio que enviarAvisoChequesPorVencer)
// y el parseo defensivo de una respuesta no-JSON (HTML de error, etc.) que
// antes producía un SyntaxError genérico en los 5 emisores de WhatsApp.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { waEndpointConfigurado, leerRespuestaWa } from '../../lib/wa-endpoint-http.js';

describe('waEndpointConfigurado', () => {
  const original = process.env.WA_ENDPOINT;
  afterEach(() => {
    if (original === undefined) delete process.env.WA_ENDPOINT;
    else process.env.WA_ENDPOINT = original;
  });

  it('es false si WA_ENDPOINT no está seteada', () => {
    delete process.env.WA_ENDPOINT;
    expect(waEndpointConfigurado()).toBe(false);
  });

  it('es true si WA_ENDPOINT está seteada', () => {
    process.env.WA_ENDPOINT = 'https://ejemplo.com/api/notif/whatsapp';
    expect(waEndpointConfigurado()).toBe(true);
  });
});

describe('leerRespuestaWa', () => {
  function mockResp({ status = 200, contentType = 'application/json', body = '{}' } = {}) {
    return {
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => JSON.parse(body),
      text: async () => body,
    };
  }

  it('parsea JSON normalmente cuando el content-type es application/json', async () => {
    const resp = mockResp({ body: '{"ok":true,"message_id":"abc123"}' });
    const resultado = await leerRespuestaWa(resp);
    expect(resultado.esJson).toBe(true);
    expect(resultado.data).toEqual({ ok: true, message_id: 'abc123' });
  });

  it('no revienta con SyntaxError si el body es HTML — devuelve motivo descriptivo', async () => {
    const resp = mockResp({ status: 404, contentType: 'text/html; charset=utf-8', body: '<!DOCTYPE html><html>404</html>' });
    const resultado = await leerRespuestaWa(resp);
    expect(resultado.esJson).toBe(false);
    expect(resultado.motivo).toContain('404');
    expect(resultado.motivo).toContain('text/html');
  });

  it('cubre el caso de content-type JSON pero body inválido (no debería tirar)', async () => {
    const resp = mockResp({ status: 200, contentType: 'application/json', body: 'no es json de verdad' });
    const resultado = await leerRespuestaWa(resp);
    expect(resultado.esJson).toBe(false);
    expect(resultado.motivo).toContain('200');
  });
});
