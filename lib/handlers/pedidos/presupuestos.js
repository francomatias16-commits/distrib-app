// lib/handlers/pedidos/presupuestos.js
// Presupuestos (absorto desde api/presupuestos/index.js). Extraído de
// lib/handlers/pedidos.js (25/08/2026).

import { crearClienteSupabaseLazy } from '../../supabase-lazy.js';
import { getUserSeguro } from '../../auth-helpers.js';
import * as AuditRepo from '../../repos/audit.js';
import {
  calcularIvaPonderadoCombo,
  calcularTotalesPedido,
} from '../../calc/pedido-totales.js';
import { errorSeguro } from '../../error-response.js';
import {
  puede,
  rolesDe,
} from '../../permisos-service.js';
import { obtenerCombosParaValidarPedido } from '../../repos/combos.js';
import {
  actualizarPresupuesto,
  bloquearPresupuestoAceptado,
  crearPedidoDesdePresupuesto,
  crearPresupuestoConItemsRpc,
  eliminarItemsPedido,
  eliminarItemsPresupuesto,
  eliminarPedido,
  eliminarPresupuesto,
  incrementarStockReservadoRpc,
  insertarItemsPedidoDesdePresupuesto,
  liberarStockReservadoRpc,
  listarPresupuestos,
  listarStockOtrosDepositos,
  obtenerClienteCredito,
  obtenerClienteParaPresupuesto,
  obtenerClientePorUsuarioId,
  obtenerPerfilPresupuestos,
  obtenerPresupuestoCompleto,
  obtenerPresupuestoConDetalle,
  obtenerPresupuestoParaEliminar,
  obtenerPresupuestoParaPatch,
  obtenerStockDepositoPrincipal,
  registrarMovimientoStockReserva,
  resolverPreciosClienteRpc,
  revertirPresupuestoAEnviado,
  vincularPresupuestoConPedido,
} from '../../repos/pedidos.js';
import { obtenerStockDeDeposito } from '../../repos/depositos.js';
import { obtenerProductosParaValidarPedido } from '../../repos/productos.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export const ROLES_ADMIN_PRES = rolesDe('presupuestos', 'acceder');
// Estados según constraint real de la DB: borrador|enviado|aceptado|rechazado|vencido
const ESTADOS_VALIDOS_PRES = ['borrador', 'enviado', 'aceptado', 'rechazado', 'vencido'];

// Vigencia por defecto en días, usada tanto acá como en handlePresupuestos
// (antes vivía duplicado el número 48 en dos lugares — ver comentario de
// crearPresupuestoParaCliente).
const PRESUPUESTO_VIGENCIA_DIAS_DEFAULT = 48;

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

export async function handlePresupuestos(req, res) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
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

        // Multi-depósito (550): mismo criterio de prioridad que
        // resolver_deposito_pedido() — primero la sucursal fija del
        // cliente (si tiene una asignada), después el depósito PRINCIPAL
        // (réplica de la lógica histórica de confirmar_pedido()). Solo si
        // ninguno de los dos tiene NINGÚN registro de stock se cae al
        // fallback de "cualquier depósito con más disponible". Si un nivel
        // tiene registro pero insuficiente, no se prueba el siguiente —
        // mismo comportamiento que ya tenía el principal, ahora extendido.
        let stockFila = clienteCredito?.deposito_id
          ? await obtenerStockDeDeposito(clienteCredito.deposito_id, it.producto_id)
          : null;

        if (!stockFila) {
          stockFila = await obtenerStockDepositoPrincipal(empresa_id, it.producto_id);
        }

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
