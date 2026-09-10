// tests/handlers/whatsapp-system-prompt.test.js
//
// Regresión de texto para armarSystemPromptWhatsApp() (lib/handlers/notif.js),
// motivada por dos hallazgos reales de scripts/eval-asistente-whatsapp.js
// corridos contra Gemini (2026-09-08, ver PLAN_QA_ASISTENTE_WHATSAPP.md
// sección 8):
//
//   1. agregar-item-simple-01: el bot respondía "Listo, anotado. ¿Algo
//      más?" tras agregar_item, sin nombrar el producto ni la cantidad —
//      si el modelo entendió mal a qué producto se refería el cliente
//      (ej. tras varios turnos), no había forma de notarlo antes de
//      confirmar el pedido.
//   2. buscar-productos-directo-01: ante productos sin stock, el bot
//      listaba las 6 variantes con precio de una, sin que el cliente lo
//      pidiera.
//
// armarSystemPromptWhatsApp() es una función pura (sin dependencias que
// mockear, mismo criterio que armarSystemPrompt() en
// tests/asistente/fase1-prompt-correccion.test.js) — se importa tal cual.
// Este test no reemplaza al eval real contra un proveedor (que sí evalúa
// el TEXTO que efectivamente contesta el modelo): solo confirma que la
// instrucción sigue estando en el prompt que se le manda, para no
// perderla en un refactor futuro del wording.

import { describe, it, expect } from 'vitest';
import { armarSystemPromptWhatsApp } from '../../lib/handlers/notif.js';

describe('armarSystemPromptWhatsApp — instrucciones agregadas tras hallazgos del eval (2026-09-08)', () => {
  it('systemPromptConTools exige confirmar producto + cantidad después de agregar_item/modificar_cantidad', () => {
    const { systemPromptConTools } = armarSystemPromptWhatsApp();

    expect(systemPromptConTools).toContain(
      'Después de llamar a agregar_item (o modificar_cantidad), tu respuesta en texto SIEMPRE tiene que ' +
      'nombrar el producto y la cantidad que quedó'
    );
    expect(systemPromptConTools).toContain('nunca confirmes solo con un "listo"/"anotado" genérico');
  });

  it('systemPromptConTools exige avisar falta de stock antes de listar precios de variantes sin stock', () => {
    const { systemPromptConTools } = armarSystemPromptWhatsApp();

    expect(systemPromptConTools).toContain(
      'Si buscar_productos devuelve resultados pero NINGUNO tiene stock, no listes todas las variantes ' +
      'con precio de una'
    );
    expect(systemPromptConTools).toContain(
      'avisale primero al cliente que no hay stock de eso y preguntale si igual ' +
      'quiere que le pases precios o alternativas'
    );
  });

  it('systemPromptSinTools (Groq/OpenRouter sin function calling) no promete tools que no puede ejecutar', () => {
    // Red de seguridad ya existente: confirma que el fix de esta sesión no
    // se filtró por error a la variante sin tools, que sigue siendo el
    // mensaje corto de "no puedo procesar el pedido automáticamente".
    const { systemPromptSinTools } = armarSystemPromptWhatsApp();

    expect(systemPromptSinTools).not.toContain('agregar_item');
    expect(systemPromptSinTools).not.toContain('buscar_productos');
  });
});
