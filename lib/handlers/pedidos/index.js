// lib/handlers/pedidos/index.js
// Orquestador del módulo pedidos: dispatcher HTTP principal (GET/PATCH/DELETE
// de /api/pedidos + sub-ruteo a presupuestos/remito-nro/chofer/devoluciones)
// y reexportación de la API pública del módulo. Extraído de
// lib/handlers/pedidos.js (25/08/2026) — ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

import { crearClienteSupabaseLazy } from '../../supabase-lazy.js';
import { getUserSeguro } from '../../auth-helpers.js';
import * as AuditRepo from '../../repos/audit.js';
import { errorSeguro } from '../../error-response.js';
import { puede, rolesDe } from '../../permisos-service.js';
import { rateLimit } from '../../rate-limit.js';
import {
  actualizarEstadoPedido,
  anularFacturaPendiente,
  eliminarEntregasDePedido,
  eliminarFacturasDePedido,
  eliminarPedidoPorId,
  liberarStockReservadoRpc,
  listarDevolucionesDePedido,
  listarFacturasDePedido,
  listarFacturasVinculadasParaCancelar,
  listarItemsPedidoParaCancelar,
  listarPedidosFiltrados,
  listarStockParaLiberarReserva,
  marcarPedidoCancelado,
  marcarPedidoDespachado,
  marcarPedidoEntregado,
  obtenerDepositoRealReserva,
  obtenerEstadoDevolucionPorPedidos,
  obtenerPedidoDetalleConItems,
  obtenerPedidoIdEstado,
  obtenerPerfilParaPedidos,
  resolverClienteIdPorEmail,
  revertirPuntosPedidoCanceladoRpc,
} from '../../repos/pedidos.js';
import { notificarPedidoEnCamino } from '../_push.js';
import { handlePresupuestos, crearPresupuestoParaCliente, ROLES_ADMIN_PRES } from './presupuestos.js';
import { handleRemitoNro } from './remito.js';
import { handleChofer } from './chofer.js';
import { handleDevolucionesAdmin, crearDevolucionCore } from './devoluciones.js';
import { confirmarPedidoHandler } from './confirmar-pedido.js';
import { verPedidoSugeridoHandler, confirmarPedidoSugeridoHandler } from './pedido-sugerido.js';
import { crearPedidoAdminHandler, crearPedidoParaCliente } from './crear-pedido.js';
import { notificarEstado, notificarDespachoPorEmail, notificarPedidoConfirmado, acreditarPuntos, acreditarAhorroCompetencia } from './notificaciones.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

// Reexportado tal cual (mismo nombre, mismo valor) porque asistente-tools.js
// lo reimporta como ROLES_PEDIDO — ver nota en lib/permisos-service.js.
// La tabla en permisos-service.js es la única fuente de verdad; acá solo
// se reexpone. Los 3 gates internos de este archivo usan puede() directo.
export const ROLES_ADMIN = rolesDe('pedidos', 'acceder');
const ESTADOS_VALIDOS = ['borrador', 'confirmado', 'preparando', 'despachado', 'entregado', 'cancelado'];

// DT-04: Rate limiting diferenciado
// confirmar pedido → más restrictivo (20 req/min) por el impacto en stock y facturación
const limiterConfirmar = rateLimit({ max: 20, windowMs: 60_000 });
// operaciones admin → 60 req/min (estándar)
const limiterAdmin = rateLimit({ max: 60, windowMs: 60_000 });

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

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
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

// Reexportación de la API pública del módulo (importada externamente por
// lib/asistente-tools/index.js, lib/eventos-listeners/pedido_creado.js, y
// api/index.js vía el barrel lib/handlers/pedidos.js).
export { notificarEstado };
export { confirmarPedidoSugeridoHandler };
export { crearPedidoParaCliente };
export { notificarPedidoConfirmado };
export { acreditarPuntos };
export { acreditarAhorroCompetencia };
export { ROLES_ADMIN_PRES };
export { crearPresupuestoParaCliente };
export { crearDevolucionCore };
