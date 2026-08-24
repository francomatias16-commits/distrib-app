// lib/solo-lectura.js
// Bloqueo centralizado de mutaciones para usuarios marcados como
// `usuarios.solo_lectura = true` (hoy: únicamente la cuenta demo pública
// de la landing, ver migración 456).
//
// Se resuelve UNA vez en el dispatcher (api/index.js), antes de despachar
// al handler correspondiente, para no tener que tocar los ~35 handlers
// existentes uno por uno. Mismo espíritu que lib/demo-mode.js (punto único
// de verdad), pero a nivel de escritura HTTP en vez de integraciones
// externas.
//
// Diseño de la falla (importante, y al revés de demo-mode.js a propósito):
// si la consulta a `usuarios.solo_lectura` falla por cualquier motivo,
// esta función deja pasar la request (fail-open). Acá el objetivo es
// proteger los datos de la empresa demo compartida, no un límite de
// seguridad crítico sobre datos de un cliente real — y un fail-closed acá
// tumbaría el panel entero de TODOS los clientes reales ante cualquier
// hiccup transitorio de esta consulta puntual. Mismo criterio que
// lib/plan-limits.js.

import jwt from 'jsonwebtoken';
import { crearClienteSupabaseLazy } from './supabase-lazy.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // supabase_user_id -> { soloLectura: boolean, expira: number }

/**
 * Extrae el `sub` (user id) del JWT de Supabase SIN verificar la firma.
 * Es seguro para este uso puntual: acá solo se usa para decidir la clave
 * de cache y hacer un lookup adicional que puede RESTRINGIR, nunca
 * OTORGAR, acceso — la verificación real de identidad la sigue haciendo
 * cada handler vía `verificarToken()` (auth-helpers.js) llamando a
 * `supabase.auth.getUser(token)`, que sí valida la firma contra Supabase.
 * Un token forjado con un `sub` inventado no gana nada acá: como mucho
 * evita este chequeo extra, pero el handler downstream lo va a rechazar
 * igual por no ser un token real.
 */
function subSinVerificar(token) {
  try {
    const payload = jwt.decode(token);
    return payload?.sub || null;
  } catch {
    return null;
  }
}

const METODOS_MUTACION = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Excepción POS (2026-08-21): el visitante demo puede operar la caja de
// verdad — abrir turno, cargar carrito, mover caja, etc. — para poder
// probar la pantalla de venta de punta a punta, en vez de quedarse
// trabado en "Abrir caja". Lo único que se sigue bloqueando es el paso
// que efectivamente cierra/cobra la venta. `cerrar-turno` y
// `forzar-cierre-turno` se dejan pasar a propósito (no van en el set de
// abajo): si se bloquearan, el turno del visitante anterior quedaría
// abierto para siempre y el próximo visitante no podría abrir caja.
const POS_ACCIONES_BLOQUEADAS_EN_DEMO = new Set(['registrar-venta']);

/**
 * Si la request es una mutación de un usuario solo_lectura, responde 403
 * y devuelve `true` (el llamador debe cortar y no seguir al handler).
 * En cualquier otro caso devuelve `false` sin tocar `res`.
 *
 * @param {object} req
 * @param {object} res
 * @returns {Promise<boolean>}
 */
export async function bloquearSiSoloLectura(req, res) {
  if (!METODOS_MUTACION.has(req.method)) return false;

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false; // sin token, el propio handler lo va a rechazar con 401

  try {
    const userId = subSinVerificar(token);
    if (!userId) return false; // token no decodificable — el handler lo rechaza igual

    const cacheado = cache.get(userId);
    let soloLectura;

    if (cacheado && cacheado.expira > Date.now()) {
      soloLectura = cacheado.soloLectura;
    } else {
      const { data: perfil, error: errPerfil } = await supabase
        .from('usuarios')
        .select('solo_lectura')
        .eq('id', userId)
        .single();

      if (errPerfil) {
        console.error('[solo-lectura] Error consultando perfil, se deja pasar por seguridad:', errPerfil.message);
        return false;
      }

      soloLectura = !!perfil?.solo_lectura;
      cache.set(userId, { soloLectura, expira: Date.now() + CACHE_TTL_MS });
    }

    if (soloLectura) {
      const esPos = req.query?._mod === 'pos';
      if (esPos && !POS_ACCIONES_BLOQUEADAS_EN_DEMO.has(req.query?.accion)) {
        return false; // POS: se deja pasar, ver comentario de POS_ACCIONES_BLOQUEADAS_EN_DEMO arriba
      }

      res.status(403).json({
        error: esPos
          ? 'Esta es una demostración: no está habilitado cerrar una venta. Podés abrir caja, cargar productos y armar el carrito libremente.'
          : 'Estás en modo demostración. Podés ver todo el sistema, pero no se pueden guardar cambios.',
        codigo: 'DEMO_SOLO_LECTURA',
      });
      return true;
    }

    return false;
  } catch (err) {
    console.error('[solo-lectura] Error inesperado, se deja pasar por seguridad:', err?.message || err);
    return false;
  }
}
