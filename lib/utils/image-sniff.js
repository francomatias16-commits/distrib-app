// lib/utils/image-sniff.js
// SEC-13 / BUG-04 (Auditoría Integral 2026): varios endpoints validaban una
// imagen adjunta solo por el MIME/prefijo declarado por el cliente
// ('image/jpeg', 'data:image/png;base64,...') sin mirar el contenido real
// del archivo. Un string cualquiera con el prefijo correcto pasaba la
// validación igual. Este helper hace sniffing real por magic bytes para los
// 3 formatos que el proyecto acepta (jpeg/png/webp) — es intencionalmente
// chico y sin dependencias nuevas, no un parser de formatos genérico.

/**
 * Devuelve el mime real detectado por los primeros bytes del buffer, o null
 * si no matchea ninguna de las firmas conocidas (jpeg/png/webp).
 * @param {Buffer} buffer
 * @returns {'image/jpeg'|'image/png'|'image/webp'|null}
 */
export function sniffImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG_SIG.every((b, i) => buffer[i] === b)) {
    return 'image/png';
  }

  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Valida que `buffer` sea realmente uno de `mimeTypesPermitidos` según sus
 * magic bytes, no según el MIME que declaró el cliente. Devuelve
 * { ok: true } o { ok: false, error } listo para responder 400.
 * @param {Buffer} buffer
 * @param {Set<string>|string[]} mimeTypesPermitidos
 */
export function validarImagenPorContenido(buffer, mimeTypesPermitidos) {
  const permitidos = mimeTypesPermitidos instanceof Set
    ? mimeTypesPermitidos
    : new Set(mimeTypesPermitidos);

  const mimeReal = sniffImageMimeType(buffer);
  if (!mimeReal) {
    return { ok: false, error: 'El archivo no es una imagen válida (JPG/PNG/WEBP).' };
  }
  if (!permitidos.has(mimeReal)) {
    return { ok: false, error: 'Tipo de imagen no soportado. Usá JPG, PNG o WEBP.' };
  }
  return { ok: true, mimeReal };
}

// PDF: '%PDF-'
function esPdfValido(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  return buffer.slice(0, 5).toString('ascii') === '%PDF-';
}

// Frente 5 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: el asistente ahora
// también acepta Word/Excel. Ambos formatos (.docx/.xlsx) son en
// realidad un ZIP (firma 'PK\x03\x04') con XML adentro — no alcanza con
// la firma del ZIP para distinguirlos entre sí ni de un .zip cualquiera
// (o de un .pptx, que también es ZIP pero no está soportado). En vez de
// sumar una librería de ZIP solo para esto, se aprovecha que el nombre
// de cada entrada dentro de un ZIP viaja SIN comprimir en su header
// local — aparece como texto plano en el buffer crudo aunque el
// contenido de esa entrada esté deflate-comprimido. Buscar el path
// canónico que cada formato OOXML siempre incluye
// (word/document.xml para Word, xl/workbook.xml para Excel) alcanza
// para distinguirlos sin parsear el ZIP entero.
export const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];
const ENTRADA_WORD = Buffer.from('word/document.xml');
const ENTRADA_EXCEL = Buffer.from('xl/workbook.xml');

function esZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && ZIP_SIG.every((b, i) => buffer[i] === b);
}

/**
 * @param {Buffer} buffer
 * @returns {typeof MIME_DOCX | typeof MIME_XLSX | null}
 */
function sniffOoxmlMimeType(buffer) {
  if (!esZip(buffer)) return null;
  if (buffer.includes(ENTRADA_WORD)) return MIME_DOCX;
  if (buffer.includes(ENTRADA_EXCEL)) return MIME_XLSX;
  return null;
}

// CSV no tiene magic bytes propios. Se acepta como texto plano siempre
// que decodifique como UTF-8/ASCII razonable (sin bytes nulos ni el
// arranque de otro formato binario conocido) — es una validación laxa a
// propósito, el contenido real lo termina de interpretar
// extraerTextoDeArchivo() y, si no tiene sentido como texto, el propio
// modelo lo va a notar.
function esTextoPlausible(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const muestra = buffer.slice(0, 2000);
  for (let i = 0; i < muestra.length; i++) {
    // bytes de control (fuera de tab/salto de línea/retorno de carro)
    // indican binario, no CSV.
    const b = muestra[i];
    if (b === 0) return false;
    if (b < 9 && b !== 0) return false;
    if (b > 13 && b < 32) return false;
  }
  return true;
}

/**
 * Igual que validarImagenPorContenido, pero acepta además PDF, Word
 * (.docx), Excel (.xlsx) y CSV cuando esos mimes están en
 * `mimeTypesPermitidos` — para endpoints (remitos, comprobantes de
 * proveedor, asistente) que reciben foto o documento.
 * @param {Buffer} buffer
 * @param {Set<string>|string[]} mimeTypesPermitidos
 */
export function validarArchivoPorContenido(buffer, mimeTypesPermitidos) {
  const permitidos = mimeTypesPermitidos instanceof Set
    ? mimeTypesPermitidos
    : new Set(mimeTypesPermitidos);

  if (permitidos.has('application/pdf') && esPdfValido(buffer)) {
    return { ok: true, mimeReal: 'application/pdf' };
  }

  if (permitidos.has(MIME_DOCX) || permitidos.has(MIME_XLSX)) {
    const mimeOoxml = sniffOoxmlMimeType(buffer);
    if (mimeOoxml && permitidos.has(mimeOoxml)) {
      return { ok: true, mimeReal: mimeOoxml };
    }
  }

  const mimeImagen = sniffImageMimeType(buffer);
  if (mimeImagen) {
    if (!permitidos.has(mimeImagen)) {
      return { ok: false, error: 'Tipo de imagen no soportado. Usá JPG, PNG o WEBP.' };
    }
    return { ok: true, mimeReal: mimeImagen };
  }

  // CSV se chequea al final: sin magic bytes, cualquier archivo binario
  // no reconocido arriba podría "pasar" como texto si se chequeara antes.
  if (permitidos.has('text/csv') && esTextoPlausible(buffer)) {
    return { ok: true, mimeReal: 'text/csv' };
  }

  return {
    ok: false,
    error: 'No pude reconocer el archivo como imagen (JPG/PNG/WEBP), PDF, Word (.docx), Excel (.xlsx) o CSV. Probá exportarlo a uno de esos formatos, o copiá el texto y pegalo directamente.',
  };
}
