// lib/handlers/reglas-automatizacion.js
// GET    /api/reglas-automatizacion               → lista de reglas (filtros: activa, evento_disparador)
// POST   /api/reglas-automatizacion                → crear regla
// PATCH  /api/reglas-automatizacion?id=uuid        → editar regla
// POST   /api/reglas-automatizacion?_svc=toggle    → activar/desactivar { id, activa }
// DELETE /api/reglas-automatizacion?id=uuid        → eliminar regla
//
// GET    /api/reglas-automatizacion?_svc=tareas             → tareas pendientes para MI rol
// POST   /api/reglas-automatizacion?_svc=tareas-completar    → completar { id } (cualquier rol interno)
//
// Fase 6 de PLAN_ERP_SINCRONIZACION_2026.md: administración de las reglas
// que el propio cliente arma desde automatizacion.html ("Reglas
// personalizadas"). El motor que las evalúa/ejecuta en tiempo real vive
// en lib/reglas-automatizacion.js, llamado desde eventos-dispatcher.js —
// este handler es solo el ABM.

import { rateLimit } from '../rate-limit.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import {
  listarReglasAutomatizacion,
  crearReglaAutomatizacion,
  actualizarReglaAutomatizacion,
  toggleActivaReglaAutomatizacion,
  eliminarReglaAutomatizacion,
  listarTareasAutomatizacion,
  completarTareaAutomatizacion,
  EVENTOS_DISPONIBLES,
} from '../repos/reglas-automatizacion.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  if (await limiter(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // ── Tareas (_svc=tareas / _svc=tareas-completar) — cualquier rol
  // interno, se resuelve antes del gate dueño/admin de las reglas. ────
  if (req.query?._svc === 'tareas' || req.query?._svc === 'tareas-completar') {
    const accionTareas = req.query._svc === 'tareas' ? 'leer' : 'completar';
    if (!puede(perfil, accionTareas, 'tareas_automatizacion')) {
      return res.status(403).json({ error: 'Sin permiso para ver las tareas de automatización' });
    }

    if (req.query._svc === 'tareas' && req.method === 'GET') {
      try {
        const data = await listarTareasAutomatizacion(perfil.empresa_id, perfil.rol, perfil.id);
        return res.json({ tareas: data });
      } catch (err) {
        return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
      }
    }

    if (req.query._svc === 'tareas-completar' && req.method === 'POST') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requerido' });
      try {
        const data = await completarTareaAutomatizacion(perfil.empresa_id, id, perfil.id);
        return res.json(data);
      } catch (err) {
        return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
      }
    }

    return res.status(405).json({ error: 'Método no permitido' });
  }

  if (!puede(perfil, 'leer', 'reglas_automatizacion')) {
    return res.status(403).json({ error: 'Sin permiso para ver reglas de automatización' });
  }

  const { empresa_id } = perfil;
  const esEscritor = puede(perfil, 'escribir', 'reglas_automatizacion');

  // ── GET: listado (+ catálogo de eventos disponibles para el form) ─────
  if (req.method === 'GET') {
    const { activa, evento_disparador } = req.query;
    try {
      const data = await listarReglasAutomatizacion(empresa_id, { activa, evento_disparador });
      return res.json({ reglas: data, eventos_disponibles: EVENTOS_DISPONIBLES });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  if (!esEscritor) {
    return res.status(403).json({ error: 'Solo dueño o admin pueden modificar reglas de automatización' });
  }

  // ── POST ?_svc=toggle: activar/desactivar sin borrar ───────────────────
  if (req.method === 'POST' && req.query?._svc === 'toggle') {
    const { id, activa } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });
    try {
      const data = await toggleActivaReglaAutomatizacion(empresa_id, id, activa);
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── POST: crear ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const data = await crearReglaAutomatizacion(empresa_id, req.body || {});
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
      const data = await actualizarReglaAutomatizacion(empresa_id, id, req.body || {});
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
      await eliminarReglaAutomatizacion(empresa_id, id);
      return res.json({ ok: true });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
