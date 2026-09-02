// lib/asistente-tools/index.js
// Orquestador del split de lib/asistente-tools.js (25/08/2026). Junta las
// 98 tools desde los módulos por dominio (mismo orden que el archivo
// original, para no cambiar ningún comportamiento de selección/orden), y
// reexpone el motor (schema, selección de tools relevantes, ejecución,
// confirmación) sin cambios. lib/asistente-tools.js (el archivo, no la
// carpeta) sigue siendo el punto de entrada público — ver ese archivo.

import { TOOLS_CLIENTES } from './clientes.js';
import { TOOLS_PEDIDOS } from './pedidos.js';
import { TOOLS_STOCK } from './stock.js';
import { TOOLS_POS } from './pos.js';
import { TOOLS_FACTURACION } from './facturacion.js';
import { TOOLS_COBRANZAS } from './cobranzas.js';
import { TOOLS_CHEQUES_BCRA } from './cheques-bcra.js';
import { TOOLS_PRECIOS } from './precios.js';
import { TOOLS_AUTOMATIZACION } from './automatizacion.js';
import { TOOLS_CONCILIACION_BANCARIA } from './conciliacion-bancaria.js';
import { TOOLS_NOTIFICACIONES } from './notificaciones.js';
import { TOOLS_PROVEEDORES } from './proveedores.js';
import { TOOLS_LOGISTICA } from './logistica.js';
import { TOOLS_ADMIN } from './admin.js';
import { TOOLS_EXPORT_CONTABLE } from './export-contable.js';
import { TOOLS_LIQUIDACION } from './liquidacion.js';

// lib/asistente-tools.js
//
// Catálogo de herramientas (function calling) del asistente de ayuda.
//
// Reemplaza el enfoque anterior de asistente-datos-vivos.js (regex a
// mano, 1 por pregunta) por tool calling real: el modelo recibe la
// lista de herramientas de abajo con su descripción y JSON Schema de
// parámetros, y decide él mismo cuál llamar (o ninguna) según la
// pregunta. Esto es lo que permite escalar a "cualquier consulta"
// sin agregar un regex nuevo por cada intención.
//
// Por qué sigue siendo seguro (mismo principio que el archivo que
// reemplaza): el modelo NUNCA arma SQL. Solo elige un nombre de una
// lista fija y un puñado de parámetros primitivos (texto, número,
// fecha) declarados en el schema. Cada handler de abajo llama SIEMPRE
// a una RPC ya escrita a mano, ya auditada, SECURITY DEFINER y
// scopeada por empresa_id — y el empresa_id nunca sale del modelo:
// lo inyecta el handler desde el perfil ya verificado (verificarToken()).
//
// Para agregar una herramienta nueva:
//   1. Escribir la RPC en Supabase (scopeada por p_empresa_id, revocada
//      de PUBLIC, otorgada a service_role — ver
//      203_asistente_tools_lectura.sql).
//   2. Agregar una entrada a TOOLS de abajo: name, description (en
//      español, clara, porque el modelo decide según esto), parameters
//      (JSON Schema), y execute().
//   3. NO agregar nada que reciba nombres de tabla/columna como
//      parámetro, ni que no filtre por empresa_id.
//
// Tools de ESCRITURA (hacen algo, no solo consultan) — DISTINTO de lo
// anterior, ver 419_asistente_acciones_pendientes.sql:
//   4. Marcar la entrada con `requiereConfirmacion: true`.
//   5. Agregar `async resumen({ empresaId, args })` que devuelva UNA
//      frase en texto plano, clara y específica, de lo que se va a
//      hacer (ej. "Anular la venta #A1B2C3 de $4.500 de Juan Pérez.
//      Esto no se puede deshacer."). Ese texto es lo único que ve el
//      usuario antes de tocar el botón Confirmar — tiene que alcanzar
//      para decidir sin adivinar nada.
//   6. `execute()` sigue siendo el que hace el cambio real — pero con
//      esta marca, ejecutarTool() JAMÁS lo llama directo: solo se llama
//      desde resolverAccionPendiente(), después del click de Confirmar
//      del usuario. Gemini nunca tiene la posibilidad de ejecutarla
//      él mismo en el mismo turno en que la "decide".

import { db } from '../repos/_db.js';
import {
  crearCliente as crearClienteRepo,
  actualizarCliente as actualizarClienteRepo,
  desactivarCliente as desactivarClienteRepo,
} from '../repos/clientes.js';
import * as AuditRepo from '../repos/audit.js';
import {
  crearPedidoParaCliente, ROLES_ADMIN as ROLES_PEDIDO,
  crearPresupuestoParaCliente, ROLES_ADMIN_PRES as ROLES_PRESUPUESTO,
  crearDevolucionCore,
} from '../handlers/pedidos.js';
import { procesarColaFinancieraEmpresa } from '../handlers/cierre.js';
import { generarSugerenciasPilotoEmpresa } from '../handlers/piloto.js';
import { analizarYGenerarOrdenes as analizarStockAutonomoEmpresa } from '../handlers/stock-auto.js';
import { recalcularScoreEmpresa } from '../handlers/score.js';
import { detectarYNotificar as detectarAnomaliasAuditoriaEmpresa } from '../handlers/auditoria.js';
import { generarExport } from '../export-contable/index.js';
import {
  listarInvitacionesChofer, invitarChoferNuevo, invitarChoferExistente,
  revocarInvitacionChofer, ROLES_GESTION as ROLES_CHOFER_INVITACION,
  APP_URL_FALLBACK,
} from '../handlers/chofer_invitacion.js';
import {
  listarSesionesMigracion, obtenerEstadoSesionMigracion, ROLES_MIGRACION,
} from '../handlers/migracion.js';
import {
  generarLinkPortalProveedor, listarLinksPortalProveedor,
  revocarLinkPortalProveedor, ROLES_ESCRITURA as ROLES_PORTAL_PROVEEDOR,
} from '../handlers/portal_proveedor.js';
import {
  listarUsuariosEquipo, ROLES_GESTION as ROLES_USUARIOS,
} from '../handlers/usuarios.js';
import {
  listarReglasPrecio, crearReglaPrecio, actualizarReglaPrecio,
} from '../repos/reglas-precio.js';
import {
  listarReglasAutomatizacion, crearReglaAutomatizacion, actualizarReglaAutomatizacion,
} from '../repos/reglas-automatizacion.js';
import {
  listarOfertasActivas as listarOfertasLiquidacion,
  obtenerReglas as obtenerReglasLiquidacion,
  guardarReglas as guardarReglasLiquidacion,
} from '../repos/stock.js';

import { TTL_CONFIRMACION_MS, EVENTOS_DISPONIBLES_ASISTENTE, EVENTOS_LABELS_ASISTENTE, TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE, ROLES_NOTIFICACION_VALIDOS } from './_constantes.js';

const TOOLS = [
  ...TOOLS_CLIENTES,
  ...TOOLS_PEDIDOS,
  ...TOOLS_STOCK,
  ...TOOLS_POS,
  ...TOOLS_FACTURACION,
  ...TOOLS_COBRANZAS,
  ...TOOLS_CHEQUES_BCRA,
  ...TOOLS_PRECIOS,
  ...TOOLS_AUTOMATIZACION,
  ...TOOLS_CONCILIACION_BANCARIA,
  ...TOOLS_NOTIFICACIONES,
  ...TOOLS_PROVEEDORES,
  ...TOOLS_LOGISTICA,
  ...TOOLS_ADMIN,
  ...TOOLS_EXPORT_CONTABLE,
  ...TOOLS_LIQUIDACION,
];

function toolsParaRol(rol) {
  return TOOLS.filter((t) => !Array.isArray(t.roles) || t.roles.includes(rol));
}

/** Formato que espera la API de Gemini para declarar funciones (function_declarations). */
function esquemaParaGemini(rol) {
  return toolsParaRol(rol).map((t) => ({
    name: t.name,
    description: t.requiereConfirmacion
      // El modelo tiene que saber, desde la descripción misma, que llamar
      // esta función NO ejecuta nada todavía — así no le promete al
      // usuario "listo, ya lo anulé" antes de que exista la confirmación.
      ? `${t.description} IMPORTANTE: llamar esta función solo PROPONE la acción, no la ejecuta. El resultado te va a dar un resumen que tenés que mostrarle tal cual al usuario pidiéndole que confirme con el botón — nunca digas que ya se hizo, y nunca vuelvas a llamar esta función para la misma acción.`
      : t.description,
    parameters: t.parameters,
  }));
}

// FIX (v514): Groq y OpenRouter usan la API "Chat Completions" (formato
// OpenAI), que declara funciones distinto a Gemini — envueltas en
// { type: 'function', function: {...} } en vez de una lista plana. Antes
// esos dos proveedores no recibían tools en absoluto (ver comentario
// viejo más abajo en asistente-providers.js): con la cuota gratuita de
// Gemini agotándose rápido, eso significaba que apenas Gemini fallaba el
// asistente dejaba de poder consultar datos reales de la cuenta. Ahora
// Groq (gratis, ~1000 solicitudes/día para el modelo de texto configurado
// en GROQ_MODEL — ver FIX v520 en asistente-providers.js para el modelo
// vigente, que sí soporta tool calling) y OpenRouter (con el router `openrouter/free`, que
// elige automáticamente un modelo gratuito compatible con tool calling)
// también pueden ejecutar las mismas tools — mismo texto de `description`
// que ve Gemini, mismo `parameters` (ambos formatos usan JSON Schema).
// FIX (v518): el filtro por rol (v517) no alcanza para dueno/admin — ven
// las 68 tools igual, porque su `roles` las incluye casi todas. Para esos
// roles, el esquema completo YA pesa ~13.860 tokens estimados él solo,
// por encima del límite de 12.000 TPM de Groq, sin sumar system prompt,
// artículos ni historial. Acá se agrega una segunda pasada, aplicada solo
// para los proveedores con ese límite chico (Groq/OpenRouter — ver
// esquemaParaOpenAI más abajo): de las tools que el rol puede ver, se
// seleccionan solo las relevantes para ESA pregunta puntual por
// coincidencia de palabras clave (nombre de la tool pesa más que la
// descripción), con un tope duro de tools declaradas. Si la pregunta es
// tan genérica que no matchea ninguna palabra con ninguna tool (ej. "hola,
// ¿cómo estás?"), se cae a un set "núcleo" curado con las tools de
// consulta más pedidas, para no dejar al asistente sin ninguna
// herramienta en ese caso.
//
// Gemini NO pasa por este segundo filtro: su falla observada fue 429 de
// cuota diaria, no un límite de tamaño de request — reducirle el catálogo
// no resuelve nada ahí y sí le sacaría capacidad real sin necesidad.

const TOOLS_MAX_PROVEEDOR_TPM_CHICO = 20;

const TOOLS_NUCLEO_FALLBACK = [
  'contar_pedidos_pendientes',
  'listar_pedidos_pendientes',
  'consultar_stock_critico',
  'consultar_analisis_stock_predictivo',
  'listar_cheques_alerta',
  'consultar_deuda_proveedor',
  'listar_facturas_proveedor_por_vencer',
  'listar_lotes_por_vencer',
  'consultar_bloqueo_cliente',
  'consultar_ruta_dia',
  'diagnosticar_pedido',
  'diagnosticar_venta_pos',
  'consultar_cuenta_corriente_proveedor',
  'consultar_cola_financiera_pendiente',
  'consultar_datos_empresa',
];

const STOPWORDS_PREGUNTA = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'a', 'en',
  'por', 'para', 'que', 'con', 'sin', 'sobre', 'me', 'te', 'se', 'su', 'sus', 'mi', 'mis',
  'tu', 'tus', 'al', 'lo', 'le', 'les', 'es', 'son', 'esta', 'este', 'estan', 'como', 'cual',
  'cuales', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'dame', 'decime', 'pasame', 'porfa',
  'favor', 'podes', 'puedes', 'quiero', 'quisiera', 'necesito', 'tengo', 'hay', 'todo',
  'todos', 'toda', 'todas', 'perdon', 'digo',
]);

// Normaliza a minúsculas sin tildes y separa en palabras "significativas"
// (largo >= 3, sin stopwords). No es un tokenizador lingüístico real: es
// deliberadamente simple, a propósito de que solo tiene que aproximar
// coincidencias tool-pregunta, no entender la pregunta.
function palabrasSignificativas(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length >= 3 && !STOPWORDS_PREGUNTA.has(p))
    .map(raizAproximada);
}

// Achica plurales/variantes simples ("pedidos" -> "pedido", "facturas" ->
// "factura") para que matcheen contra el singular usado en los nombres de
// tools. Heurística a propósito, no un stemmer real.
function raizAproximada(palabra) {
  if (palabra.length > 5 && palabra.endsWith('es')) return palabra.slice(0, -2);
  if (palabra.length > 4 && palabra.endsWith('s')) return palabra.slice(0, -1);
  return palabra;
}

function seleccionarToolsRelevantes(toolsDelRol, pregunta) {
  const palabrasPregunta = new Set(palabrasSignificativas(pregunta));

  const puntuadas = toolsDelRol.map((t) => {
    const palabrasNombre = new Set(t.name.split('_').map(raizAproximada));
    const palabrasDesc = new Set(palabrasSignificativas(t.description));
    let score = 0;
    for (const p of palabrasPregunta) {
      if (palabrasNombre.has(p)) score += 3; // coincidencia en el nombre pesa más
      else if (palabrasDesc.has(p)) score += 1;
    }
    return { t, score };
  });

  const conMatch = puntuadas.filter((p) => p.score > 0).sort((a, b) => b.score - a.score);

  if (conMatch.length === 0) {
    return TOOLS_NUCLEO_FALLBACK
      .map((nombre) => toolsDelRol.find((t) => t.name === nombre))
      .filter(Boolean)
      .slice(0, TOOLS_MAX_PROVEEDOR_TPM_CHICO);
  }

  return conMatch.slice(0, TOOLS_MAX_PROVEEDOR_TPM_CHICO).map((p) => p.t);
}

function esquemaParaOpenAI(rol, pregunta) {
  const toolsDelRol = toolsParaRol(rol);
  const toolsAEnviar = pregunta ? seleccionarToolsRelevantes(toolsDelRol, pregunta) : toolsDelRol;
  return toolsAEnviar.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.requiereConfirmacion
        ? `${t.description} IMPORTANTE: llamar esta función solo PROPONE la acción, no la ejecuta. El resultado te va a dar un resumen que tenés que mostrarle tal cual al usuario pidiéndole que confirme con el botón — nunca digas que ya se hizo, y nunca vuelvas a llamar esta función para la misma acción.`
        : t.description,
      parameters: t.parameters,
    },
  }));
}

async function ejecutarTool(nombre, { empresaId, rol, usuarioId, conversacionId, args }) {
  const tool = TOOLS.find((t) => t.name === nombre);
  if (!tool) throw new Error(`Tool desconocida: ${nombre}`);
  if (!empresaId) throw new Error('No hay empresa asociada al usuario, no se puede ejecutar la tool');

  // ASISTENTE-001 (auditoría 2026-07-26): el chat-widget se inyecta en TODAS
  // las pantallas del admin (ver nav.js) sin distinguir rol, y hasta acá las
  // tools de este archivo solo validaban empresa_id — nunca el rol de negocio
  // del caller. Resultado: un vendedor/contador/depositero podía preguntarle
  // al asistente por datos que su propio menú (nav-data.js) le oculta en la
  // UI — ej. un vendedor sin acceso a "Proveedores"/"Cheques" podía obtener
  // esos mismos datos por chat. `roles` en cada tool replica exactamente los
  // roles que ya tienen esa pantalla habilitada en nav-data.js. Tools sin
  // `roles` definido (ninguna sensible a día de hoy) quedan abiertas a
  // cualquier rol autenticado, como antes.
  if (Array.isArray(tool.roles) && !tool.roles.includes(rol)) {
    throw new Error('No tenés permiso para consultar ese dato con tu rol actual. Pedíselo a un administrador.');
  }

  if (!tool.requiereConfirmacion) {
    return tool.execute({ empresaId, args: args || {} });
  }

  // Tool de escritura: nunca se ejecuta acá. Se guarda como propuesta
  // pendiente y se le devuelve al modelo solo el resumen + el id para
  // que el usuario confirme por fuera de este mismo turno.
  if (!conversacionId || !usuarioId) {
    throw new Error(`${nombre} requiere confirmación y no se pudo registrar (falta conversación o usuario)`);
  }

  const resumen = await tool.resumen({ empresaId, args: args || {} });

  const { data, error } = await db
    .from('asistente_acciones_pendientes')
    .insert({
      conversacion_id: conversacionId,
      usuario_id: usuarioId,
      empresa_id: empresaId,
      tool_nombre: nombre,
      tool_args: args || {},
      resumen,
    })
    .select('id')
    .single();

  if (error) throw new Error(`No se pudo preparar la confirmación de ${nombre}: ${error.message}`);

  return {
    pendiente_confirmacion: true,
    id_confirmacion: data.id,
    resumen,
  };
}

/**
 * Resuelve (confirma o cancela) una acción pendiente creada por
 * ejecutarTool() para una tool con requiereConfirmacion:true.
 *
 * Se llama desde lib/handlers/asistente.js cuando el usuario clickea
 * Confirmar/Cancelar en el chat-widget — NUNCA desde el loop de Gemini.
 * Valida dueño + empresa + conversación + vigencia antes de tocar nada,
 * y usa un UPDATE atómico con `estado = 'pendiente'` en el WHERE para
 * que un doble click (o una carrera de dos tabs) no ejecute la acción
 * dos veces: el segundo UPDATE no afecta ninguna fila.
 */
async function resolverAccionPendiente({ id, usuarioId, empresaId, conversacionId, confirmar }) {
  if (!id) throw new Error('Falta el id de la acción a confirmar');

  const { data: fila, error: errorLectura } = await db
    .from('asistente_acciones_pendientes')
    .select('id, tool_nombre, tool_args, resumen, estado, usuario_id, empresa_id, conversacion_id, creado_en')
    .eq('id', id)
    .maybeSingle();

  if (errorLectura) throw new Error(`No se pudo leer la acción pendiente: ${errorLectura.message}`);
  if (!fila) return { encontrada: false };

  // Nunca resolver una acción de otro usuario, otra empresa, u otra
  // conversación aunque alguien adivine/reutilice el UUID.
  if (fila.usuario_id !== usuarioId || fila.empresa_id !== empresaId || fila.conversacion_id !== conversacionId) {
    throw new Error('Esa acción pendiente no corresponde a esta conversación');
  }

  if (fila.estado !== 'pendiente') {
    return { encontrada: true, estado: fila.estado, resumen: fila.resumen, yaResuelta: true };
  }

  const vencida = Date.now() - new Date(fila.creado_en).getTime() > TTL_CONFIRMACION_MS;
  if (vencida) {
    await db.from('asistente_acciones_pendientes')
      .update({ estado: 'expirada', resuelto_en: new Date().toISOString() })
      .eq('id', id)
      .eq('estado', 'pendiente');
    return { encontrada: true, estado: 'expirada', resumen: fila.resumen };
  }

  if (!confirmar) {
    await db.from('asistente_acciones_pendientes')
      .update({ estado: 'cancelada', resuelto_en: new Date().toISOString() })
      .eq('id', id)
      .eq('estado', 'pendiente');
    return { encontrada: true, estado: 'cancelada', resumen: fila.resumen };
  }

  // Reclamo atómico: si dos requests llegan casi juntas (doble click),
  // solo una gana esta UPDATE (la otra afecta 0 filas porque ya no
  // encuentra estado='pendiente').
  const { data: reclamada, error: errorReclamo } = await db
    .from('asistente_acciones_pendientes')
    .update({ estado: 'confirmada', resuelto_en: new Date().toISOString() })
    .eq('id', id)
    .eq('estado', 'pendiente')
    .select('id')
    .maybeSingle();

  if (errorReclamo) throw new Error(`No se pudo confirmar la acción: ${errorReclamo.message}`);
  if (!reclamada) return { encontrada: true, estado: 'ejecutada_por_otro_click', resumen: fila.resumen };

  const tool = TOOLS.find((t) => t.name === fila.tool_nombre);
  if (!tool) {
    await db.from('asistente_acciones_pendientes').update({ estado: 'error', resultado: { error: 'tool desconocida' } }).eq('id', id);
    throw new Error(`Tool desconocida al ejecutar la acción confirmada: ${fila.tool_nombre}`);
  }

  try {
    const resultado = await tool.execute({ empresaId, usuarioId, args: fila.tool_args || {} });
    await db.from('asistente_acciones_pendientes').update({ estado: 'ejecutada', resultado }).eq('id', id);
    return { encontrada: true, estado: 'ejecutada', resumen: fila.resumen, resultado };
  } catch (error) {
    await db.from('asistente_acciones_pendientes').update({ estado: 'error', resultado: { error: error.message } }).eq('id', id);
    throw new Error(`Se confirmó pero falló al ejecutar "${fila.resumen}": ${error.message}`);
  }
}

export { TOOLS, esquemaParaGemini, esquemaParaOpenAI, seleccionarToolsRelevantes, ejecutarTool, resolverAccionPendiente };
