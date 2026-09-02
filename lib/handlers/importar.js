// api/importar/index.js
// POST /api/importar           → delega a RPC importar_productos_lote en Supabase
// POST /api/importar?vision=1  → OCR vía Claude Vision sobre imagen/PDF escaneado
//
// La lógica de importación vive en db/025_rpc_importar_productos.sql
// Esta función solo autentica y delega. Sin procesamiento pesado = sin timeouts.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { getUserSeguro } from '../auth-helpers.js';
import { rateLimit }    from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { obtenerEmpresaYRolPorAuthId } from '../repos/usuarios.js';
import { importarProductosLoteRpc, conciliarRecepcionRpc, insertarRecepcionBorrador } from '../repos/importar.js';
// FIX 092: sharp eliminado del top-level. Un import estático de sharp en ESM
// hace que api/index.js (que importa este módulo) crashee al cargarse,
// tumbando TODOS los 21 handlers. Se reemplaza con import() dinámico en el
// único punto de uso (procesamiento de imagen en modo ?vision=1).

// Se mantiene el cliente propio solo para Auth (getUser) — no es acceso a tabla.
const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

const limiter        = rateLimit({ max: 120, windowMs: 60_000 }); // upsert CSV: delega a RPC, sin costo externo
const limiterVision  = rateLimit({ max: 5,   windowMs: 60_000 }); // OCR vía Claude Vision: tiene costo por llamada, mismo criterio que /importar del plan

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido' });

  if (await limiter(req, res)) return;

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerEmpresaYRolPorAuthId(user.id);

  if (!perfil || !puede(perfil, 'cargar', 'importar'))
    return res.status(403).json({ error: 'Solo administradores pueden importar productos' });

  if (req.query.vision === '1') {
    if (await limiterVision(req, res)) return;
    if (req.query.tipo === 'remito')
      return handleVisionRemito(req, res, perfil.empresa_id);
    return handleVision(req, res, perfil.empresa_id);
  }

  return handleUpsert(req, res, perfil.empresa_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Upsert: delega completamente a la RPC de Supabase
// ─────────────────────────────────────────────────────────────────────────────
async function handleUpsert(req, res, empresa_id) {
  try {
    const { filas, lista_precio_id, lista_nombre, deposito_id } = req.body || {};

    if (!Array.isArray(filas) || filas.length === 0)
      return res.status(400).json({ error: 'Se requiere un array "filas"' });

    if (filas.length > 500)
      return res.status(400).json({ error: 'Máximo 500 productos por lote' });

    const { data, error } = await importarProductosLoteRpc({
      p_empresa_id:      empresa_id,
      p_filas:           filas,
      p_lista_precio_id: lista_precio_id || null,
      p_lista_nombre:    lista_nombre    || null,
      p_deposito_id:     deposito_id     || null,
    });

    if (error) {
      console.error('[importar] RPC error:', error);
      return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    }

    if (!data?.ok) {
      return res.status(500).json({ error: data?.error || 'Error en RPC' });
    }

    return res.json({
      ok:              true,
      resumen:         data.resumen,
      lista_precio_id: data.lista_precio_id,
      errores_detalle: data.errores_detalle || [],
      resultados:      [],   // compatibilidad con versión anterior
    });

  } catch (err) {
    console.error('[importar] crash:', err);
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.', { error: 'Error interno: ' + err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function preprocessImage(imagen_base64, mime_type) {
  const buffer = Buffer.from(imagen_base64, 'base64');
  let processedBuffer;

  if (mime_type.startsWith('image/')) {
    // FIX 092: import() dinámico para evitar crash de top-level import en ESM
    const { default: sharp } = await import('sharp');
    processedBuffer = await sharp(buffer)
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } else if (mime_type === 'application/pdf') {
    // Para PDFs, podríamos extraer la primera página como imagen si fuera necesario
    // Por ahora, solo pasamos el buffer original si no es imagen
    processedBuffer = buffer;
  } else {
    processedBuffer = buffer;
  }

  return processedBuffer.toString('base64');
}

// Medición temporal de uso de OCR (ver AUDITORIA_UI_VS_DATOS_DEMO_2026-08 / hilo Active CPU).
// Best-effort: nunca debe romper ni demorar la respuesta al usuario.
async function registrarUsoOcr({ empresa_id, tipo, ok, duracion_ms, bytes_entrada, bytes_salida }) {
  try {
    await supabase.from('ocr_usage_log').insert({
      empresa_id, tipo, ok, duracion_ms, bytes_entrada, bytes_salida,
    });
  } catch (e) {
    console.error('[importar] no se pudo registrar uso OCR (no bloqueante):', e.message);
  }
}

// Vision OCR
// ─────────────────────────────────────────────────────────────────────────────
async function handleVision(req, res, empresa_id) {
  const t0 = Date.now();
  const { imagen_base64, mime_type } = req.body || {};
  if (!imagen_base64 || !mime_type)
    return res.status(400).json({ error: 'Se requiere imagen_base64 y mime_type' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY)
    return res.status(500).json({ error: 'API key de Claude no configurada' });

  const prompt = `Analizá esta imagen de una lista de precios o catálogo de productos.\nExtraé todos los productos que puedas identificar y devolvé ÚNICAMENTE un JSON válido con este formato (sin texto adicional, sin markdown):\n[{"codigo":"EAN o código interno o vacío","nombre":"nombre del producto","precio":0.00,"categoria":"categoría o vacío"}]\nSi un campo no está disponible, usá cadena vacía para texto y 0 para precio.\nPrecio en número (sin símbolos de moneda). Incluí todos los productos visibles aunque estén incompletos.`;

  const bytesEntrada = Buffer.byteLength(imagen_base64, 'base64');
  let imagenProcesada, bytesSalida;

  try {
    imagenProcesada = await preprocessImage(imagen_base64, mime_type);
    bytesSalida = Buffer.byteLength(imagenProcesada, 'base64');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime_type, data: imagenProcesada } },
          { type: 'text',  text: prompt }
        ]}]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      await registrarUsoOcr({ empresa_id, tipo: 'productos', ok: false, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: bytesSalida });
      return res.status(502).json({ error: 'Error de Vision API', detalle: err });
    }

    const data   = await response.json();
    const texto  = data.content?.find(b => b.type === 'text')?.text || '[]';
    const limpio = texto.replace(/```json|```/g, '').trim();
    let filas;
    try   { filas = JSON.parse(limpio); }
    catch {
      await registrarUsoOcr({ empresa_id, tipo: 'productos', ok: false, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: bytesSalida });
      return res.status(502).json({ error: 'Respuesta de Vision no es JSON válido', raw: texto });
    }

    await registrarUsoOcr({ empresa_id, tipo: 'productos', ok: true, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: bytesSalida });
    return res.json({ filas });
  } catch (err) {
    await registrarUsoOcr({ empresa_id, tipo: 'productos', ok: false, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: bytesSalida });
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.2: Vision OCR para remitos y facturas de proveedor
// POST /api/importar?vision=1&tipo=remito
// ─────────────────────────────────────────────────────────────────────────────
export async function handleVisionRemito(req, res, empresa_id) {
  const t0 = Date.now();
  const { imagen_base64, mime_type, orden_id } = req.body || {};

  if (!imagen_base64 || !mime_type)
    return res.status(400).json({ error: 'Se requiere imagen_base64 y mime_type' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY)
    return res.status(500).json({ error: 'API key de Claude no configurada' });

  const prompt = `Analizá esta imagen de un remito o factura de proveedor.
Extraé todos los productos listados y devolvé ÚNICAMENTE un JSON válido (sin texto adicional, sin markdown):
[{"codigo":"código de barras o interno o vacío","nombre":"descripción del producto","cantidad":0,"precio_unitario":0.00}]
Reglas:
- cantidad: número de unidades recibidas (no precio). Si dice "12 unidades" → cantidad: 12.
- precio_unitario: precio por unidad sin IVA. Si no está claro, usá 0.
- codigo: EAN, código de barras, o código interno. Si no aparece, usá cadena vacía.
- Incluí todos los renglones del documento aunque estén incompletos.
- No incluyas subtotales, totales ni encabezados como productos.`;

  const bytesEntrada = Buffer.byteLength(imagen_base64, 'base64');
  let imagenProcesada, bytesSalida;
  try {
    imagenProcesada = await preprocessImage(imagen_base64, mime_type);
    bytesSalida = Buffer.byteLength(imagenProcesada, 'base64');
  } catch (e) {
    await registrarUsoOcr({ empresa_id, tipo: 'remito', ok: false, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: null });
    return errorSeguro(res, e, 400, 'Error al procesar imagen.');
  }

  let datosOcr;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime_type, data: imagenProcesada } },
          { type: 'text',  text: prompt }
        ]}]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      await registrarUsoOcr({ empresa_id, tipo: 'remito', ok: false, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: bytesSalida });
      return res.status(502).json({ error: 'Error de Vision API', detalle: err });
    }

    const data   = await response.json();
    const texto  = data.content?.find(b => b.type === 'text')?.text || '[]';
    const limpio = texto.replace(/```json|```/g, '').trim();

    try   { datosOcr = JSON.parse(limpio); }
    catch {
      await registrarUsoOcr({ empresa_id, tipo: 'remito', ok: false, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: bytesSalida });
      return res.status(502).json({ error: 'Respuesta OCR no es JSON válido', raw: texto });
    }

  } catch (err) {
    await registrarUsoOcr({ empresa_id, tipo: 'remito', ok: false, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: bytesSalida });
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.', { error: 'Error al llamar Vision API: ' + err.message });
  }

  // Si hay orden_id, cruzar con la OC vía RPC
  let conciliacion = null;
  if (orden_id) {
    const { data: conc, error: errConc } = await conciliarRecepcionRpc({
      orden_id,
      datos_ocr: JSON.stringify(datosOcr),
      umbral_pct: 10,
    });

    if (!errConc && conc?.ok) {
      conciliacion = conc;
    } else {
      console.warn('[importar/remito] conciliar_recepcion error:', errConc?.message);
    }
  }

  // Guardar borrador de recepcion_mercaderia
  const recepcion = await insertarRecepcionBorrador({
    empresa_id,
    orden_id:          orden_id || null,
    datos_ocr:         datosOcr,
    items_conciliados: conciliacion?.items    || null,
    discrepancias:     conciliacion?.discrepancias || null,
    estado:            'borrador'
  });

  await registrarUsoOcr({ empresa_id, tipo: 'remito', ok: true, duracion_ms: Date.now() - t0, bytes_entrada: bytesEntrada, bytes_salida: bytesSalida });

  return res.json({
    ok:           true,
    recepcion_id: recepcion?.id || null,
    datos_ocr:    datosOcr,
    conciliacion
  });
}
