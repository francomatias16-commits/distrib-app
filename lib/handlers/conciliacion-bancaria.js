// lib/handlers/conciliacion-bancaria.js
// GET    /api/conciliacion-bancaria                        → lista de lotes
// GET    /api/conciliacion-bancaria?lote_id=uuid            → movimientos del lote + candidatos
// POST   /api/conciliacion-bancaria                         → crear lote + movimientos { nombre_archivo, movimientos:[...] }
// POST   /api/conciliacion-bancaria?_svc=auto               → auto-conciliar lote { lote_id }
// POST   /api/conciliacion-bancaria?_svc=confirmar          → confirmar match { movimiento_id, cobro_id }
// POST   /api/conciliacion-bancaria?_svc=deshacer           → deshacer match { movimiento_id }
// POST   /api/conciliacion-bancaria?_svc=descartar          → descartar movimiento { movimiento_id }
// DELETE /api/conciliacion-bancaria?lote_id=uuid             → eliminar lote (y sus movimientos)
//
// Etapa 3 del plan por etapas (Cobranzas y riesgo financiero): conciliación
// bancaria automática contra el extracto importado (tabla creada en
// 248_etapa3_conciliacion_bancaria.sql).

import { rateLimit } from '../rate-limit.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import {
  crearLoteConMovimientos,
  listarLotes,
  eliminarLote,
  listarMovimientos,
  confirmarMatch,
  deshacerMatch,
  autoMatchearLote,
  descartarMovimiento,
} from '../repos/conciliacion-bancaria.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

const TIPOS_VALIDOS = ['credito', 'debito'];

function validarMovimientos(movimientos) {
  if (!Array.isArray(movimientos) || !movimientos.length) {
    throw new Error('No hay movimientos para importar');
  }
  for (const [i, m] of movimientos.entries()) {
    if (!m.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(String(m.fecha))) {
      throw new Error(`Fila ${i + 1}: fecha inválida (esperado AAAA-MM-DD)`);
    }
    if (m.monto === undefined || m.monto === null || Number(m.monto) <= 0) {
      throw new Error(`Fila ${i + 1}: monto inválido`);
    }
    if (!TIPOS_VALIDOS.includes(m.tipo)) {
      throw new Error(`Fila ${i + 1}: tipo debe ser "credito" o "debito"`);
    }
  }
}

export default async function handler(req, res) {
  if (await limiter(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil || !puede(perfil, 'leer', 'conciliacion_bancaria')) {
    return res.status(perfil ? 403 : 401).json({
      error: perfil ? 'Sin permiso para ver conciliación bancaria' : 'No autorizado',
    });
  }

  const { empresa_id } = perfil;
  const esEscritor = puede(perfil, 'escribir', 'conciliacion_bancaria');

  // ── GET: lotes o movimientos de un lote ────────────────────────────
  if (req.method === 'GET') {
    try {
      const { lote_id, estado } = req.query;
      if (lote_id) {
        const data = await listarMovimientos(empresa_id, lote_id, { estado });
        return res.json(data);
      }
      const data = await listarLotes(empresa_id);
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  if (!esEscritor) {
    return res.status(403).json({ error: 'Solo dueño, admin o contador pueden operar la conciliación bancaria' });
  }

  // ── POST ?_svc=auto: auto-conciliar matches únicos y exactos ───────
  if (req.method === 'POST' && req.query?._svc === 'auto') {
    const { lote_id } = req.body || {};
    if (!lote_id) return res.status(400).json({ error: 'lote_id requerido' });
    try {
      const data = await autoMatchearLote(empresa_id, lote_id, perfil.id);
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── POST ?_svc=confirmar: confirmar match manual ────────────────────
  if (req.method === 'POST' && req.query?._svc === 'confirmar') {
    const { movimiento_id, cobro_id } = req.body || {};
    if (!movimiento_id || !cobro_id) {
      return res.status(400).json({ error: 'movimiento_id y cobro_id son requeridos' });
    }
    try {
      const data = await confirmarMatch(empresa_id, movimiento_id, cobro_id, perfil.id);
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── POST ?_svc=deshacer: revertir un match ──────────────────────────
  if (req.method === 'POST' && req.query?._svc === 'deshacer') {
    const { movimiento_id } = req.body || {};
    if (!movimiento_id) return res.status(400).json({ error: 'movimiento_id requerido' });
    try {
      const data = await deshacerMatch(empresa_id, movimiento_id);
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── POST ?_svc=descartar: marcar movimiento como no conciliable ────
  if (req.method === 'POST' && req.query?._svc === 'descartar') {
    const { movimiento_id } = req.body || {};
    if (!movimiento_id) return res.status(400).json({ error: 'movimiento_id requerido' });
    try {
      const data = await descartarMovimiento(empresa_id, movimiento_id);
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── POST: crear lote + movimientos (importar extracto ya parseado) ─
  if (req.method === 'POST') {
    const { nombre_archivo, movimientos } = req.body || {};
    try {
      validarMovimientos(movimientos);
      const data = await crearLoteConMovimientos(empresa_id, perfil.id, nombre_archivo, movimientos);
      return res.status(201).json(data);
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }

  // ── DELETE: eliminar lote ───────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { lote_id } = req.query;
    if (!lote_id) return res.status(400).json({ error: 'lote_id requerido' });
    try {
      await eliminarLote(empresa_id, lote_id);
      return res.json({ ok: true });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
