// tests/asistente/fase1-prompt-correccion.test.js
//
// Fase 1 del plan de robustez conversacional — la mitad que faltaba de
// test: fase1-correccion-sin-reiniciar.test.js ya cubre el mecanismo
// server-side (ejecutarTool/resolverAccionPendiente en
// lib/asistente-tools/index.js: reemplazo atómico, TTL, cancelar). Lo que
// NO estaba cubierto es la mitad de PROMPT (lib/handlers/asistente.js):
//   - armarSystemPrompt(): si hay una propuesta vigente, el bloque que se
//     le agrega al prompt de Gemini (conTools) tiene que decir CUÁL
//     herramienta y CUÁL resumen — literal, para que el modelo la
//     reconozca y la vuelva a llamar con el dato corregido. La variante
//     sinTools (Groq/OpenRouter, sin function calling) nunca debe
//     mencionarla: esos proveedores no pueden volver a llamar nada.
//   - obtenerPropuestaVigentePara(): el filtro de TTL — una propuesta ya
//     vencida no debe ofrecerse para "corregir" (ya no se puede confirmar,
//     así que decirle al modelo que la corrija sería mentirle).
//
// armarSystemPrompt se importa tal cual (función pura, sin dependencias
// que mockear — ver export al final de asistente.js). Para
// obtenerPropuestaVigentePara se mockea únicamente lib/repos/asistente.js
// (de donde sale obtenerAccionPendienteVigente).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const repoMock = vi.hoisted(() => ({ obtenerAccionPendienteVigente: vi.fn() }));
vi.mock('../../lib/repos/asistente.js', () => ({
  contarUsosAsistenteDesde: vi.fn(),
  obtenerConversacionSiVigente: vi.fn(),
  crearConversacion: vi.fn(),
  listarUltimosMensajes: vi.fn(),
  insertarMensajes: vi.fn(),
  tocarConversacion: vi.fn(),
  buscarArticulosAsistenteRpc: vi.fn(),
  buscarToolsAsistenteRpc: vi.fn(), // Frente 2 (PLAN_OPTIMIZACION_ASISTENTE_2026.md)
  insertarUsoAsistente: vi.fn(),
  obtenerAccionPendienteVigente: repoMock.obtenerAccionPendienteVigente,
}));

const { armarSystemPrompt, obtenerPropuestaVigentePara } = await import('../../lib/handlers/asistente.js');
const { TTL_CONFIRMACION_MS } = await import('../../lib/asistente-tools.js');

const CONVERSACION_ID = 'conv-1';

beforeEach(() => {
  repoMock.obtenerAccionPendienteVigente.mockReset();
});

describe('armarSystemPrompt — nota de propuesta vigente (Fase 1)', () => {
  it('sin propuesta vigente: el prompt conTools NO menciona ninguna propuesta sin confirmar', () => {
    const { conTools } = armarSystemPrompt({ articulos: [], rol: 'dueno', propuestaVigente: null });
    expect(conTools).not.toContain('propuesta sin confirmar todavía');
  });

  it('con propuesta vigente: el prompt conTools menciona la herramienta exacta y el resumen exacto', () => {
    const { conTools } = armarSystemPrompt({
      articulos: [],
      rol: 'dueno',
      propuestaVigente: { toolNombre: 'ajustar_stock_asistente', resumen: 'Sumar 5 de "Fideos" en "Depósito Central" por motivo "ajuste_manual". Stock: 10 → 15.' },
    });
    expect(conTools).toContain('hay una propuesta sin confirmar todavía en esta conversación (herramienta "ajustar_stock_asistente")');
    expect(conTools).toContain('Sumar 5 de "Fideos" en "Depósito Central" por motivo "ajuste_manual". Stock: 10 → 15.');
    expect(conTools).toContain('volvé a llamar la misma herramienta');
    expect(conTools).toContain('(ajustar_stock_asistente) con el dato corregido');
  });

  it('con propuesta vigente: instruye a NO pedir que repita todo, y a tratar un tema no relacionado como abandonada', () => {
    const { conTools } = armarSystemPrompt({
      articulos: [],
      rol: 'admin',
      propuestaVigente: { toolNombre: 'editar_producto', resumen: 'Producto "Fideos": precio $1.200.' },
    });
    expect(conTools).toContain('no le pidas');
    expect(conTools).toContain('que repita todo desde cero');
    expect(conTools).toContain('tratala como abandonada');
  });

  it('con propuesta vigente Y artículos de ayuda encontrados: la nota se agrega igual, al final del bloque de tools', () => {
    const { conTools } = armarSystemPrompt({
      articulos: [{ titulo: 'Cómo cargar un pedido', contenido: 'Paso 1...' }],
      rol: 'vendedor',
      propuestaVigente: { toolNombre: 'crear_pedido', resumen: 'Crear pedido a Juan Pérez.' },
    });
    expect(conTools).toContain('Artículo 1: Cómo cargar un pedido');
    expect(conTools).toContain('herramienta "crear_pedido"');
    // La nota de propuesta va en el bloque de tools, ANTES del contexto de artículos.
    expect(conTools.indexOf('herramienta "crear_pedido"')).toBeLessThan(conTools.indexOf('Artículo 1'));
  });

  it('la variante sinTools (Groq/OpenRouter) NUNCA menciona la propuesta vigente, así exista', () => {
    const { sinTools } = armarSystemPrompt({
      articulos: [],
      rol: 'dueno',
      propuestaVigente: { toolNombre: 'ajustar_stock_asistente', resumen: 'Sumar 5 de "Fideos"...' },
    });
    expect(sinTools).not.toContain('propuesta sin confirmar');
    expect(sinTools).not.toContain('ajustar_stock_asistente');
    expect(sinTools).toContain('NO tenés acceso a herramientas');
  });

  it('sin artículos ni propuesta vigente: usa la rama de "no se encontró ningún artículo" tal cual', () => {
    const { conTools } = armarSystemPrompt({ articulos: [], rol: 'dueno', propuestaVigente: null });
    expect(conTools).toContain('No se encontró ningún artículo de la base de conocimiento relacionado con la pregunta.');
  });
});

describe('obtenerPropuestaVigentePara — filtro de TTL', () => {
  it('sin ninguna acción pendiente: devuelve null', async () => {
    repoMock.obtenerAccionPendienteVigente.mockResolvedValue({ data: null, error: null });
    const res = await obtenerPropuestaVigentePara(CONVERSACION_ID);
    expect(res).toBeNull();
  });

  it('con una acción pendiente reciente: devuelve toolNombre + resumen', async () => {
    repoMock.obtenerAccionPendienteVigente.mockResolvedValue({
      data: { tool_nombre: 'editar_producto', resumen: 'Producto "Fideos": precio $1.200.', creado_en: new Date().toISOString() },
      error: null,
    });
    const res = await obtenerPropuestaVigentePara(CONVERSACION_ID);
    expect(res).toEqual({ toolNombre: 'editar_producto', resumen: 'Producto "Fideos": precio $1.200.' });
  });

  it('acción pendiente ya vencida por TTL: devuelve null (no se ofrece "corregir" algo que no se puede confirmar)', async () => {
    const creadaHaceMucho = new Date(Date.now() - TTL_CONFIRMACION_MS - 60_000).toISOString();
    repoMock.obtenerAccionPendienteVigente.mockResolvedValue({
      data: { tool_nombre: 'editar_producto', resumen: 'Producto "Fideos": precio $1.200.', creado_en: creadaHaceMucho },
      error: null,
    });
    const res = await obtenerPropuestaVigentePara(CONVERSACION_ID);
    expect(res).toBeNull();
  });

  it('justo en el borde del TTL (recién dentro del límite): sigue vigente', async () => {
    const creadaJustoDentro = new Date(Date.now() - TTL_CONFIRMACION_MS + 5_000).toISOString();
    repoMock.obtenerAccionPendienteVigente.mockResolvedValue({
      data: { tool_nombre: 'editar_producto', resumen: 'Producto "Fideos": precio $1.200.', creado_en: creadaJustoDentro },
      error: null,
    });
    const res = await obtenerPropuestaVigentePara(CONVERSACION_ID);
    expect(res).not.toBeNull();
  });

  it('si la consulta falla: no revienta el turno, devuelve null y solo loguea', async () => {
    repoMock.obtenerAccionPendienteVigente.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await obtenerPropuestaVigentePara(CONVERSACION_ID);
    expect(res).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
