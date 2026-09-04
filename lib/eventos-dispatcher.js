// lib/eventos-dispatcher.js
// Fase 3 del plan de sincronización ERP: despachador de eventos.
//
// despacharEvento(evento) corre todos los listeners registrados para
// evento.tipo_evento con Promise.allSettled — un listener que falla NO
// frena a los demás — y deja eventos_negocio.estado en 'procesado' o
// 'error' según el resultado real.
//
// despacharPendientes({ empresaId, limite, incluirErrores }) hace el
// barrido de eventos 'pendiente' (y opcionalmente 'error', para
// reprocesar) y los despacha uno por uno. Se usa hoy para el despacho
// inmediato disparado desde crearPedidoParaCliente(); queda preparado
// para un futuro cron de barrido (no agregado en esta entrega, ver
// CHANGELOG_v548).

import { crearClienteSupabaseLazy } from './supabase-lazy.js';
import { listenersPedidoCreado } from './eventos-listeners/pedido_creado.js';
import { listenersClienteEnMora } from './eventos-listeners/cliente_en_mora.js';
import { listenersChequesPorVencer } from './eventos-listeners/cheques_por_vencer.js';
import { listenersClienteEnRiesgoFuga } from './eventos-listeners/cliente_en_riesgo_fuga.js';
import { obtenerReglasActivas, evaluarCondicion, ejecutarAccion } from './reglas-automatizacion.js';

const supabase = crearClienteSupabaseLazy(() => [
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
]);

// SYNC-06 (Auditoría Integral 2026): tope de reintentos antes de que un
// evento en 'error' se considere agotado (deja de aparecer aunque se pida
// incluirErrores=true) y lease del claim 'procesando' — si un worker se
// cae con el evento tomado, después de este tiempo vuelve a estar
// disponible para que otro barrido lo reclame.
const EVENTOS_MAX_INTENTOS = 5;
const EVENTOS_LEASE_MS = 2 * 60 * 1000; // 2 minutos — el despacho hoy es síncrono e inmediato, nunca debería tardar tanto por evento.

// Registro de listeners por tipo de evento. pedido_facturado y
// factura_anulada se emiten desde v552 (lib/facturas.js: emitirFactura /
// anularFactura) pero siguen sin listeners — nada en el repo necesita
// reaccionar a esto todavía (los efectos reales, como el asiento en
// cta_cte, ya corren dentro de las propias funciones, no como reacción
// al evento). Quedan en eventos_negocio para trazabilidad; se suman
// listeners cuando exista algo real que migrar.
// cliente_en_mora se sumó en la Fase 4. cheques_por_vencer se sumó en v553
// (migración de handleChequesCron, mismo criterio que handleDeudaCron).
// cliente_en_riesgo_fuga se sumó en la Fase 2 de PLAN_CLIENTES_EN_FUGA.md
// — a diferencia de los anteriores, es un evento nuevo desde el día uno
// (no migra ningún camino directo preexistente), así que handleFugaCron
// siempre pasa por acá, sin flag de expand-contract.
const REGISTRO_LISTENERS = {
  pedido_creado: listenersPedidoCreado,
  pedido_facturado: [],
  factura_anulada: [],
  cliente_en_mora: listenersClienteEnMora,
  cheques_por_vencer: listenersChequesPorVencer,
  cliente_en_riesgo_fuga: listenersClienteEnRiesgoFuga,
};

// Fase 8 (observabilidad): tipos de evento sin listener registrado quedan
// en estado 'pendiente' para siempre por diseño (ver comentario en
// despacharEvento) — es trazabilidad, no una cola atascada. Se detectó
// contra producción (2026-08-09) que el panel "Salud del sistema" no
// distinguía esto: 3 eventos pedido_facturado con 4+ días en 'pendiente'
// se veían igual que un evento realmente colgado. Se expone la lista para
// que lib/repos/observabilidad.js pueda anotarlos en vez de que el panel
// los muestre como si el despachador estuviera fallando.
export const TIPOS_EVENTO_SIN_LISTENER = Object.entries(REGISTRO_LISTENERS)
  .filter(([, listeners]) => listeners.length === 0)
  .map(([tipo]) => tipo);

// despacharReglasAutomatizacion() (Fase 6): evalúa las reglas que el propio
// cliente armó desde la UI (automatizacion.html) para este tipo de evento,
// además de los listeners de código fijo de arriba. Deliberadamente NO
// afecta el estado ('procesado'/'error') que despacharEvento() deja en
// eventos_negocio — ese estado sigue reflejando solo los listeners fijos,
// para no romper el contrato que ya prueban tests/handlers/eventos-
// dispatcher.test.js. Un error leyendo reglas, o una regla individual que
// falla, se loguea y no frena nada más (mismo criterio fire-and-forget que
// el resto del bus de eventos).
async function despacharReglasAutomatizacion(evento) {
  let reglas = [];
  try {
    reglas = await obtenerReglasActivas(evento.empresa_id, evento.tipo_evento);
  } catch (err) {
    console.error(`[EVENTOS] error leyendo reglas_automatizacion para evento ${evento.id}:`, err.message);
    return;
  }

  for (const regla of reglas) {
    try {
      if (evaluarCondicion(regla.condicion, evento.payload)) {
        await ejecutarAccion({ ...regla.accion, __regla_id: regla.id }, evento.payload, evento);
      }
    } catch (err) {
      console.error(`[EVENTOS] regla "${regla.nombre}" (${regla.id}) falló para evento ${evento.id}:`, err.message);
    }
  }
}

export async function despacharEvento(evento) {
  const listeners = REGISTRO_LISTENERS[evento.tipo_evento] || [];

  // Fase 6: las reglas de automatización corren siempre, incluso para
  // tipos de evento sin listeners fijos migrados todavía — son dos
  // mecanismos independientes sobre el mismo bus.
  await despacharReglasAutomatizacion(evento);

  if (!listeners.length) {
    // Tipo de evento sin listeners migrados todavía — no se toca el
    // evento (queda 'pendiente' tal cual llegó).
    return { ok: true, listeners: 0 };
  }

  const resultados = await Promise.allSettled(
    listeners.map(listener => listener(evento.payload, evento))
  );

  const errores = [];
  resultados.forEach((resultado, i) => {
    if (resultado.status === 'rejected') {
      const nombreListener = listeners[i].listenerNombre || listeners[i].name || `listener_${i}`;
      errores.push({ listener: nombreListener, error: resultado.reason?.message || String(resultado.reason) });
      console.error(
        `[EVENTOS] listener "${nombreListener}" falló para evento ${evento.id} (${evento.tipo_evento}):`,
        resultado.reason
      );
    }
  });

  const ok = errores.length === 0;
  // intentos ya viene incrementado por el claim atómico de
  // despacharPendientes() antes de llamar acá; si despacharEvento() se
  // invoca directo (ver tests / despacho inmediato de un evento recién
  // insertado, que no pasa por el claim) evento.intentos puede ser
  // undefined — se lo trata como 1 (este es el primer y único intento).
  const intentosFinal = (evento.intentos ?? 0) || 1;
  const ultimoError = ok ? null : (errores[0]?.error || null);

  const { error: updateError } = await supabase
    .from('eventos_negocio')
    .update({
      estado: ok ? 'procesado' : 'error',
      procesado_en: new Date().toISOString(),
      procesando_desde: null,
      intentos: intentosFinal,
      ultimo_error: ultimoError ? String(ultimoError).slice(0, 500) : null,
    })
    .eq('id', evento.id);

  if (updateError) {
    console.error(`[EVENTOS] no se pudo actualizar el estado del evento ${evento.id}:`, updateError);
  }

  return { ok, listeners: listeners.length, errores };
}

// SYNC-06: reclama HASTA `limite` eventos elegibles con un UPDATE
// condicional por fila (no un SELECT seguido de un loop) — cada claim solo
// afecta la fila si sigue en el estado que se leyó momentos antes, así que
// dos barridos concurrentes no pueden quedarse los dos con el mismo
// evento: el segundo en llegar encuentra 0 filas afectadas y lo descarta.
// Eventos 'procesando' cuyo lease venció (worker caído a mitad de camino)
// también son candidatos, tratados igual que si fueran 'pendiente'.
async function reclamarEventos({ empresaId, limite, incluirErrores }) {
  const leaseVencidoAntes = new Date(Date.now() - EVENTOS_LEASE_MS).toISOString();

  const estadosCandidatos = incluirErrores ? ['pendiente', 'error'] : ['pendiente'];

  let query = supabase
    .from('eventos_negocio')
    .select('*')
    .order('creado_en')
    .limit(limite * 3); // margen: algunos candidatos pueden perder la carrera del claim.

  if (empresaId) query = query.eq('empresa_id', empresaId);

  // OR manual porque combina condiciones distintas por estado (error con
  // tope de intentos, procesando con lease vencido) que un solo .in() no
  // puede expresar.
  const filtroOr = [
    `estado.in.(${estadosCandidatos.join(',')})`,
    `and(estado.eq.procesando,procesando_desde.lt.${leaseVencidoAntes})`,
  ].join(',');
  query = query.or(filtroOr);

  const { data: candidatos, error } = await query;
  if (error) {
    console.error('[EVENTOS] error leyendo eventos candidatos:', error);
    return { eventos: [], error: error.message };
  }

  const reclamados = [];
  for (const candidato of (candidatos || [])) {
    if (reclamados.length >= limite) break;

    // Los 'error' que ya agotaron el tope de reintentos quedan como
    // dead-letter: no se reclaman aunque incluirErrores=true los haya
    // traído en el SELECT de arriba.
    if (candidato.estado === 'error' && (candidato.intentos || 0) >= EVENTOS_MAX_INTENTOS) continue;

    const nuevosIntentos = (candidato.intentos || 0) + 1;
    const { data: ganado, error: claimError } = await supabase
      .from('eventos_negocio')
      .update({ estado: 'procesando', procesando_desde: new Date().toISOString(), intentos: nuevosIntentos })
      .eq('id', candidato.id)
      .eq('estado', candidato.estado) // condición de carrera: solo si sigue como lo leímos
      .select('*')
      .maybeSingle();

    if (claimError) {
      console.error(`[EVENTOS] error reclamando evento ${candidato.id}:`, claimError);
      continue;
    }
    if (ganado) reclamados.push(ganado);
  }

  return { eventos: reclamados };
}

export async function despacharPendientes({ empresaId, limite = 20, incluirErrores = false } = {}) {
  const { eventos, error } = await reclamarEventos({ empresaId, limite, incluirErrores });

  if (error) {
    return { ok: false, procesados: 0, error };
  }

  let procesados = 0;
  let conError = 0;
  for (const evento of eventos) {
    const resultado = await despacharEvento(evento);
    procesados++;
    if (!resultado.ok) conError++;
  }

  return { ok: conError === 0, procesados, conError };
}
