// lib/handlers/pedidos/pedido-sugerido.js
// Ruta pública (sin login) para ver y confirmar un pedido sugerido enviado
// por el link de WhatsApp. Extraído de lib/handlers/pedidos.js (25/08/2026).

import * as AuditRepo from '../../repos/audit.js';
import { errorSeguro } from '../../error-response.js';
import { puede } from '../../permisos-service.js';
import {
  esPedidoPilotoWhatsApp,
  existeIntegracionMPActiva,
} from '../../repos/pagos.js';
import {
  confirmarPedidoSugeridoRpc,
  obtenerPedidoParaConfirmarSugerido,
  obtenerPedidoSugeridoDetalle,
} from '../../repos/pedidos.js';

export async function verPedidoSugeridoHandler(req, res) {
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

export async function confirmarPedidoSugeridoHandler(req, res) {
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

  // FIX v956 (Hallazgo 🟡 #9): la RPC ahora es un UPDATE atómico con guard
  // (ver migración 537) — dos requests concurrentes ya no pueden pasar
  // ambas el check y ejecutar el UPDATE. La segunda llega acá con
  // data.ok === false ("ya procesado"); si registráramos auditoría en ese
  // caso quedaría una fila de UPDATE falsa (antes/después idénticos, no
  // hubo cambio real). Solo se audita la transición que efectivamente
  // ocurrió.
  if (!data?.ok) return res.status(409).json(data);

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
