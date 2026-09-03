// tests/lib/email-html-injection.test.js
//
// Regresión para v1059 (CHANGELOG_v1059_fix_html_injection_lib_email.md):
// las 5 funciones de lib/email.js interpolaban campos de texto libre
// (empresa.nombre, razon_social del cliente/proveedor, notas de pedido,
// descripción de movimientos, nombre de producto, link de recuperación de
// contraseña, foto_url del remito) sin escapar en el HTML de emails
// transaccionales que le llegan a un actor DISTINTO de quien cargó el dato
// (cliente o proveedor de la empresa) — mismo patrón que el hallazgo de
// saas-alertas.js (v1056), ahora aplicado a los 5 templates de este archivo.
//
// Cubre: escape de HTML en el body de las 5 funciones (payload
// <script>/<img onerror>), que el subject (texto plano, no HTML) mantenga
// el valor crudo sin doble-escapar pero con \r\n recortado (header
// injection), y que texto legítimo con apóstrofe/ampersand siga siendo
// legible tras el escape.

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/demo-mode.js', () => ({
  esEmpresaDemo: vi.fn(() => Promise.resolve(false)),
}));

let capturedBody = null;
const originalFetch = global.fetch;

beforeEach(() => {
  capturedBody = null;
  process.env.RESEND_API_KEY = 're_test';
  process.env.EMAIL_FROM = 'no-responder@test.example';
  global.fetch = vi.fn(async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ id: 'email-test-1' }) };
  });
});

const {
  enviarEmailConfirmacionPedido,
  enviarEmailDespacho,
  enviarEmailRecuperacionPassword,
  enviarEmailEstadoCuenta,
  enviarEmailRecepcionProveedor,
} = await import('../../lib/email.js');

const PAYLOAD = '<script>alert(1)</script>"\'';
const EMPRESA = { id: 'empresa-1', nombre: PAYLOAD, email: 'empresa@test.example' };

describe('lib/email.js — escape de HTML (fix v1059)', () => {
  it('enviarEmailConfirmacionPedido escapa empresa.nombre, razon_social, notas_cliente y nombre de item', async () => {
    await enviarEmailConfirmacionPedido(
      { id: 'pedido-1', numero: 'P-1', total: 100, notas_cliente: PAYLOAD },
      { email: 'cliente@test.example', razon_social: PAYLOAD },
      EMPRESA,
      [{ nombre: PAYLOAD, cantidad: 1, precio_unitario: 10 }],
    );
    expect(capturedBody.html).not.toContain('<script>alert(1)</script>');
    expect(capturedBody.html).toContain('&lt;script&gt;');
  });

  it('enviarEmailDespacho escapa empresa.nombre y razon_social', async () => {
    await enviarEmailDespacho(
      { id: 'pedido-1', numero: 'P-1', total: 100 },
      { email: 'cliente@test.example', razon_social: PAYLOAD },
      EMPRESA,
    );
    expect(capturedBody.html).not.toContain('<script>alert(1)</script>');
  });

  it('enviarEmailRecuperacionPassword escapa empresa.nombre y el link (atributo href)', async () => {
    const linkMalicioso = 'https://x.test/reset"><script>alert(1)</script>';
    await enviarEmailRecuperacionPassword('cliente@test.example', linkMalicioso, EMPRESA);
    expect(capturedBody.html).not.toContain('"><script>alert(1)</script>');
  });

  it('enviarEmailEstadoCuenta escapa nombre de cliente, número de factura, descripción de movimiento y enviadoPor', async () => {
    await enviarEmailEstadoCuenta(
      { email: 'cliente@test.example', razon_social: PAYLOAD },
      { total: 100, vencida: 0, porVencer: 0 },
      [{ numero: PAYLOAD, total: 100, total_cobrado: 0 }],
      [{ descripcion: PAYLOAD, monto: 10 }],
      EMPRESA,
      { nombre: PAYLOAD },
    );
    expect(capturedBody.html).not.toContain('<script>alert(1)</script>');
  });

  it('enviarEmailRecepcionProveedor escapa razon_social, nombre de item y foto_url (atributo href)', async () => {
    await enviarEmailRecepcionProveedor(
      { email: 'proveedor@test.example', razon_social: PAYLOAD },
      { numero: PAYLOAD },
      { foto_url: 'https://x.test/foto"><script>alert(1)</script>' },
      [{ nombre: PAYLOAD }],
      [],
      EMPRESA,
    );
    expect(capturedBody.html).not.toContain('<script>alert(1)</script>');
  });

  it('el subject no escapa entidades HTML (es texto plano) pero recorta \\r\\n', async () => {
    const empresaConSaltoDeLinea = { ...EMPRESA, nombre: 'Distribuidora\r\nBcc: atacante@evil.example' };
    await enviarEmailDespacho(
      { id: 'pedido-1', numero: 'P-1', total: 100 },
      { email: 'cliente@test.example', razon_social: 'Cliente & Cía' },
      empresaConSaltoDeLinea,
    );
    expect(capturedBody.subject).not.toMatch(/[\r\n]/);
    expect(capturedBody.subject).not.toContain('&amp;');
  });

  it('texto legítimo con apóstrofe/ampersand se sigue viendo legible tras el escape', async () => {
    await enviarEmailDespacho(
      { id: 'pedido-1', numero: 'P-1', total: 100 },
      { email: 'cliente@test.example', razon_social: "O'Higgins & Cía" },
      { ...EMPRESA, nombre: "Distribuidora S.A. & Cía" },
    );
    expect(capturedBody.html).toContain('O&#39;Higgins');
    expect(capturedBody.html).toContain('Distribuidora S.A. &amp; Cía');
  });
});
