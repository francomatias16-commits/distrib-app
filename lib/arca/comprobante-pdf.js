// lib/arca/comprobante-pdf.js
//
// Genera el PDF del comprobante electrónico (Factura C o Nota de Crédito C)
// con pdfkit y lo sube a Supabase Storage (bucket "comprobantes").
// Actualiza el campo `pdf_url` en la tabla `facturas` al terminar.
//
// Datos requeridos para el PDF (todos vienen de la BD — no hay lógica de negocio acá):
//   - factura: { id, tipo, numero, cae, cae_vto, total, neto, iva, fecha_emision, notas_error }
//   - empresa: { nombre, cuit, domicilio, condicion_iva, razon_social }
//   - cliente: { razon_social, nombre_fantasia, cuit, condicion_iva, domicilio }
//   - items:   [{ descripcion, cantidad, precio_unitario, subtotal }]
//
// El PDF sigue el layout mínimo exigido por ARCA:
//   - Encabezado: datos del emisor (izquierda), letra del comprobante (centro), datos del receptor (derecha)
//   - Cuerpo: tabla de items con descripción, cantidad, precio unitario y subtotal
//   - Pie: subtotal, IVA (si aplica), total, CAE y vencimiento CAE con código de barras INTERLEAVED 2of5
//
// Dependencias:
//   npm install pdfkit bwip-js
//   (bwip-js genera el código de barras ARCA sin depender de binarios externos)
//
// Uso:
//   import { generarPDFComprobante } from './comprobante-pdf.js';
//   const { ok, url, error } = await generarPDFComprobante(facturaId);
//
// Se puede llamar:
//   - Justo después de emitirComprobanteARCA() para adjuntar el PDF en el mismo request.
//   - Desde un endpoint dedicado /api/facturas/pdf?id=xxx para regeneración on-demand.
//   - Desde un job background si no querés añadir latencia al flujo de emisión.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { calcularDesgloseIva } from '../calc/iva-desglose.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

// Bucket de Supabase Storage donde se guardan los PDFs.
// Debe existir y tener RLS configurada (recomendado: público para lectura, service_role para escritura).
const BUCKET = 'comprobantes';

// ── API pública ────────────────────────────────────────────────────────────

/**
 * Genera el PDF del comprobante identificado por `facturaId` y lo sube a Storage.
 * Actualiza `facturas.pdf_url` con la URL pública al terminar.
 *
 * @param {string} facturaId  UUID de la fila en `facturas`.
 * @returns {{ ok: boolean, url?: string, error?: string }}
 */
export async function generarPDFComprobante(facturaId) {
  if (!facturaId) {
    return { ok: false, error: '[pdf] Se requiere facturaId.' };
  }

  // 1. Leer todos los datos necesarios desde Supabase
  let contexto;
  try {
    contexto = await leerContextoPDF(facturaId);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // 2. Generar el buffer PDF en memoria
  let pdfBuffer;
  try {
    pdfBuffer = await construirPDF(contexto);
  } catch (err) {
    console.error('[pdf] Error generando PDF:', err);
    return { ok: false, error: `[pdf] Error al construir el PDF: ${err.message}` };
  }

  // 3. Subir a Supabase Storage
  const storagePath = rutaStorage(contexto.factura);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true, // sobreescribe si ya existe (reintento o regeneración)
    });

  if (uploadError) {
    console.error('[pdf] Error subiendo a Storage:', uploadError.message);
    return { ok: false, error: `[pdf] Error al subir el PDF: ${uploadError.message}` };
  }

  // 4. Obtener URL pública
  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const url = urlData?.publicUrl;

  if (!url) {
    return { ok: false, error: '[pdf] No se pudo obtener la URL pública del PDF.' };
  }

  // 5. Guardar la URL en facturas.pdf_url
  const { error: updateError } = await supabase
    .from('facturas')
    .update({ pdf_url: url })
    .eq('id', facturaId);

  if (updateError) {
    // No crítico: el PDF existe en Storage, solo falló la referencia en BD.
    console.error('[pdf] PDF subido pero no se pudo guardar pdf_url en facturas:', updateError.message);
  }

  return { ok: true, url };
}

// ── Leer datos de la BD ────────────────────────────────────────────────────

async function leerContextoPDF(facturaId) {
  // Factura + cliente
  const { data: factura, error: errFact } = await supabase
    .from('facturas')
    .select(`
      id, tipo, numero, cae, cae_vto, total, neto, iva,
      fecha_emision, empresa_id, cliente_id, pedido_id, venta_pos_id,
      clientes (
        razon_social, nombre_fantasia, cuit,
        condicion_iva, domicilio, localidad
      )
    `)
    .eq('id', facturaId)
    .single();

  if (errFact || !factura) {
    throw new Error(`[pdf] Factura ${facturaId} no encontrada: ${errFact?.message ?? 'sin datos'}`);
  }

  if (!factura.cae) {
    throw new Error(`[pdf] La factura ${facturaId} no tiene CAE — no se puede generar el PDF antes de emitir.`);
  }

  // Empresa + config de facturación (razón social, CUIT fiscal, domicilio oficial)
  const { data: empresa, error: errEmp } = await supabase
    .from('empresas')
    .select('nombre, cuit, domicilio, email')
    .eq('id', factura.empresa_id)
    .single();

  if (errEmp || !empresa) {
    throw new Error(`[pdf] Empresa ${factura.empresa_id} no encontrada.`);
  }

  // Datos adicionales de facturacion_config (razon_social oficial, condicion_iva, punto_venta)
  const { data: cfg } = await supabase
    .from('facturacion_config')
    .select('razon_social, condicion_iva, domicilio, punto_venta')
    .eq('empresa_id', factura.empresa_id)
    .eq('activo', true)
    .maybeSingle();

  // Items: pedido_items o venta_pos_items según origen de la factura
  const items = await leerItems(factura);

  return {
    factura,
    empresa: {
      nombre:       cfg?.razon_social || empresa.nombre,
      cuit:         empresa.cuit,
      domicilio:    cfg?.domicilio    || empresa.domicilio || '',
      condicion_iva: cfg?.condicion_iva || 'monotributo',
      punto_venta:  cfg?.punto_venta  || 1,
    },
    cliente: factura.clientes || null,
    items,
  };
}

async function leerItems(factura) {
  // Intentar pedido_items primero
  if (factura.pedido_id) {
    const { data } = await supabase
      .from('pedido_items')
      .select('cantidad, precio_unitario, subtotal, productos(nombre, iva)')
      .eq('pedido_id', factura.pedido_id);
    if (data?.length) {
      return data.map(it => ({
        descripcion:     it.productos?.nombre || 'Producto',
        cantidad:        Number(it.cantidad),
        precio_unitario: Number(it.precio_unitario),
        subtotal:        Number(it.subtotal),
        iva:             it.productos?.iva ?? null,
      }));
    }
  }

  // Luego venta_pos_items
  if (factura.venta_pos_id) {
    const { data } = await supabase
      .from('venta_pos_items')
      .select('cantidad, precio_unitario, subtotal, productos(nombre, iva)')
      .eq('venta_pos_id', factura.venta_pos_id);
    if (data?.length) {
      return data.map(it => ({
        descripcion:     it.productos?.nombre || 'Producto',
        cantidad:        Number(it.cantidad),
        precio_unitario: Number(it.precio_unitario),
        subtotal:        Number(it.subtotal),
        iva:             it.productos?.iva ?? null,
      }));
    }
  }

  // Fallback: una sola línea con el total (NC o factura sin items explícitos
  // — ej. la NC en sí, que se persiste con pedido_id/venta_pos_id en null y
  // se referencia por factura_origen_id en vez de tener sus propios ítems).
  // Sin ítems reales no hay forma de reconstruir el desglose por alícuota,
  // así que `iva` queda null: el bloque de totales usa el neto/iva agregado
  // que ya está en `facturas` en vez de inventar un desglose.
  return [{
    descripcion:     tipoLabel(factura.tipo),
    cantidad:        1,
    precio_unitario: Number(factura.total),
    subtotal:        Number(factura.total),
    iva:             null,
  }];
}

// ── Construcción del PDF ───────────────────────────────────────────────────

async function construirPDF({ factura, empresa, cliente, items }) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size:    'A4',
        margins: { top: 40, bottom: 40, left: 45, right: 45 },
        info: {
          Title:   `${tipoLabel(factura.tipo)} ${factura.numero}`,
          Author:  empresa.nombre,
          Subject: 'Comprobante electrónico ARCA',
        },
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W   = doc.page.width  - doc.page.margins.left - doc.page.margins.right;
      const L   = doc.page.margins.left;
      const TOP = doc.page.margins.top;

      // ── Encabezado ──────────────────────────────────────────────────────

      // Cuadro central: letra del comprobante
      const letraBox = { x: L + W / 2 - 28, y: TOP, w: 56, h: 56 };
      doc.rect(letraBox.x, letraBox.y, letraBox.w, letraBox.h).stroke('#374151');

      const letra = letraDelTipo(factura.tipo);
      doc
        .font('Helvetica-Bold').fontSize(28)
        .text(letra, letraBox.x, letraBox.y + 6, { width: letraBox.w, align: 'center' });

      const codigoTipo = codigoTipoARCA(factura.tipo);
      doc
        .font('Helvetica').fontSize(7)
        .text(`Cod. ${codigoTipo}`, letraBox.x, letraBox.y + 38, { width: letraBox.w, align: 'center' });

      // Bloque izquierdo: emisor
      const emisorX = L;
      const emisorW = W / 2 - 36;
      doc.rect(emisorX, TOP, emisorW, 56).stroke('#374151');
      doc
        .font('Helvetica-Bold').fontSize(11)
        .text(empresa.nombre, emisorX + 8, TOP + 6, { width: emisorW - 16 });
      doc
        .font('Helvetica').fontSize(8)
        .text(`CUIT: ${formatearCuit(empresa.cuit)}`, emisorX + 8, TOP + 21, { width: emisorW - 16 })
        .text(empresa.domicilio || '', emisorX + 8, TOP + 31, { width: emisorW - 16 })
        .text(condicionIvaLabel(empresa.condicion_iva), emisorX + 8, TOP + 41, { width: emisorW - 16 });

      // Bloque derecho: tipo de comprobante
      const derechaX = L + W / 2 + 28;
      const derechaW = W / 2 - 36;
      doc.rect(derechaX, TOP, derechaW, 56).stroke('#374151');
      doc
        .font('Helvetica-Bold').fontSize(9)
        .text(tipoLabel(factura.tipo), derechaX + 8, TOP + 6, { width: derechaW - 16 })
        .font('Helvetica').fontSize(8)
        .text(`N°: ${factura.numero || '—'}`, derechaX + 8, TOP + 19, { width: derechaW - 16 })
        .text(`Fecha: ${formatearFecha(factura.fecha_emision)}`, derechaX + 8, TOP + 29, { width: derechaW - 16 })
        .text(`Punto de venta: ${String(empresa.punto_venta).padStart(5, '0')}`, derechaX + 8, TOP + 39, { width: derechaW - 16 });

      // ── Datos del receptor ───────────────────────────────────────────────

      let y = TOP + 66;

      doc.rect(L, y, W, 44).stroke('#374151');
      doc
        .font('Helvetica-Bold').fontSize(8)
        .text('RECEPTOR', L + 8, y + 4);
      doc.font('Helvetica').fontSize(8);

      const nombreCliente = cliente?.razon_social || cliente?.nombre_fantasia || 'CONSUMIDOR FINAL';
      doc.text(`Razón social / Nombre: ${nombreCliente}`, L + 8, y + 14, { width: W / 2 - 10 });

      if (cliente?.cuit) {
        doc.text(`CUIT: ${formatearCuit(cliente.cuit)}`, L + 8, y + 24);
      } else {
        doc.text('Consumidor Final', L + 8, y + 24);
      }

      const domCliente = [cliente?.domicilio, cliente?.localidad].filter(Boolean).join(', ');
      if (domCliente) {
        doc.text(`Domicilio: ${domCliente}`, L + W / 2, y + 14, { width: W / 2 - 8 });
      }

      if (cliente?.condicion_iva) {
        doc.text(`Condición IVA: ${condicionIvaLabel(cliente.condicion_iva)}`, L + W / 2, y + 24, { width: W / 2 - 8 });
      }

      // ── Tabla de items ───────────────────────────────────────────────────

      y += 54;

      // Encabezado tabla
      const colDesc  = { x: L,           w: W * 0.48 };
      const colCant  = { x: L + W * 0.48, w: W * 0.10 };
      const colPU    = { x: L + W * 0.58, w: W * 0.20 };
      const colSub   = { x: L + W * 0.78, w: W * 0.22 };

      doc.rect(L, y, W, 16).fillAndStroke('#f3f4f6', '#374151');
      doc
        .fillColor('#111827').font('Helvetica-Bold').fontSize(8)
        .text('Descripción',     colDesc.x + 4, y + 4, { width: colDesc.w - 4 })
        .text('Cant.',           colCant.x,     y + 4, { width: colCant.w, align: 'center' })
        .text('Precio unit.',    colPU.x,       y + 4, { width: colPU.w,   align: 'right' })
        .text('Subtotal',        colSub.x,       y + 4, { width: colSub.w - 4, align: 'right' });

      y += 16;

      // Filas
      doc.font('Helvetica').fontSize(8);
      for (const item of items) {
        const lineH = 14;
        if (y + lineH > doc.page.height - doc.page.margins.bottom - 120) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        doc.rect(L, y, W, lineH).stroke('#e5e7eb');
        doc
          .fillColor('#111827')
          .text(item.descripcion,                    colDesc.x + 4, y + 3, { width: colDesc.w - 8, ellipsis: true })
          .text(String(item.cantidad),               colCant.x,     y + 3, { width: colCant.w,     align: 'center' })
          .text(formatARS(item.precio_unitario),     colPU.x,       y + 3, { width: colPU.w,       align: 'right' })
          .text(formatARS(item.subtotal),            colSub.x,      y + 3, { width: colSub.w - 4,  align: 'right' });
        y += lineH;
      }

      // ── Totales ───────────────────────────────────────────────────────────

      y += 6;

      const totW  = 160;
      const totX  = L + W - totW;
      const lineT = 15;

      const esMonotributista = empresa.condicion_iva === 'monotributo' ||
                               empresa.condicion_iva === 'Monotributista';

      if (!esMonotributista && factura.neto != null && factura.iva != null) {
        // Responsable Inscripto: mostrar neto + IVA. Si tenemos los ítems
        // reales con alícuota (factura A/B con pedido/venta de origen), se
        // reconstruye el desglose real — una fila de IVA por alícuota, en
        // vez del "IVA (21%)" fijo que asumía una sola tasa. Si no hay
        // ítems con alícuota (ej. PDF de una Nota de Crédito, que no tiene
        // sus propios ítems), se cae al IVA agregado ya persistido en
        // `facturas.iva` sin inventar un porcentaje.
        const itemsConAlicuota = items.filter(it => it.iva != null);
        let desglose = null;
        if (itemsConAlicuota.length === items.length && items.length > 0) {
          try {
            desglose = calcularDesgloseIva(itemsConAlicuota);
          } catch (err) {
            console.warn('[pdf] No se pudo reconstruir el desglose de IVA, uso el agregado:', err.message);
          }
        }

        filaTotales(doc, totX, y, totW, 'Neto gravado:', formatARS(factura.neto), lineT);
        y += lineT;

        if (desglose && desglose.alicuotas.length > 0) {
          for (const a of desglose.alicuotas) {
            filaTotales(doc, totX, y, totW, `IVA (${formatPct(a.alicuota)}):`, formatARS(a.importe), lineT);
            y += lineT;
          }
        } else {
          filaTotales(doc, totX, y, totW, 'IVA:', formatARS(factura.iva), lineT);
          y += lineT;
        }
      }

      // Total
      doc.rect(totX, y, totW, lineT + 2).fillAndStroke('#1e3a5f', '#1e3a5f');
      doc
        .fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
        .text('TOTAL:', totX + 6, y + 4, { width: totW * 0.5 })
        .text(formatARS(factura.total), totX, y + 4, { width: totW - 6, align: 'right' });
      doc.fillColor('#111827');

      // ── CAE y código de barras ───────────────────────────────────────────

      y += lineT + 14;

      if (y > doc.page.height - doc.page.margins.bottom - 80) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      doc.moveTo(L, y).lineTo(L + W, y).stroke('#e5e7eb');
      y += 8;

      // Código de barras INTERLEAVED 2of5 según especificación ARCA
      // Dato: CUIT(11) + TipoCbte(2) + PtoVta(4) + NroCbte(8) + VtoCae(8) + CAE(14) = 47 dígitos
      const barcode2of5 = armarCodigoBarras({
        cuit:       empresa.cuit,
        tipoCbte:   codigoTipoARCA(factura.tipo),
        ptoVenta:   empresa.punto_venta,
        numero:     factura.numero,
        caeVto:     factura.cae_vto,
        cae:        factura.cae,
      });

      try {
        const barcodeBuffer = await generarCodigoBarras(barcode2of5);
        doc.image(barcodeBuffer, L, y, { width: 220, height: 32 });
      } catch (bErr) {
        // Si falla el barcode (entorno sin soporte gráfico), continuar sin él.
        console.warn('[pdf] No se pudo generar código de barras:', bErr.message);
        doc.font('Helvetica').fontSize(7).text(`[código: ${barcode2of5}]`, L, y);
      }

      doc
        .font('Helvetica').fontSize(7.5).fillColor('#374151')
        .text(`CAE N°: ${factura.cae}`, L + 230, y)
        .text(`Vto. CAE: ${formatearFechaCAE(factura.cae_vto)}`, L + 230, y + 12)
        .text('Comprobante autorizado por ARCA', L + 230, y + 24);

      y += 40;

      // Leyenda legal mínima ARCA
      doc
        .font('Helvetica').fontSize(6.5).fillColor('#9ca3af')
        .text(
          'Este comprobante fue generado y autorizado electrónicamente por ARCA (ex-AFIP). ' +
          'La validez del CAE puede verificarse en www.afip.gob.ar/fe/qr.',
          L, y, { width: W, align: 'center' }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── Helpers de dibujo ──────────────────────────────────────────────────────

function filaTotales(doc, x, y, w, label, valor, h) {
  doc.rect(x, y, w, h).stroke('#e5e7eb');
  doc
    .font('Helvetica').fontSize(8).fillColor('#374151')
    .text(label, x + 6, y + 3, { width: w * 0.55 })
    .text(valor,  x,     y + 3, { width: w - 6, align: 'right' });
}

// ── Código de barras ARCA (INTERLEAVED 2of5) ──────────────────────────────
// Especificación: https://www.afip.gob.ar/fe/documentos/CodigosBarraFEv1.pdf
// Estructura: CUIT(11) + TipoCbte(2) + PtoVta(5) + NroCbte(8) + FchVtoCae(8) + CAE(14) = 48 dígitos

function armarCodigoBarras({ cuit, tipoCbte, ptoVenta, numero, caeVto, cae }) {
  const cuitLimpio = String(cuit).replace(/\D/g, '').padStart(11, '0').slice(0, 11);
  const tipoPad    = String(tipoCbte).padStart(2, '0');
  const ptoPad     = String(ptoVenta).padStart(5, '0');

  // Extraer número puro del campo `numero` ("C-00001-00000042" → "00000042")
  const nroMatch = String(numero || '').match(/(\d{8})$/);
  const nroPad   = nroMatch ? nroMatch[1] : '00000000';

  // Fecha vto CAE: puede ser date "2026-07-15" o iso string → YYYYMMDD
  const vto = caeVto ? String(caeVto).replace(/-/g, '').slice(0, 8) : '00000000';

  const caeLimpio = String(cae || '').replace(/\D/g, '').padStart(14, '0').slice(0, 14);

  return `${cuitLimpio}${tipoPad}${ptoPad}${nroPad}${vto}${caeLimpio}`;
}

async function generarCodigoBarras(data) {
  return new Promise((resolve, reject) => {
    bwipjs.toBuffer(
      {
        bcid:        'interleaved2of5',
        text:        data,
        scale:       2,
        height:      10,      // unidades bwip — ≈ 10mm de alto
        includetext: false,
        backgroundcolor: 'ffffff',
      },
      (err, png) => {
        if (err) reject(err);
        else resolve(png);
      }
    );
  });
}

// ── Storage path ───────────────────────────────────────────────────────────

function rutaStorage(factura) {
  // Ej: "empresas/<empresa_id>/facturas/<numero>.pdf"
  const nombre = (factura.numero || factura.id).replace(/[^a-zA-Z0-9_\-]/g, '_');
  return `empresas/${factura.empresa_id}/facturas/${nombre}.pdf`;
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatARS(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'ARS', minimumFractionDigits: 2,
  }).format(Number(n));
}

/** Formatea una alícuota de IVA para el label del PDF: 21 → "21%", 10.5 → "10,5%". */
function formatPct(n) {
  return `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(Number(n))}%`;
}

function formatearFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatearFechaCAE(val) {
  if (!val) return '—';
  // Puede llegar como "2026-07-15" (date) o como "20260715" (string ARCA)
  const s = String(val).replace(/-/g, '');
  if (s.length === 8) {
    return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  }
  return String(val);
}

function formatearCuit(cuit) {
  const c = String(cuit || '').replace(/\D/g, '');
  if (c.length === 11) return `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;
  return cuit;
}

function tipoLabel(tipo) {
  const map = {
    'C':    'FACTURA C',
    'B':    'FACTURA B',
    'A':    'FACTURA A',
    'NC_C': 'NOTA DE CRÉDITO C',
    'NC_B': 'NOTA DE CRÉDITO B',
    'NC_A': 'NOTA DE CRÉDITO A',
  };
  return map[tipo] || `COMPROBANTE ${tipo}`;
}

function letraDelTipo(tipo) {
  if (!tipo) return '?';
  // 'NC_C' → 'C', 'B' → 'B', etc.
  return tipo.replace('NC_', '').slice(0, 1);
}

function codigoTipoARCA(tipo) {
  const map = {
    'A': 1, 'B': 6, 'C': 11,
    'NC_A': 3, 'NC_B': 8, 'NC_C': 13,
  };
  return map[tipo] ?? 11;
}

function condicionIvaLabel(condicion) {
  const map = {
    'monotributo':          'Monotributista',
    'responsable_inscripto': 'Responsable Inscripto',
    'exento':               'Exento',
    'consumidor_final':     'Consumidor Final',
  };
  return map[condicion] || condicion || 'Consumidor Final';
}
