// lib/repos/clientes-fuga.js
// Fase 2 de PLAN_CLIENTES_EN_FUGA.md: acceso a datos para el listener
// `cliente_en_riesgo_fuga` (lib/eventos-listeners/cliente_en_riesgo_fuga.js).
// Mismo criterio que el resto de los listeners de eventos_negocio
// (cliente_en_mora, cheques_por_vencer): el payload del evento viaja
// liviano (ids + valores ya calculados por fn_clientes_en_fuga), y este
// repo resuelve de nuevo contra las tablas reales lo que hace falta para
// actuar — no confía en lo que viajó en el payload para nada que importe
// (teléfono, vendedor, umbral de empresa).

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';

const supabase = crearClienteSupabaseLazy(() => [
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
]);

// Umbral default de "cliente grande" para la Fase 2.2 (tarea al vendedor
// en vez de WhatsApp automático) cuando la empresa no configuró el suyo.
// Mismo valor que ya quedó documentado en el plan y validado con Matías:
// $600.000/año.
const UMBRAL_CLIENTE_GRANDE_DEFAULT = 600000;

/**
 * Resuelve los datos del cliente que el listener necesita para decidir y
 * ejecutar la recuperación — mismo criterio que resolverCliente() en
 * cliente_en_mora.js: solo por id, sin filtrar por empresa acá (el
 * evento ya viene scopeado por tenant desde eventos_negocio, y
 * evento.empresa_id es la fuente de verdad que usa el listener, no lo
 * que devuelva esta consulta).
 */
export async function resolverClienteParaFuga(clienteId) {
  const { data, error } = await supabase
    .from('clientes')
    .select('id, razon_social, telefono, vendedor_id_default')
    .eq('id', clienteId)
    .maybeSingle();

  return { data, error };
}

/**
 * Lee empresas.config->>'fuga_umbral_cliente_grande' (numérico, en
 * pesos/año) — mismo patrón de acceso a config que ya usan
 * captura-competencia.js/prospectos-competencia.js/rutas-live.js. Si la
 * empresa no lo configuró, o el valor guardado no es un número válido,
 * se usa el default. Un error de red/consulta también cae al default en
 * vez de tirar — el umbral es una preferencia, no algo que deba frenar
 * la clasificación del cliente.
 */
export async function resolverUmbralClienteGrande(empresaId) {
  try {
    const { data, error } = await supabase
      .from('empresas')
      .select('config')
      .eq('id', empresaId)
      .maybeSingle();

    if (error || !data) return UMBRAL_CLIENTE_GRANDE_DEFAULT;

    const crudo = data.config?.fuga_umbral_cliente_grande;
    const num = Number(crudo);
    return Number.isFinite(num) && num > 0 ? num : UMBRAL_CLIENTE_GRANDE_DEFAULT;
  } catch {
    return UMBRAL_CLIENTE_GRANDE_DEFAULT;
  }
}

/**
 * Crea una tarea dirigida (tareas_automatizacion.usuario_id, migración
 * 593) para el vendedor puntual del cliente en fuga — y siempre deja
 * también roles ['dueno','admin'] para que la vea el dueño de la empresa
 * si el cliente no tenía vendedor asignado (usuario_id null) o si el
 * dueño igual quiere verlas todas. evento_disparador queda fijo en
 * 'cliente_en_riesgo_fuga' — no es una tarea de una regla_id de usuario
 * (regla_id null), es del listener de código fijo. cliente_id (migración
 * 594, Fase 3) es lo que le permite a la pantalla de clientes en fuga
 * saber que a ESTE cliente puntual ya se le disparó una tarea.
 */
export async function crearTareaFuga({ empresa_id, usuario_id, cliente_id, titulo, descripcion }) {
  const { data, error } = await supabase
    .from('tareas_automatizacion')
    .insert({
      empresa_id,
      regla_id: null,
      evento_disparador: 'cliente_en_riesgo_fuga',
      titulo,
      descripcion: descripcion || null,
      roles: ['dueno', 'admin'],
      usuario_id: usuario_id || null,
      cliente_id: cliente_id || null,
      estado: 'pendiente',
    })
    .select('id')
    .single();

  if (error) throw new Error(`[ClientesFugaRepo.crearTarea] ${error.message}`);
  return data;
}

/**
 * Cooldown real del aviso de fuga (nota 1.3/2.3 del plan: "no mandar el
 * mismo aviso todos los días") — a diferencia de `ultimoEnvioPorCliente`
 * (lib/repos/notif.js), que solo mira `notif_log`, acá se toma el máximo
 * entre las DOS tablas donde puede haber quedado registro de un aviso ya
 * disparado para este cliente:
 *   - notif_log (tipo='cliente_en_riesgo_fuga', canal='whatsapp') — camino 3
 *     del listener (chico/mediano, WhatsApp automático).
 *   - tareas_automatizacion (evento_disparador='cliente_en_riesgo_fuga') —
 *     caminos 1 y 2 del listener (deuda / cliente grande), que NUNCA pasan
 *     por notif_log porque no mandan WhatsApp. Sin este chequeo,
 *     handleFugaCron volvía a emitir el evento todos los días para esos dos
 *     caminos y el vendedor terminaba con una tarea duplicada por día
 *     mientras el cliente siguiera en fuga.
 * Devuelve la fecha más reciente entre ambas fuentes, o null si no hay
 * ningún aviso previo.
 */
export async function ultimoAvisoFuga(clienteId) {
  const [{ data: wa }, { data: tarea }] = await Promise.all([
    supabase
      .from('notif_log')
      .select('created_at')
      .eq('cliente_id', clienteId)
      .eq('tipo', 'cliente_en_riesgo_fuga')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('tareas_automatizacion')
      .select('created_at')
      .eq('cliente_id', clienteId)
      .eq('evento_disparador', 'cliente_en_riesgo_fuga')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const fechas = [wa?.created_at, tarea?.created_at].filter(Boolean);
  if (!fechas.length) return null;
  return fechas.reduce((max, f) => (new Date(f) > new Date(max) ? f : max));
}

// ── Fase 3 — pantalla "Clientes en fuga" ────────────────────────────────

/**
 * Wrapper delgado sobre la RPC fn_clientes_en_fuga (590/591/592) — EXECUTE
 * revocado para authenticated/anon, solo service_role (mismo criterio que
 * v_cobranza_priorizada, ver comentario en clientes-fuga.js handler).
 * Usado tanto por handleFugaCron (lib/handlers/notif.js) como por
 * listarClientesEnFuga de acá abajo — se devuelve {data, error} crudo
 * (sin throw) porque handleFugaCron necesita distinguir el error por
 * empresa sin cortar el loop de todas las demás.
 */
export async function clientesEnFugaRpc(empresaId, limite = 50) {
  return await supabase.rpc('fn_clientes_en_fuga', {
    p_empresa_id: empresaId,
    p_limite: limite,
  });
}

/**
 * Fase 3 de PLAN_CLIENTES_EN_FUGA.md: la lista para la pantalla, enriquecida
 * con qué acción ya se disparó para cada cliente — no solo la detección
 * cruda de fn_clientes_en_fuga. Dos fuentes, ambas acotadas a los
 * cliente_id de la página (nunca N+1: un select con `.in()` por fuente):
 *   - tareas_automatizacion (cliente_id, migración 594) — camino 1/2 del
 *     listener (deuda / cliente grande): tarea pendiente o completada.
 *   - notif_log (tipo='cliente_en_riesgo_fuga', canal='whatsapp') — camino
 *     3 del listener (WhatsApp automático a cliente chico/mediano).
 * Si un cliente tiene ambas (no debería pasar — el listener elige un solo
 * camino por evento — pero sí puede pasar entre eventos de fechas
 * distintas), gana la más reciente.
 */
export async function listarClientesEnFuga(empresaId, { soloVendedorId } = {}) {
  const { data, error } = await clientesEnFugaRpc(empresaId, 200);
  if (error) throw new Error(`[ClientesFugaRepo.listar] ${error.message}`);

  let clientes = data?.clientes || [];
  if (soloVendedorId) {
    clientes = clientes.filter((c) => c.vendedor_id_default === soloVendedorId);
  }

  const base = {
    total_clientes_en_fuga: data?.total_clientes_en_fuga || 0,
    valor_anual_total_en_riesgo: data?.valor_anual_total_en_riesgo || 0,
  };

  if (!clientes.length) {
    return { ...base, clientes_mostrados: 0, clientes: [] };
  }

  const clienteIds = clientes.map((c) => c.cliente_id);

  const [{ data: whatsapps }, { data: tareas }] = await Promise.all([
    supabase
      .from('notif_log')
      .select('cliente_id, created_at')
      .eq('tipo', 'cliente_en_riesgo_fuga')
      .eq('canal', 'whatsapp')
      .in('cliente_id', clienteIds)
      .order('created_at', { ascending: false }),
    supabase
      .from('tareas_automatizacion')
      .select('cliente_id, estado, created_at')
      .eq('empresa_id', empresaId)
      .eq('evento_disparador', 'cliente_en_riesgo_fuga')
      .in('cliente_id', clienteIds)
      .order('created_at', { ascending: false }),
  ]);

  // `.order()` + primer match de cada Map ⇒ el más reciente por cliente,
  // sin necesitar una sub-consulta agregada.
  const ultimaTareaPorCliente = new Map();
  for (const t of tareas || []) {
    if (!ultimaTareaPorCliente.has(t.cliente_id)) ultimaTareaPorCliente.set(t.cliente_id, t);
  }
  const ultimoWaPorCliente = new Map();
  for (const w of whatsapps || []) {
    if (!ultimoWaPorCliente.has(w.cliente_id)) ultimoWaPorCliente.set(w.cliente_id, w.created_at);
  }

  const enriquecidos = clientes.map((c) => {
    const tarea = ultimaTareaPorCliente.get(c.cliente_id);
    const waFecha = ultimoWaPorCliente.get(c.cliente_id);

    // Si hay ambas señales, gana la más reciente (ver nota del jsdoc).
    let accion_disparada = 'sin_accion';
    let accion_fecha = null;
    if (tarea && (!waFecha || tarea.created_at >= waFecha)) {
      accion_disparada = tarea.estado === 'completada' ? 'tarea_completada' : 'tarea_pendiente';
      accion_fecha = tarea.created_at;
    } else if (waFecha) {
      accion_disparada = 'whatsapp_enviado';
      accion_fecha = waFecha;
    }

    return { ...c, accion_disparada, accion_fecha };
  });

  return { ...base, clientes_mostrados: enriquecidos.length, clientes: enriquecidos };
}
