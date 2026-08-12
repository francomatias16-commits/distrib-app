// lib/handlers/banco-codigos.js — Banco de códigos de barras compartido
// entre TODAS las empresas del SaaS (440).
//
// Complementa Open Food Facts / Open Products Facts / Open Beauty Facts /
// Mercado Libre / Serper.dev como fuente de nombre+foto al escanear un
// código en alta de producto (ver productos-scanner-remoto.js): antes de
// salir a esas APIs externas se consulta primero este banco propio, y cada
// vez que una empresa guarda un producto con código+nombre, ese dato se aporta
// acá para que cualquier otra empresa que escanee el mismo código lo tenga.
//
// GET  /api/banco-codigos?accion=consultar&codigo=<ean>   → { encontrado, nombre, foto_url, fuente }
// POST /api/banco-codigos  { codigo, nombre?, foto_url?, fuente? }  → aportar/confirmar (upsert)
// POST /api/banco-codigos?accion=refrescar  { codigo }  → borrar cache + re-buscar en externos
//
// Tabla sin empresa_id a propósito — ver comentario en la migración 440.
// Lectura: cualquier perfil con permiso 'leer' sobre 'banco_codigos_producto'
// (todos los roles operativos). Escritura: 'dueno', 'admin', 'depositero'
// (mismos roles que pueden dar de alta productos).
//
// FIX (v622, "escaneé un Rexona y no me tomó ni el nombre ni la foto"):
// Movimos las consultas a fuentes externas del navegador al servidor para
// evitar bloqueos CORS. El resultado se guarda en el banco antes de
// responder, así la próxima consulta del mismo código es puro SELECT.
//
// FIX (v623): buscarEnFuentesExternas consultaba OFF → OPF en serie y
// cortaba en el primero que devolviera cualquier cosa (aunque incompleto).
// Ahora usa Promise.all para consultar en paralelo y mergea el mejor
// nombre + imagen del conjunto — más rápido y con cobertura completa.
//
// FIX (v624, "productos de limpieza/higiene siguen sin nombre ni foto"):
// Verificado con el código real del screenshot (7891024136409 — Plax):
//   - Open Food Facts:     status 0 (no encontrado)
//   - Open Products Facts: status 0 (no encontrado)
//   - Open Beauty Facts:   status 1 ← nombre + imagen disponibles
//   - UPCItemDB trial:     0 resultados
//   - Mercado Libre:       0 resultados
//
// La causa raíz es que Open Beauty Facts (cosméticos, higiene bucal,
// cuidado personal, desodorantes, jabones) es una base de datos SEPARADA
// del proyecto Open*Facts — mismo formato de API, distinto dominio
// (world.openbeautyfacts.org). Los productos de higiene personal no
// figuran en OFF ni en OPF, sino en OBF. Se agrega como 4ª fuente
// paralela con la misma función consultarOpenFacts ya existente.
//
// FIX (v625, "otros productos de limpieza/aromas/maquillaje solo leen
// el código, sin nombre ni foto"):
// El problema raíz es que Open*Facts (OFF/OPF/OBF) y Mercado Libre tienen
// cobertura CERO para muchos productos argentinos de estas categorías —
// Axe, Dove Skip, Ala, Blem, Schwarzkopf, Revlon, etc. no figuran en
// ninguna de las cuatro fuentes anteriores.
//
// Solución: Serper.dev como 5ª fuente de fallback, igual que ya usa
// auto-imagenes.js para búsqueda de fotos por nombre. La diferencia es
// que acá el nombre del producto es DESCONOCIDO (solo tenemos el EAN), así
// que la búsqueda en Serper es por número de código de barras directamente
// — Google lo indexa muy bien para productos de supermercado y farmacia.
// Si Serper encuentra una imagen real del producto, también extrae el título
// de la página como nombre (generalmente el nombre completo de la publicación
// en ML/Frávega/etc.). Solo se activa si SERPER_API_KEY está configurada
// en el entorno — sin la key el comportamiento es idéntico a v624.
//
// FIX (v628, "la foto no coincide con el producto salvo en alimentos/bebidas"):
// OFF tiene cobertura excelente para alimentos/bebidas porque es una base
// alimentada específicamente por esa industria durante años. Para limpieza,
// bazar y cuidado personal ARGENTINO no existe un equivalente con cobertura
// comparable — ni OPF/OBF ni Mercado Libre lo resuelven bien. La Fase 1+2 de
// Serper (nombre por texto → imagen por nombre, dos consultas separadas)
// ya ayudaba, pero al desacoplar nombre e imagen podía traer la variante
// equivocada del mismo producto (otro gramaje, otro pack). Se agrega una
// Fase 0: Google Shopping por el código de barras directo — cuando hay
// match, nombre e imagen vienen del MISMO listing del retailer, atado al
// GTIN exacto que buscamos. Ver buscarPorCodigoShopping() más abajo.

import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { db } from '../repos/_db.js';
import { puede } from '../permisos-service.js';
import { incrementarContadorUsoApi } from '../repos/auto-imagenes.js';

const FUENTES_VALIDAS = ['manual', 'openfoodfacts', 'openproductsfacts', 'openbeautyfacts', 'mercadolibre', 'serper', 'serper_shopping'];

function limpiarCodigo(valor) {
  return String(valor || '').trim();
}

const rateLimitApi = rateLimit({ max: 120, windowMs: 60_000 });

// EAN-8, EAN-13 o UPC-A — mismo chequeo que auto-imagenes.js.
function esCodigoBarraValido(codigo) {
  if (!codigo) return false;
  const limpio = String(codigo).trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(limpio)) return false;

  const digitos = limpio.split('').map(Number);
  const check = digitos.pop();
  let suma = 0;
  digitos.reverse().forEach((d, i) => { suma += d * (i % 2 === 0 ? 3 : 1); });
  const checkCalculado = (10 - (suma % 10)) % 10;
  return checkCalculado === check;
}

const TIMEOUT_EXTERNO_MS = 4000;

async function fetchConTimeout(url, opciones = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_EXTERNO_MS);
  try {
    return await fetch(url, { ...opciones, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extraerMejorImagen(product) {
  if (!product) return null;
  if (product.image_url) return product.image_url;
  if (product.image_front_url) return product.image_front_url;
  const porIdioma = product.selected_images?.front?.display;
  if (porIdioma && typeof porIdioma === 'object') {
    const primeraDisponible = Object.values(porIdioma).find(u => typeof u === 'string' && u);
    if (primeraDisponible) return primeraDisponible;
  }
  return null;
}

// Consulta cualquier base del proyecto Open*Facts (misma estructura de API):
//   world.openfoodfacts.org     — alimentos y bebidas
//   world.openproductsfacts.org — productos del hogar, limpieza, bazar
//   world.openbeautyfacts.org   — higiene personal, cosméticos, desodorantes,
//                                 jabones, cuidado bucal (Plax, Colgate, etc.)
async function consultarOpenFacts(base, codigo) {
  try {
    const r = await fetchConTimeout(
      `https://${base}/api/v2/product/${encodeURIComponent(codigo)}`
        + '.json?fields=product_name,generic_name,image_url,image_front_url,selected_images',
      { headers: { 'User-Agent': 'distrib-app - banco-codigos (contacto: soporte@mfweb.com.ar)' } },
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (data?.status !== 1) return null; // 0 = no encontrado en esta base
    const p = data?.product;
    const nombre = p?.product_name?.trim() || p?.generic_name?.trim() || '';
    const imagenUrl = extraerMejorImagen(p);
    if (!nombre && !imagenUrl) return null;
    let fuente = 'openfoodfacts';
    if (base.includes('openproductsfacts')) fuente = 'openproductsfacts';
    if (base.includes('openbeautyfacts'))   fuente = 'openbeautyfacts';
    return { nombre: nombre || null, imagenUrl, fuente };
  } catch (err) {
    console.warn(`[banco-codigos] falló la consulta a ${base}:`, err?.message);
    return null;
  }
}

// Mejor esfuerzo puro — Mercado Libre puede devolver 401/403 en cualquier
// momento, pero server-to-server evita el CORS que bloqueaba desde el browser.
async function consultarMercadoLibre(codigo) {
  try {
    const r = await fetchConTimeout(
      `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(codigo)}`,
    );
    if (!r.ok) return null;
    const data = await r.json();
    const item = data?.results?.[0];
    if (!item?.title) return null;
    return { nombre: item.title, imagenUrl: item.thumbnail || null, fuente: 'mercadolibre' };
  } catch (err) {
    console.warn('[banco-codigos] falló la consulta a Mercado Libre:', err?.message);
    return null;
  }
}

// v625 — Serper.dev como 5ª fuente de fallback para productos no encontrados
// en Open*Facts ni Mercado Libre (limpieza, aromas, maquillaje argentinos).
//
// ESTRATEGIA DE DOS FASES (v625b — "método infalible para imagen correcta"):
//
//   Problema anterior: buscar imagen por código de barras devuelve cualquier
//   página que mencione ese número — el resultado puede ser un producto
//   completamente distinto (e.g. el TALCO VERITAS devolvía una imagen verde
//   de té porque alguna página tenía ese EAN en un contexto diferente).
//
//   Solución: separar la búsqueda de NOMBRE de la búsqueda de IMAGEN.
//
//   Fase 1 — Nombre por código (búsqueda web, no de imágenes):
//     Busca en Google el EAN como texto y extrae el nombre del producto del
//     snippet/título de la primera página relevante. Las páginas de
//     supermercados/ML siempre mencionan el nombre completo en el título.
//     La búsqueda web es más precisa que imágenes para identificar el
//     producto exacto por código.
//
//   Fase 2 — Imagen por nombre (búsqueda de imágenes):
//     Una vez que sabemos el nombre ("TALCO VERITAS ORIGINAL 180G"), buscar
//     la imagen CON ESE NOMBRE. Google Image Search con el nombre exacto del
//     producto en site:mercadolibre.com.ar da la foto oficial del producto
//     casi sin errores — es básicamente la misma búsqueda que haría el
//     usuario si quisiera encontrar la imagen a mano.
//
//   Esta separación elimina el problema de raíz: la imagen siempre está
//   anclada al nombre confirmado del producto, nunca al código solo.
//
// Requiere SERPER_API_KEY en env. Sin key → retorna null silenciosamente.

const DOMINIOS_STOCK = ['istockphoto.com', 'shutterstock.com', 'gettyimages.com', 'alamy.com', 'freepik.com', 'pinterest.com', 'pinterest.com.au'];

// Limpia el título de una página web para obtener el nombre del producto.
function limpiarNombreDesdeWeb(titulo) {
  if (!titulo) return null;
  return titulo
    .replace(/\s*[\-–]\s*MercadoLibre.*$/i, '')   // "Prod X - MercadoLibre Argentina"
    .replace(/\s*[\-–]\s*Walmart.*$/i, '')
    .replace(/\s*[\-–]\s*Carrefour.*$/i, '')
    .replace(/\s*[\-–]\s*Coto.*$/i, '')
    .replace(/\s*[\-–]\s*Farmacity.*$/i, '')
    .replace(/\s*[\-–]\s*La Anonima.*$/i, '')
    .replace(/\s*[\-–]\s*Jumbo.*$/i, '')
    .replace(/\|\s*.*$/, '')                        // "Prod X | Categoría | Tienda"
    .replace(/\s+\d+\s+resultados.*$/i, '')         // basura de buscadores
    .trim();
}

// FASE 1: buscar el NOMBRE del producto a partir del código de barras
// usando resultados de búsqueda web (no de imágenes). Los resultados web
// tienen el nombre en el <title> de la página — mucho más fiable que el
// alt text de una imagen para identificar un producto por EAN.
async function buscarNombrePorCodigoSerper(codigo) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const r = await fetchConTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: `"${codigo}" producto`,
        gl: 'ar',
        hl: 'es',
        num: 5,
      }),
    });
    incrementarContadorUsoApi('serper').catch(() => {});
    if (!r.ok) return null;
    const data = await r.json();

    // Prioridad: Knowledge Graph (Google sabe exactamente qué producto es) >
    // resultados orgánicos de tiendas conocidas > cualquier otro resultado.
    const kg = data?.knowledgeGraph;
    if (kg?.title) return limpiarNombreDesdeWeb(kg.title);

    const TIENDAS = ['mercadolibre', 'carrefour', 'walmart', 'coto', 'farmacity', 'jumbo', 'dia', 'vea', 'disco'];
    const organicos = data?.organic || [];

    // Primer resultado de tienda conocida
    const deTienda = organicos.find(r =>
      TIENDAS.some(t => (r.link || '').toLowerCase().includes(t)),
    );
    if (deTienda?.title) return limpiarNombreDesdeWeb(deTienda.title);

    // Primer resultado con título que parezca nombre de producto (no una nota/blog)
    const primero = organicos.find(r => r.title && r.title.length < 120);
    if (primero?.title) return limpiarNombreDesdeWeb(primero.title);

    return null;
  } catch (err) {
    console.warn(`[banco-codigos] Serper búsqueda web falló (código: ${codigo}):`, err?.message);
    return null;
  }
}

// FASE 2: buscar la IMAGEN del producto por su nombre exacto.
//
// v627 — "Multi-candidata infalible": en lugar de devolver la primera imagen
// encontrada, recolecta TODAS las candidatas de las 3 estrategias en paralelo.
// Devuelve { mejor, candidatas[] } para que el endpoint "refrescar" pueda
// ofrecer alternativas sin volver a consultar a Serper.
//
// Orden de preferencia (dentro de cada estrategia, mayor ancho = mejor):
//   1. Supermercados/farmacias argentinas — fotos verificadas por la cadena.
//   2. Web general sin ML — retailers, fabricante, prensa.
//   3. Mercado Libre — último recurso (vendedores 3P pueden tener fotos erróneas).
//
// urlsRechazadas: URLs que el usuario ya vio y rechazó; se excluyen del
// resultado para que cada "intentar otra" siempre dé algo distinto.

const MAX_CANDIDATAS_POR_QUERY = 5;
const SUPERMERCADOS_AR = 'site:carrefour.com.ar OR site:cotodigital3.com.ar OR site:farmacity.com OR site:jumbo.com.ar OR site:laanonima.com.ar';

// Devuelve hasta MAX_CANDIDATAS_POR_QUERY URLs de imagen que pasen los filtros
// de calidad y no estén en urlsRechazadas.
async function _ejecutarBusquedaImagenSerper(query, urlsRechazadas = []) {
  try {
    const r = await fetchConTimeout('https://google.serper.dev/images', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'ar', hl: 'es', num: 10 }),
    });
    incrementarContadorUsoApi('serper').catch(() => {});
    if (!r.ok) return [];
    const data = await r.json();
    const items = data?.images || [];

    return items
      .filter(it => it?.imageUrl && (it.imageWidth || 0) >= 300)
      .filter(it => !DOMINIOS_STOCK.some(d => (it.domain || '').includes(d)))
      .filter(it => {
        if (!it.imageWidth || !it.imageHeight) return true;
        const ratio = it.imageWidth / it.imageHeight;
        return ratio >= 0.4 && ratio <= 2.5;
      })
      .filter(it => !urlsRechazadas.includes(it.imageUrl))
      .sort((a, b) => (b.imageWidth || 0) - (a.imageWidth || 0))
      .slice(0, MAX_CANDIDATAS_POR_QUERY)
      .map(it => it.imageUrl);
  } catch (err) {
    console.warn(`[banco-codigos] Serper búsqueda de imagen falló (query: "${query}"):`, err?.message);
    return [];
  }
}

// Ejecuta las 3 estrategias EN PARALELO y recolecta todas las candidatas únicas.
// Devuelve { mejor: string|null, candidatas: string[] }
// — "mejor" es la primera URL disponible (supermercados > general > ML),
// — "candidatas" son el resto (para que el frontend cicle sin re-consultar).
async function buscarImagenPorNombreSerper(nombre, urlsRechazadas = []) {
  if (!process.env.SERPER_API_KEY || !nombre) return { mejor: null, candidatas: [] };

  const [deSuper, sinML, deML] = await Promise.all([
    _ejecutarBusquedaImagenSerper(`(${SUPERMERCADOS_AR}) ${nombre}`, urlsRechazadas),
    _ejecutarBusquedaImagenSerper(`${nombre} -site:mercadolibre.com.ar -site:mercadolibre.com`, urlsRechazadas),
    _ejecutarBusquedaImagenSerper(`site:mercadolibre.com.ar ${nombre}`, urlsRechazadas),
  ]);

  // Merge en orden de confiabilidad, deduplicando.
  const vistas = new Set();
  const todas = [];
  for (const url of [...deSuper, ...sinML, ...deML]) {
    if (!vistas.has(url)) { vistas.add(url); todas.push(url); }
  }

  return { mejor: todas[0] || null, candidatas: todas.slice(1) };
}

// FASE 0 (v628): Google Shopping por código de barras (GTIN) vía Serper.
//
// Por qué esto ataca la causa raíz real del problema (no solo un síntoma):
// las Fases 1+2 de abajo hacen una búsqueda de TEXTO por el código para
// sacar el nombre, y LUEGO una búsqueda de IMAGEN por ese nombre — son dos
// consultas independientes que Google resuelve por separado. Nada garantiza
// que la imagen elegida en la Fase 2 sea la del MISMO producto que dio el
// nombre en la Fase 1 — si el nombre queda ambiguo (envases con distintos
// gramajes/variantes, "Talco Veritas" vs "Talco Veritas 180g" vs "...300g"),
// la Fase 2 puede traer la variante equivocada.
//
// Google Shopping, en cambio, indexa productos que los propios retailers
// suben con su GTIN (código de barras) explícito en el feed — el título y
// la imagen que devuelve vienen del MISMO listing, ya atados al código
// exacto que buscamos. Es la fuente más precisa disponible sin pagar un
// servicio de barcode-lookup dedicado (GS1 Argentina, UPCitemdb PRO, etc.).
// Cobertura: mejor en artículos con distribución masiva (higiene, limpieza
// de marca reconocida) — para productos muy regionales/artesanales puede no
// tener nada, y ahí sigue el fallback a Fase 1+2.
async function buscarPorCodigoShopping(codigo, urlsRechazadas = []) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const r = await fetchConTimeout('https://google.serper.dev/shopping', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: codigo, gl: 'ar', hl: 'es', num: 10 }),
    });
    incrementarContadorUsoApi('serper').catch(() => {});
    if (!r.ok) return null;
    const data = await r.json();

    const items = (data?.shopping || [])
      .filter(it => it?.imageUrl && it?.title)
      .filter(it => !urlsRechazadas.includes(it.imageUrl));
    if (items.length === 0) return null;

    const nombre = limpiarNombreDesdeWeb(items[0].title);
    const candidatas = items.slice(1).map(it => it.imageUrl).filter(Boolean);
    return { nombre, imagenUrl: items[0].imageUrl, candidatas, fuente: 'serper_shopping' };
  } catch (err) {
    console.warn(`[banco-codigos] Serper shopping falló (código: ${codigo}):`, err?.message);
    return null;
  }
}

// Orquesta Fase 0 (shopping por GTIN) y, si no da resultado, las Fases 1+2
// (nombre por texto → imagen por nombre) como fallback.
// Solo se invoca cuando las cuatro fuentes gratuitas (OFF/OPF/OBF/ML) no
// devolvieron ni nombre ni imagen.
// urlsRechazadas se pasa a todas las fases para excluir imágenes ya vistas.
async function consultarSerper(codigo, urlsRechazadas = []) {
  if (!process.env.SERPER_API_KEY) return null;

  // Fase 0: intento directo por GTIN — si hay match, es la fuente más
  // confiable porque nombre e imagen vienen del mismo listing.
  const shopping = await buscarPorCodigoShopping(codigo, urlsRechazadas);
  if (shopping?.imagenUrl) return shopping;

  // Fallback: Fases 1+2 (texto → nombre, luego imagen por nombre).
  // Si Shopping encontró nombre pero no imagen utilizable, reusarlo evita
  // una consulta extra a Fase 1.
  const nombre = shopping?.nombre || await buscarNombrePorCodigoSerper(codigo);
  if (!nombre) return null;

  const { mejor, candidatas } = await buscarImagenPorNombreSerper(nombre, urlsRechazadas);
  const candidatasFinal = [...(shopping?.candidatas || []), ...candidatas];

  return { nombre, imagenUrl: mejor || null, candidatas: candidatasFinal, fuente: 'serper' };
}

// Baja la imagen del host externo y la resube al bucket propio, normalizada.
async function rehostearImagen(imagenUrl, codigo) {
  try {
    const r = await fetchConTimeout(imagenUrl);
    if (!r.ok) return null;
    const original = Buffer.from(await r.arrayBuffer());

    const { default: sharp } = await import('sharp');
    const buffer = await sharp(original)
      .resize(600, 600, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 80 })
      .toBuffer();

    const nombreArchivo = `banco-codigos/${codigo}.jpg`;
    const { error: errorSubida } = await db.storage
      .from('productos-fotos')
      .upload(nombreArchivo, buffer, { cacheControl: '86400', upsert: true, contentType: 'image/jpeg' });
    if (errorSubida) throw errorSubida;

    const { data } = db.storage.from('productos-fotos').getPublicUrl(nombreArchivo);
    return data?.publicUrl || null;
  } catch (err) {
    console.warn('[banco-codigos] no se pudo rehostear la imagen:', err?.message);
    return null;
  }
}

// v625 — Cinco fuentes con Serper como último recurso y corrección de imagen.
// v627 — Acepta urlsRechazadas para excluir imágenes ya vistas; devuelve
//         candidatas[] adicionales para ciclar sin re-consultar al servidor.
//
// Cobertura por categoría de producto:
//   OFF  (openfoodfacts.org)    → alimentos, bebidas
//   OPF  (openproductsfacts.org)→ limpieza del hogar, bazar, ferretería
//   OBF  (openbeautyfacts.org)  → higiene personal, cosméticos, desodorantes,
//                                  jabones, pasta dental, enjuague bucal
//   ML   (mercadolibre.com/MLA) → fallback general — productos regionales no
//                                  catalogados en Open*Facts
//   Serper (google.serper.dev)  → fallback final:
//                                  Fase 0: Shopping por código (nombre+imagen
//                                          atados al mismo listing, GTIN exacto)
//                                  Fase 1: nombre via web search (por código)
//                                  Fase 2: imagen via image search (por nombre)
//
// Devuelve: { nombre, imagenUrl, fuente, candidatas: string[] }
// "imagenUrl" es la mejor imagen disponible (no rechazada).
// "candidatas" son URLs alternativas que el frontend puede mostrar sin
// re-consultar al server — vacío cuando no hay alternativas.
async function buscarEnFuentesExternas(codigo, urlsRechazadas = []) {
  const esValido = esCodigoBarraValido(codigo);

  const [off, opf, obf, ml] = await Promise.all([
    esValido ? consultarOpenFacts('world.openfoodfacts.org', codigo)     : Promise.resolve(null),
    esValido ? consultarOpenFacts('world.openproductsfacts.org', codigo) : Promise.resolve(null),
    esValido ? consultarOpenFacts('world.openbeautyfacts.org', codigo)   : Promise.resolve(null),
    consultarMercadoLibre(codigo),
  ]);

  const nombre = off?.nombre || opf?.nombre || obf?.nombre || ml?.nombre || null;
  const fuente = off?.fuente || opf?.fuente || obf?.fuente || ml?.fuente || null;

  // Elegir la primera imagen de las fuentes directas que no esté rechazada.
  const imagenesDirectas = [off?.imagenUrl, opf?.imagenUrl, obf?.imagenUrl, ml?.imagenUrl]
    .filter(u => u && !urlsRechazadas.includes(u));
  let imagenUrl = imagenesDirectas[0] || null;

  // Tenemos nombre pero sin imagen disponible (ML sin foto, OPF sin imagen, etc.):
  // probar primero Shopping por GTIN (más preciso, ancla nombre+imagen al
  // mismo listing) y si no hay match, Serper Fase 2 por nombre.
  if (nombre && !imagenUrl && process.env.SERPER_API_KEY) {
    const shopping = await buscarPorCodigoShopping(codigo, urlsRechazadas);
    if (shopping?.imagenUrl) {
      return { nombre, imagenUrl: shopping.imagenUrl, candidatas: shopping.candidatas, fuente: 'serper_shopping' };
    }
    const { mejor, candidatas } = await buscarImagenPorNombreSerper(nombre, urlsRechazadas);
    return { nombre, imagenUrl: mejor || null, candidatas, fuente: mejor ? 'serper' : fuente };
  }

  if (nombre || imagenUrl) return { nombre, imagenUrl, candidatas: [], fuente };

  // Ninguna fuente gratuita devolvió nada: Serper completo (Fase 1 + Fase 2).
  const serper = await consultarSerper(codigo, urlsRechazadas);
  if (serper && (serper.nombre || serper.imagenUrl)) return serper;

  return null;
}

export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  try {
    // ── GET: consultar un código puntual ──────────────────────────────
    if (req.method === 'GET' && req.query.accion === 'consultar') {
      if (!puede(perfil, 'leer', 'banco_codigos_producto')) {
        return res.status(403).json({ error: 'Sin permiso' });
      }

      const codigo = limpiarCodigo(req.query.codigo);
      if (!codigo) return res.status(400).json({ error: 'codigo es requerido' });

      const { data, error } = await db
        .from('banco_codigos_producto')
        .select('codigo, nombre, foto_url, fuente, veces_confirmado')
        .eq('codigo', codigo)
        .maybeSingle();
      if (error) throw error;

      if (data) {
        return res.json({
          encontrado: true,
          nombre: data.nombre,
          foto_url: data.foto_url,
          fuente: data.fuente,
          veces_confirmado: data.veces_confirmado,
        });
      }

      // No está en el banco propio: buscar en fuentes externas server-side.
      const externo = await buscarEnFuentesExternas(codigo);
      if (!externo) return res.json({ encontrado: false });

      const fotoUrl = externo.imagenUrl ? await rehostearImagen(externo.imagenUrl, codigo) : null;
      if (!externo.nombre && !fotoUrl) return res.json({ encontrado: false });

      const { data: guardado, error: errorUpsert } = await db
        .from('banco_codigos_producto')
        .upsert({
          codigo,
          nombre: externo.nombre || null,
          foto_url: fotoUrl,
          fuente: externo.fuente,
          veces_confirmado: 1,
          aportado_por: perfil.empresa_id,
        }, { onConflict: 'codigo' })
        .select('codigo, nombre, foto_url, fuente, veces_confirmado')
        .single();
      if (errorUpsert) console.warn('[banco-codigos] no se pudo cachear el hallazgo externo:', errorUpsert.message);

      const resultado = guardado || { codigo, nombre: externo.nombre || null, foto_url: fotoUrl, fuente: externo.fuente, veces_confirmado: 1 };
      return res.json({
        encontrado: true,
        nombre: resultado.nombre,
        foto_url: resultado.foto_url,
        fuente: resultado.fuente,
        veces_confirmado: resultado.veces_confirmado,
      });
    }

    // ── POST: aportar/confirmar un código ─────────────────────────────
    if (req.method === 'POST') {
      if (!puede(perfil, 'escribir', 'banco_codigos_producto')) {
        return res.status(403).json({ error: 'Sin permiso' });
      }

      const codigo   = limpiarCodigo(req.body?.codigo);
      const nombre   = req.body?.nombre?.trim() || null;
      const fotoUrl  = req.body?.foto_url?.trim() || null;
      const fuente   = FUENTES_VALIDAS.includes(req.body?.fuente) ? req.body.fuente : 'manual';

      if (!codigo) return res.status(400).json({ error: 'codigo es requerido' });
      if (!nombre && !fotoUrl) {
        return res.status(400).json({ error: 'Se necesita al menos nombre o foto_url para aportar' });
      }

      const { data: existente } = await db
        .from('banco_codigos_producto')
        .select('nombre, foto_url, veces_confirmado')
        .eq('codigo', codigo)
        .maybeSingle();

      const payload = {
        codigo,
        nombre:           nombre || existente?.nombre || null,
        foto_url:         fotoUrl || existente?.foto_url || null,
        fuente,
        veces_confirmado: (existente?.veces_confirmado || 0) + 1,
        aportado_por:     perfil.empresa_id,
      };

      const { data, error } = await db
        .from('banco_codigos_producto')
        .upsert(payload, { onConflict: 'codigo' })
        .select('codigo, nombre, foto_url, fuente, veces_confirmado')
        .single();
      if (error) throw error;

      return res.status(existente ? 200 : 201).json(data);
    }

    // ── POST ?accion=refrescar: limpiar cache + re-buscar ────────────
    // v627 — Acepta urls_rechazadas[] en el body para excluir imágenes ya
    // vistas por el usuario. Devuelve candidatas[] adicionales (raw URLs de
    // Serper, no rehosteadas) para que el frontend pueda ciclar por ellas
    // sin re-consultar al servidor en cada clic.
    //
    // Body: { codigo: string, urls_rechazadas?: string[] }
    // Respuesta: { ok, encontrado, nombre, foto_url, candidatas[], fuente }
    //
    // Requiere permiso de escritura sobre banco_codigos_producto (mismos
    // roles que alta de producto: 'dueno', 'admin', 'depositero').
    if (req.method === 'POST' && req.query.accion === 'refrescar') {
      if (!puede(perfil, 'escribir', 'banco_codigos_producto')) {
        return res.status(403).json({ error: 'Sin permiso' });
      }

      const codigo = limpiarCodigo(req.body?.codigo);
      if (!codigo) return res.status(400).json({ error: 'codigo es requerido' });

      // URLs que el usuario ya vio y rechazó — no devolverlas ni como principal
      // ni como candidata, para que cada "intentar otra" muestre algo distinto.
      const urlsRechazadas = Array.isArray(req.body?.urls_rechazadas)
        ? req.body.urls_rechazadas.filter(u => typeof u === 'string' && u).slice(0, 20)
        : [];

      // Eliminar solo la foto — conservar el nombre si ya era correcto.
      const { data: existente } = await db
        .from('banco_codigos_producto')
        .select('nombre')
        .eq('codigo', codigo)
        .maybeSingle();

      // Limpiar la foto del Storage propio si existe.
      const nombreArchivo = `banco-codigos/${codigo}.jpg`;
      await db.storage.from('productos-fotos').remove([nombreArchivo]).catch(() => {});

      // Actualizar el banco: foto_url = null para forzar re-búsqueda.
      if (existente) {
        await db
          .from('banco_codigos_producto')
          .update({ foto_url: null, fuente: 'manual' })
          .eq('codigo', codigo)
          .catch(() => {});
      }

      // Re-buscar en fuentes externas pasando las URLs rechazadas para que
      // Serper las filtre y devuelva candidatas distintas.
      const externo = await buscarEnFuentesExternas(codigo, urlsRechazadas);
      const nombreFinal = externo?.nombre || existente?.nombre || null;

      // Rehostear solo la imagen principal (la que va al banco y a la DB).
      // Las candidatas se devuelven como raw URLs — el frontend las descarga
      // directamente solo si el usuario sigue clickeando "intentar otra".
      let fotoUrl = null;
      if (externo?.imagenUrl) {
        fotoUrl = await rehostearImagen(externo.imagenUrl, codigo);
      }

      // Si la re-búsqueda encontró algo, actualizar el banco.
      if (nombreFinal || fotoUrl) {
        await db
          .from('banco_codigos_producto')
          .upsert({
            codigo,
            nombre: nombreFinal,
            foto_url: fotoUrl,
            fuente: externo?.fuente || 'manual',
            veces_confirmado: 1,
            aportado_por: perfil.empresa_id,
          }, { onConflict: 'codigo' })
          .catch(() => {});
      }

      // Candidatas: raw URLs de Serper que no sean la principal ni rechazadas.
      const candidatas = (externo?.candidatas || [])
        .filter(u => u && u !== externo?.imagenUrl && !urlsRechazadas.includes(u))
        .slice(0, 8);

      return res.json({
        ok: true,
        encontrado: !!(nombreFinal || fotoUrl),
        nombre: nombreFinal,
        foto_url: fotoUrl,
        candidatas,
        fuente: externo?.fuente || 'manual',
      });
    }

    return res.status(404).json({ error: 'Acción no encontrada' });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo consultar el banco de códigos.');
  }
}
