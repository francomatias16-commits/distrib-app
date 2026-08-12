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
//   PATCH?accion=factura                        → actualizar factura (datos+items) / estado / anular

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
  existeProveedorEnEmpresa,
  insertarFacturaProveedorCC,
  insertarItemsFacturaProveedorCC,
  eliminarItemsFacturaProveedorCC,
  conciliarOcFacturaRpc,
  actualizarConciliacionFactura,
  registrarPagoProveedorRpc,
  obtenerFacturaEstadoTotalPagado,
  actualizarFacturaProveedorCC,
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
        subtotal, iva_pct = 21, iva_monto, total,
        notas, items = []
      } = req.body;

      if (!proveedor_id || !numero_factura || !fecha_factura)
        return res.status(400).json({ error: 'proveedor_id, numero_factura y fecha_factura son requeridos' });

      // Verificar que el proveedor pertenece a la empresa
      const provExiste = await existeProveedorEnEmpresa(empresa_id, proveedor_id);
      if (!provExiste) return res.status(404).json({ error: 'Proveedor no encontrado' });

      // Calcular totales si no vienen completos
      const calcSubtotal = subtotal ?? items.reduce((s, i) => s + (i.cantidad * i.precio_unitario), 0);
      const calcIvaMonto = iva_monto ?? (calcSubtotal * (iva_pct / 100));
      const calcTotal    = total ?? (calcSubtotal + calcIvaMonto);

      // Insertar factura
      let factura;
      try {
        factura = await insertarFacturaProveedorCC({
          empresa_id, proveedor_id, orden_id: orden_id || null,
          numero_factura, tipo, fecha_factura,
          fecha_vencimiento: fecha_vencimiento || null,
          subtotal: calcSubtotal, iva_pct, iva_monto: calcIvaMonto,
          total: calcTotal, notas
        });
      } catch (fErr) {
        return errorSeguro(res, fErr, 500, 'No se pudo completar la operación.');
      }

      // Insertar ítems
      if (items.length > 0) {
        const filas = items.map(i => ({
          factura_id:      factura.id,
          producto_id:     i.producto_id || null,
          descripcion:     i.descripcion || i.nombre || '—',
          cantidad:        i.cantidad,
          precio_unitario: i.precio_unitario,
        }));

        try {
          await insertarItemsFacturaProveedorCC(filas);
        } catch (iErr) {
          return errorSeguro(res, iErr, 500, 'No se pudo completar la operación.');
        }
      }

      // Si tiene orden_id, conciliar automáticamente
      let conciliacion = null;
      if (orden_id && items.length > 0) {
        const { data: conc } = await conciliarOcFacturaRpc({ orden_id, factura_id: factura.id, umbral_pct: 5 });

        if (conc?.ok) {
          conciliacion = conc;
          await actualizarConciliacionFactura({
            id: factura.id, empresa_id, conciliacion: conc, discrepancias: conc.discrepancias,
          });
        }
      }

      // Auditoría (v455): alta de factura de proveedor — un único punto que
      // cubre cabecera + ítems, mismo criterio que "Registrar venta" en
      // pos.js (v721): un solo registro de auditoría por hecho de negocio,
      // no uno por cada insert interno (factura + items + conciliación son
      // parte del mismo alta).
      await AuditRepo.registrarAuditoriaSilenciosa(
        empresa_id, perfil.id, 'facturas_proveedor', 'INSERT', factura.id,
        null, { proveedor_id, numero_factura, total: calcTotal, orden_id: orden_id || null }
      );

      return res.status(201).json({ ok: true, factura, conciliacion });
    }

    // ── Conciliar OC vs Factura ───────────────────────────────────
    if (accion === 'conciliar') {
      const { orden_id, factura_id, umbral_pct = 5 } = req.body;
      if (!orden_id || !factura_id)
        return res.status(400).json({ error: 'orden_id y factura_id requeridos' });

      const { data, error } = await conciliarOcFacturaRpc({ orden_id, factura_id, umbral_pct });

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

      const { proveedor_id, factura_id, monto, medio_pago, fecha_pago, referencia, notas, cheque_id } = req.body;
      if (!proveedor_id || !factura_id || !monto)
        return res.status(400).json({ error: 'proveedor_id, factura_id y monto son requeridos' });

      const { data, error } = await registrarPagoProveedorRpc({
        p_empresa_id:   empresa_id,
        p_proveedor_id: proveedor_id,
        p_factura_id:   factura_id,
        p_monto:        monto,
        p_medio:        medio_pago || 'transferencia',
        p_fecha:        fecha_pago || new Date().toISOString().slice(0, 10),
        p_referencia:   referencia || null,
        p_notas:        notas || null,
        p_usuario_id:   perfil.id,
        p_cheque_id:    cheque_id || null,
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
      await AuditRepo.registrarAuditoriaSilenciosa(
        empresa_id, perfil.id, 'pagos_proveedor', 'INSERT', factura_id,
        null, {
          proveedor_id, monto, medio_pago: medio_pago || 'transferencia',
          cheque_id: cheque_id || null, estado_factura: data.estado, total_pagado: data.total_pagado,
        }
      );

      return res.json(data);
    }

    return res.status(400).json({ error: 'Acción POST desconocida' });
  }

  // ════════════════════════════════════════════════════════════════
  // PATCH: actualizar factura (cabecera + ítems) / estado / anular
  // ════════════════════════════════════════════════════════════════
  if (req.method === 'PATCH') {
    if (accion === 'factura') {
      if (!esEscritor) return res.status(403).json({ error: 'Sin permisos' });

      const { id, estado, notas, fecha_vencimiento } = req.body;
      if (!id) return res.status(400).json({ error: 'id requerido' });

      // FIX (Ruben, 16/7/2026): el PATCH solo guardaba estado/notas/
      // fecha_vencimiento. El modal de edición manda numero_factura,
      // tipo, fecha_factura, iva_pct e items completos, pero se
      // descartaban en silencio — el usuario editaba ítems y "no se
      // guardaba nada". Ahora también se actualiza la cabecera y se
      // reemplazan los ítems (mismo criterio que el alta por POST).
      const {
        numero_factura, tipo, fecha_factura, iva_pct,
        subtotal, iva_monto, total, orden_id, items
      } = req.body;

      // FIX (auditoría pedido→factura→cta_cte→cobro, Hallazgo 7): antes se
      // aceptaba cualquier valor de `estado` acá, incluyendo 'pagada' o
      // 'anulada' — permitiendo marcar una factura de proveedor como
      // pagada sin pasar por registrar_pago_proveedor/conciliar_oc_factura,
      // y desincronizando el saldo real de cc_proveedores/cta_cte respecto
      // al estado mostrado. Verificado contra el CHECK constraint real
      // (facturas_proveedor_estado_check): los únicos valores posibles son
      // pendiente/parcial/pagada/anulada. 'parcial' y 'pagada' solo deberían
      // resultar de un pago real (registrar_pago_proveedor); 'anulada' solo
      // de conciliar_oc_factura o de una anulación explícita sin pagos.
      const ESTADOS_PATCH_PERMITIDOS = ['pendiente'];
      if (estado && !ESTADOS_PATCH_PERMITIDOS.includes(estado)) {
        return res.status(400).json({
          error: `Estado '${estado}' no se puede asignar directo por este endpoint. ` +
                 `Usá ?accion=pago (registrar_pago_proveedor) para pasar a 'parcial'/'pagada', ` +
                 `o ?accion=conciliar (conciliar_oc_factura) para 'anulada'.`,
        });
      }

      // No permitir editar cabecera/ítems de una factura que ya tiene
      // algún pago registrado (parcial o pagada) ni de una anulada.
      // total_pagado queda "congelado" en la fila — si se edita el total
      // después de un pago parcial, total_pagado puede terminar superando
      // al nuevo total (saldo negativo, estado desincronizado). Por eso el
      // corte es total_pagado > 0, no solo estado === 'pendiente' (más
      // robusto que chequear el string de estado).
      const camposCabecera = [numero_factura, tipo, fecha_factura, iva_pct, orden_id, items].some(v => v !== undefined);
      let facturaAntesDeEditar = null;
      if (camposCabecera) {
        facturaAntesDeEditar = await obtenerFacturaEstadoTotalPagado({ id, empresa_id });

        if (!facturaAntesDeEditar) return res.status(404).json({ error: 'Factura no encontrada' });
        if (facturaAntesDeEditar.estado === 'anulada' || Number(facturaAntesDeEditar.total_pagado) > 0) {
          return res.status(400).json({
            error: 'No se pueden editar los datos/ítems de una factura anulada o con pagos ya registrados.',
          });
        }
      }

      const upd = {};
      if (estado)                      upd.estado             = estado;
      if (notas !== undefined)         upd.notas              = notas;
      if (fecha_vencimiento)           upd.fecha_vencimiento  = fecha_vencimiento;
      if (numero_factura)              upd.numero_factura     = numero_factura;
      if (tipo)                        upd.tipo               = tipo;
      if (fecha_factura)               upd.fecha_factura      = fecha_factura;
      if (orden_id !== undefined)      upd.orden_id           = orden_id || null;
      if (iva_pct !== undefined)       upd.iva_pct            = iva_pct;

      if (Array.isArray(items)) {
        const calcSubtotal = subtotal ?? items.reduce((s, i) => s + (i.cantidad * i.precio_unitario), 0);
        const calcIvaMonto = iva_monto ?? (calcSubtotal * ((iva_pct ?? 21) / 100));
        const calcTotal    = total ?? (calcSubtotal + calcIvaMonto);
        upd.subtotal  = calcSubtotal;
        upd.iva_monto = calcIvaMonto;
        upd.total     = calcTotal;
      }

      let data;
      try {
        data = await actualizarFacturaProveedorCC({ id, empresa_id, upd });
      } catch (error) {
        return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      }

      // Auditoría (v455): edición de factura de proveedor (cabecera+ítems o
      // cambio de estado a 'pendiente' — el único que este endpoint permite
      // asignar directo, ver el bloque ESTADOS_PATCH_PERMITIDOS arriba).
      await AuditRepo.registrarAuditoriaSilenciosa(
        empresa_id, perfil.id, 'facturas_proveedor', 'UPDATE', id,
        facturaAntesDeEditar ? { estado: facturaAntesDeEditar.estado } : null, upd
      );

      // Reemplazar ítems: borrar los existentes e insertar los nuevos,
      // igual que hace el alta por POST.
      if (Array.isArray(items)) {
        try {
          await eliminarItemsFacturaProveedorCC(id);
        } catch (delErr) {
          return errorSeguro(res, delErr, 500, 'No se pudo completar la operación.');
        }

        if (items.length > 0) {
          const filas = items.map(i => ({
            factura_id:      id,
            producto_id:     i.producto_id || null,
            descripcion:     i.descripcion || i.nombre || '—',
            cantidad:        i.cantidad,
            precio_unitario: i.precio_unitario,
          }));

          try {
            await insertarItemsFacturaProveedorCC(filas);
          } catch (iErr) {
            return errorSeguro(res, iErr, 500, 'No se pudo completar la operación.');
          }
        }

        // Si tiene orden_id, re-conciliar con los ítems actualizados.
        const ordenParaConciliar = data.orden_id;
        if (ordenParaConciliar) {
          const { data: conc } = await conciliarOcFacturaRpc({ orden_id: ordenParaConciliar, factura_id: id, umbral_pct: 5 });

          if (conc?.ok) {
            await actualizarConciliacionFactura({
              id, empresa_id, conciliacion: conc, discrepancias: conc.discrepancias,
            });
          }
        }
      }

      return res.json({ ok: true, factura: data });
    }

    return res.status(400).json({ error: 'Acción PATCH desconocida' });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
