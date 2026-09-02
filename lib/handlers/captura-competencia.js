// lib/handlers/captura-competencia.js
// Fase 1 (Capa 2 — MVP) del PLAN_CAPTURA_COMPETENCIA.md.
//
// Flujo (ver plan, sección 1.2):
//   1. POST accion=crear      — sube la foto, extrae renglones (visión),
//                                matchea contra catálogo propio, guarda todo
//                                como pendiente_revision.
//   2. GET  accion=detalle    — trae la captura + items para la pantalla de
//                                revisión del vendedor.
//   3. POST accion=confirmar_item — ajuste manual de un renglón (producto,
//                                cantidad, precio, o descartar). Obligatorio
//                                pasar por acá incluso con confianza alta —
//                                nunca se convierte a pedido sin revisión
//                                (plan, 1.5).
//   4. POST accion=cerrar     — recalcula totales/ahorro con los items ya
//                                confirmados, valida piso de margen, marca
//                                'revisado'.
//   5. POST accion=convertir  — alta de cliente (si hace falta) + creación
//                                del pedido, reutilizando crearPedidoParaCliente
//                                (mismo motor de precios/stock/crédito que el
//                                resto del sistema — no se duplica esa lógica).

import { randomUUID } from 'node:crypto';
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { validarImagenPorContenido } from '../utils/image-sniff.js';
import { db } from '../repos/_db.js';
import {
  subirFotoCapturaStorage,
  crearCaptura,
  insertarItemsCaptura,
  obtenerCapturaDetalle,
  listarCapturasPendientes,
  obtenerMetricasCaptura,
  actualizarTotalesCaptura,
  marcarCapturaConvertida,
  marcarCapturaDescartada,
  confirmarItemCaptura,
  matchearProducto,
  listarAhorroAcumuladoEmpresa,
} from '../repos/captura-competencia.js';
import { crearCliente } from '../repos/clientes.js';
import { firmarCampoUrl } from '../utils/storage-urls.js';
import { extraerRenglonesDeFactura } from './captura-competencia/_extraccion.js';
import { crearPedidoParaCliente } from './pedidos/crear-pedido.js';

const IMAGEN_MIME_TYPES_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGEN_BASE64_CHARS = 5_600_000; // ~4MB de imagen, mismo límite que asistente.js

// Piso de margen por defecto si la empresa no configuró uno propio en
// empresas.config->>'captura_competencia_margen_minimo_pct'. 8% es
// conservador a propósito: mejor que el vendedor tenga que pedir una
// excepción a un admin que regalar margen sin darse cuenta en el
// apuro de cerrar la venta en el mostrador (riesgo señalado en el plan).
const MARGEN_MINIMO_PCT_DEFAULT = 8;

// Umbral de sanidad para accionCerrar (ver nota en el loop de validación):
// si el precio propio de un renglón es más de 4 veces el de competencia (o
// menos de 1/4), lo más probable es que el matching haya asociado un
// producto propio equivocado (típicamente una variante de peso distinta,
// ej. presentación de 1kg vs. 5kg) y no que el ahorro sea real. Detectarlo
// acá, con un mensaje accionable, evita además que un % de ahorro absurdo
// (ej. -2000%) intente guardarse en una columna numeric(5,2) y explote
// como error genérico de base de datos sin explicación para el vendedor.
const RATIO_PRECIO_SOSPECHOSO = 4;

const rateLimitApi = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  const accion = req.query.accion;

  try {
    // Ex-gate de flag (empresas.config->>'captura_competencia_habilitada'):
    // sacado a pedido directo — la función queda disponible siempre, para
    // todas las empresas, sin depender de esa clave. Se sigue consultando
    // 'empresas' porque accionCerrar necesita su config igual (piso de
    // margen configurable por empresa) — solo se dejó de usar para bloquear.
    const { data: empresaConfigRow } = await db.from('empresas').select('config').eq('id', perfil.empresa_id).single();
    const empresaConfig = empresaConfigRow?.config || {};

    if (req.method === 'POST' && accion === 'crear') return await accionCrear(req, res, perfil);
    if (req.method === 'GET' && accion === 'listar') return await accionListar(req, res, perfil);
    if (req.method === 'GET' && accion === 'detalle') return await accionDetalle(req, res, perfil);
    if (req.method === 'GET' && accion === 'metricas') return await accionMetricas(req, res, perfil);
    if (req.method === 'GET' && accion === 'ahorro_ranking') return await accionAhorroRanking(req, res, perfil);
    if (req.method === 'POST' && accion === 'confirmar_item') return await accionConfirmarItem(req, res, perfil);
    if (req.method === 'POST' && accion === 'cerrar') return await accionCerrar(req, res, perfil, empresaConfig);
    if (req.method === 'POST' && accion === 'convertir') return await accionConvertir(req, res, perfil);
    if (req.method === 'POST' && accion === 'descartar') return await accionDescartar(req, res, perfil);

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo procesar la captura de competencia.');
  }
}

// ── 1. Crear captura: subir foto + extraer + matchear ────────────────────

async function accionCrear(req, res, perfil) {
  if (!puede(perfil, 'crear', 'captura_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }

  const imagenBase64 = (req.body?.imagen_base64 || '').trim();
  const imagenMimeTypeDeclarado = (req.body?.imagen_mime_type || '').trim();
  const proveedorNombreManual = (req.body?.proveedor_competencia_nombre || '').trim() || null;

  if (!imagenBase64) return res.status(400).json({ error: 'Falta imagen_base64' });
  if (!IMAGEN_MIME_TYPES_PERMITIDOS.has(imagenMimeTypeDeclarado)) {
    return res.status(400).json({ error: 'Tipo de imagen no soportado. Usá JPG, PNG o WEBP.' });
  }
  if (imagenBase64.length > MAX_IMAGEN_BASE64_CHARS) {
    return res.status(400).json({ error: 'La imagen es demasiado pesada. Probá con una más chica o comprimida.' });
  }

  let imagenBuffer;
  try {
    imagenBuffer = Buffer.from(imagenBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'La imagen adjunta no es válida.' });
  }

  const validacion = validarImagenPorContenido(imagenBuffer, IMAGEN_MIME_TYPES_PERMITIDOS);
  if (!validacion.ok) return res.status(400).json({ error: validacion.error });

  // Path del objeto en el bucket privado: empresa/vendedor/uuid.ext — mismo
  // criterio de namespacing que usa el resto del proyecto (ver storage-urls.js).
  const extension = validacion.mimeReal.split('/')[1];
  const path = `${perfil.empresa_id}/${perfil.id}/${randomUUID()}.${extension}`;

  const { error: errorUpload } = await subirFotoCapturaStorage(path, imagenBuffer, validacion.mimeReal);
  if (errorUpload) throw new Error(`No se pudo subir la foto: ${errorUpload.message}`);

  // Extracción por visión (ver _extraccion.js) — si falla, la foto ya quedó
  // subida y se puede reintentar la interpretación sin volver a sacarla.
  let extraccion;
  try {
    extraccion = await extraerRenglonesDeFactura({ data: imagenBase64, mimeType: validacion.mimeReal });
  } catch (err) {
    // Dos causas muy distintas caían en el mismo mensaje crudo antes de este
    // fix: (a) parsearJsonDeRespuesta() de _extraccion.js, que ya tira un
    // mensaje seguro y accionable ("foto más nítida"); y (b)
    // responderConFallback() de asistente-providers.js cuando los proveedores
    // con visión (Gemini/Groq) fallan los dos — ahí el mensaje trae la
    // respuesta HTTP completa de cada proveedor (cuotas, org id, URLs
    // internas), pensado para debug server-side, no para mostrárselo al
    // vendedor en la pantalla. Mismo caso ya distinguido en asistente.js
    // (buscar esFalloDeImagen) — acá faltaba ese mismo tratamiento.
    if (/No se pudo leer la imagen/i.test(err.message || '')) {
      return errorSeguro(
        res,
        err,
        503,
        'No se pudo leer la imagen automáticamente en este momento (alta demanda en el servicio de lectura). Probá de nuevo en unos minutos, o cargá el proveedor y guardá la foto igual para revisar los renglones a mano más tarde.'
      );
    }
    return res.status(422).json({
      error: err.message || 'No se pudo leer la factura. Probá con una foto más nítida o mejor iluminada.',
    });
  }

  const { data: capturaCreada, error: errorCaptura } = await crearCaptura({
    empresa_id: perfil.empresa_id,
    vendedor_id: perfil.id,
    imagen_path: path,
    proveedor_competencia_nombre: proveedorNombreManual || extraccion.proveedor_nombre,
  });
  if (errorCaptura) throw new Error(`No se pudo crear la captura: ${errorCaptura.message}`);

  // Matching por texto contra el catálogo propio (fn_captura_matchear_producto,
  // migración 552) — un renglón a la vez porque cada texto necesita su propia
  // búsqueda de similitud, no se puede batchear en una sola llamada RPC.
  const itemsParaGuardar = [];
  for (const item of extraccion.items) {
    const match = await matchearProducto(perfil.empresa_id, item.texto_original);
    itemsParaGuardar.push({
      texto_original: item.texto_original,
      producto_id: match?.producto_id || null,
      cantidad: item.cantidad,
      precio_unitario_competencia: item.precio_unitario,
      // Estimador conservador para la pantalla de revisión — el precio
      // AUTORITATIVO se recalcula recién en accionConvertir() vía
      // crearPedidoParaCliente(), que ya aplica reglas de precio por
      // cliente/lista (no existen todavía para un prospecto nuevo). Ver
      // nota de arquitectura en el handler de conversión.
      precio_unitario_propio: match?.precio_base ?? null,
      confianza_match: match?.score ?? null,
    });
  }

  const { error: errorItems } = await insertarItemsCaptura(capturaCreada.id, itemsParaGuardar);
  if (errorItems) throw new Error(`No se pudieron guardar los renglones: ${errorItems.message}`);

  const { data: detalle, error: errorDetalle } = await obtenerCapturaDetalle(capturaCreada.id, perfil.empresa_id);
  if (errorDetalle) throw new Error(errorDetalle.message);

  return res.status(201).json({ captura: detalle });
}

// ── 2. Listar capturas pendientes ─────────────────────────────────────────

async function accionListar(req, res, perfil) {
  if (!puede(perfil, 'leer', 'captura_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  // El vendedor de campo solo ve lo suyo; dueño/admin auditan/revisan la
  // bandeja completa de la empresa (ver comentario de permisos en
  // permisos-service.js — "dueno/admin pueden auditar/revisar cualquier
  // captura"). Antes esto quedaba siempre scopeado a perfil.id sin importar
  // el rol, así que un admin/dueño no veía nunca lo cargado por sus
  // vendedores.
  const vendedorIdFiltro = perfil.rol === 'vendedor' ? perfil.id : null;
  const { data, error } = await listarCapturasPendientes(perfil.empresa_id, vendedorIdFiltro);
  if (error) throw new Error(error.message);
  return res.json({ capturas: data });
}

// ── 2b. Métricas de éxito del piloto (plan 1.7) ──────────────────────────
// % de capturas que terminan en pedido convertido, y tiempo promedio
// foto→cierre (fecha_captura → convertido_at). Mismo scoping por rol que
// accionListar: vendedor ve lo suyo, dueño/admin ven la empresa completa.

async function accionMetricas(req, res, perfil) {
  if (!puede(perfil, 'leer', 'captura_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const vendedorIdFiltro = perfil.rol === 'vendedor' ? perfil.id : null;
  const { data, error } = await obtenerMetricasCaptura(perfil.empresa_id, vendedorIdFiltro);
  if (error) throw new Error(error.message);

  // Las descartadas no cuentan para el denominador ni para la tasa de
  // cierre — si contaran, descartar una captura mala (error del vendedor,
  // comercio que no daba para nada) seguiría arrastrando la métrica para
  // abajo para siempre, justo lo contrario de lo que busca poder sacarla
  // de la bandeja.
  const filas = (data || []).filter((f) => f.estado !== 'descartado');
  const total = filas.length;
  const convertidas = filas.filter((f) => f.estado === 'convertido_pedido');
  const tasaConversionPct = total > 0 ? (convertidas.length / total) * 100 : 0;

  const duracionesMs = convertidas
    .filter((f) => f.fecha_captura && f.convertido_at)
    .map((f) => new Date(f.convertido_at).getTime() - new Date(f.fecha_captura).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const tiempoPromedioHoras = duracionesMs.length
    ? duracionesMs.reduce((sum, ms) => sum + ms, 0) / duracionesMs.length / 3_600_000
    : null;

  return res.json({
    total_capturas: total,
    total_convertidas: convertidas.length,
    tasa_conversion_pct: Number(tasaConversionPct.toFixed(1)),
    tiempo_promedio_foto_cierre_horas: tiempoPromedioHoras !== null ? Number(tiempoPromedioHoras.toFixed(1)) : null,
  });
}

// ── 2.5. Ranking de ahorro acumulado (Fase 2, plan 2.5 — reporte admin) ──
// Reporte agregado de TODA la empresa (no de "lo mío" como el resto de esta
// pantalla) — se excluye explícitamente al rol vendedor de campo en vez de
// reusar el recurso 'captura_competencia' sin más, porque acá el criterio de
// scope no es "sus propias capturas" sino "todos los clientes de la empresa".
async function accionAhorroRanking(req, res, perfil) {
  if (!puede(perfil, 'leer', 'captura_competencia') || perfil.rol === 'vendedor') {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const { data, error } = await listarAhorroAcumuladoEmpresa(perfil.empresa_id);
  if (error) throw new Error(error.message);

  const clientes = (data || []).map((f) => ({
    razon_social: f.clientes?.razon_social || null,
    ahorro_acumulado: f.ahorro_acumulado,
    pedidos_con_ahorro: f.pedidos_con_ahorro,
    ultima_actualizacion: f.ultima_actualizacion,
  }));
  const ahorroTotalEmpresa = clientes.reduce((sum, c) => sum + Number(c.ahorro_acumulado || 0), 0);

  return res.json({
    clientes,
    ahorro_total_empresa: Math.round(ahorroTotalEmpresa * 100) / 100,
  });
}

// ── 3. Detalle para pantalla de revisión ─────────────────────────────────

async function accionDetalle(req, res, perfil) {
  if (!puede(perfil, 'leer', 'captura_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta id' });

  const { data, error } = await obtenerCapturaDetalle(id, perfil.empresa_id);
  if (error || !data) return res.status(404).json({ error: 'Captura no encontrada' });

  // firmarCampoUrl reemplaza el path guardado en `imagen_original_url` por
  // una signed URL de corta duración — recibe el objeto completo + nombre
  // de campo (no el valor ya extraído), ver lib/utils/storage-urls.js.
  const detalleConUrl = await firmarCampoUrl(db, 'capturas-competencia', data, 'imagen_original_url');
  return res.json({ captura: detalleConUrl });
}

// ── 4. Confirmar/ajustar un renglón (obligatorio antes de cerrar) ────────

async function accionConfirmarItem(req, res, perfil) {
  if (!puede(perfil, 'confirmar', 'captura_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const { item_id, producto_id, cantidad, precio_unitario_propio, descartado } = req.body || {};
  if (!item_id) return res.status(400).json({ error: 'Falta item_id' });

  const { error } = await confirmarItemCaptura(item_id, { producto_id, cantidad, precio_unitario_propio, descartado });
  if (error) throw new Error(error.message);

  return res.json({ ok: true });
}

// ── 5. Cerrar cotización: totales + validación de piso de margen ────────

async function accionCerrar(req, res, perfil, empresaConfig) {
  if (!puede(perfil, 'confirmar', 'captura_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const id = req.body?.id;
  if (!id) return res.status(400).json({ error: 'Falta id' });

  const { data: captura, error: errorDetalle } = await obtenerCapturaDetalle(id, perfil.empresa_id);
  if (errorDetalle || !captura) return res.status(404).json({ error: 'Captura no encontrada' });

  const itemsVigentes = (captura.captura_competencia_items || []).filter((it) => !it.descartado);
  if (!itemsVigentes.length) {
    return res.status(400).json({ error: 'No quedan renglones vigentes para cotizar (¿se descartaron todos?)' });
  }
  const sinProducto = itemsVigentes.filter((it) => !it.producto_id);
  if (sinProducto.length) {
    return res.status(400).json({
      error: `Hay ${sinProducto.length} renglón(es) sin producto propio asignado. Confirmalos o descartalos antes de cerrar.`,
      items_pendientes: sinProducto.map((it) => it.id),
    });
  }

  // Piso de margen (ver nota MARGEN_MINIMO_PCT_DEFAULT): se valida contra
  // productos.costo, que tiene 100% de cobertura en el catálogo auditado
  // en la Fase 0 — a diferencia del EAN, acá sí se puede confiar en el dato.
  // empresaConfig ya lo trajo el gate del feature flag al principio del
  // handler — no se vuelve a consultar 'empresas' acá.
  const margenMinimoPct = Number(empresaConfig?.captura_competencia_margen_minimo_pct) || MARGEN_MINIMO_PCT_DEFAULT;

  const productoIds = itemsVigentes.map((it) => it.producto_id);
  const { data: productosCosto, error: errorCosto } = await db
    .from('productos')
    .select('id, costo')
    .in('id', productoIds);
  if (errorCosto) throw new Error(errorCosto.message);
  const costoPorProducto = Object.fromEntries((productosCosto || []).map((p) => [p.id, Number(p.costo) || 0]));

  const violacionesMargen = [];
  const preciosSospechosos = [];
  let totalCompetencia = 0;
  let totalPropio = 0;

  for (const item of itemsVigentes) {
    const cantidad = Number(item.cantidad) || 0;
    const precioPropio = Number(item.precio_unitario_propio) || 0;
    const precioCompetencia = Number(item.precio_unitario_competencia) || 0;
    const costo = costoPorProducto[item.producto_id] ?? 0;

    if (costo > 0 && precioPropio > 0) {
      const margenPct = ((precioPropio - costo) / precioPropio) * 100;
      if (margenPct < margenMinimoPct) {
        violacionesMargen.push({ item_id: item.id, margen_actual_pct: Number(margenPct.toFixed(1)) });
      }
    }

    // Ver RATIO_PRECIO_SOSPECHOSO: un renglón "sano" tiene precio propio y
    // de competencia en el mismo orden de magnitud (son, se supone, el
    // mismo producto). Si están a más de 4x de distancia en cualquier
    // sentido, se avisa en vez de dejar que el % de ahorro se dispare.
    if (precioPropio > 0 && precioCompetencia > 0) {
      const ratio = precioPropio / precioCompetencia;
      if (ratio > RATIO_PRECIO_SOSPECHOSO || ratio < 1 / RATIO_PRECIO_SOSPECHOSO) {
        preciosSospechosos.push({
          item_id: item.id,
          precio_competencia: precioCompetencia,
          precio_propio: precioPropio,
        });
      }
    }

    totalCompetencia += precioCompetencia * cantidad;
    totalPropio += precioPropio * cantidad;
  }

  if (preciosSospechosos.length) {
    return res.status(409).json({
      error: `${preciosSospechosos.length} renglón(es) tienen un precio propio muy alejado del de competencia — probablemente se matcheó el producto equivocado (ej. otra presentación/peso). Revisá el producto propio asignado antes de cerrar.`,
      precios_sospechosos: preciosSospechosos,
    });
  }

  if (violacionesMargen.length) {
    return res.status(409).json({
      error: `${violacionesMargen.length} renglón(es) quedarían por debajo del margen mínimo (${margenMinimoPct}%). Ajustá el precio antes de cerrar.`,
      violaciones_margen: violacionesMargen,
    });
  }

  const ahorroAbsoluto = totalCompetencia - totalPropio;
  const ahorroPorcentual = totalCompetencia > 0 ? (ahorroAbsoluto / totalCompetencia) * 100 : 0;

  // Red de seguridad final: con el filtro de preciosSospechosos de arriba
  // esto no debería dispararse nunca, pero si algún caso raro se escapa
  // (ej. totalCompetencia muy chico por redondeo) preferimos un 409 claro
  // a que la UPDATE reviente por overflow en la columna numeric del %.
  if (Math.abs(ahorroPorcentual) > 99999) {
    return res.status(409).json({
      error: 'El % de ahorro calculado no tiene sentido (revisá los precios y productos cargados en los renglones).',
    });
  }

  const { error: errorUpdate } = await actualizarTotalesCaptura(id, {
    total_competencia: totalCompetencia,
    total_propio_cotizado: totalPropio,
    ahorro_absoluto: ahorroAbsoluto,
    ahorro_porcentual: ahorroPorcentual,
    estado: 'revisado',
  });
  if (errorUpdate) throw new Error(errorUpdate.message);

  return res.json({
    ok: true,
    total_competencia: totalCompetencia,
    total_propio_cotizado: totalPropio,
    ahorro_absoluto: ahorroAbsoluto,
    ahorro_porcentual: Number(ahorroPorcentual.toFixed(1)),
  });
}

// ── 6. Convertir en cliente + pedido ─────────────────────────────────────

async function accionConvertir(req, res, perfil) {
  if (!puede(perfil, 'convertir', 'captura_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const { id, cliente_id: clienteIdExistente, cliente_nuevo } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Falta id' });

  const { data: captura, error: errorDetalle } = await obtenerCapturaDetalle(id, perfil.empresa_id);
  if (errorDetalle || !captura) return res.status(404).json({ error: 'Captura no encontrada' });
  if (captura.estado !== 'revisado') {
    return res.status(409).json({ error: 'La captura tiene que estar cerrada (accion=cerrar) antes de convertir' });
  }

  let clienteId = clienteIdExistente || captura.cliente_id;
  if (!clienteId) {
    if (!cliente_nuevo?.razon_social) {
      return res.status(400).json({ error: 'Falta cliente_id o cliente_nuevo.razon_social para dar de alta' });
    }
    const nuevoCliente = await crearCliente(perfil.empresa_id, cliente_nuevo);
    clienteId = nuevoCliente.id;
  }

  const itemsVigentes = (captura.captura_competencia_items || []).filter((it) => !it.descartado);
  const itemsPedido = itemsVigentes.map((it) => ({
    producto_id: it.producto_id,
    cantidad: Number(it.cantidad) || 0,
  }));

  // NOTA DE ARQUITECTURA: no se manda precio_unitario_propio acá adrede.
  // crearPedidoParaCliente() resuelve el precio server-side vía
  // resolverPreciosClienteRpc() — el mismo motor que usa el portal y el
  // POS — que recién ahora puede aplicar reglas de precio específicas del
  // cliente (recién creado). El precio mostrado en la pantalla de revisión
  // (precio_base) era una estimación conservadora; el precio real del
  // pedido queda fijado acá, con la misma autoridad que cualquier otro
  // pedido del sistema.
  const resultado = await crearPedidoParaCliente({
    empresaId: perfil.empresa_id,
    vendedorId: perfil.id,
    clienteId,
    items: itemsPedido,
  });

  if (!resultado.ok) {
    return res.status(resultado.status || 400).json({ error: resultado.error });
  }

  const { error: errorMarcar } = await marcarCapturaConvertida(id, clienteId, resultado.pedido_id);
  if (errorMarcar) console.error('[captura-competencia] pedido creado pero no se pudo marcar la captura como convertida:', errorMarcar.message);

  return res.status(201).json({ ok: true, cliente_id: clienteId, pedido: resultado });
}

// ── 6. Descartar una captura completa (soft-delete, no un renglón) ──────
// Le da al vendedor una salida real para una captura hecha por error —
// hasta acá el estado 'descartado' existía en el CHECK de la tabla y en
// las etiquetas del frontend, pero nada lo disparaba nunca. Se bloquea
// solo si ya hay un pedido real detrás (convertido_pedido): una vez que
// existe ese pedido, "descartar la captura" dejaría de reflejar lo que
// pasó de verdad. Descartar una ya descartada es un no-op válido (mismo
// estado final), no se rechaza con 409.
async function accionDescartar(req, res, perfil) {
  if (!puede(perfil, 'confirmar', 'captura_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Falta id' });

  const { data: captura, error: errorDetalle } = await obtenerCapturaDetalle(id, perfil.empresa_id);
  if (errorDetalle || !captura) return res.status(404).json({ error: 'Captura no encontrada' });
  if (captura.estado === 'convertido_pedido') {
    return res.status(409).json({ error: 'La captura ya se convirtió en un pedido, no se puede descartar' });
  }

  const { error } = await marcarCapturaDescartada(id);
  if (error) throw new Error(error.message);

  return res.json({ ok: true });
}
