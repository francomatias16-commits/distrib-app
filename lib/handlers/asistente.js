// lib/handlers/asistente.js
// GET/POST /api/asistente — Asistente de ayuda interno (chatbot RAG + tools).
//
// Flujo:
//   1. verificarToken()  -> valida el JWT de Supabase y obtiene perfil/rol/empresa
//   2. excedioLimiteAsistente() -> corta si el usuario abusó del asistente
//      (consulta persistente contra asistente_uso, no en memoria)
//   3. resolverConversacion() -> reusa o crea una fila en asistente_conversaciones,
//      trae los últimos mensajes como historial corto (multi-turn)
//   4. embedding de la pregunta + búsqueda semántica (RPC buscar_articulos_asistente)
//   5. arma el prompt con los artículos encontrados + catálogo de tools
//   6. responderConFallback() (Gemini -> Groq -> OpenRouter, ver ../asistente-providers.js).
//      Gemini puede llamar tools de ../asistente-tools.js para datos en vivo;
//      Groq/OpenRouter (fallback) responden solo con los artículos, sin tools.
//   7. guarda los 2 mensajes nuevos (user + model) y loguea en asistente_uso
//      (también sirve de base para el rate limit)
//
// Requiere en el entorno:
//   GEMINI_API_KEY                        (embedding de la pregunta + proveedor Gemini)
//   GROQ_API_KEY, OPENROUTER_API_KEY       (proveedores de fallback, opcionales)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (ya definidos en el resto del proyecto)
//
// Base de conocimiento: docs/ayuda/*.md, cargados en asistente_articulos vía
// `npm run cargar-embeddings-asistente` (scripts/generar-embeddings-asistente.js).
//
// Tablas de historial (asistente_conversaciones / asistente_mensajes) y RPCs
// de tools: ver supabase/migrations/203_asistente_tools_lectura.sql y
// supabase/migrations/204_asistente_conversaciones.sql.
//
// Registrado en api/index.js como HANDLERS.asistente y ruteado desde
// vercel.json: /api/asistente(.*) -> /api/index?_mod=asistente.

import { db } from '../repos/_db.js';
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { responderConFallback } from '../asistente-providers.js';
import { esquemaParaGemini, esquemaParaOpenAI, ejecutarTool, resolverAccionPendiente, TTL_CONFIRMACION_MS } from '../asistente-tools.js';
import { withRetry } from '../retry.js';
import { validarArchivoPorContenido, MIME_DOCX, MIME_XLSX } from '../utils/image-sniff.js'; // SEC-13 + Frente 5 (PLAN_OPTIMIZACION_ASISTENTE_2026.md)
import { extraerTextoDeArchivo } from '../utils/extraer-texto-archivo.js';
import {
  contarUsosAsistenteDesde,
  obtenerConversacionSiVigente,
  crearConversacion,
  listarUltimosMensajes,
  insertarMensajes,
  tocarConversacion,
  buscarArticulosAsistenteRpc,
  buscarToolsAsistenteRpc,
  insertarUsoAsistente,
  obtenerAccionPendienteVigente,
} from '../repos/asistente.js';

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMS = 768;

// Cuántos mensajes previos (user + model, cuentan juntos) se mandan como
// contexto en cada pregunta nueva. Ventana corta a propósito: cubre un
// "¿y a 15 días?" de repregunta sin inflar el prompt sin límite.
const HISTORIAL_MAX_MENSAJES = 6;

// Una conversación "vieja" no se sigue extendiendo — se abre una nueva.
// Evita arrastrar contexto de una sesión de chat de hace 3 días.
const CONVERSACION_MAX_INACTIVIDAD_MS = 24 * 60 * 60_000;

// Límite de consultas por usuario en la ventana de tiempo definida.
//
// FIX (v220): antes esto usaba rateLimitPorClave() (en memoria, por
// instancia serverless). Con varias instancias de Vercel corriendo en
// paralelo (típico ante un pico de tráfico a la demo pública), cada una
// lleva su propio contador — el límite real efectivo se multiplica justo
// en el escenario donde más importa controlar el costo de la API de
// Gemini en una cuenta sin dueño real.
//
// Ahora se consulta directo la tabla `asistente_uso`, que ya se usa para
// registrar cada consulta (ver registrarUso más abajo) y ya tenía un
// índice pensado exactamente para esto (ver comentario en la migración
// 195_asistente_ayuda.sql: "Índice usado por rateLimit()"). Es la misma
// fuente de verdad para todas las instancias.
// FIX (v524, cuenta paga de Gemini): antes 15/10min — un número pensado
// para cuidar la cuota DIARIA gratuita de Gemini (compartida por toda la
// empresa), no solo para prevenir abuso. Con facturación activa esa cuota
// diaria deja de ser el techo real; el techo pasa a ser el costo por
// llamada, que sigue queriendo estar acotado. Se sube a 40/10min: da
// margen de sobra para una sesión de trabajo normal (varias preguntas
// seguidas, alguna con imagen adjunta) sin dejar de ser un tope — sigue
// habiendo un límite explícito a propósito, tanto por costo como para
// frenar un loop de cliente que reintente sin parar.
const LIMITE_ASISTENTE_MAX = 40;
const LIMITE_ASISTENTE_VENTANA_MS = 10 * 60_000;

// Antes 500 (pensado para una consulta corta). Se sube para poder pegar
// texto largo: una lista de stock, un pedido dictado y transcripto, un
// remito copiado de un WhatsApp. Sigue acotado (no es un editor de texto)
// para no inflar sin límite el costo/latencia de cada llamada a Gemini.
const MAX_LARGO_PREGUNTA = 8000;

// Límites del archivo adjunto opcional (ver imagen_base64/imagen_mime_type
// más abajo — el nombre de campo se mantiene por compatibilidad con el
// frontend ya desplegado, pero desde el Frente 5 de
// PLAN_OPTIMIZACION_ASISTENTE_2026.md no es necesariamente una imagen).
// MAX_IMAGEN_BASE64_CHARS ~5.6MB de base64 (~4MB de imagen real, el
// base64 infla ~33%) — suficiente para una foto de celular comprimida o
// una captura de WhatsApp, sin aceptar archivos enormes que disparen el
// costo/latencia de Gemini o el tiempo de la función serverless.
const IMAGEN_MIME_TYPES_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGEN_BASE64_CHARS = 5_600_000;

// Documentos (PDF/Word/Excel/CSV): pesan mucho menos que una foto para el
// mismo contenido útil (son texto/estructura, no una grilla de píxeles),
// así que se les da más margen en bytes del archivo original — el texto
// que efectivamente llega al modelo se acota aparte, a MAX_LARGO_PREGUNTA
// (ver más abajo, en el bloque de extracción).
const DOCUMENTO_MIME_TYPES_PERMITIDOS = new Set(['application/pdf', MIME_DOCX, MIME_XLSX, 'text/csv']);
const MAX_DOCUMENTO_BASE64_CHARS = 14_000_000; // ~10MB de archivo real
const ARCHIVO_MIME_TYPES_PERMITIDOS = new Set([
  ...IMAGEN_MIME_TYPES_PERMITIDOS,
  ...DOCUMENTO_MIME_TYPES_PERMITIDOS,
]);

async function excedioLimiteAsistente(usuarioId) {
  const desde = new Date(Date.now() - LIMITE_ASISTENTE_VENTANA_MS).toISOString();

  const { count, error } = await contarUsosAsistenteDesde(usuarioId, desde);

  if (error) {
    // Fail-open: un problema para leer el contador no debe tumbar el
    // asistente para todo el mundo (mismo criterio que lib/plan-limits.js).
    console.error('[asistente] Error consultando límite de uso, se permite por defecto:', error.message);
    return false;
  }

  return (count || 0) >= LIMITE_ASISTENTE_MAX;
}

// ---------------------------------------------------------------------
// Conversación / historial multi-turn
// ---------------------------------------------------------------------

async function resolverConversacion({ conversacionId, usuarioId, empresaId }) {
  if (conversacionId) {
    const { data, error } = await obtenerConversacionSiVigente(conversacionId, usuarioId);

    if (!error && data) {
      const inactiva = Date.now() - new Date(data.actualizado_en).getTime() > CONVERSACION_MAX_INACTIVIDAD_MS;
      if (!inactiva) return data.id;
    }
  }

  const { data: nueva, error: errorCrear } = await crearConversacion({ usuario_id: usuarioId, empresa_id: empresaId });

  if (errorCrear) throw new Error(`No se pudo crear la conversación: ${errorCrear.message}`);
  return nueva.id;
}

async function obtenerHistorial(conversacionId) {
  const { data, error } = await listarUltimosMensajes(conversacionId, HISTORIAL_MAX_MENSAJES);

  if (error) {
    console.error('[asistente] No se pudo leer el historial, se sigue sin él:', error.message);
    return [];
  }
  return (data || []).reverse();
}

async function guardarMensajes({ conversacionId, pregunta, respuesta }) {
  const { error } = await insertarMensajes([
    { conversacion_id: conversacionId, rol: 'user', contenido: pregunta },
    { conversacion_id: conversacionId, rol: 'model', contenido: respuesta },
  ]);
  if (error) {
    console.error('[asistente] No se pudieron guardar los mensajes:', error.message);
  }

  const { error: errorTouch } = await tocarConversacion(conversacionId);
  if (errorTouch) {
    console.error('[asistente] No se pudo actualizar la conversación:', errorTouch.message);
  }
}

// ---------------------------------------------------------------------
// Embedding de la pregunta + búsqueda semántica
// ---------------------------------------------------------------------

// FIX (v524, cuenta paga de Gemini): antes esta llamada era la ÚNICA parte
// del flujo que golpeaba a Gemini sin pasar por withRetry() ni por un
// circuit breaker (a diferencia de llamarGemini() en asistente-providers.js,
// que sí tiene ambos). Un 429/5xx transitorio acá tiraba abajo la pregunta
// entera ANTES de llegar siquiera a responderConFallback() — es decir, ni
// Groq ni OpenRouter llegaban a intentarlo, porque el fallo pasaba en el
// paso previo (embedding para la búsqueda semántica), no en el de texto.
// Con la cuenta paga los 429 de Gemini deberían ser raros, pero un 5xx o
// un timeout de red puntual sigue siendo posible en cualquier API —
// withRetry() ya sabe reintentar justo esos casos (ver
// defaultEsReintentable en lib/retry.js) y no los 4xx de datos, así que
// sumarlo acá achica el margen de error sin arriesgar loops en errores
// que no se van a arreglar reintentando.
async function generarEmbeddingPregunta(pregunta) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;

  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: pregunta }] },
          outputDimensionality: EMBEDDING_DIMS,
          taskType: 'RETRIEVAL_QUERY', // distinto de RETRIEVAL_DOCUMENT usado al indexar
        }),
      });

      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        const error = new Error(`Falló el embedding de la pregunta (${res.status}): ${texto}`);
        error.status = res.status;
        throw error;
      }

      const data = await res.json();
      const values = data?.embedding?.values;
      if (!values) throw new Error('Embedding de la pregunta vacío o inesperado');
      return values;
    },
    { intentos: 2, baseDelayMs: 300 }
  );
}

// `embeddingPregunta`: opcional. Si no se pasa, se genera acá adentro
// (comportamiento original, y el que siguen teniendo los callers que no
// conocen este parámetro). Si se pasa, se reusa tal cual — ver Frente 2
// más abajo (buscarToolsRelevantesPorEmbedding), donde el handler
// principal genera el embedding UNA sola vez y lo comparte entre la
// búsqueda de artículos y la de tools, para no pagar 2 veces el costo/
// latencia de Gemini por el mismo texto.
async function buscarArticulosRelevantes({ pregunta, rol, embeddingPregunta }) {
  const embedding = embeddingPregunta || (await generarEmbeddingPregunta(pregunta));

  const { data, error } = await buscarArticulosAsistenteRpc({
    query_embedding: embedding,
    p_rol: rol,
    match_count: 3,
    match_threshold: 0.5,
  });

  if (error) throw new Error(`Falló la búsqueda semántica: ${error.message}`);
  return data || [];
}

// ---------------------------------------------------------------------
// Frente 2 (PLAN_OPTIMIZACION_ASISTENTE_2026.md): selección de tools por
// similitud semántica, capa previa al matcheo por palabras clave de
// seleccionarToolsRelevantes() (ver lib/asistente-tools/index.js).
// ---------------------------------------------------------------------

// match_threshold más laxo que el de artículos (0.5): acá no se está
// decidiendo si mostrarle o no una fuente al usuario, sino simplemente
// si vale la pena preferir esta sugerencia sobre el matcheo por keyword
// — y match_count más alto (8, contra 3 de artículos) para darle margen
// de sobra a seleccionarToolsRelevantes() antes de recortar a
// TOOLS_MAX_PROVEEDOR_TPM_CHICO. Un threshold demasiado laxo no es grave:
// en el peor caso, se sugiere alguna tool de más entre las TOP-8, nunca
// se le esconde una tool al modelo que el keyword sí hubiera encontrado
// (porque, si la semántica no trae nada útil, se sigue de largo al
// fallback por keyword — ver seleccionarToolsRelevantes()).
const TOOLS_SEMANTICA_MATCH_COUNT = 8;
const TOOLS_SEMANTICA_MATCH_THRESHOLD = 0.55;

// Devuelve un array de tool_nombre ordenado por similitud, o `null` si
// la búsqueda semántica no se pudo hacer (RPC caída, error de red). `null`
// es distinto de `[]` (búsqueda OK pero sin ningún match sobre el
// threshold) solo a fines de este comentario/debug — para
// seleccionarToolsRelevantes() da exactamente lo mismo: en ambos casos no
// hay sugerencia utilizable y se cae al matcheo por keyword. Por eso
// mismo esta función nunca deja propagar el error: un fallo acá NO debe
// tumbar el turno entero (mismo criterio fail-open del resto del
// archivo) — la keyword de siempre sigue funcionando como red de
// seguridad, tal como pide el punto 4 del diseño del Frente 2.
async function buscarToolsRelevantesPorEmbedding(embeddingPregunta) {
  try {
    const { data, error } = await buscarToolsAsistenteRpc({
      query_embedding: embeddingPregunta,
      match_count: TOOLS_SEMANTICA_MATCH_COUNT,
      match_threshold: TOOLS_SEMANTICA_MATCH_THRESHOLD,
    });

    if (error) throw new Error(error.message);
    return (data || []).map((fila) => fila.tool_nombre);
  } catch (error) {
    console.error('[asistente] Falló la búsqueda semántica de tools, se sigue con keywords:', error.message);
    return null;
  }
}

// Umbral para MOSTRAR un artículo como "Fuente" en el chat, distinto (más
// estricto) del match_threshold=0.5 usado para decidir qué se le pasa al
// modelo como contexto. Motivo: en un corpus chico y muy homogéneo (todos
// los artículos hablan de "el sistema", "pedidos", "panel"), 0.5 de similitud
// coseno lo supera casi cualquier artículo aunque no tenga relación real con
// la pregunta — eso generaba "Fuente: X, Y, Z" con artículos que no explican
// nada de lo preguntado (ver caso "por qué no tiene evento el botón").
// Le seguimos dando al modelo los de >=0.5 por si le sirven de contexto
// débil, pero solo mostramos como fuente citada los que superan este piso.
const UMBRAL_MOSTRAR_FUENTE = 0.68;

function articulosParaMostrar(articulos) {
  return articulos.filter((a) => (a.similarity ?? 0) >= UMBRAL_MOSTRAR_FUENTE);
}

// ---------------------------------------------------------------------
// Caché de repetición consecutiva (v515)
// ---------------------------------------------------------------------
//
// Motivo: cada consulta gasta cuota gratuita en 2 lugares — el embedding
// de la pregunta (generarEmbeddingPregunta, Gemini) y el proveedor de
// texto (Gemini/Groq/OpenRouter). Un caso frecuente en la práctica: el
// usuario dispara la misma pregunta dos veces seguidas (doble click en
// "enviar", reintento tras un timeout percibido, o simplemente repite
// literal "cuántos pedidos pendientes tengo" un rato después). Ninguna de
// esas dos cosas necesita volver a golpear la API — se puede reusar la
// última respuesta tal cual, sin gastar una consulta más.
//
// A propósito NO es una caché general por texto de pregunta (eso serviría
// datos en vivo desactualizados sin que el usuario lo sepa): solo aplica
// si la pregunta repetida es EXACTAMENTE el último turno de ESTA misma
// conversación (ya cargado en `historial`, no hace falta ir a buscar nada
// más a la base) y ese turno es reciente. Pasada la ventana, se vuelve a
// consultar todo de cero — mejor un dato fresco que uno viejo.
const CACHE_REPETICION_VENTANA_MS = 2 * 60_000;

function normalizarPregunta(texto) {
  return (texto || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// `historial` viene en orden ascendente (más viejo primero, ver
// obtenerHistorial). Si el turno inmediatamente anterior en esta misma
// conversación es user+model y el user matchea la pregunta actual (misma,
// ignorando mayúsculas/espacios), devuelve el texto de esa respuesta.
// Si no matchea o pasó la ventana, devuelve null y se sigue el camino normal.
function respuestaCacheadaPorRepeticion(historial, pregunta) {
  if (!historial || historial.length < 2) return null;

  const ultimo = historial[historial.length - 1];
  const anteultimo = historial[historial.length - 2];
  if (ultimo?.rol !== 'model' || anteultimo?.rol !== 'user') return null;
  if (normalizarPregunta(anteultimo.contenido) !== normalizarPregunta(pregunta)) return null;

  const edadMs = Date.now() - new Date(anteultimo.creado_en).getTime();
  if (edadMs > CACHE_REPETICION_VENTANA_MS) return null;

  return ultimo.contenido;
}

// ---------------------------------------------------------------------
// Fase 1 del plan de robustez conversacional (corrección sin reiniciar)
// ---------------------------------------------------------------------

// Consulta si esta conversación tiene una propuesta de tool de escritura
// sin resolver y todavía vigente (mismo TTL que usa resolverAccionPendiente
// en asistente-tools.js — una propuesta vencida no cuenta: se le pediría al
// modelo que "corrija" algo que ya ni se puede confirmar). Se llama en CADA
// turno de pregunta nueva, no solo al hacer click en Confirmar/Cancelar.
async function obtenerPropuestaVigentePara(conversacionId) {
  const { data, error } = await obtenerAccionPendienteVigente(conversacionId);
  if (error) {
    console.error('[asistente] No se pudo consultar la acción pendiente de la conversación:', error.message);
    return null;
  }
  if (!data) return null;
  const vencida = Date.now() - new Date(data.creado_en).getTime() > TTL_CONFIRMACION_MS;
  if (vencida) return null;
  return { toolNombre: data.tool_nombre, resumen: data.resumen };
}

// ---------------------------------------------------------------------
// Armado del prompt
// ---------------------------------------------------------------------

// FIX (v513): antes esta función devolvía un único systemPrompt, con el
// bloque de instrucciones de tools SIEMPRE incluido, y ese mismo texto se
// mandaba a los 3 proveedores del fallback (ver responderConFallback en
// asistente-providers.js). El problema: Groq y OpenRouter no reciben el
// catálogo de tools (PROVEEDORES_CON_TOOLS = solo 'gemini') y no tienen
// ninguna forma real de ejecutarlas — pero el prompt les decía igual
// "priorizá SIEMPRE llamar la herramienta que corresponda". Un modelo
// chico y gratuito (sobre todo el fallback final, llama-3.1-8b:free)
// intenta cumplir esa instrucción sin poder hacerlo, y termina
// "actuando" una respuesta con datos de una tool inexistente —incluso
// devolviendo literalmente el placeholder tal cual, del estilo
// "[resultado de la herramienta]"— en vez de admitir que no tiene el dato.
//
// Ahora armarSystemPrompt devuelve DOS variantes ({ conTools, sinTools }):
// la que menciona las herramientas (para Gemini, que sí puede ejecutarlas)
// y una que le aclara al modelo que NO tiene acceso a datos en vivo en
// este momento y que no debe simular ni inventar un resultado (para
// Groq/OpenRouter). El orquestador (responderConFallback) elige cuál
// mandarle a cada proveedor según si está en PROVEEDORES_CON_TOOLS.
function armarSystemPrompt({ articulos, rol, propuestaVigente }) {
  const bloqueTools = [
    '',
    'Además de los artículos de ayuda, tenés herramientas para consultar datos reales y actuales de la cuenta',
    '(deuda a un proveedor, facturas por vencer, lotes por vencer, cheques en alerta, bloqueo de un cliente,',
    'ruta del día, pedidos pendientes —tanto el total como el detalle uno por uno—, stock crítico, y',
    'diagnóstico puntual de un pedido: por qué no facturó, estado en ARCA/AFIP, si quedó asentado en la cuenta',
    'corriente). Cuando la pregunta pida un dato puntual de la cuenta, priorizá SIEMPRE llamar la herramienta',
    'que corresponda antes de responder — nunca completes con un ejemplo, un valor típico o un dato inventado.',
    'Si ninguna herramienta cubre exactamente lo que piden, decilo con honestidad ("no tengo una forma de',
    'consultar eso todavía") en vez de fabricar una respuesta que suene plausible.',
    '',
    'Sé directo: si el usuario pide una lista o un dato concreto, dale la lista o el dato tal cual lo devolvió',
    'la herramienta, sin agregar preguntas de seguimiento que no pidió. Esto vale para CUALQUIER sección',
    '(pedidos, presupuestos, ventas de mostrador, cheques, cuentas corrientes, stock, cola financiera,',
    'automatización, etc.), no solo pedidos. No le pidas el ID corto de un documento (u otro dato) por las',
    'dudas "para darle más información" — pedíselo solo si la PRÓXIMA acción puntual que el usuario realmente',
    'pidió lo necesita y no tenés forma de resolverlo solo. Las herramientas de diagnóstico puntual',
    '(diagnosticar_pedido/presupuesto/venta_pos/cheque) YA saben buscar por el nombre del cliente en vez del',
    'ID corto: si el usuario te da un nombre, pasáselo directo a la herramienta en el campo "cliente" en vez',
    'de frenar a pedirle el ID — la herramienta te va a devolver el diagnóstico directo si hay un solo',
    'candidato, o una lista corta para que el usuario elija si hay varios. Recién ahí, si sigue siendo',
    'ambiguo, pedile que aclare (con el ID, la fecha, o el monto). Si ya le mostraste una lista con',
    'referencias cortas en este mismo chat y el usuario después pregunta por uno de esos ítems por nombre o',
    'por número de orden ("el segundo", "el de tal cliente"), usá la referencia que ya tenés de esa lista en',
    'vez de volvérsela a pedir. Si una búsqueda por nombre (proveedor/cliente) devuelve varios candidatos o',
    'ninguno, ahí sí pedile al usuario que aclare el nombre en vez de adivinar.',
    '',
    'Cuando una herramienta te devuelva un error de "hay más de un X parecido a..." con una lista numerada',
    '(cliente, producto, proveedor, depósito, categoría, zona, regla de precio, regla de automatización,',
    'recompensa, lote de conciliación, orden de compra), mostrale esa lista al usuario TAL CUAL viene, con la',
    'misma numeración y el mismo orden — no la reformules, no la resumas, no la redactes de nuevo con tus',
    'palabras. Es así para que el usuario pueda responder con el número o con el nombre completo de una',
    'opción sin que el formato cambie entre un intento y el siguiente. Esto aplica también dentro de',
    'crear_pedido/crear_presupuesto cuando un producto o el cliente resultan ambiguos: si el usuario responde',
    'con un número, con "el segundo/la primera", o con el nombre completo de una de las opciones que le',
    'mostraste, volvé a llamar la función usando exactamente el texto de esa opción de la lista — nunca lo',
    'reformules vos ni inventes una variante distinta a la que se le ofreció.',
    '',
    'También tenés herramientas para HACER cosas, no solo consultar (por ahora: anular una venta de',
    'mostrador puntual, crear un pedido nuevo, o crear un presupuesto/cotización nuevo). Nunca las ejecutás',
    'vos directamente: al llamarlas solo se genera una propuesta con un resumen, y la acción real recién',
    'ocurre si el usuario clickea "Confirmar" en el botón que se le muestra después. Nunca digas que ya',
    'hiciste la acción; decí que preparaste la propuesta y que la confirme. Si falta un dato necesario (a',
    'qué cliente, qué producto, qué cantidad, el motivo de una anulación), pedíselo antes de llamar la',
    'herramienta en vez de inventarlo.',
    '',
    'El usuario puede pegarte un texto largo (una lista de stock, un pedido dictado y transcripto, un',
    'remito o una nota copiada de un WhatsApp) o adjuntarte una imagen (foto o captura de un pedido/lista).',
    'En ese caso interpretalo vos mismo de punta a punta: identificá qué cliente es y cada producto con su',
    'cantidad, y llamá crear_pedido o crear_presupuesto UNA sola vez con todos los items juntos en el array',
    '"items" — no le vayas preguntando línea por línea si el texto ya es razonablemente claro. Elegí',
    'crear_pedido si el usuario dice "pedido"/"cargar"/"vender" o no aclara nada, y crear_presupuesto si',
    'dice explícitamente "presupuesto" o "cotización". Si el documento no trae un cliente identificable, o',
    'ninguna línea se entiende como producto+cantidad, no inventes: explicale al usuario qué no pudiste',
    'interpretar y pedile que lo aclare. Igual que siempre, nunca vos mismo calculás ni mencionás un precio',
    'o total antes de llamar la función: eso lo resuelve el servidor.',
    ...(propuestaVigente ? [
      '',
      `Además: hay una propuesta sin confirmar todavía en esta conversación (herramienta "${propuestaVigente.toolNombre}"): "${propuestaVigente.resumen}". Si en tu`,
      'último mensaje al usuario vos mismo pediste que aclare o corrija algo de ESA propuesta, y lo que te acaba de',
      'responder es esa corrección (un dato distinto, no un tema nuevo), volvé a llamar la misma herramienta',
      `(${propuestaVigente.toolNombre}) con el dato corregido y el resto de los datos que ya tenías — no le pidas`,
      'que repita todo desde cero. El servidor se encarga de reemplazar la propuesta vieja por la nueva, no hace',
      'falta que hagas nada especial más que volver a llamar la función. Si en cambio el usuario te pide algo que',
      'no tiene relación con esa propuesta, tratala como abandonada: no la vuelvas a mencionar y respondé lo que',
      'te pidió (la propuesta vieja sigue esperando su Confirmar/Cancelar en pantalla si el usuario decide volver',
      'a ella).',
    ] : []),
  ].join('\n');

  // Variante para proveedores SIN tool-calling real (Groq/OpenRouter en el
  // fallback). Reemplaza el bloque anterior por una aclaración explícita:
  // nunca simular ni inventar un resultado de herramienta.
  const bloqueSinTools = [
    '',
    'IMPORTANTE: en este momento NO tenés acceso a herramientas para consultar datos en vivo de la cuenta',
    '(pedidos, stock, facturas, cheques, cuentas corrientes, rutas, etc.) ni para crear o anular nada. Si la',
    'pregunta pide un dato puntual de la cuenta o una acción sobre ella, respondé con honestidad que no podés',
    'consultar ni ejecutar eso en este momento y sugerí reintentar en unos minutos o contactar a un',
    'administrador. NUNCA "actúes" como si estuvieras consultando algo, ni completes con un número, una',
    'lista o un resultado inventado (ni siquiera como placeholder tipo "[resultado]"): sin la herramienta no',
    'hay forma de saber ese dato, así que decilo directamente en vez de simular que lo estás buscando.',
  ].join('\n');

  const base = (bloque) => {
    if (articulos.length === 0) {
      return [
        'Sos el asistente de ayuda interno del sistema distrib. Respondé en español, breve y concreto.',
        `Estás respondiendo a un usuario con rol "${rol}".`,
        'No se encontró ningún artículo de la base de conocimiento relacionado con la pregunta.',
        'Si la pregunta pide un dato puntual de la cuenta, usá las herramientas disponibles para responderla',
        '(si las tenés disponibles — ver instrucción más abajo).',
        'Si no es algo que las herramientas puedan resolver, decile amablemente que no tenés información sobre',
        'ese tema todavía y sugerile contactar a un administrador. No inventes procedimientos ni datos que no',
        'estén confirmados por un artículo o una herramienta.',
        bloque,
      ].join('\n');
    }

    const contexto = articulos
      .map((a, i) => `### Artículo ${i + 1}: ${a.titulo}\n${a.contenido}`)
      .join('\n\n');

    return [
      'Sos el asistente de ayuda interno del sistema distrib. Respondé en español, de forma breve, clara y concreta.',
      `Estás respondiendo a un usuario con rol "${rol}" — adaptá la respuesta a lo que ese rol puede hacer.`,
      'Basate ÚNICAMENTE en los artículos de ayuda que te paso a continuación para explicar CÓMO hacer algo. Si la pregunta no está cubierta por estos artículos ni por una herramienta, decilo con honestidad en vez de inventar un procedimiento.',
      'No repitas el artículo completo: resumí lo relevante para la pregunta puntual.',
      bloque,
      '',
      contexto,
    ].join('\n');
  };

  return {
    conTools: base(bloqueTools),
    sinTools: base(bloqueSinTools),
  };
}

// ---------------------------------------------------------------------
// Confirmación de acciones de escritura (click Confirmar/Cancelar)
// ---------------------------------------------------------------------

// Traduce el resultado de resolverAccionPendiente() a un texto de chat.
// Se guarda como el turno "model" en el historial, igual que cualquier
// otra respuesta — así queda el rastro de qué se confirmó/canceló.
function textoParaResultadoConfirmacion(resultado) {
  switch (resultado.estado) {
    case 'ejecutada':
      return `Listo, hecho: ${resultado.resumen}`;
    case 'cancelada':
      return 'Cancelado. No se hizo ningún cambio.';
    case 'expirada':
      return 'Esa propuesta ya venció (pasaron más de 10 minutos desde que se generó). Pedime de nuevo la acción para armar un resumen actualizado antes de confirmar.';
    case 'reemplazada':
      // Fase 1 del plan de robustez conversacional: el usuario corrigió un
      // dato de esta propuesta y el asistente armó una nueva con el dato
      // corregido (ver ejecutarTool() en asistente-tools/index.js) — esta
      // burbuja vieja quedó obsoleta. Puede pasar que el usuario toque
      // Confirmar/Cancelar en la burbuja vieja igual (scrolleó para arriba,
      // no vio la nueva), así que se le explica qué pasó en vez de un
      // mensaje genérico de "ya había quedado en estado...".
      return 'Esa propuesta ya no está vigente: la reemplazaste al corregir un dato. Fijate en la propuesta más reciente del chat para confirmarla o cancelarla.';
    case 'ejecutada_por_otro_click':
      return 'Esa acción ya se estaba procesando (parece un doble click) — no se ejecutó dos veces.';
    default:
      return `Esa propuesta ya había quedado en estado "${resultado.estado}" anteriormente.`;
  }
}

// Busca, entre las tools que se ejecutaron en esta vuelta, si alguna quedó
// pendiente de confirmación (ver requiereConfirmacion en asistente-tools.js)
// para exponérselo al frontend y que dibuje los botones Confirmar/Cancelar.
// Solo puede haber una: TOOL_CALLS_MAX es bajo y, apenas una tool devuelve
// pendiente_confirmacion, el resumen le llega a Gemini con instrucciones
// explícitas de no volver a llamarla en el mismo turno.
function extraerAccionPendiente(toolsUsadas) {
  const conPendiente = (toolsUsadas || []).find((t) => t.resultado?.pendiente_confirmacion);
  if (!conPendiente) return null;
  return {
    id: conPendiente.resultado.id_confirmacion,
    resumen: conPendiente.resultado.resumen,
  };
}

// Fase 3 del plan de robustez conversacional: si la ÚLTIMA tool llamada en
// este turno terminó en un error de tipo `ambiguo()` (ver _respuestas.js),
// trae un array `opciones` ({id,label}) colgado del resultado (ver el
// catch en asistente-providers.js que lo preserva). Se mira solo la
// última entrada de `toolsUsadas` (no cualquiera) porque, si el modelo
// llegó a resolver la ambigüedad con una llamada posterior exitosa dentro
// del mismo turno, esa llamada posterior ya no tiene `opciones` — y en ese
// caso no corresponde mostrarle botones de una ambigüedad que ya se
// resolvió sola.
function extraerOpcionesAmbiguas(toolsUsadas) {
  if (!toolsUsadas?.length) return null;
  const ultima = toolsUsadas[toolsUsadas.length - 1];
  if (ultima?.ok === false && Array.isArray(ultima.resultado?.opciones) && ultima.resultado.opciones.length) {
    return ultima.resultado.opciones;
  }
  return null;
}

// ---------------------------------------------------------------------
// Registro de uso
// ---------------------------------------------------------------------

// Frente 3 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: 3 parámetros nuevos,
// todos opcionales — cayoEnNucleoFallback/cantidadToolsConMatch vienen de
// seleccionarToolsRelevantes() (undefined si no hubo pregunta con tools
// armadas), toolFinalmenteUsada sale de toolsUsadas del propio turno.
async function registrarUso({
  usuarioId, empresaId, pregunta, proveedor, articulosEncontrados, latenciaMs,
  cayoEnNucleoFallback, cantidadToolsConMatch, toolFinalmenteUsada,
  // Frente 2 (migración 602): cuál de los 2 caminos de selección se usó
  // realmente en este request — 'semantica' | 'keywords' | 'nucleo_fallback'.
  metodoSeleccionTools,
}) {
  const { error } = await insertarUsoAsistente({
    usuario_id: usuarioId,
    empresa_id: empresaId,
    pregunta,
    proveedor_usado: proveedor,
    articulos_encontrados: articulosEncontrados,
    latencia_ms: latenciaMs,
    cayo_en_nucleo_fallback: cayoEnNucleoFallback,
    cantidad_tools_con_match: cantidadToolsConMatch,
    tool_finalmente_usada: toolFinalmenteUsada,
    metodo_seleccion_tools: metodoSeleccionTools,
  });

  if (error) {
    // No frenamos la respuesta al usuario por un error de logging.
    console.error('[asistente] No se pudo registrar el uso', error);
  }
}

// Frente 3: última tool efectivamente ejecutada en el turno, sea cual sea
// el proveedor que terminó respondiendo. Mismo criterio de "última, no
// cualquiera" que ya usa extraerOpcionesAmbiguas() más abajo.
function extraerToolFinalmenteUsada(toolsUsadas) {
  if (!toolsUsadas?.length) return null;
  return toolsUsadas[toolsUsadas.length - 1]?.nombre ?? null;
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------

export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const perfil = await verificarToken(req, db);
  if (!perfil || !perfil.id) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // -------------------------------------------------------------------
  // Rama de confirmación: click en Confirmar/Cancelar sobre una acción
  // de escritura ya propuesta (ver requiereConfirmacion en
  // asistente-tools.js). Se distingue de una pregunta nueva por la
  // presencia de accion_pendiente_id — NUNCA se llega acá desde el loop
  // de Gemini, solo desde el botón del chat-widget.
  // No pasa por excedioLimiteAsistente(): no consume ninguna API de IA,
  // es una operación de base de datos puntual.
  const accionPendienteId = req.body?.accion_pendiente_id || null;
  if (accionPendienteId) {
    const conversacionId = req.body?.conversacion_id || null;
    if (!conversacionId) {
      return res.status(400).json({ error: "Falta 'conversacion_id' para resolver la acción pendiente" });
    }

    try {
      const confirmar = req.body?.confirmar !== false; // default true: solo false explícito cancela
      const resultado = await resolverAccionPendiente({
        id: accionPendienteId,
        usuarioId: perfil.id,
        empresaId: perfil.empresa_id,
        conversacionId,
        confirmar,
      });

      if (!resultado.encontrada) {
        return res.status(404).json({ error: 'No se encontró esa acción pendiente' });
      }

      const texto = textoParaResultadoConfirmacion(resultado);

      await guardarMensajes({
        conversacionId,
        pregunta: confirmar ? '(usuario confirmó la acción pendiente)' : '(usuario canceló la acción pendiente)',
        respuesta: texto,
      });

      return res.status(200).json({
        respuesta: texto,
        conversacion_id: conversacionId,
        accion_resuelta: { estado: resultado.estado },
      });
    } catch (error) {
      console.error('[asistente] Error resolviendo acción pendiente:', error?.message ?? error);
      return res.status(500).json({ error: error.message || 'No se pudo resolver la acción pendiente' });
    }
  }

  if (await excedioLimiteAsistente(perfil.id)) {
    return res.status(429).json({
      error: 'Alcanzaste el límite de consultas al asistente. Probá de nuevo en unos minutos.',
    });
  }

  let pregunta = (req.body?.pregunta || '').trim();

  // Archivo opcional adjunto (ver frontend/shared/chat-widget.js): foto,
  // captura de un pedido/lista de stock, PDF, Word o Excel. El nombre de
  // campo (`imagen_base64`/`imagen_mime_type`) se mantiene por
  // compatibilidad con el frontend ya desplegado, aunque desde el
  // Frente 5 de PLAN_OPTIMIZACION_ASISTENTE_2026.md no es necesariamente
  // una imagen. Viaja SIN el prefijo `data:...;base64,` (el frontend ya
  // lo recorta).
  const archivoBase64 = (req.body?.imagen_base64 || '').trim() || null;
  const archivoMimeTypeDeclarado = (req.body?.imagen_mime_type || '').trim() || null;

  // `imagen` es lo que efectivamente se manda al camino de visión de
  // responderConFallback() — solo se completa si el archivo adjunto
  // termina siendo una imagen real (foto) o un PDF escaneado sin texto
  // extraíble (ver más abajo). El resto de los documentos se resuelven
  // ANTES, acá mismo, convirtiéndose a texto y sumándose a `pregunta`.
  let imagenParaVision = null;
  let archivoTruncado = false;

  if (archivoBase64) {
    if (!archivoMimeTypeDeclarado || !ARCHIVO_MIME_TYPES_PERMITIDOS.has(archivoMimeTypeDeclarado)) {
      return res.status(400).json({ error: 'Tipo de archivo no soportado. Usá JPG, PNG, WEBP, PDF, Word (.docx), Excel (.xlsx) o CSV.' });
    }
    const esImagenDeclarada = IMAGEN_MIME_TYPES_PERMITIDOS.has(archivoMimeTypeDeclarado);
    const limiteBase64 = esImagenDeclarada ? MAX_IMAGEN_BASE64_CHARS : MAX_DOCUMENTO_BASE64_CHARS;
    if (archivoBase64.length > limiteBase64) {
      return res.status(400).json({
        error: esImagenDeclarada
          ? 'La imagen es demasiado pesada. Probá con una más chica o comprimida.'
          : 'El archivo es demasiado pesado. Probá con uno más liviano.',
      });
    }
    // SEC-13: hasta acá solo se validó el MIME declarado por el cliente y el
    // largo del string — no el contenido real. Se decodifica una vez (ya
    // hace falta el buffer más abajo, sea para mandarlo a los providers o
    // para extraerle el texto) y se hace sniffing por magic bytes/contenido
    // antes de confiar en él.
    let archivoBuffer;
    try {
      archivoBuffer = Buffer.from(archivoBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'El archivo adjunto no es válido.' });
    }
    const validacionArchivo = validarArchivoPorContenido(archivoBuffer, ARCHIVO_MIME_TYPES_PERMITIDOS);
    if (!validacionArchivo.ok) {
      return res.status(400).json({ error: validacionArchivo.error });
    }
    const mimeReal = validacionArchivo.mimeReal;

    if (IMAGEN_MIME_TYPES_PERMITIDOS.has(mimeReal)) {
      // Foto/captura: sigue el camino de visión que ya existía.
      imagenParaVision = { mimeType: mimeReal, data: archivoBase64 };
    } else {
      // Documento: se extrae el texto server-side y se trata como si el
      // usuario lo hubiera pegado directamente (ver armarSystemPrompt(),
      // que ya sabe interpretar un texto largo de pedido/stock/remito).
      let extraccion;
      try {
        extraccion = await extraerTextoDeArchivo(archivoBuffer, mimeReal);
      } catch (error) {
        console.error('[asistente] Error extrayendo texto de archivo adjunto:', error?.message ?? error);
        return res.status(400).json({ error: 'No se pudo leer el contenido del archivo. Probá con otro archivo o pegá el texto directamente.' });
      }
      if (!extraccion) {
        return res.status(400).json({ error: 'No pude leer ese tipo de archivo todavía. Copiá el texto y pegalo directamente.' });
      }
      if (extraccion.esPdfEscaneado) {
        // Sin capa de texto (PDF escaneado/foto adentro de un PDF): se
        // manda tal cual al camino de visión. Gemini acepta `inlineData`
        // con mimeType 'application/pdf' directamente, sin rasterizar a
        // mano (ver comentario en asistente-providers.js sobre
        // PROVEEDORES_CON_VISION).
        imagenParaVision = { mimeType: 'application/pdf', data: archivoBase64 };
      } else {
        const textoExtraido = extraccion.texto || '';
        if (!textoExtraido) {
          return res.status(400).json({ error: 'El archivo no tiene contenido de texto legible.' });
        }
        const encabezado = '\n\n[Contenido extraído del archivo adjunto]\n';
        const espacioDisponible = MAX_LARGO_PREGUNTA - pregunta.length - encabezado.length;
        let textoParaPrompt = textoExtraido;
        if (textoParaPrompt.length > Math.max(espacioDisponible, 0)) {
          textoParaPrompt = textoParaPrompt.slice(0, Math.max(espacioDisponible, 0));
          archivoTruncado = true;
        }
        pregunta = `${pregunta}${encabezado}${textoParaPrompt}${archivoTruncado ? '\n[...texto truncado por longitud...]' : ''}`.trim();
      }
    }
  }

  if (!pregunta && !imagenParaVision) {
    return res.status(400).json({ error: "Falta el campo 'pregunta' o un archivo adjunto" });
  }
  if (pregunta.length > MAX_LARGO_PREGUNTA) {
    return res.status(400).json({ error: `El texto es demasiado largo (máximo ${MAX_LARGO_PREGUNTA} caracteres)` });
  }
  // Pregunta vacía pero con imagen/PDF escaneado (el usuario solo adjuntó
  // el archivo, sin escribir nada): se sustituye por una instrucción
  // genérica, tanto para la búsqueda semántica de artículos como para lo
  // que ve Gemini junto al adjunto — así no hace falta un camino especial
  // para "sin texto". El caso de documento-a-texto ya deja `pregunta` con
  // contenido (el texto extraído), así que no entra acá.
  if (!pregunta && imagenParaVision) {
    pregunta = 'Interpretá el archivo adjunto: puede ser un pedido, un presupuesto o una lista de stock.';
  }

  // conversacion_id es opcional: el frontend lo manda a partir de la 2da
  // pregunta de la sesión de chat (ver frontend/shared/chat-widget.js).
  const conversacionIdEntrante = req.body?.conversacion_id || null;

  try {
    const conversacionId = await resolverConversacion({
      conversacionId: conversacionIdEntrante,
      usuarioId: perfil.id,
      empresaId: perfil.empresa_id,
    });

    // El historial se pide primero y solo (no en Promise.all con la
    // búsqueda de artículos como antes) porque, si hay una repetición
    // exacta reciente, ni siquiera vale la pena generar el embedding de
    // la pregunta (ver respuestaCacheadaPorRepeticion más arriba) — esa
    // llamada también consume cuota gratuita de Gemini.
    const historial = await obtenerHistorial(conversacionId);

    const respuestaCacheada = respuestaCacheadaPorRepeticion(historial, pregunta);
    if (respuestaCacheada) {
      // Se guarda igual como un turno nuevo (para que el usuario lo vea
      // reflejado en el chat), pero sin volver a tocar ninguna API paga/
      // con cuota: ni embedding, ni búsqueda semántica, ni proveedor de
      // texto. No se llama registrarUso — no se consumió ninguna cuota,
      // así que no debería contar contra el límite de uso del usuario.
      await guardarMensajes({ conversacionId, pregunta, respuesta: respuestaCacheada });

      return res.status(200).json({
        respuesta: respuestaCacheada,
        conversacion_id: conversacionId,
        articulos_consultados: [],
        tools_usadas: [],
        accion_pendiente: null,
        opciones: null,
        proveedor: 'cache',
      });
    }

    // Frente 2 (PLAN_OPTIMIZACION_ASISTENTE_2026.md): se genera UNA sola
    // vez el embedding de la pregunta y se reusa tanto para la búsqueda
    // semántica de artículos de ayuda (ya existía) como para la de tools
    // nueva — evita pagar el costo/latencia de Gemini dos veces por el
    // mismo texto (riesgo que el propio plan señala en la sección "Riesgo
    // a vigilar" del Frente 2). Si esto falla, se propaga el error igual
    // que antes (sin embedding no hay artículos, y esa parte siempre fue
    // obligatoria) — solo la búsqueda de tools de acá abajo es fail-open.
    const embeddingPregunta = await generarEmbeddingPregunta(pregunta);

    const [articulos, sugerenciasToolsSemanticas, propuestaVigente] = await Promise.all([
      buscarArticulosRelevantes({ pregunta, rol: perfil.rol, embeddingPregunta }),
      buscarToolsRelevantesPorEmbedding(embeddingPregunta),
      obtenerPropuestaVigentePara(conversacionId),
    ]);
    const { conTools: systemPromptConTools, sinTools: systemPromptSinTools } = armarSystemPrompt({
      articulos,
      rol: perfil.rol,
      propuestaVigente,
    });

    // Frente 3 (PLAN_OPTIMIZACION_ASISTENTE_2026.md): objeto mutable, lo
    // llena esquemaParaOpenAI() -> seleccionarToolsRelevantes() más abajo.
    const metaSeleccionTools = {};

    const tools = {
      // FIX (v514): antes un solo `esquema` (formato Gemini) que solo Gemini
      // usaba. Ahora Groq/OpenRouter también ejecutan tools, pero declaran
      // funciones en el formato Chat Completions de OpenAI — se generan los
      // dos esquemas acá y cada adaptador toma el que le corresponde (ver
      // asistente-providers.js).
      // FIX (v517): se pasa el rol para que el catálogo declarado al
      // modelo ya venga filtrado a las tools que ese rol puede usar (ver
      // toolsParaRol() en asistente-tools.js) — antes se declaraban las
      // 68 tools sin importar el rol, aunque ejecutarTool() rechazara
      // igual las que no correspondían.
      // FIX (v518): además, para Groq/OpenRouter (los que realmente
      // reciben esquemaOpenAI — ver asistente-providers.js) se pasa
      // también `pregunta`, para que se seleccionen solo las tools
      // relevantes a esta pregunta puntual y el catálogo entre en el
      // límite de tokens por minuto de esos proveedores incluso para
      // dueno/admin (ver seleccionarToolsRelevantes() en asistente-tools.js).
      // Gemini sigue recibiendo el catálogo completo del rol vía
      // esquemaGemini — su falla no era de tamaño, era de cuota diaria.
      //
      // FIX (v1067): una repregunta corta tipo "y 20000" (después de
      // "cuántos clientes tienen más de $150.000 en deuda") no tiene
      // ninguna palabra que matchee ninguna tool — palabrasSignificativas
      // descarta "y" (stopword) y solo queda el número. Eso hacía caer
      // seleccionarToolsRelevantes() al set núcleo de fallback, que NO
      // incluye listar_clientes_por_deuda ni la mayoría de las tools de
      // consulta puntual: si en ese turno el proveedor activo era
      // Groq/OpenRouter (típicamente porque Gemini ya pegó 429 de cuota),
      // el modelo se quedaba sin la tool aunque la pregunta anterior
      // dejara clarísimo el tema. Gemini no tenía este problema (recibe
      // el catálogo completo + el historial, y arma el follow-up solo),
      // pero el fallback a Groq/OpenRouter es justamente el caso donde
      // más hace falta que el catálogo filtrado no pierda el hilo. Se
      // concatena el último mensaje del usuario en el historial (si lo
      // hay) a la pregunta actual, solo para el scoring de keywords —
      // no cambia qué se le manda al modelo como mensaje del turno.
      esquemaGemini: esquemaParaGemini(perfil.rol),
      // Frente 3 (PLAN_OPTIMIZACION_ASISTENTE_2026.md): metaSeleccionTools
      // se muta acá adentro (ver seleccionarToolsRelevantes()) para poder
      // registrar en asistente_uso si esta pregunta no matcheó ninguna
      // tool por keyword — independiente de qué proveedor termine
      // respondiendo el turno.
      // FIX (Frente 2): se pasa además `sugerenciasToolsSemanticas` — si
      // hay alguna, seleccionarToolsRelevantes() la usa directamente y ni
      // siquiera llega a evaluar keywords (ver ese archivo). La ventaja
      // sobre el matcheo por keyword de siempre: no depende de que la
      // pregunta comparta una raíz de palabra con el nombre/descripción
      // de la tool (ej. "clientes morosos" SÍ encuentra
      // listar_clientes_por_deuda por similitud semántica, aunque
      // "moroso" no aparezca en ningún lado de esa tool).
      esquemaOpenAI: esquemaParaOpenAI(
        perfil.rol,
        [...historial.filter((m) => m.rol === 'user').slice(-1).map((m) => m.contenido), pregunta].join(' '),
        metaSeleccionTools,
        sugerenciasToolsSemanticas,
      ),
      ejecutar: (nombre, args) =>
        ejecutarTool(nombre, {
          empresaId: perfil.empresa_id,
          rol: perfil.rol,
          usuarioId: perfil.id,
          conversacionId,
          args,
        }),
    };

    const { texto, proveedor, toolsUsadas, latenciaMs } = await responderConFallback({
      systemPromptConTools,
      systemPromptSinTools,
      historial: historial.map((m) => ({ rol: m.rol, contenido: m.contenido })),
      mensaje: pregunta,
      tools,
      imagen: imagenParaVision || undefined,
    });

    await Promise.all([
      guardarMensajes({ conversacionId, pregunta, respuesta: texto }),
      registrarUso({
        usuarioId: perfil.id,
        empresaId: perfil.empresa_id,
        pregunta,
        proveedor,
        articulosEncontrados: articulos.length,
        latenciaMs,
        cayoEnNucleoFallback: metaSeleccionTools.cayoEnNucleoFallback,
        cantidadToolsConMatch: metaSeleccionTools.cantidadToolsConMatch,
        metodoSeleccionTools: metaSeleccionTools.metodoSeleccion,
        toolFinalmenteUsada: extraerToolFinalmenteUsada(toolsUsadas),
      }),
    ]);

    return res.status(200).json({
      respuesta: texto,
      conversacion_id: conversacionId,
      articulos_consultados: articulosParaMostrar(articulos).map((a) => ({ slug: a.slug, titulo: a.titulo })),
      tools_usadas: toolsUsadas,
      accion_pendiente: extraerAccionPendiente(toolsUsadas),
      opciones: extraerOpcionesAmbiguas(toolsUsadas),
      proveedor,
      // Frente 5 (PLAN_OPTIMIZACION_ASISTENTE_2026.md): si el documento
      // adjunto era más largo que MAX_LARGO_PREGUNTA, se truncó el texto
      // extraído antes de mandarlo al modelo. El frontend puede avisarlo.
      archivo_truncado: archivoTruncado,
    });
  } catch (error) {
    console.error('[asistente] Error:', error?.message ?? error);

    // FIX (v516): antes siempre el mismo mensaje genérico ("probá de nuevo
    // en unos segundos"), sin importar la causa. Cuando la causa real es
    // que los 3 proveedores fallaron (típicamente los 3 sin cuota gratuita
    // en simultáneo — HTTP 429 en la búsqueda por texto del error), decirle
    // al usuario "probá en unos segundos" es directamente falso: la cuota
    // diaria no se libera en segundos. Se distingue ese caso puntual para
    // ser honestos sobre qué está pasando en vez de sugerir un reintento
    // que va a volver a fallar.
    // FIX (v519): faltaba el caso de imagen — responderConFallback() tira
    // un mensaje DISTINTO cuando falla adjuntando una imagen ("No se pudo
    // leer la imagen...", ver PROVEEDORES_CON_VISION en
    // asistente-providers.js), que el regex de abajo no matcheaba, así que
    // ese caso caía siempre en el mensaje genérico — el menos útil de los
    // tres, justo para el caso donde más hacía falta ser específico.
    const esFalloDeLos3Proveedores = /Los 3 proveedores fallaron/i.test(error?.message || '');
    const esFalloDeImagen = /No se pudo leer la imagen/i.test(error?.message || '');
    const mensaje = esFalloDeLos3Proveedores
      ? 'El asistente no está disponible en este momento. Probá de nuevo en unos minutos o contactá a un administrador si es urgente.'
      : esFalloDeImagen
      ? 'No se pudo leer la imagen en este momento (ninguno de los proveedores con soporte de imágenes pudo procesarla). Probá de nuevo en un rato, con una foto más chica/nítida, o cargá el pedido a mano mientras tanto.'
      : 'No se pudo generar una respuesta en este momento. Probá de nuevo en unos segundos.';

    return res.status(500).json({ error: mensaje });
  }
}

export { buscarArticulosRelevantes, armarSystemPrompt, obtenerPropuestaVigentePara };
