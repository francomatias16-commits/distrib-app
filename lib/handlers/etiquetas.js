// lib/handlers/etiquetas.js
// Rutas:
//   GET  /api/etiquetas/config     → config de etiquetas de la empresa (defaults si no existe)
//   PUT  /api/etiquetas/config     → guarda (upsert) la config de etiquetas
//   POST /api/etiquetas/productos  → productos reales para la vista previa/impresión (Etapa 2)
//
// Generador de etiquetas de precio/código de barras — ver
// PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md. La impresión en sí es 100%
// client-side (frontend/admin/js/etiquetas-print.js, sección 4 del plan)
// — este handler solo persiste la config (Etapa 1) y resuelve los datos
// reales de los productos tildados en el listado (Etapa 2).
//
// _svc=config sigue gateado con `empresa_config` (solo dueño/admin, mismo
// gate que el resto de Admin → Hardware). _svc=productos usa el gate
// nuevo `etiquetas_productos` (dueño/admin/vendedor/depositero, mismo
// criterio que `stock` — ver lib/permisos-service.js): es una acción
// operativa sobre el listado de Productos, no una config de empresa.

import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import { obtenerConfigEtiquetas, guardarConfigEtiquetas, registrarGeneracionEtiquetas } from '../repos/etiquetas.js';
import { obtenerProductosParaEtiquetas } from '../repos/productos.js';
import { puede } from '../permisos-service.js';
import { exigirLimitePlan, LimitePlanError } from '../plan-limits.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function requerirPerfilAdmin(req, res) {
  const perfil = await verificarToken(req, db);
  if (!perfil) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  if (!puede(perfil, 'acceder', 'empresa_config')) {
    res.status(403).json({ error: 'Sin permisos' });
    return null;
  }
  return perfil;
}

// Gate de la Etapa 2 — separado de requerirPerfilAdmin() porque usa un
// recurso distinto (`etiquetas_productos`, más permisivo que
// `empresa_config`): cualquiera que puede operar el listado de Productos
// (dueño/admin/vendedor/depositero) puede generar etiquetas para lo que
// tiene tildado, sin necesitar acceso a Admin → Hardware.
async function requerirPerfilOperativo(req, res) {
  const perfil = await verificarToken(req, db);
  if (!perfil) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  if (!puede(perfil, 'acceder', 'etiquetas_productos')) {
    res.status(403).json({ error: 'Sin permisos' });
    return null;
  }
  return perfil;
}

const FORMATOS_VALIDOS = ['auto', 'ean13', 'code128'];
// Mismo tope que listarProductosActivosParaAlertaStock (500) — una
// selección más grande que eso ya es un caso raro (probablemente el
// usuario tildó "seleccionar todos" sobre un catálogo enorme) y conviene
// que el front lo corte en tandas antes que dejar pasar un IN() gigante.
const MAX_IDS_ETIQUETAS = 500;

const rateLimitApi = rateLimit({ max: 100, windowMs: 60_000 });
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (await rateLimitApi(req, res)) return;

  const _svc = req.query._svc;

  // ── GET /api/etiquetas/config ────────────────────────────────────────────
  if (req.method === 'GET' && _svc === 'config') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    try {
      const config = await obtenerConfigEtiquetas(perfil.empresa_id);
      return res.status(200).json({ ok: true, config });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo cargar la configuración de etiquetas.');
    }
  }

  // ── PUT /api/etiquetas/config ────────────────────────────────────────────
  if (req.method === 'PUT' && _svc === 'config') {
    const perfil = await requerirPerfilAdmin(req, res);
    if (!perfil) return;

    const {
      ancho_mm, alto_mm, columnas, margen_mm,
      formato_simbologia, lista_precio_default_id,
      incluir_iva, mostrar_codigo_interno, mostrar_promociones,
    } = req.body ?? {};

    if (ancho_mm !== undefined && !(Number(ancho_mm) > 0))
      return res.status(400).json({ error: 'ancho_mm debe ser un número mayor a 0' });
    if (alto_mm !== undefined && !(Number(alto_mm) > 0))
      return res.status(400).json({ error: 'alto_mm debe ser un número mayor a 0' });
    if (columnas !== undefined && !(Number.isInteger(Number(columnas)) && Number(columnas) > 0))
      return res.status(400).json({ error: 'columnas debe ser un entero mayor a 0' });
    if (margen_mm !== undefined && Number(margen_mm) < 0)
      return res.status(400).json({ error: 'margen_mm no puede ser negativo' });
    if (formato_simbologia !== undefined && !FORMATOS_VALIDOS.includes(formato_simbologia))
      return res.status(400).json({ error: `formato_simbologia debe ser una de: ${FORMATOS_VALIDOS.join(', ')}` });

    try {
      const config = await guardarConfigEtiquetas(perfil.empresa_id, {
        ancho_mm: ancho_mm !== undefined ? Number(ancho_mm) : undefined,
        alto_mm: alto_mm !== undefined ? Number(alto_mm) : undefined,
        columnas: columnas !== undefined ? Number(columnas) : undefined,
        margen_mm: margen_mm !== undefined ? Number(margen_mm) : undefined,
        formato_simbologia,
        lista_precio_default_id: lista_precio_default_id !== undefined ? (lista_precio_default_id || null) : undefined,
        incluir_iva,
        mostrar_codigo_interno,
        mostrar_promociones,
      });
      return res.status(200).json({ ok: true, config });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo guardar la configuración de etiquetas.');
    }
  }

  // ── POST /api/etiquetas/productos (Etapa 2) ──────────────────────────────
  // Trae los campos reales (precio, iva, codigo_es_barras, vendido_por_peso,
  // unidad) de los productos tildados en el listado — fn_productos_lista no
  // los expone porque la grilla no los muestra. `ids` puede venir con
  // productos que ya no existen o no pertenecen a la empresa (se tildaron y
  // se borraron/desactivaron entre medio, o el request está manipulado): el
  // repo ya filtra por empresa_id, así que la respuesta simplemente trae
  // menos productos que ids se mandaron — no es un error, el front avisa
  // con un toast cuando data.length < ids.length.
  if (req.method === 'POST' && _svc === 'productos') {
    const perfil = await requerirPerfilOperativo(req, res);
    if (!perfil) return;

    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids debe ser un array con al menos un elemento' });
    if (ids.length > MAX_IDS_ETIQUETAS)
      return res.status(400).json({ error: `No se pueden pedir más de ${MAX_IDS_ETIQUETAS} productos por vez` });

    // ── Corte de plan trial (Etapa 8, migración 576) ─────────────────────
    // Trial permite 1 sola generación de etiquetas (chequear_limite_plan
    // cuenta filas de etiquetas_generaciones). A diferencia del corte de
    // WhatsApp (bloqueo silencioso, 200), acá sí se corta con 403: no hay
    // un "fallback simulado" razonable para un PDF/preview de etiquetas.
    try {
      await exigirLimitePlan(db, perfil.empresa_id, 'etiquetas_generaciones');
    } catch (err) {
      if (err instanceof LimitePlanError) {
        return res.status(403).json({ error: 'LIMITE_PLAN_ALCANZADO', detalle: err.info });
      }
      return errorSeguro(res, err, 500, 'No se pudieron cargar los productos.');
    }

    try {
      const productos = await obtenerProductosParaEtiquetas(perfil.empresa_id, ids);
      // Registro de la generación para el tope de plan — no debe tumbar la
      // respuesta ya resuelta si falla (ver comentario en el repo).
      registrarGeneracionEtiquetas(perfil.empresa_id, perfil.id, ids.length)
        .catch(e => console.error('[ETIQUETAS] Error registrando generación:', e.message));
      return res.status(200).json({ ok: true, productos });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudieron cargar los productos.');
    }
  }

  return res.status(404).json({ error: 'Ruta no encontrada' });
}
