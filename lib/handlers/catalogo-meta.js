// api/catalogo-meta/index.js
// Rutas (todas bajo /api/catalogo-meta, ver vercel.json + api/index.js):
//   GET    /api/catalogo-meta/estado         → estado de conexión de la empresa
//   POST   /api/catalogo-meta/conectar       → recibe el token del login de Facebook, lo guarda
//   DELETE /api/catalogo-meta/desconectar    → borra las credenciales de la empresa
//   POST   /api/catalogo-meta/carga-inicial  → sube los productos del panel al catálogo de Meta (reconcilia por nombre contra lo que ya exista, ver FIX-DUP-01)
//   POST   /api/catalogo-meta/importar       → espejo completo: trae/actualiza productos DESDE el catálogo de Meta
//
// Adaptado del prototipo de un solo negocio (Distribuciones Trejo —
// README_INTEGRACION_META.md: meta-connect.html + 3 Edge Functions de
// Supabase) al patrón real de este proyecto: handler Node dentro del
// dispatcher único de Vercel (api/index.js), por EMPRESA (no singleton),
// reusando verificarToken/permisos-service/crypto-secrets ya existentes.
//
// Diferencia clave con el prototipo: allá la sincronización panel→Meta se
// disparaba con un Database Webhook de Supabase en cada INSERT/UPDATE de
// `products`. Acá no hace falta un webhook aparte: se expone
// `sincronizarProductoConMeta()` para que lib/handlers/productos.js (o el
// repo que corresponda) la llame directo, en background, después de
// crear/editar un producto — mismo criterio que el resto del proyecto
// (llamadas in-process en vez de infraestructura extra).
//
// Variables de entorno necesarias:
//   WA_APP_ID              (ya existe — misma app "fluxo" que Embedded Signup)
//   WA_APP_SECRET          (ya existe)
//   ARCA_SECRETS_KEY       (ya existe — se reusa para cifrar catalog_access_token)
//
// Configuración de "Facebook Login for Business" (developers.facebook.com,
// app WA_APP_ID, token de tipo "Token de acceso de usuario") pidiendo solo
// catalog_management — business_management no está disponible para este
// tipo de token y tampoco hace falta: el catálogo autorizado se obtiene
// vía /debug_token + granular_scopes (ver getAuthorizedCatalogId), no
// consultando /me directamente. config_id ya generado y pegado en
// frontend/env-config.js (META_CATALOG_LOGIN_CONFIG_ID).

import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import { puede } from '../permisos-service.js';
import {
  obtenerCredencialesCatalogo,
  guardarCredencialesCatalogo,
  borrarCredencialesCatalogo,
  marcarSyncPush,
  marcarSyncPull,
  listarProductosParaCatalogoMeta,
  listarProductosConRetailerId,
  obtenerOCrearCategoriaImportadoWhatsapp,
  crearProductoDesdeMeta,
  actualizarProductoDesdeMeta,
  obtenerProductoParaSync,
  listarEmpresaIdsConCatalogoConectado,
} from '../repos/catalogo-meta.js';

const META_API_VERSION = 'v22.0'; // mismo criterio que notif.js/piloto.js: v19.0 venció el 21/5/2026
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;
const STORAGE_BUCKET = 'productos-fotos'; // mismo bucket que usa el resto del panel (ver 353_foto_producto_upload.sql)
const PAGE_LIMIT = 100;
const BATCH_SIZE = 500; // por debajo del límite de 5000 de Meta

const rateLimitApi = rateLimit({ max: 30, windowMs: 60_000 });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function requerirPerfilAdmin(req, res) {
  const perfil = await verificarToken(req, db);
  if (!perfil) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  // Reusa el mismo recurso que el resto de la config de empresa (logo,
  // datos, catálogo público) — dueño/admin únicamente.
  if (!puede(perfil, 'acceder', 'empresa_config')) {
    res.status(403).json({ error: 'No tenés permiso para esta acción' });
    return null;
  }
  return perfil;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (await rateLimitApi(req, res)) return;

  const _svc = req.query._svc;

  try {
    if (req.method === 'GET' && _svc === 'estado') return await handleEstado(req, res);
    if (req.method === 'POST' && _svc === 'conectar') return await handleConectar(req, res);
    if (req.method === 'DELETE' && _svc === 'desconectar') return await handleDesconectar(req, res);
    if (req.method === 'POST' && _svc === 'carga-inicial') return await handleCargaInicial(req, res);
    if (req.method === 'POST' && _svc === 'importar') return await handleImportarDesdeMeta(req, res);
    if (req.method === 'POST' && _svc === 'sync-producto') return await handleSyncProducto(req, res);
    if (['GET', 'POST'].includes(req.method) && _svc === 'importar-cron') return await handleImportarCron(req, res);
  } catch (err) {
    return errorSeguro(res, err, 500, 'Error al procesar la solicitud de catálogo.');
  }

  return res.status(404).json({ error: 'Ruta no encontrada' });
}

// ── GET /api/catalogo-meta/estado ───────────────────────────────────────

async function handleEstado(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  const { data } = await obtenerCredencialesCatalogo(perfil.empresa_id);

  return res.status(200).json({
    conectado: !!data?.catalog_id,
    connected_at: data?.connected_at || null,
    ultima_sync_push_at: data?.ultima_sync_push_at || null,
    ultima_sync_pull_at: data?.ultima_sync_pull_at || null,
  });
}

// ── POST /api/catalogo-meta/conectar ────────────────────────────────────
// Body: { catalog_token } — el accessToken de corta duración que devuelve
// FB.login en el navegador del dueño/admin (Facebook Login for Business,
// permiso catalog_management). Ver frontend/admin/js/catalogo-meta.js.

async function handleConectar(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  const { catalog_token } = req.body || {};
  if (!catalog_token) {
    return res.status(400).json({ error: 'Falta catalog_token' });
  }

  const catalogLongToken = await exchangeForLongLivedToken(catalog_token);
  const catalogId = await getAuthorizedCatalogId(catalogLongToken);

  if (!catalogId) {
    return res.status(400).json({ error: 'No se encontró ningún catálogo autorizado con esa cuenta de Facebook' });
  }

  const { error } = await guardarCredencialesCatalogo(perfil.empresa_id, {
    catalog_id: catalogId,
    catalog_access_token: catalogLongToken,
  });
  if (error) return errorSeguro(res, error, 500, 'No se pudo guardar la conexión.');

  return res.status(200).json({ ok: true, catalog_id: catalogId });
}

// ── DELETE /api/catalogo-meta/desconectar ───────────────────────────────

async function handleDesconectar(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  const { error } = await borrarCredencialesCatalogo(perfil.empresa_id);
  if (error) return errorSeguro(res, error, 500, 'No se pudo desconectar.');

  return res.status(200).json({ ok: true });
}

// ── POST /api/catalogo-meta/carga-inicial ───────────────────────────────
// Sube TODOS los productos del panel al catálogo de Meta. Pensado para
// correrse UNA vez, después de conectar, y antes de depender de la sync
// automática. A propósito NO borra productos que la empresa ya tenía
// cargados a mano en su catálogo de WhatsApp.
//
// FIX-DUP-01: antes de subir nada, se reconcilia por nombre contra el
// catálogo que la empresa YA tiene en Meta (ver emparejarPorNombre) — sin
// esto, una empresa que ya usaba WhatsApp Business con su propio catálogo
// terminaba con cada producto del panel duplicado como ítem nuevo en
// Meta, en vez de actualizar el que ya tenía. Un match por nombre se
// vincula (persiste el retailer_id real) y a partir de ahí el request de
// arriba lo trata como una actualización, no una creación — por eso deja
// de exigirle foto (Meta solo la exige para crear ítems nuevos).
async function handleCargaInicial(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  const { data: cred } = await obtenerCredencialesCatalogo(perfil.empresa_id);
  if (!cred?.catalog_id) {
    return res.status(404).json({ error: 'Todavía no conectaste ningún catálogo de Meta.' });
  }

  const { data: productos, error } = await listarProductosParaCatalogoMeta(perfil.empresa_id);
  if (error) return errorSeguro(res, error, 500, 'No se pudieron leer los productos.');
  if (!productos.length) {
    return res.status(400).json({ error: 'No hay productos cargados en el panel.' });
  }

  const siteUrl = process.env.CATALOGO_META_SITE_URL || null; // opcional: link de "ver más" por producto

  // Reconciliación por nombre contra lo que la empresa ya tenía en Meta
  // antes de conectar (FIX-DUP-01). Si falla la consulta a Meta, seguimos
  // sin reconciliar en vez de bloquear la carga inicial entera por esto
  // — mismo criterio de "fail soft" que el resto de las dependencias
  // externas del proyecto.
  const vinculados = [];
  let avisos = [];
  try {
    const metaItemsExistentes = await listarItemsCatalogoMeta(cred);
    const retailerIdsYaUsados = new Set(productos.map(p => p.retailer_id));
    const itemsSinMatchPorId = metaItemsExistentes.filter(item => !retailerIdsYaUsados.has(item.retailer_id || item.id));
    const productosSinVincular = productos.filter(p => p.retailer_id === p.id);
    const { matches, ambiguos } = emparejarPorNombre(productosSinVincular, itemsSinMatchPorId);

    avisos = ambiguos.map(a => ({
      nombre: a.nombre,
      motivo: `hay ${a.candidatos_panel} producto(s) en el panel y ${a.candidatos_whatsapp} ítem(s) en WhatsApp con este nombre — no se vinculó automáticamente, revisar manualmente.`,
    }));

    for (const { producto, metaItem } of matches) {
      const retailerIdReal = metaItem.retailer_id || metaItem.id;
      const { error: linkError } = await actualizarProductoDesdeMeta(producto.id, { retailer_id: retailerIdReal });
      if (linkError) {
        avisos.push({ nombre: producto.nombre, motivo: 'se encontró como ya existente en WhatsApp pero no se pudo vincular: ' + String(linkError) });
        continue;
      }
      producto.retailer_id = retailerIdReal; // refleja el link en memoria para el loop de abajo
      vinculados.push({ id: producto.id, nombre: producto.nombre, retailer_id: retailerIdReal });
    }
  } catch (err) {
    console.error('[catalogo-meta] no se pudo reconciliar por nombre antes de la carga inicial, se sigue sin reconciliar:', err?.message || err);
  }

  const requests = [];
  const omitidos = [];

  for (const p of productos) {
    if (!p.retailer_id) {
      omitidos.push({ id: p.id, nombre: p.nombre, motivo: 'sin retailer_id' });
      continue;
    }
    // Si ya está vinculado a un ítem real de Meta (por una sync previa o
    // por la reconciliación de arriba), no hace falta foto local — Meta
    // solo la exige para CREAR un ítem nuevo, no para actualizar uno que
    // ya existe con su propia imagen.
    const yaExisteEnMeta = p.retailer_id !== p.id;
    if (!yaExisteEnMeta && !p.foto_url) {
      omitidos.push({ id: p.id, nombre: p.nombre, motivo: 'sin foto (Meta exige imagen para crear un ítem nuevo)' });
      continue;
    }
    requests.push({
      method: 'UPDATE',
      data: {
        id: p.retailer_id,
        allow_upsert: yaExisteEnMeta || !!p.foto_url,
        name: p.nombre,
        description: p.descripcion || p.nombre,
        ...(p.foto_url ? { image_url: p.foto_url } : {}),
        price: `${Math.round(Number(p.precio_base || 0) * 100)}`,
        currency: 'ARS',
        availability: p.activo === false ? 'out of stock' : 'in stock',
        condition: 'new',
        ...(siteUrl ? { url: siteUrl } : {}),
        retailer_id: p.retailer_id,
      },
    });
  }

  if (!requests.length) {
    return res.status(400).json({ error: 'Ningún producto tiene los datos mínimos (foto + retailer_id) para subir a Meta.', omitidos });
  }

  const resultadosPorLote = [];
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const lote = requests.slice(i, i + BATCH_SIZE);
    const resp = await fetch(`${META_BASE_URL}/${cred.catalog_id}/items_batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: cred.catalog_access_token, requests: lote }),
    });
    const body = await resp.json();
    resultadosPorLote.push({ enviados: lote.length, ok: resp.ok, respuesta: body });
    if (!resp.ok) {
      return res.status(502).json({ error: 'Meta devolvió un error al subir el lote de productos', detalle: body, resultadosPorLote, omitidos, vinculados, avisos });
    }
  }

  await marcarSyncPush(perfil.empresa_id);

  return res.status(200).json({
    ok: true,
    total_productos: productos.length,
    enviados: requests.length,
    vinculados,
    avisos,
    omitidos,
    resultadosPorLote,
  });
}

// ── POST /api/catalogo-meta/sync-producto ───────────────────────────────
// Sync puntual de UN producto hacia el catálogo de Meta — v1068. Se llama
// desde frontend/admin/js/productos.js → guardarProducto(), justo después
// de crear/editar un producto, sin esperar la respuesta (fire-and-forget)
// para no bloquear el guardado si Meta está lento o caído. Silenciosa si
// la empresa no tiene catálogo conectado (caso normal de la mayoría) —
// ver sincronizarProductoConMeta() más abajo. Abierta a los mismos roles
// que pueden dar de alta/editar productos (no solo dueño/admin, a
// diferencia del resto de las rutas de este archivo que configuran la
// integración en sí).
async function handleSyncProducto(req, res) {
  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });
  if (!puede(perfil, 'disparar', 'catalogo_meta_sync')) {
    return res.status(403).json({ error: 'No tenés permiso para esta acción' });
  }

  const { producto_id } = req.body || {};
  if (!producto_id) return res.status(400).json({ error: 'Falta producto_id' });

  const { data: producto } = await obtenerProductoParaSync(perfil.empresa_id, producto_id);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });

  // A propósito: nunca un 500 acá. El producto ya se guardó bien en el
  // panel — un fallo de Meta no es un error del usuario. Se loguea para
  // diagnosticar y se responde 200 igual, con el resultado en el body.
  try {
    const resultado = await sincronizarProductoConMeta(perfil.empresa_id, producto);
    if (resultado === 'ok') await marcarSyncPush(perfil.empresa_id);
    return res.status(200).json({ ok: true, resultado });
  } catch (err) {
    console.error('[catalogo-meta] sync puntual falló para producto', producto_id, err?.message);
    return res.status(200).json({ ok: false, resultado: 'error' });
  }
}

// ── Reconciliación por nombre (FIX-DUP-01) ──────────────────────────────
//
// Problema real: tanto el push (carga-inicial) como el pull (importar)
// usaban SOLO retailer_id para decidir si un producto/ítem ya existía del
// otro lado. Eso funciona perfecto una vez que todo pasó por acá al menos
// una vez (retailer_id queda vinculado), pero para una empresa que se
// conecta por primera vez y YA tenía productos cargados de antes en
// ambos lados (su catálogo de WhatsApp Y su panel, sin relación entre
// sí) generaba duplicados en los dos sentidos: el pull creaba un producto
// nuevo en el panel para cada ítem de Meta que no matcheaba por
// retailer_id, y el push mandaba cada producto del panel como ítem nuevo
// a Meta (con su propio uuid como retailer_id, que Meta obviamente nunca
// había visto). Fix: antes de tratar algo como "no existe del otro
// lado", se intenta un matching por nombre (normalizado, sin tildes, case
// insensitive) contra lo que quedó sin matchear por retailer_id — pero
// SOLO entre productos que todavía están en su retailer_id por default
// (retailer_id === id, es decir: nunca se vincularon explícitamente a un
// ítem externo todavía). Un match 1-a-1 sin ambigüedad se vincula solo
// (persiste el retailer_id real en el producto); si hay más de un
// candidato de cualquier lado con el mismo nombre, se deja sin vincular
// automáticamente y se reporta como aviso — mejor pedir una revisión
// manual que adivinar mal y pisar el producto equivocado.

export function normalizarNombreProducto(nombre) {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // sin tildes/diacríticos
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Empareja productos del panel que todavía están sin vincular a un ítem
 * externo (retailer_id === su propio id) contra ítems de Meta que no
 * matchearon por retailer_id, usando el nombre normalizado como único
 * criterio. Devuelve solo matches 1-a-1 sin ambigüedad; cualquier nombre
 * con más de un candidato de cualquier lado queda afuera (ver `ambiguos`)
 * en vez de vincularse a ciegas.
 */
export function emparejarPorNombre(productosSinVincular, metaItemsSinMatch) {
  const productosPorNombre = new Map();
  for (const p of productosSinVincular) {
    const clave = normalizarNombreProducto(p.nombre);
    if (!clave) continue;
    if (!productosPorNombre.has(clave)) productosPorNombre.set(clave, []);
    productosPorNombre.get(clave).push(p);
  }

  const itemsPorNombre = new Map();
  for (const item of metaItemsSinMatch) {
    const clave = normalizarNombreProducto(item.name);
    if (!clave) continue;
    if (!itemsPorNombre.has(clave)) itemsPorNombre.set(clave, []);
    itemsPorNombre.get(clave).push(item);
  }

  const matches = [];
  const ambiguos = [];

  for (const [clave, productosDelNombre] of productosPorNombre) {
    const itemsDelNombre = itemsPorNombre.get(clave);
    if (!itemsDelNombre || itemsDelNombre.length === 0) continue;

    if (productosDelNombre.length === 1 && itemsDelNombre.length === 1) {
      matches.push({ producto: productosDelNombre[0], metaItem: itemsDelNombre[0] });
    } else {
      ambiguos.push({
        nombre: productosDelNombre[0].nombre,
        candidatos_panel: productosDelNombre.length,
        candidatos_whatsapp: itemsDelNombre.length,
      });
    }
  }

  return { matches, ambiguos };
}

/**
 * Trae TODO el catálogo de una empresa en Meta, paginado. Extraído de
 * importarCatalogoDeEmpresa para poder reusarlo también desde
 * handleCargaInicial (reconciliación por nombre antes de subir). Tira
 * con `.detalleMeta` colgado del Error si Meta devuelve error al listar
 * — mismo contrato que antes.
 */
async function listarItemsCatalogoMeta(cred) {
  const metaItems = [];
  let url =
    `${META_BASE_URL}/${cred.catalog_id}/products` +
    `?fields=id,retailer_id,name,description,price,image_url,availability` +
    `&limit=${PAGE_LIMIT}&access_token=${encodeURIComponent(cred.catalog_access_token)}`;

  while (url) {
    const resp = await fetch(url);
    const body = await resp.json();
    if (!resp.ok) {
      const err = new Error('Meta devolvió un error al listar el catálogo');
      err.detalleMeta = body;
      throw err;
    }
    metaItems.push(...(body.data || []));
    url = body.paging?.next || '';
  }

  return metaItems;
}

// ── Núcleo del espejo Meta → panel, compartido entre el botón manual
// (handleImportarDesdeMeta) y el cron periódico (handleImportarCron,
// v1068) ────────────────────────────────────────────────────────────────
// Trae TODO el catálogo de la empresa en WhatsApp (paginado) y, por cada
// retailer_id: crea el producto si no existe (descargando la imagen a
// productos-fotos) o actualiza nombre/precio/descripción/disponibilidad/
// imagen si ya existe. No toca categoria/orden salvo para asignar
// "Importado de WhatsApp" a los nuevos. Idempotente: se puede correr las
// veces que haga falta. `cred` ya viene con el token descifrado (ver
// obtenerCredencialesCatalogo). Tira si Meta devuelve error al listar el
// catálogo (con `.detalleMeta` colgado del Error) — el caller decide qué
// hacer con eso.
//
// FIX-DUP-01: antes de crear un producto nuevo para un ítem de Meta que
// no matcheó por retailer_id, se intenta reconciliar por nombre contra
// productos del panel que todavía están sin vincular — evita duplicar
// en el panel algo que la empresa ya tenía cargado de las dos formas
// antes de conectar. Ver emparejarPorNombre() más arriba.
async function importarCatalogoDeEmpresa(empresa_id, cred) {
  const { data: existentes } = await listarProductosConRetailerId(empresa_id);
  const existentesPorRetailerId = new Map();
  for (const p of existentes) {
    if (p.retailer_id) existentesPorRetailerId.set(p.retailer_id, p);
  }

  const metaItems = await listarItemsCatalogoMeta(cred);

  // Reconciliación por nombre (FIX-DUP-01): solo entre lo que quedó sin
  // matchear por retailer_id de los dos lados.
  const itemsSinMatchPorId = metaItems.filter(item => !existentesPorRetailerId.has(item.retailer_id || item.id));
  const productosSinVincular = existentes.filter(p => p.retailer_id === p.id);
  const { matches, ambiguos } = emparejarPorNombre(productosSinVincular, itemsSinMatchPorId);

  const vinculacionesPorRetailerIdMeta = new Map();
  for (const { producto, metaItem } of matches) {
    vinculacionesPorRetailerIdMeta.set(metaItem.retailer_id || metaItem.id, producto);
  }

  let categoriaImportadoId = null;
  const importados = [];
  const actualizados = [];
  const vinculados = [];
  const avisos = ambiguos.map(a => ({
    retailer_id: null,
    nombre: a.nombre,
    motivo: `hay ${a.candidatos_panel} producto(s) en el panel y ${a.candidatos_whatsapp} ítem(s) en WhatsApp con este nombre — no se vinculó automáticamente, revisar manualmente.`,
  }));
  const errores = [];

  for (const item of metaItems) {
    const retailerId = item.retailer_id || item.id;
    if (!retailerId) continue;

    const existente = existentesPorRetailerId.get(retailerId);
    const vinculacionPorNombre = !existente ? vinculacionesPorRetailerIdMeta.get(retailerId) : null;

    try {
      if (!item.name) {
        errores.push({ retailer_id: retailerId, motivo: 'sin nombre en el catálogo de Meta' });
        continue;
      }

      if (!existente && !vinculacionPorNombre) {
        if (!categoriaImportadoId) {
          categoriaImportadoId = await obtenerOCrearCategoriaImportadoWhatsapp(empresa_id);
        }

        let fotoUrl = null;
        if (item.image_url) {
          try {
            fotoUrl = await mirrorImageToStorage(empresa_id, retailerId, item.image_url);
          } catch (imgErr) {
            avisos.push({ retailer_id: retailerId, nombre: item.name, motivo: 'producto creado pero falló la descarga de imagen: ' + String(imgErr) });
          }
        }

        const { error: insertError } = await crearProductoDesdeMeta(empresa_id, categoriaImportadoId, {
          retailer_id: retailerId,
          nombre: item.name,
          descripcion: item.description || '',
          precio_base: parseMetaPrice(item.price) ?? 0,
          foto_url: fotoUrl,
          activo: item.availability ? item.availability === 'in stock' : true,
        });
        if (insertError) throw insertError;
        importados.push({ retailer_id: retailerId, nombre: item.name });
      } else {
        // Mismo bloque de actualización sirve para el caso normal
        // (`existente`, matcheó por retailer_id) y para el caso recién
        // vinculado por nombre (`vinculacionPorNombre`) — la única
        // diferencia es que este último también necesita persistir el
        // retailer_id real de Meta en el producto del panel.
        const productoDestino = existente || vinculacionPorNombre;
        const campos = {
          nombre: item.name,
          activo: item.availability ? item.availability === 'in stock' : true,
        };
        if (vinculacionPorNombre) campos.retailer_id = retailerId;
        if (item.description !== undefined) campos.descripcion = item.description;

        const precio = parseMetaPrice(item.price);
        if (precio !== null) {
          campos.precio_base = precio;
        } else if (item.price) {
          avisos.push({ retailer_id: retailerId, nombre: item.name, motivo: `no se pudo interpretar el precio de Meta ("${item.price}"), se conservó el precio del panel` });
        }

        if (item.image_url) {
          try {
            campos.foto_url = await mirrorImageToStorage(empresa_id, retailerId, item.image_url);
          } catch (imgErr) {
            avisos.push({ retailer_id: retailerId, nombre: item.name, motivo: 'falló la descarga de la imagen nueva, se conservó la anterior: ' + String(imgErr) });
          }
        }

        const { error: updateError } = await actualizarProductoDesdeMeta(productoDestino.id, campos);
        if (updateError) throw updateError;

        if (vinculacionPorNombre) {
          vinculados.push({ retailer_id: retailerId, nombre: item.name });
        } else {
          actualizados.push({ retailer_id: retailerId, nombre: item.name });
        }
      }
    } catch (err) {
      errores.push({ retailer_id: retailerId, nombre: item.name, motivo: String(err) });
    }
  }

  await marcarSyncPull(empresa_id);

  return { total_en_whatsapp: metaItems.length, importados, actualizados, vinculados, avisos, errores };
}

// ── POST /api/catalogo-meta/importar ────────────────────────────────────
// Botón manual — un solo disparo para la empresa del usuario logueado.
// Ver importarCatalogoDeEmpresa() para el núcleo real.

async function handleImportarDesdeMeta(req, res) {
  const perfil = await requerirPerfilAdmin(req, res);
  if (!perfil) return;

  const { data: cred } = await obtenerCredencialesCatalogo(perfil.empresa_id);
  if (!cred?.catalog_id) {
    return res.status(404).json({ error: 'Todavía no conectaste ningún catálogo de Meta.' });
  }

  let r;
  try {
    r = await importarCatalogoDeEmpresa(perfil.empresa_id, cred);
  } catch (err) {
    if (err.detalleMeta) return res.status(502).json({ error: err.message, detalle: err.detalleMeta });
    return errorSeguro(res, err, 500, 'No se pudo importar el catálogo.');
  }

  return res.status(200).json({
    ok: true,
    total_en_whatsapp: r.total_en_whatsapp,
    importados: r.importados.length,
    actualizados: r.actualizados.length,
    vinculados: r.vinculados.length,
    con_avisos: r.avisos.length,
    con_errores: r.errores.length,
    detalle_importados: r.importados,
    detalle_actualizados: r.actualizados,
    detalle_vinculados: r.vinculados,
    detalle_avisos: r.avisos,
    detalle_errores: r.errores,
  });
}

// ── GET/POST /api/catalogo-meta/importar-cron ───────────────────────────
// Corrida periódica del espejo Meta → panel — v1068. Sin esto, los
// cambios hechos directo en el catálogo de WhatsApp (fuera del panel)
// solo se reflejaban corriendo el botón "Importar" a mano. Mismo patrón
// de auth que el resto de los crons de notif.js (Authorization: Bearer
// $CRON_SECRET que Vercel adjunta solo; fail-closed si no está
// configurada). Corre para TODAS las empresas con catálogo conectado —
// un error en una empresa no corta el resto, queda registrado en
// `detalle` y se sigue con la próxima.
async function handleImportarCron(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });

  const authHeader = req.headers['authorization'] || '';
  const secretQueryFallback = req.headers['x-cron-secret'] || req.body?.secret; // compat: testing manual
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron no configurado' });
  }
  const secretOk = authHeader === `Bearer ${process.env.CRON_SECRET}` || secretQueryFallback === process.env.CRON_SECRET;
  if (!secretOk) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { data: empresaIds } = await listarEmpresaIdsConCatalogoConectado();
  const resultados = { procesadas: 0, con_cambios: 0, con_errores: 0, detalle: [] };

  for (const empresaId of empresaIds) {
    resultados.procesadas++;
    try {
      const { data: cred } = await obtenerCredencialesCatalogo(empresaId);
      if (!cred?.catalog_id) continue; // se desconectó justo entre el listado y acá

      const r = await importarCatalogoDeEmpresa(empresaId, cred);
      if (r.importados.length > 0 || r.actualizados.length > 0 || r.vinculados.length > 0) resultados.con_cambios++;
      resultados.detalle.push({
        empresa_id: empresaId,
        importados: r.importados.length,
        actualizados: r.actualizados.length,
        vinculados: r.vinculados.length,
        con_avisos: r.avisos.length,
        con_errores: r.errores.length,
      });
    } catch (err) {
      resultados.con_errores++;
      resultados.detalle.push({ empresa_id: empresaId, error: err.message || String(err) });
      console.error('[catalogo-meta] importar-cron falló para empresa', empresaId, err);
    }
  }

  return res.status(200).json({ ok: true, ...resultados });
}

// ── Sync puntual panel → Meta (para llamar in-process desde productos.js) ─
//
// Se llama, en background (sin await bloqueante, con .catch(() => {})
// desde el caller) después de crear/editar un producto, para no depender
// de un Database Webhook aparte. Silenciosa si la empresa no tiene
// catálogo conectado — no es un error, es el caso normal de la mayoría.

export async function sincronizarProductoConMeta(empresa_id, producto) {
  const { data: cred } = await obtenerCredencialesCatalogo(empresa_id);
  if (!cred?.catalog_id || !producto?.retailer_id) return 'omitido';

  // Si el producto ya está vinculado a un ítem real de Meta (retailer_id
  // distinto de su propio id — por una sync previa o por la
  // reconciliación por nombre de la carga inicial), alcanza con
  // actualizarlo aunque no tenga foto local: Meta ya tiene una imagen
  // para ese ítem. Solo para CREAR un ítem nuevo hace falta foto.
  const yaExisteEnMeta = producto.retailer_id !== producto.id;

  const body = {
    access_token: cred.catalog_access_token,
    requests: [
      {
        method: 'UPDATE',
        data: {
          id: producto.retailer_id,
          allow_upsert: yaExisteEnMeta || !!producto.foto_url,
          price: `${Math.round(Number(producto.precio_base || 0) * 100)}`,
          currency: 'ARS',
          availability: producto.activo === false ? 'out of stock' : 'in stock',
          ...(producto.nombre ? { name: producto.nombre } : {}),
          ...(producto.foto_url ? { image_url: producto.foto_url } : {}),
        },
      },
    ],
  };

  const resp = await fetch(`${META_BASE_URL}/${cred.catalog_id}/items_batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.error('[catalogo-meta] Meta devolvió error al sincronizar producto', producto.id, await resp.text());
    return 'error';
  }
  return 'ok';
}

// ============================================================
// Helpers
// ============================================================

async function exchangeForLongLivedToken(shortToken) {
  const url = new URL(`${META_BASE_URL}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', process.env.WA_APP_ID);
  url.searchParams.set('client_secret', process.env.WA_APP_SECRET);
  url.searchParams.set('fb_exchange_token', shortToken);

  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) throw new Error(`Error extendiendo token: ${JSON.stringify(data)}`);
  return data.access_token;
}

// `/me/owned_product_catalogs` no existe como edge del nodo User (ese edge
// es de Business, ver developers.facebook.com/.../business/owned_product_catalogs)
// — de ahí el error "(#100) Tried accessing nonexisting field". Como este
// token sólo tiene el permiso granular `catalog_management` (sin
// business_management no podemos resolver el business_id para usar ese
// edge), la forma correcta de obtener el catálogo autorizado es vía
// `/debug_token`: el campo `granular_scopes` trae, para cada permiso
// granular concedido en el popup, los `target_ids` de los recursos
// puntuales que el usuario autorizó (acá, el/los catalog_id). Mismo patrón
// que usa Meta para WhatsApp Embedded Signup con whatsapp_business_management.
async function getAuthorizedCatalogId(token) {
  const appToken = `${process.env.WA_APP_ID}|${process.env.WA_APP_SECRET}`;
  const url = `${META_BASE_URL}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(`Error consultando catálogo: ${JSON.stringify(data)}`);

  const granularScopes = data?.data?.granular_scopes || [];
  const catalogScope = granularScopes.find((s) => s.scope === 'catalog_management');
  return catalogScope?.target_ids?.[0] ?? null;
}

// Meta devuelve el precio como texto ("1234.00 ARS") al leerlo.
function parseMetaPrice(raw) {
  if (!raw) return null;
  const cleanMatch = String(raw).match(/[\d]+([.,]\d+)?/);
  if (!cleanMatch) return null;
  const num = parseFloat(cleanMatch[0].replace(',', '.'));
  return isNaN(num) ? null : num;
}

async function mirrorImageToStorage(empresa_id, retailerId, metaImageUrl) {
  const imgRes = await fetch(metaImageUrl);
  if (!imgRes.ok) throw new Error(`no se pudo descargar la imagen (HTTP ${imgRes.status})`);

  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const bytes = Buffer.from(await imgRes.arrayBuffer());

  // Mismo patrón de path que auto-imagenes.js (`${empresaId}/...`), con
  // sufijo -whatsapp para no chocar con la foto que ya pudiera tener el
  // producto por otra vía (auto-imagenes, subida manual).
  const path = `${empresa_id}/${retailerId}-whatsapp-${Date.now()}.${ext}`;

  const { error: uploadError } = await db.storage
    .from(STORAGE_BUCKET)
    .upload(path, bytes, { contentType, upsert: false, cacheControl: '3600' });
  if (uploadError) throw new Error(uploadError.message);

  const { data } = db.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}
