// tests/handlers/saas-alertas-html-injection.test.js
//
// Regresión para v1056 (CHANGELOG_v1056_fix_html_injection_saas_alertas_nuevo_tenant.md):
// avisarNuevoTenant() interpolaba empresa.{nombre,email,cuit,saas_plan} sin
// escapar en el HTML del email que recibe el superadmin (SAAS_ALERTA_EMAIL),
// con esos datos cargados por cualquiera que se autoregistra
// (POST /api/registro). Cubre: fail-closed sin INTERNAL_PUSH_SECRET, 401 con
// secreto incorrecto, escape de los 4 campos (incluye payload
// <img onerror=...>), corte de \r\n en el subject (header injection), y que
// texto legítimo con apóstrofe/ampersand siga siendo legible tras el escape.
//
// NOTA: este archivo lo escribo yo ahora al armar el zip — el changelog
// v1056 (heredado de la sesión anterior) menciona un archivo con el mismo
// nombre y "6/6 OK", pero esa versión nunca me llegó adjunta. Este es un
// test nuevo equivalente, corrido acá mismo (ver resultado en el mensaje).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const enviarEmailMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true, id: 'email-test-1' })));

vi.mock('../../lib/email.js', () => ({
  enviarEmail: enviarEmailMock,
}));

const { default: saasAlertasHandler } = await import('../../lib/handlers/saas-alertas.js');

function mockReq({ headers = {}, body = {} } = {}) {
  return { method: 'POST', headers, body };
}

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

const EMPRESA_BASE = {
  id: 'empresa-1',
  nombre: 'Distribuidora Test',
  email: 'test@example.com',
  cuit: '20304050607',
  created_at: '2026-09-01T12:00:00.000Z',
  saas_trial_fin: '2026-09-15T00:00:00.000Z',
  saas_plan: 'trial',
};

beforeEach(() => {
  enviarEmailMock.mockClear();
  delete process.env.INTERNAL_PUSH_SECRET;
  delete process.env.SAAS_ALERTA_EMAIL;
});

describe('saasAlertasHandler — auth', () => {
  it('rechaza con 503 (fail-closed) si INTERNAL_PUSH_SECRET no está configurada', async () => {
    const res = mockRes();
    await saasAlertasHandler(mockReq({ body: { tipo: 'nuevo_tenant', empresa: EMPRESA_BASE } }), res);
    expect(res.statusCode).toBe(503);
    expect(enviarEmailMock).not.toHaveBeenCalled();
  });

  it('rechaza con 401 si el header x-push-secret no coincide', async () => {
    process.env.INTERNAL_PUSH_SECRET = 'secreto-real';
    const res = mockRes();
    await saasAlertasHandler(mockReq({
      headers: { 'x-push-secret': 'incorrecto' },
      body: { tipo: 'nuevo_tenant', empresa: EMPRESA_BASE },
    }), res);
    expect(res.statusCode).toBe(401);
    expect(enviarEmailMock).not.toHaveBeenCalled();
  });
});

describe('saasAlertasHandler — escape de HTML (fix v1056)', () => {
  beforeEach(() => {
    process.env.INTERNAL_PUSH_SECRET = 'secreto-real';
    process.env.SAAS_ALERTA_EMAIL = 'ruben@mfweb.example';
  });

  it('escapa un payload de inyección en el nombre de empresa', async () => {
    const res = mockRes();
    const empresa = { ...EMPRESA_BASE, nombre: '<img src=x onerror=fetch(1)>' };

    await saasAlertasHandler(mockReq({
      headers: { 'x-push-secret': 'secreto-real' },
      body: { tipo: 'nuevo_tenant', empresa },
    }), res);

    expect(res.statusCode).toBe(200);
    const html = enviarEmailMock.mock.calls[0][0].html;
    expect(html).not.toContain('<img src=x onerror=');
    expect(html).toContain('&lt;img src=x onerror=fetch(1)&gt;');
  });

  it('escapa email y CUIT también', async () => {
    const res = mockRes();
    const empresa = {
      ...EMPRESA_BASE,
      email: '"><script>alert(1)</script>',
      cuit: '<b>20-1</b>',
    };

    await saasAlertasHandler(mockReq({
      headers: { 'x-push-secret': 'secreto-real' },
      body: { tipo: 'nuevo_tenant', empresa },
    }), res);

    const html = enviarEmailMock.mock.calls[0][0].html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>20-1</b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('corta saltos de línea en el subject (header injection)', async () => {
    const res = mockRes();
    const empresa = { ...EMPRESA_BASE, nombre: 'Empresa Mala\r\nBcc: victima@evil.com' };

    await saasAlertasHandler(mockReq({
      headers: { 'x-push-secret': 'secreto-real' },
      body: { tipo: 'nuevo_tenant', empresa },
    }), res);

    const subject = enviarEmailMock.mock.calls[0][0].subject;
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('texto legítimo con apóstrofe y ampersand se sigue viendo legible', async () => {
    const res = mockRes();
    const empresa = { ...EMPRESA_BASE, nombre: "Almacén O'Higgins & Cía." };

    await saasAlertasHandler(mockReq({
      headers: { 'x-push-secret': 'secreto-real' },
      body: { tipo: 'nuevo_tenant', empresa },
    }), res);

    const html = enviarEmailMock.mock.calls[0][0].html;
    // escapeHtml solo transforma & < > " ' — los acentos quedan intactos.
    expect(html).toContain('Almacén O&#39;Higgins &amp; Cía.');
  });

  it('responde 400 si faltan tipo o empresa', async () => {
    const res = mockRes();
    await saasAlertasHandler(mockReq({
      headers: { 'x-push-secret': 'secreto-real' },
      body: { tipo: 'nuevo_tenant' },
    }), res);
    expect(res.statusCode).toBe(400);
  });
});
