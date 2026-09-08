// tests/repos/asistente-uso.test.js
//
// Frente 3 de PLAN_OPTIMIZACION_ASISTENTE_2026.md (migración 601): confirma
// que insertarUsoAsistente() propaga los 3 campos nuevos
// (cayo_en_nucleo_fallback, cantidad_tools_con_match, tool_finalmente_usada)
// al insert de asistente_uso, y que sigue funcionando sin ellos (opcionales,
// para no romper ningún call site viejo que no los pase).
//
// Frente 2 de PLAN_OPTIMIZACION_ASISTENTE_2026.md (migración 602): suma
// metodo_seleccion_tools ('semantica' | 'keywords' | 'nucleo_fallback'),
// mismo criterio opcional.

import { vi, describe, it, expect } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { insertarUsoAsistente } = await import('../../lib/repos/asistente.js');

describe('insertarUsoAsistente — Frente 3 (logging de selección de tools)', () => {
  it('propaga los 3 campos nuevos al insert', async () => {
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    dbMock.from.mockReturnValue({ insert: insertMock });

    await insertarUsoAsistente({
      usuario_id: 'u1',
      empresa_id: 'e1',
      pregunta: 'cuánto vale mi stock total',
      proveedor_usado: 'groq',
      articulos_encontrados: 0,
      latencia_ms: 500,
      cayo_en_nucleo_fallback: false,
      cantidad_tools_con_match: 3,
      tool_finalmente_usada: 'consultar_stock_valorizacion',
      metodo_seleccion_tools: 'keywords',
    });

    expect(dbMock.from).toHaveBeenCalledWith('asistente_uso');
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      cayo_en_nucleo_fallback: false,
      cantidad_tools_con_match: 3,
      tool_finalmente_usada: 'consultar_stock_valorizacion',
      metodo_seleccion_tools: 'keywords',
    }));
  });

  it('sin pasar los campos nuevos, los manda como undefined (no rompe, no inventa default)', async () => {
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    dbMock.from.mockReturnValue({ insert: insertMock });

    await insertarUsoAsistente({
      usuario_id: 'u1',
      empresa_id: 'e1',
      pregunta: 'hola',
      proveedor_usado: 'gemini',
      articulos_encontrados: 0,
      latencia_ms: 300,
    });

    const payload = insertMock.mock.calls[0][0];
    expect(payload.cayo_en_nucleo_fallback).toBeUndefined();
    expect(payload.cantidad_tools_con_match).toBeUndefined();
    expect(payload.tool_finalmente_usada).toBeUndefined();
    expect(payload.metodo_seleccion_tools).toBeUndefined();
  });

  it('Frente 2: propaga metodo_seleccion_tools="semantica" al insert', async () => {
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    dbMock.from.mockReturnValue({ insert: insertMock });

    await insertarUsoAsistente({
      usuario_id: 'u1',
      empresa_id: 'e1',
      pregunta: 'clientes morosos',
      proveedor_usado: 'groq',
      articulos_encontrados: 0,
      latencia_ms: 420,
      cayo_en_nucleo_fallback: false,
      cantidad_tools_con_match: 1,
      tool_finalmente_usada: 'listar_clientes_por_deuda',
      metodo_seleccion_tools: 'semantica',
    });

    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      metodo_seleccion_tools: 'semantica',
    }));
  });
});
