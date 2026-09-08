// lib/eventos-listeners/pedido_creado.js
// Fase 3 del plan de sincronización ERP: los tres listeners que migran el
// comportamiento de crearPedidoParaCliente() (lib/handlers/pedidos.js) sin
// cambiarlo — reusan las mismas funciones que corrían encadenadas antes.
//
// El payload del evento (Fase 1) solo trae ids a propósito (liviano), así
// que cada listener que necesita el cliente completo lo resuelve acá.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { notificarPedidoConfirmado, acreditarPuntos, acreditarAhorroCompetencia } from '../handlers/pedidos.js';
import { emitirFactura } from '../facturas.js';
import { ErrorEventoNoRecuperable } from '../eventos-errores.js';

const supabase = crearClienteSupabaseLazy(() => [
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
]);

async function resolverCliente(clienteId) {
  // FIX-CPU-01: si clienteId ya viene undefined/null en el payload, ni
  // siquiera vale la pena pegarle a la base — es un evento con datos
  // incompletos desde el origen y va a fallar exactamente igual mañana y
  // pasado. Se corta acá para que el dispatcher lo mande a dead-letter en
  // el primer intento en vez de reintentarlo en cada corrida de cron.
  if (!clienteId) {
    throw new ErrorEventoNoRecuperable(
      `Evento pedido_creado sin cliente_id en el payload — no se puede reintentar, requiere revisión manual.`
    );
  }

  const { data, error } = await supabase
    .from('clientes')
    .select('id, razon_social, limite_credito, saldo_deuda, activo, telefono')
    .eq('id', clienteId)
    .maybeSingle();

  if (error || !data) {
    // Este caso sí puede ser transitorio (problema de conexión, cliente
    // borrado y vuelto a crear con otro id, etc.) — se mantiene como
    // error reintentable, tal como estaba.
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

// Fase 2 de PLAN_CAPTURA_COMPETENCIA.md (Capa 3 — retención): mismo criterio
// que listenerPuntos — resuelve el cliente completo y delega en la función
// compartida con el camino directo (crear-pedido.js/confirmar-pedido.js).
async function listenerAhorroCompetencia(payload, evento) {
  const cliente = await resolverCliente(payload.cliente_id);
  await acreditarAhorroCompetencia(payload.pedido_id, cliente, evento.empresa_id);
}
listenerAhorroCompetencia.listenerNombre = 'acreditarAhorroCompetencia';

export const listenersPedidoCreado = [listenerNotificar, listenerFacturar, listenerPuntos, listenerAhorroCompetencia];
