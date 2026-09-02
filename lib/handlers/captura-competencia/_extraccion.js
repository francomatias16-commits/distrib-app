// lib/handlers/captura-competencia/_extraccion.js
// Fase 1 (PLAN_CAPTURA_COMPETENCIA.md, sección 1.4): en vez de sumar un
// servicio de OCR nuevo, reutiliza el pipeline de visión que ya está en
// producción (responderConFallback, Gemini → Groq → OpenRouter — ver
// lib/asistente-providers.js), con un system prompt propio que pide un
// JSON estructurado de renglones. Cero integración nueva, cero costo
// adicional de infraestructura.
//
// Por qué modelo de visión y no OCR clásico (plan 1.4): el problema real
// acá no es "leer texto" sino "interpretar un formato de remito arbitrario
// y no estandarizado" — cada competidor tiene el suyo. Un modelo con
// razonamiento generaliza mejor a formatos nunca vistos que un OCR rígido.

import { responderConFallback } from '../../asistente-providers.js';

const SYSTEM_PROMPT = `Sos un asistente que lee fotos de facturas o remitos de venta (en Argentina, de un proveedor distribuidor a un comercio minorista) y devuelve SOLO un JSON con los renglones de productos, sin ningún texto antes o después.

Formato de salida (JSON estricto, sin comentarios, sin markdown, sin \`\`\`):
{
  "proveedor_nombre": string o null (nombre del proveedor/distribuidor emisor de la factura, si se puede leer),
  "items": [
    {
      "texto_original": string (la descripción del producto tal cual aparece en el renglón, sin modificar),
      "cantidad": number (cantidad del renglón; si no se puede leer, usar 1),
      "precio_unitario": number (precio unitario en pesos argentinos, sin símbolo de moneda ni separadores de miles; si el renglón solo trae el total de la línea y no el unitario, calculalo dividiendo por la cantidad)
    }
  ]
}

Reglas importantes:
- Incluí SOLO renglones que sean productos (mercadería). NO incluyas fletes, descuentos, impuestos, subtotales, totales, ni líneas de encabezado/pie.
- Si un renglón no se entiende con confianza razonable, igual incluilo con el texto tal cual se lee — la revisión humana posterior se encarga de corregir o descartar.
- Si la imagen no es una factura o remito legible, devolvé {"proveedor_nombre": null, "items": []}.
- No inventes productos que no estén en la imagen.`;

const MAX_TOKENS_EXTRACCION = 2048;

/**
 * @param {{ data: string, mimeType: string }} imagen - base64 sin prefijo
 *   data:...;base64, + mime real (ya sniffeado por magic bytes en el
 *   handler, no el declarado por el cliente).
 * @returns {Promise<{ proveedor_nombre: string|null, items: Array<{ texto_original: string, cantidad: number, precio_unitario: number }> }>}
 */
export async function extraerRenglonesDeFactura(imagen) {
  const { texto } = await responderConFallback({
    systemPromptConTools: SYSTEM_PROMPT,
    systemPromptSinTools: SYSTEM_PROMPT,
    historial: [],
    mensaje: 'Extraé los renglones de esta factura/remito según el formato indicado.',
    imagen,
    maxTokens: MAX_TOKENS_EXTRACCION,
  });

  const parsed = parsearJsonDeRespuesta(texto);
  return normalizarExtraccion(parsed);
}

/**
 * El modelo a veces envuelve el JSON en \`\`\`json ... \`\`\` pese a la
 * instrucción de no hacerlo, o agrega una frase antes/después. Se busca el
 * primer bloque { ... } balanceado en vez de confiar en que la respuesta
 * sea JSON puro de punta a punta.
 */
function parsearJsonDeRespuesta(texto) {
  const limpio = (texto || '').trim();
  try {
    return JSON.parse(limpio);
  } catch {
    // sigue abajo
  }

  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio === -1 || fin === -1 || fin <= inicio) {
    throw new Error('No se pudo leer la factura. Probá con una foto más nítida o mejor iluminada.');
  }
  try {
    return JSON.parse(limpio.slice(inicio, fin + 1));
  } catch {
    throw new Error('No se pudo leer la factura. Probá con una foto más nítida o mejor iluminada.');
  }
}

function normalizarExtraccion(parsed) {
  const itemsCrudos = Array.isArray(parsed?.items) ? parsed.items : [];

  const items = itemsCrudos
    .map((it) => ({
      texto_original: String(it?.texto_original ?? '').trim(),
      cantidad: Number(it?.cantidad) || 1,
      precio_unitario: Number(it?.precio_unitario) || 0,
    }))
    .filter((it) => it.texto_original.length > 0);

  return {
    proveedor_nombre: parsed?.proveedor_nombre ? String(parsed.proveedor_nombre).trim() : null,
    items,
  };
}
