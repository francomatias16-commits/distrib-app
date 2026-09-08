// tests/asistente/extraer-texto-archivo.test.js
//
// Frente 5 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: cubre
// lib/utils/extraer-texto-archivo.js y la parte de
// lib/utils/image-sniff.js que reconoce PDF/docx/xlsx/CSV por contenido
// real (no por el mime que declare el cliente).
//
// Fixtures reales (no simulados): tests/asistente/fixtures/prueba.docx
// (generado con la librería `docx`) y prueba-con-texto.pdf (generado con
// `pdfkit`) — ninguna de las dos es dependencia del proyecto, solo se
// usaron una vez para producir estos dos archivos chicos versionados. El
// .xlsx y el .csv se arman en memoria acá mismo con `xlsx` (esa sí es
// dependencia real, la misma que usa extraerTextoDeArchivo).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { validarArchivoPorContenido, MIME_DOCX, MIME_XLSX } from '../../lib/utils/image-sniff.js';
import { extraerTextoDeArchivo } from '../../lib/utils/extraer-texto-archivo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

const PERMITIDOS = new Set([
  'application/pdf',
  MIME_DOCX,
  MIME_XLSX,
  'text/csv',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function xlsxDePrueba() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Producto', 'Cantidad', 'Precio'],
    ['Aceite girasol 5L', 10, 4500],
    ['Fideos 500g', 24, 900],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Pedido');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('validarArchivoPorContenido — Frente 5 (docx/xlsx/csv/pdf)', () => {
  it('reconoce un .docx real como Word por contenido, no por extensión', () => {
    const buffer = fs.readFileSync(path.join(FIXTURES, 'prueba.docx'));
    const resultado = validarArchivoPorContenido(buffer, PERMITIDOS);
    expect(resultado.ok).toBe(true);
    expect(resultado.mimeReal).toBe(MIME_DOCX);
  });

  it('reconoce un .xlsx real como Excel por contenido', () => {
    const buffer = xlsxDePrueba();
    const resultado = validarArchivoPorContenido(buffer, PERMITIDOS);
    expect(resultado.ok).toBe(true);
    expect(resultado.mimeReal).toBe(MIME_XLSX);
  });

  it('reconoce un PDF con texto real', () => {
    const buffer = fs.readFileSync(path.join(FIXTURES, 'prueba-con-texto.pdf'));
    const resultado = validarArchivoPorContenido(buffer, PERMITIDOS);
    expect(resultado.ok).toBe(true);
    expect(resultado.mimeReal).toBe('application/pdf');
  });

  it('acepta un CSV como texto plano', () => {
    const buffer = Buffer.from('producto,cantidad\nAceite,10\nFideos,24\n', 'utf-8');
    const resultado = validarArchivoPorContenido(buffer, PERMITIDOS);
    expect(resultado.ok).toBe(true);
    expect(resultado.mimeReal).toBe('text/csv');
  });

  it('rechaza un .zip genérico que no es ni docx ni xlsx (ej. un .pptx)', () => {
    // Mismo signature de ZIP (PK\x03\x04) que docx/xlsx, pero sin ninguno
    // de los paths canónicos de Office (word/document.xml, xl/workbook.xml)
    // — no debería colarse como si fuera un formato soportado.
    const buffer = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('ppt/presentation.xml contenido cualquiera'),
    ]);
    const resultado = validarArchivoPorContenido(buffer, PERMITIDOS);
    expect(resultado.ok).toBe(false);
  });

  it('rechaza binario que no matchea ningún formato soportado', () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const resultado = validarArchivoPorContenido(buffer, PERMITIDOS);
    expect(resultado.ok).toBe(false);
  });
});

describe('extraerTextoDeArchivo — Frente 5', () => {
  it('extrae texto de un .docx real', async () => {
    const buffer = fs.readFileSync(path.join(FIXTURES, 'prueba.docx'));
    const resultado = await extraerTextoDeArchivo(buffer, MIME_DOCX);
    expect(resultado.texto).toContain('Distribuidora El Sol');
    expect(resultado.texto).toContain('Aceite de girasol');
  });

  it('extrae cada hoja de un .xlsx real como tabla separada por tabs', async () => {
    const buffer = xlsxDePrueba();
    const resultado = await extraerTextoDeArchivo(buffer, MIME_XLSX);
    expect(resultado.texto).toContain('### Hoja: Pedido');
    expect(resultado.texto).toContain('Aceite girasol 5L\t10\t4500');
  });

  it('extrae un CSV tal cual, sin transformarlo', async () => {
    const buffer = Buffer.from('producto,cantidad\nAceite,10\n', 'utf-8');
    const resultado = await extraerTextoDeArchivo(buffer, 'text/csv');
    expect(resultado.texto).toBe('producto,cantidad\nAceite,10');
  });

  it('extrae texto de un PDF real y NO lo marca como escaneado', async () => {
    const buffer = fs.readFileSync(path.join(FIXTURES, 'prueba-con-texto.pdf'));
    const resultado = await extraerTextoDeArchivo(buffer, 'application/pdf');
    expect(resultado.esPdfEscaneado).toBeFalsy();
    expect(resultado.texto).toContain('Distribuidora El Sol');
  });

  it('marca como escaneado un PDF real sin capa de texto, aunque pdf-parse falle al parsearlo', async () => {
    // FIX descubierto al escribir este test: pdf-parse (pdf.js v1.10
    // embebido) no siempre degrada con gracia — un PDF real generado con
    // pdfkit, sin texto pero estructuralmente válido, le dispara
    // "bad XRef entry" en vez de devolver texto vacío. extraerTextoDeArchivo
    // atrapa esa falla y la trata como "posible escaneado" (ver comentario
    // en el propio archivo) para no rechazar el adjunto — el handler cae
    // al camino de visión (Gemini como application/pdf) en ese caso.
    const buffer = fs.readFileSync(path.join(FIXTURES, 'prueba-sin-texto.pdf'));
    const resultado = await extraerTextoDeArchivo(buffer, 'application/pdf');
    expect(resultado.esPdfEscaneado).toBe(true);
    expect(resultado.texto).toBe('');
  });

  it('marca como escaneado un PDF mínimo sin ningún contenido parseable', async () => {
    const buffer = Buffer.from('%PDF-1.4\n%%EOF');
    const resultado = await extraerTextoDeArchivo(buffer, 'application/pdf');
    expect(resultado.esPdfEscaneado).toBe(true);
    expect(resultado.texto).toBe('');
  });

  it('devuelve null para un mime no soportado por este módulo (ej. una imagen)', async () => {
    const resultado = await extraerTextoDeArchivo(Buffer.from('cualquier cosa'), 'image/jpeg');
    expect(resultado).toBeNull();
  });

  it('propaga el error si el buffer no es un docx válido (el handler lo atrapa)', async () => {
    await expect(extraerTextoDeArchivo(Buffer.from('no soy un docx'), MIME_DOCX)).rejects.toThrow();
  });
});
