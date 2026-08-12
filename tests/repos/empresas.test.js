// tests/repos/empresas.test.js
//
// Fase 7 — el módulo `empresas` no tenía tests de repo todavía (checklist
// punto 5). Cubre las funciones nuevas sumadas al migrar
// lib/handlers/empresa.js (logo, datos editables, update), con foco en que
// cada query filtre por `empresa_id` — es la clase de bug que ya se auditó
// una vez en AUDITORIA_2026 y que una migración de repo mal hecha podría
// reintroducir (ej. un `.update()` sin `.eq('id', empresa_id)` tocaría la
// fila equivocada al primer registro que matchee).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  obtenerLogoUrl,
  actualizarLogoUrl,
  obtenerDatosEditables,
  actualizarDatosEmpresa,
  obtenerConfig,
  actualizarConfig,
} = await import('../../lib/repos/empresas.js');

// Mismo query builder falso que tests/repos/scores.test.js: encadenado
// devuelve `this`, los métodos terminales resuelven con el resultado dado.
function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq:     vi.fn(() => obj),
    update: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
});

describe('obtenerLogoUrl', () => {
  it('filtra por id de empresa y devuelve solo logo_url', async () => {
    const query = fakeQuery({ data: { logo_url: 'https://cdn/x/logo.webp' }, error: null });
    dbMock.from.mockReturnValue(query);

    const url = await obtenerLogoUrl('empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('empresas');
    expect(query.select).toHaveBeenCalledWith('logo_url');
    expect(query.eq).toHaveBeenCalledWith('id', 'empresa-1');
    expect(url).toBe('https://cdn/x/logo.webp');
  });

  it('devuelve null si la empresa no tiene logo cargado', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: { logo_url: null }, error: null }));

    const url = await obtenerLogoUrl('empresa-1');

    expect(url).toBeNull();
  });
});

describe('actualizarLogoUrl', () => {
  it('actualiza solo la fila de la empresa dueña del logo', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarLogoUrl('empresa-1', 'https://cdn/x/logo.webp');

    expect(query.update).toHaveBeenCalledWith({ logo_url: 'https://cdn/x/logo.webp' });
    expect(query.eq).toHaveBeenCalledWith('id', 'empresa-1');
  });

  it('propaga el error si el update falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'row not found' } }));

    await expect(actualizarLogoUrl('empresa-1', 'x')).rejects.toThrow(
      '[EmpresaRepo.actualizarLogoUrl] row not found',
    );
  });
});

describe('obtenerDatosEditables', () => {
  it('trae exactamente los campos editables + config, filtrado por empresa_id', async () => {
    const fila = {
      nombre: 'Acme', cuit: '20304050607', domicilio: 'Calle 1', telefono: '123',
      email: 'a@a.com', logo_url: null, config: { catalogo_publico_habilitado: true },
    };
    const query = fakeQuery({ data: fila, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerDatosEditables('empresa-1');

    expect(query.select).toHaveBeenCalledWith(
      'nombre, cuit, domicilio, telefono, email, logo_url, config',
    );
    expect(query.eq).toHaveBeenCalledWith('id', 'empresa-1');
    expect(data).toEqual(fila);
  });

  it('lanza si la empresa no existe (single() sin fila)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));

    await expect(obtenerDatosEditables('empresa-fantasma')).rejects.toThrow(
      '[EmpresaRepo.obtenerDatosEditables] no rows',
    );
  });
});

describe('actualizarDatosEmpresa', () => {
  it('actualiza filtrando por empresa_id y devuelve la fila resultante', async () => {
    const actualizado = { nombre: 'Acme SA', cuit: '20304050607', domicilio: null, telefono: null, email: null, logo_url: null };
    const query = fakeQuery({ data: actualizado, error: null });
    dbMock.from.mockReturnValue(query);

    const datos = await actualizarDatosEmpresa('empresa-1', { nombre: 'Acme SA', cuit: '20304050607' });

    expect(query.update).toHaveBeenCalledWith({ nombre: 'Acme SA', cuit: '20304050607' });
    expect(query.eq).toHaveBeenCalledWith('id', 'empresa-1');
    expect(datos).toEqual(actualizado);
  });

  it('propaga error.code (ej. 23505 de CUIT duplicado) para que el handler lo distinga', async () => {
    dbMock.from.mockReturnValue(
      fakeQuery({ data: null, error: { message: 'duplicate key', code: '23505' } }),
    );

    await expect(actualizarDatosEmpresa('empresa-1', { cuit: '20304050607' }))
      .rejects.toMatchObject({ code: '23505', message: expect.stringContaining('duplicate key') });
  });
});

describe('obtenerConfig / actualizarConfig (multi-tenant, ya existentes)', () => {
  it('actualizarConfig nunca toca otra empresa aunque cambien las claves internas', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarConfig('empresa-1', { catalogo_publico_habilitado: true, otra_clave: 'x' });

    expect(query.eq).toHaveBeenCalledWith('id', 'empresa-1');
    expect(query.eq).not.toHaveBeenCalledWith('id', expect.not.stringMatching('empresa-1'));
  });

  it('obtenerConfig devuelve {} si config es null, sin filtrar de otra empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: { config: null }, error: null }));

    const config = await obtenerConfig('empresa-1');

    expect(config).toEqual({});
  });
});
