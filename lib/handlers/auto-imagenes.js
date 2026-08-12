// lib/handlers/auto-imagenes.js
// POST /api/auto-imagenes  → busca y carga automáticamente fotos de productos
// que todavía no tienen foto_url, en 3 capas (de más a menos precisa):
//
//   Capa 1 (match exacto, alimentos): si `codigo` es un EAN/UPC válido, se
//   consulta Open Food Facts (gratis, sin key) y se usa la foto real del
//   producto. Cubre bien alimentos/bebidas, pero NO bazar/limpieza/perfumería.
//
//   Capa 1b (match exacto, no alimentos): mismo barcode, pero contra Open
//   Products Facts — el proyecto hermano de Open Food Facts para productos
//   NO alimenticios (limpieza, higiene, bazar, ferretería, etc.), gratis y
//   sin key, misma API. Se prueba solo si la Capa 1 no encontró nada, porque
//   depende del rubro del cliente: en limpieza/bazar Open Food Facts da 0
//   resultados por diseño (no es su rubro), no por falla de código de barra.
//
//   Capa 2 (match real, por nombre): búsqueda de imágenes en Google vía
//   Serper.dev, opt-in (SERPER_API_KEY). En dos etapas: primero restringida
//   a MercadoLibre (`site:mercadolibre.com.ar`), porque estos productos
//   mayoristas casi siempre terminan revendidos ahí y la foto de la
//   publicación es la del producto exacto, no una ilustrativa — y recién si
//   no hay nada ahí, cae a la búsqueda general (ver CHANGELOG_v396). Es la
//   capa más efectiva para productos sin barcode real (código interno
//   corto) o que no matchearon en Capa 1/1b, y cubre cualquier rubro.
//
//   (v394: se sacó la Capa 3 de banco de fotos genérico — Pexels devolvía
//   fotos representativas, no la foto real, y en la práctica terminaba
//   siendo la única capa que corría porque la fuente de foto real no estaba
//   configurada. Ver CHANGELOG_v394: "una foto claramente incorrecta es
//   peor que no tener foto" — ahora lo que no matchea por barcode ni por
//   Serper queda con el ícono de categoría, sin excepción.)
//
//   (v393→v394: la Capa 2 real usaba Google Custom Search JSON API
//   directo; se reemplazó por Serper.dev porque esa API de Google está
//   cerrada a cuentas nuevas desde 2025 y se discontinúa el 1/1/2027 —
//   Serper da el mismo resultado (scrapea Google Images), acepta cuentas
//   nuevas, y sale más barato: ~USD 1/1000 consultas contra los USD 5/1000
//   de Google CSE, sin el límite duro de 10.000/día.)
//
// Lo que no encuentra match en ninguna capa queda con foto_url = null a
// propósito: el frontend de la tienda debe mostrar el ícono SVG de la
// categoría como respaldo (nunca se guarda una URL "falsa").
//
// Se procesa en lotes chicos (default 8, máx 15) porque cada producto
// puede implicar 1-2 llamadas HTTP externas + descarga/resize/upload de
// imagen — con lotes grandes se corre riesgo de timeout de la función
// serverless. El frontend llama a este endpoint repetidas veces hasta que
// `restantes` llega a 0.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { rateLimit }    from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { listarProductosSinFoto, actualizarFotoProducto, contarProductosSinFoto } from '../repos/productos.js';
import { obtenerEmpresaYRolPorAuthId } from '../repos/usuarios.js';
import { leerContadorUsoApi, incrementarContadorUsoApi } from '../repos/auto-imagenes.js';
import { puede } from '../permisos-service.js';

// Se mantiene el cliente propio solo para Auth (getUser) y Storage (subida de
// fotos) — ninguno de los dos es acceso a tabla, quedan fuera del repo.
const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

// Cada llamada dispara trabajo pesado (HTTP externo + storage), por eso el
// límite es bajo — a diferencia de /api/importar que solo delega a una RPC.
const limiter = rateLimit({ max: 20, windowMs: 60_000 });

const LOTE_DEFAULT = 8;
const LOTE_MAX     = 15;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  if (req.method !== 'POST' && req.method !== 'GET')
    return res.status(405).json({ error: 'Método no permitido' });

  if (await limiter(req, res)) return;

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerEmpresaYRolPorAuthId(user.id);

  if (!perfil || !puede(perfil, 'ejecutar', 'auto_imagenes'))
    return res.status(403).json({ error: 'Solo administradores pueden ejecutar esta acción' });

  // v395: GET liviano — solo devuelve el contador de uso de Serper, no
  // dispara ninguna búsqueda de imágenes. Lo usa el modal del frontend
  // para mostrar cuánto se lleva gastado antes de arrancar.
  if (req.method === 'GET') {
    return res.json({ ok: true, contadorSerper: await leerContadorSerper() });
  }

  // v394: se saca la Capa 3 de Pexels (banco genérico) por completo — la
  // única búsqueda ampliada ahora es la foto real por nombre (Serper).
  const incluirBusquedaReal = req.body?.incluirBusquedaReal === true;

  if (incluirBusquedaReal && !process.env.SERPER_API_KEY) {
    return res.status(500).json({
      error: 'Falta configurar SERPER_API_KEY en Vercel para poder buscar '
        + 'la foto real del producto por nombre (serper.dev).',
    });
  }

  // v397: el frontend manda acá los IDs de productos que YA se intentaron
  // en esta misma corrida (con o sin match) para que no se vuelvan a traer
  // en el próximo lote — ver nota en procesarLote() sobre el bug del loop
  // infinito que esto soluciona.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const excluirIds = Array.isArray(req.body?.excluirIds)
    ? req.body.excluirIds.filter(id => typeof id === 'string' && UUID_RE.test(id))
    : [];

  try {
    const loteSolicitado = parseInt(req.body?.lote, 10);
    const lote = Number.isFinite(loteSolicitado)
      ? Math.min(Math.max(loteSolicitado, 1), LOTE_MAX)
      : LOTE_DEFAULT;

    return await procesarLote(res, perfil.empresa_id, lote, incluirBusquedaReal, excluirIds);
  } catch (err) {
    console.error('[auto-imagenes] crash:', err);
    return errorSeguro(res, err, 500, 'No se pudo completar la búsqueda de imágenes.');
  }
}

// v397: se agrega excluirIds — antes, un producto que no conseguía match
// en ninguna capa se quedaba con foto_url null para siempre, así que la
// query de "traer los próximos N sin foto" volvía a traer EL MISMO
// producto en cada tanda del loop del frontend. Como `restantes` (el
// count total de la empresa) nunca bajaba de ese resto permanente, el
// loop no tenía forma de terminar solo — se probó en vivo con un lote de
// 20 productos y el contador de "procesados" llegó a 73 antes de que se
// cortara la búsqueda manualmente, aunque en la base solo había 20 filas
// reales (13 con foto, 7 sin match). Con excluirIds, cada tanda saca de
// la selección los IDs que YA se intentaron en esta misma corrida (haya
// o no haya matcheado), así que el próximo lote SIEMPRE trae productos
// nuevos — y cuando ya no queda ninguno sin intentar, procesados = 0 y el
// loop corta solo por la condición que ya existía en el frontend.
async function procesarLote(res, empresaId, lote, incluirBusquedaReal, excluirIds = []) {
  let productos;
  try {
    productos = await listarProductosSinFoto(empresaId, { limit: lote, excluirIds });
  } catch (errProductos) {
    console.error('[auto-imagenes] error leyendo productos:', errProductos);
    return errorSeguro(res, errProductos, 500, 'No se pudo leer el listado de productos.');
  }

  const resultados = await Promise.all((productos || []).map(async (producto) => {
    try {
      const resultado = await resolverImagenProducto(producto, incluirBusquedaReal);
      if (!resultado) {
        return { id: producto.id, nombre: producto.nombre, resultado: 'sin_match' };
      }

      const fotoUrl = await subirFotoAlBucket(empresaId, producto.id, resultado.buffer);

      await actualizarFotoProducto(producto.id, { foto_url: fotoUrl, foto_fuente: resultado.fuente || null });

      return { id: producto.id, nombre: producto.nombre, resultado: 'ok', fuente: resultado.fuente };
    } catch (errProducto) {
      console.error(`[auto-imagenes] error en producto ${producto.id}:`, errProducto);
      return { id: producto.id, nombre: producto.nombre, resultado: 'error' };
    }
  }));

  const detalle = resultados;
  const conFoto = resultados.filter(r => r.resultado === 'ok').length;

  const restantes = await contarProductosSinFoto(empresaId);

  return res.json({
    ok: true,
    procesados: (productos || []).length,
    con_foto: conFoto,
    sin_match: (productos || []).length - conFoto,
    restantes: restantes || 0,
    detalle,
    contadorSerper: await leerContadorSerper(),
  });
}

// v395: lectura del contador interno de uso de Serper (ver migración
// 395_contador_uso_serper.sql). Es un select directo porque este handler
// ya usa el service role (bypassa RLS) — no hace falta una RPC para leer,
// solo para incrementar de forma atómica.
async function leerContadorSerper() {
  try {
    const data = await leerContadorUsoApi('serper');
    return { usados: data?.usados ?? 0, actualizadoAt: data?.actualizado_at ?? null };
  } catch (err) {
    console.error('[auto-imagenes] no se pudo leer el contador de Serper:', err?.message);
    return { usados: null, actualizadoAt: null };
  }
}

// No se espera esta llamada (fire-and-forget): incrementar el contador es
// secundario al flujo principal, y varios productos del mismo lote pueden
// llamar a Serper en paralelo — bloquear cada uno por esto sumaría latencia
// sin necesidad, el UPSERT de la RPC ya es atómico así que no hay riesgo de
// perder incrementos por la concurrencia.
function incrementarContadorSerper() {
  incrementarContadorUsoApi('serper')
    .then(({ error }) => {
      if (error) console.error('[auto-imagenes] no se pudo incrementar el contador de Serper:', error.message);
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Resolución por capas: barcode (Open Food/Products Facts) → foto real por
// nombre (Serper). Ya no hay Capa 3 de banco genérico — ver nota v394 al
// principio del archivo.
// ─────────────────────────────────────────────────────────────────────────
async function resolverImagenProducto(producto, incluirBusquedaReal) {
  if (esCodigoBarraValido(producto.codigo)) {
    const porBarcode = await buscarPorOpenFoodFacts(producto.codigo);
    if (porBarcode) return porBarcode;

    const porBarcodeNoAlimento = await buscarPorOpenProductsFacts(producto.codigo);
    if (porBarcodeNoAlimento) return porBarcodeNoAlimento;
  }

  if (!incluirBusquedaReal) return null; // sin barcode y sin opt-in → sin_match, queda el ícono de categoría

  const nombreLimpio = limpiarNombreParaBusqueda(producto.nombre);
  if (!nombreLimpio) return null;

  return await buscarPorImagenReal(nombreLimpio);
}

// EAN-8, EAN-13 o UPC-A (12 dígitos), con dígito verificador correcto.
function esCodigoBarraValido(codigo) {
  if (!codigo) return false;
  const limpio = String(codigo).trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(limpio)) return false;

  const digitos = limpio.split('').map(Number);
  const check = digitos.pop();
  let suma = 0;
  // Para EAN/UPC el patrón de pesos se cuenta desde el dígito verificador
  // hacia la izquierda: 3,1,3,1... (equivalente al estándar GS1).
  digitos.reverse().forEach((d, i) => { suma += d * (i % 2 === 0 ? 3 : 1); });
  const checkCalculado = (10 - (suma % 10)) % 10;
  return checkCalculado === check;
}

// Los nombres de este tipo de catálogo (listas de precio de distribuidoras)
// vienen cargados de códigos de empaque que no aportan nada a una búsqueda
// de imagen y le restan precisión (ej. "CX21", "BL6X12", "FARDO X 12"):
// afinan el resultado en el propio sistema del distribuidor, pero ni Google
// Images ni Pexels los van a encontrar como texto — al contrario, empeoran
// el match porque el motor de búsqueda les da peso como si fueran parte del
// nombre del producto.
function limpiarNombreParaBusqueda(nombre) {
  return String(nombre || '')
    // cantidad/formato: "x 500 ml", "x1 un", "x43 gr"
    .replace(/x\s*\d+(\.\d+)?\s*(un|kg|g|gr|grs|ml|l|lt|cc|cm|mm)\b/gi, '')
    .replace(/-\s*presentaci[oó]n.*$/i, '')
    // packaging/embalaje: "CX21", "FX6", "F12", "C24", "BL6X12", "B20X12"
    .replace(/\b[A-Z]{1,3}\s*\d{1,3}(X\d{1,3})?\b/gi, '')
    // packaging con palabra completa: "FARDO X 12", "FRD X 12", "CAJA X24"
    .replace(/\b(fardo|frd|caja|cja|bulto|blister|bl|display|disp)\s*x?\s*\d+\b/gi, '')
    .replace(/[-–—]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// v397: helper compartido — extrae la mejor URL de imagen disponible de la
// respuesta de OFF/OPF. `image_url` (la imagen "seleccionada" del idioma
// detectado) es el campo más directo, pero en una base colaborativa como
// esta no todos los productos la tienen marcada aunque SÍ tengan fotos
// cargadas: quedan en `image_front_url` (a veces poblado aunque image_url
// no lo esté) o en `selected_images.front.display` (un objeto por idioma —
// ej. "es", "en" — del que alcanza con tomar cualquiera que exista). Se
// prueba en ese orden antes de darse por vencido; no cuesta nada extra
// (mismo request, solo se piden más campos) y puede rescatar productos
// que Serper (pago) tendría que resolver por nombre.
function extraerMejorImagen(product) {
  if (!product) return null;
  if (product.image_url) return product.image_url;
  if (product.image_front_url) return product.image_front_url;

  const porIdioma = product.selected_images?.front?.display;
  if (porIdioma && typeof porIdioma === 'object') {
    const primeraDisponible = Object.values(porIdioma).find(url => typeof url === 'string' && url);
    if (primeraDisponible) return primeraDisponible;
  }

  return null;
}

async function buscarPorOpenFoodFacts(codigo) {
  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(codigo)}`
        + '.json?fields=image_url,image_front_url,selected_images',
      { headers: { 'User-Agent': 'distrib-app - auto-imagenes (contacto: soporte@mfweb.com.ar)' } },
    );
    if (!r.ok) return null;
    const data = await r.json();
    const imageUrl = extraerMejorImagen(data?.product);
    if (!imageUrl) return null;

    const buffer = await descargarYNormalizar(imageUrl);
    if (!buffer) return null;
    return { buffer, fuente: 'openfoodfacts' };
  } catch (err) {
    console.error('[auto-imagenes] Open Food Facts falló:', err?.message);
    return null;
  }
}

async function buscarPorOpenProductsFacts(codigo) {
  try {
    const r = await fetch(
      `https://world.openproductsfacts.org/api/v2/product/${encodeURIComponent(codigo)}`
        + '.json?fields=image_url,image_front_url,selected_images',
      { headers: { 'User-Agent': 'distrib-app - auto-imagenes (contacto: soporte@mfweb.com.ar)' } },
    );
    if (!r.ok) return null;
    const data = await r.json();
    const imageUrl = extraerMejorImagen(data?.product);
    if (!imageUrl) return null;

    const buffer = await descargarYNormalizar(imageUrl);
    if (!buffer) return null;
    return { buffer, fuente: 'openproductsfacts' };
  } catch (err) {
    console.error('[auto-imagenes] Open Products Facts falló:', err?.message);
    return null;
  }
}

// Capa 2 (real, por nombre): búsqueda de imágenes en Google vía Serper.dev.
// A diferencia de un banco de fotos de stock (paisajes, personas, conceptos
// genéricos), esto busca en la web real y trae fotos del producto puntual —
// de sitios de venta, fabricantes, etc. No requiere traducción: nombres de
// marca y modelo funcionan igual en español que en inglés. `gl: 'ar'` y
// `hl: 'es'` priorizan resultados de sitios argentinos/en español, más
// relevantes para este catálogo que resultados genéricos en inglés.
// Requiere SERPER_API_KEY (serper.dev — cuenta nueva, sin la restricción de
// Google Custom Search JSON API, que está cerrada a altas nuevas desde 2025).
//
// v396: la búsqueda general (sin restricción de sitio) devuelve fotos
// "genéricas disfrazadas de reales" con demasiada frecuencia para rubros de
// bazar/limpieza/perfumería — cualquier blog o pinterest con la palabra
// "acondicionador" matchea, pero no es LA foto del producto puntual. Se
// agrega una Etapa 1 restringida a MercadoLibre (`site:mercadolibre.com.ar`)
// antes de la búsqueda general: como estos productos mayoristas casi siempre
// terminan revendidos ahí, la foto de la publicación SÍ es la del producto
// exacto (no una ilustrativa). Si no aparece nada en MercadoLibre, recién
// ahí se cae a la búsqueda general de antes — mejor no tener foto que una
// mal etiquetada como "real" cuando no lo es.
async function buscarPorImagenReal(nombreProducto) {
  if (!process.env.SERPER_API_KEY) return null;

  const porMercadoLibre = await buscarImagenSerper(
    `site:mercadolibre.com.ar ${nombreProducto}`, 'busqueda_web_mercadolibre',
  );
  if (porMercadoLibre) return porMercadoLibre;

  return await buscarImagenSerper(nombreProducto, 'busqueda_web');
}

async function buscarImagenSerper(query, fuente) {
  try {
    const r = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'ar', hl: 'es', num: 10 }),
    });
    // Se cuenta apenas responde el fetch, sin importar si después hay match
    // o no: Serper factura por consulta ejecutada, no por resultado usado.
    // Cada llamada a esta función (etapa 1 o 2) es una consulta separada.
    incrementarContadorSerper();
    if (!r.ok) return null;
    const data = await r.json();
    const items = data?.images || [];

    // De los candidatos, priorizar el más grande — las miniaturas/íconos
    // chicos suelen ser resultados de baja calidad (logos, watermarks).
    // También se descartan bancos de fotos de stock: si se cuelan en los
    // resultados de búsqueda por nombre, son una foto genérica disfrazada
    // de "foto real" — el mismo problema que esta capa existe para evitar.
    // v396: se suma un filtro de proporción — infografías, banners y logos
    // sueltos suelen ser mucho más anchos que altos (o viceversa); una foto
    // de producto real está casi siempre entre cuadrada y 2:3 vertical/horiz.
    const candidato = items
      .filter(it => it?.imageUrl && (it.imageWidth || 0) >= 300)
      .filter(it => !esDominioDeStock(it.domain) && !esDominioDeStock(it.link))
      .filter(it => proporcionRazonable(it.imageWidth, it.imageHeight))
      .sort((a, b) => (b.imageWidth || 0) - (a.imageWidth || 0))[0];
    if (!candidato) return null;

    const buffer = await descargarYNormalizar(candidato.imageUrl);
    if (!buffer) return null;
    return { buffer, fuente };
  } catch (err) {
    console.error(`[auto-imagenes] búsqueda de imagen real falló (query: ${query}):`, err?.message);
    return null;
  }
}

function proporcionRazonable(ancho, alto) {
  if (!ancho || !alto) return true; // sin datos de alto, no se puede evaluar — no descartar por las dudas
  const ratio = ancho / alto;
  return ratio >= 0.4 && ratio <= 2.5;
}

const DOMINIOS_DE_STOCK = [
  'istockphoto.com', 'shutterstock.com', 'gettyimages.com', 'alamy.com',
  'dreamstime.com', 'freepik.com', '123rf.com', 'pexels.com', 'pixabay.com',
  'depositphotos.com', 'adobe.com', 'stock.adobe.com', 'vecteezy.com',
];
function esDominioDeStock(url) {
  if (!url) return false;
  try {
    const host = (url.includes('://') ? new URL(url).hostname : url).replace(/^www\./, '');
    return DOMINIOS_DE_STOCK.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}


// Descarga la imagen y la normaliza a JPEG cuadrado (import dinámico de
// sharp, mismo criterio que importar.js: evitar el import estático a nivel
// de módulo para no arriesgar el arranque de toda la lambda si faltara).
async function descargarYNormalizar(imageUrl) {
  const r = await fetch(imageUrl);
  if (!r.ok) return null;
  const original = Buffer.from(await r.arrayBuffer());

  const { default: sharp } = await import('sharp');
  return await sharp(original)
    .resize(800, 800, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .jpeg({ quality: 82 })
    .toBuffer();
}

async function subirFotoAlBucket(empresaId, productoId, buffer) {
  const nombreArchivo = `${empresaId}/${productoId}.jpg`;

  const { error: errorSubida } = await supabase.storage
    .from('productos-fotos')
    .upload(nombreArchivo, buffer, {
      cacheControl: '3600',
      upsert: true,
      contentType: 'image/jpeg',
    });
  if (errorSubida) throw errorSubida;

  const { data } = supabase.storage.from('productos-fotos').getPublicUrl(nombreArchivo);
  return data?.publicUrl || null;
}
