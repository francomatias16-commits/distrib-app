// tests/handlers/facturas-notas-credito-emitir-parcial.test.js
//
// Etapa 7 (Bloque 1, Devoluciones) — v1049. Cubre el fix del hallazgo:
// `emitirNotaCreditoARCA` (lib/arca/wsfev1.js) ignora el monto real de la
// NC que se le pasa y siempre pide el CAE por el total COMPLETO de la
// factura original, además de anularla entera vía
// `persistir_nc_y_anular_factura` — sin importar si la NC nació de una
// devolución parcial (ej: 1 de 5 productos facturados).
//
// Fix en lib/handlers/facturas.js (accion=emitir de notas-credito): si la
// NC está vinculada a una factura y su total es menor al de esa factura,
// nunca se llama a emitirNotaCreditoARCA. Se aplica el crédito solo en
// cta_cte (mismo mecanismo que el modo manual sin config ARCA), sin tocar
// el estado de la factura, y se deja constancia en notas_error de que hay
// que declararla a mano en AFIP/ARCA.
//
// Este test no ejercita la migración 572 (el tope de "no exceder el total
// de la factura entre varias NC") — esa validación vive en SQL dentro de
// `crear_nota_credito` y necesita un test de integración contra Postgres
// real (mismo gap de cobertura documentado para las RPC de devoluciones
// desde v1048). Acá se cubre el comportamiento observable del handler JS.

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── Mocks de todo lo que lib/handlers/facturas.js importa a nivel de
//    módulo, para que cargarlo no dispare ningún efecto de lado real. ──
vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({}),
}));

const getUserSeguroMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ getUserSeguro: getUserSeguroMock }));

vi.mock('../../lib/facturas.js', () => ({
  emitirFactura: vi.fn(),
  anularFactura: vi.fn(),
}));

vi.mock('../../lib/arca/wsaa.js', () => ({
  obtenerTokenWSAA: vi.fn(),
}));

// La aserción central de este archivo: emitirNotaCreditoARCA NUNCA debe
// llamarse para una NC parcial.
const emitirNotaCreditoARCAMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/arca/wsfev1.js', () => ({
  emitirNotaCreditoARCA: emitirNotaCreditoARCAMock,
}));

vi.mock('../../lib/arca/comprobante-pdf.js', () => ({
  generarPDFComprobante: vi.fn().mockResolvedValue({ ok: true, url: 'https://example.test/pdf' }),
  obtenerUrlFirmadaComprobante: vi.fn(),
  rutaStorageComprobante: vi.fn(() => 'ruta/comprobante.pdf'),
}));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca rate-limitado
}));

vi.mock('../../lib/crypto-secrets.js', () => ({ cifrar: vi.fn() }));
vi.mock('../../lib/demo-mode.js', () => ({ esEmpresaDemo: vi.fn().mockResolvedValue(false) }));
vi.mock('../../lib/error-response.js', () => ({
  errorSeguro: (res, _err, status, mensaje) => res.status(status).json({ error: mensaje }),
}));

// puede(): se mockea abierto (true) — el foco de este test es la lógica
// de emisión parcial, no la matriz de permisos (esa ya tiene su propia
// cobertura en tests/handlers/*-permisos.test.js).
vi.mock('../../lib/permisos-service.js', () => ({ puede: vi.fn(() => true) }));

vi.mock('../../lib/handlers/registro.js', () => ({ validarCUIT: vi.fn() }));

const repoMock = vi.hoisted(() => ({
  perfil: { rol: 'dueno', empresa_id: 'empresa-1' },
  nc: null,
  cfgARCA: { id: 'cfg-1', homologacion: true },
  aplicarCtaCteLlamadas: [],
  actualizarNotaCreditoLlamadas: [],
}));

vi.mock('../../lib/repos/facturas.js', () => ({
  obtenerPerfilFacturas: vi.fn(() => Promise.resolve(repoMock.perfil)),
  obtenerNotaCreditoParaEmitir: vi.fn(() => Promise.resolve({ data: repoMock.nc, error: null })),
  obtenerConfigArcaActiva: vi.fn(() => Promise.resolve(repoMock.cfgARCA)),
  aplicarNotaCreditoCtaCteRpc: vi.fn((params) => {
    repoMock.aplicarCtaCteLlamadas.push(params);
    return Promise.resolve({ error: null });
  }),
  actualizarNotaCredito: vi.fn((id, campos) => {
    repoMock.actualizarNotaCreditoLlamadas.push({ id, campos });
    return Promise.resolve({ error: null });
  }),
  obtenerNotaCreditoActualizada: vi.fn(() => Promise.resolve({ ...repoMock.nc, estado: 'emitida' })),
}));

const { default: handler } = await import('../../lib/handlers/facturas.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

function reqEmitir(id = 'nc-1') {
  return {
    method: 'POST',
    query: { _svc: 'notas-credito', accion: 'emitir' },
    headers: { authorization: 'Bearer token-valido' },
    body: { id },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserSeguroMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  repoMock.perfil = { rol: 'dueno', empresa_id: 'empresa-1' };
  repoMock.cfgARCA = { id: 'cfg-1', homologacion: true };
  repoMock.aplicarCtaCteLlamadas = [];
  repoMock.actualizarNotaCreditoLlamadas = [];
});

describe('handleNotasCredito — accion=emitir — NC parcial no anula la factura completa (fix v1049)', () => {
  it('NC parcial (total menor al de la factura): no llama a emitirNotaCreditoARCA, acredita en cta_cte y deja nota para declarar a mano', async () => {
    repoMock.nc = {
      id: 'nc-1',
      tipo: 'B',
      total: 2000,
      estado: 'pendiente',
      factura_id: 'factura-1',
      facturas: { numero: 'B-00001-00000042', tipo: 'B', cae: 'cae-original', total: 10000, estado: 'emitida' },
    };

    const res = mockRes();
    await handler(reqEmitir(), res);

    expect(emitirNotaCreditoARCAMock).not.toHaveBeenCalled();
    expect(repoMock.aplicarCtaCteLlamadas).toHaveLength(1);
    expect(repoMock.aplicarCtaCteLlamadas[0]).toMatchObject({ p_nc_id: 'nc-1', p_cae: null, p_cae_vto: null });

    // Se deja constancia explícita de que falta declararla a mano en ARCA
    // — sin esto, el crédito queda invisible para contabilidad.
    expect(repoMock.actualizarNotaCreditoLlamadas).toHaveLength(1);
    expect(repoMock.actualizarNotaCreditoLlamadas[0].campos.notas_error).toMatch(/declarar.*manual/i);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ modo: 'manual_parcial' }),
    );
  });

  it('NC que cubre el total completo de la factura: sigue yendo por ARCA como antes (no rompe el camino feliz)', async () => {
    repoMock.nc = {
      id: 'nc-2',
      tipo: 'B',
      total: 10000,
      estado: 'pendiente',
      factura_id: 'factura-1',
      facturas: { numero: 'B-00001-00000042', tipo: 'B', cae: 'cae-original', total: 10000, estado: 'emitida' },
    };
    emitirNotaCreditoARCAMock.mockResolvedValue({
      ok: true, cae: 'cae-nc', caeVto: '2026-12-31', numero: 43, facturaNCId: 'factura-nc-1',
    });

    const res = mockRes();
    await handler(reqEmitir('nc-2'), res);

    expect(emitirNotaCreditoARCAMock).toHaveBeenCalledWith('factura-1', expect.any(String));
    expect(repoMock.aplicarCtaCteLlamadas).toHaveLength(1);
    expect(repoMock.aplicarCtaCteLlamadas[0]).toMatchObject({ p_cae: 'cae-nc' });
  });

  it('NC sin factura vinculada (factura_id null): no se la trata como parcial, sigue el flujo normal (manual, sin ARCA configurada)', async () => {
    repoMock.nc = {
      id: 'nc-3',
      tipo: 'B',
      total: 500,
      estado: 'pendiente',
      factura_id: null,
      facturas: null,
    };
    repoMock.cfgARCA = null; // sin config ARCA -> modo manual "de siempre"

    const res = mockRes();
    await handler(reqEmitir('nc-3'), res);

    expect(emitirNotaCreditoARCAMock).not.toHaveBeenCalled();
    expect(repoMock.aplicarCtaCteLlamadas).toHaveLength(1);
    // No debe llevar el mensaje de "NC parcial" — es el modo manual genérico
    // (sin config ARCA), no el branch nuevo del fix.
    expect(repoMock.actualizarNotaCreditoLlamadas).toHaveLength(0);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ modo: 'manual' }),
    );
  });
});
