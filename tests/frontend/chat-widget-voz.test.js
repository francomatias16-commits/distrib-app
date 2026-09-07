// tests/frontend/chat-widget-voz.test.js
//
// Fase 4 (voz) del plan de asistente por voz: normalizarNumerosParaVoz()
// se agregó porque hablar() le pasaba el texto de la respuesta directo a
// SpeechSynthesisUtterance, y los montos vienen formateados en formato
// argentino (punto = miles, coma = decimal) — la mayoría de los motores
// de TTS del navegador leen el punto como separador DECIMAL sin importar
// el lang="es-AR", así que "$45.000" se leía "cuarenta y cinco punto
// cero cero cero" en vez de "cuarenta y cinco mil".

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { cargarScripts } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_WIDGET = path.resolve(__dirname, '../../frontend/shared/chat-widget.js');

// El resto del archivo (el IIFE de montaje) espera window.supabase, una
// sesión, etc. — acá solo nos interesa normalizarNumerosParaVoz(), que
// queda como top-level function del script (fuera del IIFE) y por lo
// tanto disponible en el sandbox sin tener que simular todo lo demás.
// El IIFE corre igual al cargar el archivo, pero window.supabase queda
// undefined y el bloque de montaje async falla en silencio (mismo
// comportamiento que en una página sin sesión, ver comentario del header
// del archivo) sin afectar la función que estamos probando.
function cargar() {
  const { sandbox } = cargarScripts([CHAT_WIDGET], {
    extra: {
      // supabaseClient ausente + auth ausente = el auto-montaje del IIFE
      // no sigue de largo; alcanza con no reventar la carga del script.
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    },
  });
  return sandbox;
}

describe('normalizarNumerosParaVoz — Fase 4 (voz)', () => {
  it('convierte un monto sin decimales, con separador de miles', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('Registrar un cobro de $45.000 en efectivo a Juan Pérez.'))
      .toBe('Registrar un cobro de 45000 pesos en efectivo a Juan Pérez.');
  });

  it('convierte un monto con decimales (coma) a "con N centavos"', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('Queda a favor $1.250,75.'))
      .toBe('Queda a favor 1250 pesos con 75 centavos.');
  });

  it('convierte varios montos en el mismo texto', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('Debía $12.500, queda debiendo $2.500.'))
      .toBe('Debía 12500 pesos, queda debiendo 2500 pesos.');
  });

  it('no agrega separador de miles falso a montos chicos', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('Precio $450.')).toBe('Precio 450 pesos.');
  });

  it('saca el "×" del detalle de items sin tocar las cantidades', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('3 × Coca Cola 500ml, 2 × Sprite.'))
      .toBe('3 Coca Cola 500ml, 2 Sprite.');
  });

  it('no toca cantidades chicas sin separador de miles (ej. "3 x Coca Cola")', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('3 x Coca Cola, total $4.500.'))
      .toBe('3 x Coca Cola, total 4500 pesos.');
  });

  it('convierte porcentajes', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('nivel 1: 10% de descuento'))
      .toBe('nivel 1: 10 por ciento de descuento');
  });

  it('combina monto + detalle de items + total en un texto real de resumen', () => {
    const { normalizarNumerosParaVoz } = cargar();
    const original = 'Crear un pedido para Juan Pérez: 3 × Coca Cola 500ml, 2 × Sprite. Total $4.500.';
    expect(normalizarNumerosParaVoz(original))
      .toBe('Crear un pedido para Juan Pérez: 3 Coca Cola 500ml, 2 Sprite. Total 4500 pesos.');
  });

  it('deja intacto un texto sin números ni símbolos', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('Actualmente no tiene deuda registrada.'))
      .toBe('Actualmente no tiene deuda registrada.');
  });

  it('devuelve el texto tal cual si es null/vacío (no revienta)', () => {
    const { normalizarNumerosParaVoz } = cargar();
    expect(normalizarNumerosParaVoz('')).toBe('');
    expect(normalizarNumerosParaVoz(null)).toBe(null);
  });
});
