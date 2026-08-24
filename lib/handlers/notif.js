// api/notif/index.js
// Router consolidado de notificaciones. Reúne en un solo Serverless Function:
//
//   - WhatsApp (antes api/notif/whatsapp.js)
//   - Eventos de entrega (antes api/notif/notif-entrega.js)
//   - Push interno desde triggers de Supabase (antes api/notif/push-interno.js)
//   - Registro/desregistro de dispositivos push (antes en api/notif/push.js)
//   - Push chofer (antes api/notif/push-chofer.js)
//   - Cheques por vencer CRON (antes api/notif/cheques-por-vencer.js)
//   - Deuda vencida CRON (antes api/notif/deuda-vencida.js)
//   - Estado de cuenta (antes api/estado-cuenta/index.js)
//
// ── Entradas ──────────────────────────────────────────────────────────────
//
//   POST /api/notif/whatsapp        → { template, telefono, params }
//   POST /api/notif/notif-entrega   → { evento, ruta_id | pedido_id, motivo? }
//     evento="proximidad" (Etapa 1 logística): { pedido_id, eta_minutos } —
//     avisa al cliente "tu pedido está a ~X min". Disparado automáticamente
//     por rutas-live.js cuando el GPS del chofer cruza el umbral.
//   POST /api/notif/push-interno    → { empresa_id, tipo, titulo, cuerpo, datos }
//   POST   /api/notif/push          → { usuario_id, empresa_id, token_push, tipo_dispositivo }
//   DELETE /api/notif/push          → { usuario_id, token_push }
//   POST /api/notif/cheques-por-vencer → cron (x-cron-secret)
//   POST /api/notif/deuda-vencida   → cron (x-cron-secret)
//   POST /api/estado-cuenta         → { cliente_id } + Bearer token
//   POST /api/notif/reintentar-email → { notif_log_id } + Bearer token
//     (Hallazgo 2, auditoría notificaciones) Reintenta un envío de email
//     que quedó registrado en notif_log con entregada=false. Reconstruye
//     el email desde datos frescos (no reenvía el HTML guardado, lo
//     vuelve a generar) y llama al mismo enviarEmailXxx() que el flujo
//     original. Requiere rol dueno/admin. Tipos soportados: 
//     confirmacion_pedido, pedido_despachado, estado_cuenta,
//     recepcion_proveedor.
//   GET  /api/notif/whatsapp-webhook  → verificación del webhook de Meta
//     (hub.mode/hub.verify_token/hub.challenge)
//   POST /api/notif/whatsapp-webhook  → mensajes entrantes de WhatsApp
//     (Etapa 6 — bidireccional, ver
//     supabase/migrations/246_etapa6_whatsapp_bidireccional.sql y
//     lib/whatsapp-pedido-tools.js)
//   POST /api/notif/whatsapp-embedded-signup → alta de WhatsApp Business
//     propio de una empresa (Etapa 7, ver
//     supabase/migrations/272_etapa7_whatsapp_embedded_signup.sql). Body:
//     { code, waba_id, phone_number_id } — devueltos por el JS SDK de Meta
//     al terminar el flujo de Embedded Signup en el frontend. Requiere
//     Bearer token de un usuario con rol dueno/admin.
//
// ── Variables de entorno requeridas ─────────────────────────────────────────
//
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_VERIFY_TOKEN, WA_APP_SECRET
//     (número/token globales — quedan como fallback para empresas que
//     todavía no conectaron su propio número vía Embedded Signup)
//   WA_APP_ID (Etapa 7 — App ID de Meta, junto con WA_APP_SECRET se usa
//     para el intercambio server-to-server del código de Embedded Signup)
//   WA_ENDPOINT, INTERNAL_API_KEY, CRON_SECRET
//   GEMINI_API_KEY (+ GROQ_API_KEY/OPENROUTER_API_KEY opcionales) — mismo
//   fallback que el asistente de ayuda, ver lib/asistente-providers.js.
//
// ─────────────────────────────────────────────────────────────────────────────

import { createClient }            from '@supabase/supabase-js';
import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import crypto                      from 'node:crypto';
import { enviarPush, notificarPedidoEntregado, notificarDeudaVencida } from './_push.js';
import {
  enviarEmailEstadoCuenta,
  enviarEmailConfirmacionPedido,
  enviarEmailDespacho,
  enviarEmailRecepcionProveedor,
} from '../email.js';
import { rateLimit }               from '../rate-limit.js';
import { verificarToken }          from '../auth-helpers.js';
import { esEmpresaDemo, whatsappSimulado } from '../demo-mode.js';
import { responderConFallback } from '../asistente-providers.js';
import { esquemaPedidoWhatsAppGemini, esquemaPedidoWhatsAppOpenAI, ejecutarToolPedidoWhatsApp } from '../whatsapp-pedido-tools.js';
import { errorSeguro } from '../error-response.js';
import { cifrar, descifrar } from '../crypto-secrets.js';
import { calcularTotalesPedido, calcularIvaPonderadoCombo } from '../calc/pedido-totales.js';
import { obtenerProductosParaCotizarPedido } from '../repos/productos.js';
import { obtenerCombosParaValidarPedido } from '../repos/combos.js';
import { listarUltimosMovimientos } from '../repos/cta-cte.js';
import {
  ultimoEnvioPorTipo,
  ultimoEnvioPorCliente,
  listarAdminsDueno,
  listarChequesPorIds,
  listarChequesPorVencer,
  listarClientesActivosConCtaCte,
  actualizarNecesitaReconexionWhatsapp,
  registrarLog,
  obtenerPerfilEstadoCuenta,
  obtenerClienteEstadoCuenta,
  obtenerClienteEstadoCuentaPorId,
  listarFacturasPendientes,
  registrarLogConAviso,
  obtenerNotifLogPorId,
  obtenerEmpresaParaEmail,
  obtenerClienteParaReintento,
  obtenerPedidoConItemsParaReintento,
  obtenerPedidoDespachoParaReintento,
  obtenerRecepcionParaReintento,
  obtenerOrdenCompraConProveedor,
  obtenerRutaDeEmpresa,
  listarEntregasDeRuta,
  marcarRutaEnCamino,
  obtenerPedidoParaNotifEntrega,
  marcarPedidoEntregado,
  listarUsuariosPorRoles,
  obtenerUsuarioDeEmpresa,
  upsertDispositivoPush,
  desactivarDispositivoPush,
} from '../repos/notif.js';
// Fase 4 (plan ERP de sincronización): emitirEvento/usaDespachadorEventos
// son livianos y sin ciclo (eventos.js solo importa supabase-lazy.js) —
// se importan estáticos acá. lib/eventos-dispatcher.js NO se importa
// estático (ver import dinámico más abajo, en handleDeudaCron): ese sí
// cerraría un ciclo, porque el dispatcher importa el listener de
// cliente_en_mora, que a su vez importa enviarAvisoDeudaVencida de este
// mismo archivo. Mismo patrón ya documentado en pedidos.js (Fase 3).
import { emitirEvento, usaDespachadorEventos } from '../eventos.js';
import { puede } from '../permisos-service.js';
// Punto 8 (auditoría financiera 2026) — reproceso del outbox
// audit_log_pendientes, ver handleAuditLogReprocesarCron más abajo.
import { reprocesarAuditoriaPendientes } from '../repos/audit.js';
// Lote 4 (fase 7, paso 7): bot conversacional de WhatsApp — repo propio,
// ver cabecera de lib/repos/whatsapp-bot.js.
import {
  obtenerCredencialesWhatsapp,
  guardarCredencialesWhatsapp,
  buscarConversacionAbiertaPorTelefono,
  buscarConversacionAbiertaPorTelefonoYEmpresa,
  obtenerEmpresaPorPhoneNumberId,
  obtenerEmpresaPorWabaId,
  actualizarEstadoConexionWhatsapp,
  marcarHistorialSincronizado,
  buscarClientePorTelefonoEnEmpresa,
  resolverClientePorTelefonoRpc,
  buscarConversacionAbiertaIdPorEmpresa,
  crearConversacion,
  obtenerEstadoYBorrador,
  actualizarUltimaInteraccion,
  marcarConversacionActiva,
  reiniciarBorradorConversacion,
  cerrarConversacionConPedido,
  marcarConversacionDerivada,
  obtenerConversacionEmpresaTelefono,
  obtenerConversacionParaAccion,
  tomarConversacion,
  liberarConversacion,
  registrarMensajeWhatsapp,
  obtenerHistorialMensajes,
  contarMensajesEntrantes,
  obtenerClienteParaPedidoWhatsapp,
  obtenerStockParaPedidoWhatsapp,
  resolverPreciosClienteRpc,
  crearPedidoClienteRpc,
  obtenerNumeroPedido,
  obtenerSalientesPendientes,
  marcarSalienteEnviado,
  marcarSalienteFallido,
  MAX_INTENTOS_SALIENTE,
} from '../repos/whatsapp-bot.js';


const limiterWhatsApp = rateLimit({ max: 10, windowMs: 60_000 }); // WA tiene costo por mensaje
const limiterPush     = rateLimit({ max: 30, windowMs: 60_000 });
const limiterGeneral  = rateLimit({ max: 60, windowMs: 60_000 });
// Etapa 3 (Cta. cte. y cobros), Hallazgo 1: estado-cuenta envía un email
// real por Resend (costo por envío, igual que WhatsApp) pero no tenía
// ningún rate limit — a diferencia de limiterWhatsApp/limiterPush de acá
// arriba, se podía spamear sin límite.
const limiterEstadoCuenta = rateLimit({ max: 10, windowMs: 60_000 });
// Rate limit propio del webhook entrante de Meta (Etapa 3). Más permisivo
// que el de usuarios logueados porque acá puede pegar tráfico legítimo de
// varios clientes distintos escribiendo al mismo tiempo, pero no cero —
// contiene el abuso si alguien encuentra la URL (no hay token de usuario
// que filtrar en este endpoint, lo saltea a propósito el router principal).
const limiterWebhookWhatsApp = rateLimit({ max: 60, windowMs: 60_000 });

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

// ═════════════════════════════════════════════════════════════════════════
// ── Router principal ─────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // ── Sub-router: cron jobs + estado-cuenta ─────────────────────────
  const _svc = req.query._svc;
  if (_svc === 'cheques-cron')       return handleChequesCron(req, res);
  if (_svc === 'deuda-cron')         return handleDeudaCron(req, res);
  // Fase 4 (plan ERP de sincronización): barrido periódico de
  // eventos_negocio en estado 'pendiente' o 'error' — reprocesa lo que
  // quedó sin despachar (ej. una empresa activó el flag después de que el
  // evento ya se había emitido) o lo que falló (ej. un listener que tiró
  // por un corte de red puntual). No existía en la Fase 3 porque con un
  // solo tipo de evento (pedido_creado) y despacho inmediato no hacía
  // falta — con cliente_en_mora sumado acá, ya vale la pena. Ver
  // handleEventosReprocesarCron más abajo.
  if (_svc === 'eventos-reprocesar-cron') return handleEventosReprocesarCron(req, res);
  // Etapa 5 offline, punto 3 — reintento diario de salientes del bot que
  // quedaron pendientes (ver responderYRegistrar/enviarTextoWhatsApp más
  // arriba). Mismo esquema de auth que eventos-reprocesar-cron.
  if (_svc === 'whatsapp-salientes-reprocesar-cron') return handleWhatsappSalientesReprocesarCron(req, res);
  // Punto 8 (auditoría financiera 2026) — outbox de auditoría durable
  // (lib/repos/audit.js). Mismo esquema de auth y mismo criterio de "1
  // corrida diaria" que los dos crons de arriba.
  if (_svc === 'audit-log-reprocesar-cron') return handleAuditLogReprocesarCron(req, res);
  if (_svc === 'estado-cuenta')      return handleEstadoCuenta(req, res);
  // Reintento manual de emails fallidos desde el panel de historial de
  // notificaciones (Hallazgo 2, auditoría notificaciones). Auth de usuario
  // vía Bearer — ver handleReintentarEmail más abajo.
  if (_svc === 'reintentar-email')   return handleReintentarEmail(req, res);
  // Webhook de Meta: sin auth de usuario (lo llama Meta, no el frontend).
  // Dedupe por wa_message_id adentro del handler protege contra reintentos.
  if (_svc === 'whatsapp-webhook')   return whatsappWebhookHandler(req, res);
  // Panel admin de conversaciones (Etapa 5) — auth de usuario vía Bearer,
  // ver whatsappConversacionAccionHandler.
  if (_svc === 'whatsapp-conversacion-accion') return whatsappConversacionAccionHandler(req, res);
  // Alta de WhatsApp Business propio de una empresa (Etapa 7) — auth de
  // usuario vía Bearer, ver whatsappEmbeddedSignupHandler.
  if (_svc === 'whatsapp-embedded-signup') return whatsappEmbeddedSignupHandler(req, res);

  const tipo = req.query?._svc || req.query?.tipo || req.body?.tipo;

  // ── Rate limiting diferenciado por tipo ───────────────────────────
  if (tipo === 'whatsapp') {
    if (await limiterWhatsApp(req, res)) return;
  } else if (tipo === 'push' || tipo === 'push-chofer' || tipo === 'push-interno') {
    if (await limiterPush(req, res)) return;
  } else {
    if (await limiterGeneral(req, res)) return;
  }

  switch (tipo) {
    case 'whatsapp':
      return whatsappHandler(req, res);

    case 'despacho':
    case 'entrega_confirmada':
    case 'entrega_no_realizada':
    case 'proximidad':
      if (!req.body) req.body = {};
      if (!req.body.evento) req.body.evento = tipo;
      return entregaHandler(req, res);

    case 'push-interno':
      return pushInternoHandler(req, res);

    case 'push':
      return pushHandler(req, res);

    case 'push-chofer':
      return pushChoferHandler(req, res);

    default:
      return res.status(400).json({
        error: `tipo desconocido: "${tipo}". Válidos: whatsapp, despacho, entrega_confirmada, entrega_no_realizada, proximidad, push-interno, push, push-chofer`,
      });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// ── WhatsApp ─────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

// v19.0 venció el 21/5/2026 (Meta sostiene cada versión ~2 años desde su lanzamiento).
// Se sube a v22.0 para alinear con la versión que usa el JS SDK del frontend
// (ver frontend/admin/js/whatsapp-onboarding.js, FB.init version: 'v22.0').
const META_API_VERSION = 'v22.0';
const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`;

// FIX SYNC-09 (Auditoría Integral 2026): estas constantes vivían más abajo,
// pegadas solo a enviarTextoWhatsApp() — la única llamada a Meta que
// reintentaba fallas transitorias (429/5xx). whatsappHandler() (envío de
// templates: pedido_despachado/entregado/por_llegar/no_entregado,
// cheques_por_vencer, deuda_vencida) hacía un solo intento — un 429/500 de
// Meta ahí se traducía directo en notificación perdida, sin ningún reintento,
// mientras el envío de texto libre sí reintentaba. Se comparten acá para que
// ambos caminos usen el mismo criterio de "qué es transitorio" y el mismo
// backoff — "uniforme" es justamente lo que pedía la recomendación.
const REINTENTOS_TRANSITORIO_META = 2;
const ESPERA_REINTENTO_META_MS = 600;
const esperarReintentoMeta = (ms) => new Promise((r) => setTimeout(r, ms));
const esFallaTransitoriaMeta = (status) => status === 429 || status >= 500;

const TEMPLATES = {
  confirmacion_pedido: {
    name: 'confirmacion_pedido', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: p.nombre_cliente },
      { type: 'text', text: String(p.numero_pedido) },
      { type: 'text', text: formatMonto(p.total) },
    ]}],
  },
  pedido_despachado: {
    name: 'pedido_despachado', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: String(p.numero_pedido) },
      { type: 'text', text: formatMonto(p.total) },
    ]}],
  },
  pedido_cancelado: {
    name: 'pedido_cancelado', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: String(p.numero_pedido) },
    ]}],
  },
  deuda_vencida: {
    name: 'deuda_vencida', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: p.nombre_cliente },
      { type: 'text', text: formatMonto(p.monto_vencido) },
    ]}],
  },
  pedido_entregado: {
    name: 'pedido_entregado', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: p.nombre_cliente },
      { type: 'text', text: String(p.numero_pedido) },
    ]}],
  },
  pedido_no_entregado: {
    name: 'pedido_no_entregado', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: p.nombre_cliente },
      { type: 'text', text: String(p.numero_pedido) },
      { type: 'text', text: p.motivo },
    ]}],
  },
  // Etapa 1 (Logística) — aviso automático "tu pedido está a ~X min",
  // disparado por rutas-live.js cuando el GPS del chofer entra en el radio
  // configurado. IMPORTANTE: a diferencia de los templates de arriba, este
  // todavía NO está dado de alta ni aprobado en Meta Business Manager — hay
  // que crearlo ahí con el mismo nombre/idioma/variables antes de que estos
  // envíos dejen de fallar con "template inexistente" (quedan logueados en
  // notif_log igual, sin cortar el resto del flujo de tracking).
  pedido_por_llegar: {
    name: 'pedido_por_llegar', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: p.nombre_cliente },
      { type: 'text', text: String(p.numero_pedido) },
      { type: 'text', text: String(p.eta_minutos) },
    ]}],
  },
  // Reset de contraseña por WhatsApp — portal cliente (v719/455). Igual que
  // pedido_por_llegar: falta darlo de alta y aprobarlo en Meta Business
  // Manager con este mismo nombre/idioma/variable antes de que el envío
  // deje de fallar con "template inexistente" (handleResetPasswordWhatsapp
  // en auth.js igual guarda el código y no revela el fallo al cliente).
  // Idealmente se registra en Meta como categoría AUTHENTICATION (no
  // UTILITY como el resto), que trae su propio botón de "copiar código" y
  // el disclaimer de seguridad estándar — no cambia nada de este lado, solo
  // cómo se lo da de alta del lado de Meta.
  codigo_recuperacion_password: {
    name: 'codigo_recuperacion_password', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: String(p.codigo) },
    ]}],
  },
  cheques_por_vencer: {
    name: 'cheques_por_vencer', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: String(p.cantidad) },
      { type: 'text', text: formatMonto(p.total) },
    ]}],
  },
  oferta_plan_pago: {
    name: 'oferta_plan_pago', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: p.nombre_cliente },
      { type: 'text', text: formatMonto(p.monto_deuda) },
    ]}],
  },
  // Template para notificar al chofer cuando se le asigna una ruta
  ruta_asignada: {
    name: 'ruta_asignada', language: 'es_AR',
    components: (p) => [{ type: 'body', parameters: [
      { type: 'text', text: p.nombre_chofer },
      { type: 'text', text: String(p.fecha) },
      { type: 'text', text: String(p.cant_pedidos) },
      { type: 'text', text: p.link_app },
    ]}],
  },
};

// ── Etapa 7: credenciales por empresa (Embedded Signup) ─────────────────
// Si la empresa conectó su propio número (fila en empresa_whatsapp), se usa
// ese phone_number_id/access_token. Si no, se cae a las variables de
// entorno globales (WA_PHONE_NUMBER_ID/WA_ACCESS_TOKEN) — así el número de
// prueba/sandbox de las Etapas 0-6 sigue funcionando para las empresas que
// todavía no pasaron por Embedded Signup.
const cacheCredenciales = new Map(); // empresa_id -> { cred, expira }
const CACHE_CREDENCIALES_TTL_MS = 60_000;

async function resolverCredencialesWhatsapp(empresaId) {
  const fallback = {
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID || null,
    accessToken:   process.env.WA_ACCESS_TOKEN || null,
    propia:        false,
    // Empresas que todavía usan el número compartido de prueba: se rigen
    // por el interruptor global de siempre (ver v291), no tienen fila
    // propia donde guardar un flag individual.
    enviosHabilitados: process.env.WA_NOTIF_SALIENTES_HABILITADAS === 'true',
  };
  if (!empresaId) return fallback;

  const cacheado = cacheCredenciales.get(empresaId);
  if (cacheado && cacheado.expira > Date.now()) return cacheado.cred;

  const { data, error } = await obtenerCredencialesWhatsapp(empresaId);

  const cred = (!error && data)
    ? {
        phoneNumberId: data.phone_number_id,
        accessToken: descifrar(data.access_token),
        propia: true,
        // v294: empresa con número propio → decide SU flag individual,
        // no el interruptor global (default false, fail-safe).
        enviosHabilitados: data.envios_habilitados === true,
      }
    : fallback;

  cacheCredenciales.set(empresaId, { cred, expira: Date.now() + CACHE_CREDENCIALES_TTL_MS });
  return cred;
}

async function whatsappHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { template, telefono, params, empresa_id } = req.body;
  const { phoneNumberId, accessToken, enviosHabilitados, propia } = await resolverCredencialesWhatsapp(empresa_id);

  if (!phoneNumberId || !accessToken) {
    return res.status(500).json({ error: 'WhatsApp no configurado en el servidor' });
  }
  if (!template || !telefono) return res.status(400).json({ error: 'Faltan campos: template y telefono son requeridos' });

  const templateDef = TEMPLATES[template];
  if (!templateDef) {
    return res.status(400).json({ error: `Template desconocido: "${template}". Válidos: ${Object.keys(TEMPLATES).join(', ')}` });
  }

  const telefonoLimpio = normalizarTelefono(telefono);
  if (!telefonoLimpio) return res.status(400).json({ error: 'Número de teléfono inválido' });

  // ── Corte de modo demo — Fase 3 del proceso demo/comercial ────────────
  // Ninguna empresa demo dispara un WhatsApp real a un número real.
  if (await esEmpresaDemo(empresa_id)) {
    const { message_id } = whatsappSimulado();
    return res.status(200).json({ ok: true, message_id, template, telefono: telefonoLimpio, demo: true });
  }

  // ── Corte de costos por empresa (v294, reemplaza el interruptor global de v291) ─
  // Bloquea acá TODOS los templates salientes iniciados por el sistema
  // (pedido_despachado, pedido_entregado, pedido_por_llegar,
  // pedido_no_entregado, cheques_por_vencer, deuda_vencida), ya que Meta
  // cobra por cada uno entregado (categoría "utility"). Es el único punto
  // por el que pasan los 6 templates, confirmado.
  //
  // `enviosHabilitados` ya viene resuelto por resolverCredencialesWhatsapp():
  //   - Empresa con número propio conectado → su columna individual
  //     `empresa_whatsapp.envios_habilitados` (default false, fail-safe).
  //   - Empresa todavía en el número compartido de prueba → sigue el
  //     interruptor global WA_NOTIF_SALIENTES_HABILITADAS de siempre.
  //
  // No afecta enviarTextoWhatsApp() (texto libre, gratis por ventana de
  // servicio de 24hs) ni las alertas internas del dashboard.
  if (!enviosHabilitados) {
    const { message_id } = whatsappSimulado();
    return res.status(200).json({ ok: true, bloqueado: true, message_id, template, telefono: telefonoLimpio });
  }

  const armarBody = (destinatario) => ({
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                destinatario,
    type:              'template',
    template: {
      name:       templateDef.name,
      language:   { code: templateDef.language },
      components: templateDef.components(params || {}),
    },
  });

  try {
    const intentar = (destinatario) => fetch(`${META_BASE_URL}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(armarBody(destinatario)),
    });

    let resp = await intentar(telefonoLimpio);
    let data = await resp.json();

    // Ver nota junto a alternarNueveAr(): el número de prueba de Meta en el
    // sandbox de Argentina puede tener la lista de destinatarios permitidos
    // en el formato con o sin "9" según cómo se haya verificado — no hay
    // forma de saberlo de antemano, así que ante un 131030 se reintenta una
    // sola vez con el formato contrario antes de darlo por fallido.
    if (!resp.ok && data?.error?.code === 131030) {
      const alterno = alternarNueveAr(telefonoLimpio);
      if (alterno) {
        resp = await intentar(alterno);
        data = await resp.json();
      }
    }

    // FIX SYNC-09: fallas transitorias (429/5xx) ahora reintentan con
    // backoff, mismo criterio que enviarTextoWhatsApp — antes esta llamada
    // (usada para los 6 templates de negocio: pedido_despachado/entregado/
    // por_llegar/no_entregado, cheques_por_vencer, deuda_vencida) hacía un
    // solo intento y un 429/500 pasajero de Meta se traducía directo en
    // notificación perdida.
    for (let intento = 1; !resp.ok && esFallaTransitoriaMeta(resp.status) && intento <= REINTENTOS_TRANSITORIO_META; intento++) {
      console.warn(`[whatsapp-template] Falla transitoria (status ${resp.status}) enviando template "${template}" a ${telefonoLimpio} — reintento ${intento}/${REINTENTOS_TRANSITORIO_META}`);
      await esperarReintentoMeta(ESPERA_REINTENTO_META_MS * intento);
      resp = await intentar(telefonoLimpio);
      data = await resp.json();
    }

    if (!resp.ok) {
      const errorMsg = data?.error?.message || 'Error desconocido de Meta API';
      // Código 190 (OAuthException) = token vencido/inválido — alertar a admins
      // para no descubrirlo recién mirando logs de Vercel días después.
      if (data?.error?.code === 190) {
        await alertarTokenWhatsAppVencido(data.error, empresa_id, propia).catch(() => {});
      }
      return res.status(502).json({ error: errorMsg, code: data?.error?.code });
    }
    // v295: self-healing — si esta empresa había quedado marcada como
    // "necesita reconexión" y el envío ahora funcionó, se limpia sola sin
    // esperar a que alguien la reconecte a mano (por si el corte fue
    // transitorio del lado de Meta).
    if (propia && empresa_id) {
      marcarEstadoTokenWhatsapp(empresa_id, false).catch(() => {});
    }
    return res.status(200).json({ ok: true, message_id: data.messages?.[0]?.id, template, telefono: telefonoLimpio });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo conectar con Meta API' });
  }
}

function normalizarTelefono(tel) {
  let limpio = String(tel).replace(/[\s\-\(\)]/g, '');
  if (limpio.startsWith('+')) limpio = limpio.slice(1);
  if (!limpio.startsWith('549') && limpio.length <= 10) limpio = '549' + limpio.replace(/^0/, '');
  if (!/^\d{10,15}$/.test(limpio)) return null;
  return limpio;
}

function formatMonto(n) {
  return Math.round(n || 0).toLocaleString('es-AR');
}

// ═════════════════════════════════════════════════════════════════════════
// ── WhatsApp bidireccional (Etapa 6) ────────────────────────────────────
// Ver supabase/migrations/246_etapa6_whatsapp_bidireccional.sql y
// lib/whatsapp-pedido-tools.js. Diseño y motivos de cada decisión están
// documentados en la cabecera de esa migración; acá solo el flujo.
// ═════════════════════════════════════════════════════════════════════════

const REGEX_CONFIRMA = /^\s*(si|sí|dale|confirmo|confirmar|ok|listo|de acuerdo)\s*[.!]*\s*$/i;
const REGEX_CANCELA  = /^\s*(no|cancelar|cancelo|espera|paren?|olvidalo)\s*[.!]*\s*$/i;
const MAX_TURNOS_SIN_CONFIRMAR = 20; // corte defensivo: evita loops largos de tokens de IA por conversación (subido de 8 a 20, 2026-08-04)

// Antes, una vez derivada la conversación, si el cliente seguía escribiendo
// esos mensajes se guardaban pero NUNCA más generaban ni un push ni una
// respuesta (auditoría 2026-08-03: dos consultas seguidas del cliente
// quedaron sin ninguna respuesta porque la conversación ya estaba
// 'derivada_humano' desde un mensaje anterior y nadie la había tomado desde
// el panel admin). Este umbral evita floodear con un push por cada mensaje
// si el cliente escribe varias líneas seguidas, pero re-avisa si pasó un
// rato considerable sin que nadie la tome.
const UMBRAL_REAVISO_DERIVADA_MIN = 10;

// ── Etapa 3: validación de firma de Meta ────────────────────────────────
// Meta firma cada POST del webhook con HMAC-SHA256 (clave = App Secret) y
// manda el resultado en el header `X-Hub-Signature-256` como
// "sha256=<hex>". Sin esto, cualquiera que adivine la URL puede simular
// ser un cliente tuyo por teléfono (hallazgo de la Etapa 0 del plan).
// Requiere `req.rawBody` (bytes exactos del body) — ver api/index.js,
// donde se desactiva el bodyParser automático para preservarlos.
export function firmaValidaDeMeta(req) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) {
    // Sin secreto configurado no hay nada contra qué validar. Se trata
    // como firma inválida (fail closed) en vez de dejar pasar todo.
    console.error('[whatsapp-webhook] WA_APP_SECRET no configurado — rechazando por seguridad');
    return false;
  }

  const firmaRecibida = req.headers['x-hub-signature-256'];
  if (!firmaRecibida || typeof firmaRecibida !== 'string' || !firmaRecibida.startsWith('sha256=')) {
    return false;
  }

  const rawBody = req.rawBody instanceof Buffer ? req.rawBody : Buffer.from('');
  const firmaEsperada = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Comparación en tiempo constante: evita filtrar por timing cuánto de
  // la firma coincide. Ambos buffers deben tener el mismo largo o
  // timingSafeEqual tira excepción — si difieren, ya es inválida.
  const bufRecibida  = Buffer.from(firmaRecibida);
  const bufEsperada   = Buffer.from(firmaEsperada);
  if (bufRecibida.length !== bufEsperada.length) return false;
  return crypto.timingSafeEqual(bufRecibida, bufEsperada);
}

async function whatsappWebhookHandler(req, res) {
  // ── Verificación del webhook (Meta hace un GET una vez al configurarlo) ──
  if (req.method === 'GET') {
    const modo      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (modo === 'subscribe' && token && token === process.env.WA_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      return;
    }
    return res.status(403).json({ error: 'Verificación fallida' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // Rate limit propio del webhook (Etapa 3) — antes de gastar cómputo
  // validando firma o tocando la base.
  if (await limiterWebhookWhatsApp(req, res)) return;

  // Validación de firma (Etapa 3) — rechaza con 401 cualquier POST que no
  // traiga la firma correcta, antes de tocar la base o parsear el mensaje.
  if (!firmaValidaDeMeta(req)) {
    console.error('[whatsapp-webhook] Firma inválida o ausente en X-Hub-Signature-256');
    return res.status(401).json({ error: 'Firma inválida' });
  }

  // Meta espera 200 rápido — si algo falla adentro, igual respondemos 200
  // (salvo error de parseo del body) para que Meta no reintente en loop
  // un mensaje que ya está registrado; el error queda en logs.
  try {
    // Coexistencia (migración 436): cuando el negocio rechazó compartir su
    // historial, Meta manda el aviso SIN el sobre entry/changes habitual
    // (ver "Payload syntax — chat history sharing declined" en la doc) —
    // se detecta antes de asumir la forma normal de abajo.
    if (!req.body?.entry && req.body?.history) {
      await procesarHistorialDeclinado(req.body);
      return res.status(200).json({ ok: true });
    }

    // Un solo POST puede traer varios entries y, dentro de cada uno, varios
    // changes (distintos `field`) — antes de Coexistencia esto asumía que
    // siempre había exactamente uno de tipo `messages`, lo cual seguía
    // siendo cierto para el número global/Embedded Signup normal, pero deja
    // de serlo con los webhooks nuevos que exige Coexistencia (`account_update`,
    // `smb_message_echoes`, `history`, `smb_app_state_sync` — ver "Setting up
    // your app" en la doc de Coexistencia).
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        await procesarCambioWebhookWhatsapp(entry, change);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[whatsapp-webhook] Error procesando mensaje entrante:', err);
    return res.status(200).json({ ok: false }); // 200 igual — ver comentario arriba
  }
}

// Dispatch por `field` de un único `change` dentro de `entry.changes[]`.
async function procesarCambioWebhookWhatsapp(entry, change) {
  const value = change?.value;
  const field = change?.field;

  switch (field) {
    case 'messages': {
      const mensaje = value?.messages?.[0];
      // Notificaciones de "status" (entregado/leído de mensajes salientes)
      // llegan con field='messages' pero sin `messages` — no hay nada que
      // procesar.
      if (!mensaje) return;

      // Etapa 7: metadata.phone_number_id identifica qué número de negocio
      // recibió el mensaje. Con Embedded Signup cada empresa tiene el
      // suyo, así que esto resuelve la empresa sin ambigüedad — antes
      // (Etapa 0-6, un solo número global) esto no existía y se dependía
      // solo del teléfono del cliente vía resolver_cliente_por_telefono
      // (ver resolverEmpresaCliente más abajo, que sigue siendo el fallback).
      const phoneNumberIdReceptor = value?.metadata?.phone_number_id || null;

      if (mensaje.type !== 'text') {
        // Fase 1 de la Etapa 6 solo entiende texto libre. Audio/imagen/ubicación
        // quedan derivados a un humano directamente.
        await procesarMensajeNoSoportado(mensaje, phoneNumberIdReceptor);
        return;
      }

      await procesarMensajeTexto({
        telefono:    mensaje.from,
        texto:       mensaje.text?.body || '',
        waMessageId: mensaje.id,
        phoneNumberIdReceptor,
      });
      return;
    }

    // ── Coexistencia (migración 436) ──────────────────────────────────
    case 'account_update':
      return procesarCambioEstadoCuentaWhatsapp(entry, value);

    case 'smb_message_echoes':
      // Mensajes que el dueño mandó a mano desde la app de WhatsApp
      // Business (o un dispositivo vinculado) — se reflejan en la
      // conversación de distrib para que el historial no quede a medias.
      return procesarEcoMensajesWhatsapp(value);

    case 'history':
      return procesarHistorialWhatsapp(value);

    case 'smb_app_state_sync':
      // Contactos del celular del dueño (alta/edición/baja). distrib ya
      // administra sus propios `clientes` por empresa — por ahora esto
      // solo se loguea para diagnóstico, sin escribir nada, para no pisar
      // el maestro de clientes con la agenda personal del dueño.
      console.log('[whatsapp-webhook] smb_app_state_sync recibido (contactos sincronizados, sin acción):', value?.state_sync?.length ?? 0, 'contacto(s)');
      return;

    default:
      // Campos que la app no pidió pero que Meta manda igual (ej. otros
      // productos de negocio compartiendo el mismo WABA) — se ignoran.
      return;
  }
}

// ── Coexistencia: cambios de estado de la cuenta (account_update) ────────
// PARTNER_REMOVED/ACCOUNT_OFFBOARDED = el dueño desconectó el número desde
// la app; ACCOUNT_RECONNECTED = volvió a conectar sin pasar por Embedded
// Signup de nuevo. Ver Webhooks > account_update en la doc de Coexistencia.
async function procesarCambioEstadoCuentaWhatsapp(entry, value) {
  const wabaId = entry?.id;
  const evento = value?.event;
  if (!wabaId || !evento) return;

  const empresaWa = await obtenerEmpresaPorWabaId(wabaId);
  if (!empresaWa) return; // WABA no es de ninguna empresa conectada por acá

  if (evento === 'PARTNER_REMOVED' || evento === 'ACCOUNT_OFFBOARDED') {
    await actualizarEstadoConexionWhatsapp(empresaWa.empresa_id, { desconectado: true });
    console.log(`[whatsapp-webhook] Empresa ${empresaWa.empresa_id} desconectó su WhatsApp (${evento})`);
  } else if (evento === 'ACCOUNT_RECONNECTED') {
    await actualizarEstadoConexionWhatsapp(empresaWa.empresa_id, { desconectado: false });
    console.log(`[whatsapp-webhook] Empresa ${empresaWa.empresa_id} reconectó su WhatsApp (${evento})`);
  }
  // Otros valores de `event` (ej. cambio de `phone_number` del WABA) no
  // tienen manejo específico todavía — no es un caso de Coexistencia.
}

// ── Coexistencia: eco de mensajes mandados a mano desde el celular ──────
async function procesarEcoMensajesWhatsapp(value) {
  const phoneNumberId = value?.metadata?.phone_number_id || null;
  if (!phoneNumberId) return;
  const empresaWa = await obtenerEmpresaPorPhoneNumberId(phoneNumberId);
  if (!empresaWa) return;

  for (const echo of (value?.message_echoes || [])) {
    const telefono = normalizarTelefono(echo.to);
    if (!telefono) continue;
    try {
      const cliente = await buscarClientePorTelefonoEnEmpresa(empresaWa.empresa_id, telefono);
      const conversacionId = await resolverConversacionWhatsapp({ telefono, empresaId: empresaWa.empresa_id, clienteId: cliente?.id || null });
      await registrarMensaje({
        conversacionId,
        direccion: 'out',
        waMessageId: echo.id,
        texto: echo.text?.body || null,
        tipo: echo.type || 'text',
      });
    } catch (err) {
      if (!err?.duplicado) console.error('[whatsapp-webhook] Error registrando eco de mensaje (Coexistencia):', err.message);
    }
  }
}

// ── Coexistencia: sincronización de historial de chats tras el alta ─────
// Alcance MVP: solo se ingieren mensajes de tipo texto dentro de threads
// 1-a-1 (mismo criterio que el resto del bot, que hoy solo entiende texto
// libre). Los `media_placeholder` y los mensajes de grupo se descartan —
// no hay dónde mostrarlos todavía en el panel de conversaciones.
async function procesarHistorialWhatsapp(value) {
  const phoneNumberId = value?.metadata?.phone_number_id || null;
  const businessPhone = value?.metadata?.display_phone_number || null;
  if (!phoneNumberId) return;
  const empresaWa = await obtenerEmpresaPorPhoneNumberId(phoneNumberId);
  if (!empresaWa) return;

  for (const bloque of (value?.history || [])) {
    // Bloque de error (ej. el negocio no compartió su historial) — no
    // trae `threads`, solo `errors`. Nada que ingerir.
    if (bloque?.errors?.length) {
      console.log('[whatsapp-webhook] Historial de Coexistencia no disponible para', empresaWa.empresa_id, ':', bloque.errors[0]?.title);
      continue;
    }
    for (const thread of (bloque?.threads || [])) {
      const telefono = normalizarTelefono(thread.id);
      if (!telefono) continue;
      const cliente = await buscarClientePorTelefonoEnEmpresa(empresaWa.empresa_id, telefono);
      const conversacionId = await resolverConversacionWhatsapp({ telefono, empresaId: empresaWa.empresa_id, clienteId: cliente?.id || null });

      for (const msg of (thread.messages || [])) {
        if (msg.type !== 'text') continue; // media_placeholder / otros tipos: fuera de alcance del MVP
        const direccion = normalizarTelefono(msg.from) === normalizarTelefono(businessPhone) ? 'out' : 'in';
        try {
          await registrarMensaje({
            conversacionId,
            direccion,
            waMessageId: msg.id,
            texto: msg.text?.body || null,
            tipo: 'text',
          });
        } catch (err) {
          if (!err?.duplicado) console.error('[whatsapp-webhook] Error ingiriendo mensaje de historial (Coexistencia):', err.message);
        }
      }
    }
  }
}

// Caso especial: historial declinado sin el sobre entry/changes habitual
// (ver comentario en whatsappWebhookHandler).
async function procesarHistorialDeclinado(body) {
  const phoneNumberId = body?.metadata?.phone_number_id || null;
  const empresaWa = phoneNumberId ? await obtenerEmpresaPorPhoneNumberId(phoneNumberId) : null;
  console.log('[whatsapp-webhook] El negocio declinó compartir su historial de WhatsApp Business app', empresaWa ? `(empresa ${empresaWa.empresa_id})` : '', body?.history?.[0]?.errors?.[0]?.title || '');
}

// `export` (antes interna) para poder testearla directamente — mismo
// criterio que crearPedidoDesdeItemsWhatsapp más abajo (plan 3.2).
export async function procesarMensajeNoSoportado(mensaje, phoneNumberIdReceptor) {
  const telefono = normalizarTelefono(mensaje.from);
  if (!telefono) return;
  const { empresaId, clienteId } = await resolverEmpresaCliente(telefono, phoneNumberIdReceptor);
  if (!empresaId) return;
  const conversacionId = await resolverConversacionWhatsapp({ telefono, empresaId, clienteId });
  await registrarMensaje({ conversacionId, direccion: 'in', waMessageId: mensaje.id, texto: null, tipo: mensaje.type });
  await marcarDerivada(conversacionId, `Mensaje tipo "${mensaje.type}" no soportado por el asistente automático`);
  // FIX (Etapa 5 offline, punto 3): antes llamaba a enviarTextoWhatsApp
  // directo acá — ni quedaba en el historial de la conversación ni
  // entraba al outbox si fallaba. responderYRegistrar hace ambas cosas,
  // mismo criterio que el resto de las respuestas del bot.
  await responderYRegistrar(conversacionId, telefono, empresaId, 'Recibimos tu mensaje. Un vendedor te va a responder a la brevedad');
}

// ── Matching teléfono → empresa/cliente ─────────────────────────────────
async function resolverEmpresaCliente(telefono, phoneNumberIdReceptor) {
  // FIX SYNC-02 (Auditoría Integral 2026): antes, el chequeo de
  // "conversación abierta por teléfono" corría PRIMERO y era global (sin
  // phone_number_id ni empresa_id) — así que si el mismo teléfono era
  // cliente de más de una empresa de la plataforma, un mensaje que llegaba
  // al número propio de la Empresa B podía terminar leyendo/escribiendo
  // la conversación abierta de la Empresa A. Ahora, cuando phone_number_id
  // ya identifica sin ambigüedad la empresa dueña del número receptor
  // (Etapa 7, Embedded Signup), esa empresa se resuelve PRIMERO y de forma
  // determinística, y la conversación abierta se busca acotada a ESA
  // empresa — nunca global.
  if (phoneNumberIdReceptor) {
    const empresaWa = await obtenerEmpresaPorPhoneNumberId(phoneNumberIdReceptor);
    if (empresaWa) {
      const abiertaEnEmpresa = await buscarConversacionAbiertaPorTelefonoYEmpresa(telefono, empresaWa.empresa_id);
      if (abiertaEnEmpresa) return { empresaId: abiertaEnEmpresa.empresa_id, clienteId: abiertaEnEmpresa.cliente_id };

      const cliente = await buscarClientePorTelefonoEnEmpresa(empresaWa.empresa_id, telefono);
      // Empresa resuelta igual aunque el teléfono no matchee ningún
      // cliente todavía — procesarMensajeTexto corta el flujo automático
      // si clienteId es null (mismo comportamiento que el camino de abajo).
      return { empresaId: empresaWa.empresa_id, clienteId: cliente?.id || null };
    }
    // phoneNumberIdReceptor no tiene fila en empresa_whatsapp: es el
    // número global de prueba (Etapas 0-6) — sigue por el matching de
    // abajo, sin filtrar por empresa.
  }

  // Sin número propio identificado: se mantiene el comportamiento previo
  // (conversación abierta global por teléfono, decisión #1 de la migración
  // 246) — limitación conocida y documentada del piloto con un único
  // número global compartido entre empresas.
  const abierta = await buscarConversacionAbiertaPorTelefono(telefono);
  if (abierta) return { empresaId: abierta.empresa_id, clienteId: abierta.cliente_id };

  const { data: matches, error } = await resolverClientePorTelefonoRpc(telefono);
  if (error) {
    console.error('[whatsapp-webhook] Error resolviendo teléfono:', error.message);
    return { empresaId: null, clienteId: null };
  }
  if (!matches?.length) return { empresaId: null, clienteId: null };

  // Caso ambiguo (mismo teléfono, cliente de más de una empresa de la
  // plataforma): se toma el primero. Es una limitación conocida del piloto
  // (un solo número de WA para todas las empresas) — ver decisión #1.
  const elegido = matches[0];
  return { empresaId: elegido.empresa_id, clienteId: elegido.cliente_id };
}

async function resolverConversacionWhatsapp({ telefono, empresaId, clienteId }) {
  // FIX SYNC-02: acotado por empresa, mismo motivo que en
  // resolverEmpresaCliente — evita reusar/escribir sobre la fila de
  // conversación de OTRA empresa cuando el teléfono es compartido entre
  // clientes de distintas empresas de la plataforma.
  const existente = await buscarConversacionAbiertaIdPorEmpresa(telefono, empresaId);
  if (existente) return existente.id;

  return crearConversacion({ telefono, empresa_id: empresaId, cliente_id: clienteId });
}

async function registrarMensaje({ conversacionId, direccion, waMessageId, texto, tipo, metadata }) {
  const { error } = await registrarMensajeWhatsapp({
    conversacion_id: conversacionId,
    direccion,
    wa_message_id: waMessageId,
    texto,
    tipo,
    metadata,
  });
  // Conflicto de wa_message_id = ya procesado (reintento de Meta). No es un
  // error real, pero sí debe cortar el flujo para no duplicar el pedido.
  if (error?.code === '23505') {
    const err = new Error('DUPLICADO');
    err.duplicado = true;
    throw err;
  }
  if (error) throw new Error(`No se pudo registrar el mensaje de WhatsApp: ${error.message}`);
}

async function marcarDerivada(conversacionId, motivo) {
  await marcarConversacionDerivada(conversacionId, motivo);

  // Aviso a los admins/vendedores de la empresa, mismo mecanismo que
  // alertarTokenWhatsAppVencido — para que alguien retome la charla.
  const conv = await obtenerConversacionEmpresaTelefono(conversacionId);
  if (!conv) return;
  const { data: admins } = await listarUsuariosPorRoles(conv.empresa_id, ['dueno', 'admin', 'vendedor']);
  for (const admin of (admins || [])) {
    enviarPush(admin.id, 'WhatsApp derivado', `${motivo} (${conv.telefono})`, { tipo: 'whatsapp_derivado', link: '/admin/whatsapp-conversaciones' }).catch(() => {});
  }
}

// FIX (2026-08-03): ver comentario de UMBRAL_REAVISO_DERIVADA_MIN. Se llama
// cuando llega un mensaje nuevo y la conversación YA estaba
// 'derivada_humano' de antes — antes acá no pasaba nada en absoluto.
async function manejarMensajeEnConversacionDerivada({ conversacionId, empresaId, telefono, ultimaInteraccionPrevia }) {
  const minutosInactivo = ultimaInteraccionPrevia
    ? (Date.now() - new Date(ultimaInteraccionPrevia).getTime()) / 60000
    : Infinity;

  await actualizarUltimaInteraccion(conversacionId);

  if (minutosInactivo < UMBRAL_REAVISO_DERIVADA_MIN) return; // ya se avisó hace poco, no floodear

  const conv = await obtenerConversacionEmpresaTelefono(conversacionId);
  if (!conv) return;
  const { data: admins } = await listarUsuariosPorRoles(conv.empresa_id, ['dueno', 'admin', 'vendedor']);
  for (const admin of (admins || [])) {
    enviarPush(admin.id, 'Cliente esperando respuesta', `Volvió a escribir mientras esperaba a un vendedor (${telefono})`, { tipo: 'whatsapp_derivado', link: '/admin/whatsapp-conversaciones' }).catch(() => {});
  }

  await responderYRegistrar(conversacionId, telefono, empresaId,
    'Ya le avisé a nuestro equipo que estás esperando, en breve te responden 🙂');
}

// ── Flujo principal por mensaje de texto ────────────────────────────────
// `export` (antes interna) para poder testearla directamente — mismo
// criterio que crearPedidoDesdeItemsWhatsapp más abajo (plan 3.2).
export async function procesarMensajeTexto({ telefono: telefonoCrudo, texto, waMessageId, phoneNumberIdReceptor }) {
  const telefono = normalizarTelefono(telefonoCrudo);
  if (!telefono) return;

  const { empresaId, clienteId } = await resolverEmpresaCliente(telefono, phoneNumberIdReceptor);
  if (!empresaId || !clienteId) {
    // Número que escribe pero no es cliente de ninguna empresa del piloto.
    // No se responde nada automático para no invitar a seguir escribiendo
    // (evita costo de conversación de Meta sin ningún cliente identificado).
    return;
  }

  const conversacionId = await resolverConversacionWhatsapp({ telefono, empresaId, clienteId });

  try {
    await registrarMensaje({ conversacionId, direccion: 'in', waMessageId, texto, tipo: 'text' });
  } catch (err) {
    if (err.duplicado) return; // ya procesado, no hacer nada más
    throw err;
  }

  const conv = await obtenerEstadoYBorrador(conversacionId);

  if (conv.estado === 'derivada_humano') {
    await manejarMensajeEnConversacionDerivada({
      conversacionId, empresaId, telefono, ultimaInteraccionPrevia: conv.ultima_interaccion,
    });
    return;
  }

  if (conv.estado === 'esperando_confirmacion') {
    if (REGEX_CONFIRMA.test(texto)) {
      await confirmarPedidoWhatsapp({ conversacionId, empresaId, clienteId, telefono, borrador: conv.pedido_borrador });
      return;
    }
    if (REGEX_CANCELA.test(texto)) {
      await reiniciarBorradorConversacion(conversacionId);
      await responderYRegistrar(conversacionId, telefono, empresaId,
        'Listo, cancelé ese pedido. Contame qué necesitás y armamos uno nuevo.');
      return;
    }
    // Mensaje ambiguo en medio de una confirmación pendiente: se vuelve a
    // 'activa' y sigue por el flujo normal del asistente (puede que el
    // cliente esté agregando algo más antes de confirmar).
    await marcarConversacionActiva(conversacionId);
    // marcarConversacionActiva ya reinició turno_desde en la base — se
    // refleja acá también porque `conv` se leyó antes de este reset y
    // contarMensajesEntrantes de abajo necesita el valor nuevo, no el viejo.
    conv.turno_desde = new Date().toISOString();
  }

  // Corte defensivo de costo/loop: si ya hubo demasiadas idas y vueltas sin
  // llegar a una confirmación, se deriva en vez de seguir gastando tokens.
  // FIX (2026-08-04): contarMensajesEntrantes ahora recibe turno_desde para
  // acotar el conteo a la ronda actual (ver comentario de la función en
  // lib/repos/whatsapp-bot.js) — antes contaba mensajes de toda la vida de
  // la conversación, incluidas rondas ya derivadas/cerradas.
  const turnos = await contarMensajesEntrantes(conversacionId, conv.turno_desde);
  if (turnos > MAX_TURNOS_SIN_CONFIRMAR) {
    await marcarDerivada(conversacionId, 'Muchos mensajes sin llegar a confirmar un pedido');
    // FIX (2026-08-03): antes usaba enviarTextoWhatsApp directo, que manda
    // el mensaje pero nunca lo registra en whatsapp_mensajes — quedaba un
    // "agujero" en el historial (el mensaje podía haberle llegado al
    // cliente pero no se veía en la base). responderYRegistrar hace ambas
    // cosas, igual que el resto de las respuestas del bot.
    await responderYRegistrar(conversacionId, telefono, empresaId,
      'Te paso con un vendedor para terminar de armar tu pedido');
    return;
  }

  await procesarConAsistente({ conversacionId, empresaId, clienteId, telefono, texto });
}

async function procesarConAsistente({ conversacionId, empresaId, clienteId, telefono, texto }) {
  const historialRaw = await obtenerHistorialMensajes(conversacionId, { limite: 10 });
  const historial = historialRaw.reverse()
    .slice(0, -1) // el mensaje actual ya se manda aparte como `mensaje`
    .map((m) => ({ rol: m.direccion === 'in' ? 'user' : 'model', contenido: m.texto }));

  // FIX (2026-08-03): antes se armaba un único `systemPrompt` y un único
  // `tools.esquema`, pero responderConFallback espera systemPromptConTools/
  // systemPromptSinTools y tools.esquemaGemini/tools.esquemaOpenAI (mismo
  // contrato que ya usa handlers/asistente.js). Con los nombres viejos, la
  // desestructuración de responderConFallback dejaba systemPrompt y las
  // tools en `undefined` para los tres proveedores — el modelo respondía
  // sin catálogo, sin precios y sin poder tocar el borrador, aunque el
  // código "aparentaba" estar armando todo bien. Ver conversación con
  // Nadal 2026-08-03 (auditoría del flujo real en Supabase) para el
  // diagnóstico completo.
  const systemPromptConTools =
    'Sos el asistente de pedidos por WhatsApp de un distribuidor mayorista. Hablás en español ' +
    'rioplatense, tono cordial y breve (es un chat, no un email). Tu único objetivo es ayudar al ' +
    'cliente a armar un pedido usando las herramientas disponibles: buscar productos del catálogo ' +
    'real (nunca inventes productos, precios ni stock), agregarlos al borrador con la cantidad que ' +
    'pida, y cuando el cliente diga que ya está, usar proponer_confirmacion para cerrar el armado. ' +
    'proponer_confirmacion te devuelve el subtotal, el IVA y el total ya calculados por el servidor: ' +
    'nunca sumes vos mismo los precios ni inventes un total aproximado, repetí tal cual esos tres ' +
    'números en tu resumen. Después de proponer_confirmacion, tu respuesta en texto debe resumir el ' +
    'pedido (ítems, cantidades, y el total exacto que te devolvió la tool) y pedir explícitamente que ' +
    'conteste "SÍ" para confirmarlo. Nunca le pidas al cliente datos que estas herramientas no usan ' +
    '(dirección de entrega, método de pago, etc.) — eso se gestiona por otro canal después de ' +
    'confirmado el pedido. Si el cliente pide algo que no es un pedido simple (precio especial, ' +
    'reclamo, hablar con alguien, algo que no podés resolver con las tools), usá derivar_humano y ' +
    'avisale en el texto que ya lo estás comunicando con un vendedor.';

  // Red de seguridad: hoy los 3 proveedores (gemini/groq/openrouter) están
  // en PROVEEDORES_CON_TOOLS, así que en la práctica siempre se usa la
  // variante de arriba — esta queda por si algún proveedor se sacara de
  // ese set (ver mismo criterio en armarSystemPrompt(), handlers/asistente.js).
  const systemPromptSinTools =
    'Sos el asistente de pedidos por WhatsApp de un distribuidor mayorista. En este momento NO tenés ' +
    'acceso al catálogo real ni a las herramientas para armar un pedido. No inventes productos, ' +
    'precios, stock ni un total. Avisale al cliente con honestidad que en este momento no podés ' +
    'procesar el pedido automáticamente y que ya se lo estás pasando a un vendedor.';

  const tools = {
    esquemaGemini: esquemaPedidoWhatsAppGemini(),
    esquemaOpenAI: esquemaPedidoWhatsAppOpenAI(),
    ejecutar: (nombre, args) => ejecutarToolPedidoWhatsApp(nombre, { empresaId, clienteId, conversacionId, args }),
  };

  let texto_respuesta;
  try {
    const resultado = await responderConFallback({ systemPromptConTools, systemPromptSinTools, historial, mensaje: texto, tools });
    texto_respuesta = resultado.texto;
  } catch (err) {
    console.error('[whatsapp-webhook] Asistente no disponible:', err.message);
    await marcarDerivada(conversacionId, 'El asistente automático no pudo responder (proveedores de IA caídos)');
    texto_respuesta = 'Estoy teniendo problemas para responderte automáticamente. Ya avisé a un vendedor para que te escriba.';
  }

  await responderYRegistrar(conversacionId, telefono, empresaId, texto_respuesta);
}

// Etapa 5 offline, punto 3: único choke point de salientes del bot — si
// enviarTextoWhatsApp no pudo (ya agotó sus propios reintentos transitorios
// arriba), el mensaje NO se pierde: se graba igual con
// metadata.estado_envio='pendiente' para que lo levante el cron
// (_svc=whatsapp-salientes-reprocesar-cron, más abajo). Antes esto se
// registraba igual pero sin ninguna marca de que había fallado — quedaba
// en el historial como si se hubiera mandado.
async function responderYRegistrar(conversacionId, telefono, empresaId, texto) {
  const envio = await enviarTextoWhatsApp(telefono, texto, empresaId);
  const metadata = envio
    ? { estado_envio: 'enviado' }
    : { estado_envio: 'pendiente', intentos: 0 };
  await registrarMensaje({ conversacionId, direccion: 'out', waMessageId: envio?.message_id, texto, tipo: 'text', metadata });
}

// ── Confirmación final: acá y SOLO acá se crea el pedido en firme ───────
async function confirmarPedidoWhatsapp({ conversacionId, empresaId, clienteId, telefono, borrador }) {
  const items = borrador?.items || [];
  if (!items.length) {
    await responderYRegistrar(conversacionId, telefono, empresaId, 'No tengo ítems cargados todavía, contame qué necesitás.');
    await marcarConversacionActiva(conversacionId);
    return;
  }

  const resultado = await crearPedidoDesdeItemsWhatsapp({ empresaId, clienteId, items });

  if (!resultado.ok) {
    await responderYRegistrar(conversacionId, telefono, empresaId,
      `No pude confirmar el pedido: ${resultado.error}. Si querés, decime qué sacamos y lo intentamos de nuevo.`);
    await marcarConversacionActiva(conversacionId);
    return;
  }

  await cerrarConversacionConPedido(conversacionId, resultado.pedidoId);

  await responderYRegistrar(conversacionId, telefono, empresaId,
    `¡Pedido confirmado! Número ${resultado.numeroPedido || resultado.pedidoId.slice(0, 8)}. ` +
    `Total: $${formatMonto(resultado.total)}. Te avisamos cuando esté en camino.`);
}

// Réplica acotada del flujo de confirmarPedidoHandler/crear_pedido_cliente
// (lib/handlers/pedidos.js) para el canal WhatsApp: mismo motor de precios
// y stock, canal='whatsapp', sin vendedor asignado (p_vendedor_id null).
// `export` (antes interna) para poder testearla directamente — plan 3.2.
export async function crearPedidoDesdeItemsWhatsapp({ empresaId, clienteId, items }) {
  const { data: clienteRow, error: cliError } = await obtenerClienteParaPedidoWhatsapp(clienteId, empresaId);
  if (cliError || !clienteRow) return { ok: false, error: 'cliente no encontrado' };
  if (!clienteRow.activo) return { ok: false, error: 'cliente inactivo' };

  // v(combos): el asistente de WhatsApp todavía no ofrece combos en su
  // NLU/tools (whatsapp-pedido-tools.js no los conoce), así que en la
  // práctica `items` de hoy siempre trae puro producto_id — pero el
  // borrador ya viaja por el mismo motor de precios/stock que el portal
  // y el admin (ver comentario arriba de la función), así que se lo deja
  // preparado para aceptar combo_id sin romper nada si en el futuro se
  // suma esa opción al bot. Mismo criterio que confirmarPedidoHandler /
  // crearPedidoParaCliente: cada renglón es DE UN PRODUCTO o DE UN COMBO.
  for (const item of items) {
    const esCombo = !!item.combo_id;
    if (esCombo === !!item.producto_id) {
      return { ok: false, error: 'ítem inválido en el pedido' };
    }
  }

  const productoIdsDirectos = items.filter((i) => i.producto_id).map((i) => i.producto_id);
  const comboIds            = [...new Set(items.filter((i) => i.combo_id).map((i) => i.combo_id))];

  const combosData = comboIds.length ? await obtenerCombosParaValidarPedido(empresaId, comboIds) : [];
  const comboMap = new Map(combosData.map((c) => [c.id, c]));

  for (const comboId of comboIds) {
    const combo = comboMap.get(comboId);
    if (!combo || !combo.activo) return { ok: false, error: 'combo no disponible' };
  }

  // Stock: directo + lo que consume cada combo, acumulado por producto
  // antes de comparar (mismo criterio que confirmarPedidoHandler).
  const necesidadPorProducto = new Map();
  for (const item of items) {
    if (item.producto_id) {
      necesidadPorProducto.set(item.producto_id, (necesidadPorProducto.get(item.producto_id) || 0) + item.cantidad);
    } else {
      const combo = comboMap.get(item.combo_id);
      for (const ci of combo.items) {
        necesidadPorProducto.set(ci.producto_id, (necesidadPorProducto.get(ci.producto_id) || 0) + ci.cantidad * item.cantidad);
      }
    }
  }
  const productoIdsParaStock = [...necesidadPorProducto.keys()];

  const stockData = await obtenerStockParaPedidoWhatsapp(productoIdsParaStock);
  const stockMap = {};
  for (const s of stockData) {
    if (s.depositos?.es_principal || !stockMap[s.producto_id]) {
      stockMap[s.producto_id] = Math.max(0, (s.cantidad || 0) - (s.cantidad_reservada || 0));
    }
  }
  for (const [productoId, necesaria] of necesidadPorProducto) {
    if (necesaria > (stockMap[productoId] ?? 0)) {
      const nombre = items.find((i) => i.producto_id === productoId)?.nombre || productoId;
      return { ok: false, error: `stock insuficiente para "${nombre}"` };
    }
  }

  const { data: preciosResueltos, error: errPrecios } = productoIdsDirectos.length
    ? await resolverPreciosClienteRpc({
        cliente_id: clienteId, producto_ids: productoIdsDirectos, empresa_id: empresaId,
      })
    : { data: [], error: null };
  if (errPrecios) return { ok: false, error: 'no se pudieron resolver los precios' };
  const precioMap = Object.fromEntries((preciosResueltos || []).map((p) => [p.producto_id, p.precio]));

  const prodsData = productoIdsDirectos.length
    ? await obtenerProductosParaCotizarPedido(empresaId, productoIdsDirectos)
    : [];
  if (!prodsData || prodsData.length !== productoIdsDirectos.length) {
    return { ok: false, error: 'uno o más productos no pertenecen a esta empresa' };
  }

  // Precio/IVA por renglón — combo: precio propio de la tabla `combos` +
  // IVA ponderado de su composición (nunca lo que traiga el borrador).
  for (const item of items) {
    if (item.producto_id) {
      item._precio_servidor = precioMap[item.producto_id] ?? prodsData.find((p) => p.id === item.producto_id)?.precio_base ?? 0;
      item._iva_servidor    = prodsData.find((p) => p.id === item.producto_id)?.iva ?? 21;
    } else {
      const combo = comboMap.get(item.combo_id);
      item._precio_servidor = combo.precio;
      item._iva_servidor    = calcularIvaPonderadoCombo(combo.items);
    }
  }

  // Sin descuento_pct: el borrador de WhatsApp no soporta descuentos por
  // ítem (a diferencia del portal/admin), así que siempre da 0 — mismo
  // resultado que antes de unificar con calcularTotalesPedido.
  const { subtotal, iva_total, total, itemsParaRpc } = calcularTotalesPedido(items, {
    resolverPrecio: (item) => item._precio_servidor,
    resolverIva:    (item) => item._iva_servidor,
  });

  if (clienteRow.limite_credito > 0 && (clienteRow.saldo_deuda || 0) + total > clienteRow.limite_credito) {
    return { ok: false, error: 'supera el límite de crédito del cliente' };
  }

  const { data: rpcResult, error: rpcError } = await crearPedidoClienteRpc({
    p_empresa_id: empresaId,
    p_cliente_id: clienteId,
    p_vendedor_id: null,
    p_items: itemsParaRpc,
    p_subtotal: Math.round(subtotal * 100) / 100,
    p_iva_total: Math.round(iva_total * 100) / 100,
    p_total: total,
    p_notas_cliente: 'Pedido generado por WhatsApp (asistente automático)',
    p_fecha_entrega: null,
    p_canal: 'whatsapp',
  });
  if (rpcError) return { ok: false, error: 'error interno creando el pedido' };
  if (!rpcResult?.ok) return { ok: false, error: rpcResult?.error || 'stock insuficiente' };

  const pedidoRow = await obtenerNumeroPedido(rpcResult.pedido_id);
  return { ok: true, pedidoId: rpcResult.pedido_id, numeroPedido: pedidoRow?.numero_pedido, total };
}

// ── Bug conocido de Meta con números argentinos en el sandbox de prueba
//    (Etapa 6 — hallazgo post-deploy, testing real 2026-07-10/11) ────────
// El mensaje entrante trae el teléfono CON el "9" que WhatsApp agrega a
// los celulares argentinos (ej. 5493482313453), y así es como queda
// guardado en whatsapp_conversaciones.telefono (correcto, no se toca).
// Pero la lista de destinatarios permitidos del NÚMERO DE PRUEBA (modo
// Desarrollo) internamente guarda ese mismo número SIN el "9"
// (5493482313453 → 543482313453), aunque en la UI se haya escrito y
// verificado con "9". Resultado: enviarTextoWhatsApp fallaba con
// (#131030) Recipient phone number not in allowed list en todo intento
// de respuesta real, aun con el número bien cargado en Meta.
// Este ajuste solo afecta el valor `to` de ESTA llamada puntual de envío
// — nunca toca lo que se guarda en la base ni el matching de cliente.
// Documentado como bug de larga data de Meta para AR/BR/MX en modo
// Desarrollo; una vez migrado al número real verificado en producción
// (Etapa 7 del plan), Meta acepta ambos formatos y este ajuste queda
// siendo inofensivo en ese escenario (nunca se dispara el reintento).
//
// ACTUALIZACIÓN 2026-07-11: el intento inicial de "sacar siempre el 9"
// no alcanzó — al volver a verificar el número de prueba en Meta
// escribiéndolo explícitamente CON el "9", la lista de destinatarios
// permitidos quedó guardada con el formato contrario al de la primera
// vez. Conclusión: no hay forma confiable de saber de antemano qué
// formato tiene Meta internamente (puede cambiar según cómo se haya
// verificado), así que en vez de adivinar, se prueba un formato y, si
// Meta responde puntualmente con el error 131030, se reintenta una sola
// vez con el otro. Fuera del sandbox de prueba (número real en
// producción) este error no existe, así que el reintento nunca se activa.
function alternarNueveAr(telefono) {
  if (/^549\d{10}$/.test(telefono)) return '54' + telefono.slice(3);
  if (/^54\d{10}$/.test(telefono))  return '549' + telefono.slice(2);
  return null; // no es un patrón de celular argentino conocido — no hay alterno
}

// ── Envío de texto libre (distinto de whatsappHandler, que solo manda
//    templates aprobados). Meta solo permite texto libre dentro de la
//    ventana de servicio de 24h desde el último mensaje del cliente —
//    que es justo el caso acá, porque siempre respondemos a algo que el
//    cliente escribió recién. ──
//
// Etapa 5 offline (plan PLAN_OFFLINE_COMPLETO.md, punto 3): además del
// reintento puntual por 131030 (bug del "9" AR, ver más arriba), se suma
// un reintento genérico y corto (2 intentos extra, backoff fijo chico)
// para fallas transitorias reales: caída de red hacia Meta, 5xx del lado
// de Meta, o 429 (rate limit de Meta — no confundir con el 429 propio de
// nuestro rate-limiter, que es otra capa). Esto resuelve el caso común
// ("Meta tuvo un hipo de un par de segundos"); lo que sigue fallando
// después de esto ya no es hipo — responderYRegistrar lo deja en el
// outbox (whatsapp_mensajes.metadata) para que lo reintente el cron
// diario en vez de perderlo.
// FIX SYNC-09: las constantes de reintento/backoff se comparten con
// whatsappHandler (ver REINTENTOS_TRANSITORIO_META arriba) — antes había
// una copia local acá y whatsappHandler no tenía ninguna.

async function enviarTextoWhatsApp(telefono, texto, empresaId) {
  if (await esEmpresaDemo(empresaId)) return whatsappSimulado();

  const { phoneNumberId, accessToken, propia } = await resolverCredencialesWhatsapp(empresaId);
  if (!phoneNumberId || !accessToken) {
    console.error('[whatsapp-webhook] Sin credenciales de WhatsApp (ni propias de la empresa ni WA_PHONE_NUMBER_ID/WA_ACCESS_TOKEN globales)');
    return null;
  }

  const intentarEnvio = async (destinatario) => {
    const resp = await fetch(`${META_BASE_URL}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: destinatario,
        type: 'text',
        text: { body: texto, preview_url: false },
      }),
    });
    const data = await resp.json();
    return { ok: resp.ok, status: resp.status, data };
  };

  try {
    let { ok, status, data } = await intentarEnvio(telefono);

    if (!ok && data?.error?.code === 131030) {
      const alterno = alternarNueveAr(telefono);
      if (alterno) {
        console.warn(`[whatsapp-webhook] 131030 con ${telefono} — reintentando con formato alterno ${alterno}`);
        ({ ok, status, data } = await intentarEnvio(alterno));
      }
    }

    for (let intento = 1; !ok && esFallaTransitoriaMeta(status) && intento <= REINTENTOS_TRANSITORIO_META; intento++) {
      console.warn(`[whatsapp-webhook] Falla transitoria (status ${status}) enviando a ${telefono} — reintento ${intento}/${REINTENTOS_TRANSITORIO_META}`);
      await esperarReintentoMeta(ESPERA_REINTENTO_META_MS * intento);
      ({ ok, status, data } = await intentarEnvio(telefono));
    }

    if (!ok) {
      if (data?.error?.code === 190) await alertarTokenWhatsAppVencido(data.error, empresaId, propia).catch(() => {});
      console.error('[whatsapp-webhook] Error enviando texto:', data?.error?.message);
      return null;
    }
    if (propia && empresaId) {
      marcarEstadoTokenWhatsapp(empresaId, false).catch(() => {});
    }
    return { message_id: data.messages?.[0]?.id };
  } catch (err) {
    console.error('[whatsapp-webhook] No se pudo conectar con Meta API:', err.message);
    return null;
  }
}

// ── Etapa 5: panel admin de conversaciones ──────────────────────────────
// El listado (v_whatsapp_conversaciones_activas) y el historial de
// mensajes se leen directo desde el frontend con el cliente de Supabase
// del usuario logueado — RLS (migración 247) ya scopea todo por
// empresa_id, mismo criterio que notif-log.js con notif_log. Acá solo va
// la ÚNICA acción de escritura que necesita el panel: tomar/liberar una
// conversación derivada a un humano. No usa las tablas RLS-only del
// cliente porque no hay policy de UPDATE para whatsapp_conversaciones a
// propósito (ver comentario en la migración 271) — la escritura pasa
// siempre por acá, con `supabase` (service_role) y validando a mano que
// la conversación pertenezca a la empresa del usuario autenticado.
async function whatsappConversacionAccionHandler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const perfil = await verificarToken(req, supabase);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });
  if (!puede(perfil, 'gestionar', 'whatsapp_panel')) {
    return res.status(403).json({ error: 'Rol insuficiente para gestionar conversaciones de WhatsApp' });
  }

  const { conversacion_id, accion } = req.body || {};
  if (!conversacion_id) return res.status(400).json({ error: 'conversacion_id requerido' });
  if (!['tomar', 'liberar'].includes(accion)) {
    return res.status(400).json({ error: 'accion inválida. Válidas: tomar, liberar' });
  }

  // Ownership explícito por empresa_id — nunca confiar en lo que manda el
  // cliente sin validar contra la empresa del usuario autenticado (mismo
  // criterio que handleEstadoCuenta más abajo en este archivo).
  const { data: conv, error: convErr } = await obtenerConversacionParaAccion(conversacion_id);
  if (convErr || !conv) return res.status(404).json({ error: 'Conversación no encontrada' });
  if (conv.empresa_id !== perfil.empresa_id) {
    return res.status(403).json({ error: 'Esa conversación no pertenece a tu empresa' });
  }

  if (accion === 'tomar') {
    if (conv.tomada_por && conv.tomada_por !== perfil.id) {
      return res.status(409).json({ error: 'Otro usuario ya tomó esta conversación' });
    }
    const { error } = await tomarConversacion(conversacion_id, perfil.id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo tomar la conversación.');
    return res.status(200).json({ ok: true });
  }

  // accion === 'liberar'
  if (conv.tomada_por && conv.tomada_por !== perfil.id && perfil.rol === 'vendedor') {
    // Un vendedor no libera lo que tomó otro vendedor — sí puede dueño/admin.
    return res.status(409).json({ error: 'Esta conversación la tomó otro usuario' });
  }
  const { error } = await liberarConversacion(conversacion_id);
  if (error) return errorSeguro(res, error, 500, 'No se pudo liberar la conversación.');
  return res.status(200).json({ ok: true });
}


// ── Etapa 7: alta de WhatsApp Business propio de una empresa ────────────
// Recibe lo que devuelve el JS SDK de Meta al terminar el flujo de
// Embedded Signup en el frontend (ver frontend/admin/js/whatsapp-onboarding.js)
// y hace en el backend, server-to-server, los pasos de Coexistencia (único
// flujo soportado, ver FIX 2026-08-04 más abajo):
//   1. Intercambiar el `code` de un solo uso por un token de acceso.
//   2. Suscribir esta app a los webhooks del WABA de la empresa (el número
//      ya viene registrado en Cloud API por el propio Embedded Signup, no
//      hace falta un /register aparte).
// Solo si los pasos salen bien se guarda la fila en empresa_whatsapp — si
// algo falla a mitad de camino, no queda un estado a medias que el webhook
// entrante podría llegar a usar.

// `export` (antes interna) para poder testearla directamente — mismo
// criterio que crearPedidoDesdeItemsWhatsapp/procesarMensajeTexto (plan 3.2).
export async function whatsappEmbeddedSignupHandler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const perfil = await verificarToken(req, supabase);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });
  if (!puede(perfil, 'conectar', 'whatsapp_onboarding')) {
    return res.status(403).json({ error: 'Solo el dueño o un admin puede conectar el WhatsApp de la empresa' });
  }
  if (!perfil.empresa_id) return res.status(400).json({ error: 'Tu usuario no tiene una empresa asociada' });

  const { code, waba_id } = req.body || {};
  let phone_number_id = null;
  // FIX (2026-08-04): se sacó por completo la opción "Crear un WhatsApp
  // Business nuevo" (ver whatsapp-onboarding.js) — Meta solo la permite con
  // un número sin ninguna cuenta de WhatsApp activa, algo que en la
  // práctica nunca aplicaba a un número personal ya en uso y trababa a la
  // mayoría de los dueños en el primer intento. Coexistencia es ahora el
  // único flujo: el postMessage de Meta (evento
  // FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING) solo trae `waba_id` — el
  // phone_number_id siempre se resuelve server-to-server más abajo
  // listando los números del WABA (Paso 1ter).

  if (!code || !waba_id) {
    return res.status(400).json({ error: 'Faltan campos: code y waba_id son requeridos' });
  }

  const appId     = process.env.WA_APP_ID;
  const appSecret = process.env.WA_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('[whatsapp-embedded-signup] WA_APP_ID/WA_APP_SECRET no configurados');
    return res.status(500).json({ error: 'Embedded Signup no está configurado en el servidor' });
  }

  try {
    // ── Paso 1: intercambiar el code por un token de acceso ──────────────
    const tokenUrl = new URL(`${META_BASE_URL}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', appId);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('code', code);
    const tokenResp = await fetch(tokenUrl.toString());
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('[whatsapp-embedded-signup] Error intercambiando code:', tokenData?.error);
      return res.status(502).json({ error: 'No se pudo validar la conexión con Meta. Probá de nuevo el botón "Conectar mi WhatsApp".' });
    }
    let accessToken = tokenData.access_token;

    // ── Paso 1bis: canjear por un token de LARGA DURACIÓN (~60 días) ─────
    // El token que devuelve el paso anterior es de corta vida (del orden
    // de 1-2hs). Sin este canje, la conexión de la empresa se corta sola
    // en cuestión de horas y sin ningún aviso — Meta no manda webhook de
    // "token vencido", el próximo envío simplemente empieza a fallar
    // (error 190) y nadie se entera hasta que un cliente reclama que no
    // le llegó un mensaje. No cortamos el alta si este paso falla (mejor
    // guardar un token corto que ninguno), pero lo dejamos bien visible
    // en los logs porque implica que esa empresa se va a desconectar
    // sola pronto.
    try {
      const longLivedUrl = new URL(`${META_BASE_URL}/oauth/access_token`);
      longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
      longLivedUrl.searchParams.set('client_id', appId);
      longLivedUrl.searchParams.set('client_secret', appSecret);
      longLivedUrl.searchParams.set('fb_exchange_token', accessToken);
      const longLivedResp = await fetch(longLivedUrl.toString());
      const longLivedData = await longLivedResp.json();
      if (longLivedResp.ok && longLivedData.access_token) {
        accessToken = longLivedData.access_token;
      } else {
        console.error('[whatsapp-embedded-signup] No se pudo canjear por token de larga duración, se guarda el de corta vida (~1-2hs):', longLivedData?.error);
      }
    } catch (err) {
      console.error('[whatsapp-embedded-signup] Error canjeando token de larga duración:', err.message);
    }

    // ── Paso 1ter: resolver phone_number_id ──────────────────────────────
    // El postMessage FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING de Meta solo
    // trae `waba_id` (ver docs "Onboard WhatsApp Business app users") — no
    // llega phone_number_id por el frontend. Se lista el/los número(s) del
    // WABA server-to-server.
    if (!phone_number_id) {
      const numerosResp = await fetch(`${META_BASE_URL}/${waba_id}/phone_numbers`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      const numerosData = await numerosResp.json();
      const numeros = numerosData?.data || [];
      if (!numerosResp.ok || numeros.length === 0) {
        console.error('[whatsapp-embedded-signup] No se pudo resolver el número del WABA en Coexistencia:', numerosData?.error);
        return res.status(502).json({ error: 'No se pudo identificar el número conectado. Probá de nuevo el botón "Conectar mi WhatsApp existente".' });
      }
      if (numeros.length > 1) {
        // No debería pasar en el flujo de Coexistencia (1 número por WABA
        // de un dueño de WhatsApp Business app), pero si pasa se deja
        // constancia en logs en vez de adivinar cuál es.
        console.error('[whatsapp-embedded-signup] El WABA de Coexistencia tiene más de un número, se usa el primero:', numeros.map((n) => n.id));
      }
      phone_number_id = numeros[0].id;
    }

    // ── Paso 2: registrar el número ───────────────────────────────────────
    // En Coexistencia el número YA está registrado en Cloud API por el
    // propio flujo de Embedded Signup — llamar a /register lo rechaza
    // Meta. Ver "Onboarding business customers" en la doc de Coexistencia:
    // "skip the phone number registration step, as the number is already
    // registered." Como Coexistencia es el único flujo soportado (ver FIX
    // más arriba), este paso ya no aplica nunca — se deja `pin` en null
    // para el registro en base (ver `guardarCredencialesWhatsapp`).
    const pin = null;

    // ── Paso 3: suscribir esta app a los webhooks del WABA de la empresa ──
    const subscribeResp = await fetch(`${META_BASE_URL}/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const subscribeData = await subscribeResp.json();
    if (!subscribeResp.ok || !subscribeData.success) {
      console.error('[whatsapp-embedded-signup] Error suscribiendo webhooks:', subscribeData?.error);
      return res.status(502).json({ error: 'El número se registró pero no se pudo suscribir a los webhooks. Contactá soporte antes de usarlo.' });
    }

    // Nombre verificado del número, solo para mostrarle algo lindo al
    // usuario en la confirmación — si falla no corta el alta.
    let verifiedName = null;
    try {
      const infoResp = await fetch(`${META_BASE_URL}/${phone_number_id}?fields=verified_name`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      const infoData = await infoResp.json();
      verifiedName = infoData?.verified_name || null;
    } catch { /* no crítico */ }

    // ── Guardar credenciales (upsert: permite reconectar si algo cambió) ──
    const { error: dbError } = await guardarCredencialesWhatsapp({
      empresa_id:      perfil.empresa_id,
      waba_id,
      phone_number_id,
      verified_name:   verifiedName,
      access_token:    cifrar(accessToken),
      register_pin:    pin,
      necesita_reconexion: false,
      es_coexistencia: true,
      desconectado_en: null,
      conectado_por:   perfil.id,
      actualizado_en:  new Date().toISOString(),
    });

    if (dbError) return errorSeguro(res, dbError, 500, 'El número se conectó en Meta pero no se pudo guardar en el sistema. Contactá soporte.');

    // ── Paso 4: disparar la sincronización de contactos/historial ────────
    // Hay 24hs desde el alta para pedir la sync de contactos + historial de
    // chats o hay que offboardear y repetir todo el flujo (ver "Synchronizing
    // WhatsApp Business app data" en la doc) — se dispara ya mismo, sin
    // bloquear la respuesta al usuario. No es fatal si falla: el dueño ya
    // quedó conectado igual, solo no le va a llegar el historial viejo.
    iniciarSincronizacionCoexistencia(phone_number_id, accessToken, perfil.empresa_id)
      .catch((err) => console.error('[whatsapp-embedded-signup] Error dando de alta la sincronización de Coexistencia:', err.message));

    // Otra empresa pudo haber tenido antes este mismo phone_number_id
    // (ej. número de test reciclado) — el UNIQUE de la migración 272 lo
    // hubiera rechazado con conflicto real, así que si llegamos acá está limpio.
    return res.status(200).json({ ok: true, verified_name: verifiedName, phone_number_id, es_coexistencia: true });
  } catch (err) {
    console.error('[whatsapp-embedded-signup] Error inesperado:', err.message);
    return res.status(500).json({ error: 'No se pudo completar la conexión con WhatsApp' });
  }
}

// Pide (no espera a que termine — es asincrónico vía webhooks `history` /
// `smb_app_state_sync`) la sincronización de contactos y de historial de
// chats de un número recién conectado por Coexistencia. Solo se puede
// pedir una vez por alta — si algo sale mal acá, el dueño queda conectado
// igual, simplemente sin el historial viejo (no es motivo para cortar el
// alta ni reintentar solo, ver comentario en el caller).
async function iniciarSincronizacionCoexistencia(phone_number_id, accessToken, empresa_id) {
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` };

  const pedirSync = async (sync_type) => {
    const resp = await fetch(`${META_BASE_URL}/${phone_number_id}/smb_app_data`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messaging_product: 'whatsapp', sync_type }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error(`[whatsapp-embedded-signup] Meta rechazó la solicitud de sync "${sync_type}":`, data?.error);
    }
    return resp.ok;
  };

  // Contactos primero, historial de chats después — mismo orden que
  // documenta Meta ("Step 1: Initiate contacts synchronization" / "Step 2:
  // Initiate message history synchronization").
  const contactosOk = await pedirSync('smb_app_state_sync');
  const historialOk = await pedirSync('history');

  if (contactosOk || historialOk) {
    await marcarHistorialSincronizado(empresa_id);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// ── Eventos de entrega ───────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

const WA_ENDPOINT = process.env.WA_ENDPOINT || 'http://localhost:3000/api/notif/whatsapp';

const MOTIVOS = {
  nadie_en_casa:        'nadie en casa al momento de la entrega',
  rechazo:              'el cliente rechazó la mercadería',
  direccion_incorrecta: 'la dirección no fue encontrada',
  otro:                 'inconveniente en la entrega',
};

async function entregaHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const apiKey = req.headers['x-api-key'];
  // FIX FASE 6 parte 3: tenant-scoping real.
  // No se encontró caller interno en todo el repo (frontend ni backend), pero
  // puede usarse desde herramientas externas (n8n, Zapier, webhooks propios).
  // Se mantiene el endpoint (no se elimina por precaución) y se agrega
  // validación de que ruta_id/pedido_id pertenezcan a una empresa real —
  // antes, cualquiera con la API key podía mandar pedido_id arbitrarios.
  if (!process.env.INTERNAL_API_KEY) {
    return res.status(503).json({ error: 'Endpoint no configurado' });
  }
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { evento, ruta_id, pedido_id, empresa_id, motivo } = req.body;
  if (!evento) return res.status(400).json({ error: 'Campo "evento" requerido' });
  if (!empresa_id) return res.status(400).json({ error: 'Campo "empresa_id" requerido para tenant-scoping' });

  try {
    switch (evento) {
      case 'despacho':             return res.json(await manejarDespacho(ruta_id, empresa_id));
      case 'entrega_confirmada':   return res.json(await manejarEntregaConfirmada(pedido_id, empresa_id));
      case 'entrega_no_realizada': return res.json(await manejarNoEntregado(pedido_id, motivo, empresa_id));
      case 'proximidad':           return res.json(await manejarProximidad(pedido_id, empresa_id, req.body.eta_minutos));
      default:
        return res.status(400).json({ error: `Evento desconocido: "${evento}"` });
    }
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

async function manejarDespacho(rutaId, empresaId) {
  if (!rutaId) throw new Error('ruta_id requerido para evento "despacho"');
  // Tenant-scoping: verificar que la ruta pertenece a la empresa del caller
  const rutaCheck = await obtenerRutaDeEmpresa(rutaId, empresaId);
  if (!rutaCheck) throw new Error('ruta_id no encontrada para esta empresa');
  // FIX: ruta_items → entregas (tabla real del schema)
  const { data: items, error } = await listarEntregasDeRuta(rutaId);
  if (error) throw error;
  if (!items?.length) return { ok: true, mensaje: 'Ruta sin pedidos', enviados: 0 };

  // FIX: rutas no tiene despachado_at — solo actualizar estado
  await marcarRutaEnCamino(rutaId);

  const resultados = await Promise.all(items.map(item => enviarNotifPedido(item.pedidos, 'despacho')));
  return { ok: true, evento: 'despacho', ruta_id: rutaId, enviados: resultados.filter(r => r.ok).length, errores: resultados.filter(r => !r.ok).length };
}

async function manejarEntregaConfirmada(pedidoId, empresaId) {
  if (!pedidoId) throw new Error('pedido_id requerido');
  // Tenant-scoping: filtrar por empresa_id del caller además del pedido_id
  const { data: pedido, error } = await obtenerPedidoParaNotifEntrega(pedidoId, empresaId);
  if (error || !pedido) throw new Error('Pedido no encontrado para esta empresa');
  // FIX: pedidos no tiene entregado_at — usar fecha_despacho o solo actualizar estado
  await marcarPedidoEntregado(pedidoId);
  const resultado = await enviarNotifPedido(pedido, 'entrega_confirmada');
  // Cableado (auditoría notificaciones): canal push además del WhatsApp de
  // arriba — notificarPedidoEntregado ya existía en _push.js sin caller.
  // Best-effort: si el cliente no tiene usuario de portal o el push falla,
  // no debe afectar el resultado del evento (el WhatsApp ya se mandó).
  if (pedido.clientes?.id) {
    notificarPedidoEntregado(pedidoId, pedido.clientes.id).catch(err =>
      console.error('[entrega-confirmada] Error enviando push de pedido entregado:', err.message));
  }
  return { ok: resultado.ok, evento: 'entrega_confirmada', pedido_id: pedidoId, ...resultado };
}

// FIX (auditoría etapa 6 — Hallazgo 1): esta función no tenía ningún caller
// en todo el repo (era código muerto) y, si algo la invocaba, marcaba el
// pedido como 'cancelado' — lo que rompía la reprogramación documentada
// ("el pedido queda disponible para reprogramar en una próxima ruta").
// El flujo real de "no se pudo entregar" ahora vive en el endpoint
// autenticado del chofer (PATCH /api/chofer/remitos/:id/no-entregar en
// pedidos.js), que ya hace el update de `entregas` y revierte el pedido a
// 'confirmado' con ownership/tenant checks completos vía JWT. Esta función
// queda acotada a un solo trabajo: mandar la notificación de WhatsApp. Si
// algo externo la sigue llamando directo (solo valida x-api-key estático,
// no JWT), no debe pisar ni duplicar ese estado — por eso ya no escribe en
// `pedidos` ni en `entregas`.
async function manejarNoEntregado(pedidoId, motivo, empresaId) {
  if (!pedidoId) throw new Error('pedido_id requerido');
  // Tenant-scoping: filtrar por empresa_id del caller además del pedido_id
  const { data: pedido, error } = await obtenerPedidoParaNotifEntrega(pedidoId, empresaId);
  if (error || !pedido) throw new Error('Pedido no encontrado para esta empresa');
  const resultado = await enviarNotifPedido(pedido, 'entrega_no_realizada', motivo);
  return { ok: resultado.ok, evento: 'entrega_no_realizada', pedido_id: pedidoId, motivo: motivo || 'otro', ...resultado };
}

// Etapa 1 (Logística) — Plan por etapas: "tracking en vivo del chofer +
// notificación al cliente" cuando el pedido está a ~15 min. Se dispara
// desde rutas-live.js (accion=posicion) al cruzar el umbral, una sola vez
// por entrega (ver entregas.aviso_proximidad_enviado).
async function manejarProximidad(pedidoId, empresaId, etaMinutos) {
  if (!pedidoId) throw new Error('pedido_id requerido para evento "proximidad"');
  const { data: pedido, error } = await obtenerPedidoParaNotifEntrega(pedidoId, empresaId);
  if (error || !pedido) throw new Error('Pedido no encontrado para esta empresa');

  const resultado = await enviarNotifPedido(pedido, 'proximidad', null, etaMinutos);
  return { ok: resultado.ok, evento: 'proximidad', pedido_id: pedidoId, ...resultado };
}

async function enviarNotifPedido(pedido, evento, motivo, etaMinutos) {
  const cliente = pedido?.clientes;
  if (!cliente?.telefono) return { ok: false, razon: 'sin_telefono', cliente: cliente?.razon_social };
  const nombreCorto = primerNombre(cliente.razon_social);
  let template, params;
  const numeroPedido = pedido.id ? pedido.id.slice(0, 8).toUpperCase() : '—';
  if (evento === 'despacho') {
    template = 'pedido_despachado'; params = { numero_pedido: numeroPedido, total: pedido.total };
  } else if (evento === 'entrega_confirmada') {
    template = 'pedido_entregado'; params = { nombre_cliente: nombreCorto, numero_pedido: numeroPedido };
  } else if (evento === 'proximidad') {
    // NOTA: template nuevo — falta darlo de alta en el proveedor de WhatsApp
    // Business (mismo lugar donde ya están pedido_despachado / pedido_entregado
    // / pedido_no_entregado). Mientras no esté aprobado, este envío falla con
    // error_wa y queda logueado, sin romper el resto del flujo de posición GPS.
    template = 'pedido_por_llegar';
    params = { nombre_cliente: nombreCorto, numero_pedido: numeroPedido, eta_minutos: etaMinutos ?? 15 };
  } else {
    template = 'pedido_no_entregado'; params = { nombre_cliente: nombreCorto, numero_pedido: numeroPedido, motivo: MOTIVOS[motivo] || MOTIVOS.otro };
  }
  try {
    const waResp = await fetch(WA_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template, telefono: cliente.telefono, params, empresa_id: pedido.empresa_id }) });
    const waData = await waResp.json();
    if (!waResp.ok) return { ok: false, razon: 'error_wa', detalle: waData.error, cliente: cliente.razon_social };
    // FIX: notif_log requiere empresa_id (NOT NULL) — tomarlo del pedido
    await registrarLog({ empresa_id: pedido.empresa_id, cliente_id: cliente.id, pedido_id: pedido.id, tipo: template, canal: 'whatsapp', telefono: cliente.telefono, message_id: waData.message_id || null, payload: params });
    return { ok: true, cliente: cliente.razon_social, message_id: waData.message_id };
  } catch (err) {
    return { ok: false, razon: 'error_red', detalle: err.message, cliente: cliente.razon_social };
  }
}

function primerNombre(razonSocial) {
  return (razonSocial || '').split(/[\s,]+/)[0];
}

// ═════════════════════════════════════════════════════════════════════════
// ── Push interno desde triggers de Supabase ──────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

const ROLES_POR_TIPO = {
  nuevo_pedido:  ['dueno', 'admin', 'vendedor'],
  // FIX (2026-07-12): typo 'deposito' → 'depositero'. El enum rol_usuario
  // real es dueno/admin/vendedor/depositero/chofer/contador/cliente — el
  // valor 'deposito' no existe, así que esta query rompía con
  // "22P02: invalid input value for enum rol_usuario" y el endpoint
  // devolvía 500 para TODA notificación de stock_critico, encontrado al
  // probar el fix de INTERNAL_PUSH_SECRET (ver CHANGELOG_v298).
  stock_critico: ['dueno', 'admin', 'depositero'],
  // Cron de Supabase (migración 437, whatsapp_avisar_conversaciones_estancadas):
  // conversación con borrador de pedido armado que quedó >40 min sin
  // respuesta del cliente. Mismos destinatarios que el resto de los avisos
  // de derivación del bot (whatsapp_derivado, ver marcarDerivada más abajo).
  whatsapp_estancado: ['dueno', 'admin', 'vendedor'],
};

async function pushInternoHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // FIX FASE 6 parte 3: secreto real vía variable de entorno INTERNAL_PUSH_SECRET.
  //
  // Para configurar/rotar el secreto:
  //   1. Generá un secreto fuerte: openssl rand -hex 32
  //   2. Setealo en Vercel: INTERNAL_PUSH_SECRET=<valor>
  //   3. Corré la migración SQL en supabase/migrations/20240101_push_interno_secret.sql
  //      que actualiza el trigger de Supabase para enviar ese valor en el
  //      header x-push-secret.
  //
  // FIX SEC-14 (auditoría 2026, hallazgo alto): el fallback de abajo
  // (aceptar el header legacy `x-trigger: supabase` cuando
  // INTERNAL_PUSH_SECRET no está configurada) quedaba activo indefinidamente
  // si nadie llegaba a completar el paso 2/3/4 de la migración descripta
  // arriba — y `x-trigger: supabase` es un valor fijo y público (aparece
  // documentado en este mismo archivo), no un secreto. Mientras la variable
  // de entorno no estuviera seteada en Vercel, cualquiera que conociera ese
  // header podía pedir pushes arbitrarios con `empresa_id`/`titulo`/`cuerpo`
  // controlados por él, a cualquier usuario de cualquier empresa.
  //
  // Ahora es fail-closed sin excepción: si INTERNAL_PUSH_SECRET no está
  // configurada, el endpoint rechaza TODO con 503 (en vez de aceptar el
  // fallback) — así el problema es una notificación caída y visible en los
  // triggers de Supabase, no un endpoint abierto y silencioso. Para
  // habilitar el endpoint hay que completar los pasos 1-3 de arriba.
  const pushSecret = process.env.INTERNAL_PUSH_SECRET;

  if (!pushSecret) {
    console.error('[SECURITY] pushInternoHandler: INTERNAL_PUSH_SECRET no configurada — rechazando (fail-closed). Configurá la variable y corré la migración SQL para habilitar el endpoint.');
    return res.status(503).json({ error: 'Endpoint no configurado' });
  }

  if (req.headers['x-push-secret'] !== pushSecret) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id, tipo, titulo, cuerpo, datos } = req.body;
  if (!empresa_id || !tipo || !titulo || !cuerpo) return res.status(400).json({ error: 'Faltan campos requeridos' });

  const roles = ROLES_POR_TIPO[tipo];
  if (!roles) return res.status(400).json({ error: `Tipo desconocido: ${tipo}` });

  try {
    const { data: usuarios, error } = await listarUsuariosPorRoles(empresa_id, roles);
    if (error) throw error;
    if (!usuarios?.length) return res.status(200).json({ ok: true, enviadas: 0, motivo: 'sin destinatarios' });

    let totalEnviadas = 0;
    for (const usuario of usuarios) {
      try {
        const { enviadas } = await enviarPush(usuario.id, titulo, cuerpo, datos || {}, { empresa_id, tipo });
        totalEnviadas += enviadas;
      } catch (e) { /* continue */ }
    }
    return res.status(200).json({ ok: true, enviadas: totalEnviadas, destinatarios: usuarios.length });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

// ═════════════════════════════════════════════════════════════════════════
// ── Registro/desregistro de dispositivos push ────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

async function pushHandler(req, res) {
  if (req.method === 'POST')   return registrarDispositivo(req, res);
  if (req.method === 'DELETE') return desregistrarDispositivo(req, res);
  return res.status(405).json({ error: 'Método no permitido' });
}

async function registrarDispositivo(req, res) {
  try {
    const { usuario_id, empresa_id, token_push, tipo_dispositivo } = req.body;
    if (!usuario_id || !token_push) return res.status(400).json({ error: 'Datos incompletos' });

    // FIX: push_tokens → dispositivos_push (tabla real del schema)
    const { error } = await upsertDispositivoPush({
      usuario_id, empresa_id, token_push, tipo_dispositivo: tipo_dispositivo || 'web',
      activo: true, updated_at: new Date().toISOString(),
    });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json({ ok: true });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

async function desregistrarDispositivo(req, res) {
  try {
    const { usuario_id, token_push } = req.body;
    if (!token_push) return res.status(400).json({ error: 'token_push requerido' });
    if (!usuario_id)  return res.status(400).json({ error: 'usuario_id requerido' });

    // FIX (audit Fase 2, hallazgo #4): antes se daba de baja el dispositivo
    // filtrando solo por token_push, sin validar que perteneciera al usuario
    // que hace el pedido. Ahora se exige coincidencia de usuario_id, así que
    // conocer/adivinar un token ajeno ya no alcanza para desregistrarlo.
    const { error } = await desactivarDispositivoPush(token_push, usuario_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json({ ok: true });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

// ═════════════════════════════════════════════════════════════════════════
// ── Push chofer (notif de ruta asignada) ─────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

async function pushChoferHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // FIX FASE 6: el frontend (rutas.js) siempre mandó Authorization: Bearer
  // <supabase_access_token>, nunca x-api-key — el chequeo anterior validaba
  // un header que el cliente real no envía. Si INTERNAL_API_KEY estaba
  // seteada en Vercel, esto rompía la función en producción; si no estaba
  // seteada, el chequeo se saltaba por completo (fail-open) y CUALQUIERA
  // podía disparar push a cualquier chofer de cualquier empresa con
  // chofer_id/ruta_id arbitrarios en el body. Se reemplaza por validación
  // real del JWT de Supabase + rol + pertenencia a la empresa.
  const perfil = await verificarToken(req, supabase);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });
  if (!['dueno', 'admin'].includes(perfil.rol)) return res.status(403).json({ error: 'Sin permisos' });

  const { chofer_id, ruta_id, fecha } = req.body || {};
  if (!chofer_id || !ruta_id) return res.status(400).json({ error: 'chofer_id y ruta_id son requeridos' });

  // empresa_id SIEMPRE del perfil autenticado — nunca del body (antes el
  // caller lo elegía libremente, lo que permitía notificar "como si fuera"
  // otra empresa en el log de push).
  const empresa_id = perfil.empresa_id;

  // Tenant scoping: chofer y ruta deben pertenecer a la empresa del que llama.
  const choferRow = await obtenerUsuarioDeEmpresa(chofer_id, empresa_id);
  if (!choferRow) return res.status(404).json({ error: 'Chofer no encontrado en tu empresa' });

  const rutaRow = await obtenerRutaDeEmpresa(ruta_id, empresa_id);
  if (!rutaRow) return res.status(404).json({ error: 'Ruta no encontrada en tu empresa' });

  try {
    const titulo = 'Ruta asignada';
    // FIX: 'fecha' viaja a texto plano de una notificación push sin escapar.
    // Se acota a un patrón de fecha simple para evitar inyección de texto
    // arbitrario en el cuerpo del push (vector de phishing).
    const fechaSegura = typeof fecha === 'string' && /^[\d/\-: ]{1,20}$/.test(fecha) ? fecha : null;
    const cuerpo = `Tenés una ruta programada${fechaSegura ? ` para el ${fechaSegura}` : ''}. Revisá los pedidos.`;
    const { enviadas } = await enviarPush(chofer_id, titulo, cuerpo, { tipo: 'ruta_asignada', ruta_id, link: '/chofer' }, { empresa_id, tipo: 'ruta_asignada' });
    return res.status(200).json({ ok: true, enviadas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ── Cheques por Vencer CRON (absorto desde api/notif/cheques-por-vencer.js) ─
// ══════════════════════════════════════════════════════════════════════════

// ── v295: marca/limpia el flag de reconexión en empresa_whatsapp ────────
// Se usa desde los puntos donde se detecta error 190 (token vencido) y
// desde los envíos exitosos (self-healing: si volvió a andar, se limpia
// solo, sin esperar a que alguien reconecte a mano). No hace nada si la
// empresa está en el número compartido de prueba (no hay fila que marcar).
async function marcarEstadoTokenWhatsapp(empresaId, necesitaReconexion) {
  if (!empresaId) return;
  await actualizarNecesitaReconexionWhatsapp(empresaId, necesitaReconexion);
}

const DIAS_AVISO     = 3;
// ── Alerta: token de WhatsApp (Meta) vencido/inválido ──────────────────────
// Se dispara cuando Meta responde código 190 (OAuthException). Sin esto, el
// corte de WhatsApp pasa desapercibido hasta que alguien revisa logs de Vercel.
const HORAS_COOLDOWN_WA_TOKEN = 6;

async function alertarTokenWhatsAppVencido(errorMeta, empresaId, propia) {
  // v295: si es el número propio de una empresa, se marca en la tabla
  // (así el panel "Conectar WhatsApp" puede mostrar "necesita reconexión"
  // sin depender de que alguien vea el push o revise logs).
  if (propia && empresaId) {
    await marcarEstadoTokenWhatsapp(empresaId, true);
  }

  // Cooldown y destinatarios: acotados a la empresa dueña del número si es
  // propio (no tiene sentido avisarle a otras empresas de un problema que
  // no es suyo); global como hasta ahora si es el número compartido de
  // prueba (afecta a todas las empresas que todavía lo usan por igual).
  const ultimoEnvioFecha = await ultimoEnvioPorTipo(
    'wa_token_vencido',
    (propia && empresaId) ? { empresa_id: empresaId } : {},
  );

  if (ultimoEnvioFecha) {
    const haceHoras = (Date.now() - new Date(ultimoEnvioFecha)) / 1000 / 3600;
    if (haceHoras < HORAS_COOLDOWN_WA_TOKEN) return; // ya se avisó recientemente
  }

  const admins = await listarAdminsDueno((propia && empresaId) ? empresaId : null);
  if (!admins?.length) return;

  const titulo = '⚠ WhatsApp desconectado';
  const cuerpo = propia
    ? `El WhatsApp que conectaste dejó de funcionar (Meta, código 190: "${errorMeta?.message || 'sin detalle'}"). Volvé a tocar "Conectar mi WhatsApp" en Configuración para reconectarlo.`
    : `El token de Meta del número compartido venció o es inválido (code 190): "${errorMeta?.message || 'sin detalle'}". Las notificaciones por WhatsApp no se están enviando.`;

  for (const admin of admins) {
    try { await enviarPush(admin.id, titulo, cuerpo, { tipo: 'wa_token_vencido', link: '/admin/whatsapp-onboarding' }); }
    catch (e) { /* continue */ }
  }

  // Registro para el cooldown — por empresa si es número propio, o del
  // primer admin encontrado si es el número global (mismo criterio de
  // antes, solo a fines de control).
  await registrarLog({
    empresa_id: (propia && empresaId) ? empresaId : admins[0].empresa_id,
    tipo: 'wa_token_vencido',
    canal: 'push',
    payload: { error: errorMeta },
  });
}

const HORAS_COOLDOWN_CHEQUES = 23;

// ── Fase 4 (plan ERP), evento `cheques_por_vencer` ───────────────────────
// Réplica exacta del bloque que antes vivía inline en el loop de
// handleChequesCron (push a admins + WhatsApp opcional + notif_log) — se
// extrae a función exportada para que la reuse tanto el camino directo
// (empresas sin el flag de Fase 3) como el listener del despachador
// (lib/eventos-listeners/cheques_por_vencer.js), sin duplicar la lógica.
// Mismo criterio que enviarAvisoDeudaVencida (cliente_en_mora, Fase 4).
//
// El payload del evento solo trae los ids de los cheques (liviano, mismo
// criterio que el resto de los eventos) — acá se resuelven de nuevo desde
// la base junto con los admins, en vez de viajar el objeto completo.
// Devuelve { ok, motivo? } — el caller decide cómo contabilizarlo.
export async function enviarAvisoChequesPorVencer({ empresaId, chequeIds }) {
  const { data: lista, error: chequesError } = await listarChequesPorIds(chequeIds);
  if (chequesError) return { ok: false, motivo: `error leyendo cheques — ${chequesError.message}` };
  if (!lista?.length) return { ok: false, motivo: 'ningún cheque de la lista encontrado' };

  const admins = await listarAdminsDueno(empresaId, { campos: 'id, nombre, email, telefono' });
  if (!admins?.length) return { ok: false, motivo: 'sin admins/dueños para notificar' };

  const hoy = new Date();
  const total   = lista.reduce((s, c) => s + (c.monto || 0), 0);
  const resumen = lista.map(c => {
    const diasRestantes = Math.ceil((new Date(c.vencimiento) - hoy) / 86400000);
    const label = diasRestantes === 0 ? 'hoy' : diasRestantes === 1 ? 'mañana' : `en ${diasRestantes} días`;
    return `${c.clientes?.razon_social || 'Cliente'} — $${c.monto?.toLocaleString('es-AR')} (vence ${label})`;
  }).join('\n');

  const titulo = `${lista.length} cheque${lista.length > 1 ? 's' : ''} por vencer`;
  const cuerpo = `Total: $${total.toLocaleString('es-AR')}\n${resumen}`;

  let envioPush = false;
  for (const admin of admins) {
    try {
      const { enviadas } = await enviarPush(admin.id, titulo, cuerpo, { tipo: 'cheques_por_vencer', link: '/admin/cheques' });
      if (enviadas > 0) envioPush = true;
    } catch (e) { /* continue */ }
  }

  if (process.env.WA_ENDPOINT) {
    const adminConTel = admins.find(a => a.telefono);
    if (adminConTel?.telefono) {
      try {
        await fetch(process.env.WA_ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template: 'cheques_por_vencer', telefono: adminConTel.telefono, params: { cantidad: String(lista.length), total: total.toLocaleString('es-AR') }, empresa_id: empresaId }),
        });
      } catch (e) { /* WA opcional */ }
    }
  }

  await registrarLog({ empresa_id: empresaId, tipo: 'cheques_por_vencer', canal: 'push', payload: { cantidad: lista.length, total, cheques: lista.map(c => c.id) } });
  return { ok: true, cantidad: lista.length, total };
}

async function handleChequesCron(req, res) {
  // FIX FASE 6: Vercel invoca los cron jobs con método GET y adjunta
  // automáticamente "Authorization: Bearer $CRON_SECRET" — se acepta GET/POST
  // y queda fail-closed si CRON_SECRET no está configurada.
  // CRON-001 (auditoría 2026-07-26): se sacó `x-vercel-cron` de la condición
  // de autorización — es un header spoofeable por cualquiera en un request
  // normal, no un mecanismo de seguridad documentado por Vercel. Ahora es
  // puramente informativo (se sigue leyendo más abajo por si se quiere
  // loguear, pero ya no otorga acceso por sí solo).
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });

  const authHeader    = req.headers['authorization'] || '';
  const secretQueryFallback = req.headers['x-cron-secret'] || req.body?.secret; // compat: testing manual

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron no configurado' });
  }
  const secretOk = authHeader === `Bearer ${process.env.CRON_SECRET}` || secretQueryFallback === process.env.CRON_SECRET;
  if (!secretOk) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const hoy    = new Date();
  const limite = new Date(hoy);
  limite.setDate(limite.getDate() + DIAS_AVISO);

  const resultados = { procesados: 0, enviados: 0, omitidos: 0, errores: 0, detalle: [] };

  try {
    // FIX: cheques.fecha_cobro no existe → columna real es vencimiento
    const cheques = await listarChequesPorVencer(
      hoy.toISOString().split('T')[0],
      limite.toISOString().split('T')[0],
    );

    const porEmpresa = {};
    for (const ch of (cheques || [])) {
      if (!porEmpresa[ch.empresa_id]) porEmpresa[ch.empresa_id] = [];
      porEmpresa[ch.empresa_id].push(ch);
    }

    for (const [empresaId, lista] of Object.entries(porEmpresa)) {
      resultados.procesados++;

      const ultimoEnvioFecha = await ultimoEnvioPorTipo('cheques_por_vencer', { empresa_id: empresaId });

      if (ultimoEnvioFecha) {
        const haceHoras = (hoy - new Date(ultimoEnvioFecha)) / 1000 / 3600;
        if (haceHoras < HORAS_COOLDOWN_CHEQUES) {
          resultados.omitidos++;
          resultados.detalle.push({ empresa: empresaId, resultado: `omitido — avisado hace ${Math.round(haceHoras)} hs` });
          continue;
        }
      }

      // Fase 4 (plan ERP de sincronización): mismo criterio que
      // handleDeudaCron/cliente_en_mora — se emite el evento siempre,
      // awaiteado (cron batch, sin nadie esperando una respuesta HTTP
      // rápida; awaitear evita la carrera de despacharPendientes
      // corriendo antes de que el INSERT del evento confirme).
      try {
        await emitirEvento({
          empresaId,
          tipoEvento: 'cheques_por_vencer',
          payload: { cheque_ids: lista.map(c => c.id) },
          origen: 'handleChequesCron',
        });
      } catch (err) {
        console.error('[EVENTOS] error emitiendo cheques_por_vencer:', err);
      }

      // Fase 3: expand-contract — nunca las dos rutas activas a la vez
      // para la misma empresa.
      let despachadorActivo = false;
      try {
        despachadorActivo = await usaDespachadorEventos(empresaId);
      } catch (err) {
        console.error('[EVENTOS] error chequeando flag fase3_despachador_eventos:', err);
      }

      let resultadoAviso;
      if (despachadorActivo) {
        const { despacharPendientes } = await import('../eventos-dispatcher.js');
        const resultadoDespacho = await despacharPendientes({ empresaId });
        resultadoAviso = resultadoDespacho.ok
          ? { ok: true }
          : { ok: false, motivo: 'error en el despachador de eventos (ver eventos_negocio)' };
      } else {
        resultadoAviso = await enviarAvisoChequesPorVencer({ empresaId, chequeIds: lista.map(c => c.id) });
      }

      if (!resultadoAviso.ok) {
        resultados.errores++;
        resultados.detalle.push({ empresa: empresaId, resultado: resultadoAviso.motivo || 'error desconocido' });
        continue;
      }
      resultados.enviados++;
      resultados.detalle.push({ empresa: empresaId, resultado: 'enviado', cheques: lista.length, total: lista.reduce((s, c) => s + (c.monto || 0), 0) });
    }

    return res.status(200).json({ ok: true, ...resultados });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ── Barrido de eventos_negocio (Fase 4 — plan ERP) ─────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Reprocesa eventos 'pendiente' (nunca se despacharon, ej. el flag de
// Fase 3 se activó después de emitidos) y 'error' (un listener falló) para
// TODAS las empresas — despacharPendientes() sin empresaId ya consulta sin
// filtrar por empresa. No hace nada distinto de lo que ya hacía el
// despacho inmediato; solo le da una segunda oportunidad a lo que quedó
// atrás. Mismo criterio de auth que el resto de los crons (CRON_SECRET,
// fail-closed si no está configurada).
async function handleEventosReprocesarCron(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });

  const authHeader = req.headers['authorization'] || '';
  const secretQueryFallback = req.headers['x-cron-secret'] || req.body?.secret;

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron no configurado' });
  }
  const secretOk = authHeader === `Bearer ${process.env.CRON_SECRET}` || secretQueryFallback === process.env.CRON_SECRET;
  if (!secretOk) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const { despacharPendientes } = await import('../eventos-dispatcher.js');
    // limite 500: hasta v588 esto corría 1 vez por hora (límite de cron
    // por hora del plan Hobby de Vercel — ver vercel.json) con un límite
    // de 200, justificado en que no debería acumular más que eso entre
    // corridas. Al bajar a 1 corrida diaria (mismo motivo: el plan Hobby
    // no permite crons más frecuentes que 1/día) el backlog entre
    // corridas puede ser hasta 24x mayor en el peor caso, así que se
    // sube el límite en la misma proporción. Si algún día lo satura,
    // sigue siendo señal de que algo está fallando en loop — vale la
    // pena que aparezca en los logs, no esconderlo subiendo el límite
    // más todavía sin investigar (mismo criterio que antes). Si el
    // volumen real de eventos crece de forma sostenida, esto necesita
    // revisarse junto con la Fase 8 del plan ERP (observabilidad,
    // todavía sin arrancar) en vez de seguir subiendo el número a mano.
    const resultado = await despacharPendientes({ limite: 500, incluirErrores: true });
    return res.status(200).json({ ok: resultado.ok, procesados: resultado.procesados, con_error: resultado.conError });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar el barrido de eventos.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ── Reintento de salientes del bot de WhatsApp CRON (Etapa 5 offline,
//    punto 3 del plan) ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Mismo esquema de auth y mismo motivo de "1 corrida diaria" que
// handleEventosReprocesarCron (plan Hobby de Vercel no permite crons más
// frecuentes) — ver comentario ahí. El reintento inmediato ya lo cubre
// enviarTextoWhatsApp (lib arriba); esto es el catch-all para lo que ni
// así salió (Meta caído más de unos segundos, token vencido, etc.).
async function handleWhatsappSalientesReprocesarCron(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });

  const authHeader = req.headers['authorization'] || '';
  const secretQueryFallback = req.headers['x-cron-secret'] || req.body?.secret;

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron no configurado' });
  }
  const secretOk = authHeader === `Bearer ${process.env.CRON_SECRET}` || secretQueryFallback === process.env.CRON_SECRET;
  if (!secretOk) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const { data: pendientes, error } = await obtenerSalientesPendientes(200);
    if (error) throw new Error(error.message || 'No se pudo leer el outbox de WhatsApp');

    let enviados = 0;
    let conError = 0;
    let agotados = 0;

    for (const msg of pendientes) {
      const conv = msg.whatsapp_conversaciones;
      const intentosPrevios = msg.metadata?.intentos || 0;

      if (!conv?.telefono || !conv?.empresa_id) {
        // No debería pasar (FK NOT NULL a whatsapp_conversaciones), pero
        // si la conversación fue borrada por algún motivo no hay a quién
        // reenviarle — no tiene sentido seguir reintentando esto.
        await marcarSalienteFallido(msg.id, 999, 'Conversación asociada no encontrada');
        agotados++;
        continue;
      }

      const envio = await enviarTextoWhatsApp(conv.telefono, msg.texto, conv.empresa_id);
      if (envio) {
        await marcarSalienteEnviado(msg.id, envio.message_id);
        enviados++;
      } else {
        await marcarSalienteFallido(msg.id, intentosPrevios, 'Reintento del cron falló — ver logs de enviarTextoWhatsApp');
        if (intentosPrevios + 1 >= MAX_INTENTOS_SALIENTE) agotados++;
        else conError++;
      }
    }

    return res.status(200).json({ ok: true, procesados: pendientes.length, enviados, con_error: conError, agotados });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar el barrido de salientes de WhatsApp.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ── Reproceso del outbox de auditoría financiera CRON (Punto 8, auditoría
//    2026) ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Mismo esquema de auth y mismo criterio de "1 corrida diaria" que
// handleEventosReprocesarCron/handleWhatsappSalientesReprocesarCron (plan
// Hobby de Vercel no permite crons más frecuentes) — ver comentario ahí.
// Toda la lógica de claim/reintento/dead-letter vive en
// reprocesarAuditoriaPendientes (lib/repos/audit.js); esto es solo el
// wiring HTTP + auth, igual que los otros dos cron handlers.
async function handleAuditLogReprocesarCron(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });

  const authHeader = req.headers['authorization'] || '';
  const secretQueryFallback = req.headers['x-cron-secret'] || req.body?.secret;

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron no configurado' });
  }
  const secretOk = authHeader === `Bearer ${process.env.CRON_SECRET}` || secretQueryFallback === process.env.CRON_SECRET;
  if (!secretOk) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const resultado = await reprocesarAuditoriaPendientes({ limite: 200, incluirErrores: true });
    if (resultado.error) throw new Error(resultado.error);

    return res.status(200).json({
      ok: resultado.ok,
      procesados: resultado.procesados,
      con_error: resultado.conError,
      agotados: resultado.agotados,
    });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar el reproceso del outbox de auditoría.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ── Deuda Vencida CRON (absorto desde api/notif/deuda-vencida.js) ─────────
// ══════════════════════════════════════════════════════════════════════════

const DEUDA_WA_ENDPOINT  = process.env.WA_ENDPOINT || 'http://localhost:3000/api/notif/whatsapp';
const HORAS_COOLDOWN_DEUDA = 72;

// ── Fase 4 (plan ERP), evento `cliente_en_mora` ──────────────────────────
// Réplica exacta del bloque que antes vivía inline en el loop de
// handleDeudaCron (WhatsApp + notif_log + push) — se extrae a función
// exportada para que la reuse tanto el camino directo (empresas sin el
// flag de Fase 3) como el listener del despachador (lib/eventos-listeners/
// cliente_en_mora.js), sin duplicar la lógica. Mismo criterio que
// emitirFactura/notificarPedidoConfirmado en la Fase 3.
// Devuelve { ok, motivo? } — el caller decide cómo contabilizarlo
// (el cron lo usa para enviados/errores/detalle).
export async function enviarAvisoDeudaVencida({ clienteId, empresaId, telefono, razonSocial, saldoVencido }) {
  try {
    const waResp = await fetch(DEUDA_WA_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'deuda_vencida', telefono, params: { nombre_cliente: _primerNombreDeuda(razonSocial), monto_vencido: saldoVencido }, empresa_id: empresaId }),
    });
    const waData = await waResp.json();
    if (!waResp.ok) {
      return { ok: false, motivo: `error WA — ${waData.error}` };
    }
    await registrarLog({ cliente_id: clienteId, empresa_id: empresaId, tipo: 'deuda_vencida', canal: 'whatsapp', telefono, message_id: waData.message_id || null, payload: { saldo_vencido: saldoVencido } });
    // Cableado (auditoría notificaciones): canal push además del
    // WhatsApp de arriba — notificarDeudaVencida ya existía en
    // _push.js sin caller. Best-effort: no corta el flujo si el cliente
    // no tiene usuario de portal o el push falla.
    notificarDeudaVencida(clienteId, saldoVencido).catch(err =>
      console.error('[deuda-vencida] Error enviando push de deuda vencida:', err.message));
    return { ok: true };
  } catch (waErr) {
    return { ok: false, motivo: `error red — ${waErr.message}` };
  }
}

async function handleDeudaCron(req, res) {
  // FIX FASE 6: Vercel invoca los cron jobs con método GET y adjunta
  // automáticamente "Authorization: Bearer $CRON_SECRET" — se acepta GET/POST
  // y queda fail-closed si CRON_SECRET no está configurada.
  // CRON-001 (auditoría 2026-07-26): se sacó `x-vercel-cron` de la condición
  // de autorización — es un header spoofeable por cualquiera en un request
  // normal, no un mecanismo de seguridad documentado por Vercel.
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });

  const authHeader    = req.headers['authorization'] || '';
  const secretQueryFallback = req.headers['x-cron-secret'] || req.body?.secret; // compat: testing manual

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron no configurado' });
  }
  const secretOk = authHeader === `Bearer ${process.env.CRON_SECRET}` || secretQueryFallback === process.env.CRON_SECRET;
  if (!secretOk) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const resultados = { procesados: 0, enviados: 0, omitidos: 0, errores: 0, detalle: [] };

  try {
    const clientes = await listarClientesActivosConCtaCte();

    const hoy = new Date();
    for (const cliente of (clientes || [])) {
      resultados.procesados++;

      if (!cliente.telefono) {
        resultados.omitidos++;
        resultados.detalle.push({ cliente: cliente.razon_social, resultado: 'omitido — sin teléfono' });
        continue;
      }

      const diasCredito = cliente.dias_credito || 30;
      let vencido = 0, creditos = 0;
      for (const m of (cliente.cta_cte || [])) {
        if (m.tipo === 'debito') {
          const fv = new Date(m.fecha);
          fv.setDate(fv.getDate() + diasCredito);
          if (fv < hoy) vencido += m.monto;
        } else { creditos += m.monto; }
      }
      // El saldo vencido es la deuda que ya pasó su fecha de crédito menos los pagos/créditos totales
      const saldoVencido = Math.max(0, vencido - creditos);

      if (saldoVencido <= 0) {
        resultados.omitidos++;
        resultados.detalle.push({ cliente: cliente.razon_social, resultado: 'omitido — sin deuda vencida' });
        continue;
      }

      const ultimoEnvioFecha = await ultimoEnvioPorCliente(cliente.id, 'deuda_vencida');

      if (ultimoEnvioFecha) {
        const hace = (hoy - new Date(ultimoEnvioFecha)) / 1000 / 3600;
        if (hace < HORAS_COOLDOWN_DEUDA) {
          resultados.omitidos++;
          resultados.detalle.push({ cliente: cliente.razon_social, resultado: `omitido — ya avisado hace ${Math.round(hace)} hs` });
          continue;
        }
      }

      // Fase 4 (plan ERP de sincronización): se emite el evento de negocio
      // siempre, esté activo o no el despachador — deja rastro en
      // eventos_negocio para trazabilidad aunque el camino directo (abajo)
      // sea el que efectivamente dispare el aviso para esta empresa. Mismo
      // criterio que pedido_creado en crearPedidoParaCliente (Fase 1/3).
      //
      // FIX (esta entrega): a diferencia de crearPedidoParaCliente (donde
      // emitirEvento y el despacho van los dos fire-and-forget, sin nadie
      // esperando respuesta HTTP), acá SÍ se espera el despacho un poco más
      // abajo — así que dejar este emitirEvento sin awaitear generaba una
      // carrera real: despacharPendientes podía correr antes de que el
      // INSERT del evento hubiera confirmado, y el aviso de esta vuelta del
      // loop quedaba pendiente hasta la corrida siguiente del cron (con el
      // cron reportando "enviado" igual, porque el despacho de eventos
      // viejos daba ok). Se awaitea: mismo criterio que el resto de este
      // bloque, sin costo real en un cron batch.
      try {
        await emitirEvento({
          empresaId: cliente.empresa_id,
          tipoEvento: 'cliente_en_mora',
          payload: { cliente_id: cliente.id, saldo_vencido: saldoVencido },
          origen: 'handleDeudaCron',
        });
      } catch (err) {
        console.error('[EVENTOS] error emitiendo cliente_en_mora:', err);
      }

      // Fase 3: expand-contract — nunca las dos rutas activas a la vez
      // para la misma empresa. A diferencia de crearPedidoParaCliente
      // (que responde a un HTTP request y por eso dispara el despacho
      // fire-and-forget), acá estamos en un cron batch sin nadie
      // esperando una respuesta rápida — se puede esperar el resultado
      // real y usarlo para las estadísticas del cron sin ningún costo.
      let despachadorActivo = false;
      try {
        despachadorActivo = await usaDespachadorEventos(cliente.empresa_id);
      } catch (err) {
        console.error('[EVENTOS] error chequeando flag fase3_despachador_eventos:', err);
      }

      let resultadoAviso;
      if (despachadorActivo) {
        const { despacharPendientes } = await import('../eventos-dispatcher.js');
        const resultadoDespacho = await despacharPendientes({ empresaId: cliente.empresa_id });
        resultadoAviso = resultadoDespacho.ok
          ? { ok: true }
          : { ok: false, motivo: 'error en el despachador de eventos (ver eventos_negocio)' };
      } else {
        resultadoAviso = await enviarAvisoDeudaVencida({
          clienteId: cliente.id, empresaId: cliente.empresa_id, telefono: cliente.telefono,
          razonSocial: cliente.razon_social, saldoVencido,
        });
      }

      if (!resultadoAviso.ok) {
        resultados.errores++;
        resultados.detalle.push({ cliente: cliente.razon_social, resultado: resultadoAviso.motivo || 'error desconocido' });
        continue;
      }
      resultados.enviados++;
      resultados.detalle.push({ cliente: cliente.razon_social, resultado: 'enviado', saldo_vencido: saldoVencido });
    }

    return res.status(200).json({ ok: true, ...resultados });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

function _primerNombreDeuda(razonSocial) {
  return (razonSocial || '').split(/[\s,]+/)[0];
}

// ══════════════════════════════════════════════════════════════════════════
// ── Estado de Cuenta (absorto desde api/estado-cuenta/index.js) ──────────
// ══════════════════════════════════════════════════════════════════════════

async function handleEstadoCuenta(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  if (await limiterEstadoCuenta(req, res)) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Sin token de autenticación' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Token inválido o expirado' });

  const { data: perfil, error: perfilErr } = await obtenerPerfilEstadoCuenta(user.id);
  if (perfilErr || !perfil) return res.status(403).json({ error: 'Perfil no encontrado' });

  if (!puede(perfil, 'enviar', 'notif_estado_cuenta')) return res.status(403).json({ error: 'Rol insuficiente para enviar estados de cuenta' });

  const { cliente_id, incluir_movimientos = true, email_override } = req.body || {};
  if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido' });

  const { data: cliente, error: cliErr } = await obtenerClienteEstadoCuenta(cliente_id, perfil.empresa_id);
  if (cliErr || !cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  // Etapa 3, Hallazgo 3: el modal de "Enviar estado de cuenta"
  // (cta-cte.js) siempre armó y mandó este campo — con un mensaje al
  // usuario de "podés ingresar un email manualmente para este envío
  // puntual" cuando el cliente no tiene email cargado — pero el handler
  // nunca lo leía del body. Resultado real: si el cliente no tenía email,
  // el envío fallaba con 422 sin importar lo que el usuario escribiera acá,
  // sin ninguna pista de que el campo era decorativo.
  let emailDestino = cliente.email;
  if (email_override) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email_override)) {
      return res.status(400).json({ error: 'El email ingresado no es válido' });
    }
    emailDestino = email_override;
  }
  if (!emailDestino) return res.status(422).json({ error: 'El cliente no tiene email registrado' });

  const facturas = await listarFacturasPendientes(perfil.empresa_id, cliente_id);

  let movimientos = [];
  if (incluir_movimientos) {
    movimientos = await listarUltimosMovimientos(perfil.empresa_id, cliente_id, { limit: 10 });
  }

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  let deudaTotal = 0, deudaVencida = 0, deudaPorVencer = 0;
  for (const f of facturas || []) {
    const pendiente = (f.total || 0) - (f.total_cobrado || 0);
    if (pendiente <= 0) continue;
    deudaTotal += pendiente;
    const vto = f.vencimiento ? new Date(f.vencimiento) : null;
    if (vto) {
      if (vto < hoy) deudaVencida += pendiente;
      else if ((vto - hoy) <= 7 * 86400000) deudaPorVencer += pendiente;
    }
  }

  const empresa = perfil.empresas;
  const resultado = await enviarEmailEstadoCuenta(
    { ...cliente, email: emailDestino }, { total: deudaTotal, vencida: deudaVencida, porVencer: deudaPorVencer },
    facturas || [], movimientos, empresa, perfil
  );

  // FIX (Hallazgo 2, auditoría notificaciones — "reenvío manual de
  // emails"): antes esto se logueaba en email_log, una tabla legada sin
  // columnas `entregada`/`motivo` (ver 018_req10_email_log.sql), y el
  // `return res.status(502)` de la línea de más abajo cortaba el flujo
  // ANTES de llegar a este insert cuando el envío fallaba — es decir, en
  // producción email_log solo tenía filas de envíos exitosos, ninguna de
  // los fallidos. Se migra a notif_log (tipo='estado_cuenta', canal='email'),
  // igual que el resto de los emails del sistema, logueando siempre —
  // éxito y falla — para que el historial combinado del panel sea real y
  // haya algo consistente que un reintento pueda usar. email_log se deja
  // de escribir pero las filas históricas siguen siendo legibles desde el
  // panel (ver frontend/admin/js/notif-log.js).
  await registrarLogConAviso({
    empresa_id: perfil.empresa_id,
    cliente_id,
    tipo:       'estado_cuenta',
    canal:      'email',
    email:      emailDestino,
    message_id: resultado.id || null,
    entregada:  !!resultado.ok,
    motivo:     resultado.ok ? null : (resultado.razon || 'error_desconocido'),
    payload:    { asunto: `Estado de cuenta — ${empresa?.nombre || 'Distribuidora'}`, enviado_por: perfil.id },
  }, 'ESTADO-CUENTA');

  if (!resultado.ok) return res.status(502).json({ error: 'Error al enviar el email', detalle: resultado.razon });

  return res.status(200).json({ ok: true, email_id: resultado.id, destinatario: emailDestino, cliente: cliente.nombre_fantasia || cliente.razon_social });
}

// ══════════════════════════════════════════════════════════════════════════
// ── Reintento manual de emails fallidos (Hallazgo 2, auditoría notif.) ────
// ══════════════════════════════════════════════════════════════════════════
//
// No reenvía el HTML tal cual quedó guardado (no se guarda HTML en
// notif_log — el payload solo tiene identificadores livianos, a propósito,
// para no inflar la tabla). En cambio, vuelve a armar el email desde datos
// frescos de la base (por si el cliente actualizó su email, el pedido
// cambió de total, etc.) y llama al mismo enviarEmailXxx() que usa el
// flujo original. El resultado se inserta como una fila NUEVA en
// notif_log (con `reintento_de` apuntando a la fila original en el
// payload) — se preserva el historial completo de intentos en vez de
// mutar el registro original.
const TIPOS_REINTENTABLES = ['confirmacion_pedido', 'pedido_despachado', 'estado_cuenta', 'recepcion_proveedor'];

async function handleReintentarEmail(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // Mismo costo/rate-limit que estado-cuenta: dispara un envío real por Resend.
  if (await limiterEstadoCuenta(req, res)) return;

  const perfil = await verificarToken(req, supabase);
  if (!perfil) return res.status(401).json({ error: 'Token inválido o expirado' });
  if (!['dueno', 'admin'].includes(perfil.rol)) {
    return res.status(403).json({ error: 'Rol insuficiente para reintentar envíos' });
  }

  const { notif_log_id } = req.body || {};
  if (!notif_log_id) return res.status(400).json({ error: 'notif_log_id requerido' });

  const { data: original, error: origErr } = await obtenerNotifLogPorId(notif_log_id, perfil.empresa_id);
  if (origErr || !original) return res.status(404).json({ error: 'Registro no encontrado' });

  if (original.canal !== 'email') {
    return res.status(400).json({ error: 'Solo se pueden reintentar notificaciones de email' });
  }
  if (original.entregada) {
    return res.status(400).json({ error: 'Este email ya fue entregado correctamente' });
  }
  if (!TIPOS_REINTENTABLES.includes(original.tipo)) {
    return res.status(400).json({ error: `No se puede reintentar el tipo "${original.tipo}" todavía` });
  }

  let resultado;
  try {
    switch (original.tipo) {
      case 'confirmacion_pedido':
        resultado = await _reintentarConfirmacionPedido(original);
        break;
      case 'pedido_despachado':
        resultado = await _reintentarDespacho(original);
        break;
      case 'estado_cuenta':
        resultado = await _reintentarEstadoCuenta(original, perfil);
        break;
      case 'recepcion_proveedor':
        resultado = await _reintentarRecepcionProveedor(original, perfil);
        break;
    }
  } catch (err) {
    console.error(`[REINTENTAR-EMAIL] Error reconstruyendo envío (notif_log ${notif_log_id}):`, err.message);
    resultado = { ok: false, razon: 'error_reconstruyendo_envio' };
  }

  // Fila nueva, preservando el historial (no se pisa la original).
  await registrarLogConAviso({
    empresa_id: original.empresa_id,
    cliente_id: original.cliente_id,
    pedido_id:  original.pedido_id,
    tipo:       original.tipo,
    canal:      'email',
    email:      original.email,
    message_id: resultado?.id || null,
    entregada:  !!resultado?.ok,
    motivo:     resultado?.ok ? null : (resultado?.razon || 'error_desconocido'),
    payload:    { ...(original.payload || {}), reintento_de: original.id, reintentado_por: perfil.id },
  }, 'REINTENTAR-EMAIL');

  if (!resultado?.ok) {
    return res.status(502).json({ error: 'El reintento también falló', detalle: resultado?.razon });
  }
  return res.status(200).json({ ok: true, email_id: resultado.id });
}

async function _reintentarConfirmacionPedido(original) {
  const pedido  = await obtenerPedidoConItemsParaReintento(original.pedido_id);
  const cliente = await obtenerClienteParaReintento(original.cliente_id, 'email, razon_social');
  const empresa = await obtenerEmpresaParaEmail(original.empresa_id);

  if (!pedido || !cliente) return { ok: false, razon: 'pedido_o_cliente_no_encontrado' };

  const items = (pedido.pedido_items || []).map(i => ({
    nombre:          i.productos?.nombre || '—',
    cantidad:        i.cantidad,
    precio_unitario: i.precio_unitario,
    descuento_pct:   i.descuento_pct || 0,
  }));
  return enviarEmailConfirmacionPedido(pedido, cliente, empresa, items);
}

async function _reintentarDespacho(original) {
  const pedido  = await obtenerPedidoDespachoParaReintento(original.pedido_id);
  const cliente = await obtenerClienteParaReintento(original.cliente_id, 'id, email, razon_social');
  const empresa = await obtenerEmpresaParaEmail(original.empresa_id);

  if (!pedido || !cliente) return { ok: false, razon: 'pedido_o_cliente_no_encontrado' };
  return enviarEmailDespacho(pedido, cliente, empresa);
}

async function _reintentarEstadoCuenta(original, perfil) {
  const cliente = await obtenerClienteEstadoCuentaPorId(original.cliente_id);
  const empresa = await obtenerEmpresaParaEmail(original.empresa_id);

  if (!cliente) return { ok: false, razon: 'cliente_no_encontrado' };

  const facturas = await listarFacturasPendientes(original.empresa_id, original.cliente_id);

  const movs = await listarUltimosMovimientos(original.empresa_id, original.cliente_id, { limit: 10 });

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  let deudaTotal = 0, deudaVencida = 0, deudaPorVencer = 0;
  for (const f of facturas || []) {
    const pendiente = (f.total || 0) - (f.total_cobrado || 0);
    if (pendiente <= 0) continue;
    deudaTotal += pendiente;
    const vto = f.vencimiento ? new Date(f.vencimiento) : null;
    if (vto) {
      if (vto < hoy) deudaVencida += pendiente;
      else if ((vto - hoy) <= 7 * 86400000) deudaPorVencer += pendiente;
    }
  }

  // Se reenvía al mismo destinatario que falló originalmente (puede ser un
  // email_override puntual distinto al del cliente) en vez de recalcularlo,
  // para que el reintento sea fiel al intento que se está reintentando.
  return enviarEmailEstadoCuenta(
    { ...cliente, email: original.email || cliente.email },
    { total: deudaTotal, vencida: deudaVencida, porVencer: deudaPorVencer },
    facturas || [], movs || [], empresa, perfil
  );
}

async function _reintentarRecepcionProveedor(original, perfil) {
  const recepcionId = original.payload?.recepcion_id;
  if (!recepcionId) return { ok: false, razon: 'recepcion_id_no_disponible' };

  const recepcion = await obtenerRecepcionParaReintento(recepcionId, original.empresa_id);
  if (!recepcion) return { ok: false, razon: 'recepcion_no_encontrada' };

  const orden = await obtenerOrdenCompraConProveedor(recepcion.orden_id, original.empresa_id);

  const proveedor = orden?.proveedores;
  if (!proveedor?.email) return { ok: false, razon: 'sin_email' };

  const empresa = await obtenerEmpresaParaEmail(original.empresa_id);

  return enviarEmailRecepcionProveedor(
    proveedor, orden, recepcion,
    recepcion.items_conciliados || [], recepcion.discrepancias || [], empresa,
  );
}
