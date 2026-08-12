// lib/asistente-providers.js
//
// Adaptadores para los 3 proveedores de IA del asistente de ayuda (Gemini,
// Groq, OpenRouter) y la cadena de fallback que los orquesta, reutilizando
// el CircuitBreaker y el withRetry ya existentes en el proyecto
// (lib/circuit-breaker.js, lib/retry.js — Módulo 2: Resiliencia API) en vez
// de duplicar esa lógica.
//
// Tool calling: los 3 proveedores reciben el catálogo de tools y pueden
// pedir ejecutar una función (ver lib/asistente-tools.js). Gemini usa su
// propio formato (function_declarations); Groq y OpenRouter comparten el
// formato "Chat Completions" de OpenAI (tools: [{type:'function',...}]).
// Si algún proveedor pide una tool, se ejecuta acá mismo (execute()) y se
// le manda el resultado de vuelta en un segundo round-trip para que arme
// la respuesta final en texto.
//
// FIX (v514): antes solo Gemini tenía tools — Groq/OpenRouter (fallback)
// respondían solo con los artículos de la base de conocimiento (RAG), sin
// datos en vivo, bajo la premisa de que son modelos chicos de capa
// gratuita, menos confiables eligiendo la herramienta correcta. En la
// práctica, la cuota gratuita de Gemini es chica e inconsistente entre
// cuentas (Google la recortó varias veces durante 2025-2026), y el
// asistente se quedaba sin poder responder datos reales de la cuenta
// apenas esa cuota se agotaba en el día — el problema real a resolver.
// Groq (llama-3.3-70b-versatile, free ~1000 req/día) y OpenRouter (router
// `openrouter/free`, que elige un modelo gratuito compatible con tool
// calling) sí soportan function calling de forma confiable, así que ahora
// también reciben las tools — dan MUCHO más margen diario gratis que
// depender solo de Gemini.
//
// Uso típico desde lib/handlers/asistente.js:
//
//   import { responderConFallback } from '../asistente-providers.js';
//   const { texto, proveedor, toolsUsadas, latenciaMs } = await responderConFallback({
//     systemPromptConTools: '...',   // para proveedores que sí pueden ejecutar tools
//     systemPromptSinTools: '...',   // reserva, por si algún proveedor quedara sin tools
//     historial: [{ rol: 'user', contenido: '...' }, { rol: 'model', contenido: '...' }],
//     mensaje: '...',
//     tools: { esquemaGemini: [...], esquemaOpenAI: [...], ejecutar: (nombre, args) => {...} },
//   });

import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker.js';
import { withRetry } from './retry.js';

// ---------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------

const CONFIG = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    // FIX (v524, cuenta paga): sigue siendo gemini-2.5-flash por defecto
    // (buena relación velocidad/costo para un chatbot de ayuda). Con
    // facturación activa, si en algún momento se quiere priorizar calidad
    // de respuesta por sobre costo, alcanza con setear GEMINI_MODEL=
    // gemini-2.5-pro en las variables de entorno — no hace falta tocar
    // código, ya está parametrizado.
    modelo: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    // Antes 15_000: pensado para no acumular latencia mientras se esperaba
    // que el circuit breaker cortara ante la cuota gratuita agotada. Con
    // cuenta paga ese motivo desaparece y el timeout puede ser un poco más
    // generoso — una respuesta con varias vueltas de tools o una imagen
    // pesada puede tardar algo más sin que sea una falla real.
    timeoutMs: 20_000,
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    // FIX (v520): llama-3.3-70b-versatile (el de antes) fue deprecado por
    // Groq el 17/06/2026 junto con qwen3-32b y llama-4-scout — Groq avisó
    // que deja de responder "en agosto 2026" (fuentes externas lo
    // confirman: shutdown para esa fecha). Estamos a 30/07, o sea a días
    // de que esto se rompiera solo iba a repetir el mismo problema del
    // 404 que ya pasó con la visión (ver más abajo). Se migra PROACTIVA-
    // MENTE a openai/gpt-oss-120b — es el reemplazo que Groq recomienda
    // en su propia página de deprecaciones, y a diferencia de
    // qwen/qwen3.6-27b (usado abajo para visión) NO está en estado
    // Preview del lado de Groq.
    //
    // Importante — cambia el límite de TPM: gpt-oss-120b tiene 8.000 TPM
    // en el free tier (antes 12.000 con el modelo viejo). La selección
    // dinámica de tools del v518 (tope de 20 tools, ~4.000-5.000 tokens
    // en la práctica) sigue entrando cómoda, pero el margen se achicó —
    // si en el futuro se vuelve a ver 413 de Groq, revisar acá primero.
    modelo: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    // FIX (v519/v520): modelo aparte para imágenes. meta-llama/llama-4-
    // scout-17b-16e-instruct (v519) TAMBIÉN fue deprecado el 17/06/2026 y
    // ya devolvía 404 "model_not_found" en producción (ver
    // CHANGELOG_v520). Reemplazado por qwen/qwen3.6-27b, el modelo con
    // visión vigente hoy según la doc actual de Groq (console.groq.com/
    // docs/vision) — multimodal, tool calling, JSON mode. Groq lo sirve
    // como Preview (no gpt-oss-120b, que no tiene visión), así que el
    // riesgo de rotación sigue latente acá — mismo motivo por el que
    // sigue siendo SEGUNDO intento, nunca reemplazando a Gemini.
    modeloVision: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b',
    timeoutMs: 12_000,
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    // FIX (v514): antes un modelo :free puntual (meta-llama/llama-3.1-8b-instruct:free).
    // Los modelos :free individuales de OpenRouter rotan y se dan de baja sin aviso
    // (pasó con buena parte de la línea Llama gratuita en julio 2026), y ese 8B chico
    // no soporta tool calling de forma confiable. `openrouter/free` es el router propio
    // de OpenRouter: elige al azar, en cada request, un modelo gratuito ACTUALMENTE
    // disponible, filtrando automáticamente por los que soportan la capacidad que se
    // necesita (acá, tool calling) — no hay que mantener actualizado un nombre de modelo.
    modelo: process.env.OPENROUTER_MODEL || 'openrouter/free',
    timeoutMs: 15_000,
  },
};

// Máximo de tools que se ejecutan en una misma pregunta. Un límite chico
// a propósito: esto es un chatbot de ayuda, no un agente — si el modelo
// pide más de esto, algo salió mal (loop) y es mejor cortar y responder
// con lo que haya.
const TOOL_CALLS_MAX = 3;

// Orden de la cadena de fallback. Se puede reordenar según prioridad
// (por ejemplo, priorizar Groq por latencia, y dejar Gemini de reserva).
//
// NOTA (v524, cuenta paga de Gemini): con facturación activa, Gemini deja
// de quedarse sin cuota diaria a mitad de jornada — pero eso no vuelve
// innecesario a Groq/OpenRouter. Siguen cubriendo el otro tipo de falla
// (Gemini caído, un 5xx puntual de Google, un timeout de red), que puede
// pasar en cualquier proveedor con o sin plan pago. Sacarlos de la cadena
// cambiaría "3 intentos antes de fallarle al usuario" por "1 solo intento",
// que va exactamente en contra del objetivo de "sin interrupciones" — se
// mantienen a propósito como red de seguridad, ahora rara vez necesaria en
// la práctica pero igual de valiosa el día que Gemini tenga un problema.
const ORDEN_PROVEEDORES = ['gemini', 'groq', 'openrouter'];

// Un circuit breaker independiente por proveedor. Igual que el resto del
// proyecto, su alcance real es por instancia serverless cálida (Vercel).
// timeoutMs va un poco por encima del timeout del propio fetch (que corta
// primero vía AbortController) para que sea solo una red de seguridad.
const circuitBreakers = {
  gemini: new CircuitBreaker({ name: 'asistente:gemini', umbralFallas: 3, tiempoRecuperacion: 60_000, timeoutMs: CONFIG.gemini.timeoutMs + 2000 }),
  groq: new CircuitBreaker({ name: 'asistente:groq', umbralFallas: 3, tiempoRecuperacion: 30_000, timeoutMs: CONFIG.groq.timeoutMs + 2000 }),
  openrouter: new CircuitBreaker({ name: 'asistente:openrouter', umbralFallas: 3, tiempoRecuperacion: 30_000, timeoutMs: CONFIG.openrouter.timeoutMs + 2000 }),
};

// ---------------------------------------------------------------------
// Helper de fetch con timeout (AbortController — corta la conexión de
// verdad, a diferencia de un simple Promise.race).
// ---------------------------------------------------------------------

async function fetchConTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });

    if (!res.ok) {
      const cuerpo = await res.text().catch(() => '');
      const error = new Error(`HTTP ${res.status} de ${url}: ${cuerpo.slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }

    return res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// Mapea nuestro historial genérico ({ rol: 'user'|'model', contenido }) al
// formato "contents" de Gemini.
function historialAContentsGemini(historial) {
  return (historial || []).map((m) => ({
    role: m.rol === 'model' ? 'model' : 'user',
    parts: [{ text: m.contenido }],
  }));
}

// Mismo historial genérico, pero al formato "messages" de Chat Completions
// (OpenAI-compatible), que usan tanto Groq como OpenRouter.
function historialAMessagesOpenAI(historial) {
  return (historial || []).map((m) => ({
    role: m.rol === 'model' ? 'assistant' : 'user',
    content: m.contenido,
  }));
}

// ---------------------------------------------------------------------
// Adaptador: Gemini (con tool calling opcional)
// ---------------------------------------------------------------------

async function llamarGemini({ systemPrompt, historial, mensaje, tools, imagen }) {
  const { apiKey, modelo, timeoutMs } = CONFIG.gemini;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

  // imagen: { mimeType, data } opcional, con `data` en base64 sin el
  // prefijo `data:...;base64,` (ver lib/handlers/asistente.js, que ya lo
  // valida y lo separa antes de llegar acá). Solo se adjunta al turno
  // actual del usuario, nunca al historial — el historial ya quedó
  // guardado como texto (ver guardarMensajes en el handler), no vale la
  // pena mandar la imagen de vuelta en cada pregunta de seguimiento.
  const partesUsuario = [{ text: mensaje }];
  if (imagen?.data && imagen?.mimeType) {
    partesUsuario.push({ inlineData: { mimeType: imagen.mimeType, data: imagen.data } });
  }

  const contents = [
    ...historialAContentsGemini(historial),
    { role: 'user', parts: partesUsuario },
  ];

  const bodyBase = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    // maxOutputTokens: 800 -> 1200 (interpretar texto largo pegado o una
    // imagen con varias líneas de pedido) -> 2048 (FIX v524, cuenta paga):
    // ya no hace falta cuidar cada respuesta larga contra una cuota diaria
    // gratuita compartida — se prioriza que el asistente pueda dar una
    // respuesta completa (por ejemplo, un diagnóstico con varios pasos o
    // una lista larga de pedidos) sin cortarse a mitad de camino.
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  };

  if (tools?.esquemaGemini?.length) {
    bodyBase.tools = [{ function_declarations: tools.esquemaGemini }];
  }

  const toolsUsadas = [];
  let vueltas = 0;

  // Round-trip inicial + hasta TOOL_CALLS_MAX vueltas más si el modelo
  // sigue pidiendo funciones.
  while (true) {
    const data = await fetchConTimeout(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bodyBase, contents }) },
      timeoutMs
    );

    const candidato = data?.candidates?.[0];
    const partes = candidato?.content?.parts || [];
    const funcionPedida = partes.find((p) => p.functionCall)?.functionCall;

    if (!funcionPedida) {
      const texto = partes.find((p) => p.text)?.text;
      if (!texto) throw new Error('Gemini devolvió una respuesta vacía o inesperada');
      return { texto, toolsUsadas };
    }

    if (!tools?.ejecutar || vueltas >= TOOL_CALLS_MAX) {
      // O no hay forma de ejecutar tools, o se pasó del límite de vueltas:
      // cortamos el loop y le pedimos una respuesta sin más funciones.
      break;
    }
    vueltas += 1;

    let resultado;
    let ok = true;
    try {
      resultado = await tools.ejecutar(funcionPedida.name, funcionPedida.args || {});
    } catch (error) {
      ok = false;
      resultado = { error: error.message };
    }
    // Se guarda el resultado COMPLETO (no solo el flag ok): cuando la tool
    // es de escritura (requiereConfirmacion:true, ver asistente-tools.js),
    // el resultado trae { pendiente_confirmacion, id_confirmacion, resumen }
    // y lib/handlers/asistente.js necesita esos campos para dibujarle los
    // botones Confirmar/Cancelar al usuario — no alcanza con saber si la
    // llamada "salió bien".
    toolsUsadas.push({ nombre: funcionPedida.name, args: funcionPedida.args || {}, ok, resultado });

    // El propio turno del modelo (pidiendo la función) entra al historial
    // de "contents", seguido del resultado de la función — así Gemini
    // tiene el contexto completo para la siguiente vuelta.
    contents.push({ role: 'model', parts: [{ functionCall: funcionPedida }] });
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: funcionPedida.name, response: { resultado } } }],
    });
  }

  // Vueltas agotadas: se pide una respuesta final sin declarar tools, para
  // forzar texto en vez de otra function call.
  const dataFinal = await fetchConTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bodyBase, tools: undefined, contents }),
    },
    timeoutMs
  );

  const textoFinal = dataFinal?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!textoFinal) throw new Error('Gemini no devolvió texto final tras agotar las tools disponibles');
  return { texto: textoFinal, toolsUsadas };
}

// ---------------------------------------------------------------------
// Helper compartido: Chat Completions (formato OpenAI) con tool calling.
// Groq y OpenRouter son ambos compatibles con este formato, así que la
// lógica del round-trip de tools (idéntica en espíritu a llamarGemini) se
// escribe una sola vez acá y cada adaptador solo arma la URL/headers/modelo.
// ---------------------------------------------------------------------

async function llamarChatCompletionsConTools({ url, headers, modelo, timeoutMs, systemPrompt, historial, mensaje, tools, maxTokens, imagen, extraBody }) {
  // FIX (v519): si viene `imagen`, el turno del usuario no es un string
  // plano — es el formato de contenido multimodal de Chat Completions
  // (array de partes `text` + `image_url`, con la imagen como data URI).
  // Mismo criterio que ya usa llamarGemini con `inlineData`: la imagen
  // SOLO va en el turno actual, nunca se reinyecta en el historial viejo.
  const contenidoUsuario = imagen?.data && imagen?.mimeType
    ? [
        { type: 'text', text: mensaje },
        { type: 'image_url', image_url: { url: `data:${imagen.mimeType};base64,${imagen.data}` } },
      ]
    : mensaje;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historialAMessagesOpenAI(historial),
    { role: 'user', content: contenidoUsuario },
  ];

  // FIX (v521): con `imagen` NO se manda el catálogo de tools. En
  // producción, Groq devolvió 413 "Request too large" para el modelo de
  // visión (qwen/qwen3.6-27b, límite de 8.000 TPM en el free tier): el
  // esquema de tools (hasta 20, ~4.000-5.000 tokens según v518) sumado a
  // la imagen se pasaba del límite (9.704 solicitados vs 8.000). Leer una
  // foto de un pedido/remito es una tarea de una sola vuelta (transcribir
  // lo que se ve), no necesita consultar stock/clientes en el mismo
  // request — si el usuario necesita ese dato después, lo pregunta en
  // texto plano sin imagen, donde las tools sí van completas.
  const toolsOpenAI = (!imagen && tools?.esquemaOpenAI?.length) ? tools.esquemaOpenAI : undefined;
  const toolsUsadas = [];
  let vueltas = 0;

  while (true) {
    const body = { model: modelo, messages, temperature: 0.3, max_tokens: maxTokens, ...extraBody };
    if (toolsOpenAI && tools?.ejecutar && vueltas < TOOL_CALLS_MAX) body.tools = toolsOpenAI;

    const data = await fetchConTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
    const mensajeRespuesta = data?.choices?.[0]?.message;
    const toolCalls = mensajeRespuesta?.tool_calls;

    if (!toolCalls?.length) {
      const texto = limpiarRazonamiento(mensajeRespuesta?.content);
      if (!texto) throw new Error('Respuesta vacía o inesperada');
      return { texto, toolsUsadas };
    }

    if (!tools?.ejecutar || vueltas >= TOOL_CALLS_MAX) break;
    vueltas += 1;

    // El propio turno del modelo (pidiendo la/las función/es) entra al
    // historial de "messages" tal cual vino, seguido de un mensaje role:
    // 'tool' por cada tool_call — así el modelo tiene el contexto completo
    // para la siguiente vuelta (mismo criterio que Gemini más arriba).
    messages.push(mensajeRespuesta);
    for (const llamada of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(llamada.function?.arguments || '{}');
      } catch {
        args = {};
      }

      let resultado;
      let ok = true;
      try {
        resultado = await tools.ejecutar(llamada.function?.name, args);
      } catch (error) {
        ok = false;
        resultado = { error: error.message };
      }
      toolsUsadas.push({ nombre: llamada.function?.name, args, ok, resultado });

      messages.push({ role: 'tool', tool_call_id: llamada.id, content: JSON.stringify(resultado) });
    }
  }

  // Vueltas agotadas: se pide una respuesta final sin declarar tools, para
  // forzar texto en vez de otro tool_call.
  const dataFinal = await fetchConTimeout(
    url,
    { method: 'POST', headers, body: JSON.stringify({ model: modelo, messages, temperature: 0.3, max_tokens: maxTokens, ...extraBody }) },
    timeoutMs
  );
  const textoFinal = limpiarRazonamiento(dataFinal?.choices?.[0]?.message?.content);
  if (!textoFinal) throw new Error('No devolvió texto final tras agotar las tools disponibles');
  return { texto: textoFinal, toolsUsadas };
}

// FIX (v522): red de seguridad además de `reasoning_format: 'hidden'`
// (ver llamarGroq). Groq documentó ese parámetro como la forma correcta
// de ocultar el razonamiento, pero hay reportes de la propia comunidad de
// Groq de modelos que igual dejan pasar texto de razonamiento suelto en
// algunos casos. Esto saca cualquier bloque `<think>...</think>` (con o
// sin cierre, por si la respuesta se corta a mitad del pensamiento) antes
// de que el texto llegue al usuario. Es un no-op inofensivo para
// Gemini/OpenRouter, que normalmente no usan estas tags.
function limpiarRazonamiento(texto) {
  if (!texto) return texto;
  return texto
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // bloque completo
    .replace(/<think>[\s\S]*$/gi, '') // bloque sin cerrar (respuesta cortada)
    .trim();
}

// ---------------------------------------------------------------------
// Adaptador: Groq (API compatible con OpenAI Chat Completions)
// ---------------------------------------------------------------------

async function llamarGroq({ systemPrompt, historial, mensaje, tools, imagen }) {
  const { apiKey, modelo, modeloVision, timeoutMs } = CONFIG.groq;
  if (!apiKey) throw new Error('GROQ_API_KEY no configurada');

  // FIX (v519): con imagen se manda el modelo con visión (ver comentario
  // en CONFIG.groq), NUNCA el de texto normal — llama-3.3-70b-versatile
  // no tiene forma de interpretar una imagen y, si se le mandara igual,
  // el riesgo es que "alucine" una respuesta ignorando el adjunto en vez
  // de fallar limpio (mismo motivo por el que PROVEEDORES_CON_VISION
  // existe para no degradar a un proveedor sin soporte real).
  //
  // FIX (v522): tanto qwen/qwen3.6-27b (visión) como openai/gpt-oss-120b
  // (texto) son modelos "razonadores" del lado de Groq — por defecto
  // devuelven su cadena de pensamiento interna mezclada en el mismo
  // `message.content`, envuelta en tags `<think>...</think>` (reportado
  // por un usuario real: vio ese texto crudo, en inglés, en el chat).
  // `reasoning_format: 'hidden'` (documentado en console.groq.com/docs/
  // reasoning) le pide a Groq que devuelva SOLO la respuesta final, sin
  // el razonamiento. No se manda a OpenRouter: ahí el router `openrouter/
  // free` elige un modelo distinto en cada request y no todos van a
  // reconocer este parámetro específico de Groq.
  return llamarChatCompletionsConTools({
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    modelo: imagen ? modeloVision : modelo,
    timeoutMs,
    systemPrompt,
    historial,
    mensaje,
    tools,
    imagen,
    maxTokens: 800,
    extraBody: { reasoning_format: 'hidden' },
  });
}

// ---------------------------------------------------------------------
// Adaptador: OpenRouter (también compatible con OpenAI Chat Completions)
// ---------------------------------------------------------------------

async function llamarOpenRouter({ systemPrompt, historial, mensaje, tools }) {
  const { apiKey, modelo, timeoutMs } = CONFIG.openrouter;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no configurada');

  return llamarChatCompletionsConTools({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      // Recomendado por OpenRouter para identificar la app en su dashboard.
      'HTTP-Referer': process.env.SITE_URL || 'https://localhost',
      'X-Title': 'Asistente de ayuda distrib',
    },
    modelo,
    timeoutMs,
    systemPrompt,
    historial,
    mensaje,
    tools,
    maxTokens: 800,
  });
}

const ADAPTADORES = {
  gemini: llamarGemini,
  groq: llamarGroq,
  openrouter: llamarOpenRouter,
};

// FIX (v514): antes solo Gemini ('gemini'). Ver comentario de cabecera —
// Groq y OpenRouter ahora también reciben tools (con su propio formato,
// armado en lib/handlers/asistente.js vía esquemaParaOpenAI()).
const PROVEEDORES_CON_TOOLS = new Set(['gemini', 'groq', 'openrouter']);

// FIX (v519): antes solo Gemini ('gemini') — era el único con soporte real
// de imágenes en este proyecto, así que degradar a Groq/OpenRouter con una
// imagen adjunta significaba que esos adaptadores ignoraban el adjunto por
// completo y contestaban solo en base al texto, arriesgando una respuesta
// que sonara "vista" sin haberlo hecho (ver comentario original más abajo,
// que se mantiene vigente para OpenRouter). Ahora Groq también tiene un
// modelo con visión real (`qwen/qwen3.6-27b` desde el FIX v520 — ver
// CONFIG.groq.modeloVision) y entra como SEGUNDO intento — el orden de
// ORDEN_PROVEEDORES ya pone a Gemini primero, así que Groq solo se prueba
// si Gemini no pudo (sin cuota, timeout, etc.), nunca reemplazándolo.
//
// OpenRouter se deja afuera a propósito por ahora: el router `openrouter/
// free` no garantiza qué modelo puntual contesta en cada request, así que
// no hay forma de asegurar que el modelo elegido esa vez tenga visión —
// mandarle la imagen igual arriesgaría el mismo problema de "alucinar sin
// haber visto nada" que este mismo fix busca evitar. Si en el futuro se
// fija un modelo puntual con visión confirmada en OpenRouter (no el router
// automático), se puede sumar acá.
const PROVEEDORES_CON_VISION = new Set(['gemini', 'groq']);

// ---------------------------------------------------------------------
// Orquestador: cadena de fallback
// ---------------------------------------------------------------------
//
// Prueba cada proveedor en orden. breaker.exec() ya se encarga de rechazar
// de inmediato si el circuito está abierto (CircuitBreakerOpenError), sin
// gastar tiempo en intentarlo. Si todos fallan, tira un error con el
// detalle de cada intento.

async function responderConFallback({ systemPromptConTools, systemPromptSinTools, historial, mensaje, tools, imagen }) {
  const inicio = Date.now();
  const erroresPorProveedor = {};

  const proveedoresAIntentar = imagen
    ? ORDEN_PROVEEDORES.filter((p) => PROVEEDORES_CON_VISION.has(p))
    : ORDEN_PROVEEDORES;

  for (const nombreProveedor of proveedoresAIntentar) {
    const breaker = circuitBreakers[nombreProveedor];
    const adaptador = ADAPTADORES[nombreProveedor];
    const tieneTools = PROVEEDORES_CON_TOOLS.has(nombreProveedor);
    const toolsParaEsteProveedor = tieneTools ? tools : undefined;
    // El systemPrompt se ajusta según si ESTE proveedor puede ejecutar tools
    // (ver armarSystemPrompt() en lib/handlers/asistente.js): hoy los 3
    // están en PROVEEDORES_CON_TOOLS, así que en la práctica siempre se usa
    // systemPromptConTools — systemPromptSinTools queda de red de
    // seguridad para si algún proveedor se saca de ese set más adelante
    // (ej. si su modelo gratuito deja de soportar function calling de forma
    // confiable) y no debería recibir esas instrucciones sin poder cumplirlas.
    const systemPrompt = tieneTools ? systemPromptConTools : systemPromptSinTools;

    try {
      const { texto, toolsUsadas } = await breaker.exec(() =>
        withRetry(
          () => adaptador({ systemPrompt, historial, mensaje, tools: toolsParaEsteProveedor, imagen }),
          { intentos: 2, baseDelayMs: 400 }
        )
      );

      return {
        texto,
        proveedor: nombreProveedor,
        toolsUsadas: toolsUsadas || [],
        latenciaMs: Date.now() - inicio,
      };
    } catch (error) {
      erroresPorProveedor[nombreProveedor] =
        error instanceof CircuitBreakerOpenError ? 'circuito abierto (fallos recientes)' : error.message;
      // sigue con el próximo proveedor de la cadena
    }
  }

  const detalle = Object.entries(erroresPorProveedor)
    .map(([proveedor, msg]) => `${proveedor}: ${msg}`)
    .join(' | ');

  if (imagen) {
    throw new Error(`No se pudo leer la imagen en este momento (Gemini no respondió). Detalle: ${detalle}`);
  }
  throw new Error(`Los 3 proveedores fallaron. Detalle: ${detalle}`);
}

// Útil para exponer el estado de los circuit breakers en un endpoint
// de diagnóstico o en el panel de admin.
function estadoProveedores() {
  return Object.fromEntries(
    Object.entries(circuitBreakers).map(([nombre, breaker]) => [nombre, breaker.healthcheck()])
  );
}

export { responderConFallback, estadoProveedores };
