// lib/handlers/maestros.js
// ABM de datos maestros por empresa: zonas de reparto, depósitos,
// listas de precio y categorías. Antes de esto, estas 4 tablas se leían
// desde media docena de pantallas (productos, clientes, reglas de precio,
// pedidos, reportes) pero no existía forma de crear/editar/dar de baja
// un registro desde la interfaz — solo se podían cargar a mano por SQL.
//
// GET    /api/maestros?recurso=<r>            → lista (filtro ?activa=true|false|'')
// GET    /api/maestros?recurso=<r>&id=uuid     → detalle
// POST   /api/maestros?recurso=<r>            → crear
// PATCH  /api/maestros?recurso=<r>            → editar (body.id requerido)
// DELETE /api/maestros?recurso=<r>&id=uuid     → dar de baja (soft-delete: activa=false)
//
// <r> ∈ {'zonas', 'depositos', 'listas-precios', 'categorias'}
//
// Migrado a capa de repos (lib/repos/maestros.js): la config por recurso
// (RECURSOS), las reglas de "único" (principal/default) y de baja viven
// ahora en el repo. Acá solo queda auth + mapeo HTTP, mismo patrón que
// reglas-precio.js.

import { rateLimit } from '../rate-limit.js';
import { verificarToken } from '../auth-helpers.js';
import { AuditRepo } from '../repos/index.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { db } from '../repos/_db.js';
import {
  RECURSOS,
  listarMaestros,
  obtenerMaestro,
  crearMaestro,
  actualizarMaestro,
  eliminarMaestro,
} from '../repos/maestros.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  if (await limiter(req, res)) return;

  if (!RECURSOS[req.query.recurso])
    return res.status(400).json({ error: 'recurso inválido. Usá: zonas, depositos, listas-precios o categorias' });

  const perfil = await verificarToken(req, db);
  if (!perfil || !puede(perfil, 'leer', 'maestros')) {
    return res.status(perfil ? 403 : 401).json({
      error: perfil ? 'Sin permisos' : 'No autorizado',
    });
  }

  const { empresa_id } = perfil;
  const esEscritor = puede(perfil, 'escribir', 'maestros');
  const recurso = req.query.recurso;

  // ── GET ─────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { id, activa } = req.query;
    try {
      if (id) {
        const data = await obtenerMaestro(recurso, empresa_id, id);
        return res.json(data);
      }
      const data = await listarMaestros(recurso, empresa_id, { activa });
      return res.json({ data });
    } catch (err) {
      if (err.message === 'No encontrado') return res.status(404).json({ error: err.message });
      return errorSeguro(res, err, 500, 'No se pudo obtener el listado.');
    }
  }

  if (!esEscritor) return res.status(403).json({ error: 'Solo dueño/admin puede modificar este dato' });

  // ── POST: crear ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const data = await crearMaestro(recurso, empresa_id, req.body || {});
      await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, perfil.id, RECURSOS[recurso].tabla, 'INSERT', data.id, null, data);
      return res.status(201).json(data);
    } catch (err) {
      return errorSeguro(res, err, err.message === 'Nombre requerido' ? 400 : 500, 'No se pudo crear el registro.');
    }
  }

  // ── PATCH: editar ───────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, ...cambios } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });
    try {
      const { antes, despues } = await actualizarMaestro(recurso, empresa_id, id, cambios);
      await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, perfil.id, RECURSOS[recurso].tabla, 'UPDATE', id, antes, despues);
      return res.json(despues);
    } catch (err) {
      if (err.message === 'No encontrado') return res.status(404).json({ error: err.message });
      if (err.message === 'id requerido' || err.message === 'Nombre requerido' || err.message.startsWith('No podés') || err.message.startsWith('Este registro'))
        return res.status(400).json({ error: err.message });
      return errorSeguro(res, err, 500, 'No se pudo guardar el cambio.');
    }
  }

  // ── DELETE: soft-delete (activa=false) ─────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });
    try {
      const { antes } = await eliminarMaestro(recurso, empresa_id, id);
      await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, perfil.id, RECURSOS[recurso].tabla, 'UPDATE', id, antes, { activa: false });
      return res.json({ ok: true });
    } catch (err) {
      if (err.message === 'No encontrado') return res.status(404).json({ error: err.message });
      if (err.message.startsWith('No podés') || err.message.startsWith('Este registro'))
        return res.status(400).json({ error: err.message });
      return errorSeguro(res, err, 500, 'No se pudo dar de baja.');
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
