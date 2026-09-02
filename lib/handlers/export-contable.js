// lib/handlers/export-contable.js
// Etapa 6 — Export contable (Tango / Bejerman / Contabilium)
//
// GET  /api/export-contable/config              → lee export_contable_config
// POST /api/export-contable/config              → guarda export_contable_config
// GET  /api/export-contable?tipo=ventas&desde=&hasta=&proveedor=tango
//      → genera y devuelve el archivo (descarga directa, no JSON)
// GET  /api/export-contable/historial           → últimas exportaciones (export_contable_log)
//
// ESTADO: esqueleto. El formateador genérico CSV está completo y sirve de
// fallback funcional; Tango/Bejerman/Contabilium están documentados pero
// devuelven 501 hasta confirmar el layout exacto contra un caso real
// (ver TODOs en lib/export-contable/formato-*.js).
//
// Mismo patrón de auth que el resto de los handlers (token Bearer de
// Supabase + fila en `usuarios` para rol/empresa_id). Solo dueño/admin/
// contador pueden generar o configurar exports contables — mismo criterio
// que facturas.js (ROLES_FACTURAS).

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { getUserSeguro } from '../auth-helpers.js';
import { rateLimit } from '../rate-limit.js';
import { generarExport } from '../export-contable/index.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { obtenerEmpresaYRolPorAuthId } from '../repos/usuarios.js';
import {
  obtenerConfigExportContable,
  upsertConfigExportContable,
  listarHistorialExportContable,
  insertarLogExportContable,
  listarComprobantesContables,
} from '../repos/export-contable.js';

const limiter = rateLimit({ max: 20, windowMs: 60_000 });

// Se mantiene el cliente propio solo para Auth (getUser) — no es acceso a tabla.
const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export default async function handler(req, res) {
  if (await limiter(req, res)) return;
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Auth (igual que facturas.js / proveedores.js) ────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfilRaw = await obtenerEmpresaYRolPorAuthId(user.id);
  const perfil = perfilRaw ? { id: user.id, empresa_id: perfilRaw.empresa_id, rol: perfilRaw.rol } : null;

  if (!perfil || !puede(perfil, 'acceder', 'export_contable')) {
    return res.status(403).json({ error: 'Sin permisos' });
  }

  const empresa_id = perfil.empresa_id;
  const { recurso } = req.query;

  if (recurso === 'config')     return configHandler(req, res, perfil, empresa_id);
  if (recurso === 'historial')  return historialHandler(req, res, empresa_id);

  if (req.method === 'GET')  return generarHandler(req, res, perfil, empresa_id);

  return res.status(405).json({ error: 'Método no permitido' });
}

// ════════════════════════════════════════════════════════════════════
// GET/POST /api/export-contable/config
// ════════════════════════════════════════════════════════════════════
async function configHandler(req, res, perfil, empresa_id) {
  if (req.method === 'GET') {
    const { data, error } = await obtenerConfigExportContable(empresa_id);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // Sin fila todavía = no configurado (no es un error)
    return res.json(data || { configurado: false });
  }

  if (req.method === 'POST') {
    if (!puede(perfil, 'configurar', 'export_contable')) {
      return res.status(403).json({ error: 'Solo dueño/admin puede modificar la configuración contable' });
    }

    const { proveedor, plan_cuentas, separador_decimal, formato_fecha, activo } = req.body || {};

    const PROVEEDORES_VALIDOS = ['tango', 'bejerman', 'contabilium', 'generico_csv'];
    if (proveedor && !PROVEEDORES_VALIDOS.includes(proveedor)) {
      return res.status(400).json({ error: `Proveedor inválido. Opciones: ${PROVEEDORES_VALIDOS.join(', ')}` });
    }

    const { data, error } = await upsertConfigExportContable(empresa_id, {
      proveedor:         proveedor || 'generico_csv',
      plan_cuentas:      plan_cuentas || {},
      separador_decimal: separador_decimal || ',',
      formato_fecha:     formato_fecha || 'DD/MM/YYYY',
      activo:            activo ?? true,
      updated_at:        new Date().toISOString(),
    });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true, config: data });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ════════════════════════════════════════════════════════════════════
// GET /api/export-contable/historial
// ════════════════════════════════════════════════════════════════════
async function historialHandler(req, res, empresa_id) {
  const { data, error } = await listarHistorialExportContable(empresa_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json({ historial: data || [] });
}

// ════════════════════════════════════════════════════════════════════
// GET /api/export-contable?tipo=ventas|compras|cobranzas
//     &desde=YYYY-MM-DD&hasta=YYYY-MM-DD&proveedor=tango|bejerman|contabilium|generico_csv
// ════════════════════════════════════════════════════════════════════
async function generarHandler(req, res, perfil, empresa_id) {
  const { tipo, desde, hasta } = req.query;
  let { proveedor } = req.query;

  const TIPOS_VALIDOS = ['ventas', 'compras', 'cobranzas'];
  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ error: `Parámetro "tipo" inválido. Opciones: ${TIPOS_VALIDOS.join(', ')}` });
  }
  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Faltan parámetros "desde" y "hasta" (YYYY-MM-DD)' });
  }
  if (new Date(desde) > new Date(hasta)) {
    return res.status(400).json({ error: '"desde" no puede ser posterior a "hasta"' });
  }

  // Si no se pasa proveedor explícito, usar el configurado por la empresa
  if (!proveedor) {
    const { data: configProveedor } = await obtenerConfigExportContable(
      empresa_id, 'proveedor, plan_cuentas, separador_decimal, formato_fecha',
    );
    proveedor = configProveedor?.proveedor || 'generico_csv';
  }

  const { data: config } = await obtenerConfigExportContable(
    empresa_id, 'plan_cuentas, separador_decimal, formato_fecha',
  );

  // Ventas/compras necesitan plan de cuentas para armar asientos —
  // cobranzas no (es un listado de cobros, no un asiento).
  if (tipo !== 'cobranzas' && proveedor !== 'generico_csv') {
    const claves = Object.keys(config?.plan_cuentas || {});
    if (claves.length === 0) {
      return res.status(400).json({
        error: 'Falta configurar el plan de cuentas antes de exportar '
             + `${tipo} a ${proveedor}. Ver /api/export-contable/config.`,
      });
    }
  }

  let vista;
  if (tipo === 'ventas')  vista = 'v_comprobantes_contables_venta';
  if (tipo === 'compras') vista = 'v_comprobantes_contables_compra';
  // 'cobranzas' no tiene vista propia todavía — usa la tabla `cobros`
  // directo dentro de generarExport(); ver TODO en lib/export-contable/index.js

  let comprobantes = [];
  if (vista) {
    const { data, error } = await listarComprobantesContables(vista, empresa_id, desde, hasta);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    comprobantes = data || [];
  }

  let resultado;
  try {
    resultado = await generarExport({
      tipo, proveedor, comprobantes, desde, hasta,
      config: config || {},
      empresa_id,
    });
  } catch (err) {
    if (err.code === 'FORMATO_NO_IMPLEMENTADO') {
      return errorSeguro(res, err, 501, 'No se pudo completar la operación.');
    }
    console.error('[export-contable] Error generando export:', err);
    return res.status(500).json({ error: 'Error generando el archivo de export' });
  }

  // Registrar en el historial (auditoría — no bloquea si falla)
  await insertarLogExportContable({
    empresa_id,
    proveedor,
    tipo,
    fecha_desde: desde,
    fecha_hasta: hasta,
    cantidad_registros: comprobantes.length,
    usuario_id: perfil.id,
    archivo_nombre: resultado.nombreArchivo,
  });

  res.setHeader('Content-Type', resultado.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${resultado.nombreArchivo}"`);
  return res.status(200).send(resultado.contenido);
}
