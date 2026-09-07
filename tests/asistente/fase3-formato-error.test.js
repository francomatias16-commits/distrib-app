// tests/asistente/fase3-formato-error.test.js
//
// Fase 3 del plan de robustez conversacional (formato único de error para
// las tools del asistente — ver lib/asistente-tools/_respuestas.js). Ese
// módulo centraliza las 3 formas reales que toma un error de tool:
//   1. faltaDato(campo, ejemplo) — el usuario nunca dio ese dato.
//   2. ambiguo({...})            — varios candidatos, ninguno se destaca;
//                                   cuelga `.opciones` para los botones
//                                   tappable del frontend.
//   3. bloqueado(motivo, salida) — acción válida pero no ejecutable ahora.
//
// Hasta acá el módulo no tenía test propio: se lo ejercitaba solo de forma
// indirecta a través de buscarClientePorTexto() y afines en
// desambiguacion.test.js (que cubren la lógica de matching, no el formato
// de los 3 tipos de error en sí). Este archivo prueba _respuestas.js de
// forma aislada — es una función pura, sin dependencias que mockear.

import { describe, it, expect } from 'vitest';
import { faltaDato, ambiguo, bloqueado } from '../../lib/asistente-tools/_respuestas.js';

describe('faltaDato() — Tipo 1: el usuario nunca dio el dato', () => {
  it('sin ejemplo: mensaje base nombrando el campo', () => {
    const err = faltaDato('el nombre del cliente');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Me falta el nombre del cliente para seguir.');
  });

  it('con ejemplo: agrega la línea "Por ejemplo: ..." al final', () => {
    const err = faltaDato('el monto', '1500');
    expect(err.message).toBe('Me falta el monto para seguir. Por ejemplo: "1500".');
  });

  it('no cuelga `.opciones` (eso es exclusivo de ambiguo())', () => {
    const err = faltaDato('el CUIT');
    expect(err.opciones).toBeUndefined();
  });
});

describe('ambiguo() — Tipo 2: varios candidatos, ninguno claro', () => {
  const candidatos = [
    { id: 'c1', nombre: 'Juan Pérez' },
    { id: 'c2', nombre: 'Juan Pérez Hijo' },
    { id: 'c3', nombre: 'Juan P. Gómez' },
  ];

  it('arma el mensaje citando tipo y texto buscado, con la lista numerada', () => {
    const err = ambiguo({ tipo: 'cliente', texto: 'juan perez', candidatos, campoNombre: 'nombre' });
    expect(err.message).toContain('Hay más de un cliente parecido a "juan perez":');
    expect(err.message).toContain('1) Juan Pérez');
    expect(err.message).toContain('2) Juan Pérez Hijo');
    expect(err.message).toContain('3) Juan P. Gómez');
  });

  it('siempre agrega la instrucción de no reformular la lista', () => {
    const err = ambiguo({ tipo: 'producto', texto: 'fideos', candidatos, campoNombre: 'nombre' });
    expect(err.message).toContain('Mostrale esta lista tal cual, no la reformules.');
  });

  it('sin sugerenciaExtra: no agrega nada después de la instrucción de no reformular', () => {
    const err = ambiguo({ tipo: 'producto', texto: 'fideos', candidatos, campoNombre: 'nombre' });
    const lineas = err.message.split('\n');
    expect(lineas[lineas.length - 1]).toBe('Mostrale esta lista tal cual, no la reformules.');
  });

  it('con sugerenciaExtra: la agrega después de la instrucción, en la misma línea de cierre', () => {
    const err = ambiguo({
      tipo: 'cliente', texto: 'juan', candidatos, campoNombre: 'nombre',
      sugerenciaExtra: 'También podés darle el CUIT.',
    });
    expect(err.message).toContain('Mostrale esta lista tal cual, no la reformules. También podés darle el CUIT.');
  });

  it('cuelga `.opciones` con {id, label} tomado de campoNombre — no de otro campo', () => {
    const err = ambiguo({ tipo: 'cliente', texto: 'juan', candidatos, campoNombre: 'nombre' });
    expect(err.opciones).toEqual([
      { id: 'c1', label: 'Juan Pérez' },
      { id: 'c2', label: 'Juan Pérez Hijo' },
      { id: 'c3', label: 'Juan P. Gómez' },
    ]);
  });

  it('respeta campoNombre distinto de "nombre" (ej. razon_social, nombre_mostrado)', () => {
    const err = ambiguo({
      tipo: 'proveedor',
      texto: 'la serenisima',
      candidatos: [{ id: 'p1', razon_social: 'La Serenísima S.A.' }],
      campoNombre: 'razon_social',
    });
    expect(err.opciones).toEqual([{ id: 'p1', label: 'La Serenísima S.A.' }]);
    expect(err.message).toContain('1) La Serenísima S.A.');
  });

  it('recorta a un máximo de 5 opciones, aunque vengan más candidatos', () => {
    const muchos = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, nombre: `Candidato ${i}` }));
    const err = ambiguo({ tipo: 'cliente', texto: 'candidato', candidatos: muchos, campoNombre: 'nombre' });
    expect(err.opciones).toHaveLength(5);
    expect(err.message).not.toContain('6) Candidato 5');
  });

  it('default de campoNombre es "nombre" si no se especifica', () => {
    const err = ambiguo({ tipo: 'depósito', texto: 'central', candidatos: [{ id: 'd1', nombre: 'Depósito Central' }] });
    expect(err.opciones).toEqual([{ id: 'd1', label: 'Depósito Central' }]);
  });

  it('sin candidatos (array vacío o undefined): no revienta, devuelve `.opciones` vacío', () => {
    const err1 = ambiguo({ tipo: 'cliente', texto: 'nadie', candidatos: [] });
    expect(err1.opciones).toEqual([]);
    const err2 = ambiguo({ tipo: 'cliente', texto: 'nadie', candidatos: undefined });
    expect(err2.opciones).toEqual([]);
  });
});

describe('bloqueado() — Tipo 3: acción válida, no ejecutable ahora', () => {
  it('sin salida: devuelve solo el motivo', () => {
    const err = bloqueado('El cliente tiene crédito excedido.');
    expect(err.message).toBe('El cliente tiene crédito excedido.');
  });

  it('con salida: agrega la salida después del motivo, separados por un espacio', () => {
    const err = bloqueado('Stock insuficiente para "Fideos".', 'Quedan 3 unidades disponibles.');
    expect(err.message).toBe('Stock insuficiente para "Fideos". Quedan 3 unidades disponibles.');
  });

  it('no cuelga `.opciones` (no es un caso de ambigüedad)', () => {
    const err = bloqueado('La factura ya está anulada.');
    expect(err.opciones).toBeUndefined();
  });
});
