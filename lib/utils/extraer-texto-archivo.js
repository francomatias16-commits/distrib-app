// lib/utils/extraer-texto-archivo.js
//
// Frente 5 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: convierte un archivo
// adjunto (PDF con texto, .docx, .xlsx, .csv) a texto plano, para que
// lib/handlers/asistente.js lo trate por el mismo camino que ya existe
// para "el usuario pegó un texto largo" (ver el bloque de armarSystemPrompt
// que instruye a interpretar listas de stock/pedidos dictados/remitos).
//
// A propósito NO manda estos formatos como adjunto binario a un modelo de
// visión: ni Gemini ni Groq saben leer un .docx o un .xlsx directamente, y
// mandar un PDF como imagen desperdicia la estructura de texto/tabla que sí
// se puede extraer server-side. Un PDF sin texto extraíble (escaneado) es
// la única excepción real — ver `pdfEsEscaneado` más abajo; el handler
// decide ahí si cae al camino de imagen/visión en vez de este módulo.
//
// Cada extractor es independiente y solo se importa perezosamente (import()
// dinámico) para no cargar 3 librerías pesadas en cada cold start de la
// función serverless cuando la mayoría de las consultas no traen adjunto.

import { MIME_DOCX, MIME_XLSX } from './image-sniff.js';

/**
 * pdf-parse (pdf.js v1.10 embebido) arma su tabla de xref a partir del
 * `ArrayBuffer` subyacente completo del Buffer recibido, ignorando su
 * `byteOffset`. La mayoría de los Buffers chicos en Node (ej. los que
 * devuelve fs.readFileSync o el pool interno de Buffer.allocUnsafe) son
 * vistas con byteOffset != 0 sobre un ArrayBuffer compartido — en ese caso
 * pdf.js termina leyendo los objetos del PDF desde una posición desplazada
 * y tira "bad XRef entry" en PDFs perfectamente válidos y con texto real.
 * Confirmado reproduciéndolo con PDFs recién generados (no solo con el
 * fixture del repo). `new Uint8Array(buffer)` copia a un ArrayBuffer propio
 * con byteOffset 0, evitando el bug — a diferencia de Buffer.from(buffer),
 * que puede seguir usando el pool interno.
 * @param {Buffer} buffer
 * @returns {Uint8Array}
 */
function bufferSinOffsetDePool(buffer) {
  if (buffer.byteOffset === 0 && buffer.buffer.byteLength === buffer.byteLength) {
    return buffer;
  }
  return new Uint8Array(buffer);
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extraerTextoPdf(buffer) {
  const { default: pdfParse } = await import('pdf-parse');
  const resultado = await pdfParse(bufferSinOffsetDePool(buffer));
  return (resultado.text || '').trim();
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extraerTextoDocx(buffer) {
  const mammoth = await import('mammoth');
  const resultado = await mammoth.extractRawText({ buffer });
  return (resultado.value || '').trim();
}

/**
 * Convierte cada hoja de un .xlsx a una tabla en texto plano separada por
 * tabs (más liviano y más legible para el modelo que CSV con comillas, y
 * suficiente — no hace falta Markdown real acá).
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extraerTextoXlsx(buffer) {
  const XLSX = await import('xlsx');
  const libro = XLSX.read(buffer, { type: 'buffer' });
  const partes = [];
  for (const nombreHoja of libro.SheetNames) {
    const hoja = libro.Sheets[nombreHoja];
    const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, blankrows: false, defval: '' });
    if (!filas.length) continue;
    const texto = filas.map((fila) => fila.join('\t')).join('\n');
    partes.push(`### Hoja: ${nombreHoja}\n${texto}`);
  }
  return partes.join('\n\n').trim();
}

function extraerTextoCsv(buffer) {
  return buffer.toString('utf-8').trim();
}

// Un PDF sin texto extraíble es casi siempre un escaneo (foto/imagen
// metida dentro del PDF, sin capa de texto). Umbral bajo a propósito: un
// PDF real con una sola línea de encabezado ya supera esto; uno vacío o
// puramente gráfico no.
const UMBRAL_PDF_ESCANEADO = 20;

function pdfEsEscaneado(textoExtraido) {
  return (textoExtraido || '').trim().length < UMBRAL_PDF_ESCANEADO;
}

/**
 * Extrae texto plano de un archivo adjunto según su mime real (ya validado
 * por contenido — ver lib/utils/image-sniff.js). Devuelve `null` cuando el
 * mime no es ninguno de los soportados por este módulo (imágenes no pasan
 * por acá, van directo al camino de visión existente).
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<{ texto: string, esPdfEscaneado?: boolean } | null>}
 */
async function extraerTextoDeArchivo(buffer, mimeType) {
  switch (mimeType) {
    case 'application/pdf': {
      // pdf-parse (pdf.js viejo, v1.10) no siempre degrada con gracia: un
      // PDF perfectamente válido pero con una estructura que su parser no
      // maneja (xref streams comprimidos, típico de escaneos reales hechos
      // con apps de celular o scanners modernos) puede tirar una excepción
      // en vez de devolver texto vacío. Confirmado en pruebas: un PDF en
      // blanco generado con pdfkit ya dispara "bad XRef entry". Tratar
      // cualquier falla de pdf-parse como "posible escaneado" (en vez de
      // dejar que el error se propague y el handler rechace el archivo) es
      // el degrade correcto — el fallback a Gemini como `application/pdf`
      // (ver handler) igual puede leerlo aunque pdf-parse no haya podido.
      let texto = '';
      try {
        texto = await extraerTextoPdf(buffer);
      } catch (error) {
        console.error('[extraer-texto-archivo] pdf-parse no pudo leer el PDF, se trata como escaneado:', error?.message ?? error);
        return { texto: '', esPdfEscaneado: true };
      }
      if (pdfEsEscaneado(texto)) {
        return { texto: '', esPdfEscaneado: true };
      }
      return { texto };
    }
    case MIME_DOCX:
      return { texto: await extraerTextoDocx(buffer) };
    case MIME_XLSX:
      return { texto: await extraerTextoXlsx(buffer) };
    case 'text/csv':
      return { texto: extraerTextoCsv(buffer) };
    default:
      return null;
  }
}

export { extraerTextoDeArchivo, MIME_DOCX, MIME_XLSX };
