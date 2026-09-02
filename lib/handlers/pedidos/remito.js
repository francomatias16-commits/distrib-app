// lib/handlers/pedidos/remito.js
// Remito NRO (absorto desde api/remito-nro/index.js). Extraído de
// lib/handlers/pedidos.js (25/08/2026).

import { crearClienteSupabaseLazy } from '../../supabase-lazy.js';
import { getUserSeguro } from '../../auth-helpers.js';
import * as AuditRepo from '../../repos/audit.js';
import { errorSeguro } from '../../error-response.js';
import { puede } from '../../permisos-service.js';
import {
  obtenerPedidoParaRemitoNro,
  obtenerPerfilParaRemitoNro,
  reservarRemitoNroRpc,
} from '../../repos/pedidos.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export async function handleRemitoNro(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // ── Auth ──────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilParaRemitoNro(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'remitos'))
    return res.status(403).json({ error: 'Sin permisos' });

  const { pedido_id } = req.body;
  if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });

  // Verificar que el pedido pertenece a la empresa
  const ped = await obtenerPedidoParaRemitoNro(perfil.empresa_id, pedido_id);

  if (!ped) return res.status(404).json({ error: 'Pedido no encontrado' });

  // Llamar RPC que maneja la numeración atómica
  const { data: nro, error } = await reservarRemitoNroRpc(perfil.empresa_id, pedido_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  await AuditRepo.registrarAuditoriaSilenciosa(
    perfil.empresa_id, perfil.id, 'pedidos', 'UPDATE', pedido_id, null, { remito_nro: nro }
  );

  return res.json({ remito_nro: nro });
}
