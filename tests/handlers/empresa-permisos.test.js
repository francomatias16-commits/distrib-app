// tests/handlers/empresa-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta migración
// a PermisosService. Foco: mismo comportamiento observable que el
// ROLES_ADMIN original — un único gate resuelto en `requerirPerfilAdmin()`,
// compartido por logo/icon/datos/catalogo-publico.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: { storage: {} } }));

const reposMock = vi.hoisted(() => ({
  obtenerLogoUrl: vi.fn(async () => null),
  actualizarLogoUrl: vi.fn(async () => {}),
  obtenerDatosEditables: vi.fn(async () => ({ nombre: 'Empresa Test', config: {}, slug: 'empresa-test' })),
  actualizarDatosEmpresa: vi.fn(async () => ({})),
  obtenerConfig: vi.fn(async () => ({})),
  actualizarConfig: vi.fn(async () => ({})),
  actualizarSlug: vi.fn(async () => ({ slug: 'empresa-test' })),
}));
vi.mock('../../lib/repos/empresas.js', () => reposMock);

// 605: repo de resumen de visitas del catálogo (tracking de origen)
const catalogoVisitasMock = vi.hoisted(() => ({
  obtenerResumenVisitasCatalogo: vi.fn(async () => []),
}));
vi.mock('../../lib/repos/catalogo-visitas.js', () => catalogoVisitasMock);

// 951: bwip-js real genera un PNG de verdad (lento e innecesario en un test
// de permisos/headers) — se mockea al mínimo contrato que usa el handler.
const bwipToBufferMock = vi.hoisted(() => vi.fn((opts, cb) => cb(null, Buffer.from('png-fake'))));
vi.mock('bwip-js', () => ({ default: { toBuffer: bwipToBufferMock } }));

const { default: handler } = await import('../../lib/handlers/empresa.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function reqCon() {
  return {
    method: 'GET',
    query: { _svc: 'datos' },
    headers: { authorization: 'Bearer token-valido' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gate único de configuración (ROLES_ADMIN original)', () => {
  it.each(['dueno', 'admin'])('%s puede acceder (sin 403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.obtenerDatosEditables).toHaveBeenCalledWith('e1');
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede acceder (403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos' });
    expect(reposMock.obtenerDatosEditables).not.toHaveBeenCalled();
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// 951: GET /api/empresa/catalogo-qr
describe('GET /api/empresa/catalogo-qr', () => {
  function reqQr(extra = {}) {
    return {
      method: 'GET',
      query: { _svc: 'catalogo-qr' },
      headers: { authorization: 'Bearer token-valido', host: 'app.distrib.com.ar' },
      ...extra,
    };
  }

  it('vendedor NO puede acceder (403), mismo gate que el resto de la sección', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'vendedor' });
    const res = mockRes();

    await handler(reqQr(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(bwipToBufferMock).not.toHaveBeenCalled();
  });

  it('admin recibe un PNG con el link armado del lado del server (no confía en query)', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'admin' });
    const res = mockRes();

    await handler(reqQr(), res);

    expect(reposMock.obtenerDatosEditables).toHaveBeenCalledWith('e1');
    expect(bwipToBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bcid: 'qrcode',
        text: 'https://app.distrib.com.ar/cliente/catalogo/empresa-test',
      }),
      expect.any(Function)
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('png-fake'));
  });

  it('sin slug asignado, cae al link con ?empresa_id= (mismo criterio que el frontend)', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'dueno' });
    reposMock.obtenerDatosEditables.mockResolvedValueOnce({ nombre: 'Empresa Test', config: {}, slug: null });
    const res = mockRes();

    await handler(reqQr(), res);

    expect(bwipToBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'https://app.distrib.com.ar/cliente/catalogo?empresa_id=e1' }),
      expect.any(Function)
    );
  });

  it('error de bwip-js → 500 sin filtrar el error crudo', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'admin' });
    bwipToBufferMock.mockImplementationOnce((opts, cb) => cb(new Error('boom interno'), null));
    const res = mockRes();

    await handler(reqQr(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// 605: GET /api/empresa/catalogo-visitas
describe('GET /api/empresa/catalogo-visitas', () => {
  function reqVisitas(query = {}) {
    return {
      method: 'GET',
      query: { _svc: 'catalogo-visitas', ...query },
      headers: { authorization: 'Bearer token-valido' },
    };
  }

  it('vendedor NO puede acceder (403), mismo gate que el resto de la sección', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'vendedor' });
    const res = mockRes();

    await handler(reqVisitas(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(catalogoVisitasMock.obtenerResumenVisitasCatalogo).not.toHaveBeenCalled();
  });

  it('admin recibe el resumen con el empresa_id del perfil (nunca de query)', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'admin' });
    catalogoVisitasMock.obtenerResumenVisitasCatalogo.mockResolvedValueOnce([
      { origen: 'ig-bio', visitas: 12, ultima_visita: '2026-09-01T00:00:00Z' },
      { origen: 'directo', visitas: 3, ultima_visita: '2026-08-30T00:00:00Z' },
    ]);
    const res = mockRes();

    // empresa_id: 'otra-empresa' en query no debería tener ningún efecto
    await handler(reqVisitas({ empresa_id: 'otra-empresa' }), res);

    expect(catalogoVisitasMock.obtenerResumenVisitasCatalogo).toHaveBeenCalledWith('e1', 30);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      dias: 30,
      resumen: [
        { origen: 'ig-bio', visitas: 12, ultima_visita: '2026-09-01T00:00:00Z' },
        { origen: 'directo', visitas: 3, ultima_visita: '2026-08-30T00:00:00Z' },
      ],
    });
  });

  it('acepta ?dias= y lo acota entre 1 y 365', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'dueno' });
    const res = mockRes();

    await handler(reqVisitas({ dias: '7' }), res);
    expect(catalogoVisitasMock.obtenerResumenVisitasCatalogo).toHaveBeenCalledWith('e1', 7);

    await handler(reqVisitas({ dias: '9999' }), res);
    expect(catalogoVisitasMock.obtenerResumenVisitasCatalogo).toHaveBeenCalledWith('e1', 365);

    await handler(reqVisitas({ dias: 'no-es-numero' }), res);
    expect(catalogoVisitasMock.obtenerResumenVisitasCatalogo).toHaveBeenCalledWith('e1', 30);
  });
});
