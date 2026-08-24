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

/**
 * Igual que validarImagenPorContenido, pero acepta además 'application/pdf'
 * cuando ese mime está en `mimeTypesPermitidos` — para endpoints (remitos,
 * comprobantes de proveedor) que reciben foto O PDF escaneado.
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

  const mimeReal = sniffImageMimeType(buffer);
  if (!mimeReal) {
    return { ok: false, error: 'El archivo no coincide con ningún formato permitido (imagen o PDF).' };
  }
  if (!permitidos.has(mimeReal)) {
    return { ok: false, error: 'Tipo de archivo no soportado.' };
  }
  return { ok: true, mimeReal };
}
