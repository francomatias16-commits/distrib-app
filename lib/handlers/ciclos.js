// lib/handlers/ciclos.js
// REQ-07: Pedido Habitual por WhatsApp visible desde la ficha de cliente.
//
// Rutas:
//   GET  /api/ciclos?cliente_id=X           → ciclos + pedido sugerido pendiente
//   POST /api/ciclos?accion=enviar-sugerencia  { cliente_id }  → envía WhatsApp (bypass cooldown manual)
//   POST /api/ciclos?accion=descartar-sugerencia { pedido_id } → cancela el sugerido

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { getUserSeguro } from '../auth-helpers.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { obtenerEmpresaYRolPorAuthId } from '../repos/usuarios.js';
import {
  listarCiclosActivosDeCliente,
  buscarPedidoSugeridoReciente,
  obtenerUltimaNotifSugerencia,
  obtenerClienteParaSugerencia,
  generarPedidoSugeridoClienteRpc,
  listarItemsDePedido,
  registrarNotifSugerenciaRpc,
  descartarPedidoSugerido,
} from '../repos/ciclos.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

// Se mantiene el cliente propio solo para Auth (getUser) — no es acceso a tabla.
const sb = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export default async function handler(req, res) {
  // ── Rate limiting ──────────────────────────────────────────────────
  if (await limiter(req, res)) return;

  // ── Auth: empresa_id se resuelve SIEMPRE desde el JWT, nunca desde
  //    un header enviado por el cliente (evita IDOR cross-tenant) ────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await getUserSeguro(sb, token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerEmpresaYRolPorAuthId(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'ciclos')) {
    return res.status(403).json({ error: 'Acceso solo para administradores' });
  }

  const empresa_id = perfil.empresa_id;

  // ── GET: ciclos del cliente + sugerido pendiente ──────────────────────────
  if (req.method === 'GET') {
    const { cliente_id } = req.query;
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido' });

    // Ciclos activos del cliente
    const { data: ciclos, error: eCiclos } = await listarCiclosActivosDeCliente(empresa_id, cliente_id);

    if (eCiclos) return errorSeguro(res, eCiclos, 500, 'No se pudo completar la operación.');

    const desdeIso = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

    // Pedido sugerido pendiente para este cliente (si existe)
    const sugeridos = await buscarPedidoSugeridoReciente(empresa_id, cliente_id, desdeIso);

    // Último envío de sugerencia (para mostrar "Última vez enviado: X días")
    const ultimaNotif = await obtenerUltimaNotifSugerencia(empresa_id, cliente_id);

    return res.json({
      ciclos: ciclos ?? [],
      sugerido: sugeridos?.[0] ?? null,
      ultima_notif: ultimaNotif?.[0]?.created_at ?? null
    });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const accion = req.query.accion;
    const body   = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // ── Enviar sugerencia por WhatsApp (bypass cooldown manual) ──────────
    if (accion === 'enviar-sugerencia') {
      const { cliente_id } = body;
      if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido' });

      // Obtener datos del cliente
      const cliente = await obtenerClienteParaSugerencia(empresa_id, cliente_id);

      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      if (!cliente.telefono) return res.status(400).json({ error: 'El cliente no tiene teléfono registrado' });

      const desdeIso = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

      // Obtener el pedido sugerido más reciente (en las últimas 36h)
      const pedidos = await buscarPedidoSugeridoReciente(empresa_id, cliente_id, desdeIso);

      // Si no hay sugerido en las últimas 36h, generarlo ahora
      let pedidoId = pedidos?.[0]?.id;
      let items    = pedidos?.[0]?.pedido_items ?? [];

      if (!pedidoId) {
        // Generar sugerido para este cliente específico usando la función existente
        const { data: gen } = await generarPedidoSugeridoClienteRpc(empresa_id, cliente_id);
        // Si la función no existe aún, fallback: buscar ciclos activos
        if (!gen?.pedido_id) {
          return res.status(409).json({
            error: 'No hay pedido habitual pendiente para este cliente',
            detalle: 'El cliente no tiene ciclos con vencimiento próximo'
          });
        }
        pedidoId = gen.pedido_id;
        // Recargar items
        const p2 = await listarItemsDePedido(pedidoId);
        items = p2 ?? [];
      }

      // Armar mensaje WhatsApp
      const nombreCliente = cliente.nombre_fantasia || cliente.razon_social;
      const lineasItems = items
        .map(it => `• ${it.productos?.nombre ?? 'Producto'} × ${it.cantidad} ${it.productos?.unidad ?? ''}`.trim())
        .join('\n');

      const mensaje = encodeURIComponent(
        `Hola ${nombreCliente}!\n\n` +
        `Según su historial de compras, armamos su pedido habitual:\n\n` +
        `${lineasItems}\n\n` +
        `¿Lo confirmamos? Responda SÍ para procesarlo o avísenos si quiere ajustar algo.`
      );

      // Registrar en notif_log (bypass cooldown: se registra aunque ya haya una hoy)
      await registrarNotifSugerenciaRpc({
        empresa_id,
        cliente_id,
        pedido_id:  pedidoId,
        telefono:   cliente.telefono,
        message_id: `manual_${Date.now()}`,
        payload:    { modo: 'manual', items_count: items.length }
      });

      const waUrl = `https://wa.me/${cliente.telefono.replace(/\D/g, '')}?text=${mensaje}`;
      return res.json({ ok: true, wa_url: waUrl, pedido_id: pedidoId });
    }

    // ── Descartar sugerencia ────────────────────────────────────────────────
    if (accion === 'descartar-sugerencia') {
      const { pedido_id } = body;
      if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });

      const { error } = await descartarPedidoSugerido(empresa_id, pedido_id);

      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: `Acción desconocida: ${accion}` });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
