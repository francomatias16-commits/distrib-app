// lib/arca/wsaa.js
//
// Autenticación contra el WSAA (Web Service de Autenticación y Autorización)
// de ARCA/AFIP. Devuelve { token, sign } para usar en wsfev1.js.
//
// Flujo:
//   1. Si hay un token cacheado en `tokens_wsaa` y todavía no está cerca de
//      vencer, se reusa (los tokens WSAA duran ~12hs, no tiene sentido pedir
//      uno nuevo en cada factura).
//   2. Si no, se arma un TRA (Ticket de Requerimiento de Acceso), se firma
//      como CMS/PKCS#7 con el certificado y clave de la empresa, y se manda
//      al endpoint SOAP de WSAA.
//   3. La respuesta (token, sign, expirationTime) se guarda en `tokens_wsaa`
//      y se devuelve.
//
// Importante: la firma se hace con `node-forge` (JS puro) y NO con el
// binario `openssl` vía child_process, porque esto corre en funciones
// serverless de Vercel donde no hay garantía de tener `openssl` disponible
// en el PATH del runtime.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import forge from 'node-forge';
import { descifrar } from '../crypto-secrets.js';
import { CircuitBreaker } from '../circuit-breaker.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

const WSAA_URL = {
  homologacion: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  produccion: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
};

// Mismo patrón (CircuitBreaker) que mercado-pago/prisma-paystore en
// lib/handlers/pagos.js y supabase-auth en lib/handlers/auth.js — Etapa 5
// de PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md: confirmar/agregar
// cobertura en ARCA/AFIP, que hasta ahora tenía timeout pero no breaker.
//
// SIN withRetry acá a propósito (ver comentario junto al fetch() más abajo):
// un TRA firmado no se puede reenviar sin generar uno nuevo, así que este
// breaker solo evita seguir golpeando a WSAA con llamadas nuevas (de otras
// empresas/requests) mientras está caído — no reintenta la llamada que falló.
// timeoutMs se deja por encima de WSAA_TIMEOUT_MS (15s) para que el AbortController
// de más abajo sea siempre el que corta primero y devuelva su mensaje específico;
// el timeout del breaker queda solo como red de seguridad.
const wsaaBreaker = new CircuitBreaker({
  name:               'arca-wsaa',
  umbralFallas:       5,
  tiempoRecuperacion: 30_000,
  timeoutMs:          20_000,
});

// Margen de seguridad: si al token cacheado le quedan menos de 10 minutos
// de vida, se pide uno nuevo en vez de arriesgarse a que venza a mitad de
// una emisión.
const MARGEN_RENOVACION_MS = 10 * 60 * 1000;

// ── API pública ────────────────────────────────────────────────────────

/**
 * Devuelve { token, sign, expiration } válidos para la empresa indicada.
 * Usa caché en `tokens_wsaa` cuando es posible.
 *
 * @param {string} empresaId
 * @param {object} [opciones]
 * @param {string} [opciones.service='wsfe']  Servicio ARCA a autenticar.
 * @param {boolean} [opciones.forzarRenovacion=false]  Ignora la caché.
 */
export async function obtenerTokenWSAA(empresaId, opciones = {}) {
  const { service = 'wsfe', forzarRenovacion = false } = opciones;

  if (!empresaId) {
    throw new Error('[wsaa] obtenerTokenWSAA requiere empresaId.');
  }

  const config = await obtenerCertificadoEmpresa(empresaId);
  if (!config) {
    throw new Error(
      `[wsaa] No hay facturacion_config activa para la empresa ${empresaId}.`
    );
  }

  // Modo 'delegado' (default, ver migración 628): se firma con el
  // certificado ÚNICO del proveedor (Fluxo) en vez de uno propio de la
  // empresa. Lo que identifica "en nombre de quién" se factura sigue
  // siendo config.cuit en el <Auth><Cuit> de wsfev1.js — esto solo
  // decide de qué certificado sale el <Token>/<Sign>. Requiere que la
  // empresa haya delegado el servicio a la CUIT del proveedor en su
  // Administrador de Relaciones de Clave Fiscal (ver lib/arca/delegacion.js).
  if (config.modo_certificado !== 'propio') {
    return obtenerTokenWSAAProveedor(config.homologacion, service, forzarRenovacion);
  }

  // Modo 'propio' (legacy): la empresa tiene su propio certificado
  // cargado en facturacion_config.cert_pem/key_pem — comportamiento
  // sin cambios respecto a como funcionaba antes de la migración 628.
  if (!forzarRenovacion) {
    const cacheado = await leerTokenCacheado(empresaId);
    if (cacheado) return cacheado;
  }

  if (!config.cert_pem || !config.key_pem) {
    throw new Error(
      `[wsaa] La empresa ${empresaId} está en modo_certificado='propio' pero no tiene ` +
        'certificado/clave ARCA cargados (facturacion_config.cert_pem / key_pem vacíos).'
    );
  }

  const tra = construirTRA(service);
  const cms = firmarTRA(tra, config.cert_pem, config.key_pem);
  const { token, sign, expirationTime } = await wsaaBreaker.exec(() => llamarWSAA(cms, config.homologacion));

  await guardarTokenCacheado(empresaId, { token, sign, expirationTime });

  return { token, sign, expiration: expirationTime };
}

// ── Token WSAA del proveedor (modo 'delegado') ─────────────────────────
// Un solo token por ambiente (homologación/producción), compartido entre
// TODAS las empresas en modo 'delegado' — ver el comentario en la
// migración 628 sobre por qué esto es seguro y correcto.

async function obtenerTokenWSAAProveedor(homologacion, service, forzarRenovacion) {
  if (!forzarRenovacion) {
    const cacheado = await leerTokenProveedorCacheado(homologacion);
    if (cacheado) return cacheado;
  }

  const proveedor = await obtenerCertificadoProveedor(homologacion);
  if (!proveedor) {
    throw new Error(
      `[wsaa] No hay arca_proveedor_config cargado para homologacion=${homologacion}. ` +
        'Cargarlo con scripts/cargar-certificado-proveedor.js antes de usar el modo delegado.'
    );
  }

  const tra = construirTRA(service);
  const cms = firmarTRA(tra, proveedor.cert_pem, proveedor.key_pem);
  const { token, sign, expirationTime } = await wsaaBreaker.exec(() => llamarWSAA(cms, homologacion));

  await guardarTokenProveedorCacheado(homologacion, { token, sign, expirationTime });

  return { token, sign, expiration: expirationTime };
}

async function leerTokenProveedorCacheado(homologacion) {
  const { data, error } = await supabase
    .from('tokens_wsaa_proveedor')
    .select('token, sign, expiration')
    .eq('homologacion', homologacion)
    .maybeSingle();

  if (error) {
    console.error('[wsaa] Error leyendo tokens_wsaa_proveedor:', error.message);
    return null;
  }
  if (!data) return null;

  const vence = new Date(data.expiration).getTime();
  const quedaVigente = vence - Date.now() > MARGEN_RENOVACION_MS;
  if (!quedaVigente) return null;

  return { token: data.token, sign: data.sign, expiration: data.expiration };
}

async function guardarTokenProveedorCacheado(homologacion, { token, sign, expirationTime }) {
  const { error } = await supabase
    .from('tokens_wsaa_proveedor')
    .upsert(
      { homologacion, token, sign, expiration: expirationTime },
      { onConflict: 'homologacion' }
    );

  if (error) {
    console.error('[wsaa] Error guardando tokens_wsaa_proveedor (no crítico):', error.message);
  }
}

async function obtenerCertificadoProveedor(homologacion) {
  const { data, error } = await supabase
    .from('arca_proveedor_config')
    .select('cert_pem, key_pem, activo')
    .eq('homologacion', homologacion)
    .eq('activo', true)
    .maybeSingle();

  if (error) {
    throw new Error(`[wsaa] Error leyendo arca_proveedor_config: ${error.message}`);
  }
  if (!data) return null;

  return {
    ...data,
    cert_pem: descifrar(data.cert_pem),
    key_pem:  descifrar(data.key_pem),
  };
}

// ── Caché en tokens_wsaa ──────────────────────────────────────────────

async function leerTokenCacheado(empresaId) {
  const { data, error } = await supabase
    .from('tokens_wsaa')
    .select('token, sign, expiration')
    .eq('empresa_id', empresaId)
    .maybeSingle();

  if (error) {
    console.error('[wsaa] Error leyendo tokens_wsaa:', error.message);
    return null;
  }
  if (!data) return null;

  const vence = new Date(data.expiration).getTime();
  const quedaVigente = vence - Date.now() > MARGEN_RENOVACION_MS;

  if (!quedaVigente) return null;

  return { token: data.token, sign: data.sign, expiration: data.expiration };
}

async function guardarTokenCacheado(empresaId, { token, sign, expirationTime }) {
  const { error } = await supabase
    .from('tokens_wsaa')
    .upsert(
      {
        empresa_id: empresaId,
        token,
        sign,
        expiration: expirationTime,
      },
      { onConflict: 'empresa_id' }
    );

  if (error) {
    // No tiramos la operación abajo por esto: ya tenemos un token válido
    // en memoria para esta request, solo se pierde la caché para la
    // próxima. Se loguea para poder diagnosticarlo.
    console.error('[wsaa] Error guardando tokens_wsaa (no crítico):', error.message);
  }
}

// ── Certificado de la empresa ─────────────────────────────────────────

async function obtenerCertificadoEmpresa(empresaId) {
  const { data, error } = await supabase
    .from('facturacion_config')
    .select('cert_pem, key_pem, homologacion, activo, modo_certificado')
    .eq('empresa_id', empresaId)
    .eq('activo', true)
    .maybeSingle();

  if (error) {
    throw new Error(`[wsaa] Error leyendo facturacion_config: ${error.message}`);
  }
  if (!data) return data;

  // Los campos se guardan cifrados (ver lib/crypto-secrets.js); descifrar()
  // además soporta de forma transparente filas viejas que aún estén en
  // texto plano (no migradas), así que esto es seguro de aplicar siempre.
  return {
    ...data,
    cert_pem: descifrar(data.cert_pem),
    key_pem:  descifrar(data.key_pem),
  };
}

// ── TRA (Ticket de Requerimiento de Acceso) ───────────────────────────

function construirTRA(service) {
  const ahora = new Date();
  // Ventana amplia y conservadora; el vencimiento real del token lo decide
  // ARCA en la respuesta (expirationTime), esto es solo el pedido.
  const generationTime = new Date(ahora.getTime() - 10 * 60 * 1000);
  const expirationTime = new Date(ahora.getTime() + 10 * 60 * 1000);
  const uniqueId = Math.floor(ahora.getTime() / 1000);

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<loginTicketRequest version="1.0">\n' +
    '  <header>\n' +
    `    <uniqueId>${uniqueId}</uniqueId>\n` +
    `    <generationTime>${generationTime.toISOString()}</generationTime>\n` +
    `    <expirationTime>${expirationTime.toISOString()}</expirationTime>\n` +
    '  </header>\n' +
    `  <service>${service}</service>\n` +
    '</loginTicketRequest>'
  );
}

// ── Firma CMS/PKCS#7 con node-forge ───────────────────────────────────

function firmarTRA(traXml, certPem, keyPem) {
  let cert, privateKey;

  try {
    cert = forge.pki.certificateFromPem(certPem);
    privateKey = forge.pki.privateKeyFromPem(keyPem);
  } catch (err) {
    throw new Error(
      `[wsaa] No se pudo parsear el certificado o la clave privada (¿están en formato PEM válido?): ${err.message}`
    );
  }

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });

  // detached: false → el TRA viaja embebido en el propio CMS, que es lo
  // que WSAA espera (equivalente a `openssl smime -sign -nodetach`).
  p7.sign({ detached: false });

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

// ── Llamada SOAP a WSAA ───────────────────────────────────────────────

async function llamarWSAA(cmsBase64, homologacion) {
  const url = homologacion ? WSAA_URL.homologacion : WSAA_URL.produccion;

  const soapBody =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:wsaa="https://wsaa.view.sua.dvadac.desein.afip.gov">\n' +
    '  <soapenv:Header/>\n' +
    '  <soapenv:Body>\n' +
    '    <wsaa:loginCms>\n' +
    `      <wsaa:in0>${cmsBase64}</wsaa:in0>\n` +
    '    </wsaa:loginCms>\n' +
    '  </soapenv:Body>\n' +
    '</soapenv:Envelope>';

  // Timeout: igual que en wsfev1.js, sin esto una caída de WSAA puede
  // colgar la función serverless. No se reintenta automáticamente DENTRO
  // de esta función porque el `cmsBase64` recibido ya tiene un uniqueId
  // fijo firmado — reenviar el mismo CMS puede ser rechazado por AFIP como
  // "TRA repetido". Si hace falta reintentar, el caller debe generar un
  // TRA nuevo (uniqueId nuevo) y volver a firmar antes de llamar de nuevo.
  const WSAA_TIMEOUT_MS = 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WSAA_TIMEOUT_MS);

  let resp, text;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '',
      },
      body: soapBody,
      signal: controller.signal,
    });
    text = await resp.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `[wsaa] Timeout (${WSAA_TIMEOUT_MS}ms) esperando respuesta de WSAA (${url}). ` +
        `Generar un TRA nuevo antes de reintentar.`
      );
    }
    throw new Error(`[wsaa] Error de red llamando a WSAA (${url}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // Fault SOAP explícito (TRA repetido, CEE no autorizado, certificado
  // revocado/vencido, etc.) — más informativo que un parseo fallido.
  const faultMatch = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
  if (faultMatch) {
    throw new Error(`[wsaa] WSAA rechazó la solicitud: ${decodeEntidadesXML(faultMatch[1])}`);
  }

  if (!resp.ok) {
    throw new Error(`[wsaa] WSAA respondió HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  const returnMatch = text.match(/<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/);
  if (!returnMatch) {
    throw new Error(
      `[wsaa] Respuesta de WSAA sin <loginCmsReturn>. Respuesta cruda: ${text.slice(0, 500)}`
    );
  }

  const xmlInterno = decodeEntidadesXML(returnMatch[1]);

  const token = xmlInterno.match(/<token>([\s\S]*?)<\/token>/)?.[1];
  const sign = xmlInterno.match(/<sign>([\s\S]*?)<\/sign>/)?.[1];
  const expirationTime = xmlInterno.match(/<expirationTime>([\s\S]*?)<\/expirationTime>/)?.[1];

  if (!token || !sign || !expirationTime) {
    throw new Error(
      `[wsaa] No se pudo extraer token/sign/expirationTime de la respuesta de WSAA: ${xmlInterno.slice(0, 500)}`
    );
  }

  return { token, sign, expirationTime };
}

function decodeEntidadesXML(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
