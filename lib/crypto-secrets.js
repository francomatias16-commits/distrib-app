// lib/crypto-secrets.js
// Cifrado simétrico AES-256-GCM para secretos que se guardan en Supabase
// (hoy: cert_pem / key_pem del certificado ARCA por empresa en `facturacion_config`).
//
// Por qué: el plan de comercialización (sección 5.1) exige que el certificado
// AFIP/ARCA de cada cliente NUNCA se almacene en texto plano. Antes de este
// módulo, facturacion_config.cert_pem/key_pem se guardaban como TEXT plano:
// cualquiera con acceso a un dump de la BD (backup, fuga, empleado con acceso
// de soporte en Supabase) podía emitir facturas en nombre del cliente.
//
// Formato de salida: "v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
// El prefijo de versión permite rotar de algoritmo en el futuro sin migrar
// todo de golpe.
//
// Requiere la variable de entorno ARCA_SECRETS_KEY: 32 bytes en hex (64 caracteres).
// Generar una con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH  = 12; // recomendado por la spec de GCM

function obtenerClave() {
  const hex = process.env.ARCA_SECRETS_KEY;
  if (!hex) {
    throw new Error(
      'ARCA_SECRETS_KEY no está configurada. Es obligatoria para cifrar/descifrar ' +
      'certificados ARCA. Generar con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
      'y configurarla en Vercel (production y preview).'
    );
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error('ARCA_SECRETS_KEY inválida: debe ser exactamente 32 bytes en hex (64 caracteres).');
  }
  return buf;
}

/**
 * Cifra un string en texto plano. Devuelve null si el input es null/undefined/vacío
 * (para no romper el flujo de "no se mandó cert nuevo, conservar el anterior").
 */
export function cifrar(textoPlano) {
  if (textoPlano == null || textoPlano === '') return null;

  const key = obtenerClave();
  const iv  = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Descifra un string previamente cifrado con cifrar().
 * Devuelve null si el input es null/undefined/vacío.
 *
 * Compatibilidad hacia atrás: si el valor no tiene el prefijo "v1:" (es decir,
 * es un cert_pem/key_pem viejo guardado en texto plano antes de este fix),
 * se devuelve tal cual. Esto permite migrar datos existentes de forma
 * incremental: el primer guardarConfigARCA() posterior a este deploy ya
 * cifra y reemplaza el valor viejo en texto plano.
 */
export function descifrar(valorAlmacenado) {
  if (valorAlmacenado == null || valorAlmacenado === '') return null;

  if (!valorAlmacenado.startsWith('v1:')) {
    // Valor legado sin cifrar — devolver tal cual para no romper producción
    // mientras se completa la migración de datos existentes.
    return valorAlmacenado;
  }

  const partes = valorAlmacenado.split(':');
  if (partes.length !== 4) {
    throw new Error('Formato de secreto cifrado inválido (se esperaban 4 segmentos).');
  }
  const [, ivHex, authTagHex, ciphertextHex] = partes;

  const key = obtenerClave();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const textoPlano = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return textoPlano.toString('utf8');
}

/** True si el valor ya está cifrado con el formato v1 (útil para scripts de migración). */
export function estaCifrado(valor) {
  return typeof valor === 'string' && valor.startsWith('v1:');
}
