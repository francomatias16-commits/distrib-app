// lib/handlers/pos-scanner.js
// "Vincular celular": el celular funciona como lector remoto de la compu.
// El usuario abre este vínculo desde la pantalla que corresponda (botón
// "Vincular celular"/"Escanear con celular" — ver CONTEXTOS más abajo),
// escanea el QR con el teléfono, y cada código que el celular lee viaja
// en tiempo real — por un canal de Supabase Realtime Broadcast, SIN pasar
// por este backend — hasta esa pantalla, que lo procesa por el mismo
// camino que ya usa cada una para un código tipeado a mano o leído con
// lector físico.
//
// Este handler solo administra la sesión de vínculo en sí (emitir el
// token, validarlo desde el celular, revocarlo/extenderlo desde la
// compu). Nunca ve los códigos de barra escaneados.
//
// Mismo patrón que chofer_invitacion.js: token de un solo uso, hash sha256
// persistido (nunca el token crudo), tabla con RLS deny-all (migración
// 438/439), toda la autorización resuelta acá con SERVICE_ROLE_KEY.
//
// v617 — generalizado desde "solo POS" a tres contextos (`CONTEXTOS` de
// abajo): cada uno define qué permiso se chequea al generar el token y,
// si corresponde, a qué tabla valida `entidad_id` (caja / depósito). El
// resto del ciclo de vida del vínculo (extender, revocar, validar desde
// el celular) es idéntico para los tres — no hay nada ahí que dependa
// de "ser POS".
//
//  A) ADMIN (requiere sesión — el permiso puntual lo resuelve `CONTEXTOS`)
//     POST ?accion=generar   body:{ contexto, entidad_id? } → nuevo token + URL del QR
//     POST ?accion=revocar   body:{ token }                 → corta el vínculo activo
//     POST ?accion=extender  body:{ token }                 → sliding expiration: empuja
//        expira_at otros DURACION_MINUTOS. Lo llama el lado de la compu
//        cada vez que llega un código, para que un vínculo en uso activo
//        no se corte solo a mitad de sesión — solo "Cerrar vínculo" o la
//        inactividad (nadie escanea nada en DURACION_MINUTOS) lo cierran.
//        No se re-chequea el permiso de `CONTEXTOS` acá a propósito: ya
//        está acotado a esta empresa (mismo tenant) y no expone ni
//        modifica más que la sesión de vínculo en sí.
//
//  B) PÚBLICO (sin login — lo abre la cámara del celular al escanear el QR)
//     GET  ?accion=validar   &t=<token>  → { empresa, contexto, etiqueta, expira_at }
//        o { error, motivo } si el link ya no sirve (usado por /scan-pos
//        para decidir si arranca la cámara o muestra un mensaje — también
//        se re-llama cada vez que el celular vuelve de segundo plano, para
//        detectar un vínculo cerrado desde la compu mientras estaba minimizado).

import crypto from 'crypto';
import { rateLimit } from '../rate-limit.js';
import { verificarToken } from '../auth-helpers.js';
import { puede } from '../permisos-service.js';
import { db } from '../repos/_db.js';
import { errorSeguro } from '../error-response.js';
import { existeDepositoEnEmpresa } from '../repos/stock.js';
import {
  existeCajaActivaEnEmpresa,
  crearTokenScanner,
  revocarTokenScannerPorHash,
  validarTokenScanner,
  extenderTokenScanner,
  limpiarTokensVencidos,
} from '../repos/pos-scanner.js';

const limiterAdmin  = rateLimit({ max: 20, windowMs: 60_000 });
const limiterPublic = rateLimit({ max: 30, windowMs: 60_000 }); // por IP — frena fuerza bruta de tokens

const DURACION_MINUTOS = 45; // sesión de mostrador — no es un link para reusar después

// Qué pantallas pueden pedir un vínculo, quién puede hacerlo, y si el
// contexto necesita una entidad puntual (y cómo se valida). Agregar un
// contexto nuevo es sumar una entrada acá — el resto del handler (hash,
// TTL, canal Realtime, revocar/extender) no cambia.
const CONTEXTOS = {
  pos: {
    // Igual que siempre: solo quien puede vender puede vincular un
    // celular a una caja.
    tienePermiso: (perfil) => puede(perfil, 'vender', 'pos'),
    requiereEntidad: true,
    entidadInvalidaMsg: 'Caja no encontrada o inactiva.',
    async entidadValida(empresa_id, entidad_id) {
      return existeCajaActivaEnEmpresa(empresa_id, entidad_id);
    },
  },
  alta_producto: {
    // Crear/editar productos es una acción de datos maestros — mismo
    // gate que ya usa `maestros.escribir` (categorías, etc.).
    tienePermiso: (perfil) => puede(perfil, 'escribir', 'maestros'),
    requiereEntidad: false,
  },
  ajuste_stock: {
    // Cualquiera que pueda ver/operar stock (dueño/admin/vendedor/
    // depositero, mismo gate que el resto de /api/stock).
    tienePermiso: (perfil) => puede(perfil, 'acceder', 'stock'),
    requiereEntidad: true,
    entidadInvalidaMsg: 'Depósito no encontrado.',
    async entidadValida(empresa_id, entidad_id) {
      return existeDepositoEnEmpresa(entidad_id, empresa_id);
    },
  },
};

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generarTokenCrudo() {
  return crypto.randomBytes(32).toString('base64url');
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  const accion = req.query.accion || '';

  if (accion === 'validar') {
    if (await limiterPublic(req, res)) return;
    return handleValidar(req, res);
  }

  if (await limiterAdmin(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado.' });

  // El permiso específico de "generar" depende del contexto (ver
  // CONTEXTOS) — para revocar/extender no hace falta re-chequearlo, ver
  // nota en el comentario de arriba.
  if (req.method === 'POST' && accion === 'generar')  return handleGenerar(req, res, perfil);
  if (req.method === 'POST' && accion === 'revocar')  return handleRevocar(req, res, perfil);
  if (req.method === 'POST' && accion === 'extender') return handleExtender(req, res, perfil);

  return res.status(404).json({ error: 'Acción no encontrada.' });
}

// ════════════════════════════════════════════════════════════════════════
// A) ADMIN
// ════════════════════════════════════════════════════════════════════════

async function handleGenerar(req, res, perfil) {
  const { empresa_id, id: usuario_id } = perfil;
  const { contexto, entidad_id } = req.body || {};

  const cfg = CONTEXTOS[contexto];
  if (!cfg) return res.status(400).json({ error: 'Contexto de vínculo inválido.' });
  if (!cfg.tienePermiso(perfil)) {
    return res.status(403).json({ error: 'Sin permisos para esta acción.' });
  }

  if (cfg.requiereEntidad) {
    if (!entidad_id) return res.status(400).json({ error: 'Falta el dato requerido para este vínculo.' });
    const entidadValida = await cfg.entidadValida(empresa_id, entidad_id);
    if (!entidadValida) return res.status(404).json({ error: cfg.entidadInvalidaMsg });
  }

  // Best-effort — no debe frenar la generación del token nuevo.
  limpiarTokensVencidos(empresa_id).catch(() => {});

  try {
    const tokenCrudo = generarTokenCrudo();
    const expira_at = new Date(Date.now() + DURACION_MINUTOS * 60_000).toISOString();

    await crearTokenScanner({
      empresa_id,
      contexto,
      entidad_id: cfg.requiereEntidad ? entidad_id : null,
      creado_por: usuario_id,
      token_hash: hashToken(tokenCrudo),
      expira_at,
    });

    // El token crudo se devuelve UNA sola vez acá — el front lo usa para
    // armar la URL del QR y para derivar el nombre del canal Realtime
    // (mismo token de ambos lados, sin volver a pedirlo al backend).
    return res.json({
      token: tokenCrudo,
      url: `${baseUrl(req)}/scan-pos?t=${encodeURIComponent(tokenCrudo)}`,
      expira_at,
    });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo generar el vínculo con el celular.');
  }
}

async function handleExtender(req, res, perfil) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token requerido.' });

  try {
    const nuevaExpiraAt = new Date(Date.now() + DURACION_MINUTOS * 60_000).toISOString();
    const r = await extenderTokenScanner(perfil.empresa_id, hashToken(token), nuevaExpiraAt);
    if (!r) {
      // Ya estaba revocado o vencido — no hay nada que extender. El front
      // interpreta esto igual que un vínculo muerto (deja de reintentar).
      return res.status(410).json({ error: 'El vínculo ya no está activo.' });
    }
    return res.json({ ok: true, expira_at: r.expira_at });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo renovar el vínculo.');
  }
}

async function handleRevocar(req, res, perfil) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token requerido.' });

  try {
    await revocarTokenScannerPorHash(perfil.empresa_id, hashToken(token));
    return res.json({ ok: true });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo cortar el vínculo.');
  }
}

// ════════════════════════════════════════════════════════════════════════
// B) PÚBLICO — lo consume /scan-pos (frontend/scan-pos/portal.js)
// ════════════════════════════════════════════════════════════════════════

const MOTIVOS_PUBLICOS = {
  no_encontrado: 'Este link no es válido.',
  revocado: 'Este vínculo se cerró desde la caja.',
  expirado: 'Este vínculo venció. Generá uno nuevo desde la caja.',
};

async function handleValidar(req, res) {
  const token = req.query.t;
  if (!token) return res.status(400).json({ error: 'Falta el código de la URL.' });

  try {
    const r = await validarTokenScanner(hashToken(token));
    if (!r || !r.valido) {
      const motivo = r?.motivo || 'no_encontrado';
      return res.status(410).json({ error: MOTIVOS_PUBLICOS[motivo] || 'Este link no es válido.', motivo });
    }

    return res.json({
      empresa: r.empresa_nombre,
      contexto: r.contexto,
      etiqueta: r.etiqueta, // caja (pos) o depósito (ajuste_stock); null en alta_producto
      expira_at: r.expira_at,
    });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo validar el link.');
  }
}
