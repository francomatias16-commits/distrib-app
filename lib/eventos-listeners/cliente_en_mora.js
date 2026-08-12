// lib/eventos-listeners/cliente_en_mora.js
// Fase 4 del plan de sincronización ERP: listener del evento
// `cliente_en_mora`, emitido desde handleDeudaCron (lib/handlers/notif.js).
//
// El payload del evento (mismo criterio que pedido_creado en la Fase 1/3)
// solo trae ids a propósito (liviano), así que el listener resuelve el
// cliente completo antes de reusar enviarAvisoDeudaVencida — la misma
// función que usa el camino directo (empresas sin el flag de Fase 3),
// para no duplicar la lógica de WhatsApp + notif_log + push.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { enviarAvisoDeudaVencida } from '../handlers/notif.js';

const supabase = crearClienteSupabaseLazy(() => [
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
]);

async function resolverCliente(clienteId) {
  const { data, error } = await supabase
    .from('clientes')
    .select('id, razon_social, telefono, empresa_id')
    .eq('id', clienteId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`No se pudo resolver el cliente ${clienteId} para el evento cliente_en_mora: ${error?.message || 'no encontrado'}`);
  }
  return data;
}

// listenerAvisoDeudaVencida(): tira si el cliente no tiene teléfono o si
// enviarAvisoDeudaVencida devuelve { ok: false } — a diferencia del
// camino directo (que solo contabiliza el error en resultados.detalle),
// acá un error real necesita tirar para que despacharEvento() lo capture
// y deje el evento en 'error' (consultable/reprocesable por el barrido
// de eventos-reprocesar-cron), en vez de fallar en silencio.
async function listenerAvisoDeudaVencida(payload, evento) {
  const cliente = await resolverCliente(payload.cliente_id);

  if (!cliente.telefono) {
    throw new Error(`Cliente ${cliente.id} sin teléfono — no se puede enviar el aviso de deuda vencida`);
  }

  // evento.empresa_id es la fuente de verdad (la fila real de
  // eventos_negocio), no cliente.empresa_id — mismo criterio que los
  // listeners de pedido_creado.
  const resultado = await enviarAvisoDeudaVencida({
    clienteId: cliente.id,
    empresaId: evento.empresa_id,
    telefono: cliente.telefono,
    razonSocial: cliente.razon_social,
    saldoVencido: payload.saldo_vencido,
  });

  if (!resultado.ok) {
    throw new Error(resultado.motivo || 'enviarAvisoDeudaVencida falló sin motivo');
  }
}
listenerAvisoDeudaVencida.listenerNombre = 'enviarAvisoDeudaVencida';

export const listenersClienteEnMora = [listenerAvisoDeudaVencida];
