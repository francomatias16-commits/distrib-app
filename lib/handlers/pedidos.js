// api/pedidos/index.js
// GET    /api/pedidos           → lista paginada (admin o cliente propio)
// GET    /api/pedidos?id=uuid   → detalle completo con items
// PATCH  /api/pedidos           → actualizar estado (admin)
// DELETE /api/pedidos?id=uuid   → cancelar pedido (admin)
// POST   /api/pedidos?accion=confirmar → confirmar pedido desde portal cliente
//        (antes: api/pedidos/confirmar-pedido.js, ver vercel.json rewrite)

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { applySecurityHeaders, applyCorsHeaders } from '../security-headers.js'; // SEC-11: reemplaza el wildcard local por la allowlist central
import { emitirFactura } from '../facturas.js';
import { emitirEvento, usaDespachadorEventos } from '../eventos.js';
import { enviarEmailConfirmacionPedido, enviarEmailDespacho } from '../email.js';
import { rateLimit } from '../rate-limit.js';
import { exigirLimitePlan, LimitePlanError } from '../plan-limits.js';
import { notificarPedidoEnCamino, notificarPuntosGanados, enviarPush } from './_push.js';
import { notifAuto } from './_auto-push.js';
import { errorSeguro } from '../error-response.js';
import { existeIntegracionMPActiva, esPedidoPilotoWhatsApp } from '../repos/pagos.js';
import { calcularTotalesPedido, calcularIvaPonderadoCombo } from '../calc/pedido-totales.js';
import { obtenerCombosParaValidarPedido } from '../repos/combos.js';
import {
  obtenerNombreProducto,
  obtenerProductosParaValidarPedido,
  obtenerProductosParaCotizarConCosto,
  buscarProductosParaRemito,
  obtenerProveedorDefaultPorProductos,
} from '../repos/productos.js';
import { puede, rolesDe } from '../permisos-service.js';
import {
  resolverPreciosClienteRpc,
  obtenerClienteParaPresupuesto,
  contarPresupuestosPorEmpresa,
  obtenerConfigEmpresa,
  crearPresupuesto,
  crearPresupuestoConItemsRpc,
  insertarItemsPresupuesto,
  obtenerPresupuestoConDetalle,
  listarPresupuestos,
  obtenerClientePorUsuarioId,
  obtenerPresupuestoParaPatch,
  bloquearPresupuestoAceptado,
  obtenerPresupuestoCompleto,
  obtenerClienteCredito,
  obtenerStockDepositoPrincipal,
  listarStockOtrosDepositos,
  crearPedidoDesdePresupuesto,
  insertarItemsPedidoDesdePresupuesto,
  incrementarStockReservadoRpc,
  liberarStockReservadoRpc,
  registrarMovimientoStockReserva,
  eliminarItemsPedido,
  eliminarPedido,
  revertirPresupuestoAEnviado,
  vincularPresupuestoConPedido,
  actualizarPresupuesto,
  obtenerPresupuestoParaEliminar,
  eliminarItemsPresupuesto,
  eliminarPresupuesto,
  obtenerPerfilParaRemitoNro,
  obtenerPedidoParaRemitoNro,
  reservarRemitoNroRpc,
  obtenerPerfilChofer,
  obtenerEntregaActivaDelPedido,
  obtenerRemitoDetalle,
  obtenerUltimaEntregaDelPedido,
  listarRutasDelDia,
  listarEntregasPorRutas,
  listarPedidosParaRemitos,
  obtenerPedidoParaDespacho,
  obtenerPedidoParaEntrega,
  buscarEntregaPorOfflineLocalId,
  buscarDevolucionPorOfflineLocalId,
  marcarPedidoDespachado,
  actualizarCantidadItemPedido,
  registrarCobroCompletoRpc,
  marcarPedidoEntregado,
  marcarEntregaCompletada,
  marcarEntregaNoRealizada,
  revertirPedidoAConfirmado,
  listarClientesConPedidosActivos,
  obtenerClienteIdDePedido,
  obtenerComprasPorProductoCliente,
  obtenerDevueltoPorProductoCliente,
  obtenerItemsDePedido,
  obtenerPreciosBaseProductos,
  crearDevolucion,
  insertarItemsDevolucion,
  crearNotaDebitoProveedor,
  calcularScoreClienteRpc,
  obtenerPerfilParaDevolucionesAdmin,
  actualizarNotasDevolucion,
  obtenerDevolucionParaEliminar,
  anularNotasDebitoDeDevolucion,
  eliminarDevolucion,
  obtenerDevolucionDetalle,
  listarNotasDebitoDeDevolucion,
  contarDevolucionesPorEstado,
  listarDevolucionesFiltradas,
  actualizarEstadoDevolucion,
  listarItemsDevolucionParaReponer,
  marcarItemDevolucionRepuesto,
  marcarItemDevolucionError,
  obtenerDepositoPorId,
  obtenerDepositoPrincipal,
  ajustarStockRpc,
  listarItemsDevolucionConProducto,
  obtenerClienteCondicionIva,
  obtenerFacturaRecienteDePedido,
  crearNotaCreditoRpc,
  obtenerPerfilPresupuestos,
  obtenerEstadoRuta,
  listarEstadosEntregasDeRuta,
  actualizarEstadoRuta,
  obtenerClienteTelefonoRazonSocial,
  obtenerClienteParaEmailDespacho,
  obtenerEmpresaContacto,
  insertarNotifLog,
  obtenerPedidoNumeroYTotal,
  obtenerPedidoCompletoParaEmailConfirmacion,
  obtenerClienteEmailRazonSocial,
  obtenerProgramaFidelizacionActivo,
  obtenerPedidoTotal,
  obtenerClienteScoreCategoria,
  registrarMovimientoPuntosRpc,
  insertarMovimientoPuntosFallback,
  sumarSaldoPuntosFallbackRpc,
  obtenerPerfilParaPedidos,
  obtenerPedidoDetalleConItems,
  listarDevolucionesDePedido,
  obtenerEstadoDevolucionPorPedidos,
  resolverClienteIdPorEmail,
  listarPedidosFiltrados,
  actualizarEstadoPedido,
  obtenerPedidoIdEstado,
  obtenerDepositoRealReserva,
  listarFacturasDePedido,
  eliminarFacturasDePedido,
  eliminarEntregasDePedido,
  eliminarPedidoPorId,
  listarItemsPedidoParaCancelar,
  listarStockParaLiberarReserva,
  marcarPedidoCancelado,
  revertirPuntosPedidoCanceladoRpc,
  listarFacturasVinculadasParaCancelar,
  anularFacturaPendiente,
  obtenerPedidoSugeridoDetalle,
  obtenerPedidoParaConfirmarSugerido,
  confirmarPedidoSugeridoRpc,
  obtenerClienteParaPedido,
  listarStockParaValidarPedido,
  crearPedidoClienteRpc,
  obtenerPerfilParaCrearPedidoAdmin,
  obtenerUsuarioParaConfirmarPedido,
  obtenerClientePorIdParaConfirmar,
  obtenerClientePorEmailParaConfirmar,
  vaciarCarritoCliente,
  obtenerNumeroPedido,
} from '../repos/pedidos.js';
import * as AuditRepo from '../repos/audit.js';
import { firmarCampoUrl, firmarCampoUrlEnLista } from '../utils/storage-urls.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

// Reexportado tal cual (mismo nombre, mismo valor) porque asistente-tools.js
// lo reimporta como ROLES_PEDIDO — ver nota en lib/permisos-service.js.
// La tabla en permisos-service.js es la única fuente de verdad; acá solo
// se reexpone. Los 3 gates internos de este archivo usan puede() directo.
export const ROLES_ADMIN = rolesDe('pedidos', 'acceder');
const ESTADOS_VALIDOS = ['borrador', 'confirmado', 'preparando', 'despachado', 'entregado', 'cancelado'];

// ── Sincroniza rutas.estado con el estado real de sus entregas ────────────
// FIX (jul 2026, reporte Matías): rutas.estado solo se escribía desde el
// webhook interno evento=despacho (endpoint externo, alcanzable solo por
// n8n/Zapier con INTERNAL_API_KEY) — nunca desde el flujo normal en el que
// el chofer marca entregas desde su portal. Resultado: la ruta quedaba
// 'pendiente' para siempre aunque todas las entregas ya estuvieran
// entregadas/no_entregadas, y "Rutas del día", "Historial" y "Choferes en
// la calle" (que leen rutas.estado) mostraban datos contradictorios con
// "Seguimiento de entrega" (que calcula en vivo desde la tabla `entregas`).
// Se llama después de cada PATCH entregar/no-entregar sobre una entrega.
async function sincronizarEstadoRuta(ruta_id) {
  if (!ruta_id) return;

  const ruta = await obtenerEstadoRuta(ruta_id);

  // Nunca pisar una ruta cancelada o ya completada.
  if (!ruta || ruta.estado === 'cancelada' || ruta.estado === 'completada') return;

  const entregas = await listarEstadosEntregasDeRuta(ruta_id);

  if (!entregas || entregas.length === 0) return;

  const TERMINALES = ['entregado', 'no_entregado'];
  const todasTerminadas = entregas.every(e => TERMINALES.includes(e.estado));
  const algunaIniciada  = entregas.some(e => TERMINALES.includes(e.estado) || e.estado === 'en_camino');

  let nuevoEstado = null;
  if (todasTerminadas) {
    nuevoEstado = 'completada';
  } else if (algunaIniciada && ruta.estado === 'pendiente') {
    nuevoEstado = 'en_camino';
  }

  if (nuevoEstado && nuevoEstado !== ruta.estado) {
    await actualizarEstadoRuta(ruta_id, nuevoEstado);
  }
}

// DT-04: Rate limiting diferenciado
// confirmar pedido → más restrictivo (20 req/min) por el impacto en stock y facturación
const limiterConfirmar = rateLimit({ max: 20, windowMs: 60_000 });
// operaciones admin → 60 req/min (estándar)
const limiterAdmin = rateLimit({ max: 60, windowMs: 60_000 });

function validarImagenReal(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

export default async function handler(req, res) {
  // ── Sub-router: presupuestos / remito-nro (absortos para reducir Serverless Functions) ─
    const _svc = req.query._svc;
    if (_svc === 'presupuestos') return handlePresupuestos(req, res);
    if (_svc === 'remito-nro')   return handleRemitoNro(req, res);
    if (_svc === 'chofer')       return handleChofer(req, res);
    if (_svc === 'devoluciones') return handleDevolucionesAdmin(req, res);

    // ── Ruta pública de cliente: confirmar pedido ─────────────────────
  // DT-04: rate limit aplicado ANTES de autenticar para mitigar abusos
  if (req.method === 'POST' && req.query.accion === 'confirmar') {
    if (await limiterConfirmar(req, res)) return;
    return confirmarPedidoHandler(req, res);
  }

  // ── Ruta pública de cliente: ver preview de un pedido sugerido (link de
  // WhatsApp, sin login, antes de confirmar) ──────────────────────────────
  // PORTALCLIENTE-001 (auditoría 2026-07-26): `frontend/cliente/checkout.html`
  // consultaba `pedidos` directo con el cliente Supabase anon (sin sesión,
  // sin signInAnonymously). La política RLS `pedidos_select_unificada` exige
  // auth.uid() para cualquiera de sus ramas, así que un caller anon nunca
  // matcheaba ninguna — la consulta devolvía 0 filas SIEMPRE (verificado con
  // SET ROLE anon en Supabase: 0 filas visibles en toda la tabla). Resultado:
  // el link de "pedido sugerido" mandado por WhatsApp (generado en
  // lib/handlers/piloto.js) mostraba "Pedido no encontrado" para el 100% de
  // los clientes, sin importar si el pedido existía — la función de
  // confirmación en sí (accion=confirmar-sugerido, más abajo) funcionaba
  // bien porque corre server-side con service_role, pero nunca se llegaba a
  // mostrar el botón porque la carga previa fallaba. Se agrega este endpoint
  // público (rate-limited, solo lectura, resuelve todo server-side con
  // service_role) para que el preview funcione sin depender de RLS/anon.
  if (req.method === 'GET' && req.query.accion === 'ver-sugerido') {
    if (await limiterConfirmar(req, res)) return;
    return verPedidoSugeridoHandler(req, res);
  }

  // ── Ruta pública de cliente: confirmar pedido sugerido (link de WhatsApp, sin login) ─
  // confirmar_pedido_sugerido() solo tiene EXECUTE para service_role (no
  // valida internamente que empresa_id/cliente_id recibidos correspondan al
  // caller — confía en los parámetros), así que nunca debe llamarse con
  // valores provistos por el cliente. Acá los resolvemos server-side a
  // partir del pedido_id antes de invocar la RPC.
  if (req.method === 'POST' && req.query.accion === 'confirmar-sugerido') {
    if (await limiterConfirmar(req, res)) return;
    return confirmarPedidoSugeridoHandler(req, res);
  }

  // ── Ruta admin: crear pedido manualmente desde /admin/pedidos ─────
  // Fix: el modal "Nuevo pedido" del admin pegaba a POST /api/pedidos sin
  // ningún `accion`, lo cual no matcheaba ninguna rama del handler y
  // devolvía 405. Y aunque hubiera usado accion=confirmar, esa función
  // es exclusiva para clientes (usuarioData.rol === 'cliente'), así que
  // nunca iba a servir para que un admin/vendedor cargue un pedido a
  // mano. Esta rama reutiliza la misma validación de stock/precio de
  // servidor/crédito y la misma RPC transaccional (crear_pedido_cliente),
  // pero resolviendo el cliente por `cliente_id` del body en vez de por
  // la sesión logueada.
  if (req.method === 'POST' && req.query.accion === 'crear-admin') {
    if (await limiterAdmin(req, res)) return;
    return crearPedidoAdminHandler(req, res);
  }

  // DT-04: rate limit para rutas admin
  if (await limiterAdmin(req, res)) return;

  // ── Auth (rutas admin / operativas) ──────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilParaPedidos(user.id);

  if (!perfil) return res.status(403).json({ error: 'Usuario no encontrado' });

  const empresa_id = perfil.empresa_id;
  const esAdmin    = puede(perfil, 'acceder', 'pedidos');

  // ── GET ───────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { id, estado, cliente_id, vendedor_id, zona_id,
            fecha_desde, fecha_hasta, sin_facturar, sin_despachar,
            page = '1', limit = '50' } = req.query;

    if (id) {
      const { data, error } = await obtenerPedidoDetalleConItems(empresa_id, id);

      if (error) return res.status(404).json({ error: 'Pedido no encontrado' });

      if (!esAdmin) {
        // Resolver el cliente_id del usuario: por cliente_id directo (portal) o por email (legacy)
        let cliId = perfil.cliente_id;
        if (!cliId) {
          const cli = await resolverClienteIdPorEmail(empresa_id, user.email);
          cliId = cli?.id;
        }
        if (!cliId || data.cliente_id !== cliId)
          return res.status(403).json({ error: 'Acceso denegado' });
      }

      // v808: devoluciones vinculadas a este pedido, para mostrar el
      // indicador "Con devolución" en el modal de detalle.
      data.devoluciones = await listarDevolucionesDePedido(empresa_id, id);

      return res.json(data);
    }

    let cliId = null;
    if (!esAdmin) {
      cliId = perfil.cliente_id;
      if (!cliId) {
        const cli = await resolverClienteIdPorEmail(empresa_id, user.email);
        cliId = cli?.id;
      }
    }

    const { data, error, count } = await listarPedidosFiltrados({
      empresa_id, esAdmin, cliId,
      estado, cliente_id, vendedor_id, zona_id, fecha_desde, fecha_hasta,
      sin_facturar, sin_despachar, page, limit,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // v808: indicador "Con devolución" en la tabla — antes un pedido con
    // devolución aprobada/pendiente/rechazada se veía exactamente igual
    // que cualquier otro, sin ninguna señal visible desde /admin/pedidos.
    // Un solo round-trip extra para toda la página, no N+1.
    const devolucionPorPedido = await obtenerEstadoDevolucionPorPedidos(empresa_id, (data || []).map(p => p.id));
    for (const p of (data || [])) {
      p.devolucion_estado = devolucionPorPedido.get(p.id) || null;
    }

    return res.json({ data, total: count, page: +page, limit: +limit });
  }

  // ── PATCH: actualizar estado ──────────────────────────────────────
  if (req.method === 'PATCH') {
    if (!['dueno', 'admin'].includes(perfil.rol)) return res.status(403).json({ error: 'Solo dueño/admin puede forzar estados' });

    const { id, estado, notas_internas, motivo } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });
    if (estado && !ESTADOS_VALIDOS.includes(estado))
      return res.status(400).json({ error: `Estado inválido: ${estado}` });
    if (estado && !motivo?.trim()) {
      return res.status(400).json({ error: 'motivo es obligatorio para un cambio administrativo de estado' });
    }

    const { data: pedidoAntes, error: pedidoAntesError } = await obtenerPedidoIdEstado(empresa_id, id);
    if (pedidoAntesError) return errorSeguro(res, pedidoAntesError, 500, 'No se pudo leer el pedido.');
    if (!pedidoAntes) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Los estados con efectos sensibles no pasan por un UPDATE genérico.
    // Cancelación debe usar DELETE, que libera stock, revierte puntos y
    // procesa facturas/NC; permitirla aquí volvería a crear PED-021.
    if (estado === 'cancelado') {
      return res.status(409).json({
        error: 'La cancelación administrativa debe ejecutarse por el flujo de cancelación para liberar stock y procesar facturas.',
        codigo: 'usar_flujo_cancelacion',
      });
    }

    let data;
    let error;
    if (estado === 'despachado') {
      ({ error } = await marcarPedidoDespachado(id, { notas_chofer: `${motivo.trim()} — ${notas_internas || ''}`.trim() }));
      data = { ...pedidoAntes, estado: 'despachado' };
    } else if (estado === 'entregado') {
      ({ error } = await marcarPedidoEntregado(id, { notas_entrega: `${motivo.trim()} — ${notas_internas || ''}`.trim() }));
      data = { ...pedidoAntes, estado: 'entregado' };
    } else {
      const updates = {};
      if (estado) updates.estado = estado;
      if (notas_internas !== undefined) updates.notas_internas = notas_internas;
      ({ data, error } = await actualizarEstadoPedido(empresa_id, id, updates));
    }

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      empresa_id,
      perfil.id,
      'pedidos',
      'UPDATE_ADMIN_OVERRIDE',
      id,
      pedidoAntes,
      { ...(data || {}), estado, motivo: motivo?.trim() || null },
    );

    if (estado === 'despachado') {
      notificarEstado(data, empresa_id).catch(console.error);
      notificarDespachoPorEmail(data, empresa_id).catch(console.error);
      if (data.cliente_id) notificarPedidoEnCamino(data.id, data.cliente_id).catch(console.error);
    }

    return res.json({ ok: true, pedido: data, motivo: motivo.trim() });
  }

  // ── DELETE: eliminar (borrado físico) ────────────────────────────
  // Distinto de "cancelar" (más abajo): esto borra la fila de verdad.
  // Solo se permite para pedidos que todavía no dejaron rastro real
  // (sin stock reservado, sin factura, sin entrega) — para pedidos en
  // curso, primero hay que cancelarlos, lo que sí revierte todo eso.
  //
  // FIX (reporte Matías, jul 2026): al cancelar un pedido, la rama de
  // cancelación (más abajo) NO borra la factura vinculada — la deja en
  // 'anulada' (o ya estaba en 'pendiente' sin CAE si nunca se llegó a
  // emitir). Esa fila sigue existiendo con pedido_id apuntando al
  // pedido, y como facturas.pedido_id es RESTRICT (no CASCADE), el
  // DELETE de pedidos fallaba con 23503 aunque el usuario nunca haya
  // emitido nada realmente ante AFIP. Ahora se distingue: una factura
  // 'emitida' (con CAE real) sí bloquea el borrado — tiene validez
  // fiscal y hay que anularla con Nota de Crédito primero. Una factura
  // 'pendiente'/'anulada'/'error_afip' (sin CAE, sin efecto fiscal real)
  // se borra junto con el pedido. Mismo criterio para 'entregas': si el
  // pedido nunca llegó a entregarse de verdad (por eso está en un
  // estado eliminable), sus filas de entrega son solo tracking
  // logístico sin firma/entrega real, y se borran junto con él.
  if (req.method === 'DELETE' && req.query.accion === 'eliminar') {
    if (!['dueno', 'admin'].includes(perfil.rol))
      return res.status(403).json({ error: 'Solo admin puede eliminar pedidos' });

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    const { data: pedidoActual, error: pedidoErr } = await obtenerPedidoIdEstado(empresa_id, id);

    if (pedidoErr) return errorSeguro(res, pedidoErr, 500, 'No se pudo completar la operación.');
    if (!pedidoActual) return res.status(404).json({ error: 'Pedido no encontrado' });

    const ESTADOS_ELIMINABLES = ['borrador', 'pendiente', 'cancelado'];
    if (!ESTADOS_ELIMINABLES.includes(pedidoActual.estado)) {
      return res.status(400).json({
        error: `No se puede eliminar un pedido "${pedidoActual.estado}". Cancelalo primero y despues eliminalo.`,
      });
    }

    // Facturas vinculadas: si alguna tiene CAE real (estado 'emitida'),
    // no se toca nada y se rechaza el borrado del pedido.
    const facturasVinc = await listarFacturasDePedido(id);

    const tieneFacturaEmitida = (facturasVinc || []).some(f => f.estado === 'emitida');
    if (tieneFacturaEmitida) {
      return res.status(409).json({
        error: 'Este pedido tiene una factura emitida con CAE (AFIP/ARCA) y no se puede eliminar. Anulala con una Nota de Crédito primero.',
      });
    }

    // Sin factura con CAE: borramos las facturas huérfanas (pendiente/
    // anulada/error_afip) y las entregas de tracking antes del pedido,
    // para que el DELETE de pedidos no choque contra la FK.
    if ((facturasVinc || []).length) {
      await eliminarFacturasDePedido(id);
    }
    await eliminarEntregasDePedido(id);

    const { error: delErr } = await eliminarPedidoPorId(empresa_id, id);

    if (delErr) {
      if (delErr.code === '23503') {
        return res.status(409).json({
          error: 'Este pedido tiene datos asociados que no se pueden borrar automáticamente. Contactá a soporte.',
        });
      }
      return errorSeguro(res, delErr, 500, 'No se pudo eliminar el pedido.');
    }

    await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, perfil.id, 'pedidos', 'DELETE', id, pedidoActual, null);

    return res.json({ ok: true });
  }

  // ── DELETE: cancelar ─────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!['dueno', 'admin'].includes(perfil.rol))
      return res.status(403).json({ error: 'Solo admin puede cancelar pedidos' });

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    const { data: pedidoActual, error: pedidoErr } = await obtenerPedidoIdEstado(empresa_id, id);

    if (pedidoErr) return errorSeguro(res, pedidoErr, 500, 'No se pudo completar la operación.');
    if (!pedidoActual) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (['entregado', 'cancelado'].includes(pedidoActual.estado))
      return res.status(400).json({ error: `No se puede cancelar un pedido ${pedidoActual.estado}` });

    // Etapa 4: antes este bloque liberaba stock manualmente llamando a
    // liberar_stock_reservado con p_deposito_id: null, lo cual nunca
    // actualizaba ninguna fila (deposito_id = NULL no matchea en SQL,
    // sin importar el valor real de la columna) — el stock reservado
    // quedaba huérfano en cada cancelación por esta vía.
    //
    // No se reemplaza por la RPC cancelar_pedido(p_pedido_id) porque esa
    // función filtra internamente por get_empresa_id(), que lee auth.uid()
    // — y este handler corre con SUPABASE_SERVICE_ROLE_KEY, sin sesión de
    // usuario, por lo que auth.uid() sería NULL y la RPC siempre
    // devolvería "Pedido no encontrado". Se replica la misma lógica
    // (buscar depósito principal, o el de mayor stock disponible como
    // fallback) directamente acá, igual que hace la función SQL.
    const fallos = [];
    const pasosAplicados = [];

    if (['confirmado', 'preparando'].includes(pedidoActual.estado)) {
      const items = await listarItemsPedidoParaCancelar(id);

      for (const item of (items || [])) {
        const depositoReal = await obtenerDepositoRealReserva(empresa_id, id, item.producto_id);
        let depositoId = depositoReal;

        if (!depositoId) {
          const stockRows = await listarStockParaLiberarReserva(empresa_id, item.producto_id);
          const principal = stockRows?.find(s => s.depositos?.es_principal);
          depositoId = (principal || stockRows?.[0])?.deposito_id || null;
        }

        if (!depositoId) {
          fallos.push({ paso: 'liberar_stock', producto_id: item.producto_id, error: 'No se encontró depósito de reserva.' });
          continue;
        }

        const { error: liberarError } = await liberarStockReservadoRpc({
          producto_id: item.producto_id,
          deposito_id: depositoId,
          cantidad:    item.cantidad,
        });
        if (liberarError) {
          fallos.push({ paso: 'liberar_stock', producto_id: item.producto_id, deposito_id: depositoId, error: liberarError.message });
        } else {
          pasosAplicados.push(`stock:${item.producto_id}:${depositoId}`);
        }
      }
    }

    // Si no se pudo liberar todo el stock, no se marca el pedido como cancelado:
    // puede quedar una liberación parcial, que queda explícita para revisión.
    if (fallos.length) {
      return res.status(207).json({
        ok: false,
        parcial: true,
        pedido_cancelado: false,
        pasos_aplicados: pasosAplicados,
        fallos,
        error: 'No se pudo completar la liberación de stock; el pedido no fue cancelado.',
      });
    }

    const { error: pedidoCancelError } = await marcarPedidoCancelado(empresa_id, id, 'Pedido cancelado');
    if (pedidoCancelError) {
      return errorSeguro(res, pedidoCancelError, 500, 'No se pudo cancelar el pedido después de liberar el stock.');
    }
    pasosAplicados.push('pedido:cancelado');

    await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, perfil.id, 'pedidos', 'UPDATE', id, pedidoActual, { estado: 'cancelado' });

    const { error: puntosError } = await revertirPuntosPedidoCanceladoRpc({
      p_pedido_id:  id,
      p_empresa_id: empresa_id,
    });
    if (puntosError) {
      fallos.push({ paso: 'revertir_puntos', error: puntosError.message });
    } else {
      pasosAplicados.push('puntos:revertidos');
    }

    // Las facturas pendientes se anulan localmente; las emitidas requieren NC
    // real. Todo error se informa como pendiente, nunca como éxito limpio.
    const facturasVinculadas = await listarFacturasVinculadasParaCancelar(id);
    for (const f of facturasVinculadas || []) {
      if (f.estado === 'pendiente') {
        const { error: anularPendienteError } = await anularFacturaPendiente(f.id);
        if (anularPendienteError) {
          fallos.push({ paso: 'anular_factura_pendiente', factura_id: f.id, error: anularPendienteError.message });
        } else {
          pasosAplicados.push(`factura:${f.id}:anulada`);
        }
      } else {
        try {
          const { anularFactura } = await import('../facturas.js');
          const resultado = await anularFactura(f, 'Pedido cancelado', user.id);
          if (!resultado.ok) {
            fallos.push({ paso: 'emitir_nota_credito', factura_id: f.id, error: resultado.error });
          } else {
            pasosAplicados.push(`factura:${f.id}:nota_credito`);
          }
        } catch (errAnular) {
          fallos.push({ paso: 'emitir_nota_credito', factura_id: f.id, error: errAnular.message });
        }
      }
    }

    if (fallos.length) {
      return res.status(207).json({
        ok: false,
        parcial: true,
        pedido_cancelado: true,
        pasos_aplicados: pasosAplicados,
        fallos,
        error: 'El pedido fue cancelado, pero quedaron pasos financieros pendientes de conciliación.',
      });
    }

    return res.json({ ok: true, pasos_aplicados: pasosAplicados });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

async function notificarEstado(pedido, empresaId) {
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.APP_URL || 'http://localhost:3000';

  const cliente = await obtenerClienteTelefonoRazonSocial(pedido.cliente_id);

  if (!cliente?.telefono) return;

  await fetch(`${base}/api/notif/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'pedido_despachado',
      telefono: cliente.telefono,
      params: {
        numero_pedido: pedido.id.substring(0, 8).toUpperCase(),
        total:         pedido.total,
      },
    }),
  });
}

// FIX (Hallazgo 2, auditoría notificaciones — "reenvío manual de emails"):
// antes esta función llamaba a enviarEmailDespacho() y descartaba el
// resultado por completo (ni el `await` capturaba nada) — no había ningún
// rastro en notif_log ni de éxito ni de falla, a diferencia de
// notificarPedidoConfirmado()/_logNotif de más arriba. Un aviso de
// despacho que fallaba (ej: proveedor de email caído) desaparecía sin
// dejar huella, y no había nada que un futuro botón de "reintentar"
// pudiera reintentar.
async function notificarDespachoPorEmail(pedido, empresaId) {
  const cliente = await obtenerClienteParaEmailDespacho(pedido.cliente_id);

  const payloadBase = {
    numero_pedido: pedido.id?.substring(0, 8).toUpperCase(),
    total: pedido.total,
  };

  if (!cliente?.email) {
    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente?.id || pedido.cliente_id, pedidoId: pedido.id,
      canal: 'email', payload: payloadBase,
      entregada: false, motivo: 'sin_email',
    });
    return;
  }

  const empresa = await obtenerEmpresaContacto(empresaId);

  try {
    const resultado = await enviarEmailDespacho(pedido, cliente, empresa);
    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente.id, pedidoId: pedido.id,
      canal: 'email', email: cliente.email,
      messageId: resultado?.id || null,
      payload: payloadBase,
      entregada: !!resultado?.ok,
      motivo: resultado?.ok ? null : (resultado?.razon || 'error_desconocido'),
    });
    if (!resultado?.ok) {
      console.error(`[EMAIL] Aviso de despacho no entregado para pedido ${pedido.id} — motivo: ${resultado?.razon}`);
    }
  } catch (err) {
    console.error(`[EMAIL] Error enviando aviso de despacho del pedido ${pedido.id}:`, err.message);
    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente.id, pedidoId: pedido.id,
      canal: 'email', email: cliente.email,
      payload: { ...payloadBase, error: err.message },
      entregada: false, motivo: 'error_inesperado',
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// ── Confirmar pedido sugerido (link público de WhatsApp, sin login) ─────
// ═════════════════════════════════════════════════════════════════════════
async function verPedidoSugeridoHandler(req, res) {
  const pedido_id = req.query?.pedido_id;
  if (!pedido_id) return res.status(400).json({ ok: false, error: 'Falta pedido_id' });

  const { data: p, error } = await obtenerPedidoSugeridoDetalle(pedido_id);

  if (error || !p) return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });

  // Solo estos dos estados son válidos para este link: 'sugerido' (todavía
  // no confirmado, mostrar preview) o 'pendiente' (ya confirmado antes,
  // mostrar el estado de éxito). Cualquier otro estado (cancelado, etc.) se
  // trata igual que "no encontrado" — mismo criterio que ya usaba el front.
  if (p.estado !== 'sugerido' && p.estado !== 'pendiente') {
    return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
  }

  // Etapa 5 offline (Mercado Pago) — el checkout público solo puede ofrecer
  // "Pagar ahora" si (a) la empresa tiene MP configurado y (b) este pedido
  // califica para el link público de pago (mismo guard que aplica el
  // backend en crearPreferenciaPublicaHandler, lib/handlers/pagos.js —
  // acá solo se refleja para decidir si mostrar el botón, la validación
  // real vuelve a correr del lado del servidor al pagar).
  const mp_disponible = esPedidoPilotoWhatsApp(p)
    ? await existeIntegracionMPActiva(p.empresa_id)
    : false;

  // empresa_id/generado_automatico son detalles internos para decidir
  // mp_disponible — no hace falta exponerlos en la respuesta pública.
  const { empresa_id: _empresaId, generado_automatico: _generadoAuto, ...pedidoPublico } = p;

  return res.json({ ok: true, pedido: pedidoPublico, mp_disponible });
}

async function confirmarPedidoSugeridoHandler(req, res) {
  const pedido_id = req.body?.pedido_id;
  if (!pedido_id) return res.status(400).json({ error: 'Falta pedido_id' });

  // Resolver empresa_id / cliente_id desde el propio pedido (service_role),
  // nunca confiar en valores enviados por el cliente.
  const { data: pedido, error: pedError } = await obtenerPedidoParaConfirmarSugerido(pedido_id);

  if (pedError || !pedido) {
    return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
  }
  if (pedido.estado !== 'sugerido') {
    return res.status(409).json({ ok: false, error: 'Pedido no encontrado o ya procesado' });
  }

  const { data, error } = await confirmarPedidoSugeridoRpc({
    p_pedido_id:  pedido.id,
    p_empresa_id: pedido.empresa_id,
    p_cliente_id: pedido.cliente_id,
  });

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.', { ok: false });

  // Auditoría: usuario_id = null — es el cliente real confirmando por un
  // link de WhatsApp sin login, no hay un usuarios.id interno para
  // identificarlo (a diferencia de confirmarPedidoHandler, portal con
  // sesión). Mismo criterio que un disparo de sistema: no hay con qué
  // completar el campo, no que "no importa quién fue".
  await AuditRepo.registrarAuditoriaSilenciosa(
    pedido.empresa_id, null, 'pedidos', 'UPDATE', pedido.id, { estado: 'sugerido' }, data
  );

  return res.json(data);
}

// ═════════════════════════════════════════════════════════════════════════
// ── Crear pedido desde el admin (modal "Nuevo pedido" en /admin/pedidos) ──
// Réplica de la validación de stock/precio-de-servidor/crédito y de la RPC
// transaccional que usa confirmarPedidoHandler, pero para un admin/vendedor
// que elige el cliente a mano en vez de resolverlo desde su propia sesión.
// ═════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════
// ── Lógica de negocio compartida: crear un pedido para un cliente ya
// identificado (por id), con items ya identificados (por producto_id).
// Extraída de lo que antes era el cuerpo entero de crearPedidoAdminHandler
// para poder reusarla desde dos call sites con necesidades distintas:
//   1. crearPedidoAdminHandler (HTTP, abajo) — cliente_id/producto_id ya
//      vienen resueltos por los <select> del modal del panel admin.
//   2. la tool `crear_pedido` del asistente de ayuda
//      (lib/asistente-tools.js) — ahí el cliente y los productos llegan
//      como texto libre del usuario y se resuelven ANTES de llamar acá
//      (misma filosofía que el resto de las tools: nunca se le confía al
//      modelo un id, se lo resuelve el propio código contra la base).
//
// `preview:true` corre exactamente la misma validación y el mismo cálculo
// de totales que `preview:false`, pero nunca llama a la RPC transaccional
// ni dispara los efectos secundarios (factura, puntos, notificación) — así
// el asistente arma un resumen 100% real (mismos precios/stock/crédito que
// se usarían al confirmar) sin haber creado nada todavía. Ver
// `resumen()`/`execute()` de `crear_pedido` en asistente-tools.js, mismo
// patrón que ya usa `anular_venta_pos`.
//
// Devuelve siempre `{ ok, ... }`; en `ok:false` incluye `status` (código
// HTTP que usaba el handler original antes de este refactor) para que el
// wrapper HTTP pueda responder exactamente igual que antes.
// ═════════════════════════════════════════════════════════════════════════
export async function crearPedidoParaCliente({ empresaId, vendedorId, clienteId, items, notas, fechaEntrega, idempotencyKey = null, preview = false }) {
  if (!clienteId) return { ok: false, status: 400, error: 'cliente_id requerido' };
  if (!Array.isArray(items) || !items.length)
    return { ok: false, status: 400, error: 'Agregá al menos un producto' };

  // v(combos): mismo criterio que confirmarPedidoHandler — cada renglón es
  // DE UN PRODUCTO o DE UN COMBO (ítem único, precio propio), nunca ambos
  // ni ninguno (constraint pedido_items_producto_o_combo, migración 530).
  for (const item of items) {
    const esCombo = !!item.combo_id;
    if (esCombo === !!item.producto_id) {
      return { ok: false, status: 400, error: 'Item inválido' };
    }
    if (!item.cantidad || item.cantidad <= 0)
      return { ok: false, status: 400, error: 'Item inválido' };
  }

  // Cliente debe pertenecer a la empresa
  const { data: clienteRow, error: cliError } = await obtenerClienteParaPedido(empresaId, clienteId);

  if (cliError || !clienteRow) return { ok: false, status: 404, error: 'Cliente no encontrado' };
  if (!clienteRow.activo) return { ok: false, status: 400, error: 'El cliente está inactivo' };

  const productoIdsDirectos = items.filter(i => i.producto_id).map(i => i.producto_id);
  const comboIds            = [...new Set(items.filter(i => i.combo_id).map(i => i.combo_id))];

  // Combos: cabecera (precio propio, SERVIDOR) + composición, para poder
  // descontar stock por componente — mismo criterio que confirmarPedidoHandler.
  const combosData = comboIds.length ? await obtenerCombosParaValidarPedido(empresaId, comboIds) : [];
  const comboMap = new Map(combosData.map(c => [c.id, c]));

  for (const comboId of comboIds) {
    const combo = comboMap.get(comboId);
    if (!combo || !combo.activo) {
      return { ok: false, status: 400, error: `Combo no disponible: ${comboId}`, combo_id: comboId };
    }
  }

  // ── Mismo chequeo de stock que confirmarPedidoHandler (directo + lo que
  // consume cada combo, acumulado por producto antes de comparar) ──
  const necesidadPorProducto = new Map();
  for (const item of items) {
    if (item.producto_id) {
      necesidadPorProducto.set(item.producto_id, (necesidadPorProducto.get(item.producto_id) || 0) + item.cantidad);
    } else {
      const combo = comboMap.get(item.combo_id);
      for (const ci of combo.items) {
        necesidadPorProducto.set(ci.producto_id, (necesidadPorProducto.get(ci.producto_id) || 0) + ci.cantidad * item.cantidad);
      }
    }
  }
  const productoIdsParaStock = [...necesidadPorProducto.keys()];

  const stockData = await listarStockParaValidarPedido(productoIdsParaStock);

  const stockMap = {};
  for (const s of (stockData || [])) {
    if (s.depositos?.es_principal || !stockMap[s.producto_id]) {
      stockMap[s.producto_id] = { disponible: Math.max(0, s.cantidad - s.cantidad_reservada) };
    }
  }
  for (const [productoId, necesaria] of necesidadPorProducto) {
    const disponible = stockMap[productoId]?.disponible ?? 0;
    if (necesaria > disponible) {
      const nombreProd = await obtenerNombreProducto(productoId);
      return {
        ok: false,
        status: 400,
        error: `Stock insuficiente para "${nombreProd || productoId}". Disponible: ${disponible}`,
        producto_id: productoId,
        disponible,
      };
    }
  }

  // ── Precios resueltos en servidor (misma RPC que usa el portal y el POS) ──
  // Nunca se confía en un precio_unitario que venga del frontend o del modelo.
  // Solo aplica a los renglones directos — los combos tienen precio propio
  // fijo (combo.precio), no pasan por reglas de precio de cliente/lista.
  const { data: preciosResueltos, error: errPrecios } = productoIdsDirectos.length
    ? await resolverPreciosClienteRpc({
        cliente_id:   clienteRow.id,
        producto_ids: productoIdsDirectos,
        empresa_id:   empresaId,
      })
    : { data: [], error: null };
  if (errPrecios) {
    console.error('[PEDIDO] error resolviendo precios:', errPrecios);
    return { ok: false, status: 500, error: 'No se pudieron resolver los precios' };
  }
  const precioMap = Object.fromEntries((preciosResueltos || []).map(p => [p.producto_id, p.precio]));

  const prodsData = productoIdsDirectos.length
    ? await obtenerProductosParaValidarPedido(empresaId, productoIdsDirectos)
    : [];

  if (!prodsData || prodsData.length !== productoIdsDirectos.length) {
    return { ok: false, status: 400, error: 'Uno o más productos no pertenecen a esta empresa' };
  }
  const nombreMap = Object.fromEntries(prodsData.map(p => [p.id, p.nombre]));
  const prodMap   = Object.fromEntries(prodsData.map(p => [p.id, p]));

  // Validar/cachear precio+IVA del servidor por renglón — mismo criterio
  // (y misma fórmula de IVA ponderado del combo) que confirmarPedidoHandler.
  for (const item of items) {
    if (item.producto_id) {
      item._precio_servidor = precioMap[item.producto_id] ?? prodMap[item.producto_id]?.precio_base ?? 0;
      item._iva_servidor    = prodMap[item.producto_id]?.iva ?? 21;
    } else {
      const combo = comboMap.get(item.combo_id);
      item._precio_servidor = combo.precio;
      item._iva_servidor    = calcularIvaPonderadoCombo(combo.items);
    }
  }

  const { subtotal, iva_total, total, itemsParaRpc } = calcularTotalesPedido(items, {
    resolverPrecio: item => item._precio_servidor,
    resolverIva:    item => item._iva_servidor,
  });

  // Límite de crédito — mismo criterio que confirmarPedidoHandler
  if (clienteRow.limite_credito > 0) {
    const saldoActual = clienteRow.saldo_deuda || 0;
    if (saldoActual + total > clienteRow.limite_credito) {
      return {
        ok: false,
        status: 400,
        tipo: 'limite_credito',
        error: `El cliente supera su límite de crédito ($${clienteRow.limite_credito.toLocaleString('es-AR')}). Saldo actual: $${saldoActual.toLocaleString('es-AR')}`,
      };
    }
  }

  // Plan: no permitir superar el cupo de pedidos mensuales del plan contratado
  try {
    await exigirLimitePlan(supabase, empresaId, 'pedidos_mes');
  } catch (err) {
    if (err instanceof LimitePlanError) {
      return { ok: false, tipo: 'limite_plan', error: err.message, code: err.code, info: err.info };
    }
    throw err;
  }

  const detalle = {
    cliente: clienteRow.razon_social,
    items: items.map(item => ({
      producto_id: item.producto_id ?? null,
      combo_id:    item.combo_id ?? null,
      producto:    item.producto_id
        ? (nombreMap[item.producto_id] || item.producto_id)
        : (comboMap.get(item.combo_id)?.nombre || item.combo_id),
      cantidad:    item.cantidad,
      precio:      item._precio_servidor,
    })),
    subtotal:  Math.round(subtotal  * 100) / 100,
    iva_total: Math.round(iva_total * 100) / 100,
    total:     Math.round(total * 100) / 100,
  };

  // Modo preview: ya validamos todo y calculamos los totales reales, pero
  // no se toca la base — usado por el asistente para armar el resumen que
  // el usuario confirma antes de que exista el pedido.
  if (preview) return { ok: true, preview: true, ...detalle };

  // ── Crear pedido + items + reservas en una sola transacción (misma RPC) ──
  const { data: rpcResult, error: rpcError } = await crearPedidoClienteRpc({
    p_empresa_id:    empresaId,
    p_cliente_id:    clienteRow.id,
    p_vendedor_id:   vendedorId,
    p_items:         itemsParaRpc,
    p_subtotal:      detalle.subtotal,
    p_iva_total:     detalle.iva_total,
    p_total:         detalle.total,
    p_notas_cliente: notas || null,
    p_fecha_entrega: fechaEntrega || null,
    // Plan offline — Etapa 3, ítem 1: misma idempotencia que ya usaba el
    // portal cliente (ver confirmarPedidoHandler) — necesaria acá para que
    // el modal "Nuevo pedido" del admin también pueda encolarse offline y
    // reintentar sin duplicar el pedido (ver migración 443).
    p_idempotency_key: idempotencyKey || null,
  });

  if (rpcError) {
    console.error('[PEDIDO] Error en RPC crear_pedido_cliente:', rpcError);
    return { ok: false, status: 500, error: 'Error interno al crear el pedido. Intente nuevamente.' };
  }

  if (!rpcResult?.ok) {
    if (rpcResult?.tipo === 'stock_insuficiente') {
      return {
        ok: false,
        status: 409,
        tipo: 'stock_insuficiente',
        error: 'El stock de uno o más productos cambió mientras se armaba el pedido. Revisá los ítems.',
      };
    }
    console.error('[PEDIDO] RPC retornó error:', rpcResult?.error);
    return { ok: false, status: 500, error: rpcResult?.error || 'Error al crear el pedido.' };
  }

  const pedidoId = rpcResult.pedido_id;
  const yaExistia = !!rpcResult.ya_existia;

  // Auditoría: usuario_id = vendedorId, quien esté armando el pedido a
  // nombre del cliente (admin/vendedor desde el modal, o el usuarioId que
  // ya resuelve la tool `crear_pedido` del asistente antes de llegar acá)
  // — mismo punto único para las 2 formas de llegar a esta función.
  if (!yaExistia) {
    await AuditRepo.registrarAuditoriaSilenciosa(
      empresaId, vendedorId, 'pedidos', 'INSERT', pedidoId, null,
      { cliente_id: clienteRow.id, ...detalle }
    );
  }

  // Fase 1 (plan de sincronización ERP): se emite el evento de negocio
  // siempre, esté activo o no el despachador de Fase 3 — deja rastro en
  // eventos_negocio para trazabilidad aunque el camino directo (abajo)
  // sea el que efectivamente dispare los efectos para esta empresa.
  // Plan offline — Etapa 3: si el pedido ya existía (reintento/replay del
  // outbox), estos efectos ya corrieron para el intento original —
  // repetirlos duplicaría factura/puntos/notificación.
  if (!yaExistia) {
    emitirEvento({
      empresaId,
      tipoEvento: 'pedido_creado',
      payload: { pedido_id: pedidoId, cliente_id: clienteRow.id },
      origen: 'crearPedidoParaCliente',
    }).catch(err => console.error('[EVENTOS] error emitiendo pedido_creado:', err));
  }

  // Fase 3: expand-contract — nunca las dos rutas activas a la vez para
  // la misma empresa. Si no se pudo leer el flag, se cae al camino
  // directo (fail-safe) para no dejar un pedido sin sus efectos.
  let despachadorActivo = false;
  try {
    despachadorActivo = await usaDespachadorEventos(empresaId);
  } catch (err) {
    console.error('[EVENTOS] error chequeando flag fase3_despachador_eventos:', err);
  }

  if (!yaExistia) {
    if (despachadorActivo) {
      // Import dinámico: evita el ciclo estático pedidos.js → eventos-dispatcher.js
      // → eventos-listeners/pedido_creado.js → pedidos.js. Se resuelve en runtime,
      // cuando pedidos.js ya terminó de cargar, así que ESM lo maneja sin problema.
      // No "corregir" esto a un import estático sin leer esta nota primero.
      import('../eventos-dispatcher.js')
        .then(({ despacharPendientes }) => despacharPendientes({ empresaId }))
        .catch(err => console.error('[EVENTOS] error despachando eventos (Fase 3):', err));
    } else {
      // Efectos secundarios async — mismos que el flujo del portal cliente
      notificarPedidoConfirmado(pedidoId, clienteRow, empresaId).catch(console.error);

      emitirFactura(pedidoId).catch(err => {
        console.error('[PEDIDO] Error emitiendo factura automática:', err.message, { pedidoId });
      });

      acreditarPuntos(pedidoId, clienteRow, empresaId).catch(err => {
        console.error(`[PUNTOS] Error al acreditar puntos del pedido ${pedidoId}:`, err);
      });
    }
  }

  return {
    ok: true,
    pedido_id: pedidoId,
    numero: pedidoId?.slice(0, 8)?.toUpperCase(),
    ya_existia: yaExistia,
    ...detalle,
  };
}

async function crearPedidoAdminHandler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilParaCrearPedidoAdmin(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'pedidos'))
    return res.status(403).json({ error: 'Sin permisos para crear pedidos' });

  const { cliente_id, items, notas, fecha_entrega, idempotency_key } = req.body || {};

  // Plan offline — Etapa 3: mismo formato que ya usa el portal cliente
  // (UUID válido o se ignora, nunca 400 por un detalle de formato — ver
  // confirmarPedidoHandler más abajo).
  const UUID_RE_ADMIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idemKeyAdmin = (typeof idempotency_key === 'string' && UUID_RE_ADMIN.test(idempotency_key))
    ? idempotency_key
    : null;

  const resultado = await crearPedidoParaCliente({
    empresaId:   perfil.empresa_id,
    vendedorId:  perfil.id,
    clienteId:   cliente_id,
    items,
    notas,
    fechaEntrega: fecha_entrega,
    idempotencyKey: idemKeyAdmin,
  });

  if (!resultado.ok) {
    if (resultado.tipo === 'limite_plan') {
      return errorSeguro(res, new Error(resultado.error), 403, 'No se pudo completar la operación.', { code: resultado.code, info: resultado.info });
    }
    const body = { error: resultado.error };
    if (resultado.tipo) body.tipo = resultado.tipo;
    if (resultado.producto_id) body.producto_id = resultado.producto_id;
    if (resultado.disponible !== undefined) body.disponible = resultado.disponible;
    return res.status(resultado.status || 400).json(body);
  }

  return res.status(201).json({
    ok:     true,
    id:     resultado.pedido_id,
    numero: resultado.numero,
    ya_existia: resultado.ya_existia || false,
  });
}

// ═════════════════════════════════════════════════════════════════════════
// ── Confirmar pedido (antes: api/pedidos/confirmar-pedido.js) ───────────
// ═════════════════════════════════════════════════════════════════════════
async function confirmarPedidoHandler(req, res) {
  // ── 1. Autenticar usuario ────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  // ── 2. Obtener datos del usuario y cliente ───────────
  const { data: usuarioData, error: usrError } = await obtenerUsuarioParaConfirmarPedido(user.id);

  if (usrError || !usuarioData) {
    return res.status(403).json({ error: 'Usuario no encontrado' });
  }

  if (usuarioData.rol !== 'cliente') {
    return res.status(403).json({ error: 'Solo los clientes pueden hacer pedidos' });
  }

  // Buscar cliente: primero por cliente_id (usuarios portal), luego por email (legacy)
  let clienteRow = null, cliError = null;
  if (usuarioData.cliente_id) {
    const { data, error } = await obtenerClientePorIdParaConfirmar(usuarioData.empresa_id, usuarioData.cliente_id);
    clienteRow = data; cliError = error;
  } else {
    const { data, error } = await obtenerClientePorEmailParaConfirmar(usuarioData.empresa_id, usuarioData.email);
    clienteRow = data; cliError = error;
  }

  if (cliError || !clienteRow) {
    return res.status(403).json({ error: 'No se encontró un cliente asociado a esta cuenta' });
  }

  if (!clienteRow.activo) {
    return res.status(403).json({ error: 'Cliente inactivo. Contacte a la distribuidora.' });
  }

  // REQ-2: Verificar si el cliente tiene deuda vencida (score_categoria = 'bloqueado')
  // Nota: columna 'bloqueado' se agrega en 047_sincronizacion_real_db.sql
  if (clienteRow.saldo_deuda > 0 && clienteRow.limite_credito > 0 &&
      clienteRow.saldo_deuda > clienteRow.limite_credito * 1.5) {
    return res.status(403).json({
      error: 'cliente_bloqueado',
      mensaje: 'Tu cuenta tiene deuda vencida. Contactá a tu vendedor para regularizar.',
      motivo: 'Deuda supera el límite de crédito'
    });
  }

  // ── 3. Validar body ──────────────────────────────────
  const { items, notas_cliente, fecha_entrega, idempotency_key, forma_pago } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'El carrito está vacío' });
  }

  // Forma de pago: 'cuenta_corriente' (default, como siempre) o
  // 'pago_inmediato' (transferencia/efectivo a coordinar con el vendedor —
  // no genera deuda en la cta_cte del cliente, ver punto 5 más abajo y
  // emitirFactura() en lib/facturas.js). Cualquier valor no reconocido cae
  // al default seguro en vez de rechazar la confirmación.
  const formaPago = forma_pago === 'pago_inmediato' ? 'pago_inmediato' : 'cuenta_corriente';

  // Hallazgo 3 (Etapa 1, Pedidos): idempotency_key es opcional (compat con
  // clientes viejos que todavía no la mandan — nunca hace 400 por su
  // ausencia), pero si viene tiene que ser un UUID válido; cualquier otra
  // cosa se ignora en vez de romper la confirmación por un detalle de
  // formato.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idemKey = (typeof idempotency_key === 'string' && UUID_RE.test(idempotency_key))
    ? idempotency_key
    : null;

  // v(combos): cada renglón es DE UN PRODUCTO o DE UN COMBO (ítem único,
  // precio propio) — nunca ambos ni ninguno. Mismo criterio que la
  // constraint pedido_items_producto_o_combo (migración 530).
  for (const item of items) {
    const esCombo = !!item.combo_id;
    if (esCombo === !!item.producto_id) {
      return res.status(400).json({ error: 'Item inválido en el carrito' });
    }
    if (!item.cantidad || item.cantidad <= 0) {
      return res.status(400).json({ error: 'Item inválido en el carrito' });
    }
  }

  const productoIdsDirectos = items.filter(i => i.producto_id).map(i => i.producto_id);
  const comboIds            = [...new Set(items.filter(i => i.combo_id).map(i => i.combo_id))];

  // Combos: se trae la cabecera (precio propio, SERVIDOR) + composición
  // (para poder descontar stock por componente) — nunca se confía en el
  // precio ni en la composición que pueda mandar el cliente.
  const combosData = comboIds.length ? await obtenerCombosParaValidarPedido(usuarioData.empresa_id, comboIds) : [];
  const comboMap = new Map(combosData.map(c => [c.id, c]));

  for (const comboId of comboIds) {
    const combo = comboMap.get(comboId);
    if (!combo || !combo.activo) {
      return res.status(400).json({ error: `Combo no disponible: ${comboId}`, combo_id: comboId });
    }
  }

  // ── 4. Verificar stock disponible (directo + lo que consume cada combo) ──
  // Un mismo producto puede necesitarse a la vez por un renglón directo y
  // por uno o más combos del carrito — se acumula la necesidad total por
  // producto ANTES de comparar contra el stock disponible, para no aprobar
  // dos renglones que individualmente "entran" pero juntos no alcanzan.
  const necesidadPorProducto = new Map();
  for (const item of items) {
    if (item.producto_id) {
      necesidadPorProducto.set(item.producto_id, (necesidadPorProducto.get(item.producto_id) || 0) + item.cantidad);
    } else {
      const combo = comboMap.get(item.combo_id);
      for (const ci of combo.items) {
        necesidadPorProducto.set(ci.producto_id, (necesidadPorProducto.get(ci.producto_id) || 0) + ci.cantidad * item.cantidad);
      }
    }
  }
  const productoIdsParaStock = [...necesidadPorProducto.keys()];

  const stockData = await listarStockParaValidarPedido(productoIdsParaStock);

  const stockMap = {};
  for (const s of (stockData || [])) {
    if (s.depositos?.es_principal || !stockMap[s.producto_id]) {
      stockMap[s.producto_id] = {
        deposito_id: s.depositos?.id,
        disponible:  Math.max(0, s.cantidad - s.cantidad_reservada),
      };
    }
  }

  for (const [productoId, necesaria] of necesidadPorProducto) {
    const disponible = stockMap[productoId]?.disponible ?? 0;
    if (necesaria > disponible) {
      const nombreProd = await obtenerNombreProducto(productoId);
      return res.status(400).json({
        error:       `Stock insuficiente para "${nombreProd || productoId}". Disponible: ${disponible}`,
        producto_id: productoId,
        disponible,
      });
    }
  }

  // ── 4b. v85: Resolver precios del servidor (NUNCA confiar en precio del cliente)
  // Previene manipulación de precios vía devtools.
  // v176: antes esto traía CUALQUIER precio de CUALQUIER lista de la empresa
  // (primer match, sin filtrar por la lista asignada al cliente — bug real,
  // ver TODO viejo que decía "filtrar por lista asignada cuando se implemente").
  // Ahora se resuelve con resolver_precios_cliente(), que centraliza la
  // prioridad precio especial del cliente > precio de SU lista > precio_base,
  // y es el mismo punto que usa pos.js (migración 162). Solo aplica a los
  // renglones directos — los combos tienen precio propio fijo (combo.precio),
  // no pasan por reglas de precio de cliente/lista.
  const prodsData = productoIdsDirectos.length
    ? await obtenerProductosParaCotizarConCosto(usuarioData.empresa_id, productoIdsDirectos)
    : [];
  const prodMap = Object.fromEntries((prodsData || []).map(p => [p.id, p]));

  const { data: preciosResueltos, error: errPrecios } = productoIdsDirectos.length
    ? await resolverPreciosClienteRpc({
        cliente_id:   clienteRow.id,
        producto_ids: productoIdsDirectos,
        empresa_id:   usuarioData.empresa_id,
      })
    : { data: [], error: null };
  if (errPrecios) {
    console.error('[pedidos] error resolviendo precios:', errPrecios);
    return res.status(500).json({ error: 'No se pudieron resolver los precios' });
  }
  const precioMap = Object.fromEntries((preciosResueltos || []).map(p => [p.producto_id, p.precio]));

  // Validar que todos los productos/combos pertenezcan a la empresa del
  // cliente, y cachear precio/IVA del servidor por renglón.
  for (const item of items) {
    if (item.producto_id) {
      if (!prodMap[item.producto_id]) {
        return res.status(400).json({
          error: `Producto no disponible: ${item.producto_id}`,
          producto_id: item.producto_id,
        });
      }
      // Override del precio_unitario con el precio del servidor
      item._precio_servidor = precioMap[item.producto_id] ?? prodMap[item.producto_id].precio_base;
      item._iva_servidor    = prodMap[item.producto_id].iva ?? 21;
    } else {
      const combo = comboMap.get(item.combo_id);
      // Precio del combo: SIEMPRE el de la tabla `combos`, nunca el que
      // mande el cliente — ya se validó arriba que existe y está activo.
      item._precio_servidor = combo.precio;
      item._iva_servidor    = calcularIvaPonderadoCombo(combo.items);
    }
  }

  // ── 5. Verificar límite de crédito usando saldo_deuda (mantenido por trigger)
  // v85: saldo_deuda ahora se sincroniza automáticamente via trigger en cta_cte
  // v(forma_pago): si el cliente eligió 'pago_inmediato', este pedido nunca
  // va a generar un asiento en cta_cte (ver emitirFactura(), que solo debita
  // cuando forma_pago === 'cuenta_corriente' — mismo criterio que ya existía
  // para ventas POS con __monto_cta_cte_pos). No tiene sentido bloquearlo
  // contra un límite de deuda que este pedido no va a incrementar.
  if (formaPago === 'cuenta_corriente' && clienteRow.limite_credito > 0) {
    // Usar saldo_deuda del cliente (ya actualizado por trigger de cta_cte)
    const saldoActual = clienteRow.saldo_deuda || 0;
    // Calcular total del pedido con precios del servidor
    const totalPedido = items.reduce((s, i) => s + (i._precio_servidor * i.cantidad), 0);

    if (saldoActual + totalPedido > clienteRow.limite_credito) {
      return res.status(400).json({
        error: `Superás tu límite de crédito ($${clienteRow.limite_credito.toLocaleString('es-AR')}). Saldo actual: $${saldoActual.toLocaleString('es-AR')}`,
        tipo:  'limite_credito',
      });
    }
  }

  // ── 6. Calcular totales con IVA por producto ─────────
  // v85: usar precio del servidor (cacheado en _precio_servidor arriba),
  // ignorar precio_unitario que mandó el cliente. v(combos): el IVA
  // también viene cacheado por renglón (_iva_servidor) para poder usar el
  // ponderado de los combos — ver resolverIva más abajo.
  const { subtotal, iva_total, total, itemsParaRpc } = calcularTotalesPedido(items, {
    resolverPrecio: item => item._precio_servidor,
    resolverIva:    item => item._iva_servidor,
  });

  // Plan 3.3: no permitir superar el cupo de pedidos mensuales del plan contratado.
  try {
    await exigirLimitePlan(supabase, usuarioData.empresa_id, 'pedidos_mes');
  } catch (err) {
    if (err instanceof LimitePlanError) {
      return errorSeguro(res, err, 403, 'No se pudo completar la operación.', { code: err.code, info: err.info });
    }
    throw err;
  }

  // ── 7. Crear pedido + items + reservas en una sola transacción ──────────
  const { data: rpcResult, error: rpcError } = await crearPedidoClienteRpc({
    p_empresa_id:       usuarioData.empresa_id,
    p_cliente_id:       clienteRow.id,
    p_vendedor_id:      user.id,
    p_items:            itemsParaRpc,
    p_subtotal:         Math.round(subtotal  * 100) / 100,
    p_iva_total:        Math.round(iva_total * 100) / 100,
    p_total:            total,
    p_notas_cliente:    notas_cliente || null,
    p_fecha_entrega:    fecha_entrega || null,
    p_idempotency_key:  idemKey,
    p_forma_pago:       formaPago,
  });

  if (rpcError) {
    console.error('[PEDIDO] Error en RPC crear_pedido_cliente:', rpcError);
    return res.status(500).json({ error: 'Error interno al crear el pedido. Intente nuevamente.' });
  }

  if (!rpcResult?.ok) {
    if (rpcResult?.tipo === 'stock_insuficiente') {
      return res.status(409).json({
        error: 'El stock de uno o más productos cambió mientras confirmabas el pedido. Por favor, revisá el carrito.',
        tipo:  'stock_insuficiente',
      });
    }
    console.error('[PEDIDO] RPC retornó error:', rpcResult?.error);
    return res.status(500).json({ error: rpcResult?.error || 'Error al crear el pedido.' });
  }

  const pedidoId   = rpcResult.pedido_id;
  const yaExistia  = !!rpcResult.ya_existia;

  // Auditoría: usuario_id = el user.id autenticado del portal cliente (es
  // un humano real detrás, solo que "cliente" en vez de "admin"). Se omite
  // en el caso de idempotency_key duplicado (yaExistia) para no loguear
  // dos veces la misma creación real.
  if (!yaExistia) {
    await AuditRepo.registrarAuditoriaSilenciosa(
      usuarioData.empresa_id, user.id, 'pedidos', 'INSERT', pedidoId, null,
      { cliente_id: clienteRow.id, subtotal, iva_total, total, items: itemsParaRpc }
    );
  }

  // ── 8. Limpiar carrito del cliente (portal) ──────────────────────────────
  // Se hace antes de los efectos secundarios para liberar el carrito
  // incluso si alguna notificación falla.
  vaciarCarritoCliente(clienteRow.id)
    .then(() => {}) // fire-and-forget: el carrito también se limpia en el frontend
    .catch(err => console.error('[CARRITO] Error vaciando carrito:', err));

  // ── 9. Efectos secundarios async ─────────────────────────────────────────
  // Hallazgo 3: si `crear_pedido_cliente` devolvió un pedido YA EXISTENTE
  // (mismo idempotency_key — este request es un reintento del cliente tras
  // un timeout de red, no un pedido nuevo), estos efectos ya corrieron para
  // el intento original. Repetirlos duplicaría el WhatsApp/email/push de
  // confirmación, la factura y los puntos de fidelización — el fix de
  // duplicidad de PEDIDOS no debe convertirse en duplicidad de sus efectos.
  if (!yaExistia) {
    notificarPedidoConfirmado(pedidoId, clienteRow, usuarioData.empresa_id).catch(console.error);

    emitirFactura(pedidoId).catch(err => {
      console.error(`[FACTURACION] Error al emitir factura del pedido ${pedidoId}:`, err);
    });

    acreditarPuntos(pedidoId, clienteRow, usuarioData.empresa_id).catch(err => {
      console.error(`[PUNTOS] Error al acreditar puntos del pedido ${pedidoId}:`, err);
    });

    // Push al cliente (confirmación de su propio pedido)
    notificarPushPedidoConfirmado(pedidoId, clienteRow, usuarioData.empresa_id).catch(err => {
      console.error(`[PUSH] Error al enviar push del pedido ${pedidoId}:`, err);
    });

    // Push a los administradores (nuevo pedido recibido)
    notificarPushAdmin(pedidoId, clienteRow, usuarioData.empresa_id).catch(err => {
      console.error(`[PUSH-ADMIN] Error al notificar admins del pedido ${pedidoId}:`, err);
    });
  } else {
    console.log(`[PEDIDO] Confirmación duplicada detectada por idempotency_key — pedido ${pedidoId} ya existía, se omiten efectos secundarios.`);
  }

  // ── 10. Responder ─────────────────────────────────────
  // Recuperar numero_pedido generado por el trigger de DB
  const pedidoNro = await obtenerNumeroPedido(pedidoId);

  return res.status(200).json({
    ok:             true,
    pedido_id:      pedidoId,
    numero_pedido:  pedidoNro?.numero_pedido || pedidoId.slice(-8).toUpperCase(),
    total,
    ya_existia:     yaExistia,
    mensaje:        'Pedido confirmado. Recibirás un WhatsApp con la confirmación.',
  });
}

// ── Notificaciones async de confirmar-pedido ────────────────────────────────

// ── Helper para no repetir el insert de notif_log en cada rama de falla ────
// (Hallazgo 2, auditoría notificaciones): antes las fallas de WhatsApp/email
// en la confirmación de pedido solo se logueaban con console.error y no
// dejaban rastro en notif_log — indistinguible de "nunca se intentó".
//
// Generalizado (Hallazgo 2, "reenvío manual de emails"): antes solo servía
// para tipo='confirmacion_pedido' (estaba hardcodeado). Ahora recibe `tipo`
// explícito para poder reusarlo también en el aviso de despacho, que tenía
// el mismo problema pero ni siquiera tenía este helper (notificarDespachoPorEmail
// descartaba el resultado del envío por completo, sin loguear nada, ni
// éxito ni falla).
async function _logNotif({ empresaId, clienteId, pedidoId, tipo, canal, telefono, email, messageId, payload, entregada, motivo }) {
  try {
    await insertarNotifLog({
      empresa_id: empresaId,
      cliente_id: clienteId,
      pedido_id:  pedidoId,
      tipo,
      canal,
      telefono:   telefono || null,
      email:      email || null,
      message_id: messageId || null,
      payload:    payload || null,
      entregada,
      motivo:     motivo || null,
    });
  } catch (err) {
    console.error(`[NOTIF] Error guardando notif_log (tipo ${tipo}, canal ${canal}, pedido ${pedidoId}):`, err.message);
  }
}

export async function notificarPedidoConfirmado(pedidoId, cliente, empresaId) {
  // FIX: pedidos.numero no existe — número se genera desde id.slice(0,8).toUpperCase()
  const pedido = await obtenerPedidoNumeroYTotal(pedidoId);

  if (!pedido) return;

  const numeroLabel = pedido.id.slice(-8).toUpperCase();

  // ── WhatsApp de confirmación ────────────────────────────────────────────
  // FIX: antes, si el cliente no tenía teléfono, la función retornaba temprano
  // y el email de confirmación de más abajo nunca se disparaba. Ahora cada
  // canal es independiente: la falta de teléfono solo omite el WhatsApp.
  if (!cliente.telefono) {
    console.log(`[NOTIF] Cliente ${cliente.id} sin teléfono — omitiendo WhatsApp`);
    await _logNotif({
      tipo: 'confirmacion_pedido',
      empresaId, clienteId: cliente.id, pedidoId,
      canal: 'whatsapp', entregada: false, motivo: 'sin_telefono',
    });
  } else {
    try {
      const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : process.env.APP_URL || 'http://localhost:3000';

      const resp = await fetch(`${base}/api/notif/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: 'confirmacion_pedido',
          telefono: cliente.telefono,
          params: {
            nombre_cliente: cliente.razon_social.split(/[\s,]+/)[0],
            numero_pedido:  numeroLabel,
            total:          pedido.total,
          },
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        console.error(`[NOTIF] Error WA pedido ${pedidoId}:`, data.error);
        await _logNotif({
          tipo: 'confirmacion_pedido',
          empresaId, clienteId: cliente.id, pedidoId,
          canal: 'whatsapp', telefono: cliente.telefono,
          payload: { numero_pedido: numeroLabel, total: pedido.total, error: data.error || null },
          entregada: false, motivo: 'error_envio',
        });
      } else {
        await _logNotif({
          tipo: 'confirmacion_pedido',
          empresaId, clienteId: cliente.id, pedidoId,
          canal: 'whatsapp', telefono: cliente.telefono,
          messageId: data.message_id || null,
          payload: { numero_pedido: numeroLabel, total: pedido.total },
          entregada: true,
        });
        console.log(`[NOTIF] WA confirmacion_pedido enviado a ${cliente.telefono} | pedido ${pedidoId}`);
      }
    } catch (err) {
      console.error(`[NOTIF] Error de red para pedido ${pedidoId}:`, err.message);
      await _logNotif({
        tipo: 'confirmacion_pedido',
        empresaId, clienteId: cliente.id, pedidoId,
        canal: 'whatsapp', telefono: cliente.telefono,
        payload: { numero_pedido: numeroLabel, total: pedido.total, error: err.message },
        entregada: false, motivo: 'error_red',
      });
    }
  }

  // ── Email de confirmación ──────────────────────────────────────────────
  try {
    // FIX: pedidos.numero no existe — se omite de SELECT
    const pedidoCompleto = await obtenerPedidoCompletoParaEmailConfirmacion(pedidoId);

    const clienteEmail = await obtenerClienteEmailRazonSocial(cliente.id);

    const empresa = await obtenerEmpresaContacto(empresaId);

    if (pedidoCompleto && clienteEmail) {
      const items = (pedidoCompleto.pedido_items || []).map(i => ({
        nombre:          i.productos?.nombre || '—',
        cantidad:        i.cantidad,
        precio_unitario: i.precio_unitario,
        descuento_pct:   i.descuento_pct || 0,
      }));
      const resultado = await enviarEmailConfirmacionPedido(pedidoCompleto, clienteEmail, empresa, items);

      await _logNotif({
        tipo: 'confirmacion_pedido',
        empresaId, clienteId: cliente.id, pedidoId,
        canal: 'email', email: clienteEmail.email,
        messageId: resultado?.id || null,
        payload: { numero_pedido: numeroLabel, total: pedido.total },
        entregada: !!resultado?.ok,
        motivo: resultado?.ok ? null : (resultado?.razon || 'error_desconocido'),
      });

      if (!resultado?.ok) {
        console.error(`[EMAIL] Confirmación no entregada para pedido ${pedidoId} — motivo: ${resultado?.razon}`);
      }
    } else {
      // Sin fila de cliente/email consultable — no hay a quién mandarle,
      // pero igual dejamos rastro (distinto de 'sin_email' del helper interno).
      await _logNotif({
        tipo: 'confirmacion_pedido',
        empresaId, clienteId: cliente.id, pedidoId,
        canal: 'email', entregada: false, motivo: 'cliente_no_encontrado',
      });
    }
  } catch (err) {
    console.error(`[EMAIL] Error enviando confirmación del pedido ${pedidoId}:`, err.message);
    await _logNotif({
      tipo: 'confirmacion_pedido',
      empresaId, clienteId: cliente.id, pedidoId,
      canal: 'email', payload: { error: err.message },
      entregada: false, motivo: 'error_inesperado',
    });
  }
}

export async function acreditarPuntos(pedidoId, cliente, empresaId) {
  const programa = await obtenerProgramaFidelizacionActivo(empresaId);

  if (!programa) return;

  const pedido = await obtenerPedidoTotal(pedidoId);

  if (!pedido) return;

  // Bonus por comportamiento de pago (Innovación #8): el cliente gana puntos
  // extra según su categoría de score, no solo por el monto del pedido.
  const clienteScore = await obtenerClienteScoreCategoria(cliente.id);

  const categoria = clienteScore?.score_categoria || null;
  const bonusPct  = (categoria && programa.bonus_pct_categoria?.[categoria]) || 0;

  const puntosBase    = pedido.total * programa.puntos_por_peso;
  const puntosGanados = Math.floor(puntosBase * (1 + bonusPct / 100));
  if (puntosGanados <= 0) return;

  const motivo = bonusPct > 0
    ? `Pedido #${pedidoId.substring(0, 8).toUpperCase()} (+${bonusPct}% bonus por categoría "${categoria}")`
    : `Pedido #${pedidoId.substring(0, 8).toUpperCase()}`;

  // FIX: antes había un insert manual a movimientos_puntos acá ARRIBA del
  // registrar_movimiento_puntos() de abajo, que también inserta el mismo
  // movimiento -> cada pedido quedaba duplicado en el historial (el saldo
  // estaba bien porque solo el RPC toca saldo_puntos). Se deja un solo
  // camino: el RPC primero, y el insert manual + upsert de saldo solo como
  // fallback si el RPC falla.
  const { error: rpcError } = await registrarMovimientoPuntosRpc({
    p_cliente_id:    cliente.id,
    p_empresa_id:    empresaId,
    p_tipo:          'ganancia',
    p_cantidad:      puntosGanados,
    p_motivo:        motivo,
    p_referencia_id: pedidoId,
  });

  if (rpcError) {
    console.error(`[PUNTOS] RPC registrar_movimiento_puntos falló, usando fallback manual:`, rpcError.message);
    await insertarMovimientoPuntosFallback({
      cliente_id:    cliente.id,
      empresa_id:    empresaId,
      tipo:          'ganancia',
      cantidad:      puntosGanados,
      motivo,
      referencia_id: pedidoId,
    });
    // FIX (auditoría 2026, etapa 13, Hallazgo 3): el upsert de acá abajo
    // PISABA puntos_disponibles/puntos_totales con puntosGanados en vez de
    // sumarlos -- si el cliente ya tenía saldo acumulado y el RPC fallaba,
    // el fallback le resetaba el saldo al valor del último pedido. Ahora
    // usa sumar_saldo_puntos_fallback() (RPC atómica, ON CONFLICT DO
    // UPDATE ... = saldo_puntos.puntos_disponibles + p_cantidad).
    const { error: fallbackError } = await sumarSaldoPuntosFallbackRpc({
      p_cliente_id: cliente.id,
      p_empresa_id: empresaId,
      p_cantidad:   puntosGanados,
    });
    if (fallbackError) {
      console.error(`[PUNTOS] Fallback de saldo también falló:`, fallbackError.message);
    }
  }

  console.log(`[PUNTOS] ${puntosGanados} puntos acreditados al cliente ${cliente.id}${bonusPct > 0 ? ` (incluye bonus ${bonusPct}% por categoría "${categoria}")` : ''}`);

  // Cableado (auditoría notificaciones): la función existía en _push.js
  // desde antes pero nunca tenía caller — la acreditación ocurría en
  // silencio para el cliente. Best-effort, no bloquea el pedido si falla.
  notificarPuntosGanados(cliente.id, puntosGanados, motivo).catch(err =>
    console.error(`[PUNTOS] Error enviando push de puntos ganados:`, err.message));
}

async function notificarPushPedidoConfirmado(pedidoId, cliente, empresaId) {
  // FIX (Hallazgo 2, auditoría notificaciones): esta función le pegaba a
  // POST /api/notif/push, que es el endpoint de alta/baja de dispositivo
  // (espera { usuario_id, token_push }), no un endpoint de envío. El body
  // real que se mandaba ({ tokens, titulo, cuerpo, ... }) no matchea esa
  // forma, así que la llamada devolvía 400 siempre — y como no había check
  // de resp.ok ni catch, la falla era 100% silenciosa. El push de "pedido
  // confirmado" al cliente nunca se entregó desde que existe esta función.
  // Ahora se llama directo a enviarPush() (mismo helper que ya usa
  // push-interno), evitando el round-trip HTTP roto y logueando en
  // notif_log automáticamente (éxito y falla).
  const { enviadas, razon } = await enviarPush(
    cliente.id,
    'Pedido confirmado',
    `Tu pedido #${pedidoId.substring(0, 8).toUpperCase()} fue recibido.`,
    { link: '/cliente/pedidos.html', pedido_id: pedidoId },
    { empresa_id: empresaId, cliente_id: cliente.id, pedido_id: pedidoId, tipo: 'confirmacion_pedido' }
  );

  if (enviadas > 0) {
    console.log(`[PUSH] Notificación enviada a ${enviadas} dispositivo(s) del cliente ${cliente.id}`);
  } else {
    console.log(`[PUSH] Sin entrega para cliente ${cliente.id} en pedido ${pedidoId} — motivo: ${razon || 'sin_dispositivos'}`);
  }
}

// ── Push a administradores cuando llega un pedido nuevo ───────────────────────
//
// Obtiene todos los usuarios de la empresa con rol dueno/admin/vendedor que
// tengan al menos un dispositivo push activo y los notifica vía el endpoint
// push-interno. Se usa el header interno "x-trigger: supabase" ya existente
// — el llamado es server-to-server, nunca expuesto al cliente.
//
async function notificarPushAdmin(pedidoId, cliente, empresaId) {
  // 1. Obtener datos del pedido para armar el cuerpo de la notificación
  // FIX Bug-28: pedidos no tiene columna 'numero'; se genera desde id post-fetch
  const pedido = await obtenerPedidoNumeroYTotal(pedidoId);

  if (!pedido) return;

  // numero_pedido generado desde id (pedidos.numero no existe como columna)
  const numero = pedido.id.slice(-8).toUpperCase();
  const total  = Math.round(pedido.total || 0).toLocaleString('es-AR');
  const nombre = (cliente.razon_social || '').split(/[\s,]+/)[0] || 'Cliente';

  // 2. Llamar al endpoint push-interno (server-to-server)
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : (process.env.API_URL || 'http://localhost:3000');

  const resp = await fetch(`${base}/api/notif/push-interno`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-trigger':    'supabase',          // cabecera interna requerida por el handler
    },
    body: JSON.stringify({
      empresa_id: empresaId,
      tipo:       'nuevo_pedido',
      titulo:     `Nuevo pedido de ${nombre}`,
      cuerpo:     `Pedido #${numero} · $${total}`,
      datos: {
        pedido_id: pedidoId,
        link:      '/admin/pedidos.html',
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.warn(`[PUSH-ADMIN] push-interno devolvió ${resp.status}: ${body}`);
    return;
  }

  const result = await resp.json();
  console.log(`[PUSH-ADMIN] Notificación enviada a ${result.enviadas ?? 0} dispositivo(s) de admins — pedido ${pedidoId}`);
}


// ══════════════════════════════════════════════════════════════════════════
// ── Presupuestos (absorto desde api/presupuestos/index.js) ─────────────
// ══════════════════════════════════════════════════════════════════════════
// Reexportado tal cual porque asistente-tools.js lo reimporta como
// ROLES_PRESUPUESTO — mismo criterio que ROLES_ADMIN de arriba.
export const ROLES_ADMIN_PRES = rolesDe('presupuestos', 'acceder');
// Estados según constraint real de la DB: borrador|enviado|aceptado|rechazado|vencido
const ESTADOS_VALIDOS_PRES = ['borrador', 'enviado', 'aceptado', 'rechazado', 'vencido'];

// Vigencia por defecto en días, usada tanto acá como en handlePresupuestos
// (antes vivía duplicado el número 48 en dos lugares — ver comentario de
// crearPresupuestoParaCliente).
const PRESUPUESTO_VIGENCIA_DIAS_DEFAULT = 48;

// Función pura equivalente a crearPedidoParaCliente (ver más arriba), para
// que el asistente de ayuda (lib/asistente-tools.js, tool `crear_presupuesto`)
// pueda armar y proponer un presupuesto sin duplicar la lógica de negocio
// del handler HTTP. A diferencia de un pedido:
//   - NO valida stock (un presupuesto es una cotización, no reserva nada).
//   - NO valida límite de crédito ni cupo de plan de pedidos_mes.
//   - SÍ resuelve precios reales en servidor (misma RPC resolver_precios_cliente
//     que crearPedidoParaCliente) — nunca se confía en un precio que venga
//     del frontend o de lo que haya "leído" el modelo en un texto/imagen.
// preview:true valida todo y calcula los totales reales sin tocar la base
// (mismo uso que preview en crearPedidoParaCliente).
export async function crearPresupuestoParaCliente({ empresaId, vendedorId, clienteId, items, notas, diasVigencia, preview = false }) {
  if (!clienteId) return { ok: false, status: 400, error: 'cliente_id requerido' };
  if (!Array.isArray(items) || !items.length)
    return { ok: false, status: 400, error: 'Agregá al menos un producto' };

  // v536: mismo criterio de ítem único que crearPedidoParaCliente /
  // confirmarPedidoHandler — producto XOR combo (constraint
  // presupuesto_items_producto_o_combo, migración 536).
  for (const item of items) {
    const esCombo = !!item.combo_id;
    if (esCombo === !!item.producto_id) {
      return { ok: false, status: 400, error: 'Item inválido' };
    }
    if (!item.cantidad || item.cantidad <= 0)
      return { ok: false, status: 400, error: 'Item inválido' };
  }

  const { data: clienteRow, error: cliError } = await obtenerClienteParaPresupuesto(empresaId, clienteId);

  if (cliError || !clienteRow) return { ok: false, status: 404, error: 'Cliente no encontrado' };
  if (!clienteRow.activo) return { ok: false, status: 400, error: 'El cliente está inactivo' };

  const productoIdsDirectos = items.filter(i => i.producto_id).map(i => i.producto_id);
  const comboIds            = [...new Set(items.filter(i => i.combo_id).map(i => i.combo_id))];

  // Un presupuesto no reserva ni descuenta stock (es una cotización), así
  // que del combo solo hace falta precio propio + composición para el IVA
  // ponderado — no hace falta validar stock de sus componentes acá.
  const combosData = comboIds.length ? await obtenerCombosParaValidarPedido(empresaId, comboIds) : [];
  const comboMap = new Map(combosData.map(c => [c.id, c]));

  for (const comboId of comboIds) {
    const combo = comboMap.get(comboId);
    if (!combo || !combo.activo) {
      return { ok: false, status: 400, error: `Combo no disponible: ${comboId}`, combo_id: comboId };
    }
  }

  // ── Precios resueltos en servidor (misma RPC que pedidos y el panel) ──
  // Solo aplica a renglones directos — los combos usan su precio propio
  // (combo.precio), nunca reglas de precio de cliente/lista.
  const { data: preciosResueltos, error: errPrecios } = productoIdsDirectos.length
    ? await resolverPreciosClienteRpc({
        cliente_id:   clienteRow.id,
        producto_ids: productoIdsDirectos,
        empresa_id:   empresaId,
      })
    : { data: [], error: null };
  if (errPrecios) {
    console.error('[PRESUPUESTO] error resolviendo precios:', errPrecios);
    return { ok: false, status: 500, error: 'No se pudieron resolver los precios' };
  }
  const precioMap = Object.fromEntries((preciosResueltos || []).map(p => [p.producto_id, p.precio]));

  const prodsData = productoIdsDirectos.length
    ? await obtenerProductosParaValidarPedido(empresaId, productoIdsDirectos)
    : [];

  if (!prodsData || prodsData.length !== productoIdsDirectos.length) {
    return { ok: false, status: 400, error: 'Uno o más productos no pertenecen a esta empresa' };
  }
  const nombreMap = Object.fromEntries(prodsData.map(p => [p.id, p.nombre]));
  const prodMap   = Object.fromEntries(prodsData.map(p => [p.id, p]));

  for (const item of items) {
    if (item.producto_id) {
      item._precio_servidor = precioMap[item.producto_id] ?? prodMap[item.producto_id]?.precio_base ?? 0;
      item._iva_servidor    = prodMap[item.producto_id]?.iva ?? 21;
    } else {
      const combo = comboMap.get(item.combo_id);
      item._precio_servidor = combo.precio;
      item._iva_servidor    = calcularIvaPonderadoCombo(combo.items);
    }
  }

  const { subtotal, total, itemsParaRpc } = calcularTotalesPedido(items, {
    resolverPrecio: item => item._precio_servidor,
    resolverIva:    item => item._iva_servidor,
  });
  // Los presupuestos no discriminan IVA en la fila (a diferencia del
  // pedido): `subtotal` y `total` de la tabla `presupuestos` son el mismo
  // valor, igual que ya hacía el POST original de handlePresupuestos.

  const detalle = {
    cliente: clienteRow.razon_social,
    items: items.map(item => ({
      producto_id: item.producto_id ?? null,
      combo_id:    item.combo_id ?? null,
      producto:    item.producto_id
        ? (nombreMap[item.producto_id] || item.producto_id)
        : (comboMap.get(item.combo_id)?.nombre || item.combo_id),
      cantidad:    item.cantidad,
      precio:      item._precio_servidor,
    })),
    subtotal: Math.round(subtotal * 100) / 100,
    total:    Math.round(subtotal * 100) / 100,
  };

  if (preview) return { ok: true, preview: true, ...detalle };

  const vigencia = diasVigencia ?? PRESUPUESTO_VIGENCIA_DIAS_DEFAULT;
  const fechaVenc = new Date();
  fechaVenc.setHours(fechaVenc.getHours() + vigencia);

  const { data: creado, error: errPres } = await crearPresupuestoConItemsRpc({
    p_empresa_id:        empresaId,
    p_cliente_id:        clienteRow.id,
    p_vendedor_id:       vendedorId,
    p_estado:            'borrador',
    p_subtotal:          detalle.subtotal,
    p_total:             detalle.total,
    p_notas:             notas || null,
    p_fecha_vencimiento: fechaVenc.toISOString(),
    p_items:             itemsParaRpc,
  });

  if (errPres || !creado?.ok) {
    console.error('[PRESUPUESTO] Error creando cabecera e ítems transaccionalmente:', errPres || creado?.error);
    return { ok: false, status: 500, error: creado?.error || 'No se pudo crear el presupuesto' };
  }

  return { ok: true, presupuesto_id: creado.presupuesto_id, numero: creado.numero, ...detalle };
}

async function handlePresupuestos(req, res) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilPresupuestos(user.id);

  if (!perfil) return res.status(403).json({ error: 'Usuario no encontrado' });

  const empresa_id = perfil.empresa_id;
  const esAdmin    = puede(perfil, 'acceder', 'presupuestos');
  const esCliente  = perfil.rol === 'cliente';

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { id, accion } = req.query;

    // UI-004: precios reales por cliente — usado por el modal "Nuevo presupuesto"
    // para mostrar el precio correcto (lista especial, zona, descuento) al elegir
    // cliente, en vez de precio_base crudo. Reutiliza la misma RPC que el backend
    // de creación (crearPresupuestoParaCliente) y el POST de pedidos.
    if (accion === 'precios-cliente') {
      if (!esAdmin) return res.status(403).json({ error: 'Sin permisos' });
      const { cliente_id, producto_ids } = req.query;
      if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido' });
      const ids = (producto_ids || '').split(',').filter(Boolean);
      if (!ids.length) return res.json([]);
      const { data, error: errRpc } = await resolverPreciosClienteRpc({
        cliente_id,
        producto_ids: ids,
        empresa_id,
      });
      if (errRpc) return errorSeguro(res, errRpc, 500, 'No se pudo resolver los precios.');
      return res.json(data || []);
    }

    if (id) {
      const { data, error } = await obtenerPresupuestoConDetalle(empresa_id, id);

      if (error) return res.status(404).json({ error: 'Presupuesto no encontrado' });

      // cliente solo puede ver sus propios presupuestos
      if (esCliente) {
        const cli = await obtenerClientePorUsuarioId(empresa_id, user.id);
        if (!cli || data.cliente_id !== cli.id)
          return res.status(403).json({ error: 'Sin permisos' });
      }

      return res.json(data);
    }

    // Lista
    let clienteIdFiltro = null;
    if (esCliente) {
      const cli = await obtenerClientePorUsuarioId(empresa_id, user.id);
      if (!cli) return res.json([]);
      clienteIdFiltro = cli.id;
    }

    const { estado, cliente_id } = req.query;
    if (cliente_id && esAdmin) clienteIdFiltro = cliente_id;

    const { data, error } = await listarPresupuestos(empresa_id, { estado, clienteId: clienteIdFiltro });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json(data || []);
  }

  // ── POST: crear ───────────────────────────────────────────────────────────
  // PED-022: los precios del body son datos de presentación, nunca fuente de
  // verdad. El flujo común resuelve precios contra la RPC efectiva de QA y
  // calcula los totales en servidor antes de persistir.
  if (req.method === 'POST') {
    if (!esAdmin) return res.status(403).json({ error: 'Sin permisos' });

    const { cliente_id, items = [], notas, dias_vigencia } = req.body || {};
    if (!cliente_id || !items.length)
      return res.status(400).json({ error: 'cliente_id e items son requeridos' });

    const resultado = await crearPresupuestoParaCliente({
      empresaId: empresa_id,
      vendedorId: perfil.id,
      clienteId: cliente_id,
      // Deliberadamente no se pasan precio_unitario ni subtotal del frontend.
      items: items.map(item => ({
        producto_id: item.producto_id || null,
        combo_id:    item.combo_id || null,
        cantidad: item.cantidad,
        descuento_pct: item.descuento_pct,
      })),
      notas,
      diasVigencia: dias_vigencia,
      preview: false,
    });

    if (!resultado.ok) {
      return res.status(resultado.status || 500).json({ error: resultado.error });
    }
    return res.status(201).json({
      ok: true,
      id: resultado.presupuesto_id,
      numero: resultado.numero,
      total: resultado.total,
    });
  }

  // ── PATCH: actualizar estado o datos ─────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, estado, notas, fecha_vencimiento } = req.body;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    // Verificar que pertenece a la empresa
    const pres = await obtenerPresupuestoParaPatch(empresa_id, id);

    if (!pres) return res.status(404).json({ error: 'No encontrado' });

    // Cliente solo puede aprobar o rechazar presupuestos enviados
    if (esCliente) {
      const cli = await obtenerClientePorUsuarioId(empresa_id, user.id);
      if (!cli || pres.cliente_id !== cli.id)
        return res.status(403).json({ error: 'Sin permisos' });
      if (!['aceptado', 'rechazado'].includes(estado))
        return res.status(403).json({ error: 'Solo podés aceptar o rechazar' });
      if (pres.estado !== 'enviado')
        return res.status(400).json({ error: 'Solo se pueden responder presupuestos enviados' });
    }

    if (estado && !ESTADOS_VALIDOS_PRES.includes(estado))
      return res.status(400).json({ error: 'Estado inválido' });

    const patch = {};
    if (estado)            patch.estado            = estado;
    if (notas !== undefined) patch.notas            = notas;
    if (fecha_vencimiento) patch.fecha_vencimiento = fecha_vencimiento;

    // Si se acepta: convertir a pedido automáticamente
    // v85: lock optimista — el UPDATE solo procede si estado sigue siendo 'enviado'
    // Previene que dos vendedores simultáneos generen dos pedidos del mismo presupuesto.
    if (estado === 'aceptado') {
      // Intentar cambiar estado atómicamente — solo desde 'enviado'
      const { data: lockResult, error: lockError } = await bloquearPresupuestoAceptado(empresa_id, id);

      if (lockError || !lockResult) {
        // Otro proceso ya lo convirtió — devolver error claro
        return res.status(409).json({
          error: 'Este presupuesto ya fue procesado por otro usuario. Recargá la página.',
          codigo: 'presupuesto_ya_convertido'
        });
      }

      const presCompleto = await obtenerPresupuestoCompleto(id);

      // Fix (auditoría Fase 11): esto insertaba el pedido directo en estado
      // 'confirmado' sin pasar por confirmar_pedido(), así que un presupuesto
      // aceptado podía generar un pedido que sobrevendiera stock o superara
      // el límite de crédito del cliente sin que nada lo bloqueara — los
      // mismos chequeos que sí corren para un pedido armado a mano quedaban
      // salteados acá. No se puede llamar directo a la RPC confirmar_pedido()
      // porque depende de auth.uid()/get_empresa_id() (piensa que corre con
      // la sesión del usuario), y este handler corre con service_role — el
      // mismo patrón de bug que ya encontramos en el trigger de empresa_id.
      // Se replican acá los mismos chequeos (crédito + stock) y la misma
      // reserva, para que el resultado sea equivalente al de un pedido
      // confirmado por el camino normal.
      // Fix (revisión post-Fase 11, confirmado en vivo en Fase 12): la
      // versión anterior leía tipo IN ('factura','nota_debito') y la
      // columna `importe`. Ningún proceso real (facturas.js, POS, cierre.js)
      // escribe con esa convención — todos usan tipo 'debito'/'credito' y
      // solo llenan `monto` — así que este chequeo nunca veía la deuda real
      // de un cliente. Se comprobó insertando una deuda de $999.999 al
      // estilo facturas.js: el saldo acá seguía en cero.
      // Ahora se usa clientes.saldo_deuda, la misma columna que ya usa el
      // camino de "pedido armado a mano" (líneas ~485-496) y que el
      // trigger trg_sync_saldo_deuda mantiene al día en cada movimiento de
      // cta_cte, sin importar qué proceso lo haya escrito.
      const clienteCredito = await obtenerClienteCredito(pres.cliente_id);

      if (clienteCredito?.limite_credito > 0) {
        const saldo = clienteCredito.saldo_deuda || 0;
        if (saldo + presCompleto.total > clienteCredito.limite_credito) {
          return res.status(400).json({
            error: `Límite de crédito superado por este presupuesto. Saldo actual: $${saldo.toLocaleString('es-AR')} / Límite: $${clienteCredito.limite_credito.toLocaleString('es-AR')}`,
            codigo: 'limite_credito',
          });
        }
      }

      const items = presCompleto.presupuesto_items || [];
      const stockReservas = [];
      for (const it of items) {
        if (!it.producto_id) continue; // ítems "de texto" sin producto real

        // Fix (revisión post-Fase 11): réplica exacta de la lógica de
        // confirmar_pedido() — primero el depósito PRINCIPAL. Solo si no
        // existe NINGÚN registro de stock para el principal se cae al
        // fallback (cualquier depósito de la empresa, el de mayor
        // disponible). Si el principal tiene registro pero insuficiente,
        // NO se prueba otro depósito — mismo comportamiento que la función
        // SQL real, para no introducir un comportamiento distinto entre
        // los dos caminos de confirmación.
        let stockFila = await obtenerStockDepositoPrincipal(empresa_id, it.producto_id);

        if (!stockFila) {
          const fallbackRows = await listarStockOtrosDepositos(empresa_id, it.producto_id);

          if (fallbackRows.length > 0) {
            stockFila = fallbackRows.reduce((mejor, fila) => {
              const disp = fila.cantidad - fila.cantidad_reservada;
              const dispMejor = mejor ? mejor.cantidad - mejor.cantidad_reservada : -Infinity;
              return disp > dispMejor ? fila : mejor;
            }, null);
          }
        }

        const disponible = stockFila ? stockFila.cantidad - stockFila.cantidad_reservada : 0;
        if (!stockFila || disponible < it.cantidad) {
          return res.status(400).json({
            error: `Stock insuficiente para confirmar el pedido (producto ${it.producto_id}). Disponible: ${disponible}`,
            producto_id: it.producto_id,
          });
        }
        stockReservas.push({ deposito_id: stockFila.deposito_id, producto_id: it.producto_id, cantidad: it.cantidad });
      }

      // Crear pedido desde presupuesto (arranca en confirmado recién si todo
      // lo anterior pasó — antes de esto era incondicional)
      const { data: pedidoNuevo, error: errPed } = await crearPedidoDesdePresupuesto({
        empresa_id,
        cliente_id:   pres.cliente_id,
        vendedor_id:  presCompleto.vendedor_id,
        estado:       'confirmado',
        subtotal:     presCompleto.subtotal,
        total:        presCompleto.total,
        notas_internas: `Generado desde presupuesto ${presCompleto.numero}`,
        presupuesto_id: id,
      });

      // Fix (revisión post-Fase 11): antes, si esto fallaba, el código
      // seguía de largo y devolvía igual `ok:true` — dejando el presupuesto
      // trabado en 'aceptado' (por el lock optimista de arriba) sin ningún
      // pedido real detrás. Ahora se revierte el lock y se informa el error.
      if (errPed || !pedidoNuevo) {
        await revertirPresupuestoAEnviado(id);
        return res.status(500).json({
          error: 'No se pudo crear el pedido desde el presupuesto: ' + (errPed?.message || 'error desconocido'),
        });
      }

      const itemsPed = items.map(it => ({
        pedido_id:       pedidoNuevo.id,
        producto_id:     it.producto_id,
        cantidad:        it.cantidad,
        precio_unitario: it.precio_unitario,
        descuento_pct:   it.descuento_pct,
        subtotal:        it.subtotal,
      }));
      const { error: errItems } = await insertarItemsPedidoDesdePresupuesto(itemsPed);
      if (errItems) {
        await eliminarPedido(pedidoNuevo.id);
        await revertirPresupuestoAEnviado(id);
        return errorSeguro(res, errItems, 500, 'No se pudieron crear los ítems del pedido.');
      }

      // Reservar stock (mismo efecto que incrementar_stock_reservado + el
      // movimiento que registra confirmar_pedido).
      // Fix (revisión post-Fase 11): antes no se chequeaba el error de esta
      // llamada. incrementar_stock_reservado vuelve a validar disponible
      // con FOR UPDATE al momento de reservar, así que en una carrera real
      // entre dos confirmaciones simultáneas puede fallar acá — antes ese
      // fallo quedaba en silencio y el pedido igual quedaba "confirmado"
      // sin el stock realmente reservado. Ahora, si falla, se libera lo ya
      // reservado en este mismo loop y se deshace el pedido en vez de
      // dejarlo en un estado inconsistente.
      const reservasHechas = [];
      for (const r of stockReservas) {
        const { error: errReserva } = await incrementarStockReservadoRpc(r);

        if (errReserva) {
          for (const hecha of reservasHechas) {
            await liberarStockReservadoRpc(hecha).catch(() => {});
          }
          await eliminarItemsPedido(pedidoNuevo.id);
          await eliminarPedido(pedidoNuevo.id);
          await revertirPresupuestoAEnviado(id);
          return res.status(409).json({
            error: `No se pudo reservar stock para el producto ${r.producto_id} (probablemente otro pedido tomó el stock en simultáneo). Volvé a intentar la conversión.`,
            producto_id: r.producto_id,
          });
        }

        reservasHechas.push(r);

        await registrarMovimientoStockReserva({
          producto_id: r.producto_id, deposito_id: r.deposito_id, tipo: 'reserva',
          cantidad: r.cantidad, referencia_id: pedidoNuevo.id,
          referencia: 'Confirmación pedido desde presupuesto', usuario_id: perfil.id,
        });
      }

      // Guardar referencia al pedido en el presupuesto
      await vincularPresupuestoConPedido(id, pedidoNuevo.id);

      // Auditoría: recién acá, después de que las dos compensaciones de
      // arriba (items, stock) ya pasaron sin error — no tiene sentido
      // auditar una fila que se va a borrar dos líneas más abajo si algo
      // falla antes de este punto.
      await AuditRepo.registrarAuditoriaSilenciosa(
        empresa_id, perfil.id, 'pedidos', 'INSERT', pedidoNuevo.id, null,
        { cliente_id: pres.cliente_id, presupuesto_id: id, estado: 'confirmado', total: presCompleto.total }
      );

      return res.json({ ok: true, estado: 'aceptado', pedido_id: pedidoNuevo.id });
    }

    patch.updated_at = new Date().toISOString();
    const { error: errPatch } = await actualizarPresupuesto(id, patch);

    if (errPatch) return errorSeguro(res, errPatch, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true, ...patch });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!esAdmin) return res.status(403).json({ error: 'Sin permisos' });
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    const pres = await obtenerPresupuestoParaEliminar(empresa_id, id);

    if (!pres) return res.status(404).json({ error: 'No encontrado' });
    if (pres.estado === 'aceptado')
      return res.status(400).json({ error: 'No se puede eliminar un presupuesto aceptado que generó un pedido' });

    await eliminarItemsPresupuesto(id);
    const { error } = await eliminarPresupuesto(id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ══════════════════════════════════════════════════════════════════════════
// ── Remito NRO (absorto desde api/remito-nro/index.js) ──────────────────
// ══════════════════════════════════════════════════════════════════════════
async function handleRemitoNro(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // ── Auth ──────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilParaRemitoNro(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'remitos'))
    return res.status(403).json({ error: 'Sin permisos' });

  const { pedido_id } = req.body;
  if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });

  // Verificar que el pedido pertenece a la empresa
  const ped = await obtenerPedidoParaRemitoNro(perfil.empresa_id, pedido_id);

  if (!ped) return res.status(404).json({ error: 'Pedido no encontrado' });

  // Llamar RPC que maneja la numeración atómica
  const { data: nro, error } = await reservarRemitoNroRpc(perfil.empresa_id, pedido_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  await AuditRepo.registrarAuditoriaSilenciosa(
    perfil.empresa_id, perfil.id, 'pedidos', 'UPDATE', pedido_id, null, { remito_nro: nro }
  );

  return res.json({ remito_nro: nro });
}

// ══════════════════════════════════════════════════════════════════════════
// ── /api/chofer/* — Portal del chofer (PWA de entrega)                  ──
// ══════════════════════════════════════════════════════════════════════════
//
// Rutas absorbidas desde vercel.json → _svc=chofer:
//   GET  /api/chofer/remitos          → remitos del día asignados al chofer
//   POST /api/chofer/remitos          → crear remito desde pedido confirmado
//   PATCH /api/chofer/remitos/:id/entregar → marcar entrega (con firma/foto)
//   GET  /api/chofer/clientes         → lista de clientes de la ruta del día
//   GET  /api/chofer/productos        → catálogo simplificado (para remitos manuales)

// FIX (CHOFER-001, auditoría 2026-07-26): el portal del chofer autorizaba
// por empresa_id, pero no verificaba que el pedido/remito consultado o
// operado perteneciera efectivamente a una ruta asignada a ESTE chofer.
// Cualquier usuario con rol 'chofer' de la empresa podía, con solo conocer
// (o probar secuencialmente) un pedido_id de un colega, ver domicilio/
// teléfono/coordenadas de un cliente ajeno a su reparto, marcar como
// "entregado" — con firma/foto/cobro incluidos — un pedido que reparte
// otro chofer, o marcarlo "no entregado" con un motivo fabricado. dueño/
// admin siguen sin esta restricción (operan cualquier remito de su empresa).
async function pedidoEsDeEsteChofer(pedido_id, chofer_id) {
  const data = await obtenerEntregaActivaDelPedido(pedido_id);
  return !!data && data.rutas?.chofer_id === chofer_id;
}

async function handleChofer(req, res) {
  // SEC-11: antes fijaba wildcard '*' acá, pisando la allowlist central de
  // orígenes con una política más abierta para este handler mutante en
  // particular. Bearer token reduce la explotación automática por navegador,
  // pero seguía siendo una superficie cross-origin innecesariamente abierta.
  applySecurityHeaders(res);
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Auth ──────────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilChofer(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'pedidos_chofer'))
    return res.status(403).json({ error: 'Acceso restringido al portal del chofer' });

  const empresa_id = perfil.empresa_id;
  const chofer_id  = perfil.id;
  const esAdmin    = ['dueno', 'admin'].includes(perfil.rol);

  // ── Router interno por _ruta param (inyectado desde vercel.json path) ─
  // La ruta original llega como req.query._ruta:
  //   /api/chofer/remitos              → _ruta = "remitos"
  //   /api/chofer/remitos/:id/entregar → _ruta = "entregar" + req.query.id
  //   /api/chofer/clientes             → _ruta = "clientes"
  //   /api/chofer/productos            → _ruta = "productos"
  const ruta = req.query._ruta || 'remitos';

  // ════════════════════════════════════
  // GET /api/chofer/remitos
  // ════════════════════════════════════
  if (ruta === 'remitos' && req.method === 'GET') {
    // FIX: antes usaba new Date().toISOString().slice(0,10) → calcula "hoy"
    // en UTC. El server (Vercel) corre en UTC y Argentina es UTC-3, así que
    // de 21:00 a 23:59 hora ART esto ya devolvía el día siguiente.
    const hoyArgentina = () =>
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const hoy   = req.query.fecha || hoyArgentina();
    const { id } = req.query;

    // Detalle de un remito específico
    if (id) {
      const { data, error } = await obtenerRemitoDetalle(empresa_id, id);

      if (error) return res.status(404).json({ error: 'Remito no encontrado' });

      // CHOFER-001: un chofer (no admin) solo puede ver el detalle de un
      // remito si tiene una entrega activa asignada en su propia ruta.
      if (!esAdmin && !(await pedidoEsDeEsteChofer(id, chofer_id)))
        return res.status(404).json({ error: 'Remito no encontrado' });

      // ruta_id de la entrega asociada — lo necesita el front del chofer
      // para mandar el GPS (accion=posicion) mientras reparte este pedido.
      // Se trae también el cobro (si hubo) para mostrarlo una vez entregado.
      const entregaDeEstePedido = await obtenerUltimaEntregaDelPedido(id);

      return res.json({
        ...data,
        numero_pedido: data.id.slice(0, 8).toUpperCase(),
        notas: data.notas_cliente,
        ruta_id: entregaDeEstePedido?.ruta_id || null,
        monto_cobrado: entregaDeEstePedido?.monto_cobrado ?? null,
        medio_cobro: entregaDeEstePedido?.medio_cobro ?? null,
      });
    }

    // FIX: la asignación real pedido↔chofer NO vive en pedidos.chofer_id
    // (ese campo no lo escribe ningún flujo de la app — confirmado, está
    // siempre en NULL salvo carga manual). El vínculo real es
    // rutas.chofer_id + entregas.pedido_id (ver frontend/admin/js/rutas.js,
    // confirmarRuta(): crea la ruta con chofer_id y las entregas con
    // pedido_id, pero nunca actualiza pedidos.chofer_id).
    const { data: rutasHoy, error: errRutas } = await listarRutasDelDia(empresa_id, hoy, esAdmin ? null : chofer_id);
    if (errRutas) return errorSeguro(res, errRutas, 500, 'No se pudo completar la operación.');

    const rutaIds = (rutasHoy || []).map(r => r.id);
    if (rutaIds.length === 0) return res.json({ remitos: [], fecha: hoy });

    const { data: entregasHoy, error: errEntregas } = await listarEntregasPorRutas(rutaIds);
    if (errEntregas) return errorSeguro(res, errEntregas, 500, 'No se pudo completar la operación.');

    const pedidoIds = [...new Set((entregasHoy || []).map(e => e.pedido_id))];
    if (pedidoIds.length === 0) return res.json({ remitos: [], fecha: hoy });

    // Mapa pedido_id → ruta_id (lo usa el front del chofer para mandar GPS)
    const rutaIdPorPedido = new Map((entregasHoy || []).map(e => [e.pedido_id, e.ruta_id]));

    const { data, error } = await listarPedidosParaRemitos(empresa_id, pedidoIds);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    const remitos = (data || []).map(r => ({
      ...r,
      numero_pedido: r.id.slice(0, 8).toUpperCase(),
      ruta_id: rutaIdPorPedido.get(r.id) || null,
    }));
    return res.json({ remitos, fecha: hoy, ruta_id: rutaIds[0] || null });
  }

  // ════════════════════════════════════
  // POST /api/chofer/remitos
  // Registrar nuevo remito manual
  // ════════════════════════════════════
  if (ruta === 'remitos' && req.method === 'POST') {
    const { pedido_id, notas_chofer, items_entregados } = req.body || {};
    if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });

    const pedido = await obtenerPedidoParaDespacho(empresa_id, pedido_id);

    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!['confirmado', 'preparando'].includes(pedido.estado))
      return res.status(400).json({ error: `Estado inválido para despacho: ${pedido.estado}` });

    // Marcar pedido como despachado y asignar chofer
    const { error: errPatch } = await marcarPedidoDespachado(pedido_id, { notas_chofer });

    if (errPatch) return errorSeguro(res, errPatch, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      empresa_id, chofer_id, 'pedidos', 'UPDATE', pedido_id,
      { estado: pedido.estado }, { estado: 'despachado', notas_chofer: notas_chofer || null }
    );

    // Si vienen items parciales, registrarlos
    if (Array.isArray(items_entregados) && items_entregados.length > 0) {
      const updates = items_entregados.map(({ item_id, cantidad_entregada }) =>
        actualizarCantidadItemPedido(item_id, cantidad_entregada, { pedido_id })
      );
      const resultados = await Promise.allSettled(updates);
      const fallosItems = resultados
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message || 'No se pudo actualizar un ítem');
      if (fallosItems.length) {
        return res.status(207).json({
          ok: false,
          parcial: true,
          pedido_id,
          estado: 'despachado',
          fallos: fallosItems,
          error: 'El despacho se registró, pero algunos ítems no pudieron actualizarse.',
        });
      }
    }

    return res.status(201).json({ ok: true, pedido_id, estado: 'despachado' });
  }

  // ════════════════════════════════════
  // PATCH /api/chofer/remitos → entregar
  // ════════════════════════════════════
  if (ruta === 'entregar' && req.method === 'PATCH') {
    const { id, firma_url, foto_url, notas_entrega, items_entregados, receptor, cobro, offline_local_id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });

    // Punto 6 (auditoría financiera 2026, "puntos críticos" fase A): resolver
    // y autorizar el pedido (empresa + pertenencia al chofer, CHOFER-001)
    // ANTES del fast-path de idempotencia — antes se validaba recién
    // después, así que un offline_local_id ajeno (ej. de otro chofer de la
    // misma empresa) podía disparar una respuesta de éxito sobre un pedido
    // que no le pertenece, sin pasar nunca por el chequeo CHOFER-001. Esto
    // NO valida el estado del pedido todavía (eso sigue yendo después del
    // fast-path, ver comentario abajo) — solo que el pedido existe en esta
    // empresa y que este chofer puede operarlo.
    const pedido = await obtenerPedidoParaEntrega(empresa_id, id);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!esAdmin && !(await pedidoEsDeEsteChofer(id, chofer_id)))
      return res.status(404).json({ error: 'Pedido no encontrado' });

    // Plan offline — Etapa 3: fast path de idempotencia. Si este
    // offline_local_id ya generó una fila en `entregas` (reintento del
    // outbox tras reconectar, o doble tap del chofer mientras la primera
    // request seguía en vuelo), devolver éxito sin reprocesar — clave para
    // no duplicar el cobro asociado (ver registrarCobroCompletoRpc abajo).
    // Va ANTES del chequeo de estado 'despachado' a propósito: en un
    // reintento el pedido ya va a estar 'entregado', y ese chequeo de
    // estado rechazaría el reintento como si fuera un error real. También
    // se exige que la entrega encontrada sea la de ESTE pedido_id (no solo
    // el mismo offline_local_id+empresa) — evita devolver "entregado" para
    // un id de pedido que no corresponde a esa entrega.
    if (offline_local_id) {
      const yaExiste = await buscarEntregaPorOfflineLocalId(empresa_id, offline_local_id);
      if (yaExiste && yaExiste.pedido_id === id) {
        return res.json({ ok: true, pedido_id: id, estado: 'entregado', offline_replay: true });
      }
    }

    if (pedido.estado !== 'despachado')
      return res.status(400).json({ error: 'El pedido no está despachado' });

    // ── Cobro contra entrega (auditoría UX v2 — brecha funcional real) ────
    // Opcional: el chofer puede registrar que cobró efectivo/transferencia/
    // cheque al momento de entregar. Se resuelve ANTES de marcar la entrega
    // como completada: si el cobro fue completado (monto ingresado) pero
    // falla, se corta acá y la entrega queda sin confirmar, para que el
    // chofer pueda corregir el monto/medio y reintentar sin perder la firma
    // ya subida (firma_url/foto_url ya están en Storage, no se pierden).
    let cobro_id = null;
    const montoCobro = cobro?.monto != null ? Number(cobro.monto) : null;
    if (cobro && (!Number.isFinite(montoCobro) || montoCobro <= 0)) {
      return res.status(400).json({ error: 'El monto del cobro debe ser un número positivo y válido.' });
    }
    const MEDIOS_COBRO_CHOFER = new Set(['efectivo', 'transferencia', 'cheque', 'otro']);
    if (cobro && !MEDIOS_COBRO_CHOFER.has(cobro.medio)) {
      return res.status(400).json({ error: 'Medio de cobro inválido.' });
    }
    if (montoCobro != null && montoCobro > 0) {
      if (!pedido.cliente_id)
        return res.status(400).json({ error: 'El pedido no tiene cliente asociado, no se puede registrar el cobro' });
      if (!cobro?.medio)
        return res.status(400).json({ error: 'Seleccioná el medio de pago del cobro' });

      const { data: rpcData, error: rpcError } = await registrarCobroCompletoRpc({
        p_empresa_id: empresa_id,
        p_cliente_id: pedido.cliente_id,
        p_usuario_id: chofer_id,
        p_monto:      montoCobro,
        p_medio:      cobro.medio,
        p_referencia: pedido.numero_pedido ? `Remito #${pedido.numero_pedido}` : null,
        p_notas:      cobro.notas || 'Cobro registrado por el chofer al confirmar la entrega',
        // Plan offline — Etapa 3: mismo offline_local_id que la entrega,
        // sufijado, para que un reintento del cobro (aunque el resto del
        // handler no haya llegado a guardar entregas.offline_local_id)
        // también sea idempotente — ver migración 442.
        p_offline_local_id: offline_local_id ? `${offline_local_id}-cobro` : null,
      });
      if (rpcError) return errorSeguro(res, rpcError, 500, 'No se pudo registrar el cobro.');
      if (rpcData && rpcData.ok === false)
        return res.status(400).json({ error: rpcData.error || 'No se pudo registrar el cobro' });

      cobro_id = rpcData.cobro_id;
    }

    const { error: errUpd } = await marcarPedidoEntregado(id, { notas_entrega });

    if (errUpd) return errorSeguro(res, errUpd, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      empresa_id, chofer_id, 'pedidos', 'UPDATE', id,
      { estado: pedido.estado }, { estado: 'entregado', notas_entrega: notas_entrega || null, cobro_id }
    );

    // Sincronizar entregas.estado para que el historial admin refleje la entrega.
    // FIX (auditoría etapa 6): antes este update no filtraba por estado, así
    // que si el pedido tenía más de una fila histórica en `entregas` (por
    // ejemplo, una entrega fallida anterior ya reprogramada), esto también
    // la marcaba como 'entregado' por error. Ahora solo toca la entrega
    // activa (pendiente/en_camino).
    const { data: entregaActualizada, error: entregaUpdateError } = await marcarEntregaCompletada(id, {
      estado:             'entregado',
      fecha_confirmacion: new Date().toISOString(),
      notas_entrega:      notas_entrega || null,
      firma_url:          firma_url     || null,
      foto_url:           foto_url      || null,
      receptor:           receptor      || null,
      monto_cobrado:      montoCobro    || null,
      medio_cobro:        montoCobro ? (cobro?.medio || null) : null,
      cobro_id:           cobro_id,
      offline_local_id:   offline_local_id || null,
    });

    if (entregaUpdateError || !entregaActualizada?.length) {
      return res.status(207).json({
        ok: false,
        parcial: true,
        pedido_id: id,
        estado: 'entregado',
        fallos: [{ paso: 'actualizar_entrega', error: entregaUpdateError?.message || 'No se encontró una entrega activa para actualizar.' }],
        error: 'El pedido se marcó entregado, pero no se pudo sincronizar la entrega activa.',
      });
    }

    // FIX (Matías): mantener rutas.estado sincronizado con las entregas reales
    // (ver sincronizarEstadoRuta más arriba). Best-effort: si falla, no debe
    // bloquear la confirmación de la entrega ya guardada.
    const ruta_id_entrega = entregaActualizada?.[0]?.ruta_id;
    if (ruta_id_entrega) {
      sincronizarEstadoRuta(ruta_id_entrega).catch(e =>
        console.error('[entregar] Error sincronizando rutas.estado:', e?.message || e));
    }

    if (Array.isArray(items_entregados) && items_entregados.length > 0) {
      const updates = items_entregados.map(({ item_id, cantidad_entregada }) =>
        actualizarCantidadItemPedido(item_id, cantidad_entregada, { pedido_id: id })
      );
      const resultados = await Promise.allSettled(updates);
      const fallosItems = resultados
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message || 'No se pudo actualizar un ítem');
      if (fallosItems.length) {
        return res.status(207).json({
          ok: false,
          parcial: true,
          pedido_id: id,
          estado: 'entregado',
          fallos: fallosItems,
          error: 'La entrega se registró, pero algunos ítems no pudieron actualizarse.',
        });
      }
    }

    return res.json({ ok: true, pedido_id: id, estado: 'entregado' });
  }

  // ════════════════════════════════════
  // PATCH /api/chofer/remitos → no-entregar
  // ════════════════════════════════════
  //
  // FIX (auditoría etapa 6 — Hallazgo 1): el flujo de "no se pudo entregar"
  // estaba documentado (docs/ayuda/rutas-y-entregas.md), tenía columna en
  // la BD (pedidos.motivo_no_entrega desde la migración 006), template de
  // WhatsApp (notif.js: pedido_no_entregado) y el admin ya mostraba
  // entregas.estado='no_entregado' en rutas.js — pero no existía ningún
  // botón ni endpoint alcanzable por el chofer para generarlo. La única
  // función relacionada (manejarNoEntregado en notif.js) no tenía ningún
  // caller en todo el repo y, además, marcaba el pedido como 'cancelado'
  // en vez de dejarlo disponible para reprogramar como dice la
  // documentación. Ese bug se corrige aparte, en notif.js.
  if (ruta === 'no-entregar' && req.method === 'PATCH') {
    const MOTIVOS_NO_ENTREGA = ['nadie_en_casa', 'rechazo', 'direccion_incorrecta', 'otro'];
    // Mismo diccionario que usa notif.js para armar el mensaje de WhatsApp.
    const MOTIVOS_LABEL = {
      nadie_en_casa:        'nadie en casa al momento de la entrega',
      rechazo:              'el cliente rechazó la mercadería',
      direccion_incorrecta: 'la dirección no fue encontrada',
      otro:                 'inconveniente en la entrega',
    };

    const { id, motivo, notas, foto_url, offline_local_id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });
    if (!motivo || !MOTIVOS_NO_ENTREGA.includes(motivo))
      return res.status(400).json({ error: 'Motivo inválido' });

    // Punto 6: mismo criterio que en "entregar" — resolver y autorizar el
    // pedido (empresa + CHOFER-001) antes del fast-path de idempotencia.
    const pedido = await obtenerPedidoParaEntrega(empresa_id, id);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!esAdmin && !(await pedidoEsDeEsteChofer(id, chofer_id)))
      return res.status(404).json({ error: 'Pedido no encontrado' });

    // Plan offline — Etapa 3: mismo fast path de idempotencia que en
    // "entregar" — ver el comentario de ahí. También exige que la entrega
    // encontrada sea la de este pedido_id.
    if (offline_local_id) {
      const yaExiste = await buscarEntregaPorOfflineLocalId(empresa_id, offline_local_id);
      if (yaExiste && yaExiste.pedido_id === id) {
        return res.json({ ok: true, pedido_id: id, estado: 'confirmado', offline_replay: true });
      }
    }

    if (pedido.estado !== 'despachado')
      return res.status(400).json({ error: 'El pedido no está despachado' });

    // 1. Marcar la entrega activa (acotado a pendiente/en_camino — nunca un
    //    update ciego por pedido_id, mismo criterio que el fix de arriba).
    const { data: entregaNoRealizada, error: errEnt } = await marcarEntregaNoRealizada(id, {
      estado:              'no_entregado',
      fecha_confirmacion:  new Date().toISOString(),
      notas_entrega:       notas || null,
      foto_url:            foto_url || null,
      motivo_no_entrega:   motivo,
      offline_local_id:    offline_local_id || null,
    });

    if (errEnt) return errorSeguro(res, errEnt, 500, 'No se pudo completar la operación.');

    // FIX (Matías): mismo sync de rutas.estado que en el handler "entregar" —
    // un "no entregado" también es un estado terminal para la entrega y debe
    // poder cerrar la ruta si es la última pendiente.
    const ruta_id_no_entrega = entregaNoRealizada?.[0]?.ruta_id;
    if (ruta_id_no_entrega) {
      sincronizarEstadoRuta(ruta_id_no_entrega).catch(e =>
        console.error('[no-entregar] Error sincronizando rutas.estado:', e?.message || e));
    }

    // 2. El pedido vuelve a 'confirmado' — queda disponible para una
    //    próxima ruta, tal como está documentado ("el pedido queda
    //    disponible para reprogramar en una próxima ruta").
    const { error: errPed } = await revertirPedidoAConfirmado(id, {
      notas_internas: `[No entregado] ${MOTIVOS_LABEL[motivo]}${notas ? ' — ' + notas : ''}`,
    });

    if (errPed) return errorSeguro(res, errPed, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      empresa_id, chofer_id, 'pedidos', 'UPDATE', id,
      { estado: pedido.estado }, { estado: 'confirmado', motivo_no_entrega: motivo }
    );

    // 3. Notificar al cliente por WhatsApp (best-effort, no bloquea la
    //    respuesta al chofer si el envío falla).
    if (process.env.INTERNAL_API_KEY) {
      const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${base}/api/notif/notif-entrega`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY },
        body:    JSON.stringify({ evento: 'entrega_no_realizada', pedido_id: id, motivo, empresa_id }),
      }).catch(e => console.error('[no-entregar] Error notificando al cliente:', e?.message || e));
    }

    return res.json({ ok: true, pedido_id: id, estado: 'confirmado' });
  }

  // ════════════════════════════════════
  // GET /api/chofer/clientes
  // Clientes de la ruta del día
  // ════════════════════════════════════
  if (ruta === 'clientes' && req.method === 'GET') {
    const hoy = new Date().toISOString().slice(0, 10);

    let pedidoIdsPropios = null;
    // CHOFER-001: antes esto devolvía TODOS los clientes con pedidos activos
    // hoy en la empresa (domicilio, teléfono, coordenadas) a cualquier
    // chofer, sin importar si el pedido estaba en su ruta o en la de otro.
    if (!esAdmin) {
      const { data: rutasHoyChofer } = await listarRutasDelDia(empresa_id, hoy, chofer_id);
      const rutaIdsChofer = (rutasHoyChofer || []).map(r => r.id);
      if (rutaIdsChofer.length === 0) return res.json({ clientes: [] });

      const { data: entregasChofer } = await listarEntregasPorRutas(rutaIdsChofer);
      pedidoIdsPropios = [...new Set((entregasChofer || []).map(e => e.pedido_id))];
      if (pedidoIdsPropios.length === 0) return res.json({ clientes: [] });
    }

    // Obtener clientes que tienen pedidos activos hoy
    const { data, error } = await listarClientesConPedidosActivos(empresa_id, hoy, pedidoIdsPropios);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // Deduplicar clientes
    const seen = new Set();
    const clientes = (data || [])
      .map(p => p.clientes)
      .filter(c => c && !seen.has(c.id) && seen.add(c.id));

    return res.json({ clientes });
  }

  // ════════════════════════════════════
  // GET /api/chofer/productos
  // Catálogo simplificado para remitos manuales
  // ════════════════════════════════════
  if (ruta === 'productos' && req.method === 'GET') {
    const { q: busqueda } = req.query;

    let data;
    try {
      data = await buscarProductosParaRemito(empresa_id, { busqueda });
    } catch (error) {
      return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    }
    return res.json({ productos: data || [] });
  }

  // ════════════════════════════════════
  // POST /api/chofer/entrega-foto
  // Etapa 1 (Logística): "firma digital / foto de conformidad en la
  // entrega". Sube al bucket 'remitos' (ya existía desde la Etapa 8.3 pero
  // nunca se había conectado ningún endpoint). Sirve tanto para la firma
  // (dataURL exportado de un <canvas>) como para la foto de conformidad
  // (misma validación que devolucion-foto). Devuelve la url pública para
  // pasarla luego como firma_url/foto_url en PATCH /api/chofer/remitos/:id/entregar,
  // que ya acepta ambos campos desde hace tiempo.
  // ════════════════════════════════════
  if (ruta === 'entrega-foto' && req.method === 'POST') {
    const { imagen_base64, tipo: tipoImagen } = req.body || {};
    if (!imagen_base64 || typeof imagen_base64 !== 'string')
      return res.status(400).json({ error: 'imagen_base64 requerida' });
    if (!['firma', 'foto'].includes(tipoImagen))
      return res.status(400).json({ error: 'tipo debe ser "firma" o "foto"' });

    const match = imagen_base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato de imagen inválido' });

    const mime = `image/${match[1].toLowerCase()}`;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      return res.status(400).json({ error: 'Solo se permiten imágenes JPEG, PNG o WebP' });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
    const buffer = Buffer.from(match[2], 'base64');
    if (!validarImagenReal(buffer, mime))
      return res.status(400).json({ error: 'El contenido no coincide con el tipo de imagen declarado' });

    const MAX_BYTES = 8 * 1024 * 1024; // 8MB, mismo límite que devolucion-foto
    if (buffer.length > MAX_BYTES)
      return res.status(400).json({ error: 'La imagen no puede superar 8MB' });

    const path = `${empresa_id}/${chofer_id}/${tipoImagen}-${Date.now()}.${ext}`;

    const { error: errUpload } = await supabase.storage
      .from('remitos')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (errUpload) return errorSeguro(res, errUpload, 500, 'No se pudo completar la operación.');

    // SEC-05: bucket 'remitos' privado. Se devuelve el path — el cliente lo
    // reenvía tal cual en PATCH /entregar como firma_url/foto_url, y recién
    // se firma al leer (ver lib/utils/storage-urls.js). El cliente no
    // renderiza esto directo, solo lo reenvía.
    return res.status(201).json({ ok: true, url: path, tipo: tipoImagen });
  }

  // ════════════════════════════════════
  // POST /api/chofer/devolucion-foto
  // Sube la foto de una devolución al bucket 'devoluciones' usando el
  // service role (el bucket solo permite INSERT vía service_role, el chofer
  // no puede subir directo con su JWT). Recibe base64, devuelve foto_url
  // pública para pasarle luego a POST /api/chofer/devolucion.
  // ════════════════════════════════════
  if (ruta === 'devolucion-foto' && req.method === 'POST') {
    const { foto_base64 } = req.body || {};
    if (!foto_base64 || typeof foto_base64 !== 'string')
      return res.status(400).json({ error: 'foto_base64 requerida' });

    const match = foto_base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato de imagen inválido' });

    const mime = `image/${match[1].toLowerCase()}`;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      return res.status(400).json({ error: 'Solo se permiten imágenes JPEG, PNG o WebP' });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
    const buffer = Buffer.from(match[2], 'base64');
    if (!validarImagenReal(buffer, mime))
      return res.status(400).json({ error: 'El contenido no coincide con el tipo de imagen declarado' });

    const MAX_BYTES = 8 * 1024 * 1024; // 8MB, mismo límite que valida el front
    if (buffer.length > MAX_BYTES)
      return res.status(400).json({ error: 'La imagen no puede superar 8MB' });

    const path = `${empresa_id}/${chofer_id}/${Date.now()}.${ext}`;

    const { error: errUpload } = await supabase.storage
      .from('devoluciones')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (errUpload) return errorSeguro(res, errUpload, 500, 'No se pudo completar la operación.');

    // SEC-05: bucket 'devoluciones' privado. Se devuelve el path — el
    // chofer lo reenvía tal cual en POST /devolucion, sin renderizarlo.
    return res.status(201).json({ ok: true, foto_url: path });
  }

  // ════════════════════════════════════
  // POST /api/chofer/devolucion
  // Registra una devolución con foto + items. Si motivo='producto_defectuoso',
  // genera automáticamente notas_debito_proveedor agrupadas por proveedor
  // (Innovación #2).
  // ════════════════════════════════════
  if (ruta === 'devolucion' && req.method === 'POST') {
    // CHOFER-001: si la devolución viene atada a un pedido_id, un chofer
    // (no admin) solo puede registrarla contra un pedido de su propia ruta
    // — evita notas de débito a proveedor y recalculos de score disparados
    // sobre clientes/pedidos ajenos.
    const pedidoIdBody = req.body?.pedido_id;
    if (!esAdmin && pedidoIdBody && !(await pedidoEsDeEsteChofer(pedidoIdBody, chofer_id)))
      return res.status(404).json({ error: 'Pedido no encontrado' });

    const resultado = await crearDevolucionCore({ empresa_id, chofer_id, body: req.body || {} });
    if (!resultado.ok) return res.status(resultado.status || 400).json({ error: resultado.error });
    return res.status(201).json(resultado.payload);
  }

  return res.status(405).json({ error: 'Método o ruta no soportado en /api/chofer' });
}

// ─── Lógica compartida de alta de devolución ───────────────────────────────
// Usada tanto por el chofer (POST /api/chofer/devolucion) como por el admin
// (POST /api/admin/devoluciones — alta manual, sin pasar por la app del
// chofer). `creado_por_id` es el chofer_id en el caso del chofer, o el id
// del usuario admin en el caso de alta manual (la columna `chofer_id` de la
// tabla acepta cualquier usuario, no valida rol).
async function crearDevolucionCore({ empresa_id, chofer_id: creado_por_id, body }) {
  const MOTIVOS_VALIDOS = ['producto_defectuoso', 'error_pedido', 'cliente_arrepentido', 'vencido', 'otro'];
  const { pedido_id, motivo, notas, foto_url, offline_local_id } = body;
  const items = Array.isArray(body.items) ? body.items : [];

  if (!motivo || !MOTIVOS_VALIDOS.includes(motivo))
    return { ok: false, status: 400, error: 'Motivo inválido' };
  if (!items.length)
    return { ok: false, status: 400, error: 'La devolución necesita al menos un ítem' };

  // Plan offline — Etapa 3: fast path de idempotencia, mismo criterio que
  // "entregar"/"no-entregar". Acá el reintento es más barato de detectar
  // porque no hay ningún chequeo de estado previo que lo bloquee antes de
  // llegar a esta función — el riesgo real es reprocesar la nota de débito
  // automática y la notificación al admin.
  if (offline_local_id) {
    const yaExiste = await buscarDevolucionPorOfflineLocalId(empresa_id, offline_local_id);
    if (yaExiste) {
      return {
        ok: true,
        payload: {
          ok: true,
          devolucion: yaExiste,
          notas_debito: [],
          items_sin_proveedor_default: [],
          offline_replay: true,
        },
      };
    }
  }

  // Resolver cliente_id: desde el body o desde el pedido
  let cliente_id = body.cliente_id || null;
  if (!cliente_id && pedido_id) {
    const ped = await obtenerClienteIdDePedido(empresa_id, pedido_id);
    cliente_id = ped?.cliente_id || null;
  }
  if (!cliente_id) return { ok: false, status: 400, error: 'cliente_id requerido (directo o vía pedido_id)' };

  // FIX v800: el alta manual dejaba registrar devoluciones de cualquier
  // producto activo de la empresa, sin chequear que el cliente lo haya
  // comprado alguna vez — generaba notas de crédito al cliente y notas de
  // débito al proveedor sobre mercadería que nunca circuló.
  //
  // FIX v805 (auditoría 2026-08-17, caso real: se aprobó una devolución de
  // 4.555 u. de un producto del que el cliente compró 42 u. en total, vinculada
  // a un pedido que ni siquiera lo incluía — impactó stock y generó una NC de
  // ~$9,86M antes de detectarse). v800 solo validaba existencia ("¿lo compró
  // alguna vez?"), no cantidad ni el pedido vinculado. Ahora se valida:
  //   1. cantidad ≤ comprado histórico − ya reservado en otras devoluciones
  //      no rechazadas (pendiente/aprobada) del mismo producto+cliente.
  //   2. si viene pedido_id, el producto tiene que pertenecer a ESE pedido.
  //   3. precio_unitario se recalcula acá, server-side, a partir del pedido
  //      vinculado (si lo hay) o del precio_base actual del producto — nunca
  //      se usa lo que mande el body, que alimentaba directo el monto de la
  //      nota de crédito/débito sin ningún cruce contra lo realmente vendido.
  const [comprados, yaReservado, itemsPedido] = await Promise.all([
    obtenerComprasPorProductoCliente(empresa_id, cliente_id),
    obtenerDevueltoPorProductoCliente(empresa_id, cliente_id),
    pedido_id ? obtenerItemsDePedido(empresa_id, pedido_id) : Promise.resolve(new Map()),
  ]);

  // Si viene vinculada a un pedido puntual, el producto tiene que estar en ESE pedido.
  if (pedido_id) {
    const fueraDePedido = items.filter(it => !itemsPedido.has(it.producto_id));
    if (fueraDePedido.length) {
      return {
        ok: false, status: 400,
        error: `${fueraDePedido.length} producto(s) de la devolución no pertenecen al pedido seleccionado.`,
      };
    }
  }

  // Cantidad solicitada por producto en ESTA devolución (puede venir repetido)
  const solicitadoPorProducto = new Map();
  for (const it of items) {
    const cant = +it.cantidad || 0;
    solicitadoPorProducto.set(it.producto_id, (solicitadoPorProducto.get(it.producto_id) || 0) + cant);
  }

  for (const [producto_id, cantidadSolicitada] of solicitadoPorProducto.entries()) {
    if (cantidadSolicitada <= 0) {
      return { ok: false, status: 400, error: 'La cantidad devuelta tiene que ser mayor a 0.' };
    }
    const totalComprado = comprados.get(producto_id) || 0;
    if (totalComprado === 0) {
      return {
        ok: false, status: 400,
        error: 'Este cliente nunca compró uno de los producto(s) seleccionados. Elegí un producto de su historial de compras.',
      };
    }
    const disponible = totalComprado - (yaReservado.get(producto_id) || 0);
    if (cantidadSolicitada > disponible) {
      return {
        ok: false, status: 400,
        error: `Cantidad a devolver (${cantidadSolicitada}) supera lo disponible para devolver de ese producto (${Math.max(disponible, 0)} — sobre ${totalComprado} comprados en total).`,
      };
    }
  }

  // Precio server-side: el del pedido vinculado si el producto está ahí,
  // si no el precio_base actual del producto. Nunca el del body.
  const precioBase = await obtenerPreciosBaseProductos(empresa_id, [...solicitadoPorProducto.keys()]);
  for (const it of items) {
    const delPedido = itemsPedido.get(it.producto_id);
    it.precio_unitario = delPedido ? delPedido.precio_unitario : (precioBase.get(it.producto_id) || 0);
  }

  // 1. Insertar devolución
  const { data: devolucion, error: errDev } = await crearDevolucion({
    empresa_id, pedido_id: pedido_id || null, cliente_id,
    chofer_id: creado_por_id, motivo, notas: notas || null,
    foto_url: foto_url || null, estado: 'pendiente',
    offline_local_id: offline_local_id || null,
  });

  if (errDev) return { ok: false, status: 500, error: 'No se pudo completar la operación.' };

  // 2. Insertar items
  const itemsPayload = items.map(it => ({
    devolucion_id: devolucion.id,
    producto_id: it.producto_id,
    cantidad: it.cantidad,
    precio_unitario: it.precio_unitario || 0,
  }));
  const { error: errItems } = await insertarItemsDevolucion(itemsPayload);
  if (errItems) {
    const { error: rollbackError } = await eliminarDevolucion(empresa_id, devolucion.id);
    return {
      ok: false,
      status: 500,
      error: rollbackError
        ? 'Falló la inserción de ítems y también la compensación de la cabecera; requiere revisión manual.'
        : 'Falló la inserción de ítems; la cabecera fue compensada.',
      codigo: rollbackError ? 'devolucion_compensacion_pendiente' : 'devolucion_compensada',
    };
  }

  // 3. Si es producto defectuoso: nota de débito automática al proveedor,
  //    agrupada por producto.proveedor_id_default
  let notasDebitoCreadas = [];
  // Migración 193: antes este array no existía y los ítems sin
  // proveedor_id_default se descartaban en silencio (ver
  // v_productos_sin_proveedor_default para el gap de datos subyacente).
  let itemsSinProveedorDefault = [];
  if (motivo === 'producto_defectuoso') {
    const productoIds = [...new Set(items.map(it => it.producto_id))];
    const productos = await obtenerProveedorDefaultPorProductos(productoIds);

    const proveedorPorProducto = new Map((productos || []).map(p => [p.id, p.proveedor_id_default]));
    const nombrePorProducto = new Map((productos || []).map(p => [p.id, p.nombre]));
    const montoPorProveedor = new Map();

    for (const it of items) {
      const proveedor_id = proveedorPorProducto.get(it.producto_id);
      if (!proveedor_id) {
        // Sin proveedor por defecto -> queda para manejo manual, pero ahora
        // se reporta explícitamente en vez de descartarse en silencio.
        itemsSinProveedorDefault.push({
          producto_id: it.producto_id,
          nombre: nombrePorProducto.get(it.producto_id) || null,
          cantidad: it.cantidad,
        });
        continue;
      }
      const monto = (+it.cantidad || 0) * (+it.precio_unitario || 0);
      montoPorProveedor.set(proveedor_id, (montoPorProveedor.get(proveedor_id) || 0) + monto);
    }

    for (const [proveedor_id, monto] of montoPorProveedor.entries()) {
      const nd = await crearNotaDebitoProveedor({
        empresa_id, proveedor_id, devolucion_id: devolucion.id,
        motivo: `Producto defectuoso — devolución de cliente (ref. ${devolucion.id.slice(0, 8)})`,
        monto, estado: 'pendiente',
      });
      if (nd) notasDebitoCreadas.push(nd);
    }
  }

  // 4. Recalcular score del cliente ahora (best-effort, no bloquea la respuesta)
  calcularScoreClienteRpc({
    p_cliente_id: cliente_id, p_empresa_id: empresa_id, p_motivo: 'devolucion_registrada',
  }).then(() => {}).catch(() => {});

  // 5. Notificar al admin
  await notifAuto(empresa_id, {
    tipo: 'cierre_error_cola',
    titulo: 'Devolución registrada',
    cuerpo: `Devolución pendiente de revisión (motivo: ${motivo}).`,
    link: '/admin/devoluciones',
  });

  // Migración 193: si hubo producto_defectuoso con ítems sin proveedor
  // por defecto, avisar aparte -- antes esto no generaba ninguna señal.
  if (itemsSinProveedorDefault.length) {
    await notifAuto(empresa_id, {
      tipo: 'cierre_error_cola',
      titulo: '⚠ Nota de débito no generada',
      cuerpo: `${itemsSinProveedorDefault.length} ítem(s) de la devolución no generaron nota de débito automática por falta de proveedor por defecto en el producto. Revisar en /admin/productos.`,
      link: '/admin/devoluciones',
    });
  }

  return {
    ok: true,
    payload: {
      ok: true,
      devolucion,
      notas_debito: notasDebitoCreadas,
      items_sin_proveedor_default: itemsSinProveedorDefault,
    },
  };
}

// ─── Admin: gestión de devoluciones (Innovación #2) ────────────────────────
//
// GET   ?accion=listar    → lista de devoluciones (filtros: estado, motivo, q, page, limit)
// GET   ?accion=kpis      → conteos globales por estado (pendientes/aprobadas/rechazadas)
// GET   ?id=uuid           → detalle con items + notas de débito asociadas
// PATCH ?accion=revisar    → { id, estado: 'aprobada'|'rechazada' }
async function handleDevolucionesAdmin(req, res) {
  // SEC-11: mismo fix que handleChofer — wildcard reemplazado por la
  // allowlist central (ver comentario ahí).
  applySecurityHeaders(res);
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilParaDevolucionesAdmin(user.id);
  if (!perfil || !puede(perfil, 'leer', 'devoluciones'))
    return res.status(403).json({ error: 'Sin permisos para consultar devoluciones' });

  const empresa_id = perfil.empresa_id;
  const { id, accion } = req.query;

  // ── Subir foto (para adjuntar a un alta manual) ──────────────────────
  // Mismo bucket 'devoluciones' que usa el chofer; el admin tampoco puede
  // subir directo con su JWT (el bucket solo permite INSERT vía service_role).
  if (req.method === 'POST' && accion === 'foto') {
    const { foto_base64 } = req.body || {};
    if (!foto_base64 || typeof foto_base64 !== 'string')
      return res.status(400).json({ error: 'foto_base64 requerida' });

    const match = foto_base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato de imagen inválido' });

    const mime = `image/${match[1].toLowerCase()}`;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      return res.status(400).json({ error: 'Solo se permiten imágenes JPEG, PNG o WebP' });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
    const buffer = Buffer.from(match[2], 'base64');
    if (!validarImagenReal(buffer, mime))
      return res.status(400).json({ error: 'El contenido no coincide con el tipo de imagen declarado' });

    const MAX_BYTES = 8 * 1024 * 1024;
    if (buffer.length > MAX_BYTES)
      return res.status(400).json({ error: 'La imagen no puede superar 8MB' });

    const path = `${empresa_id}/admin-${user.id}/${Date.now()}.${ext}`;
    const { error: errUpload } = await supabase.storage
      .from('devoluciones')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (errUpload) return errorSeguro(res, errUpload, 500, 'No se pudo completar la operación.');

    // SEC-05: bucket 'devoluciones' privado. Se devuelve el path — el alta
    // manual no muestra preview antes de guardar, solo lo reenvía en el
    // POST de creación (ver ndSubirFotoSiCorresponde en el frontend).
    return res.status(201).json({ ok: true, foto_url: path });
  }

  // ── Crear (alta manual desde el admin, sin pasar por la app del chofer) ──
  if (req.method === 'POST' && !accion) {
    if (!puede(perfil, 'crear', 'devoluciones')) return res.status(403).json({ error: 'Sin permiso para crear devoluciones' });
    const resultado = await crearDevolucionCore({ empresa_id, chofer_id: user.id, body: req.body || {} });
    if (!resultado.ok) return res.status(resultado.status || 400).json({ error: resultado.error });
    return res.status(201).json(resultado.payload);
  }

  // ── Editar notas (en cualquier momento, no solo al revisar) ─────────────
  if (req.method === 'PATCH' && accion === 'notas') {
    if (!puede(perfil, 'editar', 'devoluciones')) return res.status(403).json({ error: 'Sin permiso para editar devoluciones' });
    const { id: devId, notas } = req.body || {};
    if (!devId) return res.status(400).json({ error: 'id requerido' });
    const { data, error } = await actualizarNotasDevolucion(empresa_id, devId, notas);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true, devolucion: data });
  }

  // ── Eliminar (solo devoluciones pendientes — una vez revisada queda
  //    como registro histórico, no se borra) ───────────────────────────
  if (req.method === 'DELETE' && id) {
    if (!puede(perfil, 'eliminar', 'devoluciones')) return res.status(403).json({ error: 'Sin permiso para eliminar devoluciones' });
    const existente = await obtenerDevolucionParaEliminar(empresa_id, id);
    if (!existente) return res.status(404).json({ error: 'Devolución no encontrada' });
    if (existente.estado !== 'pendiente')
      return res.status(400).json({ error: 'Solo se pueden eliminar devoluciones pendientes de revisión' });

    // Las notas de débito automáticas que se hayan generado al crearla
    // (motivo producto_defectuoso) quedan huérfanas si no se anulan.
    await anularNotasDebitoDeDevolucion(id);

    // devolucion_items se borra en cascada (ON DELETE CASCADE, ver 006_logistica.sql)
    const { error } = await eliminarDevolucion(empresa_id, id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true });
  }

  // ── Detalle ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && id) {
    const { data: devolucion, error } = await obtenerDevolucionDetalle(empresa_id, id);

    if (error) return res.status(404).json({ error: 'Devolución no encontrada' });

    const notasDebito = await listarNotasDebitoDeDevolucion(id);
    const devolucionConUrl = await firmarCampoUrl(supabase, 'devoluciones', devolucion, 'foto_url');

    return res.json({ ...devolucionConUrl, notas_debito: notasDebito || [] });
  }

  // ── KPIs (conteos globales por estado, independientes del filtro/página) ──
  if (req.method === 'GET' && accion === 'kpis') {
    const [pendientes, aprobadas, rechazadas] = await Promise.all([
      contarDevolucionesPorEstado(empresa_id, 'pendiente'),
      contarDevolucionesPorEstado(empresa_id, 'aprobada'),
      contarDevolucionesPorEstado(empresa_id, 'rechazada'),
    ]);
    return res.json({ pendientes, aprobadas, rechazadas });
  }

  // ── Listar ────────────────────────────────────────────────────────────
  // FIX (continuación AUDITORIA_FILTROS_v280 §5): antes traía hasta 200
  // devoluciones sin filtro de búsqueda/motivo server-side (solo `estado`
  // estaba soportado en el backend, pero el frontend ni lo mandaba —
  // filtraba las 3 columnas con Array.filter() en el navegador sobre el
  // recorte fijo, sin debounce en el buscador). Volumen actual: 0 filas
  // en jgiquzjwoedmzwqgzubr (confirmado), pero se corrige por consistencia
  // con el resto de los módulos ya migrados.
  if (req.method === 'GET') {
    const { estado, motivo, q: busqueda, fecha_desde, fecha_hasta, pedido_id } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 50));
    const desde = (page - 1) * limit;
    const hasta = desde + limit - 1;

    const { data, error, count } = await listarDevolucionesFiltradas({
      empresa_id, estado, motivo, busqueda, fecha_desde, fecha_hasta, desde, hasta, pedido_id,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    const devoluciones = await firmarCampoUrlEnLista(supabase, 'devoluciones', data || [], 'foto_url');
    return res.json({ devoluciones, total: count ?? 0, page, limit });
  }

  // ── Revisar (aprobar / rechazar) ─────────────────────────────────────
  //
  // FIX (auditoría etapa 9 — módulos): la página decía explícitamente
  // "decidí si repone stock o genera nota de crédito" pero ninguna de las
  // dos cosas existía en el código — aprobar una devolución solo cambiaba
  // el estado y (si el motivo era producto_defectuoso) dejaba la nota de
  // débito al proveedor como estaba. El cliente que devolvía mercadería no
  // recibía nunca stock repuesto ni crédito; había que hacerlo a mano y sin
  // ningún vínculo con la devolución de origen. Ahora el admin puede tildar
  // una o ambas opciones al aprobar.
  if (req.method === 'PATCH' && accion === 'revisar') {
    if (!puede(perfil, 'revisar', 'devoluciones'))
      return res.status(403).json({ error: 'Sin permiso para revisar devoluciones' });

    const { id: devId, estado, reponer_stock, generar_nc, deposito_id, items_reponer } = req.body || {};
    if (!devId || !['aprobada', 'rechazada'].includes(estado))
      return res.status(400).json({ error: 'id y estado (aprobada|rechazada) requeridos' });

    const { data: devolucion, error } = await actualizarEstadoDevolucion(empresa_id, devId, estado);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // FIX v804: data=null significa que el UPDATE no matcheó ninguna fila
    // porque la devolución ya no estaba en 'pendiente' (ya fue revisada antes
    // — típico de un reintento del front tras un error transitorio). Cortar
    // acá evita reponer stock y generar la nota de crédito por segunda vez.
    if (!devolucion) {
      const { data: actual } = await obtenerDevolucionDetalle(empresa_id, devId);
      const actualConUrl = await firmarCampoUrl(supabase, 'devoluciones', actual, 'foto_url');
      return res.status(409).json({
        error: actual
          ? `Esta devolución ya fue revisada (estado actual: ${actual.estado}). No se volvió a procesar.`
          : 'Devolución no encontrada.',
        devolucion: actualConUrl || null,
      });
    }

    // Si se rechaza, anular las notas de débito vinculadas (el producto
    // no resultó defectuoso según revisión admin -> no corresponde el débito)
    if (estado === 'rechazada') {
      await anularNotasDebitoDeDevolucion(devId);
    }

    const resultado = { ok: true, devolucion, stock_repuesto: [], stock_errores: [], nota_credito: null };

    // ── Reponer stock (solo si se aprueba y el admin lo pidió) ──────────
    if (estado === 'aprobada' && reponer_stock) {
      // Reposición parcial: si el admin destildó algún ítem en el panel,
      // items_reponer trae solo los ids de devolucion_items a reponer.
      const items = await listarItemsDevolucionParaReponer(devId, items_reponer);

      // Depósito elegido por el admin en el panel; si no mandó ninguno,
      // cae al principal (comportamiento previo, retrocompatible).
      const deposito = deposito_id
        ? await obtenerDepositoPorId(empresa_id, deposito_id)
        : await obtenerDepositoPrincipal(empresa_id);

      if (!deposito) {
        resultado.stock_errores.push('No se encontró el depósito destino — no se pudo reponer el stock.');
      } else {
        for (const it of (items || [])) {
          const { data: rpcResult, error: rpcError } = await ajustarStockRpc({
            p_producto_id: it.producto_id,
            p_deposito_id: deposito.id,
            p_delta: it.cantidad,
            p_tipo: 'ingreso',
            p_motivo: `Reposición por devolución aprobada (ref. ${devId.slice(0, 8)})`,
            p_notas: null,
            p_usuario_id: user.id,
          });
          if (rpcError || !rpcResult?.ok) {
            const mensaje = rpcError?.message || rpcResult?.error || 'error desconocido';
            await marcarItemDevolucionError(it.id, mensaje);
            resultado.stock_errores.push(`Producto ${it.producto_id}: ${mensaje}`);
          } else {
            const { error: marcaError } = await marcarItemDevolucionRepuesto(it.id, deposito.id);
            if (marcaError) {
              resultado.stock_errores.push(`Producto ${it.producto_id}: el stock se repuso, pero no se pudo marcar el ítem como procesado (${marcaError.message})`);
            } else {
              resultado.stock_repuesto.push({ producto_id: it.producto_id, cantidad: it.cantidad });
            }
          }
        }
      }
    }

    // ── Generar nota de crédito pendiente (solo si se aprueba y el admin
    //    lo pidió) — queda en estado 'pendiente', igual que una NC manual;
    //    la emisión real contra ARCA se hace desde el panel de Notas de
    //    Crédito, como con cualquier otra NC.
    if (estado === 'aprobada' && generar_nc && devolucion?.cliente_id) {
      const items = await listarItemsDevolucionConProducto(devId);

      const itemsNC = (items || [])
        .filter(it => it.cantidad > 0)
        .map(it => ({
          descripcion: it.productos?.nombre || 'Producto devuelto',
          cantidad: it.cantidad,
          precio_unitario: it.precio_unitario || 0,
        }))
        .filter(it => it.precio_unitario > 0);

      if (!itemsNC.length) {
        resultado.stock_errores.push('La devolución no tiene ítems con precio > 0 — no se generó la NC.');
      } else {
        const cliente = await obtenerClienteCondicionIva(devolucion.cliente_id);
        const tipoNC = cliente?.condicion_iva === 'responsable_inscripto' ? 'A' : 'B';

        // factura asociada: la más reciente del mismo pedido, si existe
        let factura_id = null;
        if (devolucion.pedido_id) {
          const fact = await obtenerFacturaRecienteDePedido(devolucion.pedido_id);
          factura_id = fact?.id || null;
        }

        const { data: nc, error: errNC } = await crearNotaCreditoRpc({
          p_empresa_id: empresa_id,
          p_cliente_id: devolucion.cliente_id,
          p_tipo:       tipoNC,
          p_motivo:     `Devolución aprobada (ref. ${devId.slice(0, 8)}) — ${devolucion.motivo}`,
          p_items:      itemsNC,
          p_factura_id: factura_id,
          p_created_by: user.id,
        });

        if (errNC || nc?.ok === false) {
          resultado.stock_errores.push(`No se pudo generar la NC: ${errNC?.message || nc?.error}`);
        } else {
          resultado.nota_credito = nc;
        }
      }
    }

    // Recalcular score: el cambio de estado afecta el cálculo (rechazadas
    // se excluyen del componente de devoluciones)
    //
    // FIX v803: el objeto que devuelve calcularScoreClienteRpc() (un
    // PostgrestFilterBuilder de supabase-js) es "thenable" — implementa
    // .then() pero NO .catch()/.finally() como métodos propios. Encadenar
    // `.catch()` directo sobre él (sin pasar antes por `.then()`, que sí
    // devuelve una Promise nativa) tira "TypeError: ...catch is not a
    // function" — reventaba con 500 CUALQUIER aprobación/rechazo de
    // devolución (correlation_id 9a1c8bf1, ver logs de Vercel). Acá,
    // a diferencia del alta manual (línea ~2728, fire-and-forget con
    // `.then().catch()`), esto ya se espera con `await` — alcanza con
    // try/catch normal, que sí funciona sobre un thenable.
    if (devolucion?.cliente_id) {
      try {
        await calcularScoreClienteRpc({
          p_cliente_id: devolucion.cliente_id, p_empresa_id: empresa_id,
          p_motivo: `devolucion_${estado}`,
        });
      } catch { /* best-effort: no debe bloquear la revisión de la devolución */ }
    }

    return res.json(resultado);
  }

  return res.status(405).json({ error: 'Método o acción no soportada' });
}
