// lib/handlers/whatsapp-catalog.js
// Rutas (dispatcher único, ver api/index.js — _mod=whatsapp-catalog):
//   GET  /api/whatsapp-catalog?_svc=estado        → estado de conexión + resumen
//   POST /api/whatsapp-catalog?_svc=conectar       → guarda catalog_id + token (Facebook Login for Business)
//   POST /api/whatsapp-catalog?_svc=desconectar    → borra credenciales del catálogo
//   POST /api/whatsapp-catalog?_svc=sincronizar    → corre la sync ahora (botón del panel)
//   GET|POST /api/whatsapp-catalog?_svc=cron       → corre la sync para TODAS las empresas conectadas (Vercel Cron)
//
// Pedido de CLAY (ver 610_whatsapp_catalog_sync.sql para el detalle de
// arquitectura y decisiones de diseño). Mecanismo replicado del que ya
// funciona en el proyecto Trejo (Edge Functions de Supabase), adaptado acá
// a multi-tenant y al patrón handler/repo + Vercel Cron de distrib.
//
// Decisión de diseño clave (repetida acá porque es la que más importa):
// `productos` (con su precio/stock reales, gobernados por el ERP) sigue
// siendo la fuente de verdad. El catálogo de WhatsApp es una vidriera:
//   - Push (distrib → Meta): nombre, descripción, imagen y disponibilidad
//     de cada producto matcheado, y ALTA de los que falten en Meta.
//   - Import (Meta → distrib): productos que existen en el catálogo de
//     Meta pero no en distrib se CREAN acá (categoría "Importado de
//     WhatsApp"), con el precio que traiga Meta como punto de partida.
//   - Nunca se pisa el precio de un producto que YA existe en ambos
//     lados — si el precio de Meta difiere del de distrib se marca
//     'conflicto' en producto_whatsapp_catalog_map para revisión manual,
//     no se aplica solo.

import { db } from '../repos/_db.js';
import { verificarToken } from '../auth-helpers.js';
import { puede } from '../permisos-service.js';
import { errorSeguro } from '../error-response.js';
import { rateLimit } from '../rate-limit.js';
import { cifrar, descifrar } from '../crypto-secrets.js';
import {
  obtenerCredencialesCatalogo,
  guardarCredencialesCatalogo,
  borrarCredencialesCatalogo,
  marcarUltimaSincronizacionCatalogo,
  listarEmpresasConCatalogoConectado,
  listarProductosActivosParaCatalogo,
  obtenerMapaCatalogo,
  upsertMapaCatalogo,
  obtenerResumenCatalogo,
  obtenerOCrearCategoriaImportado,
  crearProductoImportadoDeCatalogo,
} from '../repos/whatsapp-catalog.js';

const META_API_VERSION = 'v22.0'; // mismo criterio que notif.js — alinear con el JS SDK del frontend
const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`;
const PAGE_LIMIT        = 100;
// Diferencia de precio a partir de la cual se marca 'conflicto' en vez de
// 'ok' — un margen chico evita falsos positivos por redondeo de Meta (que
// devuelve el precio como texto "1234.00 ARS").
const TOLERANCIA_PRECIO = 0.01;

// Meta exige un `link` por item ("ver más" del producto). El proyecto
// todavía no tiene una URL pública por producto en el portal de cliente
// (sería lo ideal — pendiente para cuando exista), así que por ahora se
// manda un link genérico a la empresa. TODO: reemplazar por la URL real
// del portal de cliente cuando ese enlace por producto exista.
const LINK_CATALOGO_DEFAULT = process.env.WA_CATALOGO_LINK_DEFAULT || 'https://distrib.app';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function requerirPerfilAdmin(req, res) {
  const perfil = await verificarToken(req, db);
  if (!perfil) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  if (!puede(perfil, 'conectar', 'whatsapp_catalog')) {
    res.status(403).json({ error: 'Solo el dueño o un admin puede gestionar el catálogo de WhatsApp' });
    return null;
  }
  return perfil;
}

const rateLimitApi = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const _svc = req.query._svc;

  // El cron no pasa por rate limit por IP de usuario (no hay usuario) ni
  // por verificarToken — auth propia más abajo (CRON_SECRET).
  if (_svc === 'cron') return handleSyncCron(req, res);

  if (await rateLimitApi(req, res)) return;

  if (req.method === 'GET' && _svc === 'estado') return handleEstado(req, res);
  if (req.method === 'POST' && _svc === 'conectar') return handleConectar(req, res);
  if (req.method === 'POST' && _svc === 'desconectar') return handleDesconectar(req, res);
  if (req.method === 'POST' && _svc === 'sincronizar') return handleSincronizarAhora(req, res);

  return res.status(404).json({ error: 'Ruta no encontrada' });
}

// ── GET ?_svc=estado ──────────────────────────────────────────────────────
async function handleEstado(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  try {
    const { data: creds, error: credsError } = await obtenerCredencialesCatalogo(perfil.empresa_id);
    if (credsError) throw credsError;

    const { data: resumen, error: resumenError } = await obtenerResumenCatalogo(perfil.empresa_id);
    if (resumenError) throw resumenError;

    return res.status(200).json({
      ok: true,
      conectado: !!creds?.catalog_id,
      catalog_id: creds?.catalog_id || null,
      catalog_conectado_en: creds?.catalog_conectado_en || null,
      catalog_ultima_sync_en: creds?.catalog_ultima_sync_en || null,
      resumen,
    });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo cargar el estado del catálogo de WhatsApp.');
  }
}

// ── POST ?_svc=conectar ───────────────────────────────────────────────────
// El frontend hace el login (Facebook Login for Business, permisos
// catalog_management + business_management, sin Embedded Signup de
// mensajería) y manda acá el `code` + el `catalog_id` elegido. Acá se
// canjea el code por un token, se valida contra el catálogo indicado, y
// recién si la validación pasa se guarda cifrado.
async function handleConectar(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  const { code, catalog_id } = req.body || {};
  if (!code || !catalog_id) {
    return res.status(400).json({ error: 'Faltan campos: code y catalog_id son requeridos' });
  }

  const appId     = process.env.WA_APP_ID;
  const appSecret = process.env.WA_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('[whatsapp-catalog] WA_APP_ID/WA_APP_SECRET no configurados');
    return res.status(500).json({ error: 'La conexión con Meta no está configurada en el servidor' });
  }

  try {
    // Paso 1: code → token de acceso
    const tokenUrl = new URL(`${META_BASE_URL}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', appId);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('code', code);
    const tokenResp = await fetch(tokenUrl.toString());
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('[whatsapp-catalog] Error intercambiando code:', tokenData?.error);
      return res.status(502).json({ error: 'No se pudo validar la conexión con Meta. Probá de nuevo el botón de conectar catálogo.' });
    }
    let accessToken = tokenData.access_token;

    // Paso 1bis: canjear por token de larga duración (mismo motivo que
    // whatsappEmbeddedSignupHandler en notif.js — sin esto se corta solo
    // en horas sin aviso).
    try {
      const longLivedUrl = new URL(`${META_BASE_URL}/oauth/access_token`);
      longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
      longLivedUrl.searchParams.set('client_id', appId);
      longLivedUrl.searchParams.set('client_secret', appSecret);
      longLivedUrl.searchParams.set('fb_exchange_token', accessToken);
      const longLivedResp = await fetch(longLivedUrl.toString());
      const longLivedData = await longLivedResp.json();
      if (longLivedResp.ok && longLivedData.access_token) {
        accessToken = longLivedData.access_token;
      } else {
        console.error('[whatsapp-catalog] No se pudo canjear por token de larga duración, se guarda el corto:', longLivedData?.error);
      }
    } catch (err) {
      console.error('[whatsapp-catalog] Error canjeando token de larga duración:', err.message);
    }

    // Paso 2: validar que el token realmente tiene acceso a ESE catalog_id
    // (evita guardar una conexión rota por haber pegado el id equivocado).
    const checkUrl = `${META_BASE_URL}/${catalog_id}?fields=id,name&access_token=${encodeURIComponent(accessToken)}`;
    const checkResp = await fetch(checkUrl);
    const checkData = await checkResp.json();
    if (!checkResp.ok) {
      console.error('[whatsapp-catalog] El token no tiene acceso al catalog_id indicado:', checkData?.error);
      return res.status(400).json({
        error: 'No se pudo acceder a ese catálogo con la cuenta de Meta conectada. Verificá el catalog_id y que la cuenta tenga permiso catalog_management sobre él.',
      });
    }

    const { error: guardarError } = await guardarCredencialesCatalogo(perfil.empresa_id, {
      catalog_id,
      catalog_access_token: cifrar(accessToken),
      catalog_conectado_por: perfil.id,
    });
    if (guardarError) throw guardarError;

    return res.status(200).json({ ok: true, catalog_id, nombre_catalogo: checkData?.name || null });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo conectar el catálogo de WhatsApp.');
  }
}

// ── POST ?_svc=desconectar ────────────────────────────────────────────────
async function handleDesconectar(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  try {
    const { error } = await borrarCredencialesCatalogo(perfil.empresa_id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo desconectar el catálogo de WhatsApp.');
  }
}

// ── POST ?_svc=sincronizar (botón "Sincronizar ahora" del panel) ─────────
async function handleSincronizarAhora(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  try {
    const resultado = await sincronizarCatalogoWhatsapp(perfil.empresa_id);
    if (resultado.error) {
      return res.status(resultado.status || 502).json({ error: resultado.error });
    }
    return res.status(200).json({ ok: true, ...resultado });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo sincronizar el catálogo de WhatsApp.');
  }
}

// ── GET|POST ?_svc=cron (Vercel Cron, mismo criterio que el resto: fail-
//    closed sin CRON_SECRET, header spoofeable x-vercel-cron nunca es el
//    único chequeo de auth — ver handleChequesCron en notif.js) ──────────
async function handleSyncCron(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });

  const authHeader          = req.headers['authorization'] || '';
  const secretQueryFallback = req.headers['x-cron-secret'] || req.body?.secret;

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron no configurado' });
  }
  const secretOk = authHeader === `Bearer ${process.env.CRON_SECRET}` || secretQueryFallback === process.env.CRON_SECRET;
  if (!secretOk) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { data: empresas, error } = await listarEmpresasConCatalogoConectado();
  if (error) return errorSeguro(res, error, 500, 'No se pudo listar las empresas con catálogo conectado.');

  const resultados = [];
  for (const { empresa_id } of empresas) {
    try {
      const r = await sincronizarCatalogoWhatsapp(empresa_id);
      resultados.push({ empresa_id, ...r });
    } catch (err) {
      console.error(`[whatsapp-catalog-cron] Error sincronizando empresa ${empresa_id}:`, err.message);
      resultados.push({ empresa_id, error: err.message });
    }
  }

  return res.status(200).json({ ok: true, empresas_procesadas: resultados.length, resultados });
}

// ═══════════════════════════════════════════════════════════════════════
// ── Motor de sincronización ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * Corre una sincronización completa (push + import) para una empresa.
 * Idempotente — se puede correr las veces que haga falta. Nunca lanza por
 * errores puntuales de un producto/item (van a `errores` del resumen);
 * solo devuelve `{ error }` de nivel handler si falta la conexión o Meta
 * rechaza la request completa (token vencido, catalog_id inválido, etc.).
 */
async function sincronizarCatalogoWhatsapp(empresa_id) {
  const { data: creds, error: credsError } = await obtenerCredencialesCatalogo(empresa_id);
  if (credsError) throw credsError;
  if (!creds?.catalog_id || !creds?.catalog_access_token) {
    return { error: 'Esta empresa no tiene un catálogo de WhatsApp conectado.', status: 400 };
  }

  let accessToken;
  try {
    accessToken = descifrar(creds.catalog_access_token);
  } catch (err) {
    return { error: 'No se pudo descifrar el token del catálogo. Reconectá el catálogo de WhatsApp.', status: 400 };
  }

  const catalogId = creds.catalog_id;

  // ── 1) Estado actual de ambos lados ─────────────────────────────────
  const [{ data: productos, error: productosError }, { data: mapaFilas, error: mapaError }] = await Promise.all([
    listarProductosActivosParaCatalogo(empresa_id),
    obtenerMapaCatalogo(empresa_id),
  ]);
  if (productosError) throw productosError;
  if (mapaError) throw mapaError;

  const mapaPorProducto = new Map(mapaFilas.map((f) => [f.producto_id, f]));

  const metaItems = await listarTodosLosItemsDeMeta(catalogId, accessToken);
  if (metaItems.error) return { error: metaItems.error, status: 502 };
  const metaPorRetailerId = new Map(metaItems.data.map((i) => [i.retailer_id || i.id, i]));

  const ahora = new Date().toISOString();
  const filasParaMapa = [];
  const resumen = { creados_en_meta: 0, actualizados_en_meta: 0, importados: 0, conflictos: 0, errores: 0 };
  const detalleErrores = [];

  // ── 2) PUSH: productos locales → Meta (alta o actualización, nunca precio) ─
  // FORMATO REAL de la Catalog Batch API — confirmado contra la
  // implementación que ya funciona en producción en Trejo
  // (initial-catalog-load/index.ts): un único `method: "UPDATE"` con
  // `allow_upsert: true` a nivel request hace de upsert (crea si el
  // retailer_id no existía, actualiza si ya existía) — NO hay method
  // "CREATE" separado. El id del item va DENTRO de `data.id` (no como
  // `retailer_id` al nivel del request), el nombre es `title` (no
  // `name`) y la imagen es `image_link` (no `image_url`). `link` es el
  // que Meta muestra como "ver más" del producto — placeholder por
  // ahora (LINK_CATALOGO_DEFAULT) hasta que el portal de cliente tenga
  // una URL pública por producto para pasar acá.
  const batchRequests = [];
  for (const producto of productos) {
    const retailerId = String(producto.id);
    const itemMeta = metaPorRetailerId.get(retailerId);
    const filaMapa = mapaPorProducto.get(producto.id);

    if (!itemMeta) {
      // No existe en Meta todavía → alta (upsert). Acá SÍ va el precio
      // (es la creación inicial del item, Meta lo requiere) — de ahí en
      // más el precio queda gobernado por Fluxo y solo se compara, no
      // se pisa.
      batchRequests.push({
        method: 'UPDATE',
        data: {
          id: retailerId,
          title: producto.nombre,
          description: producto.descripcion || '',
          availability: producto.activo ? 'in stock' : 'out of stock',
          condition: 'new',
          price: String(Math.round((producto.precio_base || 0) * 100)), // Meta espera centavos, como string
          currency: 'ARS',
          image_link: producto.foto_url || undefined,
          link: LINK_CATALOGO_DEFAULT,
        },
      });
      filasParaMapa.push({
        producto_id: producto.id, empresa_id, retailer_id: retailerId,
        estado: 'ok', origen: 'push_panel', ultima_sincronizacion: ahora, detalle: null,
      });
      resumen.creados_en_meta += 1;
    } else if (!filaMapa || filaMapa.estado !== 'conflicto') {
      // Ya existe en ambos lados y sin conflicto pendiente → se
      // actualiza título/descripción/imagen/disponibilidad en Meta (con
      // upsert también, es un UPDATE normal porque ya existe), y se
      // compara el precio para detectar conflicto (no se pisa acá —
      // por eso NO se manda `price` en este caso).
      batchRequests.push({
        method: 'UPDATE',
        data: {
          id: retailerId,
          title: producto.nombre,
          description: producto.descripcion || '',
          availability: producto.activo ? 'in stock' : 'out of stock',
          image_link: producto.foto_url || undefined,
        },
      });

      const precioMeta = parseMetaPrice(itemMeta.price);
      const hayConflicto = precioMeta !== null && Math.abs(precioMeta - Number(producto.precio_base || 0)) > TOLERANCIA_PRECIO;

      filasParaMapa.push({
        producto_id: producto.id, empresa_id, retailer_id: retailerId,
        estado: hayConflicto ? 'conflicto' : 'ok',
        origen: filaMapa?.origen || 'push_panel',
        precio_meta: precioMeta,
        precio_meta_raw: itemMeta.price || null,
        detalle: hayConflicto
          ? `El precio en WhatsApp (${itemMeta.price}) no coincide con el precio interno ($${producto.precio_base}). Revisar manualmente.`
          : null,
        ultima_sincronizacion: ahora,
      });
      if (hayConflicto) resumen.conflictos += 1;
      else resumen.actualizados_en_meta += 1;
    }
    // si estado === 'conflicto' ya reportado: se deja en paz (no se pisa
    // título/imagen tampoco) hasta que alguien lo resuelva a mano.
  }

  if (batchRequests.length) {
    const batchResult = await aplicarBatchEnMeta(catalogId, accessToken, batchRequests);
    if (batchResult.error) {
      // Un error de nivel batch (token/catalog inválido) corta todo el
      // push, pero el import (abajo) igual puede servir información útil
      // — no cortamos la función entera.
      console.error('[whatsapp-catalog] Error aplicando batch a Meta:', batchResult.error);
      detalleErrores.push({ etapa: 'push_batch', motivo: batchResult.error });
      resumen.errores += 1;
    }
  }

  // ── 3) IMPORT: items de Meta sin match local → crear producto ────────
  const idsLocales = new Set(productos.map((p) => String(p.id)));
  const itemsSinMatch = metaItems.data.filter((i) => !idsLocales.has(i.retailer_id || i.id));

  if (itemsSinMatch.length) {
    let categoriaImportadoId;
    try {
      categoriaImportadoId = await obtenerOCrearCategoriaImportado(empresa_id);
    } catch (err) {
      detalleErrores.push({ etapa: 'import_categoria', motivo: err.message });
      categoriaImportadoId = null;
    }

    for (const item of itemsSinMatch) {
      const retailerId = item.retailer_id || item.id;
      if (!item.name) {
        detalleErrores.push({ retailer_id: retailerId, motivo: 'item de Meta sin nombre, se omite' });
        resumen.errores += 1;
        continue;
      }
      try {
        const productoId = await crearProductoImportadoDeCatalogo(empresa_id, {
          nombre: item.name,
          descripcion: item.description,
          foto_url: item.image_url,
          precio_base: parseMetaPrice(item.price) ?? 0,
          activo: item.availability ? item.availability === 'in stock' : true,
          categoria_id: categoriaImportadoId,
        });
        filasParaMapa.push({
          producto_id: productoId, empresa_id, retailer_id: retailerId,
          estado: 'ok', origen: 'import_meta', ultima_sincronizacion: ahora, detalle: null,
        });
        resumen.importados += 1;
      } catch (err) {
        detalleErrores.push({ retailer_id: retailerId, motivo: err.message });
        resumen.errores += 1;
      }
    }
  }

  // ── 4) Persistir estado + timestamp ───────────────────────────────────
  const { error: upsertError } = await upsertMapaCatalogo(filasParaMapa);
  if (upsertError) throw upsertError;

  await marcarUltimaSincronizacionCatalogo(empresa_id);

  return { ...resumen, detalle_errores: detalleErrores };
}

// ── Helpers de Graph API ──────────────────────────────────────────────────

/** Lee TODOS los items del catálogo de Meta, paginado. */
async function listarTodosLosItemsDeMeta(catalogId, accessToken) {
  const items = [];
  let url = `${META_BASE_URL}/${catalogId}/products` +
    `?fields=id,retailer_id,name,description,price,image_url,availability` +
    `&limit=${PAGE_LIMIT}&access_token=${encodeURIComponent(accessToken)}`;

  while (url) {
    const resp = await fetch(url);
    const body = await resp.json();
    if (!resp.ok) {
      return { error: body?.error?.message || 'Meta devolvió un error al listar el catálogo', data: [] };
    }
    items.push(...(body.data || []));
    url = body.paging?.next || '';
  }
  return { data: items, error: null };
}

/**
 * Manda un lote de altas/actualizaciones vía Catalog Batch API
 * (POST /{catalog_id}/items_batch). `allow_upsert: true` es lo que hace
 * que un `method: "UPDATE"` sobre un retailer_id que todavía no existe
 * lo cree en vez de fallar — mismo criterio confirmado en la
 * implementación que ya corre en producción en Trejo (no hay method
 * "CREATE" separado en esta API). Se manda en tandas de a 500 requests
 * (bien por debajo del límite de 5000 documentado de Meta).
 */
async function aplicarBatchEnMeta(catalogId, accessToken, requests) {
  const TANDA = 500;
  for (let i = 0; i < requests.length; i += TANDA) {
    const tanda = requests.slice(i, i + TANDA);
    const resp = await fetch(`${META_BASE_URL}/${catalogId}/items_batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allow_upsert: true,
        requests: tanda,
        access_token: accessToken,
      }),
    });
    const body = await resp.json();
    if (!resp.ok) {
      return { error: body?.error?.message || 'Meta rechazó el batch de sincronización' };
    }
  }
  return { error: null };
}

/** Meta devuelve el precio como texto ("1234.00 ARS") al leerlo. */
function parseMetaPrice(raw) {
  if (!raw) return null;
  const match = String(raw).match(/[\d]+([.,]\d+)?/);
  if (!match) return null;
  const num = parseFloat(match[0].replace(',', '.'));
  return isNaN(num) ? null : num;
}
