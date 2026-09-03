// lib/handlers/pos.js
// Módulo POS — venta mostrador (B2B + consumidor final).
// Registrado en api/index.js bajo _mod=pos. No es una Serverless Function
// nueva — mismo dispatcher único que el resto del proyecto.
//
// GET  /api/pos/caja-estado              → turnos abiertos del usuario actual
// GET  /api/pos/cajas                    → lista de cajas activas de la empresa
// GET  /api/pos/productos?q=...          → búsqueda rápida (código de barras o nombre)
// GET  /api/pos/resumen-turno?turno_id=  → desglose por medio de pago, sin cerrar
// GET  /api/pos/historial-turnos         → turnos cerrados + diferencia de arqueo (dueno/admin)
// GET  /api/pos/ticket?venta_id=         → detalle para imprimir/mostrar
// GET  /api/pos/ventas?q=...             → (dueno/admin) listado para anular
// GET  /api/pos/depositos                → depósitos de la empresa
// GET  /api/pos/transferencias-stock     → historial de transferencias
// POST /api/pos (sin accion)             → registrar una venta (items + pagos)
// POST /api/pos/abrir-turno              → abre turno en una caja
// POST /api/pos/cerrar-turno             → cierra turno + arqueo automático
// POST /api/pos/forzar-cierre-turno      → (dueno/admin) cierra un turno huérfano dejado abierto por otro usuario
// POST /api/pos/anular                   → anular una venta, repone stock
// POST /api/pos/facturar                 → emitir comprobante AFIP
// POST /api/pos/transferir-stock         → mover stock entre depósitos
//
// ── Fase 2 ────────────────────────────────────────────────────────────────
// GET  /api/pos/favoritos                → lista de favoritos de la empresa
// POST /api/pos/favoritos                → agregar favorito
// POST /api/pos/favoritos-quitar         → quitar favorito por id
// POST /api/pos/movimiento-caja          → registrar sangría / refuerzo / retiro (ítem 10)
// POST /api/pos/verificar-pin            → verificar PIN de supervisor (ítem 14)
// GET  /api/pos/reporte-z?turno_id=      → reporte de cierre tipo Z (ítem 15)
//
// ── Fase 3 (v142) ─────────────────────────────────────────────────────────
// POST /api/pos/cliente-rapido           → alta mínima de cliente desde la caja
// POST /api/pos/config-pin               → guardar/actualizar PIN de supervisor (dueno/admin)
// GET  /api/pos/stock-alerta?caja_id=    → productos sin stock en el depósito de la caja
//
// ── Fase 4 (v143) — Balanza + Devoluciones + Promociones ─────────────────
// GET  /api/pos/promociones              → lista de promociones activas de la empresa
// POST /api/pos/promociones              → crear/editar/eliminar promociones (dueno/admin)
// POST /api/pos/devolucion               → registrar devolución parcial de una venta
// GET  /api/pos/devoluciones?venta_id=   → devoluciones de una venta específica

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { verificarToken } from '../auth-helpers.js';
import bcrypt from 'bcryptjs';
import { rateLimit } from '../rate-limit.js';
import { emitirFactura } from '../facturas.js';
import { errorSeguro } from '../error-response.js';
import {
  buscarProductosPos,
  obtenerCategoriasDeProductos,
  obtenerProductosParaVentaPos,
  perteneceProductoAEmpresa,
  listarProductosActivosParaAlertaStock,
} from '../repos/productos.js';
import { listarDepositosIds, existeDepositoEnEmpresa } from '../repos/stock.js';
import {
  obtenerCajaConDeposito,
  obtenerDepositoPrincipal,
  asignarDepositoACaja,
  obtenerStockPorProductos,
  obtenerPreciosPorLista,
  listarPromocionesVigentes,
  listarDepositosConNombre,
  listarTransferenciasStock,
  contarDepositosDeEmpresa,
  transferirStockEntreDepositosRpc,
  listarFavoritosPos,
  upsertFavoritoPos,
  eliminarFavoritoPos,
  buscarClientePorCuit,
  crearClienteRapido,
  obtenerEmpresaParaHardware,
  obtenerConfigEmpresa,
  actualizarConfigEmpresa,
  obtenerCajaHardwareConfig,
  actualizarCajaHardwareConfig,
  actualizarPinSupervisor,
  listarPromocionesAdmin,
  crearPromocion,
  actualizarPromocion,
  eliminarPromocion,
  obtenerEstadoActivaPromocion,
  togglePromocion,
  listarTurnosAbiertosDeUsuario,
  obtenerTurnoConEmpresa,
  obtenerTurnoConEstadoYEmpresa,
  resumenTurnoCajaRpc,
  listarCajasActivas,
  obtenerCajaParaAbrirTurno,
  insertarTurnoCaja,
  obtenerTurnoAbiertoDeCaja,
  forzarCierreTurnoCajaRpc,
  cerrarTurnoCajaRpc,
  insertarMovimientoCaja,
  obtenerPinSupervisor,
  obtenerTurnoParaReporteZ,
  listarVentasDelTurno,
  listarMovimientosDelTurno,
  listarHistorialTurnos,
  listarCajasAdminConTurno,
  buscarCajaPorNombre,
  buscarOtraCajaConNombre,
  crearCajaPos,
  obtenerCajaPosPorId,
  actualizarCajaPos,
  activarCajaPos,
  desactivarCajaPos,
  listarMovimientosCajaLog,
  listarUsuariosParaUmbral,
  existeUsuarioEnEmpresa,
  actualizarUmbralUsuario,
  resolverPreciosClienteRpc,
  obtenerUmbralDescuentoUsuario,
  obtenerCajaParaVenta,
  obtenerClienteActivoParaVenta,
  registrarVentaPosRpc,
  obtenerVentaParaAnular,
  anularVentaPosRpc,
  obtenerVentaParaFacturar,
  obtenerVentaParaTicket,
  listarVentasPos,
  listarDevolucionesDeVenta,
  obtenerVentaParaDevolucion,
  registrarDevolucionPosRpc,
} from '../repos/pos.js';

import { puede } from '../permisos-service.js';
import * as AuditRepo from '../repos/audit.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);


const limiterVenta    = rateLimit({ max: 30, windowMs: 60_000 });
const limiterLectura  = rateLimit({ max: 60, windowMs: 60_000 });
const limiterFacturar = rateLimit({ max: 10, windowMs: 60_000 });
// Rate limit específico para verificación de PIN — evita fuerza bruta.
const limiterPin      = rateLimit({ max: 10, windowMs: 60_000 });

// ── Hash de PIN de supervisor (bcrypt) ───────────────────────────────────
// FIX 2026-06-30: antes el PIN se guardaba y comparaba en texto plano.
// Migración compatible hacia atrás: PINs ya guardados en texto plano
// (4-8 dígitos, no empiezan con "$2") se siguen aceptando una vez, y se
// re-hashean automáticamente al verificarse con éxito — sin necesidad de
// pedirle a cada empresa que reconfigure su PIN.
function esHashBcrypt(valor) {
  return typeof valor === 'string' && /^\$2[aby]?\$/.test(valor);
}

async function verificarYMigrarPin(pinIngresado, valorGuardado, empresaId) {
  if (!valorGuardado) return false;

  if (esHashBcrypt(valorGuardado)) {
    return bcrypt.compare(String(pinIngresado).trim(), valorGuardado);
  }

  // Legacy: PIN en texto plano. Comparación directa + re-hash silencioso.
  const coincide = String(pinIngresado).trim() === String(valorGuardado).trim();
  if (coincide) {
    const nuevoHash = await bcrypt.hash(String(pinIngresado).trim(), 10);
    await actualizarPinSupervisor(empresaId, nuevoHash);
  }
  return coincide;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const accion = req.query.accion;

  // ── Rate limiting ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (await limiterLectura(req, res)) return;
  } else {
    if (accion === 'verificar-pin') {
      if (await limiterPin(req, res)) return;
    } else {
      if (await limiterVenta(req, res)) return;
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  // FIX (Fase 7, hallazgo de paso, mismo patrón que empresa.js): esto antes
  // reimplementaba la verificación a mano (getUser + select propio a
  // `usuarios`) sin el filtro `activo=true` que sí exige `verificarToken`
  // desde la Etapa 11 de AUDITORIA_2026 — un usuario desactivado seguía
  // pudiendo operar la caja mientras su JWT de Supabase no expirara. Ahora
  // usa el helper compartido, igual que el resto de los handlers.
  const perfil = await verificarToken(req, supabase);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  // ── Ruteo ────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (accion === 'caja-estado')          return cajaEstadoHandler(req, res, perfil);
    if (accion === 'resumen-turno')        return resumenTurnoHandler(req, res, perfil);
    if (accion === 'cajas')                return cajasHandler(req, res, perfil);
    if (accion === 'productos')            return productosHandler(req, res, perfil);
    if (accion === 'ticket')               return ticketHandler(req, res, perfil);
    if (accion === 'ventas')               return ventasHandler(req, res, perfil);
    if (accion === 'depositos')            return depositosHandler(req, res, perfil);
    if (accion === 'transferencias-stock') return transferenciasStockHandler(req, res, perfil);
    if (accion === 'favoritos')            return getFavoritosHandler(req, res, perfil);
    if (accion === 'reporte-z')            return reporteZHandler(req, res, perfil);
    if (accion === 'cajas-admin')          return cajasAdminGetHandler(req, res, perfil);
    if (accion === 'historial-turnos')     return historialTurnosHandler(req, res, perfil);
    if (accion === 'movimientos-caja-log') return movimientosCajaLogHandler(req, res, perfil);
    if (accion === 'umbral-cajero')        return umbralCajeroGetHandler(req, res, perfil);
    // ── Fase 3 ──────────────────────────────────────────────────────────
    if (accion === 'stock-alerta')         return stockAlertaHandler(req, res, perfil);
    // ── Fase 4 ──────────────────────────────────────────────────────────
    if (accion === 'promociones')          return getPromocionesHandler(req, res, perfil);
    if (accion === 'devoluciones')         return getDevolucionesHandler(req, res, perfil);
    // ── Fase 5 (hardware) ────────────────────────────────────────────────
    if (accion === 'config-hardware')      return getConfigHardwareHandler(req, res, perfil);
  }

  if (req.method === 'POST') {
    if (accion === 'abrir-turno')        return abrirTurnoHandler(req, res, perfil);
    if (accion === 'cerrar-turno')       return cerrarTurnoHandler(req, res, perfil);
    if (accion === 'forzar-cierre-turno') return forzarCierreTurnoHandler(req, res, perfil);
    if (accion === 'anular')             return anularVentaHandler(req, res, perfil);
    if (accion === 'facturar')           return facturarVentaHandler(req, res, perfil);
    if (accion === 'transferir-stock')   return transferirStockHandler(req, res, perfil);
    if (accion === 'favoritos')          return postFavoritoHandler(req, res, perfil);
    if (accion === 'favoritos-quitar')   return quitarFavoritoHandler(req, res, perfil);
    if (accion === 'movimiento-caja')    return movimientoCajaHandler(req, res, perfil);
    if (accion === 'verificar-pin')      return verificarPinHandler(req, res, perfil);
    if (accion === 'cajas-admin')        return cajasAdminPostHandler(req, res, perfil);
    if (accion === 'umbral-cajero')      return umbralCajeroPostHandler(req, res, perfil);
    // ── Fase 3 ──────────────────────────────────────────────────────────
    if (accion === 'cliente-rapido')     return clienteRapidoHandler(req, res, perfil);
    if (accion === 'config-pin')         return configPinHandler(req, res, perfil);
    // ── Fase 4 ──────────────────────────────────────────────────────────
    if (accion === 'promociones')        return postPromocionesHandler(req, res, perfil);
    if (accion === 'devolucion')         return devolucionHandler(req, res, perfil);
    // ── Fase 5 (hardware) ────────────────────────────────────────────────
    if (accion === 'config-hardware')    return postConfigHardwareHandler(req, res, perfil);
    if (!accion)                         return registrarVentaHandler(req, res, perfil);
  }

  return res.status(404).json({ error: `Acción de POS desconocida: ${accion ?? '(sin especificar)'}` });
}

// ── GET /api/pos/caja-estado ─────────────────────────────────────────────
async function cajaEstadoHandler(req, res, perfil) {
  const { data, error } = await listarTurnosAbiertosDeUsuario(perfil.id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json({ turnos: data || [] });
}

// ── GET /api/pos/resumen-turno?turno_id= ────────────────────────────────
async function resumenTurnoHandler(req, res, perfil) {
  const { turno_id } = req.query;
  if (!turno_id) return res.status(400).json({ error: 'turno_id requerido' });

  const turno = await obtenerTurnoConEmpresa(turno_id);

  if (!turno || turno.cajas_pos?.empresa_id !== perfil.empresa_id) {
    return res.status(404).json({ error: 'Turno no encontrado' });
  }

  const { data: resultado, error } = await resumenTurnoCajaRpc(turno_id);

  if (error) {
    console.error('[POS] Error en resumen_turno_caja:', error);
    return res.status(500).json({ error: 'Error al calcular el resumen del turno' });
  }
  if (!resultado?.ok) {
    return res.status(404).json({ error: resultado?.error || 'Turno no encontrado' });
  }

  return res.json(resultado);
}

// ── GET /api/pos/cajas ───────────────────────────────────────────────────
async function cajasHandler(req, res, perfil) {
  const { data, error } = await listarCajasActivas(perfil.empresa_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json(data || []);
}

// ── POST /api/pos/abrir-turno ────────────────────────────────────────────
async function abrirTurnoHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos para operar caja' });
  }

  const { caja_id, monto_inicial } = req.body || {};
  if (!caja_id) return res.status(400).json({ error: 'caja_id requerido' });

  const caja = await obtenerCajaParaAbrirTurno(caja_id, perfil.empresa_id);

  if (!caja || !caja.activa) {
    return res.status(404).json({ error: 'Caja no encontrada o inactiva' });
  }

  // Bloquear venta si la caja no tiene depósito asignado
  if (!caja.deposito_id) {
    // Intentar asignar el depósito principal automáticamente
    const dep = await obtenerDepositoPrincipal(perfil.empresa_id);

    if (dep) {
      const { error: asignacionError } = await asignarDepositoACaja(caja_id, dep.id, perfil.empresa_id);
      if (asignacionError) {
        return errorSeguro(res, asignacionError, 500, 'No se pudo asignar el depósito a la caja.');
      }
      caja.deposito_id = dep.id;
    } else {
      return res.status(400).json({
        error: 'Esta caja no tiene un depósito asignado y la empresa no tiene depósitos configurados. Configurá un depósito antes de vender.',
      });
    }
  }

  const { data, error } = await insertarTurnoCaja({ caja_id, usuario_id: perfil.id, monto_inicial: monto_inicial || 0 });

  if (error) {
    if (error.code === '23505') {
      // Buscamos quién dejó la caja abierta y desde cuándo, para que el
      // mensaje sea accionable en vez de un error genérico.
      const turnoAbierto = await obtenerTurnoAbiertoDeCaja(caja_id);

      return res.status(409).json({
        error: 'Esta caja ya tiene un turno abierto',
        tipo: 'turno_abierto',
        turno_conflicto: turnoAbierto ? {
          id: turnoAbierto.id,
          usuario_nombre: turnoAbierto.usuarios?.nombre || 'otro usuario',
          abierto_at: turnoAbierto.abierto_at,
        } : null,
        puede_forzar_cierre: puede(perfil, 'administrar_cajas', 'pos'),
      });
    }
    return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }

  return res.status(201).json(data);
}

// ── POST /api/pos/forzar-cierre-turno ────────────────────────────────────
// Cierra administrativamente un turno "huérfano" (dejado abierto por otro
// usuario, sin arqueo físico posible) para destrabar la caja. Solo
// dueno/admin. Se registra como cierre forzado para auditoría — nunca se
// mezcla silenciosamente con un cierre normal con conteo de efectivo.
async function forzarCierreTurnoHandler(req, res, perfil) {
  if (!puede(perfil, 'administrar_cajas', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño o admin pueden forzar el cierre de un turno' });
  }

  const { turno_id, motivo } = req.body || {};
  if (!turno_id) return res.status(400).json({ error: 'turno_id requerido' });

  const turno = await obtenerTurnoConEstadoYEmpresa(turno_id);

  if (!turno || turno.cajas_pos?.empresa_id !== perfil.empresa_id) {
    return res.status(404).json({ error: 'Turno no encontrado' });
  }
  if (turno.estado === 'cerrado') {
    return res.status(400).json({ error: 'El turno ya estaba cerrado' });
  }

  const { data: resultado, error } = await forzarCierreTurnoCajaRpc(turno_id, perfil.id, motivo);

  if (error) {
    console.error('[POS] Error en forzar_cierre_turno_caja:', error);
    return res.status(500).json({ error: 'Error al forzar el cierre del turno' });
  }
  if (!resultado?.ok) {
    return res.status(400).json({ error: resultado?.error || 'No se pudo forzar el cierre del turno' });
  }

  return res.json(resultado);
}

// ── POST /api/pos/cerrar-turno ───────────────────────────────────────────
async function cerrarTurnoHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos para operar caja' });
  }

  const { turno_id, monto_final_declarado } = req.body || {};
  if (!turno_id || monto_final_declarado === undefined) {
    return res.status(400).json({ error: 'turno_id y monto_final_declarado son requeridos' });
  }

  const turno = await obtenerTurnoConEmpresa(turno_id);

  if (!turno || turno.cajas_pos?.empresa_id !== perfil.empresa_id) {
    return res.status(404).json({ error: 'Turno no encontrado' });
  }

  const puedeCerrarAjeno = puede(perfil, 'administrar_cajas', 'pos');
  if (turno.usuario_id !== perfil.id && !puedeCerrarAjeno) {
    return res.status(403).json({ error: 'Solo podés cerrar tu propio turno; un administrador debe hacerlo como override.' });
  }

  const { data: resultado, error } = await cerrarTurnoCajaRpc(turno_id, monto_final_declarado);

  if (error) {
    console.error('[POS] Error en cerrar_turno_caja:', error);
    return res.status(500).json({ error: 'Error al cerrar el turno' });
  }
  if (!resultado?.ok) {
    return res.status(400).json({ error: resultado?.error || 'No se pudo cerrar el turno' });
  }

  if (turno.usuario_id !== perfil.id) {
    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'turnos_caja', 'UPDATE', turno_id,
      { usuario_id: turno.usuario_id, estado: 'abierto' },
      { estado: 'cerrado', override: true, cerrado_por: perfil.id }
    );
  }

  return res.json(resultado);
}

// ── GET /api/pos/productos?q=... ─────────────────────────────────────────
async function productosHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos' });
  }

  const { q, caja_id, lista_precio_id } = req.query;
  if (!q || q.trim().length < 1) return res.json([]);

  let deposito_id = null;
  if (caja_id) {
    const caja = await obtenerCajaConDeposito(caja_id, perfil.empresa_id);

    if (!caja) {
      return res.status(404).json({
        error: 'No se pudo identificar la caja activa. Cerrá esta pantalla y volvé a abrir el turno antes de seguir vendiendo.',
      });
    }
    if (caja.deposito_id) {
      deposito_id = caja.deposito_id;
    } else {
      const dep = await obtenerDepositoPrincipal(perfil.empresa_id);
      if (dep) {
        deposito_id = dep.id;
        const { error: asignacionError } = await asignarDepositoACaja(caja_id, dep.id, perfil.empresa_id);
        if (asignacionError) {
          return errorSeguro(res, asignacionError, 500, 'No se pudo asignar el depósito a la caja.');
        }
      }
    }
  }

  const qTrim = q.trim();

  // ── Detección de código de balanza (EAN-13 que empieza con '2') ──────────
  // Formato estándar Argentina: 2 + PLU(5 dígitos) + peso_gramos(5 dígitos) + check(1)
  // Ejemplo: "2012340012505" → PLU="01234", peso=125g (0.125 kg)
  let codigoBalanza = null;
  let cantidadSugerida = null;
  if (/^2\d{12}$/.test(qTrim)) {
    const plu           = qTrim.substring(1, 6);  // 5 dígitos PLU
    const pesoGramos    = parseInt(qTrim.substring(6, 11), 10); // 5 dígitos peso
    cantidadSugerida    = Math.round((pesoGramos / 1000) * 1000) / 1000; // kg con 3 decimales
    codigoBalanza       = plu;
  }

  let productos;

  try {
    // Búsqueda por código de balanza (PLU en campo codigo, producto marcado como vendido_por_peso)
    if (codigoBalanza) {
      productos = await buscarProductosPos(perfil.empresa_id, {
        vendidoPorPeso: true,
        codigo: codigoBalanza,
        limit: 1,
      });
    }

    // Si no fue balanza o no encontró por PLU → match exacto normal
    if (!productos?.length) {
      productos = await buscarProductosPos(perfil.empresa_id, { codigo: qTrim, limit: 5 });
      // Si fue match exacto normal, no es balanza
      if (productos?.length) cantidadSugerida = null;
    }

    // Sin match exacto → búsqueda difusa (no aplica cantidad sugerida de balanza)
    if (!productos?.length) {
      cantidadSugerida = null;
      productos = await buscarProductosPos(perfil.empresa_id, { textoLibre: `%${qTrim}%`, limit: 20 });
    }
  } catch (error) {
    return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }

  if (!productos?.length) return res.json([]);

  const productoIds = productos.map(p => p.id);

  // Stock
  let stockMap = {};
  if (deposito_id) {
    const stockData = await obtenerStockPorProductos(deposito_id, productoIds);
    stockMap = Object.fromEntries(stockData.map(s => [s.producto_id, s.cantidad]));
  }

  // Precios por lista
  let precioMap = {};
  if (lista_precio_id) {
    const precios = await obtenerPreciosPorLista(lista_precio_id, productoIds);
    precioMap = Object.fromEntries(precios.map(p => [p.producto_id, p.precio]));
  }

  // Promociones vigentes de la empresa (para adjuntar al resultado)
  const hoy = new Date().toISOString().slice(0, 10);
  const promos = await listarPromocionesVigentes(perfil.empresa_id, hoy);

  // Categorías de los productos (para match de promo por categoría)
  const prods_cat = await obtenerCategoriasDeProductos(productoIds);
  const catMap = Object.fromEntries(prods_cat.map(p => [p.id, p.categoria_id]));

  const resultado = productos.map(p => {
    const precio = precioMap[p.id] ?? p.precio_base;

    // Buscar promo aplicable: primero por producto, luego por categoría
    let promoAplicable = null;
    if (promos?.length) {
      promoAplicable = promos.find(pr => pr.producto_id === p.id)
        || promos.find(pr => pr.categoria_id && pr.categoria_id === catMap[p.id]);
    }

    const base = {
      ...p,
      precio,
      stock_disponible: deposito_id ? (stockMap[p.id] ?? 0) : null,
    };

    if (cantidadSugerida !== null && p.vendido_por_peso) {
      base.cantidad_sugerida = cantidadSugerida;
      base.es_balanza = true;
    }

    if (promoAplicable) {
      base.promocion = {
        id:           promoAplicable.id,
        nombre:       promoAplicable.nombre,
        tipo:         promoAplicable.tipo,
        descuento_pct: promoAplicable.descuento_pct,
        n_cantidad:   promoAplicable.n_cantidad,
        m_paga:       promoAplicable.m_paga,
      };
    }

    return base;
  });

  return res.json(resultado);
}

// ── POST /api/pos (sin accion) — registrar venta ─────────────────────────
async function registrarVentaHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos para vender' });
  }

  const { caja_id, turno_id, cliente_id, items, pagos, descuento_global_pct, pin_supervisor, offline_local_id } = req.body || {};

  if (!caja_id || !turno_id) {
    return res.status(400).json({ error: 'caja_id y turno_id son requeridos' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'El carrito está vacío' });
  }
  if (!Array.isArray(pagos) || pagos.length === 0) {
    return res.status(400).json({ error: 'Falta indicar al menos un medio de pago' });
  }
  for (const item of items) {
    if (!item.producto_id || !item.cantidad || item.cantidad <= 0) {
      return res.status(400).json({ error: 'Item inválido en el carrito' });
    }
  }

  const descGlobalPct = Math.max(0, parseFloat(descuento_global_pct) || 0);
  if (descGlobalPct > 100) {
    return res.status(400).json({ error: 'El descuento global no puede superar el 100%.' });
  }

  // ── Validación server-side de descuentos por línea y global ──────────────
  // El total global afecta toda la venta y exige el mismo control que una línea.
  // El frontend ya lo hace, pero nunca hay que confiar solo en eso.
  const maxDescLinea = Math.max(0, ...items.map(i => Math.max(0, parseFloat(i.descuento_pct) || 0)));
  if (maxDescLinea > 100) {
    return res.status(400).json({ error: 'El descuento por línea no puede superar el 100%.' });
  }
  const maxDescSolicitado = Math.max(maxDescLinea, descGlobalPct);
  if (maxDescSolicitado > 0) {
    const [usuarioUmbral, { data: empresaPin }] = await Promise.all([
      obtenerUmbralDescuentoUsuario(perfil.id),
      obtenerPinSupervisor(perfil.empresa_id),
    ]);
    const umbral = usuarioUmbral?.supervisor_umbral_descuento_pct ?? 15;
    if (maxDescSolicitado > umbral) {
      if (!pin_supervisor || String(pin_supervisor).trim().length < 4) {
        return res.status(403).json({
          error: `Descuento del ${maxDescSolicitado}% supera el umbral autorizado (${umbral}%). Se requiere PIN de supervisor.`,
          requiere_pin: true,
        });
      }
      if (!empresaPin?.supervisor_pin) {
        return res.status(403).json({ error: 'No hay PIN de supervisor configurado. Pedile al administrador que lo configure en Ajustes.' });
      }
      if (!(await verificarYMigrarPin(pin_supervisor, empresaPin.supervisor_pin, perfil.empresa_id))) {
        return res.status(403).json({ error: 'PIN de supervisor incorrecto.', requiere_pin: true });
      }
    }
  }

  const caja = await obtenerCajaParaVenta(caja_id, perfil.empresa_id);

  if (!caja || !caja.activa) {
    return res.status(404).json({ error: 'Caja no encontrada o inactiva' });
  }

  // Bloquear venta si la caja no tiene depósito asignado
  if (!caja.deposito_id) {
    // Intentar asignar el depósito principal automáticamente
    const dep = await obtenerDepositoPrincipal(perfil.empresa_id);

    if (dep) {
      const { error: asignacionError } = await asignarDepositoACaja(caja_id, dep.id, perfil.empresa_id);
      if (asignacionError) {
        return errorSeguro(res, asignacionError, 500, 'No se pudo asignar el depósito a la caja.');
      }
      caja.deposito_id = dep.id;
    } else {
      return res.status(400).json({
        error: 'Esta caja no tiene un depósito asignado y la empresa no tiene depósitos configurados. Configurá un depósito antes de vender.',
      });
    }
  }

  if (cliente_id) {
    const cliente = await obtenerClienteActivoParaVenta(cliente_id, perfil.empresa_id);

    if (!cliente || !cliente.activo) {
      return res.status(400).json({ error: 'Cliente no encontrado o inactivo' });
    }
  }

  const productoIds = items.map(i => i.producto_id);
  const productosData = await obtenerProductosParaVentaPos(perfil.empresa_id, productoIds);

  const productosMap = Object.fromEntries(productosData.map(p => [p.id, p]));

  for (const item of items) {
    const prod = productosMap[item.producto_id];
    if (!prod || !prod.activo) {
      return res.status(400).json({ error: `Producto ${item.producto_id} no encontrado o inactivo` });
    }
  }

  // v176 (migración 162): antes acá solo se miraba precios_items vía la
  // lista asignada al cliente. Ahora se centraliza en resolver_precios_cliente,
  // que además contempla un precio especial puntual por cliente+producto
  // (prioridad: especial > lista > precio_base). Mismo punto que usa pedidos.js.
  // Si la venta es sin cliente (mostrador), no hay nada que resolver: precio_base.
  let precioMap = {};
  if (cliente_id) {
    const { data: preciosResueltos, error: errPrecios } = await resolverPreciosClienteRpc({
      cliente_id,
      producto_ids: productoIds,
      empresa_id:   perfil.empresa_id,
    });
    if (errPrecios) {
      console.error('[pos] error resolviendo precios:', errPrecios);
      return res.status(500).json({ error: 'No se pudieron resolver los precios' });
    }
    precioMap = Object.fromEntries((preciosResueltos || []).map(p => [p.producto_id, p.precio]));
  }

  // Calcular totales server-side
  let subtotal = 0;
  let iva_total = 0;
  const itemsParaRpc = [];

  for (const item of items) {
    const prod = productosMap[item.producto_id];
    const precioUnitario = precioMap[item.producto_id] ?? prod.precio_base;
    const descuentoPct   = Math.max(0, Math.min(100, parseFloat(item.descuento_pct) || 0)); // siempre 0-100

    const sub = precioUnitario * item.cantidad * (1 - descuentoPct / 100);
    const iva = sub * ((prod.iva ?? 21) / 100);

    subtotal  += sub;
    iva_total += iva;

    itemsParaRpc.push({
      producto_id:          item.producto_id,
      cantidad:             item.cantidad,
      precio_unitario:      precioUnitario,
      descuento_pct:        descuentoPct,
      subtotal:             Math.round(sub * 100) / 100,
      promocion_id:         item.promocion_id         || null,
      promocion_descripcion: item.promocion_descripcion || null,
    });
  }

  // Aplicar descuento global al total final.
  // Redondeo a peso entero (no a centavos): hoy no circulan fracciones de
  // peso, así que el total registrado debe coincidir con lo que el POS
  // muestra y cobra. Debe reflejar exactamente calcularTotales() del
  // frontend (frontend/admin/js/pos.js) para que no haya diferencias entre
  // lo mostrado en caja y lo guardado en la venta.
  const totalSinDescGlobal = subtotal + iva_total;
  const descGlobalMonto    = totalSinDescGlobal * (descGlobalPct / 100);
  const total               = Math.round(totalSinDescGlobal - descGlobalMonto);

  const MEDIOS_PAGO_POS_VALIDOS = new Set(['efectivo', 'transferencia', 'tarjeta', 'qr', 'cuenta_corriente']);
  for (const pago of pagos) {
    const montoPago = Number(pago.monto);
    if (!pago.medio || !MEDIOS_PAGO_POS_VALIDOS.has(pago.medio)) {
      return res.status(400).json({ error: `Medio de pago inválido: ${pago.medio || '(vacío)'}` });
    }
    if (!Number.isFinite(montoPago) || montoPago <= 0) {
      return res.status(400).json({ error: 'Cada pago debe tener un monto positivo y válido' });
    }
  }

  const sumaPagos = pagos.reduce((sum, pago) => sum + Number(pago.monto), 0);
  const sumaNoEfectivo = pagos
    .filter(pago => pago.medio !== 'efectivo')
    .reduce((sum, pago) => sum + Number(pago.monto), 0);
  if (sumaPagos < total - 0.01) {
    return res.status(400).json({ error: 'La suma de los pagos no alcanza el total de la venta' });
  }
  if (sumaNoEfectivo > total + 0.01) {
    return res.status(400).json({ error: 'Los medios distintos de efectivo no pueden superar el total de la venta' });
  }

  const { data: rpcResult, error: rpcError } = await registrarVentaPosRpc({
    p_empresa_id:           perfil.empresa_id,
    p_caja_id:              caja_id,
    p_turno_id:             turno_id,
    p_vendedor_id:          perfil.id,
    p_cliente_id:           cliente_id || null,
    p_deposito_id:          caja.deposito_id,
    p_items:                itemsParaRpc,
    p_pagos:                pagos,
    p_subtotal:             Math.round(subtotal * 100) / 100,
    p_iva_total:            Math.round(iva_total * 100) / 100,
    p_total:                total,
    p_descuento_global_pct: descGlobalPct,
    p_offline_local_id:     offline_local_id || null,
  });

  if (rpcError) {
    console.error('[POS] Error en RPC registrar_venta_pos:', rpcError);
    return res.status(500).json({ error: 'Error interno al registrar la venta. Intente nuevamente.' });
  }

  if (!rpcResult?.ok) {
    const tipo = rpcResult?.tipo;
    let mensaje = rpcResult?.error || 'No se pudo registrar la venta';

    if (tipo === 'stock_insuficiente') {
      const m = /stock_insuficiente:([0-9a-fA-F-]+)\s+disponible:(-?[\d.]+)/.exec(rpcResult?.error || '');
      const disp = m ? Number(m[2]) : null;
      const prod = m ? productosMap[m[1]] : null;
      mensaje = prod
        ? `No hay stock suficiente de "${prod.nombre}" en el depósito de esta caja (disponible: ${disp}).`
        : `No hay stock suficiente en el depósito de esta caja${disp !== null ? ` (disponible: ${disp})` : ''}.`;
    } else if (tipo === 'pagos_no_coinciden') {
      mensaje = 'Los montos ingresados no coinciden con el total de la venta. Revisá los medios de pago.';
    } else if (tipo === 'turno_cerrado') {
      mensaje = 'El turno de esta caja ya está cerrado. Abrí un nuevo turno para seguir vendiendo.';
    } else if (tipo === 'limite_credito') {
      mensaje = 'Esta venta supera el límite de crédito del cliente.';
    } else if (tipo === 'cliente_requerido') {
      mensaje = 'Para imputar a cuenta corriente primero tenés que elegir un cliente.';
    }

    const status = ({
      stock_insuficiente: 409,
      pagos_no_coinciden: 400,
      turno_cerrado:      409,
      limite_credito:     400,
      cliente_requerido:  400,
    })[tipo] || 500;

    return res.status(status).json({ error: mensaje, tipo });
  }

  // Auditoría: se omite en reintentos de sync offline (ya_existia) para no
  // loguear dos veces la misma venta real — mismo criterio que pedidos.js.
  // Punto 8 (auditoría 2026): venta real, dinero cobrado — variante durable.
  if (!rpcResult?.ya_existia) {
    await AuditRepo.registrarAuditoriaFinancieraDurable(
      perfil.empresa_id, perfil.id, 'ventas_pos', 'INSERT', rpcResult.venta_id, null,
      { cliente_id: cliente_id || null, total, medios_pago: pagos.map(p => p.medio) }
    );
  }

  // ── Facturación automática para ventas a cuenta corriente ──────────────
  // Antes había que ir al ticket y tocar "Facturar" a mano; mientras tanto
  // la deuda quedaba asentada en cta_cte pero invisible en Cobranzas (que
  // depende de la tabla `facturas`, no de cta_cte). Emitimos acá mismo,
  // reusando exactamente el mismo camino que el botón manual (ARCA/WSFEv1
  // vía emitirFactura). No se dispara en reintentos de sync offline
  // (ya_existia) para no reemitir sobre una venta ya facturada antes.
  // Si la emisión falla (ej: sin facturacion_config, ARCA caído), no se
  // aborta la venta — ya está confirmada y el stock descontado — se
  // informa el detalle en la respuesta para que el POS avise al vendedor.
  let facturaAutomatica = null;
  const requiereFacturaAuto = !rpcResult?.ya_existia &&
    Array.isArray(pagos) && pagos.some(p => p.medio === 'cuenta_corriente');

  if (requiereFacturaAuto) {
    try {
      const resultadoFactura = await emitirFactura({ venta_pos_id: rpcResult.venta_id });
      facturaAutomatica = resultadoFactura?.ok
        ? { ok: true, numero: resultadoFactura.factura?.numero || null }
        : { ok: false, error: resultadoFactura?.error || 'No se pudo facturar automáticamente' };
    } catch (errFactura) {
      console.error('[POS] Error al facturar automáticamente venta a cuenta corriente:', errFactura);
      facturaAutomatica = { ok: false, error: 'Error interno al facturar automáticamente' };
    }
  }

  // Si ya existía (reintento de sync offline detectado por el RPC), devolver 200 en vez de 201
  return res.status(rpcResult?.ya_existia ? 200 : 201).json({
    ...rpcResult,
    ...(facturaAutomatica ? { factura_automatica: facturaAutomatica } : {}),
  });
}

// ── POST /api/pos/anular ─────────────────────────────────────────────────
async function anularVentaHandler(req, res, perfil) {
  if (!puede(perfil, 'anular', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede anular ventas' });
  }

  const { venta_pos_id, motivo } = req.body || {};
  if (!venta_pos_id) return res.status(400).json({ error: 'venta_pos_id requerido' });
  if (!motivo?.trim()) return res.status(400).json({ error: 'El motivo de la anulación es obligatorio' });

  const venta = await obtenerVentaParaAnular(venta_pos_id, perfil.empresa_id);

  if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
  if (venta.estado === 'anulada') {
    return res.status(400).json({ error: 'La venta ya estaba anulada' });
  }
  // FIX (hallazgo: anulación de ventas facturadas): si la venta ya tiene una
  // factura con CAE emitida ante AFIP/ARCA, no la anulamos silenciosamente
  // — quedaría una factura fiscal válida sin la venta que la respalda. Para
  // corregir un error en una venta ya facturada hace falta una Nota de
  // Crédito (flujo aparte, todavía no automatizado desde acá).
  if (venta.factura_id) {
    return res.status(409).json({
      error: 'Esta venta ya tiene una factura con CAE emitida. Para anularla, emití antes una Nota de Crédito.',
    });
  }

  // FIX (auditoría pedido→factura→cta_cte→cobro, Hallazgo 6): antes esto
  // era un loop de llamadas sueltas (leer stock, actualizar stock, insertar
  // movimiento, por ítem; luego el crédito en cta_cte; recién al final el
  // UPDATE de estado). Un corte a mitad de camino dejaba stock restaurado
  // sin marcar la venta como anulada, y un reintento duplicaba esa
  // restauración. Ahora todo pasa por una única RPC transaccional e
  // idempotente, igual que registrar_venta_pos hace para la creación.
  const { data: resultado, error: errAnular } = await anularVentaPosRpc(venta_pos_id, perfil.id, motivo);

  if (errAnular || !resultado?.ok) {
    return errorSeguro(res, errAnular, 500, 'No se pudo completar la operación.');
  }

  // Punto 8 (auditoría 2026): anulación de venta real — variante durable.
  await AuditRepo.registrarAuditoriaFinancieraDurable(
    perfil.empresa_id, perfil.id, 'ventas_pos', 'UPDATE', venta_pos_id,
    { estado: venta.estado }, { estado: 'anulada', motivo }
  );

  return res.json({ ok: true });
}

// ── POST /api/pos/facturar ───────────────────────────────────────────────
async function facturarVentaHandler(req, res, perfil) {
  if (!puede(perfil, 'facturar', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede facturar ventas' });
  }
  if (await limiterFacturar(req, res)) return;

  const { venta_pos_id } = req.body || {};
  if (!venta_pos_id) return res.status(400).json({ error: 'venta_pos_id requerido' });

  const venta = await obtenerVentaParaFacturar(venta_pos_id, perfil.empresa_id);

  if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
  if (venta.estado === 'anulada') {
    return res.status(400).json({ error: 'No se puede facturar una venta anulada' });
  }

  const resultado = await emitirFactura({ venta_pos_id: venta.id });
  if (!resultado?.ok) {
    return res.status(422).json({ error: resultado?.error || 'No se pudo emitir la factura' });
  }

  return res.status(200).json({ ok: true, factura: resultado.factura });
}

// ── GET /api/pos/ticket?venta_id= ───────────────────────────────────────
async function ticketHandler(req, res, perfil) {
  const { venta_id } = req.query;
  if (!venta_id) return res.status(400).json({ error: 'venta_id requerido' });

  const { data, error } = await obtenerVentaParaTicket(venta_id, perfil.empresa_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  if (!data) return res.status(404).json({ error: 'Venta no encontrada' });
  return res.json(data);
}

// ── GET /api/pos/ventas?q=...&desde=...&hasta=...&limit=...&offset=... ────
async function ventasHandler(req, res, perfil) {
  if (!puede(perfil, 'anular', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede ver el listado de ventas' });
  }

  const { q, estado, desde, hasta } = req.query;
  const limit  = Math.min(parseInt(req.query.limit) || 30, 1000);
  const offset = parseInt(req.query.offset) || 0;

  const { data, error } = await listarVentasPos({ empresa_id: perfil.empresa_id, q, estado, desde, hasta, limit, offset });
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json(data || []);
}

// ── GET /api/pos/depositos ───────────────────────────────────────────────
async function depositosHandler(req, res, perfil) {
  if (!puede(perfil, 'transferir', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos para ver depósitos' });
  }

  const { data, error } = await listarDepositosConNombre(perfil.empresa_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json(data || []);
}

// ── GET /api/pos/transferencias-stock ───────────────────────────────────
async function transferenciasStockHandler(req, res, perfil) {
  if (!puede(perfil, 'anular', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede ver el historial' });
  }

  const depIds = await listarDepositosIds(perfil.empresa_id);
  if (!depIds.length) return res.json([]);

  const { data, error } = await listarTransferenciasStock(depIds);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json(data || []);
}

// ── POST /api/pos/transferir-stock ───────────────────────────────────────
async function transferirStockHandler(req, res, perfil) {
  if (!puede(perfil, 'transferir', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos para transferir stock' });
  }

  const { producto_id, deposito_origen, deposito_destino, cantidad, notas } = req.body || {};

  const cantidadNumerica = Number(cantidad);
  if (!producto_id || !deposito_origen || !deposito_destino || !Number.isFinite(cantidadNumerica) || cantidadNumerica <= 0) {
    return res.status(400).json({
      error: 'producto_id, deposito_origen, deposito_destino y cantidad positiva son requeridos',
    });
  }
  if (deposito_origen === deposito_destino) {
    return res.status(400).json({ error: 'El depósito de origen y destino no pueden ser el mismo' });
  }

  const cantidadDepositos = await contarDepositosDeEmpresa(perfil.empresa_id, [deposito_origen, deposito_destino]);

  if (cantidadDepositos !== 2) {
    return res.status(403).json({ error: 'Uno de los depósitos no pertenece a esta empresa' });
  }

  const { data: resultado, error } = await transferirStockEntreDepositosRpc({
    producto_id,
    deposito_origen,
    deposito_destino,
    cantidad: cantidadNumerica,
    usuario_id: perfil.id,
    notas,
  });

  if (error) {
    console.error('[POS] Error en transferir_stock_entre_depositos:', error);
    return res.status(500).json({ error: 'Error interno al transferir stock' });
  }
  if (!resultado?.ok) {
    return res.status(400).json({ error: resultado?.error, tipo: resultado?.tipo });
  }

  await AuditRepo.registrarAuditoriaSilenciosa(
    perfil.empresa_id, perfil.id, 'stock', 'UPDATE', producto_id,
    null, { deposito_origen, deposito_destino, cantidad, notas: notas || null }
  );

  return res.json(resultado);
}

// ══════════════════════════════════════════════════════════════════════════
// FASE 2 — ENDPOINTS NUEVOS
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/pos/favoritos ───────────────────────────────────────────────
// Devuelve la grilla de favoritos enriquecida con nombre/precio/stock del
// depósito de la caja activa (si se envía caja_id en query params).
async function getFavoritosHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos' });
  }

  const { caja_id } = req.query;

  // Favoritos de la empresa, en orden
  const { data: favs, error: errFavs } = await listarFavoritosPos(perfil.empresa_id);

  if (errFavs) return errorSeguro(res, errFavs, 500, 'No se pudo completar la operación.');
  if (!favs?.length) return res.json([]);

  const productoIds = favs.map(f => f.producto_id);

  // Stock del depósito de la caja (opcional, si se pasa caja_id)
  let stockMap = {};
  if (caja_id) {
    const caja = await obtenerCajaConDeposito(caja_id, perfil.empresa_id);

    if (caja?.deposito_id) {
      const stockData = await obtenerStockPorProductos(caja.deposito_id, productoIds);
      stockMap = Object.fromEntries(stockData.map(s => [s.producto_id, s.cantidad]));
    }
  }

  const resultado = favs.map(f => ({
    id:              f.id,
    producto_id:     f.producto_id,
    nombre:          f.productos?.nombre || '',
    codigo:          f.productos?.codigo || '',
    etiqueta:        f.etiqueta || f.productos?.nombre || '',
    color:           f.color || '#28a745',
    precio:          f.productos?.precio_base || 0,
    iva:             f.productos?.iva ?? 21,
    unidad:          f.productos?.unidad || 'un',
    stock_disponible: caja_id ? (stockMap[f.producto_id] ?? 0) : null,
  }));

  return res.json(resultado);
}

// ── POST /api/pos/favoritos ──────────────────────────────────────────────
// Body: { producto_id, etiqueta?, color?, orden? }
async function postFavoritoHandler(req, res, perfil) {
  if (!puede(perfil, 'anular', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede gestionar favoritos' });
  }

  const { producto_id, etiqueta, color, orden } = req.body || {};
  if (!producto_id) return res.status(400).json({ error: 'producto_id requerido' });

  // Verificar que el producto pertenece a la empresa
  if (!(await perteneceProductoAEmpresa(producto_id, perfil.empresa_id))) {
    return res.status(404).json({ error: 'Producto no encontrado' });
  }

  const { data, error } = await upsertFavoritoPos({ empresa_id: perfil.empresa_id, producto_id, etiqueta, color, orden });

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  await AuditRepo.registrarAuditoriaSilenciosa(
    perfil.empresa_id, perfil.id, 'favoritos_pos', 'INSERT', data?.id || producto_id,
    null, { producto_id, etiqueta, color, orden }
  );

  return res.status(201).json(data);
}

// ── POST /api/pos/favoritos-quitar ──────────────────────────────────────
// Body: { id }
async function quitarFavoritoHandler(req, res, perfil) {
  if (!puede(perfil, 'anular', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede gestionar favoritos' });
  }

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id requerido' });

  const { error } = await eliminarFavoritoPos(id, perfil.empresa_id);  // scope multi-tenant

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  await AuditRepo.registrarAuditoriaSilenciosa(
    perfil.empresa_id, perfil.id, 'favoritos_pos', 'DELETE', id, null, null
  );

  return res.json({ ok: true });
}

// ── POST /api/pos/movimiento-caja ────────────────────────────────────────
// Body: { turno_id, tipo, monto, concepto? }
// Registra sangría, refuerzo o retiro final del turno activo.
async function movimientoCajaHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos para registrar movimientos de caja' });
  }

  const { turno_id, tipo, monto, concepto } = req.body || {};

  if (!turno_id) return res.status(400).json({ error: 'turno_id requerido' });
  if (!['sangria', 'refuerzo', 'retiro_final'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo debe ser sangria, refuerzo o retiro_final' });
  }
  if (!monto || isNaN(parseFloat(monto)) || parseFloat(monto) <= 0) {
    return res.status(400).json({ error: 'monto debe ser mayor a cero' });
  }

  // Verificar que el turno es de una caja de esta empresa y está abierto
  const turno = await obtenerTurnoConEstadoYEmpresa(turno_id);

  if (!turno || turno.cajas_pos?.empresa_id !== perfil.empresa_id) {
    return res.status(404).json({ error: 'Turno no encontrado' });
  }
  const puedeMoverCajaAjena = puede(perfil, 'administrar_cajas', 'pos');
  if (turno.usuario_id !== perfil.id && !puedeMoverCajaAjena) {
    return res.status(403).json({ error: 'Solo podés mover dinero de tu propio turno; un administrador debe hacerlo como override.' });
  }
  if (turno.estado !== 'abierto') {
    return res.status(409).json({ error: 'El turno ya está cerrado' });
  }

  const { data, error } = await insertarMovimientoCaja({
    empresa_id: perfil.empresa_id,
    turno_id,
    tipo,
    monto:      parseFloat(monto),
    concepto:   concepto?.trim() || null,
    usuario_id: perfil.id,
  });

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  // Auditoría (v455): sangría/refuerzo/retiro final — dinero saliendo o
  // entrando a la caja fuera del flujo normal de venta, mismo criterio
  // "dinero real moviéndose" que registrarVentaHandler (v721).
  // Punto 8 (auditoría 2026): movimiento de caja real — variante durable.
  await AuditRepo.registrarAuditoriaFinancieraDurable(
    perfil.empresa_id, perfil.id, 'movimientos_caja', 'INSERT', data?.id || turno_id,
    null, { turno_id, tipo, monto: parseFloat(monto), concepto: concepto?.trim() || null }
  );

  return res.status(201).json(data);
}

// ── POST /api/pos/verificar-pin ──────────────────────────────────────────
// Body: { pin }
// Verifica el PIN de supervisor de la empresa.
// Rate-limited a 10/min para dificultar fuerza bruta.
// PIN hasheado con bcrypt (ver verificarYMigrarPin); PINs legacy en texto
// plano se migran automáticamente al hash en la primera verificación exitosa.
async function verificarPinHandler(req, res, perfil) {
  const { pin } = req.body || {};

  if (!pin || String(pin).trim().length < 4) {
    return res.status(400).json({ error: 'El PIN debe tener al menos 4 dígitos' });
  }

  const { data: empresa, error } = await obtenerPinSupervisor(perfil.empresa_id);

  if (error) return res.status(500).json({ error: 'Error al verificar el PIN' });

  if (!empresa?.supervisor_pin) {
    // Sin PIN configurado: dueño/admin pasan automáticamente; otros no.
    if (puede(perfil, 'anular', 'pos')) {
      return res.json({ ok: true });
    }
    return res.status(400).json({
      error: 'No hay PIN de supervisor configurado. Pedile al administrador que lo configure en Ajustes.',
    });
  }

  if (!(await verificarYMigrarPin(pin, empresa.supervisor_pin, perfil.empresa_id))) {
    return res.status(401).json({ error: 'PIN incorrecto' });
  }

  return res.json({ ok: true });
}

// ── GET /api/pos/reporte-z?turno_id= ────────────────────────────────────
// Reporte completo de cierre tipo "Z": medios de pago, movimientos de caja,
// efectivo esperado, lista de ventas del turno.
async function reporteZHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos' });
  }

  const { turno_id } = req.query;
  if (!turno_id) return res.status(400).json({ error: 'turno_id requerido' });

  // Turno + caja + vendedor + empresa
  const { data: turno, error: errTurno } = await obtenerTurnoParaReporteZ(turno_id);

  // usuarios!usuario_id: turnos_caja tiene DOS FKs a usuarios (usuario_id y
  // cerrado_forzado_por desde forzar_cierre_turno_caja_huerfano). Sin el
  // hint, PostgREST tira "more than one relationship was found" y esta
  // consulta rompe con 500 — que es exactamente el bug del Reporte Z
  // ("No se pudo completar la operación"). Mismo patrón ya resuelto en
  // historialTurnosHandler más abajo; acá se había quedado sin el fix.
  if (errTurno) return errorSeguro(res, errTurno, 500, 'No se pudo completar la operación.');
  if (!turno || turno.cajas_pos?.empresa_id !== perfil.empresa_id) {
    return res.status(404).json({ error: 'Turno no encontrado' });
  }

  // Ventas del turno
  const ventas = await listarVentasDelTurno(turno_id);

  // Movimientos de caja del turno
  const movimientos = await listarMovimientosDelTurno(turno_id);

  // Calcular totales por medio de pago (solo ventas completadas)
  const ventasCompletadas = (ventas || []).filter(v => v.estado === 'completada');
  const porMedio = {};
  for (const v of ventasCompletadas) {
    for (const p of (v.venta_pos_pagos || [])) {
      porMedio[p.medio] = (porMedio[p.medio] || 0) + p.monto;
    }
  }

  // Total vendido (suma de todos los medios)
  const totalVentas = Object.values(porMedio).reduce((s, v) => s + v, 0);

  // Efectivo esperado = inicial + cobros_efectivo + neto_movimientos
  const efectivoVentas = porMedio['efectivo'] || 0;
  const netoMovimientos = (movimientos || []).reduce((s, m) =>
    s + (m.tipo === 'refuerzo' ? m.monto : -m.monto), 0
  );
  const efectivoEsperado = turno.monto_inicial + efectivoVentas + netoMovimientos;

  return res.json({
    // Datos de cabecera
    empresa_nombre:  turno.cajas_pos?.empresas?.nombre || '',
    caja_nombre:     turno.cajas_pos?.nombre || '',
    vendedor_nombre: turno.usuarios?.nombre  || '',
    abierto_at:      turno.abierto_at,
    cerrado_at:      turno.cerrado_at || null,

    // Caja
    monto_inicial:          turno.monto_inicial,
    por_medio:              porMedio,
    total_ventas:           Math.round(totalVentas),

    // Movimientos de caja
    movimientos: (movimientos || []).map(m => ({
      tipo:     m.tipo,
      concepto: m.concepto,
      monto:    m.monto,
      hora:     m.created_at,
    })),

    // Arqueo
    efectivo_esperado:      Math.round(efectivoEsperado),
    monto_final_declarado:  turno.monto_final_declarado  ?? null,
    diferencia_arqueo:      turno.diferencia             ?? null,

    // Lista de ventas del turno
    ventas: (ventas || []).map(v => ({
      numero:  v.numero,
      cliente: v.clientes?.razon_social || 'Consumidor final',
      total:   v.total,
      estado:  v.estado,
    })),
  });
}

// ══════════════════════════════════════════════════════════════════════════
// GESTIÓN DE CAJAS — agregado v141
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/pos/historial-turnos ───────────────────────────────────────
// Lista turnos CERRADOS de la empresa (paginado, con filtros opcionales de
// caja y fecha) para que el admin pueda revisar diferencias de arqueo
// pasadas sin tener que reabrir el POS. Antes de esto la única forma de ver
// una diferencia era el instante mismo del cierre (toast), sin poder
// volver a consultarla después.
async function historialTurnosHandler(req, res, perfil) {
  if (!puede(perfil, 'administrar_cajas', 'pos')) {
    return res.status(403).json({ error: 'Solo dueno/admin pueden ver el historial de cierres' });
  }

  const { caja_id, desde, hasta, solo_con_diferencia, page = '1', limit = '20' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const { data, error, count } = await listarHistorialTurnos({
    empresa_id: perfil.empresa_id,
    caja_id, desde, hasta, solo_con_diferencia,
    offset, limit: parseInt(limit),
  });
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  return res.json({
    turnos: (data || []).map(t => ({
      id:                     t.id,
      caja_nombre:            t.cajas_pos?.nombre || '',
      vendedor_nombre:        t.usuarios?.nombre || '',
      abierto_at:             t.abierto_at,
      cerrado_at:             t.cerrado_at,
      monto_inicial:          t.monto_inicial,
      monto_final_declarado:  t.monto_final_declarado,
      monto_final_calculado:  t.monto_final_calculado,
      diferencia:             t.diferencia,
    })),
    total: count || 0,
  });
}

// ── GET /api/pos/cajas-admin ──────────────────────────────────────────────
// Devuelve TODAS las cajas de la empresa (activas e inactivas), con el
// turno abierto de cada una (si lo hay) para poder ofrecer "Forzar cierre"
// directo desde el admin, sin tener que pasar por el POS.
async function cajasAdminGetHandler(req, res, perfil) {
  if (!puede(perfil, 'administrar_cajas', 'pos')) {
    return res.status(403).json({ error: 'Solo dueno/admin pueden gestionar cajas' });
  }

  const { data, error } = await listarCajasAdminConTurno(perfil.empresa_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  // El filtro .eq('turnos_caja.estado', ...) acota el embed sin excluir
  // cajas sin turno abierto (no es inner join) — por constraint único en
  // turnos_caja, a lo sumo un elemento en el array.
  const resultado = (data || []).map(c => {
    const turnoAbierto = (c.turnos_caja || [])[0] || null;
    const { turnos_caja, ...cajaSinTurnos } = c;
    return {
      ...cajaSinTurnos,
      turno_abierto: turnoAbierto ? {
        id: turnoAbierto.id,
        abierto_at: turnoAbierto.abierto_at,
        usuario_nombre: turnoAbierto.usuarios?.nombre || null,
      } : null,
    };
  });

  return res.json(resultado);
}


// ── POST /api/pos/cajas-admin ─────────────────────────────────────────────
// Acciones: crear | editar | activar | desactivar
async function cajasAdminPostHandler(req, res, perfil) {
  if (!puede(perfil, 'administrar_cajas', 'pos')) {
    return res.status(403).json({ error: 'Solo dueno/admin pueden gestionar cajas' });
  }

  const { accion, id, nombre, deposito_id } = req.body || {};

  // ── Crear ────────────────────────────────────────────────────────────────
  if (accion === 'crear') {
    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!deposito_id)    return res.status(400).json({ error: 'El depósito es obligatorio' });

    if (!(await existeDepositoEnEmpresa(deposito_id, perfil.empresa_id))) {
      return res.status(400).json({ error: 'Depósito no encontrado o no pertenece a tu empresa' });
    }

    const dup = await buscarCajaPorNombre(perfil.empresa_id, nombre.trim());

    if (dup) return res.status(409).json({ error: 'Ya existe una caja con ese nombre' });

    const { data, error } = await crearCajaPos({ empresa_id: perfil.empresa_id, deposito_id, nombre: nombre.trim() });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'cajas_pos', 'INSERT', data?.id,
      null, { nombre: nombre.trim(), deposito_id }
    );

    return res.status(201).json(data);
  }

  // Las acciones siguientes requieren id
  if (!id) return res.status(400).json({ error: 'id de caja requerido' });

  const cajaExistente = await obtenerCajaPosPorId(id, perfil.empresa_id);

  if (!cajaExistente) return res.status(404).json({ error: 'Caja no encontrada' });

  // ── Editar ───────────────────────────────────────────────────────────────
  if (accion === 'editar') {
    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!deposito_id)    return res.status(400).json({ error: 'El depósito es obligatorio' });

    if (!(await existeDepositoEnEmpresa(deposito_id, perfil.empresa_id))) {
      return res.status(400).json({ error: 'Depósito no encontrado o no pertenece a tu empresa' });
    }

    const dup = await buscarOtraCajaConNombre(perfil.empresa_id, nombre.trim(), id);

    if (dup) return res.status(409).json({ error: 'Ya existe otra caja con ese nombre' });

    const { data, error } = await actualizarCajaPos(id, { nombre: nombre.trim(), deposito_id });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'cajas_pos', 'UPDATE', id,
      { nombre: cajaExistente.nombre },
      { nombre: nombre.trim(), deposito_id }
    );

    return res.json(data);
  }

  // ── Activar ──────────────────────────────────────────────────────────────
  if (accion === 'activar') {
    const { error } = await activarCajaPos(id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'cajas_pos', 'UPDATE', id, { activa: false }, { activa: true }
    );

    return res.json({ ok: true });
  }

  // ── Desactivar ───────────────────────────────────────────────────────────
  if (accion === 'desactivar') {
    const turnoAbierto = await obtenerTurnoAbiertoDeCaja(id);

    if (turnoAbierto) {
      return res.status(409).json({
        error: 'No podés desactivar esta caja porque tiene un turno abierto. Cerrálo primero desde el POS.'
      });
    }

    const { error } = await desactivarCajaPos(id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'cajas_pos', 'UPDATE', id, { activa: true }, { activa: false }
    );

    return res.json({ ok: true });
  }

  return res.status(400).json({ error: `Acción desconocida: ${accion}` });
}

// ── GET /api/pos/movimientos-caja-log?desde=&hasta= ────────────────────────
// Log auditable de sangrías/refuerzos/retiros de todos los turnos de la
// empresa en el rango de fechas dado (audit v197 — antes solo existía el
// botón en el HTML, sin backend).
async function movimientosCajaLogHandler(req, res, perfil) {
  if (!puede(perfil, 'administrar_cajas', 'pos')) {
    return res.status(403).json({ error: 'Solo dueno/admin pueden ver el log de movimientos de caja' });
  }

  const { desde, hasta } = req.query;

  const { data, error } = await listarMovimientosCajaLog({ empresa_id: perfil.empresa_id, desde, hasta });
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  return res.json({ movimientos: data || [] });
}

// ── GET /api/pos/umbral-cajero ──────────────────────────────────────────────
// Lista cajeros/vendedores de la empresa con su umbral de descuento configurado
// (para el panel "Umbral de descuento por cajero" — antes el HTML no tenía
// backend detrás).
async function umbralCajeroGetHandler(req, res, perfil) {
  if (!puede(perfil, 'administrar_cajas', 'pos')) {
    return res.status(403).json({ error: 'Solo dueno/admin pueden configurar umbrales' });
  }

  const { data, error } = await listarUsuariosParaUmbral(perfil.empresa_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json({ usuarios: data || [] });
}

// ── POST /api/pos/umbral-cajero ─────────────────────────────────────────────
// Body: { usuario_id, umbral_pct }  (umbral_pct null = usa el default de 15%)
async function umbralCajeroPostHandler(req, res, perfil) {
  if (!puede(perfil, 'administrar_cajas', 'pos')) {
    return res.status(403).json({ error: 'Solo dueno/admin pueden configurar umbrales' });
  }

  const { usuario_id, umbral_pct } = req.body || {};
  if (!usuario_id) return res.status(400).json({ error: 'usuario_id requerido' });

  if (umbral_pct != null) {
    const n = Number(umbral_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return res.status(400).json({ error: 'umbral_pct debe ser un número entre 0 y 100' });
    }
  }

  const existeDestino = await existeUsuarioEnEmpresa(usuario_id, perfil.empresa_id);

  if (!existeDestino) return res.status(404).json({ error: 'Usuario no encontrado en tu empresa' });

  const { error } = await actualizarUmbralUsuario(usuario_id, umbral_pct == null ? null : Number(umbral_pct));

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  await AuditRepo.registrarAuditoriaSilenciosa(
    perfil.empresa_id, perfil.id, 'usuarios', 'UPDATE', usuario_id,
    null, { umbral_descuento_pct: umbral_pct == null ? null : Number(umbral_pct) }
  );

  return res.json({ ok: true });
}

// ══════════════════════════════════════════════════════════════════════════
// FASE 3 — ENDPOINTS NUEVOS (v142)
// ══════════════════════════════════════════════════════════════════════════

// ── POST /api/pos/cliente-rapido ─────────────────────────────────────────
// Alta mínima de cliente desde la caja, sin salir del POS.
// Campos obligatorios: razon_social.
// Campos opcionales: cuit, telefono, email, condicion_iva.
// Se crea siempre con activo=true y condicion_final por defecto si no se
// especifica condicion_iva (el cajero puede no saber la condición exacta).
async function clienteRapidoHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos para crear clientes' });
  }

  const { razon_social, cuit, telefono, email, condicion_iva } = req.body || {};

  if (!razon_social?.trim()) {
    return res.status(400).json({ error: 'El nombre / razón social es obligatorio' });
  }

  // Normaliza CUIT/DNI: solo dígitos → si son 11, formatea como CUIT con
  // guiones (XX-XXXXXXXX-X); si son 7-8, es un DNI y se guarda tal cual.
  // Cualquier otra cantidad de dígitos es inválida (ver constraint
  // clientes_cuit_formato, migración 415).
  let cuitNormalizado = null;
  if (cuit?.trim()) {
    const soloDigitos = cuit.trim().replace(/\D/g, '');
    if (soloDigitos.length === 11) {
      cuitNormalizado = `${soloDigitos.slice(0, 2)}-${soloDigitos.slice(2, 10)}-${soloDigitos.slice(10)}`;
    } else if (soloDigitos.length === 7 || soloDigitos.length === 8) {
      cuitNormalizado = soloDigitos;
    } else {
      return res.status(400).json({
        error: 'CUIT/DNI inválido: el CUIT debe tener 11 dígitos y el DNI 7 u 8 dígitos.',
      });
    }
  }

  // Si viene CUIT, verificar que no exista ya en la empresa
  if (cuitNormalizado) {
    const dup = await buscarClientePorCuit(perfil.empresa_id, cuitNormalizado);

    if (dup) {
      return res.status(409).json({
        error: `Ya existe un cliente con ese CUIT: "${dup.razon_social}". Buscalo por nombre o CUIT en el buscador de clientes.`,
        cliente_existente: { id: dup.id, razon_social: dup.razon_social },
      });
    }
  }

  const campos = {
    empresa_id:    perfil.empresa_id,
    razon_social:  razon_social.trim(),
    cuit:          cuitNormalizado,
    telefono:      telefono?.trim() || null,
    email:         email?.trim()    || null,
    condicion_iva: condicion_iva    || 'consumidor_final',
    activo:        true,
  };

  const { data, error } = await crearClienteRapido(campos);

  if (error) {
    console.error('[POS] Error al crear cliente rápido:', error);
    // 23505 = unique_violation (podría ser una carrera con el check de arriba)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un cliente con ese CUIT/DNI en tu empresa.' });
    }
    return res.status(500).json({ error: 'No se pudo crear el cliente. Intentá de nuevo.' });
  }

  return res.status(201).json(data);
}

// ── POST /api/pos/config-pin ─────────────────────────────────────────────
// Guarda o actualiza el PIN de supervisor de la empresa.
// Solo dueño/admin. PIN puede ser null para desactivar la función.
// Validación: si viene valor, debe tener entre 4 y 8 dígitos numéricos.
// ── GET /api/pos/config-hardware ─────────────────────────────────────────
// AUDITORÍA 584 — antes esto era una config única por empresa
// (empresas.config->pos_hardware), pero cajas_pos está diseñada desde el
// origen para varias cajas físicas en simultáneo, cada una con su propia
// terminal/impresora. Ahora requiere `caja_id` para devolver la config de
// ESA caja puntual; sin `caja_id` (ej. arranque del POS antes de que se
// sepa en qué caja va a operar el cajero) devuelve defaults neutros —
// `usarTurno()`/`abrirTurno()` en el frontend vuelven a pedir esto pasando
// `caja_id` apenas se sabe con cuál caja se está trabajando.
// Solo un rol con permiso de venta puede leer configuración de hardware POS.
async function getConfigHardwareHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos para consultar la configuración de hardware POS' });
  }

  const { data: empresa, error } = await obtenerEmpresaParaHardware(perfil.empresa_id);
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  const empresaResp = {
    nombre:    empresa?.nombre    || '',
    cuit:      empresa?.cuit      || '',
    domicilio: empresa?.domicilio || '',
    telefono:  empresa?.telefono  || '',
  };

  const { caja_id } = req.query;
  if (!caja_id) {
    // Sin caja todavía elegida: defaults neutros, no se lee ninguna caja.
    return res.json({
      empresa:   empresaResp,
      impresora: { modo: 'browser' },
      terminal:  { driver: 'manual' },
    });
  }

  const { data: caja, error: errorCaja } = await obtenerCajaHardwareConfig(caja_id, perfil.empresa_id);
  if (errorCaja) return errorSeguro(res, errorCaja, 500, 'No se pudo completar la operación.');
  if (!caja) return res.status(404).json({ error: 'Caja no encontrada' });

  const hw = caja.hardware_config || {};

  return res.json({
    empresa:   empresaResp,
    caja:      { id: caja.id, nombre: caja.nombre },
    impresora: hw.impresora || { modo: 'browser' },
    terminal:  hw.terminal  || { driver: 'manual' },
  });
}

// ── POST /api/pos/config-hardware ────────────────────────────────────────
// Requiere caja_id: guarda la config de impresora/terminal de ESA caja
// puntual, no de toda la empresa (584). Solo dueño/admin puede modificarla.
async function postConfigHardwareHandler(req, res, perfil) {
  if (!puede(perfil, 'facturar', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede configurar el hardware del POS' });
  }

  const { caja_id, impresora, terminal } = req.body || {};
  if (!caja_id) return res.status(400).json({ error: 'Falta caja_id: elegí qué caja estás configurando' });
  if (!impresora && !terminal) {
    return res.status(400).json({ error: 'Nada para guardar: falta impresora o terminal' });
  }

  const { data: cajaActual, error: errorCaja } = await obtenerCajaHardwareConfig(caja_id, perfil.empresa_id);
  if (errorCaja) return errorSeguro(res, errorCaja, 500, 'No se pudo completar la operación.');
  if (!cajaActual) return res.status(404).json({ error: 'Caja no encontrada' });

  const hwActual = cajaActual.hardware_config || {};
  const hwNuevo = {
    ...hwActual,
    ...(impresora ? { impresora } : {}),
    ...(terminal  ? { terminal  } : {}),
  };

  const { data: actualizado, error } = await actualizarCajaHardwareConfig(caja_id, perfil.empresa_id, hwNuevo);
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  if (!actualizado) return res.status(404).json({ error: 'Caja no encontrada' });

  await AuditRepo.registrarAuditoriaSilenciosa(
    perfil.empresa_id, perfil.id, 'cajas_pos', 'UPDATE', caja_id,
    { hardware_config: hwActual }, { hardware_config: hwNuevo }
  );

  return res.json({ ok: true });
}

async function configPinHandler(req, res, perfil) {
  if (!puede(perfil, 'facturar', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede configurar el PIN de supervisor' });
  }

  const { pin } = req.body || {};

  // pin === null o pin === '' → desactivar PIN
  if (pin === null || pin === '') {
    const { error } = await actualizarPinSupervisor(perfil.empresa_id, null);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // Auditoría: nunca se guarda el PIN ni su hash en audit_log, solo el
    // hecho de que se desactivó — mismo criterio que "Conectar cuenta MP"
    // en pagos.js (v722): auditar metadata, nunca el secreto.
    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'empresas', 'UPDATE', perfil.empresa_id,
      null, { pin_supervisor_activo: false }
    );

    return res.json({ ok: true, activo: false });
  }

  // Validar formato: solo dígitos, 4-8 caracteres
  const pinStr = String(pin).trim();
  if (!/^\d{4,8}$/.test(pinStr)) {
    return res.status(400).json({ error: 'El PIN debe tener entre 4 y 8 dígitos numéricos' });
  }

  const pinHash = await bcrypt.hash(pinStr, 10);

  const { error } = await actualizarPinSupervisor(perfil.empresa_id, pinHash);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  await AuditRepo.registrarAuditoriaSilenciosa(
    perfil.empresa_id, perfil.id, 'empresas', 'UPDATE', perfil.empresa_id,
    null, { pin_supervisor_activo: true }
  );

  return res.json({ ok: true, activo: true });
}

// ══════════════════════════════════════════════════════════════════════════
// FASE 4 — PROMOCIONES, DEVOLUCIONES PARCIALES
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/pos/promociones ──────────────────────────────────────────────
// Devuelve todas las promociones de la empresa (activas e inactivas para admin).
async function getPromocionesHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos' });
  }

  const soloActivas = !puede(perfil, 'anular', 'pos');
  const { data, error } = await listarPromocionesAdmin(perfil.empresa_id, soloActivas);
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json(data || []);
}

// ── POST /api/pos/promociones ─────────────────────────────────────────────
// Body: { accion: 'crear'|'editar'|'eliminar', ...campos }
async function postPromocionesHandler(req, res, perfil) {
  if (!puede(perfil, 'anular', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede gestionar promociones' });
  }

  const { accion, id, nombre, tipo, n_cantidad, m_paga, descuento_pct, producto_id, categoria_id, activa, fecha_desde, fecha_hasta } = req.body || {};

  if (accion === 'crear' || accion === 'editar') {
    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!['nxm', 'descuento_categoria', 'descuento_producto'].includes(tipo)) {
      return res.status(400).json({ error: 'tipo debe ser nxm, descuento_categoria o descuento_producto' });
    }
    if (tipo === 'nxm') {
      if (!n_cantidad || !m_paga || n_cantidad <= m_paga) {
        return res.status(400).json({ error: 'Para nxm: n_cantidad debe ser mayor que m_paga' });
      }
    } else {
      if (!descuento_pct || descuento_pct <= 0 || descuento_pct > 100) {
        return res.status(400).json({ error: 'descuento_pct debe estar entre 1 y 100' });
      }
      if (tipo === 'descuento_producto' && !producto_id) {
        return res.status(400).json({ error: 'producto_id requerido para descuento_producto' });
      }
      if (tipo === 'descuento_categoria' && !categoria_id) {
        return res.status(400).json({ error: 'categoria_id requerido para descuento_categoria' });
      }
    }

    const campos = {
      empresa_id:    perfil.empresa_id,
      nombre:        nombre.trim(),
      tipo,
      n_cantidad:    tipo === 'nxm' ? parseInt(n_cantidad) : null,
      m_paga:        tipo === 'nxm' ? parseInt(m_paga)     : null,
      descuento_pct: tipo !== 'nxm' ? parseFloat(descuento_pct) : null,
      producto_id:   producto_id  || null,
      categoria_id:  categoria_id || null,
      activa:        activa !== false,
      fecha_desde:   fecha_desde  || null,
      fecha_hasta:   fecha_hasta  || null,
    };

    if (accion === 'crear') {
      const { data, error } = await crearPromocion(campos);
      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

      await AuditRepo.registrarAuditoriaSilenciosa(
        perfil.empresa_id, perfil.id, 'promociones', 'INSERT', data?.id, null, campos
      );

      return res.status(201).json(data);
    } else {
      if (!id) return res.status(400).json({ error: 'id requerido para editar' });
      const { data, error } = await actualizarPromocion(id, perfil.empresa_id, campos);
      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

      await AuditRepo.registrarAuditoriaSilenciosa(
        perfil.empresa_id, perfil.id, 'promociones', 'UPDATE', id, null, campos
      );

      return res.json(data);
    }
  }

  if (accion === 'eliminar') {
    if (!id) return res.status(400).json({ error: 'id requerido' });
    const { error } = await eliminarPromocion(id, perfil.empresa_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'promociones', 'DELETE', id, null, null
    );

    return res.json({ ok: true });
  }

  if (accion === 'toggle') {
    if (!id) return res.status(400).json({ error: 'id requerido' });
    const promo = await obtenerEstadoActivaPromocion(id, perfil.empresa_id);
    if (!promo) return res.status(404).json({ error: 'Promoción no encontrada' });
    const { error } = await togglePromocion(id, perfil.empresa_id, !promo.activa);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'promociones', 'UPDATE', id,
      { activa: promo.activa }, { activa: !promo.activa }
    );

    return res.json({ ok: true, activa: !promo.activa });
  }

  return res.status(400).json({ error: `Acción desconocida: ${accion}` });
}

// ── GET /api/pos/devoluciones?venta_id= ──────────────────────────────────
// Devuelve las devoluciones ya registradas de una venta.
async function getDevolucionesHandler(req, res, perfil) {
  if (!puede(perfil, 'anular', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede ver devoluciones' });
  }

  const { venta_id } = req.query;
  if (!venta_id) return res.status(400).json({ error: 'venta_id requerido' });

  const { data, error } = await listarDevolucionesDeVenta(venta_id, perfil.empresa_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json(data || []);
}

// ── POST /api/pos/devolucion ──────────────────────────────────────────────
// Body: { venta_pos_id, items: [{venta_pos_item_id, cantidad_devuelta}], motivo }
// Llama a rpc_registrar_devolucion_pos que: valida cantidades, repone stock, registra.
async function devolucionHandler(req, res, perfil) {
  if (!puede(perfil, 'anular', 'pos')) {
    return res.status(403).json({ error: 'Solo dueño/admin puede registrar devoluciones' });
  }

  const { venta_pos_id, items, motivo } = req.body || {};

  if (!venta_pos_id) return res.status(400).json({ error: 'venta_pos_id requerido' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items requerido (array)' });

  for (const it of items) {
    if (!it.venta_pos_item_id || !it.cantidad_devuelta || it.cantidad_devuelta <= 0) {
      return res.status(400).json({ error: 'Cada item necesita venta_pos_item_id y cantidad_devuelta > 0' });
    }
  }

  // Verificar que la venta pertenece a la empresa
  const venta = await obtenerVentaParaDevolucion(venta_pos_id, perfil.empresa_id);

  if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
  if (venta.estado === 'anulada') {
    return res.status(400).json({ error: 'No se puede devolver una venta anulada' });
  }

  const { data: devId, error } = await registrarDevolucionPosRpc({ venta_pos_id, items, motivo, usuario_id: perfil.id });

  if (error) {
    console.error('[POS] Error en rpc_registrar_devolucion_pos:', error);
    // Errores de negocio vienen en el mensaje de la excepción del RPC
    const msg = error.message?.includes('No se puede devolver') || error.message?.includes('no encontrado')
      ? error.message
      : 'Error al registrar la devolución. Intentá de nuevo.';
    return res.status(422).json({ error: msg });
  }

  // Punto 8 (auditoría 2026): devolución reversa dinero/stock de una venta
  // real — variante durable.
  await AuditRepo.registrarAuditoriaFinancieraDurable(
    perfil.empresa_id, perfil.id, 'devoluciones_pos', 'INSERT', devId, null,
    { venta_pos_id, motivo: motivo || null, items }
  );

  return res.status(201).json({ ok: true, devolucion_id: devId });
}

// ── GET /api/pos/stock-alerta?caja_id= ──────────────────────────────────
// indicada. Pensado para mostrar un aviso al abrir el turno.
// Sin caja_id → lista vacía (no bloqueante).
async function stockAlertaHandler(req, res, perfil) {
  if (!puede(perfil, 'vender', 'pos')) {
    return res.status(403).json({ error: 'Sin permisos' });
  }

  const { caja_id } = req.query;
  if (!caja_id) return res.json({ sin_stock: [], deposito: null });

  const caja = await obtenerCajaConDeposito(caja_id, perfil.empresa_id);

  if (!caja?.deposito_id) return res.json({ sin_stock: [], deposito: null });

  // Productos activos de la empresa con stock = 0 o sin fila en stock
  // en el depósito de esta caja.
  const todosActivos = await listarProductosActivosParaAlertaStock(perfil.empresa_id);

  if (!todosActivos?.length) return res.json({ sin_stock: [], deposito: caja.depositos?.nombre });

  const stockData = await obtenerStockPorProductos(caja.deposito_id, todosActivos.map(p => p.id));

  const stockMap = Object.fromEntries(stockData.map(s => [s.producto_id, s.cantidad]));

  const sinStock = todosActivos
    .filter(p => (stockMap[p.id] ?? 0) <= 0)
    .map(p => ({ id: p.id, nombre: p.nombre, codigo: p.codigo }));

  return res.json({ sin_stock: sinStock, deposito: caja.depositos?.nombre });
}
