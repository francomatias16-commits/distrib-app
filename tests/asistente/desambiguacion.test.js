// tests/asistente/desambiguacion.test.js
//
// Fase 5 del plan de robustez conversacional. Casos del primer lote
// pedido explícitamente en el plan: "Nombres de producto casi idénticos
// (el caso de la captura) → debe resolver sin preguntar dos veces", y
// "Cliente inactivo en crear_pedido → debe bloquear con mensaje claro,
// no un error de SQL crudo".
//
// lib/asistente-tools/_helpers.js importa un montón de módulos (handlers,
// repos) que a su vez importan `db` desde lib/repos/_db.js — mockear ESE
// único módulo alcanza para que todo el árbol cargue sin tocar red ni
// pedir env vars (mismo patrón que tests/repos/pedidos.test.js).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  elegirMejorCandidato,
  elegirPorMatchExacto,
  normalizarParaComparar,
  buscarClientePorTexto,
  buscarClienteParaCobroPorTexto,
} = await import('../../lib/asistente-tools/_helpers.js');

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('normalizarParaComparar()', () => {
  it('ignora mayúsculas, tildes y espacios repetidos', () => {
    expect(normalizarParaComparar('  Pérez   Hnos.  ')).toBe('perez hnos.');
    expect(normalizarParaComparar('PEREZ HNOS.')).toBe('perez hnos.');
  });
});

describe('elegirPorMatchExacto()', () => {
  const candidatos = [
    { id: 'p1', nombre: 'Aceite Girasol 1.5L' },
    { id: 'p2', nombre: 'Aceite Girasol 1L' },
  ];

  it('gana el match exacto normalizado aunque haya otro candidato parecido', () => {
    const elegido = elegirPorMatchExacto(candidatos, 'aceite girasol 1l', 'nombre');
    expect(elegido?.id).toBe('p2');
  });

  it('devuelve null si ninguno matchea exacto', () => {
    expect(elegirPorMatchExacto(candidatos, 'aceite de oliva', 'nombre')).toBeNull();
  });

  it('devuelve null si el texto está vacío', () => {
    expect(elegirPorMatchExacto(candidatos, '', 'nombre')).toBeNull();
  });
});

describe('elegirMejorCandidato() — nombres casi idénticos (caso de la captura)', () => {
  it('si hay un solo candidato, lo devuelve sin comparar nada más', () => {
    const unico = [{ id: 'p1', nombre: 'Aceite Girasol 1L', similitud: 0.2 }];
    expect(elegirMejorCandidato(unico, 'aceite')?.id).toBe('p1');
  });

  it('el match EXACTO gana siempre, aunque el margen de similitud entre los dos candidatos sea chico (Fase 0 del plan de desambiguación)', () => {
    // Este es el caso puntual de la captura: dos variantes de litraje muy
    // parecidas entre sí, donde el margen relativo de similarity() nunca
    // llega a 0.15 aunque el usuario haya dicho el nombre exacto.
    const candidatos = [
      { id: 'p1', nombre: 'Aceite Girasol 1.5L', similitud: 0.62 },
      { id: 'p2', nombre: 'Aceite Girasol 1L', similitud: 0.60 }, // margen 0.02, no alcanzaría por similitud sola
    ];
    const elegido = elegirMejorCandidato(candidatos, 'Aceite Girasol 1L', 'nombre');
    expect(elegido?.id).toBe('p2');
  });

  it('sin match exacto, con margen de similitud claro (>=0.15) elige el mejor sin preguntar', () => {
    const candidatos = [
      { id: 'p1', nombre: 'Yerba Mate Suave', similitud: 0.55 },
      { id: 'p2', nombre: 'Yerba Mate Fuerte', similitud: 0.30 },
    ];
    const elegido = elegirMejorCandidato(candidatos, 'yerba suave', 'nombre');
    expect(elegido?.id).toBe('p1');
  });

  it('sin match exacto y sin margen suficiente, devuelve null (hay que preguntar)', () => {
    const candidatos = [
      { id: 'p1', nombre: 'Coca Cola 1.5L', similitud: 0.40 },
      { id: 'p2', nombre: 'Coca Cola 2.25L', similitud: 0.38 }, // margen 0.02
    ];
    expect(elegirMejorCandidato(candidatos, 'coca cola', 'nombre')).toBeNull();
  });

  it('devuelve null si ni siquiera el mejor supera el piso mínimo de similitud (0.35)', () => {
    const candidatos = [
      { id: 'p1', nombre: 'Detergente Limón', similitud: 0.20 },
      { id: 'p2', nombre: 'Detergente Lavanda', similitud: 0.05 },
    ];
    expect(elegirMejorCandidato(candidatos, 'jabon', 'nombre')).toBeNull();
  });
});

describe('buscarClientePorTexto() — usado por crear_pedido', () => {
  it('tira faltaDato-style (mensaje concreto) si no hay texto', async () => {
    await expect(buscarClientePorTexto({ empresaId: 'e1', texto: '  ' }))
      .rejects.toThrow('Falta indicar a qué cliente es el pedido.');
  });

  it('sin candidatos, pide nombre/CUIT/teléfono en vez de fallar en silencio', async () => {
    dbMock.rpc.mockResolvedValue({ data: [], error: null });
    await expect(buscarClientePorTexto({ empresaId: 'e1', texto: 'Cliente Fantasma' }))
      .rejects.toThrow(/No encontré ningún cliente parecido/);
  });

  it('con varios candidatos ambiguos, tira ambiguo() con `.opciones` colgado (no una lista de un solo string)', async () => {
    // Importante: el texto NO debe matchear EXACTO a ninguno de los dos
    // (si matcheara, elegirPorMatchExacto lo resolvería solo, sin
    // preguntar — ver test de arriba). Acá el usuario dio un apellido
    // parcial que se parece a dos razones sociales distintas.
    dbMock.rpc.mockResolvedValue({
      data: [
        { id: 'c1', razon_social: 'Juan Pérez', similitud: 0.4, activo: true },
        { id: 'c2', razon_social: 'Juan Pérez SRL', similitud: 0.38, activo: true },
      ],
      error: null,
    });

    try {
      await buscarClientePorTexto({ empresaId: 'e1', texto: 'Perez' });
      throw new Error('no debería llegar acá: tenía que tirar ambiguo()');
    } catch (err) {
      expect(err.opciones).toEqual([
        { id: 'c1', label: 'Juan Pérez' },
        { id: 'c2', label: 'Juan Pérez SRL' },
      ]);
      expect(err.message).toContain('También podés darle el CUIT.');
    }
  });

  it('CLIENTE INACTIVO: con un único candidato claro pero inactivo, bloquea con mensaje explícito (no deja pasar el pedido)', async () => {
    dbMock.rpc.mockResolvedValue({
      data: [{ id: 'c1', razon_social: 'Cliente Dado de Baja', similitud: 1, activo: false }],
      error: null,
    });

    await expect(buscarClientePorTexto({ empresaId: 'e1', texto: 'Cliente Dado de Baja' }))
      .rejects.toThrow('El cliente "Cliente Dado de Baja" está inactivo, no se le pueden cargar pedidos.');
  });

  it('candidato claro y activo: lo devuelve directo, sin tirar ningún error', async () => {
    dbMock.rpc.mockResolvedValue({
      data: [{ id: 'c1', razon_social: 'Distribuidora Litoral', similitud: 1, activo: true }],
      error: null,
    });

    const cliente = await buscarClientePorTexto({ empresaId: 'e1', texto: 'Distribuidora Litoral' });
    expect(cliente.id).toBe('c1');
  });
});

describe('buscarClienteParaCobroPorTexto() — a diferencia de crear_pedido, NO bloquea inactivos', () => {
  it('un cliente inactivo es un caso válido para cobrar deuda vieja', async () => {
    dbMock.rpc.mockResolvedValue({
      data: [{ id: 'c1', razon_social: 'Cliente Dado de Baja', similitud: 1, activo: false }],
      error: null,
    });

    const cliente = await buscarClienteParaCobroPorTexto({ empresaId: 'e1', texto: 'Cliente Dado de Baja' });
    expect(cliente.id).toBe('c1');
  });
});
