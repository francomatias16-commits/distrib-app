// lib/handlers/fidelizacion.js
// GET  /api/index?_mod=fidelizacion                    → catálogo de recompensas activas + saldo del cliente
// POST /api/index?_mod=fidelizacion&accion=canjear      → canjear una recompensa puntual
//
// Etapa 13, Hallazgo 1 (auditoría UX) — el catálogo de recompensas (admin
// en /admin/fidelizacion.html) era enteramente decorativo: no existía
// ningún handler backend ni pantalla en el portal cliente para canjear.
// Este handler es la mitad "cliente" que faltaba.
//
// Igual que confirmarPedidoHandler (lib/handlers/pedidos.js): el cliente_id
// se deriva SIEMPRE server-side a partir del token de sesión, nunca de un
// valor que mande el navegador — así un cliente no puede canjear puntos de
// otro cliente de la misma empresa.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import {
  obtenerUsuarioPorAuthId,
  obtenerClientePorId,
  obtenerClientePorEmail,
  listarRecompensasActivas,
  obtenerSaldoPuntos,
  canjearRecompensaRpc,
} from '../repos/fidelizacion.js';

// Se mantiene el cliente propio solo para Auth (getUser) — no es acceso a tabla.
const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

// El canje es una operación sensible (mueve puntos reales) — límite más
// estricto que una lectura de catálogo.
const limiterCanjear = rateLimit({ max: 10, windowMs: 60_000 });

/**
 * Autentica el request y devuelve { empresa_id, cliente_id } derivados de
 * la sesión — mismo patrón que confirmarPedidoHandler.
 */
async function resolverClienteDesdeSesion(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No autorizado' }); return null; }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) { res.status(401).json({ error: 'Token inválido' }); return null; }

  const { data: usuarioData, error: usrError } = await obtenerUsuarioPorAuthId(user.id);

  if (usrError || !usuarioData) {
    res.status(403).json({ error: 'Usuario no encontrado' });
    return null;
  }

  if (usuarioData.rol !== 'cliente') {
    res.status(403).json({ error: 'Solo los clientes pueden canjear recompensas' });
    return null;
  }

  const { data: clienteRow, error: cliError } = usuarioData.cliente_id
    ? await obtenerClientePorId(usuarioData.empresa_id, usuarioData.cliente_id)
    : await obtenerClientePorEmail(usuarioData.empresa_id, usuarioData.email);

  if (cliError || !clienteRow) {
    res.status(403).json({ error: 'No se encontró un cliente asociado a esta cuenta' });
    return null;
  }

  if (!clienteRow.activo) {
    res.status(403).json({ error: 'Cliente inactivo. Contacte a la distribuidora.' });
    return null;
  }

  return { empresa_id: usuarioData.empresa_id, cliente_id: clienteRow.id };
}

async function listarCatalogoHandler(req, res, ctx) {
  const { empresa_id, cliente_id } = ctx;

  const hoy = new Date().toISOString().slice(0, 10);

  const [{ data: recompensas, error: errRec }, { data: saldo, error: errSaldo }] = await Promise.all([
    listarRecompensasActivas(empresa_id, hoy),
    obtenerSaldoPuntos(empresa_id, cliente_id),
  ]);

  if (errRec) return errorSeguro(res, errRec, 500, 'No se pudo cargar el catálogo de recompensas.');
  if (errSaldo) return errorSeguro(res, errSaldo, 500, 'No se pudo cargar tu saldo de puntos.');

  // Filtrar acá (no en SQL) las que ya se agotaron por stock — la
  // combinación NULL-permite-infinito hace más simple resolverlo en JS.
  const catalogo = (recompensas || []).filter(r => {
    if (r.cantidad_disponible == null) return true;
    return (r.cantidad_disponible - (r.cantidad_canjeada || 0)) > 0;
  });

  return res.json({
    ok: true,
    puntos_disponibles: saldo?.puntos_disponibles || 0,
    puntos_totales: saldo?.puntos_totales || 0,
    recompensas: catalogo,
  });
}

async function canjearHandler(req, res, ctx) {
  if (await limiterCanjear(req, res)) return;

  const { empresa_id, cliente_id } = ctx;
  const { recompensa_id } = req.body || {};

  if (!recompensa_id) {
    return res.status(400).json({ error: 'Falta indicar qué recompensa querés canjear' });
  }

  const { data, error } = await canjearRecompensaRpc({ empresa_id, cliente_id, recompensa_id });

  if (error) {
    // Los mensajes de canjear_recompensa() ya son seguros para mostrar
    // (saldo insuficiente, recompensa agotada/vencida) — no son detalle
    // interno de infraestructura, así que se los pasamos tal cual al
    // cliente en vez de taparlos con errorSeguro().
    return res.status(400).json({ error: error.message || 'No se pudo canjear la recompensa' });
  }

  return res.json({ ok: true, ...data });
}

export default async function handler(req, res) {
  const ctx = await resolverClienteDesdeSesion(req, res);
  if (!ctx) return; // ya respondió con el error correspondiente

  if (req.method === 'GET') {
    return listarCatalogoHandler(req, res, ctx);
  }

  if (req.method === 'POST' && req.query.accion === 'canjear') {
    return canjearHandler(req, res, ctx);
  }

  return res.status(405).json({ error: 'Método o acción no soportada' });
}
