// api/busqueda/index.js
// REQ-09: Búsqueda global en header admin
// GET /api/busqueda?q=texto   → clientes, productos, pedidos, presupuestos, facturas, cheques

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { rateLimit } from '../rate-limit.js';
import { buscarProductos } from '../repos/productos.js';
import { obtenerEmpresaYRolPorAuthId } from '../repos/usuarios.js';
import {
  buscarClientes,
  buscarPedidosPorIdParcial,
  buscarPresupuestos,
  buscarFacturas,
  buscarCheques,
} from '../repos/busqueda.js';
import { puede } from '../permisos-service.js';

// Se mantiene el cliente propio solo para Auth (getUser) — no es acceso a tabla.
const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

const limiter     = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  if (await limiter(req, res)) return;

  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Método no permitido' });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerEmpresaYRolPorAuthId(user.id);

  if (!perfil || !puede(perfil, 'buscar', 'busqueda'))
    return res.status(403).json({ error: 'Sin permisos' });

  const empresa_id = perfil.empresa_id;
  const q = (req.query.q || '').trim();

  if (q.length < 2)
    return res.json({ clientes: [], productos: [], pedidos: [], presupuestos: [], facturas: [], cheques: [] });

  // Auditoría Etapa 2 (v232, hallazgo Medio): q se interpolaba crudo dentro
  // del string de filtro .or() de PostgREST, sin escapar los caracteres
  // reservados de esa sintaxis ( , ( ) * ). Un q armado con esos caracteres
  // podía alterar qué condiciones se evalúan dentro del .or() y devolver
  // resultados no buscados intencionalmente. No es cross-tenant (empresa_id
  // sigue aplicado por separado con .eq()), pero igual se neutraliza acá.
  const escaparFiltroPostgrest = (valor) =>
    valor.replace(/[,()*]/g, (c) => '\\' + c);

  const qEscapado = escaparFiltroPostgrest(q);
  const like = `%${qEscapado}%`;
  const esNumero = /^\d/.test(q);

  // ── Búsquedas en paralelo ─────────────────────────────────────────────────
  const [clientes, productos, pedidos, presupuestos, facturas, cheques] = await Promise.all([
    buscarClientes(empresa_id, like),
    // Productos por código o nombre — ya vivía en lib/repos/productos.js
    buscarProductos(empresa_id, { like, limit: 5 }),
    buscarPedidosPorIdParcial(empresa_id, q),
    buscarPresupuestos(empresa_id, like),
    buscarFacturas(empresa_id, like),
    buscarCheques(empresa_id, like),
  ]);

  return res.json({ clientes, productos, pedidos, presupuestos, facturas, cheques });
}
