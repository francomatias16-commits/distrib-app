// lib/handlers/reglas-precio.js
// GET    /api/reglas-precio               → lista de reglas (filtros: activa, busqueda)
// POST   /api/reglas-precio                → crear regla
// PATCH  /api/reglas-precio?id=uuid        → editar regla
// POST   /api/reglas-precio?_svc=toggle    → activar/desactivar { id, activa }
// DELETE /api/reglas-precio?id=uuid        → eliminar regla
//
// Etapa 2 del plan por etapas (Comercial y precios), ítem 1: UI de
// administración de `reglas_precio` (tabla creada en la migración
// 243_etapa2_motor_reglas_precio.sql, que hasta ahora no tenía pantalla).

import { rateLimit } from '../rate-limit.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import {
  listarReglasPrecio,
  crearReglaPrecio,
  actualizarReglaPrecio,
  toggleActivaReglaPrecio,
  eliminarReglaPrecio,
} from '../repos/reglas-precio.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  if (await limiter(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil || !puede(perfil, 'leer', 'reglas_precio')) {
    return res.status(perfil ? 403 : 401).json({
      error: perfil ? 'Sin permiso para ver reglas de precio' : 'No autorizado',
    });
  }

  const { empresa_id } = perfil;
  const esEscritor = puede(perfil, 'escribir', 'reglas_precio');

  // ── GET: listado ─────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { activa, busqueda } = req.query;
    try {
      const data = await listarReglasPrecio(empresa_id, { activa, busqueda });
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  if (!esEscritor) {
    return res.status(403).json({ error: 'Solo dueño, admin o contador pueden modificar reglas de precio' });
  }

  // ── POST ?_svc=toggle: activar/desactivar sin borrar ───────────────────
  if (req.method === 'POST' && req.query?._svc === 'toggle') {
    const { id, activa } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });
    try {
      const data = await toggleActivaReglaPrecio(empresa_id, id, activa);
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── POST: crear ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const data = await crearReglaPrecio(empresa_id, req.body || {});
      return res.status(201).json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── PATCH: editar ───────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query?.id || req.body?.id;
    if (!id) return res.status(400).json({ error: 'id requerido' });
    try {
      const data = await actualizarReglaPrecio(empresa_id, id, req.body || {});
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── DELETE: eliminar ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });
    try {
      await eliminarReglaPrecio(empresa_id, id);
      return res.json({ ok: true });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
