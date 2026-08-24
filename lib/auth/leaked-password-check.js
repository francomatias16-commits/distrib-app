// lib/auth/leaked-password-check.js
//
// Reemplazo casero de "Prevent use of leaked passwords" de Supabase Auth,
// que solo está disponible en plan Pro y superior (ver
// AUDITORIA_PRE_LANZAMIENTO.md sección 3 — el proyecto está en Free).
//
// Usa la API pública de HaveIBeenPwned (Pwned Passwords), gratuita y sin
// API key, con el protocolo k-anonymity: nunca mandamos la contraseña ni
// su hash completo a un tercero. Solo los primeros 5 caracteres del SHA-1
// viajan por la red; HIBP devuelve todos los sufijos que matchean ese
// prefijo (cientos) y comparamos localmente.
// Docs: https://haveibeenpwned.com/API/v3#PwnedPasswords
//
// Uso: llamar ANTES de auth.admin.createUser / auth.admin.updateUserById
// en cualquier flujo donde el usuario elige su propia contraseña
// (registro público, alta de usuario interno, cambio/reset de contraseña).
//
// No se aplica (a propósito) al alta de usuarios del portal cliente vía
// WhatsApp con contraseña autogenerada por el sistema — esas no las elige
// la persona, así que no hay "reutilización de contraseña filtrada" que
// prevenir ahí.

import crypto from 'crypto';

const HIBP_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 3000;

/**
 * Verifica una contraseña contra el dataset de HaveIBeenPwned.
 *
 * @param {string} password
 * @returns {Promise<{ pwned: boolean, count: number, checkFailed: boolean }>}
 *   - pwned: true si apareció en algún leak conocido
 *   - count: cantidad de veces vista en leaks (0 si no está o si falló el chequeo)
 *   - checkFailed: true si no se pudo consultar HIBP (timeout, red caída, etc.)
 *     — en ese caso `pwned` siempre es false: preferimos no ser el motivo de
 *     que un signup falle por un problema nuestro de red, mismo criterio que
 *     Supabase Auth documenta para su propia integración con HIBP.
 */
export async function verificarPasswordFiltrada(password) {
  if (typeof password !== 'string' || !password) {
    return { pwned: false, count: 0, checkFailed: false };
  }

  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefijo = sha1.slice(0, 5);
  const sufijoBuscado = sha1.slice(5);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(HIBP_URL + prefijo, {
      headers: { 'Add-Padding': 'true' }, // mitiga análisis de tamaño de respuesta
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      console.error('[LEAKED-PW-CHECK] HIBP respondió', resp.status);
      return { pwned: false, count: 0, checkFailed: true };
    }

    const texto = await resp.text();
    for (const linea of texto.split('\n')) {
      const [sufijo, cantidadStr] = linea.trim().split(':');
      if (sufijo === sufijoBuscado) {
        return { pwned: true, count: parseInt(cantidadStr, 10) || 0, checkFailed: false };
      }
    }
    return { pwned: false, count: 0, checkFailed: false };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[LEAKED-PW-CHECK] Error consultando HIBP:', err.message);
    return { pwned: false, count: 0, checkFailed: true };
  }
}

/**
 * Helper de conveniencia para handlers: si la contraseña está filtrada,
 * devuelve el objeto de error listo para responder con res.status(400).json(...).
 * Si no está filtrada (o no se pudo chequear), devuelve null.
 *
 * @param {string} password
 * @returns {Promise<{ error: string } | null>}
 */
export async function chequearPasswordONull(password) {
  const { pwned, count } = await verificarPasswordFiltrada(password);
  if (pwned) {
    return {
      error: count > 0
        ? `Esa contraseña apareció en ${count.toLocaleString('es-AR')} filtraciones de datos conocidas. Elegí otra.`
        : 'Esa contraseña apareció en filtraciones de datos conocidas. Elegí otra.',
    };
  }
  return null;
}
