// api/empresa/index.js
// Rutas:
//   POST /api/empresa/logo             → sube logo al bucket 'logos' de Supabase Storage
//   GET  /api/empresa/icon             → redirect al logo de la empresa (o fallback estático)
//   GET  /api/empresa/datos            → datos editables de la empresa (nombre, cuit, domicilio, telefono, email)
//   PUT  /api/empresa/datos            → actualiza datos editables de la empresa
//   PUT  /api/empresa/catalogo-publico → toggle de config.catalogo_publico_habilitado
//   PUT  /api/empresa/slug             → edita el slug legible del link de catálogo (501)
//   GET  /api/empresa/catalogo-qr      → PNG con el QR del link de catálogo público (954)
//   GET  /api/empresa/catalogo-visitas → resumen de visitas por canal de origen (605)
//
// D4 (Fase 7): migrado a lib/repos/empresas.js — sin instanciación directa de
// Supabase. Antes este handler creaba `createClient()` y reresolvía
// perfil/rol a mano (usuarios.select('empresa_id, rol')) en 4 endpoints
// distintos, sin el filtro `activo` que sí aplica `verificarToken` en el
// resto del sistema desde la Etapa 11 de AUDITORIA_2026 — un usuario
// desactivado con JWT de Supabase aún vigente podía seguir usando estos 4
// endpoints. Ahora usa el mismo `verificarToken(req, db)` que ya usan los
// otros ~16 handlers, cerrando esa inconsistencia.
//
// MF Web Solutions | distrib-app

import bwipjs from 'bwip-js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import {
  obtenerLogoUrl,
  actualizarLogoUrl,
  obtenerDatosEditables,
  actualizarDatosEmpresa,
  obtenerConfig,
  actualizarConfig,
  actualizarSlug,
} from '../repos/empresas.js';
import { obtenerResumenVisitasCatalogo } from '../repos/catalogo-visitas.js';
import { puede } from '../permisos-service.js';

// Íconos estáticos de fallback (ya existen en el proyecto)
const FALLBACK_ICON = {
  '192':   '/frontend/admin/img/icon-192.png',
  '512':   '/frontend/admin/img/icon-512.png',
  'badge': '/frontend/admin/img/badge-72.png',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// 954: mismo patrón que chofer_invitacion.js/pagos.js/portal_proveedor.js —
// no hay un util compartido para esto en el proyecto, cada handler que
// necesita armar una URL absoluta del lado del server lo resuelve local.
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// 954: mismo link que arma el frontend en empresa-config.html
// (actualizarLinkCatalogo) — /catalogo/<slug> si ya tiene uno asignado,
// si no cae al UUID crudo. Se recalcula acá (no se recibe por query) para
// no confiar en un link armado por el cliente al generar el QR.
function linkCatalogo(req, { empresaId, slug }) {
  return slug
    ? `${baseUrl(req)}/cliente/catalogo/${slug}`
    : `${baseUrl(req)}/cliente/catalogo?empresa_id=${empresaId}`;
}

// 954: reutiliza bwip-js (ya dependencia del proyecto para el código de
// barras ARCA en lib/arca/comprobante-pdf.js) con bcid 'qrcode' en vez de
// 'interleaved2of5' — mismo mecanismo, otro formato de barcode.
async function generarQrPng(texto) {
  return new Promise((resolve, reject) => {
    bwipjs.toBuffer(
      {
        bcid:            'qrcode',
        text:            texto,
        scale:           6,
        includetext:     false,
        backgroundcolor: 'ffffff',
      },
      (err, png) => {
        if (err) reject(err);
        else resolve(png);
      }
    );
  });
}

/**
 * Resuelve el perfil autenticado y valida rol admin/dueño. Devuelve el
 * perfil si todo OK, o null tras haber respondido el error correspondiente
 * (401/403) — mismo contrato que el resto de handlers migrados.
 */
async function requerirPerfilAdmin(req, res) {
  const perfil = await verificarToken(req, db);
  if (!perfil) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  if (!puede(perfil, 'acceder', 'empresa_config')) {
    res.status(403).json({ error: 'Sin permisos' });
    return null;
  }
  return perfil;
}

const rateLimitApi = rateLimit({ max: 100, windowMs: 60_000 });
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (await rateLimitApi(req, res)) return;

  // NOTA: en el dispatcher único (api/index.js), req.url ya no refleja la
  // ruta original (/api/empresa/logo, /api/empresa/icon), sino
  // /api/index?_mod=empresa&_svc=... Por eso el sub-ruteo se hace con el
  // query param _svc, seteado en vercel.json para cada endpoint.
  const _svc = req.query._svc;

  // ── POST /api/empresa/logo ───────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'logo') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    const { filename, contentType, data: b64 } = req.body ?? {};
    if (!filename || !contentType || !b64)
      return res.status(400).json({ error: 'Faltan campos: filename, contentType, data' });

    // SEC-12: 'image/svg+xml' se sacó de la lista permitida. Antes se
    // guardaba el SVG tal cual el usuario lo subía, sin sanitizar — un SVG
    // puede llevar <script>/on*=/foreignObject con contenido activo que
    // sobrevive aunque el bucket sea privado (se ejecuta al abrirlo, no
    // depende de que el bucket sea público). No hay rasterizado de por
    // medio para SVG (es vectorial), así que la única forma de cerrarlo sin
    // agregar una librería de sanitización nueva es rechazarlo directamente
    // y pedir PNG/JPEG/WebP, que sí pasan por sharp más abajo.
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(contentType))
      return res.status(400).json({ error: 'Tipo de archivo no permitido. Usá PNG, JPEG o WebP.' });

    let buffer = Buffer.from(b64, 'base64');
    let storageExt     = filename.split('.').pop().toLowerCase();
    let storageContent = contentType;

    // Todo lo permitido (png/jpeg/webp) se normaliza a WebP para reducir el
    // peso de carga.
    {
      const { default: sharp } = await import('sharp');
      buffer = await sharp(buffer)
        .resize({ width: 512, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      storageExt     = 'webp';
      storageContent = 'image/webp';
    }

    // FIX: el nombre de archivo NO puede contener "logo" — varios ad-blockers
    // (uBlock, AdBlock, etc.) bloquean requests a archivos que se llamen
    // "logo.*" por patrón de nombre, sin importar el dominio. Esto rompía la
    // visualización tanto en el panel admin como en el login del portal de
    // clientes para cualquier visitante con un bloqueador activo, aunque la
    // subida en sí (POST a nuestra propia API) sí funcionaba. Ver conversación
    // 2026-08-13.
    const storagePath = `${perfil.empresa_id}/marca.${storageExt}`;

    const { error: uploadErr } = await db.storage
      .from('logos').upload(storagePath, buffer, { contentType: storageContent, upsert: true });
    if (uploadErr)
      return errorSeguro(res, uploadErr, 500, 'No se pudo subir el logo.');

    // FIX v741: el bucket 'logos' pasó a public=false en la migración 140
    // (cerraba un problema real de listado cross-tenant: con public=true
    // cualquiera podía LISTAR el bucket completo y enumerar empresa_id +
    // nombres de archivo de todas las empresas, no solo leer un logo
    // puntual). Pero este handler seguía llamando a getPublicUrl(), que
    // arma una URL con el shape "pública" SIN chequear si el bucket
    // realmente lo es — Supabase Storage no la sirve si el bucket es
    // privado y el pedido llega sin sesión (que es el caso normal: la
    // vista previa del admin y los <img> de login.html/cliente/login.html
    // son <img src="..."> anónimos, sin Authorization header). Resultado:
    // "Logo actualizado" se mostraba igual (la subida en sí funcionaba),
    // pero el <img> fallaba en silencio (img.onerror → vuelve al ícono
    // con la inicial) y el logo nunca se veía. createSignedUrl() resuelve
    // esto sin reabrir el listado: firma acceso a ESTE archivo puntual,
    // usable en un <img src> sin sesión, con el bucket siguiendo privado
    // y sin exponer el listado de objetos. Expira en ~10 años (se
    // regenera solo con el próximo re-upload del logo, no hace falta
    // ningún cron de renovación para un asset que cambia muy rara vez).
    const DIEZ_ANIOS_SEG = 10 * 365 * 24 * 60 * 60;
    const { data: signedData, error: signedErr } = await db.storage
      .from('logos').createSignedUrl(storagePath, DIEZ_ANIOS_SEG);
    if (signedErr || !signedData?.signedUrl)
      return errorSeguro(res, signedErr, 500, 'Logo subido pero no se pudo generar la URL de acceso.');

    const publicUrl = signedData.signedUrl;

    await actualizarLogoUrl(perfil.empresa_id, publicUrl);

    return res.status(200).json({ ok: true, url: publicUrl });
  }

  // ── GET /api/empresa/icon ────────────────────────────────────────────────
  if (req.method === 'GET' && _svc === 'icon') {
    const size     = req.query.size ?? '192';
    const fallback = FALLBACK_ICON[size] ?? FALLBACK_ICON['192'];

    // Este endpoint es un <link rel="icon">/manifest, no un fetch con manejo
    // de error del frontend: ante cualquier falla de auth se cae al ícono
    // estático en vez de devolver 401/403 (comportamiento preexistente).
    const perfil = await verificarToken(req, db);
    if (!perfil?.empresa_id) return res.redirect(302, fallback);

    const logoUrl = await obtenerLogoUrl(perfil.empresa_id);

    const dest = logoUrl ?? fallback;
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.redirect(302, dest);
  }

  // ── GET /api/empresa/datos ───────────────────────────────────────────────
  // Datos editables de "Datos de la empresa". Nota: RLS en `empresas` ya
  // permite SELECT de la propia fila al usuario autenticado, pero se resuelve
  // acá también para no depender de que el frontend tenga el join cacheado
  // en authCtx.perfil.empresas (por si cambió en otra pestaña/sesión).
  if (req.method === 'GET' && _svc === 'datos') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    let empresa;
    try {
      empresa = await obtenerDatosEditables(perfil.empresa_id);
    } catch (err) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    // FIX v477: se expone el flag ya "aplanado" (booleano) para que el frontend
    // no tenga que conocer la forma del jsonb `config` — el resto de `config`
    // (si en el futuro guarda otras claves) no se envía, no hace falta acá.
    const { config, ...datosPublicos } = empresa;
    return res.status(200).json({
      ...datosPublicos,
      catalogo_publico_habilitado: config?.catalogo_publico_habilitado === true,
    });
  }

  // ── PUT /api/empresa/slug ─────────────────────────────────────────────────
  // 501: slug legible para el link del catálogo público
  // (/cliente/catalogo?e=<slug>), alternativa al UUID crudo. A diferencia
  // del CUIT o del token de portal de proveedor, esto no es un dato sensible
  // ni un secreto de seguridad — es solo un identificador público más fácil
  // de tipear/dictar, así que la validación es puramente de formato.
  if (req.method === 'PUT' && _svc === 'slug') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    const slugCrudo = String(req.body?.slug ?? '').trim().toLowerCase();

    if (!/^[a-z][a-z0-9-]{2,29}$/.test(slugCrudo)) {
      return res.status(400).json({
        error: 'El link debe tener entre 3 y 30 caracteres, empezar con una letra, y usar solo minúsculas, números y guiones.',
      });
    }

    try {
      const actualizado = await actualizarSlug(perfil.empresa_id, slugCrudo);
      return res.status(200).json({ ok: true, slug: actualizado.slug });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Ese link ya está en uso por otra empresa. Probá con otro.' });
      }
      return errorSeguro(res, err, 500, 'No se pudo guardar el cambio.');
    }
  }

  // ── GET /api/empresa/catalogo-qr ─────────────────────────────────────────
  // 954: QR descargable del link de catálogo público, para cartel/vidriera
  // del local además de redes. Mismo gate admin que el resto de esta
  // sección (no /icon, que es público a propósito).
  if (req.method === 'GET' && _svc === 'catalogo-qr') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    let empresa;
    try {
      empresa = await obtenerDatosEditables(perfil.empresa_id);
    } catch (err) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    const link = linkCatalogo(req, { empresaId: perfil.empresa_id, slug: empresa.slug });

    let png;
    try {
      png = await generarQrPng(link);
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo generar el QR.');
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store'); // cambia si cambia el slug
    res.setHeader('Content-Disposition', 'attachment; filename="qr-catalogo.png"');
    return res.status(200).send(png);
  }

  // ── GET /api/empresa/catalogo-visitas ────────────────────────────────────
  // 605: resumen de visitas al catálogo público por canal de origen
  // (?src=ig-bio/qr-local/etc. en el link, registrado por
  // registrar_visita_catalogo desde catalogo.html). Mismo gate admin que
  // catalogo-qr/slug/datos. `?dias=` opcional (default 30, tope 365 para no
  // agregar sobre una ventana arbitrariamente grande).
  if (req.method === 'GET' && _svc === 'catalogo-visitas') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    const diasCrudo = parseInt(req.query.dias, 10);
    const dias = Number.isFinite(diasCrudo) ? Math.min(365, Math.max(1, diasCrudo)) : 30;

    const resumen = await obtenerResumenVisitasCatalogo(perfil.empresa_id, dias);
    return res.status(200).json({ dias, resumen });
  }

  // ── PUT /api/empresa/catalogo-publico ────────────────────────────────────
  // FIX v477: toggle de `config.catalogo_publico_habilitado` (SEC-008,
  // CHANGELOG_v296) desde el panel, sin tocar SQL a mano. Antes de este
  // endpoint solo se podía activar con un UPDATE directo en Supabase.
  if (req.method === 'PUT' && _svc === 'catalogo-publico') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    const habilitado = req.body?.habilitado === true;

    // Read-modify-write en vez de jsonb_set por SQL directo: `config` puede
    // tener otras claves a futuro y el cliente JS de Supabase no permite un
    // merge atómico de jsonb en un solo .update(). El riesgo de carrera acá
    // es mínimo (toggle manual de un admin en su propio panel, no un campo de
    // alta frecuencia de escritura).
    const configActual = await obtenerConfig(perfil.empresa_id);
    const nuevoConfig = { ...configActual, catalogo_publico_habilitado: habilitado };

    try {
      await actualizarConfig(perfil.empresa_id, nuevoConfig);
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo guardar el cambio.');
    }

    return res.status(200).json({ ok: true, catalogo_publico_habilitado: habilitado });
  }

  // ── PUT /api/empresa/datos ───────────────────────────────────────────────
  if (req.method === 'PUT' && _svc === 'datos') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    const { nombre, cuit, domicilio, telefono, email } = req.body ?? {};

    if (!nombre || !String(nombre).trim())
      return res.status(400).json({ error: 'El nombre / razón social es requerido' });

    const cuitLimpio = String(cuit ?? '').replace(/-/g, '').trim();
    if (!/^\d{11}$/.test(cuitLimpio))
      return res.status(400).json({ error: 'El CUIT debe tener 11 dígitos numéricos' });

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
      return res.status(400).json({ error: 'El email no tiene un formato válido' });

    const update = {
      nombre:    String(nombre).trim(),
      cuit:      cuitLimpio,
      domicilio: domicilio ? String(domicilio).trim() : null,
      telefono:  telefono  ? String(telefono).trim()  : null,
      email:     email     ? String(email).trim()     : null,
    };

    let empresa;
    try {
      empresa = await actualizarDatosEmpresa(perfil.empresa_id, update);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Ese CUIT ya está registrado por otra empresa.' });
      }
      return errorSeguro(res, err, 500, 'Error al guardar.');
    }

    return res.status(200).json({ ok: true, empresa });
  }

  return res.status(404).json({ error: 'Ruta no encontrada' });
}
