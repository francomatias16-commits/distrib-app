// lib/handlers/portal_proveedor.js
// Innovación #10 (roadmap) — Autogestión de Proveedores ("Vidriera Inversa")
//
// Dos superficies en este archivo:
//
// NOTA v125 (auditoría): Este handler NO está registrado en api/index.js como dispatcher
// independiente. El portal de proveedores funciona vía proveedores.js handler que detecta
// _svc=portal internamente. Este archivo contiene lógica adicional que puede integrarse
// en el futuro. No eliminar — ver M1 en AUDITORIA_v124_COMPLETA.md.
//
//
//  A) ADMIN (autenticado, llamado desde proveedores.js vía _svc=portal-admin)
//     POST ?accion=generar-link   body:{ proveedor_id }  → crea token, devuelve URL
//     GET  ?accion=links&proveedor_id=uuid               → historial de links emitidos
//     POST ?accion=revocar        body:{ token_id }       → revoca un link
//
//  B) PÚBLICO (sin login, llamado desde /proveedor/portal?t=<token>, vía
//     _svc=portal — SIN pasar por el bloque de auth de proveedores.js)
//     GET  ?accion=ver               &t=<token> → datos del proveedor + sus OCs
//     POST ?accion=confirmar-entrega &t=<token>  body:{ orden_id, fecha_esperada }
//          El proveedor confirma/ajusta la fecha de entrega de una OC propia.
//     POST ?accion=subir-factura     &t=<token>  body:{ orden_id?, numero_factura,
//          fecha_factura, total, archivo_base64?, offline_local_id? }
//          El proveedor carga una factura (con o sin OC asociada); queda
//          con origen='proveedor' y estado 'pendiente' para revisión del admin.
//          offline_local_id (Plan offline, Etapa 3, migración 448): id
//          generado en el dispositivo cuando la carga se encoló offline —
//          dedup si el outbox reintenta. confirmar-entrega no lo necesita
//          (es un UPDATE, naturalmente idempotente al reintentar).
//
// Seguridad:
//  - El token crudo viaja solo en la URL entregada una vez; en DB se guarda
//    sha256(token) (mismo patrón que refresh tokens de chofer, ver
//    lib/auth-helpers.js → hashToken).
//  - La superficie pública NUNCA usa el JWT de Supabase del usuario: valida
//    el hash contra proveedor_portal_tokens vía RPC validar_token_portal_proveedor,
//    siempre con SERVICE_ROLE_KEY (la tabla tiene RLS deny-all, ver migración 053).
//  - Rate limit propio y más estricto que el resto de la API, porque este
//    endpoint es candidato a fuerza bruta de tokens.
//  - Las escrituras (confirmar-entrega, subir-factura) SIEMPRE filtran
//    explícitamente por proveedor_id/empresa_id resueltos del token — el
//    service_role bypassea RLS, así que la validación de pertenencia es
//    responsabilidad exclusiva de este código, nunca delegada a la DB.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import crypto from 'crypto';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import {
  obtenerProveedorParaLink,
  insertarTokenPortal,
  listarTokensPortal,
  revocarTokenPortal,
  validarTokenPortalRpc,
  listarNotificacionesProveedor,
  obtenerProveedorPortal,
  obtenerNombreEmpresa,
  listarOrdenesCompraProveedor,
  listarFacturasProveedorPortal,
  obtenerOrdenCompraParaConfirmar,
  actualizarFechaEsperadaOrden,
  obtenerOrdenCompraParaFactura,
  insertarFacturaProveedorPortal,
  buscarFacturaProveedorPorOfflineLocalId,
} from '../repos/portal-proveedor.js';
import { firmarCampoUrl, firmarCampoUrlEnLista } from '../utils/storage-urls.js';
import { validarArchivoPorContenido } from '../utils/image-sniff.js'; // BUG-04

const limiterAdmin  = rateLimit({ max: 30, windowMs: 60_000 });
const limiterPublic = rateLimit({ max: 20, windowMs: 60_000 }); // por IP — frena fuerza bruta de tokens

// `supabase` sigue vivo solo para Storage (bucket `facturas-proveedor`) —
// no es una tabla, queda fuera del alcance de la migración a repos.
const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export const ROLES_ESCRITURA = ['dueno', 'admin'];
const DIAS_VALIDEZ = 30;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generarTokenCrudo() {
  // 32 bytes → 43 chars base64url, suficiente entropía para no ser adivinable
  return crypto.randomBytes(32).toString('base64url');
}

function baseUrl(req) {
  // Vercel expone el host real en x-forwarded-host; fallback a env si hiciera falta
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// ════════════════════════════════════════════════════════════════════════
// A) ADMIN — requiere usuario autenticado con rol dueno/admin
//    Llamado desde proveedores.js, que YA validó el Bearer token y resolvió
//    `perfil` antes de despachar acá. Recibe { req, res, perfil } resuelto.
// ════════════════════════════════════════════════════════════════════════
export async function handlePortalAdmin(req, res, perfil) {
  if (await limiterAdmin(req, res)) return;

  const { empresa_id, rol, id: usuario_id } = perfil;
  if (!ROLES_ESCRITURA.includes(rol))
    return res.status(403).json({ error: 'Sin permisos para gestionar el portal de proveedores' });

  const accion = req.query.accion || '';

  // ── Generar (o regenerar) link ────────────────────────────────────────
  if (req.method === 'POST' && accion === 'generar-link') {
    const { proveedor_id } = req.body || {};
    const resultado = await generarLinkPortalProveedor({
      empresa_id, creado_por: usuario_id, proveedor_id, baseUrl: baseUrl(req),
    });
    if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
    return res.status(201).json(resultado);
  }

  // ── Historial de links emitidos para un proveedor ──────────────────────
  if (req.method === 'GET' && accion === 'links') {
    const { proveedor_id } = req.query;
    const resultado = await listarLinksPortalProveedor({ empresa_id, proveedor_id });
    if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
    return res.json({ links: resultado.links });
  }

  // ── Revocar un link ──────────────────────────────────────────────────
  if (req.method === 'POST' && accion === 'revocar') {
    const { token_id } = req.body || {};
    const resultado = await revocarLinkPortalProveedor({ empresa_id, token_id });
    if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Acción desconocida' });
}

// ════════════════════════════════════════════════════════════════════════
// Funciones de negocio reusables — llamadas por handlePortalAdmin (HTTP) y
// por lib/asistente-tools.js. Mismo contrato { ok, status, error } que
// chofer_invitacion.js: `error` ya sanitizado, detalle crudo logueado acá
// con console.error.
// ════════════════════════════════════════════════════════════════════════

export async function generarLinkPortalProveedor({ empresa_id, creado_por, proveedor_id, baseUrl: baseUrlStr }) {
  if (!proveedor_id) return { ok: false, status: 400, error: 'proveedor_id requerido' };

  const prov = await obtenerProveedorParaLink(empresa_id, proveedor_id);

  if (!prov) return { ok: false, status: 404, error: 'Proveedor no encontrado' };

  const tokenCrudo = generarTokenCrudo();
  const expiraAt = new Date(Date.now() + DIAS_VALIDEZ * 24 * 60 * 60 * 1000).toISOString();

  let row;
  try {
    row = await insertarTokenPortal({
      empresa_id,
      proveedor_id,
      token_hash: hashToken(tokenCrudo),
      creado_por,
      expira_at: expiraAt,
    });
  } catch (error) {
    console.error('[PORTAL_PROVEEDOR] Error insertando token:', error);
    return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
  }

  const url = `${baseUrlStr}/proveedor/portal?t=${tokenCrudo}`;

  return {
    ok: true,
    url,
    token_id: row.id,
    proveedor: prov.razon_social,
    expira_at: row.expira_at,
    dias_validez: DIAS_VALIDEZ,
  };
}

export async function listarLinksPortalProveedor({ empresa_id, proveedor_id }) {
  if (!proveedor_id) return { ok: false, status: 400, error: 'proveedor_id requerido' };

  let data;
  try {
    data = await listarTokensPortal(empresa_id, proveedor_id);
  } catch (error) {
    console.error('[PORTAL_PROVEEDOR] Error listando links:', error);
    return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
  }

  const ahora = Date.now();
  const links = (data || []).map(l => ({
    ...l,
    estado: l.revocado_at ? 'revocado'
          : new Date(l.expira_at).getTime() < ahora ? 'expirado'
          : 'activo',
  }));

  return { ok: true, links };
}

export async function revocarLinkPortalProveedor({ empresa_id, token_id }) {
  if (!token_id) return { ok: false, status: 400, error: 'token_id requerido' };

  let data;
  try {
    data = await revocarTokenPortal(empresa_id, token_id);
  } catch (error) {
    console.error('[PORTAL_PROVEEDOR] Error revocando link:', error);
    return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
  }
  if (!data) return { ok: false, status: 404, error: 'Link no encontrado' };

  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════
// B) PÚBLICO — sin login, sin Bearer de Supabase. El proveedor entra con
//    el token de la URL. Despachado directamente desde api/index.js antes
//    de cualquier validación de usuario (ver nota en proveedores.js).
// ════════════════════════════════════════════════════════════════════════
// ── Helper compartido: valida el token crudo de la URL y resuelve a qué
//    proveedor/empresa pertenece. Usado por las 3 acciones públicas. ──────
async function validarTokenPublico(tokenCrudo) {
  if (!tokenCrudo || typeof tokenCrudo !== 'string')
    return { ok: false, status: 400, error: 'Link inválido' };

  const { data: validacion, error: vErr } = await validarTokenPortalRpc(hashToken(tokenCrudo));

  if (vErr) return { ok: false, status: 500, error: 'Error validando el link' };

  if (!validacion?.valido) {
    const motivo = validacion?.motivo || 'no_encontrado';
    const mensajes = {
      no_encontrado: 'Este link no es válido. Pedile a tu contacto habitual que te genere uno nuevo.',
      revocado:      'Este link fue desactivado. Pedile a tu contacto habitual que te genere uno nuevo.',
      expirado:      'Este link venció (los links son válidos por 30 días). Pedile a tu contacto habitual que te genere uno nuevo.',
    };
    return { ok: false, status: 410, error: mensajes[motivo] || 'Link inválido' };
  }

  return { ok: true, proveedor_id: validacion.proveedor_id, empresa_id: validacion.empresa_id };
}

export async function handlePortalPublico(req, res) {
  if (await limiterPublic(req, res)) return;

  const accion = req.query.accion || 'ver';
  const tokenCrudo = req.query.t;

  const val = await validarTokenPublico(tokenCrudo);
  if (!val.ok) return res.status(val.status).json({ error: val.error });
  const { proveedor_id, empresa_id } = val;

  if (req.method === 'GET' && accion === 'ver')
    return verPortal(res, proveedor_id, empresa_id);

  if (req.method === 'POST' && accion === 'confirmar-entrega')
    return confirmarEntrega(req, res, proveedor_id, empresa_id);

  if (req.method === 'POST' && accion === 'subir-factura')
    return subirFactura(req, res, proveedor_id, empresa_id);

  if (req.method === 'GET' && accion === 'notificaciones')
    return verNotificaciones(res, proveedor_id, empresa_id);

  return res.status(405).json({ error: 'Método o acción no permitida' });
}

// ── GET ?accion=notificaciones — historial de notif_log del proveedor ────
// Fase 4 (plan ERP), generalización del centro de notificaciones: a
// diferencia de cliente (RLS + Supabase client-side, ver
// notif_log_select_unificada), el portal de proveedor no tiene sesión de
// Supabase — es público, autenticado solo por el token de la URL — así
// que esto SÍ tiene que resolverse server-side con el token ya validado
// arriba, igual que el resto de handlePortalPublico.
//
// notif_log no tiene columna proveedor_id (solo cliente_id) — las
// notificaciones a proveedor (ver lib/handlers/proveedores.js,
// accion=notificar-proveedor) guardan el id dentro de payload jsonb. Se
// filtra ahí. empresa_id sigue siendo el filtro de aislamiento real (ya
// resuelto del token, no de un query param) — el filtro por proveedor_id
// en payload es adicional, no el único.
async function verNotificaciones(res, proveedor_id, empresa_id) {
  let data;
  try {
    data = await listarNotificacionesProveedor(empresa_id, proveedor_id);
  } catch (error) {
    return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }

  return res.json({
    ok: true,
    notificaciones: (data || []).map(n => ({
      id: n.id,
      tipo: n.tipo,
      canal: n.canal,
      email: n.email,
      entregada: n.entregada,
      motivo: n.motivo,
      created_at: n.created_at,
      // Nada más del payload sale al portal público — evita filtrar ids
      // internos (recepcion_id, orden_id, enviado_por) que el proveedor
      // no necesita ver.
    })),
  });
}

// ── GET ?accion=ver — datos del proveedor + sus OCs y facturas ────────────
async function verPortal(res, proveedor_id, empresa_id) {
  const proveedor = await obtenerProveedorPortal(empresa_id, proveedor_id);

  const nombreEmpresa = await obtenerNombreEmpresa(empresa_id);

  let ordenes;
  try {
    ordenes = await listarOrdenesCompraProveedor(empresa_id, proveedor_id);
  } catch (ocErr) {
    return errorSeguro(res, ocErr, 500, 'No se pudo completar la operación.');
  }

  const facturasRaw = await listarFacturasProveedorPortal(empresa_id, proveedor_id);
  // Vista interactiva del portal: el proveedor puede tenerla abierta un
  // rato antes de hacer clic en "ver factura", 10 min por defecto se queda
  // corto acá.
  const UNA_HORA_SEG = 60 * 60;
  const facturas = await firmarCampoUrlEnLista(supabase, 'facturas-proveedor', facturasRaw || [], 'archivo_url', UNA_HORA_SEG);

  return res.json({
    ok: true,
    empresa: nombreEmpresa || '—',
    proveedor: {
      razon_social: proveedor?.razon_social,
      nombre_fantasia: proveedor?.nombre_fantasia,
      dias_pago: proveedor?.dias_pago,
    },
    ordenes: ordenes || [],
    facturas: facturas || [],
  });
}

// ── POST ?accion=confirmar-entrega — el proveedor confirma/ajusta la fecha
//    de entrega de una OC propia (Innovación #10, antes era solo lectura). ─
async function confirmarEntrega(req, res, proveedor_id, empresa_id) {
  const { orden_id, fecha_esperada } = req.body || {};

  if (!orden_id || !fecha_esperada)
    return res.status(400).json({ error: 'orden_id y fecha_esperada son requeridos' });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_esperada))
    return res.status(400).json({ error: 'fecha_esperada debe tener formato AAAA-MM-DD' });

  // La OC tiene que ser del proveedor/empresa del token, y todavía no
  // recibida ni cancelada — no tiene sentido "confirmar entrega" de algo
  // ya cerrado.
  const orden = await obtenerOrdenCompraParaConfirmar(empresa_id, proveedor_id, orden_id);

  if (!orden) return res.status(404).json({ error: 'Orden de compra no encontrada' });
  if (['recibida', 'cancelada'].includes(orden.estado))
    return res.status(400).json({ error: `No se puede confirmar fecha en una OC ${orden.estado}` });

  let actualizada;
  try {
    actualizada = await actualizarFechaEsperadaOrden({ empresa_id, proveedor_id, orden_id, fecha_esperada });
  } catch (errUpd) {
    return errorSeguro(res, errUpd, 500, 'No se pudo completar la operación.');
  }

  return res.json({ ok: true, orden: actualizada });
}

// ── POST ?accion=subir-factura — el proveedor autocarga una factura, con o
//    sin OC asociada. Queda origen='proveedor', estado 'pendiente' para que
//    el admin la revise/concilie (Innovación #10). ─────────────────────────
async function subirFactura(req, res, proveedor_id, empresa_id) {
  const { orden_id, numero_factura, fecha_factura, total, archivo_base64, offline_local_id } = req.body || {};
  const UNA_HORA_SEG = 60 * 60;

  if (!numero_factura || !fecha_factura || total == null)
    return res.status(400).json({ error: 'numero_factura, fecha_factura y total son requeridos' });

  if (typeof numero_factura !== 'string' || numero_factura.trim().length === 0 || numero_factura.length > 40)
    return res.status(400).json({ error: 'numero_factura debe ser texto de hasta 40 caracteres' });

  const totalNum = Number(total);
  if (!Number.isFinite(totalNum) || totalNum <= 0)
    return res.status(400).json({ error: 'total debe ser un número mayor a 0' });

  // Si vino con OC, tiene que ser del proveedor/empresa del token
  if (orden_id) {
    const orden = await obtenerOrdenCompraParaFactura(empresa_id, proveedor_id, orden_id);
    if (!orden) return res.status(404).json({ error: 'Orden de compra no encontrada' });
  }

  // OFFLINE-05 (auditoría Etapa 5): idempotencia ANTES de tocar Storage.
  // Antes, esta consulta solo pasaba dentro de insertarFacturaProveedorPortal
  // — es decir, DESPUÉS de subir el archivo. Un reintento del outbox
  // (proveedor-offline.js) de una acción que el servidor ya había aplicado
  // con éxito (la respuesta se perdió antes de llegar al cliente, típico
  // con mala señal) volvía a subir el mismo archivo al bucket
  // `facturas-proveedor` en cada intento, aunque el INSERT en sí nunca se
  // duplicara. Cortamos acá, antes del upload, para el caso común de
  // reintento — el chequeo que queda dentro de
  // insertarFacturaProveedorPortal() sigue como defensa en profundidad
  // (ej. carrera entre dos requests casi simultáneos).
  if (offline_local_id) {
    const existente = await buscarFacturaProveedorPorOfflineLocalId(empresa_id, offline_local_id);
    if (existente) {
      const existenteConUrl = await firmarCampoUrl(supabase, 'facturas-proveedor', existente, 'archivo_url', UNA_HORA_SEG);
      return res.status(201).json({ ok: true, factura: existenteConUrl });
    }
  }

  // Subida opcional del archivo (PDF o imagen de la factura)
  let archivo_url = null;
  if (archivo_base64) {
    const match = archivo_base64.match(/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato de archivo inválido (debe ser JPG, PNG, WEBP o PDF)' });

    const buffer = Buffer.from(match[3], 'base64');

    const MAX_BYTES = 8 * 1024 * 1024; // 8MB, mismo límite que el resto de los uploads del proyecto
    if (buffer.length > MAX_BYTES)
      return res.status(400).json({ error: 'El archivo no puede superar 8MB' });

    // BUG-04: el regex de arriba solo valida el prefijo `data:mime;base64,`
    // que arma el propio cliente — no el contenido real del archivo. Se
    // sniffea por magic bytes antes de subirlo a Storage, y se usa el mime
    // real detectado (no el declarado) para el path/Content-Type.
    const validacionArchivo = validarArchivoPorContenido(
      buffer,
      ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    );
    if (!validacionArchivo.ok)
      return res.status(400).json({ error: validacionArchivo.error });

    const mime = validacionArchivo.mimeReal;
    const ext = mime === 'application/pdf' ? 'pdf' : (mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]);

    const path = `${empresa_id}/${proveedor_id}/${Date.now()}.${ext}`;
    const { error: errUpload } = await supabase.storage
      .from('facturas-proveedor')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (errUpload) return errorSeguro(res, errUpload, 500, 'No se pudo completar la operación.');

    // SEC-05: bucket 'facturas-proveedor' privado. Se guarda el path; la
    // signed URL se genera recién al leer (ver lib/utils/storage-urls.js).
    archivo_url = path;
  }

  let factura;
  try {
    factura = await insertarFacturaProveedorPortal({
      empresa_id,
      proveedor_id,
      orden_id: orden_id || null,
      numero_factura: numero_factura.trim(),
      fecha_factura,
      subtotal: totalNum,
      iva_pct: 0,
      iva_monto: 0,
      total: totalNum,
      origen: 'proveedor',
      archivo_url,
      notas: 'Cargada por el proveedor desde el portal de autogestión — pendiente de revisión por el admin (totales/IVA sin desglosar).',
      offline_local_id: offline_local_id || null,
    });
  } catch (errInsert) {
    return errorSeguro(res, errInsert, 500, 'No se pudo completar la operación.');
  }

  const facturaConUrl = await firmarCampoUrl(supabase, 'facturas-proveedor', factura, 'archivo_url', UNA_HORA_SEG);

  return res.status(201).json({ ok: true, factura: facturaConUrl });
}
