// lib/handlers/cc_proveedores.js
// Etapa 8.5 — Cuentas corrientes con proveedores
//
// Rutas (vía /api/proveedores?_svc=cc-proveedores):
//
//   GET  ?accion=balance                        → v_cc_proveedor (todos los proveedores)
//   GET  ?accion=balance&proveedor_id=uuid      → balance de un proveedor
//   GET  ?accion=facturas&proveedor_id=uuid     → facturas del proveedor
//   GET  ?accion=facturas&orden_id=uuid         → facturas de una OC
//   GET  ?accion=pagos&factura_id=uuid          → pagos de una factura
//   POST ?accion=factura                        → crear factura (con items)
//   POST ?accion=conciliar                      → RPC conciliar_oc_factura
//   POST ?accion=pago                           → RPC registrar_pago_proveedor
//   PATCH?accion=factura                        → RPC editar_factura_proveedor (datos+items) / estado

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { AuditRepo } from '../repos/index.js';
import {
  obtenerPerfilCCProveedores,
  listarBalanceProveedores,
  contarFacturasConDiferencias,
  obtenerFacturaProveedorDetalle,
  listarFacturasProveedorFiltradas,
  listarPagosFactura,
  existeOrdenCompraEnEmpresa,
  conciliarOcFacturaRpc,
  altaFacturaProveedorRpc,
  editarFacturaProveedorRpc,
  actualizarConciliacionFactura,
  registrarPagoProveedorRpc,
} from '../repos/cc-proveedores.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

// `supabase` sigue vivo solo para `auth.getUser()` — identidad, no dato de
// negocio, mismo criterio que `db.auth.admin.*` en clientes.js.
const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export async function handleCCProveedores(req, res) {
  if (await limiter(req, res)) return;

  // ── Auth ─────────────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilCCProveedores(user.id);

  if (!perfil || !puede(perfil, 'leer', 'cc_proveedores'))
    return res.status(403).json({ error: 'Sin permisos' });

  const { empresa_id } = perfil;
  const esEscritor = puede(perfil, 'escribir', 'cc_proveedores');
  const esPagador  = puede(perfil, 'pagar', 'cc_proveedores');
  const accion     = req.query.accion || '';

  // ════════════════════════════════════════════════════════════════
  // GET
  // ════════════════════════════════════════════════════════════════
  if (req.method === 'GET') {

    // ── Balance general o por proveedor ──────────────────────────
    if (accion === 'balance') {
      let data;
      try {
        data = await listarBalanceProveedores({ empresa_id, proveedor_id: req.query.proveedor_id });
      } catch (error) {
        return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      }

      // Tarjeta KPI "Facturas con diferencias" (badge/campanita usan el mismo
      // criterio — columna generada tiene_diferencias, mig. 414). Se cuenta
      // acá y no en el listado paginado de accion=facturas para no atarlo a
      // la página/filtro que esté mirando el usuario en ese momento.
      const facturasConDiferencias = await contarFacturasConDiferencias(empresa_id);

      return res.json({ balance: data || [], facturas_con_diferencias: facturasConDiferencias });
    }

    // ── Facturas de proveedor ─────────────────────────────────────
    // FIX (continuación AUDITORIA_FILTROS_v280, mismo patrón que
    // Cheques/Riesgo de cheques/Facturación): antes traía hasta 500
    // facturas sin filtro de fecha server-side y el frontend filtraba
    // proveedor/estado/fecha con Array.filter() sobre ese recorte fijo.
    // Ahora acepta desde/hasta (nuevo) + page/limit resueltos con
    // .range() + count:'exact'. El lookup puntual por ?id= sigue sin
    // paginar (se usa para abrir un link directo a una factura).
    if (accion === 'facturas') {
      if (req.query.id) {
        let data;
        try {
          data = await obtenerFacturaProveedorDetalle({ empresa_id, id: req.query.id });
        } catch (error) {
          return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
        }
        return res.json({ facturas: data ? [data] : [] });
      }

      const page  = Math.max(1, parseInt(req.query.page)  || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const desde = (page - 1) * limit;
      const hasta = desde + limit - 1;

      let data, count;
      try {
        ({ data, count } = await listarFacturasProveedorFiltradas({
          empresa_id,
          proveedor_id: req.query.proveedor_id,
          orden_id: req.query.orden_id,
          estado: req.query.estado,
          desde: req.query.desde,
          hasta: req.query.hasta,
          soloDiferencias: req.query.solo_diferencias === 'true',
          offset: desde,
          hasta_range: hasta,
        }));
      } catch (error) {
        return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      }
      return res.json({ facturas: data, total: count, page, limit });
    }

    // ── Pagos de una factura ──────────────────────────────────────
    if (accion === 'pagos') {
      const factura_id = req.query.factura_id;
      if (!factura_id) return res.status(400).json({ error: 'factura_id requerido' });

      let data;
      try {
        data = await listarPagosFactura({ empresa_id, factura_id });
      } catch (error) {
        return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      }
      return res.json({ pagos: data });
    }

    return res.status(400).json({ error: 'Acción GET desconocida' });
  }

  // ════════════════════════════════════════════════════════════════
  // POST
  // ════════════════════════════════════════════════════════════════
  if (req.method === 'POST') {

    // ── Crear factura ─────────────────────────────────────────────
    if (accion === 'factura') {
      if (!esEscritor) return res.status(403).json({ error: 'Sin permisos de escritura' });

      const {
        proveedor_id, orden_id, numero_factura, tipo = 'A',
        fecha_factura, fecha_vencimiento,
        iva_pct = 21, notas, items = []
      } = req.body;

      if (!proveedor_id || !numero_factura || !fecha_factura)
        return res.status(400).json({ error: 'proveedor_id, numero_factura y fecha_factura son requeridos' });
      if (!Array.isArray(items) || items.length === 0)
        return res.status(400).json({ error: 'La factura requiere al menos un ítem' });

      // FIX (punto 3 auditoría): antes esto era cabecera → ítems → RPC
      // conciliar → update conciliación → auditoría, cada uno un statement
      // suelto contra la base. Un fallo a mitad de camino (ítems, por
      // ejemplo) dejaba una factura sin ítems ya visible en los listados.
      // Ahora es una sola RPC transaccional (alta_factura_proveedor) que
      // valida tenant/proveedor/OC/ítems, inserta todo y audita dentro de
      // la misma transacción: o se completa entero, o no queda nada.
      // subtotal/iva_monto/total ya no se aceptan del body: la RPC los
      // recalcula desde los ítems reales (cierra el vector de manipulación
      // de importes que tenía el cálculo hecho acá).
      const { data, error } = await altaFacturaProveedorRpc({
        empresa_id, proveedor_id, numero_factura, fecha_factura,
        orden_id: orden_id || null, tipo, fecha_vencimiento, iva_pct, notas,
        items, umbral_pct: 5, usuario_id: perfil.id,
      });

      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      if (!data?.ok) return res.status(400).json({ error: data?.error || 'No se pudo dar de alta la factura' });

      return res.status(201).json({
        ok: true,
        factura: {
          id: data.factura_id, empresa_id, proveedor_id, orden_id: orden_id || null,
          numero_factura, subtotal: data.subtotal, iva_monto: data.iva_monto, total: data.total,
        },
        conciliacion: data.conciliacion,
      });
    }

    // ── Conciliar OC vs Factura ───────────────────────────────────
    if (accion === 'conciliar') {
      const { orden_id, factura_id, umbral_pct = 5 } = req.body;
      if (!orden_id || !factura_id)
        return res.status(400).json({ error: 'orden_id y factura_id requeridos' });

      // FIX (punto 2 auditoría): este es el call site más expuesto — tanto
      // orden_id como factura_id vienen del body sin pasar por ningún otro
      // chequeo previo. Defensa en profundidad: validar acá también, aunque
      // la RPC ya rechace el cruce.
      const [ocEsDeLaEmpresa, facturaExiste] = await Promise.all([
        existeOrdenCompraEnEmpresa({ empresa_id, orden_id }),
        obtenerFacturaProveedorDetalle({ empresa_id, id: factura_id }),
      ]);
      if (!ocEsDeLaEmpresa) return res.status(404).json({ error: 'Orden de compra no encontrada' });
      if (!facturaExiste)  return res.status(404).json({ error: 'Factura no encontrada' });

      const { data, error } = await conciliarOcFacturaRpc({ orden_id, factura_id, empresa_id, umbral_pct });

      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      if (!data?.ok) return res.status(400).json({ error: data?.error || 'Error en conciliación' });

      // Guardar resultado en la factura
      await actualizarConciliacionFactura({
        id: factura_id, empresa_id, conciliacion: data, discrepancias: data.discrepancias,
      });

      return res.json(data);
    }

    // ── Registrar pago ────────────────────────────────────────────
    if (accion === 'pago') {
      if (!esPagador) return res.status(403).json({ error: 'Sin permisos para registrar pagos' });

      const { proveedor_id, factura_id, monto, medio_pago, fecha_pago, referencia, notas, cheque_id, offline_local_id } = req.body;
      if (!proveedor_id || !factura_id || !monto)
        return res.status(400).json({ error: 'proveedor_id, factura_id y monto son requeridos' });

      // Punto 7 (auditoría 2026): offline_local_id opcional, mismo patrón
      // que cobros/ajustes de stock — si el cliente lo manda (reintento de
      // red, doble click, futuro outbox del portal de pagos), la RPC es
      // idempotente y no duplica el pago.
      const { data, error } = await registrarPagoProveedorRpc({
        p_empresa_id:       empresa_id,
        p_proveedor_id:     proveedor_id,
        p_factura_id:       factura_id,
        p_monto:            monto,
        p_medio:            medio_pago || 'transferencia',
        p_fecha:            fecha_pago || new Date().toISOString().slice(0, 10),
        p_referencia:       referencia || null,
        p_notas:            notas || null,
        p_usuario_id:       perfil.id,
        p_cheque_id:        cheque_id || null,
        p_offline_local_id: offline_local_id || null,
      });

      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      if (!data?.ok) return res.status(400).json({ error: data?.error || 'Error al registrar pago' });

      // Auditoría (v455): pago real a proveedor — dinero moviéndose, mismo
      // criterio que "cobro" en pagos.js/pedidos.js. A diferencia del cobro
      // manual (v454, auditado dentro de la función SQL porque no hay
      // handler en el medio), acá sí hay handler mediando la llamada al RPC
      // — se audita en JS, mismo patrón que el resto de la serie.
      // El RPC no devuelve el id de la fila insertada en `pagos_proveedor`
      // (solo el nuevo estado/saldo de la factura), así que se audita con
      // `factura_id` como registro_id — mismo criterio que usar el id de la
      // entidad relacionada cuando el write point no expone un id propio.
      //
      // Punto 7 (auditoría 2026): si fue un fast-path idempotente
      // (ya_existia), no se re-audita — mismo patrón que pos.js/pedidos.js
      // para no reemitir auditoría sobre un reintento que no escribió nada
      // nuevo.
      //
      // Punto 8 (auditoría 2026): dinero real saliendo — se usa la
      // variante durable (encola en audit_log_pendientes si el INSERT
      // directo falla, en vez de descartar en silencio).
      if (!data?.ya_existia) {
        await AuditRepo.registrarAuditoriaFinancieraDurable(
          empresa_id, perfil.id, 'pagos_proveedor', 'INSERT', factura_id,
          null, {
            proveedor_id, monto, medio_pago: medio_pago || 'transferencia',
            cheque_id: cheque_id || null, estado_factura: data.estado, total_pagado: data.total_pagado,
          }
        );
      }

      return res.json(data);
    }

    return res.status(400).json({ error: 'Acción POST desconocida' });
  }

  // ════════════════════════════════════════════════════════════════
  // PATCH: editar factura (cabecera + ítems) / estado
  // ════════════════════════════════════════════════════════════════
  if (req.method === 'PATCH') {
    if (accion === 'factura') {
      if (!esEscritor) return res.status(403).json({ error: 'Sin permisos' });

      const {
        id, expected_updated_at, estado, notas, fecha_vencimiento,
        numero_factura, tipo, fecha_factura, iva_pct, orden_id, items,
      } = req.body;
      if (!id) return res.status(400).json({ error: 'id requerido' });

      if (items !== undefined && !Array.isArray(items)) {
        return res.status(400).json({ error: 'items debe ser un array' });
      }

      // FIX (punto 4 auditoría): el PATCH era update de cabecera → borrar
      // ítems → insertar ítems nuevos → RPC conciliar → update conciliación
      // → auditoría, cada uno un statement suelto contra la base y sin
      // lock. Dos PATCH concurrentes sobre la misma factura podían pisarse,
      // y un fallo a mitad de camino (ej. el insert de ítems nuevos después
      // de haber borrado los viejos) podía dejar cabecera nueva con cero
      // ítems. Ahora es una sola RPC transaccional (editar_factura_proveedor)
      // que bloquea la fila (SELECT ... FOR UPDATE), valida versión
      // (expected_updated_at) si vino, valida tenant/OC/ítems, reemplaza
      // ítems, re-concilia y audita — todo o nada, mismo criterio que el
      // alta (punto 3). estado sigue restringido a 'pendiente' acá: la RPC
      // rechaza cualquier otro valor con ESTADO_NO_PERMITIDO (parcial/pagada
      // solo por registrar_pago_proveedor, anulada solo por conciliar/
      // anulación explícita).
      const { data, error } = await editarFacturaProveedorRpc({
        empresa_id, id, expected_updated_at: expected_updated_at || null,
        estado, notas, notas_provisto: notas !== undefined,
        fecha_vencimiento, numero_factura, tipo, fecha_factura, iva_pct,
        orden_id_provisto: orden_id !== undefined, orden_id,
        items_provisto: items !== undefined, items,
        umbral_pct: 5, usuario_id: perfil.id,
      });

      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      if (!data?.ok) {
        const status = ({
          NO_AUTORIZADO:        403,
          FACTURA_INEXISTENTE:  404,
          OC_INEXISTENTE:       404,
          VERSION_CONFLICT:     409,
        })[data?.codigo] || 400;
        return res.status(status).json({
          error: data?.error || 'No se pudo editar la factura',
          codigo: data?.codigo,
          ...(data?.updated_at_actual ? { updated_at_actual: data.updated_at_actual } : {}),
        });
      }

      // La RPC no devuelve la factura completa (con relaciones) que espera
      // el modal del frontend — se re-consulta después del commit, mismo
      // criterio que usa el listado/detalle para el resto de las pantallas.
      let facturaActualizada;
      try {
        facturaActualizada = await obtenerFacturaProveedorDetalle({ empresa_id, id });
      } catch (fErr) {
        return errorSeguro(res, fErr, 500, 'No se pudo completar la operación.');
      }

      return res.json({ ok: true, factura: facturaActualizada, conciliacion: data.conciliacion });
    }

    return res.status(400).json({ error: 'Acción PATCH desconocida' });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
