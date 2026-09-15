// tests/arca/comprobante-pdf-logo.test.js
//
// Bug real: el PDF del comprobante (lib/arca/comprobante-pdf.js) nunca
// dibujaba el logo de la empresa aunque estuviera cargado en
// empresa-config (empresas.logo_url) — el select ni siquiera lo traía y
// no había ningún doc.image() para él. Estos tests cubren el helper
// nuevo, obtenerLogoBufferPng(), que descarga logo_url (una signed URL) y
// lo normaliza a PNG con sharp antes de que pdfkit lo dibuje (pdfkit solo
// soporta PNG/JPEG, pero el input de subida acepta también WebP y SVG).
import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { obtenerLogoBufferPng } from '../../lib/arca/comprobante-pdf.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

function mockFetchOk(bodyBuffer) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength),
  }));
}

describe('obtenerLogoBufferPng', () => {
  it('devuelve null sin llamar a fetch si no hay logo_url (empresa sin logo configurado)', async () => {
    globalThis.fetch = vi.fn();
    const out = await obtenerLogoBufferPng(null);
    expect(out).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('devuelve null (no lanza) si la descarga de la signed URL falla', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403 }));
    const out = await obtenerLogoBufferPng('https://signed-url-vencida.example/logo.png');
    expect(out).toBeNull();
  });

  it('devuelve null (no lanza) si fetch tira una excepción de red', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    const out = await obtenerLogoBufferPng('https://storage.example/logo.png');
    expect(out).toBeNull();
  });

  it('normaliza un PNG a PNG (caso más común) y produce un buffer válido para pdfkit', async () => {
    const png = await sharp({ create: { width: 500, height: 300, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
    mockFetchOk(png);

    const out = await obtenerLogoBufferPng('https://storage.example/logo.png');
    expect(out).not.toBeNull();
    expect(out.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true); // firma PNG

    // pdfkit tiene que poder dibujarlo sin explotar (esto es lo que
    // rompía antes del fix: subir el logo como WebP tiraba un error de
    // pdfkit que abortaba la generación del PDF completo).
    const doc = new PDFDocument({ size: 'A4' });
    expect(() => doc.image(out, 10, 10, { fit: [44, 48] })).not.toThrow();
    doc.end();
  });

  it('normaliza un logo subido como WebP (formato permitido por el input pero no soportado por pdfkit)', async () => {
    const webp = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).webp().toBuffer();
    mockFetchOk(webp);

    const out = await obtenerLogoBufferPng('https://storage.example/logo.webp');
    expect(out).not.toBeNull();
    expect(out.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);

    const doc = new PDFDocument({ size: 'A4' });
    expect(() => doc.image(out, 10, 10, { fit: [44, 48] })).not.toThrow();
    doc.end();
  });

  it('achica un logo grande a un tamaño razonable para embeber (no infla el PDF)', async () => {
    const grande = await sharp({ create: { width: 2000, height: 1500, channels: 4, background: { r: 5, g: 5, b: 5, alpha: 1 } } }).png().toBuffer();
    mockFetchOk(grande);

    const out = await obtenerLogoBufferPng('https://storage.example/logo-grande.png');
    const meta = await sharp(out).metadata();
    expect(meta.width).toBeLessThanOrEqual(240);
    expect(meta.height).toBeLessThanOrEqual(240);
  });

  it('devuelve null (no lanza) si el contenido descargado no es una imagen válida', async () => {
    mockFetchOk(Buffer.from('esto no es una imagen'));
    const out = await obtenerLogoBufferPng('https://storage.example/logo.png');
    expect(out).toBeNull();
  });
});
