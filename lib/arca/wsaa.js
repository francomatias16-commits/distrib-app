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

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

const WSAA_URL = {
  homologacion: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  produccion: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
};

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

  if (!forzarRenovacion) {
    const cacheado = await leerTokenCacheado(empresaId);
    if (cacheado) return cacheado;
  }

  const config = await obtenerCertificadoEmpresa(empresaId);
  if (!config) {
    throw new Error(
      `[wsaa] No hay facturacion_config activa para la empresa ${empresaId}.`
    );
  }
  if (!config.cert_pem || !config.key_pem) {
    throw new Error(
      `[wsaa] La empresa ${empresaId} no tiene certificado/clave ARCA cargados ` +
        '(facturacion_config.cert_pem / key_pem vacíos).'
    );
  }

  const tra = construirTRA(service);
  const cms = firmarTRA(tra, config.cert_pem, config.key_pem);
  const { token, sign, expirationTime } = await llamarWSAA(cms, config.homologacion);

  await guardarTokenCacheado(empresaId, { token, sign, expirationTime });

  return { token, sign, expiration: expirationTime };
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
    .select('cert_pem, key_pem, homologacion, activo')
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
