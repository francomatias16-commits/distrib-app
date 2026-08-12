// lib/reglas-automatizacion.js
// PLAN_ERP_SINCRONIZACION_2026.md — Fase 6: motor de automatización sobre
// el bus de eventos (eventos_negocio / eventos-dispatcher.js).
//
// A diferencia de los listeners de código fijo (lib/eventos-listeners/*),
// estas son reglas que el propio cliente arma desde la UI
// (frontend/admin/automatizacion.html, sección "Reglas personalizadas"):
// "cuando pase X, si se cumple esta condición, hacé esta acción".
//
// Tabla: reglas_automatizacion (migración 432_fase6_reglas_automatizacion.sql).
//
// Este módulo expone:
//   - obtenerReglasActivas(empresaId, tipoEvento) → lee las reglas activas
//     de esa empresa para ese tipo de evento.
//   - evaluarCondicion(condicion, payload) → true/false. FAIL-CLOSED: ante
//     cualquier condición mal armada (operador desconocido, campo
//     faltante), no matchea — nunca se dispara una acción "por las dudas".
//   - ejecutarAccion(accion, payload, evento) → corre la acción de la
//     regla. MVP: un solo tipo soportado, 'notificar_push'.
//
// El CRUD de administración (listar/crear/editar/activar/eliminar reglas
// desde la UI) vive aparte, en lib/repos/reglas-automatizacion.js +
// lib/handlers/reglas-automatizacion.js — este archivo es solo el motor
// de evaluación/ejecución que corre en tiempo real desde el despachador.

import { crearClienteSupabaseLazy } from './supabase-lazy.js';
import { enviarPush } from './handlers/_push.js';

const supabase = crearClienteSupabaseLazy(() => [
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
]);

// Mismo default que el resto del panel usa para alertas críticas (ver
// automatizacion.html: push-prefs por defecto todas activas para
// dueño/admin) — una regla sin roles especificados avisa a quienes
// administran la empresa, no a todo el mundo.
const ROLES_DEFAULT_NOTIFICACION = ['dueno', 'admin'];

// Catálogo de templates de WhatsApp habilitados para la acción
// 'enviar_whatsapp' de una regla. Debe coincidir con
// TEMPLATES_WHATSAPP_DISPONIBLES en lib/repos/reglas-automatizacion.js
// (validación al guardar la regla) y con WA_TEMPLATE_LABELS en
// frontend/admin/js/automatizacion.js (opciones del selector). Son los
// mismos templates ya aprobados en Meta que usa el resto del sistema de
// WhatsApp (pedidos, cobranzas, chofer).
const TEMPLATES_WHATSAPP_DISPONIBLES = [
  'confirmacion_pedido',
  'pedido_despachado',
  'pedido_cancelado',
  'deuda_vencida',
  'pedido_entregado',
  'pedido_no_entregado',
  'pedido_por_llegar',
  'cheques_por_vencer',
  'oferta_plan_pago',
  'ruta_asignada',
];

/**
 * Trae las reglas activas de una empresa para un tipo de evento puntual.
 * Se llama una vez por evento despachado (eventos-dispatcher.js), así que
 * se apoya en el índice (empresa_id, evento_disparador, activa) de la
 * migración 432.
 */
export async function obtenerReglasActivas(empresaId, tipoEvento) {
  const { data, error } = await supabase
    .from('reglas_automatizacion')
    .select('*')
    .eq('empresa_id', empresaId)
    .eq('evento_disparador', tipoEvento)
    .eq('activa', true);

  if (error) throw new Error(`[ReglasAutomatizacion.obtenerActivas] ${error.message}`);
  return data || [];
}

// Lee un campo del payload admitiendo notación con puntos ("cliente.zona")
// para poder condicionar sobre payloads anidados sin tener que aplanarlos
// del lado de quien emite el evento.
function leerCampo(payload, campo) {
  if (!campo || typeof campo !== 'string') return undefined;
  return campo.split('.').reduce(
    (acc, clave) => (acc === null || acc === undefined ? undefined : acc[clave]),
    payload
  );
}

const OPERADORES = {
  '=':  (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>':  (a, b) => Number(a) > Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<':  (a, b) => Number(a) < Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
};

/**
 * Evalúa la condición JSON de una regla contra el payload del evento.
 *
 * Formatos soportados:
 *   {}                                          → siempre matchea
 *   { campo, operador, valor }                   → comparación simple
 *   { y: [condicion, condicion, ...] }            → todas deben cumplirse
 *   { o: [condicion, condicion, ...] }            → alguna debe cumplirse
 *
 * FAIL-CLOSED: operador desconocido, campo faltante, o cualquier otra
 * forma no reconocida → false. Una regla mal armada nunca dispara una
 * acción "por si acaso" — se ignora en silencio (el llamador puede
 * loguearlo si quiere).
 */
export function evaluarCondicion(condicion, payload) {
  if (!condicion || typeof condicion !== 'object' || Object.keys(condicion).length === 0) {
    return true;
  }

  if (Array.isArray(condicion.y)) {
    return condicion.y.every((c) => evaluarCondicion(c, payload));
  }
  if (Array.isArray(condicion.o)) {
    return condicion.o.some((c) => evaluarCondicion(c, payload));
  }

  const { campo, operador, valor } = condicion;
  if (!campo || !operador) return false; // fail-closed

  const comparar = OPERADORES[operador];
  if (!comparar) return false; // fail-closed: operador no reconocido

  const valorReal = leerCampo(payload, campo);
  if (valorReal === undefined) return false;

  try {
    return !!comparar(valorReal, valor);
  } catch {
    return false; // fail-closed ante cualquier comparación que reviente
  }
}

/**
 * Ejecuta la acción de una regla ya matcheada.
 *
 * MVP: único tipo soportado 'notificar_push' — manda una notificación push
 * a los usuarios de la empresa con alguno de los roles indicados (default
 * dueño/admin). Otros tipos ('enviar_whatsapp', 'crear_tarea', etc.) quedan
 * para una fase siguiente; acá tiran un error explícito para que quede
 * claro en los logs que la regla no se ejecutó, en vez de fallar en
 * silencio.
 */
export async function ejecutarAccion(accion, payload, evento) {
  const tipo = accion?.tipo;
  if (!tipo) {
    throw new Error('La acción no tiene "tipo"');
  }

  if (tipo === 'notificar_push') {
    const roles = Array.isArray(accion.roles) && accion.roles.length
      ? accion.roles
      : ROLES_DEFAULT_NOTIFICACION;

    const { data: usuarios, error } = await supabase
      .from('usuarios')
      .select('id')
      .eq('empresa_id', evento.empresa_id)
      .in('rol', roles);

    if (error) throw new Error(`[ReglasAutomatizacion.ejecutarAccion] ${error.message}`);

    const titulo  = accion.titulo  || 'Alerta automática';
    const mensaje = accion.mensaje || 'Se disparó una regla de automatización';

    await Promise.allSettled(
      (usuarios || []).map((u) => enviarPush(
        u.id,
        titulo,
        mensaje,
        { tipo_evento: evento.tipo_evento, regla_id: accion.__regla_id || null },
        { empresa_id: evento.empresa_id }
      ))
    );

    return { ok: true, notificados: (usuarios || []).length };
  }

  if (tipo === 'enviar_whatsapp') {
    return ejecutarAccionWhatsapp(accion, payload, evento);
  }

  if (tipo === 'crear_tarea') {
    return ejecutarAccionCrearTarea(accion, evento);
  }

  throw new Error(`Tipo de acción "${tipo}" no soportado`);
}

// URL base para llamar al propio backend (server-to-server) desde acá.
// En Vercel, VERCEL_URL no trae protocolo. Se puede pisar con
// APP_BASE_URL si hace falta apuntar a otro entorno.
function resolverUrlBase() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

async function ejecutarAccionWhatsapp(accion, payload, evento) {
  const template = accion?.template;
  if (!template || !TEMPLATES_WHATSAPP_DISPONIBLES.includes(template)) {
    throw new Error(`Template de WhatsApp "${template}" no reconocido`);
  }

  const clienteId = payload?.cliente_id;
  if (!clienteId) {
    throw new Error('El evento no tiene "cliente_id" en el payload, no se puede enviar el WhatsApp');
  }

  const { data: cliente, error } = await supabase
    .from('clientes')
    .select('id, razon_social, telefono')
    .eq('id', clienteId)
    .eq('empresa_id', evento.empresa_id)
    .maybeSingle();

  if (error) throw new Error(`[ReglasAutomatizacion.enviarWhatsapp] ${error.message}`);
  if (!cliente) throw new Error('Cliente no encontrado para enviar el WhatsApp');
  if (!cliente.telefono) throw new Error(`El cliente "${cliente.razon_social}" está sin teléfono cargado`);

  const params = { ...(accion.params || {}), nombre_cliente: cliente.razon_social };

  const resp = await fetch(`${resolverUrlBase()}/api/notif?tipo=whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template,
      telefono: cliente.telefono,
      empresa_id: evento.empresa_id,
      params,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error || 'Error enviando el WhatsApp');
  }

  return { ok: true, message_id: data.message_id };
}

async function ejecutarAccionCrearTarea(accion, evento) {
  const titulo = accion?.titulo && String(accion.titulo).trim();
  if (!titulo) {
    throw new Error('La tarea no tiene "titulo"');
  }

  const roles = Array.isArray(accion.roles) && accion.roles.length
    ? accion.roles
    : ROLES_DEFAULT_NOTIFICACION;

  const { data, error } = await supabase
    .from('tareas_automatizacion')
    .insert({
      empresa_id: evento.empresa_id,
      regla_id: accion.__regla_id || null,
      evento_disparador: evento.tipo_evento,
      titulo,
      descripcion: accion.descripcion ? String(accion.descripcion).trim() : null,
      roles,
      estado: 'pendiente',
    })
    .select('id')
    .single();

  if (error) throw new Error(`[ReglasAutomatizacion.crearTarea] ${error.message}`);

  return { ok: true, id: data.id };
}
