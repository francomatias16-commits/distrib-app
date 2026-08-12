// lib/eventos-listeners/pedido_creado.js
// Fase 3 del plan de sincronización ERP: los tres listeners que migran el
// comportamiento de crearPedidoParaCliente() (lib/handlers/pedidos.js) sin
// cambiarlo — reusan las mismas funciones que corrían encadenadas antes.
//
// El payload del evento (Fase 1) solo trae ids a propósito (liviano), así
// que cada listener que necesita el cliente completo lo resuelve acá.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { notificarPedidoConfirmado, acreditarPuntos } from '../handlers/pedidos.js';
import { emitirFactura } from '../facturas.js';

const supabase = crearClienteSupabaseLazy(() => [
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
]);

async function resolverCliente(clienteId) {
  const { data, error } = await supabase
    .from('clientes')
    .select('id, razon_social, limite_credito, saldo_deuda, activo, telefono')
    .eq('id', clienteId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`No se pudo resolver el cliente ${clienteId} para el evento pedido_creado: ${error?.message || 'no encontrado'}`);
  }
  return data;
}

async function listenerNotificar(payload, evento) {
  const cliente = await resolverCliente(payload.cliente_id);
  await notificarPedidoConfirmado(payload.pedido_id, cliente, evento.empresa_id);
}
listenerNotificar.listenerNombre = 'notificarPedidoConfirmado';

async function listenerFacturar(payload) {
  await emitirFactura(payload.pedido_id);
}
listenerFacturar.listenerNombre = 'emitirFactura';

async function listenerPuntos(payload, evento) {
  const cliente = await resolverCliente(payload.cliente_id);
  await acreditarPuntos(payload.pedido_id, cliente, evento.empresa_id);
}
listenerPuntos.listenerNombre = 'acreditarPuntos';

export const listenersPedidoCreado = [listenerNotificar, listenerFacturar, listenerPuntos];
