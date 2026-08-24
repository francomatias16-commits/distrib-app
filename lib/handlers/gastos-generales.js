// lib/handlers/gastos-generales.js
// GET    /api/gastos-generales                         → lista (filtros: activo, categoria, desde, hasta, busqueda)
// GET    /api/gastos-generales?id=uuid                  → detalle
// GET    /api/gastos-generales?_svc=resumen&desde&hasta → resumen del período (RPC 479)
// POST   /api/gastos-generales                          → crear
// PATCH  /api/gastos-generales?id=uuid                  → editar
// DELETE /api/gastos-generales?id=uuid                  → eliminar (soft-delete, activo=false)
//
// Migración 479 — pieza que faltaba para que Ganancia Neta (Reportes →
// Finanzas) reste los gastos fijos del negocio, no solo el costo de
// producto vendido. Mismo patrón CRUD que reglas-precio.js, con auditoría
// silenciosa igual que maestros.js.

import { rateLimit } from '../rate-limit.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { AuditRepo } from '../repos/index.js';
import {
  listarGastosGenerales,
  obtenerGastoGeneral,
  obtenerResumenGastosGenerales,
  crearGastoGeneral,
  actualizarGastoGeneral,
  eliminarGastoGeneral,
} from '../repos/gastos-generales.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  if (await limiter(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil || !puede(perfil, 'leer', 'gastos_generales')) {
    return res.status(perfil ? 403 : 401).json({
      error: perfil ? 'Sin permiso para ver gastos generales' : 'No autorizado',
    });
  }

  const { empresa_id } = perfil;
  const esEscritor = puede(perfil, 'escribir', 'gastos_generales');

  // ── GET ?_svc=resumen: total + desglose por categoría del período ──────
  if (req.method === 'GET' && req.query?._svc === 'resumen') {
    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta son requeridos' });
    try {
      const data = await obtenerResumenGastosGenerales(empresa_id, { desde, hasta });
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── GET ?id=uuid: detalle ────────────────────────────────────────────
  if (req.method === 'GET' && req.query?.id) {
    try {
      const data = await obtenerGastoGeneral(empresa_id, req.query.id);
      return res.json(data);
    } catch (err) {
      return res.status(404).json({ error: 'No encontrado' });
    }
  }

  // ── GET: listado ─────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { activo, categoria, desde, hasta, busqueda } = req.query;
    try {
      const data = await listarGastosGenerales(empresa_id, { activo, categoria, desde, hasta, busqueda });
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  if (!esEscritor) {
    return res.status(403).json({ error: 'Solo dueño, admin o contador pueden modificar gastos generales' });
  }

  // ── POST: crear ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const data = await crearGastoGeneral(empresa_id, perfil.id, req.body || {});
      await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, perfil.id, 'gastos_generales', 'INSERT', data.id, null, data);
      return res.status(201).json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo crear el gasto.');
    }
  }

  // ── PATCH: editar ───────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query?.id || req.body?.id;
    if (!id) return res.status(400).json({ error: 'id requerido' });
    try {
      const { antes, despues } = await actualizarGastoGeneral(empresa_id, id, req.body || {});
      await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, perfil.id, 'gastos_generales', 'UPDATE', id, antes, despues);
      return res.json(despues);
    } catch (err) {
      if (err.message === 'No encontrado') return res.status(404).json({ error: err.message });
      return errorSeguro(res, err, 400, 'No se pudo guardar el cambio.');
    }
  }

  // ── DELETE: eliminar (soft-delete) ──────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });
    try {
      const { antes } = await eliminarGastoGeneral(empresa_id, id);
      await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, perfil.id, 'gastos_generales', 'UPDATE', id, antes, { activo: false });
      return res.json({ ok: true });
    } catch (err) {
      if (err.message === 'No encontrado') return res.status(404).json({ error: err.message });
      return errorSeguro(res, err, 500, 'No se pudo eliminar el gasto.');
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
