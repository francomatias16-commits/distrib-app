// lib/eventos-listeners/cheques_por_vencer.js
// Fase 4 del plan de sincronización ERP (v553): listener del evento
// `cheques_por_vencer`, emitido desde handleChequesCron (lib/handlers/notif.js).
//
// El payload del evento solo trae ids (cheque_ids), mismo criterio que
// cliente_en_mora — enviarAvisoChequesPorVencer ya resuelve los cheques
// completos por id, así que el listener no necesita más que reenviarle
// el payload y el empresa_id del evento.

import { enviarAvisoChequesPorVencer } from '../handlers/notif.js';

// listenerAvisoChequesPorVencer(): tira si enviarAvisoChequesPorVencer
// devuelve { ok: false } — a diferencia del camino directo (que solo
// contabiliza el error en resultados.detalle), acá un error real necesita
// tirar para que despacharEvento() lo capture y deje el evento en 'error'
// (consultable/reprocesable por eventos-reprocesar-cron), en vez de
// fallar en silencio. Mismo criterio que listenerAvisoDeudaVencida.
async function listenerAvisoChequesPorVencer(payload, evento) {
  // evento.empresa_id es la fuente de verdad (la fila real de
  // eventos_negocio), no algo derivado del payload — mismo criterio que
  // los demás listeners.
  const resultado = await enviarAvisoChequesPorVencer({
    empresaId: evento.empresa_id,
    chequeIds: payload.cheque_ids,
  });

  if (!resultado.ok) {
    throw new Error(resultado.motivo || 'enviarAvisoChequesPorVencer falló sin motivo');
  }
}
listenerAvisoChequesPorVencer.listenerNombre = 'enviarAvisoChequesPorVencer';

export const listenersChequesPorVencer = [listenerAvisoChequesPorVencer];
