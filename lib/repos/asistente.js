// lib/repos/asistente.js
// Acceso a datos del Asistente de ayuda interno (chatbot RAG + tools).
// Migrado desde lib/handlers/asistente.js — mismo criterio que los demás
// repos: acá solo queda I/O contra Supabase (tablas `asistente_uso`,
// `asistente_conversaciones`, `asistente_mensajes` y el RPC
// buscar_articulos_asistente). La lógica de embeddings, el armado del
// prompt y la orquestación de proveedores (Gemini/Groq/OpenRouter) no son
// acceso a base de datos y se quedan en el handler.

import { db } from './_db.js';

export async function contarUsosAsistenteDesde(usuario_id, desdeIso) {
  return db
    .from('asistente_uso')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', usuario_id)
    .gte('creado_en', desdeIso);
}

export async function obtenerConversacionSiVigente(conversacion_id, usuario_id) {
  return db
    .from('asistente_conversaciones')
    .select('id, actualizado_en')
    .eq('id', conversacion_id)
    .eq('usuario_id', usuario_id) // nunca reusar la conversación de otro usuario
    .maybeSingle();
}

export async function crearConversacion({ usuario_id, empresa_id }) {
  return db
    .from('asistente_conversaciones')
    .insert({ usuario_id, empresa_id })
    .select('id')
    .single();
}

export async function listarUltimosMensajes(conversacion_id, limite) {
  return db
    .from('asistente_mensajes')
    .select('rol, contenido, creado_en')
    .eq('conversacion_id', conversacion_id)
    .order('creado_en', { ascending: false })
    .limit(limite);
}

export async function insertarMensajes(filas) {
  return db.from('asistente_mensajes').insert(filas);
}

export async function tocarConversacion(conversacion_id) {
  return db
    .from('asistente_conversaciones')
    .update({ actualizado_en: new Date().toISOString() })
    .eq('id', conversacion_id);
}

export async function buscarArticulosAsistenteRpc({ query_embedding, p_rol, match_count, match_threshold }) {
  return db.rpc('buscar_articulos_asistente', {
    query_embedding,
    p_rol,
    match_count,
    match_threshold,
  });
}

// Fase 1 del plan de robustez conversacional (corrección sin reiniciar).
// Trae la última propuesta 'pendiente' de la conversación, si existe.
// El TTL (¿sigue vigente o ya venció?) lo evalúa el handler con
// TTL_CONFIRMACION_MS — acá solo se devuelve la fila más reciente en
// estado 'pendiente', igual criterio que usa resolverAccionPendiente()
// en lib/asistente-tools/index.js para resolver la misma tabla.
export async function obtenerAccionPendienteVigente(conversacion_id) {
  return db
    .from('asistente_acciones_pendientes')
    .select('id, tool_nombre, tool_args, resumen, estado, creado_en')
    .eq('conversacion_id', conversacion_id)
    .eq('estado', 'pendiente')
    .order('creado_en', { ascending: false })
    .limit(1)
    .maybeSingle();
}

// conversacion_id y tools_usadas: Capa 3 de PLAN_QA_ASISTENTE.md
// (migración 600). conversacion_id es opcional (NULL en el flujo de
// "primera pregunta sin historial" si el llamador no lo tiene todavía);
// tools_usadas default [] para no romper llamadores viejos que no lo pasen.
export async function insertarUsoAsistente({
  usuario_id,
  empresa_id,
  pregunta,
  proveedor_usado,
  articulos_encontrados,
  latencia_ms,
  conversacion_id = null,
  tools_usadas = [],
}) {
  return db.from('asistente_uso').insert({
    usuario_id,
    empresa_id,
    pregunta,
    proveedor_usado,
    articulos_encontrados,
    latencia_ms,
    conversacion_id,
    tools_usadas,
  });
}
