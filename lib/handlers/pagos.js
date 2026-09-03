// api/pagos/index.js  (consolidado desde mercado-pago.js)
// Integración con Mercado Pago para pagos online
//
// DT-04: Rate limiting en todos los métodos.
//        El webhook además verifica firma HMAC-SHA256 (x-signature) para
//        garantizar que la notificación proviene realmente de Mercado Pago.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { getUserSeguro } from '../auth-helpers.js';
import { rateLimit } from '../rate-limit.js';
import fetch from 'node-fetch';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { CircuitBreaker, CircuitBreakerOpenError } from '../circuit-breaker.js';
import { withRetry } from '../retry.js';
import { cifrar, descifrar } from '../crypto-secrets.js';
import { esEmpresaDemo } from '../demo-mode.js';
import { exigirLimitePlan, LimitePlanError } from '../plan-limits.js';
import { registrarWebhookEntrante, marcarWebhookError } from '../repos/webhooks.js';
import { errorSeguro } from '../error-response.js';
import * as PagosRepo from '../repos/pagos.js';
import * as AuditRepo from '../repos/audit.js';
import { encolarConciliacionFinanciera } from '../repos/facturas.js';
// FIX (Etapa 6 offline — test que lo detectó): esta función vive en
// repos/pedidos.js (trae `generado_automatico`, ver su cabecera ahí), no
// en repos/pagos.js. Estaba escrita como `PagosRepo.obtenerPedidoParaPagoPublico`
// más abajo, que nunca existió en ese namespace — cualquier llamada real
// a crearPreferenciaPublicaHandler tiraba TypeError ("is not a function")
// en vez del 404 documentado. El guard de MP (Etapa 5, punto 2) nunca
// llegó a ejecutarse en producción por este bug.
import { obtenerPedidoParaPagoPublico } from '../repos/pedidos.js';
// FIX (QR del POS, verificado contra la doc oficial de MP): la API de
// Stores rechaza latitude/longitude en (0,0) con
// "Store coordinates (latitude 0 and longitude 0) are invalid" — (0,0) cae
// en medio del Atlántico. El formulario de mercadopago-config.html no pide
// coordenadas, así que se geocodifica la dirección server-side reusando el
// mismo motor que ya usa Clientes ("Geocodificar pendientes").
import { geocodificarDireccion } from '../geocoding.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

// ── Corte por plan trial (hallazgo auditoría plan trial vs. recursos
// pagos, 2026-09) — ver CHANGELOG y cabecera de tests/handlers/
// pagos-tope-plan.test.js. MercadoPago no tenía NINGÚN corte por plan: el
// único bloqueo existente (esEmpresaDemo, arriba) protege la cuenta demo
// pública, no el plan contratado por una empresa real. `nombreTierVisible`
// replica a mano el `nombre_visible` de `planes_limites` (no vale la pena
// una consulta extra solo para el texto del error).
function nombreTierVisible(tier) {
  const NOMBRES = { trial: 'Trial', basico: 'Básico', pro: 'Pro', enterprise: 'Enterprise' };
  return NOMBRES[tier] || tier || 'actual';
}

// Variante JSON — usada en los endpoints autenticados que responden con
// res.json (config, oauth-iniciar, pos-qr-setup, y en profundidad en
// _generarPreferenciaPago). Devuelve `true` si ya respondió (cortar acá),
// `false` si el plan permite seguir.
async function bloqueadoPorPlanMercadoPago(res, empresa_id) {
  try {
    await exigirLimitePlan(supabase, empresa_id, 'mercadopago');
    return false;
  } catch (err) {
    if (err instanceof LimitePlanError) {
      res.status(403).json({
        error: `MercadoPago no está disponible en el plan ${nombreTierVisible(err.info?.tier)}. Actualizá tu plan para conectar y cobrar con Mercado Pago.`,
        detalle: err.info,
      });
      return true;
    }
    throw err;
  }
}

// ── Resiliencia: Circuit Breaker + Retry para llamadas a MercadoPago ───────
// Un único breaker por servicio externo (patrón canónico de auth.js).
// fetchMP() lanza un Error con .status si la respuesta no es 2xx,
// para que defaultEsReintentable() de retry.js clasifique correctamente
// (5xx/red → reintentar; 4xx → no reintentar).
const mpBreaker = new CircuitBreaker({
  name:              'mercado-pago',
  umbralFallas:      5,
  tiempoRecuperacion: 30_000,
  timeoutMs:         8_000,
});

async function fetchMP(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const err  = new Error(`MercadoPago ${response.status}: ${JSON.stringify(body)}`);
    err.status       = response.status;
    err.responseBody = body;
    throw err;
  }
  // FIX (QR — crear orden en POS devuelve 204 sin body): response.json()
  // explota con "Unexpected end of JSON input" sobre un body vacío. El
  // resto de los endpoints de MP que usa este módulo sí devuelven JSON,
  // así que se preserva ese comportamiento y solo se especializa el caso
  // sin contenido.
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ── Prisma (Paystore terminals) ────────────────────────────────────────────
// Un único breaker propio — no comparte el de MP, son proveedores externos
// distintos y no queremos que fallas de uno abra el breaker del otro.
const prismaBreaker = new CircuitBreaker({
  name:               'prisma-paystore',
  umbralFallas:       5,
  tiempoRecuperacion: 30_000,
  timeoutMs:          8_000,
});

// NOTA: la Terminal Payments API de Prisma/Paystore responde errores como
// un array ([{code, message}]), a diferencia del objeto plano de MP —
// fetchMP() asume objeto, por eso este helper es una copia adaptada y no
// una reutilización directa. Base URL confirmada contra el portal de
// desarrolladores de Prisma (portal.developers.prismamediosdepago.com,
// catálogo "paystore_terminals_payments_v1"):
//   sandbox: https://api-sandbox.prismamediosdepago.com/v1/paystore_terminals/terminal_payments
// Falta confirmar el host de producción (debería ser el mismo sin
// "-sandbox", a validar en el catálogo antes de ir a producción).
function _prismaBaseUrl() {
  const base = process.env.PRISMA_API_URL
    || 'https://api-sandbox.prismamediosdepago.com/v1/paystore_terminals/terminal_payments';
  return base.replace(/\/$/, '');
}

async function fetchPrisma(path, options) {
  const response = await fetch(`${_prismaBaseUrl()}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ([]));
    const msg  = Array.isArray(body) ? (body[0]?.message || JSON.stringify(body)) : JSON.stringify(body);
    const err  = new Error(`Prisma ${response.status}: ${msg}`);
    err.status       = response.status;
    err.responseBody = body;
    throw err;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// "Facilitator Identifier (subnet) in PayStore" — confirmado en el portal
// de desarrolladores (GET /payments/{payment_id}): 1 = Sandbox,
// 9 = Homologation, 2 = Production. Configurable por env porque cambia
// según el ambiente; default 1 porque _prismaBaseUrl() también apunta a
// sandbox por default.
function _prismaSubnetAcquirerId() {
  return process.env.PRISMA_SUBNET_ACQUIRER_ID || '1';
}

// La API de Prisma espera el CUIT/CUIL con guiones (ej. "30-12345678-9",
// confirmado en el portal — aparece así en query params y en el body de
// ejemplo). Se normaliza siempre a ese formato canónico a partir de los 11
// dígitos, sin importar cómo lo haya tipeado el admin en el formulario.
function _formatCuit(cuitDigits) {
  return `${cuitDigits.slice(0, 2)}-${cuitDigits.slice(2, 10)}-${cuitDigits.slice(10)}`;
}

// crear preferencia: 30 req/min (usuario autenticado, costo de negocio moderado)
const limiterPreferencia = rateLimit({ max: 30, windowMs: 60_000 });
// webhook: 120 req/min (alta frecuencia esperada desde MP, pero limitada para evitar abusos)
const limiterWebhook = rateLimit({ max: 120, windowMs: 60_000 });
// verificar pago GET: 60 req/min
const limiterVerificar = rateLimit({ max: 60, windowMs: 60_000 });
// configurar integración MP (alta/edición manual de credenciales): 10 req/min
const limiterConfig = rateLimit({ max: 10, windowMs: 60_000 });
// cobro QR desde la caja (cargar monto / verificar estado): 60 req/min —
// verificar es polling desde pos-terminal.js mientras el cliente escanea.
const limiterQr = rateLimit({ max: 60, windowMs: 60_000 });
// Terminal Prisma: cobrar/verificar/cancelar tienen el mismo perfil de uso
// que pos-qr-cobrar/verificar (caja, polling cada 3s mientras se espera la
// terminal) — se reusa limiterQr en vez de crear un limiter idéntico.
// prisma-config (alta/edición de credenciales) reusa limiterConfig, mismo
// criterio que _svc=config de Mercado Pago.

// ── Crear Preferencia de Pago (Checkout) ───────────────────────────────────
export default async function handler(req, res) {
  // Configuración manual de credenciales de Mercado Pago por empresa
  // (el admin pega su Access Token desde su propia cuenta de MP — sin OAuth).
  if (req.query._svc === 'config') {
    if (await limiterConfig(req, res)) return;
    if (req.method === 'PUT')    return await guardarConfigMP(req, res);
    if (req.method === 'GET')    return await obtenerConfigMP(req, res);
    if (req.method === 'DELETE') return await desactivarConfigMP(req, res);
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // ── Conexión de Mercado Pago vía OAuth ("Conectar con Mercado Pago") ───
  if (req.query._svc === 'oauth-iniciar') {
    if (await limiterConfig(req, res)) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
    return await mpOauthIniciarHandler(req, res);
  }
  if (req.query._svc === 'oauth-callback') {
    // Sin limiterConfig: lo pega MP directo en el browser del admin, no un
    // fetch autenticado — el rate limit real acá es el `state` de un solo
    // uso lógico (vence a los 10 min) más el propio rate limit de MP.
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
    return await mpOauthCallbackHandler(req, res);
  }

  // Etapa 5 offline — link de pago público (checkout.html, sin login).
  // Ver nota grande en crearPreferenciaPublicaHandler más abajo.
  if (req.query._svc === 'publico') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterPreferenciaPublica(req, res)) return;
    return await crearPreferenciaPublicaHandler(req, res);
  }

  // ── Cobro presencial con QR (POS) ─────────────────────────────────────
  // Reusa la misma cuenta/access_token que ya conectó el admin en
  // _svc=config (Checkout Pro/Point). Ver bloque grande de comentarios
  // más abajo, antes de posQrSetupHandler.
  if (req.query._svc === 'pos-qr-setup') {
    if (await limiterConfig(req, res)) return;
    if (req.method === 'GET')  return await posQrEstadoSetup(req, res);
    if (req.method === 'POST') return await posQrSetupHandler(req, res);
    return res.status(405).json({ error: 'Método no permitido' });
  }
  if (req.query._svc === 'pos-qr-cobrar') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterQr(req, res)) return;
    return await posQrCobrarHandler(req, res);
  }
  if (req.query._svc === 'pos-qr-verificar') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterQr(req, res)) return;
    return await posQrVerificarHandler(req, res);
  }

  // ── Terminal de pago MERCADO PAGO POINT (backend-mediado) ─────────────
  // Migración a backend-mediado: el access_token nunca viaja al frontend,
  // reusa la misma integración MP que QR (ver comentario grande antes de
  // mpPointCobrarHandler, más abajo). No hay _svc=mp-point-config: se
  // conecta la cuenta de MP como siempre (Checkout Pro / QR), acá solo se
  // agrega el device_id (no sensible) desde Admin → Hardware.
  if (req.query._svc === 'mp-point-cobrar') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterQr(req, res)) return;
    return await mpPointCobrarHandler(req, res);
  }
  if (req.query._svc === 'mp-point-verificar') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterQr(req, res)) return;
    return await mpPointVerificarHandler(req, res);
  }
  if (req.query._svc === 'mp-point-cancelar') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterQr(req, res)) return;
    return await mpPointCancelarHandler(req, res);
  }

  // ── Terminal de pago Prisma (Paystore terminals, cobro con tarjeta) ───
  // Reemplaza al driver "Lapos" del POS (WebSocket local inventado, sin
  // agente real del otro lado — ver frontend/admin/js/pos-terminal.js).
  // Misma cuenta/token por empresa, guardado en integraciones_pago con
  // proveedor='prisma' (migración 481). Ver bloque grande de comentarios
  // antes de guardarConfigPrisma, más abajo.
  if (req.query._svc === 'prisma-config') {
    if (await limiterConfig(req, res)) return;
    if (req.method === 'GET')    return await obtenerConfigPrisma(req, res);
    if (req.method === 'PUT')    return await guardarConfigPrisma(req, res);
    if (req.method === 'DELETE') return await desactivarConfigPrisma(req, res);
    return res.status(405).json({ error: 'Método no permitido' });
  }
  if (req.query._svc === 'prisma-cobrar') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterQr(req, res)) return;
    return await prismaCobrarHandler(req, res);
  }
  if (req.query._svc === 'prisma-verificar') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterQr(req, res)) return;
    return await prismaVerificarHandler(req, res);
  }
  if (req.query._svc === 'prisma-cancelar') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterQr(req, res)) return;
    return await prismaCancelarHandler(req, res);
  }

  if (req.method === 'POST') {
    // Distinguir entre creación de preferencia y webhook
    const isWebhook = req.query.tipo === 'webhook' || req.headers['x-signature'];
    if (isWebhook) {
      if (await limiterWebhook(req, res)) return;
      return await manejarWebhook(req, res);
    }
    if (await limiterPreferencia(req, res)) return;
    return await crearPreferencia(req, res);
  } else if (req.method === 'GET') {
    if (await limiterVerificar(req, res)) return;
    return await verificarPago(req, res);
  }
  res.status(405).json({ error: 'Método no permitido' });
}

async function crearPreferencia(req, res) {
  try {
    const { pedido_id } = req.body || {};

    if (!pedido_id) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // 0. Autenticar al usuario. Nunca confiar en cliente_id/empresa_id/
    //    monto/items que vengan del body: se recalculan todos desde la
    //    BD a partir del pedido_id + el token.
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
    if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

    const perfilUsuario = await PagosRepo.obtenerPerfilUsuarioPago(user.id);

    if (!perfilUsuario) return res.status(401).json({ error: 'Usuario no encontrado' });

    // 1. Traer el pedido real desde la BD — el monto y los items se
    //    calculan exclusivamente a partir de esto, jamás del body.
    const { data: pedido, error: errorPedido } = await PagosRepo.obtenerPedidoParaPago(pedido_id);

    if (errorPedido || !pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // 2. Verificar que el pedido le pertenece al cliente autenticado
    //    (o que el usuario es admin/dueno/vendedor de la misma empresa).
    const ROLES_INTERNOS = ['dueno', 'admin', 'vendedor'];
    const esPropietario = perfilUsuario.cliente_id && perfilUsuario.cliente_id === pedido.cliente_id;
    const esInterno      = ROLES_INTERNOS.includes(perfilUsuario.rol) && perfilUsuario.empresa_id === pedido.empresa_id;

    if (!esPropietario && !esInterno) {
      return res.status(403).json({ error: 'No autorizado para pagar este pedido' });
    }

    return await _generarPreferenciaPago(res, pedido, {
      backUrls: _backUrlsAutenticado(pedido_id),
    });

  } catch (error) {
    console.error('Error en crearPreferencia:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// ── Público (sin login) — link de pago desde el checkout de WhatsApp ──────
// Etapa 5 offline, Mercado Pago: el botón "Pagar online" de
// /cliente/pedidos.html requiere sesión — no sirve para el link público que
// manda el bot de WhatsApp (frontend/cliente/checkout.html, pedido en
// estado 'sugerido'/'pendiente', sin login, mismo patrón ya usado por
// confirmar-sugerido/ver-sugerido en lib/handlers/pedidos.js).
//
// TRUST MODEL: sin Authorization, la única prueba de "esto es tuyo" es
// conocer el pedido_id (UUID no adivinable, que solo viaja por el link de
// WhatsApp) — igual que ya usa confirmar_pedido_sugerido() para una acción
// más sensible (confirmar el pedido en sí). Lo que este endpoint agrega
// ENCIMA de ese modelo, para no volverse un "pagá cualquier pedido si
// sabés el UUID" genérico: exige que el pedido haya salido del piloto de
// WhatsApp de verdad — `generado_automatico=true`, que lo pone
// exclusivamente generar_pedido_sugerido_cliente() al crearlo. No existe
// una columna `origen`; un pedido cargado a mano en el admin nunca la
// setea, así que nunca puede pagarse por esta ruta aunque alguien tuviera
// su id. Guard compartido en PagosRepo.esPedidoPilotoWhatsApp
// (repos/pagos.js), reusado también por verPedidoSugeridoHandler en
// lib/handlers/pedidos.js.
const limiterPreferenciaPublica = rateLimit({ max: 10, windowMs: 60_000 });

async function crearPreferenciaPublicaHandler(req, res) {
  try {
    const { pedido_id } = req.body || {};
    if (!pedido_id) return res.status(400).json({ error: 'Datos incompletos' });

    const { data: pedido, error: errorPedido } = await obtenerPedidoParaPagoPublico(pedido_id);

    if (errorPedido || !pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    if (!PagosRepo.esPedidoPilotoWhatsApp(pedido)) {
      // Mismo status/mensaje que "no encontrado" — no hay motivo para
      // confirmarle a quien prueba UUIDs al azar que el pedido SÍ existe
      // pero no califica.
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    return await _generarPreferenciaPago(res, pedido, {
      backUrls: _backUrlsPublico(pedido_id),
    });

  } catch (error) {
    console.error('Error en crearPreferenciaPublicaHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// URLs de retorno según de dónde vino el pago: el flujo autenticado vuelve
// a "Mis pedidos" (ya tenía sesión); el público vuelve al mismo checkout.html
// sin login — ver manejo de ?pago= en ambos archivos.
function _backUrlsAutenticado(pedido_id) {
  const _base = process.env.FRONTEND_URL || process.env.APP_URL || `https://${process.env.VERCEL_URL}`;
  return {
    success: `${_base}/cliente/pedidos.html?pago=exitoso&pedido=${pedido_id}`,
    failure: `${_base}/cliente/pedidos.html?pago=fallido&pedido=${pedido_id}`,
    pending: `${_base}/cliente/pedidos.html?pago=pendiente&pedido=${pedido_id}`,
  };
}

function _backUrlsPublico(pedido_id) {
  const _base = process.env.FRONTEND_URL || process.env.APP_URL || `https://${process.env.VERCEL_URL}`;
  return {
    success: `${_base}/cliente/checkout.html?pedido=${pedido_id}&pago=exitoso`,
    failure: `${_base}/cliente/checkout.html?pedido=${pedido_id}&pago=fallido`,
    pending: `${_base}/cliente/checkout.html?pedido=${pedido_id}&pago=pendiente`,
  };
}

// ── Core compartido: dado un pedido YA resuelto y YA autorizado (por el
// caller — auth+ownership en crearPreferencia, esPedidoPilotoWhatsApp() en
// crearPreferenciaPublicaHandler), arma y crea la preferencia en Mercado
// Pago. Extraído de lo que antes era la segunda mitad de crearPreferencia
// para no duplicar la llamada a la API de MP (circuit breaker, retry,
// idempotencia por transacción pendiente) entre los dos call sites.
async function _generarPreferenciaPago(res, pedido, { backUrls }) {
  if (!['confirmado', 'pendiente', 'preparando'].includes(pedido.estado)) {
    return res.status(400).json({ error: 'El pedido no está en un estado pagable' });
  }

  const empresa_id = pedido.empresa_id;
  const cliente_id = pedido.cliente_id;
  const monto      = Number(pedido.total);
  const pedido_id  = pedido.id;

  if (!monto || monto <= 0) {
    return res.status(400).json({ error: 'El pedido no tiene un monto válido' });
  }

  // Defensa en profundidad: este es el punto real donde se dispara el
  // cobro, más allá de por dónde haya entrado la request (crearPreferencia
  // autenticado o crearPreferenciaPublicaHandler). Corta acá también para
  // que ni una integración de MP ya conectada de antes de bajar de plan
  // pueda seguir cobrando en trial.
  if (await bloqueadoPorPlanMercadoPago(res, empresa_id)) return;

  // FIX (auditoría etapa 5): idempotencia. Si ya existe una transacción
  // pendiente para este pedido con un checkout_url vigente, se reusa en
  // vez de crear una preferencia nueva en Mercado Pago cada vez que el
  // cliente reintenta el pago (doble click, refresh, etc.).
  const txPendiente = await PagosRepo.obtenerTransaccionPendientePorPedido(pedido_id);

  if (txPendiente?.respuesta_json?.init_point) {
    return res.status(200).json({
      success: true,
      checkout_url: txPendiente.respuesta_json.init_point,
      preference_id: txPendiente.referencia_externa,
      reutilizada: true
    });
  }

  // 3. Items reales del pedido (no los que mande el cliente)
  const itemsPedido = await PagosRepo.obtenerItemsPedido(pedido_id);

  // 4. Obtener credenciales de Mercado Pago
  const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionMPActiva(empresa_id);

  if (errorIntegracion || !integracion) {
    return res.status(400).json({ error: 'Mercado Pago no configurado para esta empresa' });
  }

  // 5. Construir items para Mercado Pago a partir de los datos reales
  const itemsMercadoPago = (itemsPedido || []).map(item => ({
    title: item.productos?.nombre || 'Producto',
    quantity: Number(item.cantidad),
    unit_price: Number(item.precio_unitario),
    currency_id: 'ARS'
  }));

  const preference = {
    items: itemsMercadoPago,
    payer: {
      // FIX (auditoría etapa 5 — Hallazgo 2): antes se mandaba un email
      // placeholder fijo para todos los pagos, lo que rompía la
      // identificación del pagador y la entrega de comprobantes en el
      // dashboard de Mercado Pago. Ahora se usa el email real del
      // cliente; si no lo tiene cargado, se omite el campo en vez de
      // mandar un dato falso (MP acepta preferencias sin payer.email).
      ...(pedido.clientes?.email ? { email: pedido.clientes.email } : {})
    },
    back_urls: backUrls,
    notification_url: `${process.env.API_URL || process.env.APP_URL || `https://${process.env.VERCEL_URL}`}/api/pagos/mercado-pago`,
    external_reference: pedido_id,
    metadata: {
      pedido_id,
      cliente_id,
      empresa_id
    }
  };

  let preferenceData;
  const accessTokenMP = await obtenerAccessTokenMPValido(integracion);
  try {
    preferenceData = await mpBreaker.exec(() =>
      withRetry(() => fetchMP('https://api.mercadopago.com/checkout/preferences', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessTokenMP}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(preference),
      }))
    );
  } catch (err) {
    if (err.name === 'CircuitBreakerOpenError') {
      return errorSeguro(res, err, 503, 'No se pudo completar la operación.', { retryAfter: err.retryAfterSeconds });
    }
    console.error('Error Mercado Pago (preferencia):', err.responseBody ?? err.message);
    const status = err.status >= 400 && err.status < 500 ? 400 : 502;
    return res.status(status).json({ error: 'Error al crear preferencia de pago' });
  }

  // 4. Registrar transacción en la BD
  const { error: errorTx } = await PagosRepo.crearTransaccionPago({
    empresa_id,
    cliente_id,
    pedido_id,
    monto,
    proveedor: 'mercado_pago',
    referencia_externa: preferenceData.id,
    estado: 'pendiente',
    respuesta_json: preferenceData
  });

  if (errorTx) {
    console.error('Error al registrar transacción:', errorTx);
    return res.status(500).json({ error: 'Error al registrar pago' });
  }

  // 5. Retornar URL de checkout
  return res.status(200).json({
    success: true,
    checkout_url: preferenceData.init_point,
    preference_id: preferenceData.id
  });
}

// ── Configuración manual de credenciales de Mercado Pago (sin OAuth) ──────
//
// El admin de cada empresa cliente crea su propia cuenta/app en Mercado
// Pago, copia su Access Token (y opcionalmente la Public Key) desde
// https://www.mercadopago.com.ar/developers/panel/app y lo pega en el
// panel de distrib. Nunca se loguea acá en texto plano ni se devuelve
// al frontend: se cifra con ARCA_SECRETS_KEY (mismo mecanismo que los
// certificados ARCA, vía lib/crypto-secrets.js) antes de guardarse en
// integraciones_pago.access_token.

const PROVEEDOR_MP     = 'mercado_pago';
const PROVEEDOR_PRISMA = 'prisma';

// Helper: autentica al usuario por Supabase Auth y exige rol dueno/admin
// de la empresa. Mismo patrón que lib/handlers/empresa.js.
async function autenticarAdmin(req, res) {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) {
    res.status(401).json({ error: 'Token inválido' });
    return null;
  }

  const { data: perfil, error: perfilError } = await PagosRepo.obtenerPerfilAdminPago(user.id);

  if (perfilError || !perfil) {
    res.status(403).json({ error: 'Perfil no encontrado' });
    return null;
  }

  if (!['dueno', 'admin'].includes(perfil.rol)) {
    res.status(403).json({ error: 'Sin permisos: se requiere rol dueño o admin' });
    return null;
  }

  return perfil;
}

// PUT /api/pagos?_svc=config
// body: { access_token: string, public_key?: string }
async function guardarConfigMP(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return; // autenticarAdmin ya respondió el error

    // ── Corte de modo demo — mismo patrón que ARCA/WhatsApp/email ─────────
    // La cuenta demo pública es compartida y se resetea periódicamente:
    // nadie debería poder pegar ahí un Access Token REAL de Mercado Pago
    // (quedaría guardado, cifrado pero vivo, hasta el próximo reset).
    if (await esEmpresaDemo(perfil.empresa_id)) {
      return res.status(403).json({
        error: 'La configuración de Mercado Pago está deshabilitada en la cuenta demo pública.',
      });
    }
    if (await bloqueadoPorPlanMercadoPago(res, perfil.empresa_id)) return;

    const { access_token, public_key } = req.body || {};

    if (!access_token || typeof access_token !== 'string') {
      return res.status(400).json({ error: 'Falta access_token' });
    }

    // Validación mínima de formato: los Access Token de producción de MP
    // empiezan con "APP_USR-"; los de test empiezan con "TEST-".
    const tokenLimpio = access_token.trim();
    const esFormatoValido = /^(APP_USR|TEST)-/.test(tokenLimpio);
    if (!esFormatoValido) {
      return res.status(400).json({
        error: 'El Access Token no tiene el formato esperado de Mercado Pago (debe empezar con "APP_USR-" o "TEST-"). Copialo desde tu panel de desarrolladores de MP.'
      });
    }

    // Verificar que el token funciona realmente contra la API de MP antes
    // de guardarlo — evita guardar un token typeado mal o ya revocado.
    let cuentaMP;
    try {
      cuentaMP = await withRetry(() => fetchMP('https://api.mercadopago.com/users/me', {
        headers: { 'Authorization': `Bearer ${tokenLimpio}` },
      }));
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        return res.status(400).json({ error: 'Mercado Pago rechazó el Access Token: es inválido o fue revocado.' });
      }
      console.error('[guardarConfigMP] Error validando token contra MP:', err.message);
      return res.status(502).json({ error: 'No se pudo validar el token con Mercado Pago. Intentá de nuevo en un momento.' });
    }

    const accessTokenCifrado = cifrar(tokenLimpio);
    const publicKeyLimpia    = typeof public_key === 'string' && public_key.trim() ? public_key.trim() : null;

    // FIX MERCADOPAGO-AUDIT-01: mp_user_id (el "user_id" que MP manda en
    // cada webhook) antes solo se guardaba al configurar el QR del POS
    // (posQrSetupHandler) — una empresa que solo conectaba Checkout Pro
    // (este flujo) quedaba sin forma de resolverse desde el webhook. Se
    // guarda acá también, con el mismo dato que ya trae la respuesta de
    // /users/me usada arriba para validar el token — sin llamada extra.
    const { error: upsertError } = await PagosRepo.upsertIntegracionMP({
      empresa_id:   perfil.empresa_id,
      proveedor:    PROVEEDOR_MP,
      access_token: accessTokenCifrado,
      public_key:   publicKeyLimpia,
      mp_user_id:   cuentaMP?.id != null ? String(cuentaMP.id) : null,
      activa:       true,
      updated_at:   new Date().toISOString(),
    });

    if (upsertError) {
      console.error('[guardarConfigMP] Error guardando integración:', upsertError.message);
      return res.status(500).json({ error: 'No se pudo guardar la configuración' });
    }

    // Auditoría: jamás el access_token (ni cifrado) — solo metadata no
    // sensible, igual criterio que la propia respuesta al frontend.
    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'integraciones_pago', 'UPDATE', perfil.empresa_id, null,
      { proveedor: PROVEEDOR_MP, activa: true, mp_nickname: cuentaMP?.nickname ?? null, mp_site_id: cuentaMP?.site_id ?? null }
    );

    return res.status(200).json({
      ok: true,
      mensaje: 'Cuenta de Mercado Pago conectada correctamente.',
      cuenta: {
        nickname: cuentaMP?.nickname ?? null,
        email:    cuentaMP?.email ?? null,
        site_id:  cuentaMP?.site_id ?? null,
      }
    });

  } catch (error) {
    console.error('Error en guardarConfigMP:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// ── Conexión de Mercado Pago vía OAuth ("Conectar con Mercado Pago") ──────
//
// Alternativa a guardarConfigMP (pegar el Access Token a mano): el admin
// hace click en un botón, MP le pide autorizar la app en su propia cuenta,
// y volvemos con un `code` que canjeamos server-to-server por un
// access_token + refresh_token. Ver 497_mp_oauth_columnas.sql.
//
// Requiere una única app en el panel de desarrolladores de MP, creada por
// quien administre la cuenta de Mercado Pago de MF Web Solutions (no por
// cada empresa cliente) — MP_OAUTH_CLIENT_ID / MP_OAUTH_CLIENT_SECRET.
//
// El `state` viaja firmado (HMAC, mismo criterio que verificarFirmaMP más
// abajo) en vez de ir en un cookie de sesión: mpOauthCallbackHandler lo
// recibe en un GET disparado por el browser tras la redirección de MP, sin
// ningún header Authorization — el `state` es la única forma de saber a
// qué empresa/usuario corresponde ese `code`.
const MP_OAUTH_STATE_TTL_MS = 10 * 60_000; // 10 minutos para completar el flujo en MP

function obtenerSecretEstadoOAuthMP() {
  // Sin secreto dedicado, se cae a SUPABASE_SERVICE_ROLE_KEY (ya es un
  // secreto real, presente en todo despliegue) antes que dejar el `state`
  // sin firmar. Se puede fijar MP_OAUTH_STATE_SECRET aparte si se prefiere
  // no reusar la service role key para esto.
  return process.env.MP_OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function firmarEstadoOAuthMP(payload) {
  const secret = obtenerSecretEstadoOAuthMP();
  const json = JSON.stringify(payload);
  const b64  = Buffer.from(json, 'utf8').toString('base64url');
  const firma = createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${firma}`;
}

function verificarEstadoOAuthMP(state) {
  if (typeof state !== 'string' || !state.includes('.')) return null;
  const [b64, firma] = state.split('.');
  const secret = obtenerSecretEstadoOAuthMP();
  const firmaEsperada = createHmac('sha256', secret).update(b64).digest('base64url');

  try {
    if (!timingSafeEqual(Buffer.from(firma), Buffer.from(firmaEsperada))) return null;
  } catch {
    return null; // longitudes distintas → timingSafeEqual tira, tratar como inválido
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload?.empresa_id || !payload?.exp || Date.now() > payload.exp) return null;
  return payload;
}

// Misma lógica de armado de URL que notification_url (fetchMP) más arriba:
// preferir API_URL/APP_URL explícitas, caer a VERCEL_URL en preview.
function baseUrlPublica() {
  return process.env.API_URL || process.env.APP_URL || `https://${process.env.VERCEL_URL}`;
}

function redirectUriOAuthMP() {
  return process.env.MP_OAUTH_REDIRECT_URI || `${baseUrlPublica()}/api/pagos/oauth-callback`;
}

// GET /api/pagos?_svc=oauth-iniciar
// Requiere sesión (Bearer) de dueño/admin — a diferencia del callback, este
// endpoint sí lo llama el frontend por fetch(), por eso puede exigir el
// header Authorization normal y devolver JSON en vez de redirigir.
async function mpOauthIniciarHandler(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return;

    if (await esEmpresaDemo(perfil.empresa_id)) {
      return res.status(403).json({
        error: 'La conexión de Mercado Pago está deshabilitada en la cuenta demo pública.',
      });
    }
    if (await bloqueadoPorPlanMercadoPago(res, perfil.empresa_id)) return;

    const clientId = process.env.MP_OAUTH_CLIENT_ID;
    if (!clientId) {
      console.error('[mpOauthIniciarHandler] MP_OAUTH_CLIENT_ID no configurado');
      return res.status(500).json({ error: 'La conexión con Mercado Pago no está disponible todavía. Usá "Pegar Access Token" mientras tanto.' });
    }

    const state = firmarEstadoOAuthMP({
      empresa_id: perfil.empresa_id,
      user_id:    perfil.id,
      nonce:      randomUUID(),
      exp:        Date.now() + MP_OAUTH_STATE_TTL_MS,
    });

    const authorizeUrl = new URL('https://auth.mercadopago.com/authorization');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('platform_id', 'mp');
    authorizeUrl.searchParams.set('redirect_uri', redirectUriOAuthMP());
    authorizeUrl.searchParams.set('state', state);

    return res.status(200).json({ ok: true, url: authorizeUrl.toString() });

  } catch (error) {
    console.error('Error en mpOauthIniciarHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo iniciar la conexión con Mercado Pago.');
  }
}

// GET /api/pagos?_svc=oauth-callback
// Lo pega MP directamente en el browser del admin tras autorizar (o
// cancelar) la conexión — sin sesión, sin Authorization header. Toda la
// autorización pasa por el `state` firmado. Siempre termina en un 302 de
// vuelta al panel (nunca un JSON — el usuario está viendo el browser, no
// haciendo un fetch), con ?oauth=ok u ?oauth=error&msg=... para que el
// frontend muestre el resultado.
async function mpOauthCallbackHandler(req, res) {
  const volverA = (query) => {
    const url = new URL('/frontend/admin/mercadopago-config.html', baseUrlPublica());
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return res.redirect(302, url.pathname + url.search);
  };

  try {
    const { code, state, error: errorMP } = req.query;

    if (errorMP) {
      // El admin canceló la autorización en MP, o MP rechazó el pedido.
      return volverA({ oauth: 'error', msg: 'Conexión cancelada en Mercado Pago.' });
    }

    const payload = verificarEstadoOAuthMP(state);
    if (!payload) {
      console.warn('[mpOauthCallbackHandler] state inválido o vencido');
      return volverA({ oauth: 'error', msg: 'El enlace de conexión venció o no es válido. Probá de nuevo el botón "Conectar con Mercado Pago".' });
    }

    if (!code) {
      return volverA({ oauth: 'error', msg: 'Mercado Pago no devolvió un código de autorización.' });
    }

    if (await esEmpresaDemo(payload.empresa_id)) {
      return volverA({ oauth: 'error', msg: 'La conexión de Mercado Pago está deshabilitada en la cuenta demo pública.' });
    }
    try {
      await exigirLimitePlan(supabase, payload.empresa_id, 'mercadopago');
    } catch (err) {
      if (err instanceof LimitePlanError) {
        return volverA({ oauth: 'error', msg: `MercadoPago no está disponible en el plan ${nombreTierVisible(err.info?.tier)}. Actualizá tu plan para conectar y cobrar con Mercado Pago.` });
      }
      throw err;
    }

    const clientId     = process.env.MP_OAUTH_CLIENT_ID;
    const clientSecret = process.env.MP_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error('[mpOauthCallbackHandler] MP_OAUTH_CLIENT_ID/MP_OAUTH_CLIENT_SECRET no configurados');
      return volverA({ oauth: 'error', msg: 'La conexión con Mercado Pago no está disponible todavía.' });
    }

    let tokenData;
    try {
      tokenData = await withRetry(() => fetchMP('https://api.mercadopago.com/oauth/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     clientId,
          client_secret: clientSecret,
          grant_type:    'authorization_code',
          code,
          redirect_uri:  redirectUriOAuthMP(),
        }),
      }));
    } catch (err) {
      console.error('[mpOauthCallbackHandler] Error canjeando code por token:', err.message);
      return volverA({ oauth: 'error', msg: 'Mercado Pago rechazó la conexión. Probá de nuevo.' });
    }

    const { access_token, refresh_token, expires_in, user_id, public_key } = tokenData || {};
    if (!access_token) {
      console.error('[mpOauthCallbackHandler] Respuesta de MP sin access_token:', tokenData);
      return volverA({ oauth: 'error', msg: 'Mercado Pago no devolvió credenciales válidas.' });
    }

    const tokenExpiresAt = new Date(Date.now() + (Number(expires_in) || 15_552_000) * 1000).toISOString();
    const nuevoMpUserId  = user_id != null ? String(user_id) : null;

    // FIX (v785): si la integración ya tenía pos_id/store_id guardados de
    // una conexión anterior (Access Token manual u OAuth previo) y la
    // cuenta de MP que se está conectando ahora es otra (mp_user_id
    // distinto), ese pos_id/store_id quedan huérfanos — pertenecen a una
    // cuenta de MP que ya no es la autenticada, y el cobro con QR falla con
    // "pos_not_found" (Store/POS son recursos por cuenta en MP, no
    // globales). Se detecta el cambio de cuenta ANTES del upsert y se
    // limpian esos 3 campos para forzar que Configuración → Pagos → QR
    // pida rehacer el setup contra la cuenta recién conectada, en vez de
    // quedar con un QR roto en silencio.
    const { data: integracionPrevia } = await PagosRepo.obtenerIntegracionMPParaQr(payload.empresa_id);
    const cambioDeCuentaMP = integracionPrevia?.pos_id
      && integracionPrevia?.mp_user_id
      && nuevoMpUserId
      && integracionPrevia.mp_user_id !== nuevoMpUserId;

    if (cambioDeCuentaMP) {
      console.warn(
        `[mpOauthCallbackHandler] Cambio de cuenta de MP detectado (empresa ${payload.empresa_id}): `
        + `mp_user_id ${integracionPrevia.mp_user_id} -> ${nuevoMpUserId}. `
        + `Se limpian pos_id/store_id/qr_image para forzar nuevo setup del QR.`
      );
    }

    const { error: upsertError } = await PagosRepo.upsertIntegracionMP({
      empresa_id:       payload.empresa_id,
      proveedor:        PROVEEDOR_MP,
      access_token:     cifrar(access_token),
      refresh_token:    cifrar(refresh_token),
      token_expires_at: tokenExpiresAt,
      conectado_via:    'oauth',
      public_key:       typeof public_key === 'string' && public_key ? public_key : null,
      mp_user_id:       nuevoMpUserId,
      activa:           true,
      updated_at:       new Date().toISOString(),
      ...(cambioDeCuentaMP ? { pos_id: null, store_id: null, qr_image: null } : {}),
    });

    if (upsertError) {
      console.error('[mpOauthCallbackHandler] Error guardando integración:', upsertError.message);
      return volverA({ oauth: 'error', msg: 'La conexión con Mercado Pago funcionó pero no se pudo guardar. Contactá soporte.' });
    }

    await AuditRepo.registrarAuditoriaSilenciosa(
      payload.empresa_id, payload.user_id, 'integraciones_pago', 'UPDATE', payload.empresa_id, null,
      { proveedor: PROVEEDOR_MP, activa: true, conectado_via: 'oauth', mp_user_id: user_id != null ? String(user_id) : null }
    );

    return volverA({ oauth: 'ok' });

  } catch (error) {
    console.error('Error en mpOauthCallbackHandler:', error);
    return volverA({ oauth: 'error', msg: 'No se pudo completar la conexión con Mercado Pago.' });
  }
}

// Margen de refresco: si al access_token OAuth le quedan menos de 5 minutos
// (o ya venció), se refresca ANTES de usarlo en vez de dejar que la llamada
// a MP falle con 401 y recién ahí reaccionar.
const MP_OAUTH_REFRESH_MARGEN_MS = 5 * 60_000;

/**
 * Punto único de lectura del access_token de MP para todas las llamadas a
 * la API (crear preferencia, QR del POS, polling, webhook). Reemplaza a
 * `descifrar(integracion.access_token)` directo: para conexiones OAuth
 * (`conectado_via === 'oauth'`), si el token está por vencer lo refresca
 * solo usando el refresh_token antes de devolverlo. Para conexiones
 * manuales (Access Token pegado a mano, sin expiración) se comporta
 * exactamente igual que antes.
 */
async function obtenerAccessTokenMPValido(integracion) {
  if (integracion.conectado_via !== 'oauth' || !integracion.token_expires_at) {
    return descifrar(integracion.access_token);
  }

  const vence = new Date(integracion.token_expires_at).getTime();
  if (Number.isFinite(vence) && vence - Date.now() > MP_OAUTH_REFRESH_MARGEN_MS) {
    return descifrar(integracion.access_token);
  }

  return await refrescarTokenOAuthMP(integracion);
}

async function refrescarTokenOAuthMP(integracion) {
  const clientId     = process.env.MP_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MP_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret || !integracion.refresh_token || !integracion.empresa_id) {
    // No hay forma de refrescar — se devuelve el token vigente tal cual;
    // si ya venció, la llamada downstream a MP va a fallar con 401 y el
    // caller lo maneja como cualquier otro error de MP.
    return descifrar(integracion.access_token);
  }

  try {
    const data = await withRetry(() => fetchMP('https://api.mercadopago.com/oauth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'refresh_token',
        refresh_token: descifrar(integracion.refresh_token),
      }),
    }));

    const nuevoAccessToken  = data?.access_token;
    if (!nuevoAccessToken) throw new Error('Respuesta de refresh_token sin access_token');

    const nuevoRefreshToken = data.refresh_token || descifrar(integracion.refresh_token);
    const tokenExpiresAt    = new Date(Date.now() + (Number(data.expires_in) || 15_552_000) * 1000).toISOString();

    await PagosRepo.actualizarTokensOAuthMP(integracion.empresa_id, {
      access_token:     cifrar(nuevoAccessToken),
      refresh_token:    cifrar(nuevoRefreshToken),
      token_expires_at: tokenExpiresAt,
    });

    return nuevoAccessToken;
  } catch (err) {
    console.error('[refrescarTokenOAuthMP] No se pudo refrescar, se usa el token vigente:', err.message);
    return descifrar(integracion.access_token);
  }
}

// GET /api/pagos?_svc=config
// Devuelve si hay integración activa y metadata no sensible. NUNCA devuelve
// el access_token, ni cifrado ni en texto plano.
async function obtenerConfigMP(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return;

    const { data: integracion, error } = await PagosRepo.obtenerConfigIntegracionMP(perfil.empresa_id, PROVEEDOR_MP);

    if (error) {
      console.error('[obtenerConfigMP] Error:', error.message);
      return res.status(500).json({ error: 'No se pudo consultar la configuración' });
    }

    if (!integracion) {
      return res.status(200).json({ conectado: false });
    }

    return res.status(200).json({
      conectado:     integracion.activa,
      conectado_via: integracion.conectado_via || 'manual',
      public_key:    integracion.public_key,
      created_at:    integracion.created_at,
      updated_at:    integracion.updated_at,
    });

  } catch (error) {
    console.error('Error en obtenerConfigMP:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// DELETE /api/pagos?_svc=config
// Desactiva la integración (no borra el registro, por trazabilidad).
async function desactivarConfigMP(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return;

    const { error } = await PagosRepo.desactivarIntegracionMP(perfil.empresa_id, PROVEEDOR_MP);

    if (error) {
      console.error('[desactivarConfigMP] Error:', error.message);
      return res.status(500).json({ error: 'No se pudo desactivar la configuración' });
    }

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'integraciones_pago', 'UPDATE', perfil.empresa_id,
      { proveedor: PROVEEDOR_MP, activa: true }, { proveedor: PROVEEDOR_MP, activa: false }
    );

    return res.status(200).json({ ok: true, mensaje: 'Cuenta de Mercado Pago desconectada.' });

  } catch (error) {
    console.error('Error en desactivarConfigMP:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// ── Cobro presencial con QR (POS) — Orders API de Mercado Pago ────────────
//
// MIGRACIÓN (v782, ver hallazgo documentado en CHANGELOGS_INTEGRACION):
// este flujo usaba la API "Órdenes presenciales v2" (Instore Orders V2,
// PUT /instore/qr/seller/collectors/.../orders), que MP marca como legacy
// y que nunca quedó cubierta por el programa de interoperabilidad de QR
// (por eso Modo/otras billeteras la rechazaban de plano). Se migra a la
// "Orders API" (POST /v1/orders), unificada y con soporte de
// interoperabilidad — verificado contra la guía oficial de migración:
// mercadopago.com/developers/en/docs/qr-code/migrate-instore-orders-v2-to-orders
//
// Cambios de fondo (no es un fix chico, toca creación/verificación/webhook):
//  - Create:   PUT .../stores/{id}/pos/{id}/orders  →  POST /v1/orders
//              (el POS ya no va en el path, va en config.qr.external_pos_id
//              del body; la Store no se manda, MP la resuelve por el POS).
//              Devuelve 201 con el objeto completo (antes 204 sin body) —
//              el `id` de la orden (formato "ORD...") hay que guardarlo,
//              es la clave para verificar/cancelar/reembolsar después.
//  - Verify:   antes se buscaba el pago por external_reference contra
//              /v1/payments/search. La doc es explícita: "the Payments API
//              must not be used in integrations with the Orders API" — así
//              que ahora se consulta GET /v1/orders/{order_id} y se lee su
//              `status` (created/processed/canceled/refunded/expired) en
//              vez de status de payments. Como pos-qr-verificar solo recibe
//              `referencia` desde el POS, el order_id que devuelve el
//              cobro se le pasa de vuelta al POS (ver pos-terminal.js) para
//              que lo reenvíe al verificar — evita agregar una tabla nueva
//              solo para cachear ese id.
//  - Headers:  X-Idempotency-Key pasa a ser obligatorio en creación (y en
//              cancelación/reembolso, no implementadas todavía acá).
//  - Webhook:  el modelo viejo notificaba por los topics `payments` y
//              `merchant_orders` (o por notification_url en el body, que ya
//              no existe en la Orders API). El nuevo modelo unifica todo en
//              un único topic `order` — hay que suscribirlo a mano en Your
//              integrations → Webhooks (reemplazando payments/merchant_
//              orders para esta app) antes de ir a producción.
//
// Nota aparte, aclarada por la misma doc de MP: aunque ya se migró a la API
// vigente, que Modo efectivamente lea el QR sigue dependiendo de que Modo
// esté dado de alta en el programa de interoperabilidad de MP — eso es
// responsabilidad de Modo, no de esta integración.
//
// Flujo (mismo access_token que Checkout Pro, cifrado en integraciones_pago
// vía _svc=config — no hay una segunda cuenta ni OAuth, ver comentario
// grande arriba de guardarConfigMP):
//
//  1. pos-qr-setup (una sola vez por empresa, rol dueno/admin): crea la
//     Store y el POS de esa cuenta de MP y guarda store_id/pos_id/
//     mp_user_id/qr_image en integraciones_pago. qr_image es la URL (https,
//     la sirve el propio Mercado Pago) a la imagen del QR FIJO de esa
//     caja — se imprime o se muestra en pantalla una sola vez. Esta parte
//     no cambia con la migración: Store/POS son un recurso aparte, no
//     forman parte de la Orders API.
//  2. pos-qr-cobrar (cada venta, rol dueno/admin/vendedor): crea una orden
//     (modo `static`, el mismo QR fijo ya impreso) con el monto de la
//     venta actual. El cliente escanea el QR ya impreso — no hay que
//     generar uno nuevo por venta — y ve el monto recién cargado en su app
//     de MP. Devuelve el `order_id` que hay que reenviar a verificar.
//  3. pos-qr-verificar (polling desde pos-terminal.js mientras el cajero
//     espera que el cliente pague): consulta GET /v1/orders/{order_id}.
//     El webhook (manejarWebhook, más abajo) también recibe la notificación
//     del topic `order` — el polling es solo para que la pantalla de caja
//     no quede esperando indefinidamente si la notificación se demora.
//
// Roles: el setup toca credenciales/config de la integración → dueno/admin
// (autenticarAdmin). Cobrar/verificar son operación de caja del día a día →
// mismos roles que ya pueden operar el POS (crearVenta en pos.js).
const ROLES_POS_QR = ['dueno', 'admin', 'vendedor'];

// external_id de Store/POS en MP: se derivan siempre del empresa_id, nunca
// se guardan en la BD — evita un desync entre lo guardado y lo real, y la
// orden QR (PUT) necesita el external_store_id (string), no el store_id
// numérico que devuelve MP al crear la store.
function _externalStoreId(empresa_id) { return `distrib-${empresa_id}`; }
// FIX (v777, verificado contra la doc oficial de "Crear caja"): el EXTERNAL_ID
// de la caja (a diferencia del external_id de la Store, que sí acepta guiones)
// debe ser "alfanumérico, solo letras y números, sin espacios, guiones o
// caracteres especiales" — MP lo rechaza con bad_request si tiene guiones.
// empresa_id es un UUID (con guiones), así que se le sacan los guiones acá en
// vez de tocar _externalStoreId (que ya matchea el external_id real de la
// Store creada en producción para las empresas que ya activaron el QR).
//
// FIX (v781, verificado contra la doc oficial de "Crear caja"): el EXTERNAL_ID
// de la caja también tiene un tope de longitud — "debe ser menor de 40
// caracteres" (a diferencia del external_id de la Store, que acepta hasta 60).
// Un UUID sin guiones ya son 32 caracteres; el prefijo `distribpos` (10
// caracteres) empujaba el total a 42, MP lo rechazaba con
// "external_id is too long". Se acorta el prefijo a `dpos` (36 en total).
// Cambiar este prefijo es seguro: por el bug de v777 (STORE_ID viajando como
// string) ninguna Caja llegó a crearse con éxito en producción todavía, así
// que no hay ningún external_id viejo que este cambio pueda desincronizar.
function _externalPosId(empresa_id)   { return `dpos${String(empresa_id).replace(/[^a-zA-Z0-9]/g, '')}`; }

// FIX (v779, verificado contra la doc de "Crear sucursal"): MP valida
// `location.state_name` contra su propio listado de provincias/jurisdicciones
// argentinas — si no calza exactamente (case-sensitive, sin tolerar
// "santa fe" en vez de "Santa Fe") lo rechaza con bad_request. Como el
// formulario no fuerza mayúsculas, se normaliza acá antes de mandarlo a MP
// en vez de confiar en que el usuario lo tipeó igual al listado de MP.
const PROVINCIAS_AR = [
  'Buenos Aires', 'CABA', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba',
  'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja',
  'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan',
  'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego', 'Tucumán',
];
function _sinAcentos(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function _capitalizarPalabras(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/(^|\s|-)([a-záéíóúñ])/g, (_, sep, c) => sep + c.toUpperCase());
}
// Matchea contra el listado real de MP ignorando mayúsculas/acentos ("santa
// fe" → "Santa Fe", "cordoba" → "Córdoba"). Si no matchea ninguna (typo raro,
// o texto libre de otra fuente), cae a Title Case como mejor esfuerzo.
function _normalizarProvinciaAR(p) {
  const limpio = _sinAcentos(p).trim().toLowerCase();
  const match  = PROVINCIAS_AR.find(x => _sinAcentos(x).toLowerCase() === limpio);
  return match || _capitalizarPalabras(p);
}

// FIX (v780): recuperación de "store huérfana" — si un intento anterior de
// pos-qr-setup creó la Store (o la Caja) del lado de MP pero se cayó antes
// de llegar a guardarStoreYPosQr (red, timeout, deploy a mitad de request),
// la BD queda sin store_id/pos_id pero MP ya tiene el recurso con el
// external_id estable de esta empresa. Sin esto, el reintento volvía a
// hacer POST y MP lo rechazaba (external_id duplicado), dejando al usuario
// sin forma de avanzar salvo tocar la BD a mano. Se busca primero por
// external_id y, si existe, se reusa en vez de recrear.
async function _buscarStorePorExternalId(mpUserId, accessTokenMP, externalId) {
  const resp = await withRetry(() => fetchMP(
    `https://api.mercadopago.com/users/${mpUserId}/stores/search?external_id=${encodeURIComponent(externalId)}`,
    { headers: { 'Authorization': `Bearer ${accessTokenMP}` } }
  ));
  // La doc de MP muestra la respuesta envuelta en un array de un elemento
  // ([{ paging, results }]); se soporta también el objeto pelado por si ese
  // detalle de formato cambia entre versiones del endpoint.
  const bloque = Array.isArray(resp) ? resp[0] : resp;
  return bloque?.results?.[0] || null;
}

async function _buscarPosPorExternalId(accessTokenMP, externalId) {
  const resp = await withRetry(() => fetchMP(
    `https://api.mercadopago.com/pos?external_id=${encodeURIComponent(externalId)}`,
    { headers: { 'Authorization': `Bearer ${accessTokenMP}` } }
  ));
  return resp?.results?.[0] || null;
}

async function autenticarInterno(req, res, roles = ROLES_POS_QR) {
  const token = (req.headers.authorization ?? req.headers.Authorization ?? '').toString().replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) {
    res.status(401).json({ error: 'Token inválido' });
    return null;
  }
  const perfil = await PagosRepo.obtenerPerfilUsuarioPago(user.id);
  if (!perfil) {
    res.status(403).json({ error: 'Perfil no encontrado' });
    return null;
  }
  if (!roles.includes(perfil.rol)) {
    res.status(403).json({ error: 'Sin permisos para esta operación' });
    return null;
  }
  return perfil;
}

// GET /api/pagos?_svc=pos-qr-setup — estado actual (sin exponer el token).
async function posQrEstadoSetup(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return;

    const { data: integracion, error } = await PagosRepo.obtenerIntegracionMPParaQr(perfil.empresa_id);
    if (error) {
      console.error('[posQrEstadoSetup] Error:', error.message);
      return res.status(500).json({ error: 'No se pudo consultar la configuración' });
    }
    if (!integracion) {
      return res.status(200).json({ cuenta_conectada: false, store_configurada: false, pos_configurado: false });
    }

    return res.status(200).json({
      cuenta_conectada:  true,
      store_configurada: Boolean(integracion.store_id),
      pos_configurado:   Boolean(integracion.pos_id),
      qr_image:          integracion.qr_image || null,
    });
  } catch (error) {
    console.error('Error en posQrEstadoSetup:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// POST /api/pagos?_svc=pos-qr-setup
// body: { nombre_sucursal, calle, numero, ciudad, provincia, latitud?, longitud? }
// Crea (si hace falta) la Store y el POS en Mercado Pago y guarda el QR fijo.
async function posQrSetupHandler(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return;

    if (await esEmpresaDemo(perfil.empresa_id)) {
      return res.status(403).json({
        error: 'El cobro con QR está deshabilitado en la cuenta demo pública.',
      });
    }
    if (await bloqueadoPorPlanMercadoPago(res, perfil.empresa_id)) return;

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionMPParaQr(perfil.empresa_id);
    if (errorIntegracion || !integracion) {
      return res.status(400).json({
        error: 'Primero conectá tu cuenta de Mercado Pago (Access Token) en Configuración → Pagos.',
      });
    }

    const { nombre_sucursal, calle, numero, ciudad, provincia, latitud, longitud } = req.body || {};
    if (!nombre_sucursal || !calle || !ciudad || !provincia) {
      return res.status(400).json({ error: 'Faltan datos de la sucursal (nombre, calle, ciudad, provincia).' });
    }

    const accessTokenMP = await obtenerAccessTokenMPValido(integracion);
    const datosAGuardar = {};

    // 1. mp_user_id — hace falta para todas las URLs de la Instore Orders API.
    let mpUserId = integracion.mp_user_id;
    if (!mpUserId) {
      let cuentaMP;
      try {
        cuentaMP = await withRetry(() => fetchMP('https://api.mercadopago.com/users/me', {
          headers: { 'Authorization': `Bearer ${accessTokenMP}` },
        }));
      } catch (err) {
        console.error('[posQrSetupHandler] Error obteniendo users/me:', err.message);
        return res.status(502).json({ error: 'No se pudo consultar la cuenta de Mercado Pago.' });
      }
      mpUserId = String(cuentaMP.id);
      datosAGuardar.mp_user_id = mpUserId;
    }

    // 2. Store — se crea una sola vez por empresa (external_id estable).
    let storeId = integracion.store_id;
    let storeReciénCreada = false; // usado más abajo para el reintento del paso 3 (índice de MP con lag)
    if (!storeId) {
      let storeExistente;
      try {
        storeExistente = await _buscarStorePorExternalId(mpUserId, accessTokenMP, _externalStoreId(perfil.empresa_id));
      } catch (err) {
        console.error('[posQrSetupHandler] Error buscando store existente:', err.responseBody ?? err.message);
        storeExistente = null; // si falla la búsqueda, seguimos al flujo normal de creación
      }

      if (storeExistente) {
        storeId = String(storeExistente.id);
        datosAGuardar.store_id = storeId;
      } else {
        // Coordenadas reales: si el caller no las manda (caso normal, el
        // formulario no las pide), se geocodifica la dirección. Mandar (0,0)
        // por default hacía que MP rechazara siempre la creación de la store.
        let lat = latitud  != null ? Number(latitud)  : null;
        let lng = longitud != null ? Number(longitud) : null;
        if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          let geo;
          try {
            geo = await geocodificarDireccion({
              domicilio: `${calle} ${numero || ''}`.trim(),
              localidad: ciudad,
              provincia,
            });
          } catch (err) {
            console.error('[posQrSetupHandler] Error geocodificando la dirección:', err.message);
            return res.status(400).json({ error: 'No se pudo ubicar esa dirección. Revisá calle/ciudad/provincia.' });
          }
          if (!geo) {
            return res.status(400).json({ error: 'No se pudo ubicar esa dirección. Revisá calle/ciudad/provincia.' });
          }
          lat = geo.lat;
          lng = geo.lng;
        }

        let store;
        try {
          store = await withRetry(() => fetchMP(`https://api.mercadopago.com/users/${mpUserId}/stores`, {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${accessTokenMP}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name:        nombre_sucursal,
              external_id: _externalStoreId(perfil.empresa_id),
              location: {
                street_number: numero || 'S/N',
                street_name:   _capitalizarPalabras(calle),
                city_name:     _capitalizarPalabras(ciudad),
                state_name:    _normalizarProvinciaAR(provincia),
                latitude:      lat,
                longitude:     lng,
              },
            }),
          }));
        } catch (err) {
          console.error('[posQrSetupHandler] Error creando store:', err.responseBody ?? err.message);
          // FIX (v779): antes siempre devolvía el mismo mensaje genérico sin
          // importar la causa real — quedaba imposible de diagnosticar desde
          // el panel sin mirar los logs de Vercel. Ahora, si MP devuelve un
          // `message` legible en el body del error, se lo suma al mensaje
          // (acotado a 140 caracteres, nunca se manda el body completo tal
          // cual por si trajera algo no apto para mostrar).
          const detalleMP = typeof err.responseBody?.message === 'string'
            ? err.responseBody.message.slice(0, 140)
            : null;
          return res.status(400).json({
            error: 'Mercado Pago rechazó los datos de la sucursal. Revisá dirección/ciudad/provincia.'
              + (detalleMP ? ` (${detalleMP})` : ''),
          });
        }
        storeId = String(store.id);
        datosAGuardar.store_id = storeId;
        storeReciénCreada = true;
      }
    }

    // 3. POS — la caja física/virtual dentro de esa store. Devuelve el QR fijo.
    let posId    = integracion.pos_id;
    let qrImage  = integracion.qr_image;
    if (!posId) {
      let posExistente;
      try {
        posExistente = await _buscarPosPorExternalId(accessTokenMP, _externalPosId(perfil.empresa_id));
      } catch (err) {
        console.error('[posQrSetupHandler] Error buscando caja existente:', err.responseBody ?? err.message);
        posExistente = null; // si falla la búsqueda, seguimos al flujo normal de creación
      }

      if (posExistente) {
        posId   = _externalPosId(perfil.empresa_id);
        qrImage = posExistente.qr?.image || null;
        datosAGuardar.pos_id   = posId;
        datosAGuardar.qr_image = qrImage;
      } else {
        let pos;
        // FIX (v786): cuando la Store se acaba de crear en este mismo
        // request, el índice de búsqueda interno de MP que valida
        // `external_store_id` en la creación del POS puede tardar unos
        // segundos en verla — MP responde 400
        // 'non_existent_external_store_id' ("External store id does not
        // refer any store") aunque la Store exista, porque withRetry() no
        // reintenta 4xx (son errores de validación, no transitorios). Acá
        // SÍ es transitorio: se reintenta esta llamada puntual 3 veces con
        // espera corta, solo para ese código de error puntual y solo justo
        // después de crear la Store — no afecta el resto de los 400 de MP,
        // que siguen sin reintentarse.
        const intentosPos = storeReciénCreada ? 3 : 1;
        for (let intento = 1; intento <= intentosPos; intento++) {
          try {
            pos = await withRetry(() => fetchMP('https://api.mercadopago.com/pos', {
              method:  'POST',
              headers: { 'Authorization': `Bearer ${accessTokenMP}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name:             `${nombre_sucursal} - Caja`,
                fixed_amount:     false,
                // FIX (v777, verificado contra la doc de "Crear caja"): STORE_ID
                // debe ser numérico. storeId es `String(store.id)` (línea de
                // arriba, así se guarda en integraciones_pago) — sin este cast
                // se mandaba como string JSON y MP lo rechazaba con bad_request.
                store_id:         Number(storeId),
                external_store_id: _externalStoreId(perfil.empresa_id),
                category:         621102,
                external_id:      _externalPosId(perfil.empresa_id),
              }),
            }));
            break;
          } catch (err) {
            const esIndexLag = err.responseBody?.error === 'non_existent_external_store_id';
            if (esIndexLag && intento < intentosPos) {
              console.warn(`[posQrSetupHandler] Store recién creada aún no indexada, reintento ${intento}/${intentosPos}...`);
              await new Promise((r) => setTimeout(r, 2500));
              continue;
            }
            console.error('[posQrSetupHandler] Error creando POS:', err.responseBody ?? err.message);
            const detalleMP = typeof err.responseBody?.message === 'string'
              ? err.responseBody.message.slice(0, 140)
              : null;
            return res.status(400).json({
              error: 'No se pudo crear la caja (POS) en Mercado Pago.' + (detalleMP ? ` (${detalleMP})` : ''),
            });
          }
        }
        posId   = _externalPosId(perfil.empresa_id);
        // FIX (verificado contra la doc de MP — "Crear caja"): pos.qr.image
        // es una URL https a la imagen PNG, no un string base64. Se guarda
        // tal cual — un <img src="..."> la usa directo, sin prefijo data:.
        qrImage = pos.qr?.image || null;
        datosAGuardar.pos_id   = posId;
        datosAGuardar.qr_image = qrImage;
      }
    }

    if (Object.keys(datosAGuardar).length > 0) {
      const { error: errorGuardar } = await PagosRepo.guardarStoreYPosQr(perfil.empresa_id, datosAGuardar);
      if (errorGuardar) {
        console.error('[posQrSetupHandler] Error guardando config QR:', errorGuardar.message);
        return res.status(500).json({ error: 'No se pudo guardar la configuración del QR.' });
      }
    }

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'integraciones_pago', 'UPDATE', perfil.empresa_id, null,
      { qr_configurado: true }
    );

    return res.status(200).json({ ok: true, store_id: storeId, pos_id: posId, qr_image: qrImage });
  } catch (error) {
    console.error('Error en posQrSetupHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// Mapeo de status de la Orders API a los estados que ya consume el POS
// (ver tabla "Map status values" de la guía de migración). `processed` es
// el único que corresponde a pago aprobado; `created` es el estado inicial
// (todavía sin pago) — no existe más el limbo "opened" del modelo viejo.
function _estadoOrdenMP(status) {
  if (status === 'processed') return 'aprobado';
  if (status === 'canceled')  return 'cancelado';
  if (status === 'refunded')  return 'reembolsado';
  if (status === 'expired')   return 'expirado';
  return 'pendiente'; // created
}

// Consulta GET /v1/orders/{order_id} y mapea la respuesta al shape que ya
// consumían pos-qr-verificar y el frontend. Extraído para reusarlo también
// desde el webhook (migración 498) sin duplicar el mapeo de status/payment.
async function _consultarOrdenQr(accessTokenMP, order_id) {
  const orden = await withRetry(() => fetchMP(
    `https://api.mercadopago.com/v1/orders/${encodeURIComponent(order_id)}`,
    { headers: { 'Authorization': `Bearer ${accessTokenMP}` } }
  ));
  const pagoOrden = orden?.transactions?.payments?.[0];
  return {
    pagado:      orden?.status === 'processed',
    estado:      _estadoOrdenMP(orden?.status),
    order_id:    orden?.id || order_id,
    payment_id:  pagoOrden?.id || null,
    metodo_pago: pagoOrden?.payment_method?.type || pagoOrden?.payment_method?.id || null,
  };
}

// POST /api/pagos?_svc=pos-qr-cobrar
// body: { monto, referencia, descripcion? } — referencia es un id propio
// (ej. el id de la venta/turno en curso), se manda como external_reference
// de la orden. Devuelve order_id: el POS debe reenviarlo a
// pos-qr-verificar (la Orders API ya no expone un buscador por
// external_reference — ver comentario grande más arriba).
async function posQrCobrarHandler(req, res) {
  try {
    const perfil = await autenticarInterno(req, res);
    if (!perfil) return;

    const { monto, referencia, descripcion } = req.body || {};
    const montoNum = Number(monto);
    if (!montoNum || montoNum <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    // Mercado Pago rechaza (property_value, "Amount must be greater than
    // or equal to 15.00") cualquier orden QR por menos de $15 — no es
    // configurable por integración. Se valida acá antes de llamar a MP
    // para no tirar el 502 genérico y decirle al cajero exactamente por
    // qué no puede cobrar así (hallazgo real via correlation_id a854d7b8,
    // ver CHANGELOG_v789).
    if (montoNum < 15) {
      return res.status(400).json({ error: 'Mercado Pago no permite cobrar con QR montos menores a $15. Usá otro medio de pago para esta venta.' });
    }
    if (!referencia) {
      return res.status(400).json({ error: 'Falta la referencia de la venta' });
    }
    // La Orders API exige external_reference alfanumérico (+ '-' y '_'),
    // máximo 64 caracteres — a diferencia del modelo viejo, que lo dejaba
    // pasar tal cual. generarIdempotencyKey() del POS (pos-terminal.js) ya
    // cumple el formato, pero se valida acá por si algún otro caller manda
    // otra cosa (ids de venta con espacios, UUIDs con caracteres raros, etc).
    const referenciaStr = String(referencia);
    if (referenciaStr.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(referenciaStr)) {
      return res.status(400).json({ error: 'Referencia inválida (solo letras, números, "-" y "_", máx. 64 caracteres).' });
    }

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionMPParaQr(perfil.empresa_id);
    if (errorIntegracion || !integracion?.pos_id || !integracion?.mp_user_id) {
      return res.status(400).json({ error: 'El cobro con QR no está configurado. Hacé el setup en Configuración → Pagos → QR.' });
    }

    const accessTokenMP = await obtenerAccessTokenMPValido(integracion);
    const descripcionOrden = (descripcion || 'Venta mostrador').slice(0, 150);
    const montoStr = montoNum.toFixed(2);

    let orden;
    try {
      orden = await mpBreaker.exec(() =>
        withRetry(() => fetchMP(
          // MIGRACIÓN v782 (verificado contra la guía oficial "Migrate
          // Instore Orders V2 to Orders API"): reemplaza al PUT contra
          // /instore/qr/seller/collectors/.../orders. El POS ya no va en
          // el path, va en config.qr.external_pos_id; la identidad sale
          // del Access Token, no hace falta mandar mp_user_id ni
          // external_store_id. Devuelve 201 con el objeto completo (antes
          // era 204 sin body — fetchMP() sigue soportando ambos casos).
          'https://api.mercadopago.com/v1/orders',
          {
            method:  'POST',
            headers: {
              'Authorization':      `Bearer ${accessTokenMP}`,
              'Content-Type':       'application/json',
              // Obligatorio en creación/cancelación/reembolso de la Orders
              // API — no existía en la Instore Orders V2 API.
              'X-Idempotency-Key':  randomUUID(),
            },
            body: JSON.stringify({
              type:               'qr',
              external_reference: referenciaStr,
              description:        descripcionOrden,
              total_amount:       montoStr,
              config: {
                qr: {
                  external_pos_id: integracion.pos_id,
                  // 'static': mismo comportamiento que el modelo viejo —
                  // reusa el QR fijo ya impreso de esta caja en vez de
                  // generar uno nuevo por venta.
                  mode: 'static',
                },
              },
              transactions: {
                payments: [{ amount: montoStr }],
              },
              items: [{
                title:        descripcionOrden,
                unit_price:   montoStr,
                quantity:     1,
                unit_measure: 'unit',
              }],
            }),
          }
        ))
      );
    } catch (err) {
      if (err.name === 'CircuitBreakerOpenError') {
        return errorSeguro(res, err, 503, 'No se pudo completar la operación.', { retryAfter: err.retryAfterSeconds });
      }
      // Antes esto se tragaba el detalle de MP (código pos_not_found,
      // property_value, etc.) y no dejaba ningún id para cruzar con los
      // logs de Vercel. Ahora queda un correlation_id devuelto al front
      // y el responseBody completo de MP logueado server-side con ese id.
      return errorSeguro(
        res,
        { message: JSON.stringify(err.responseBody ?? { message: err.message }) },
        502,
        'No se pudo cargar el monto en el QR. Reintentá.'
      );
    }

    // Best-effort: si esto falla no aborta el cobro (el polling directo
    // contra MP en pos-qr-verificar sigue siendo la vía de verdad). Es
    // solo lo que le da a Realtime algo que escuchar del lado del POS.
    if (orden?.id) {
      try {
        const { error: errorCobroQr } = await PagosRepo.crearCobroQrPendiente({
          empresa_id: perfil.empresa_id,
          referencia: referenciaStr,
          order_id:   orden.id,
          monto:      montoNum,
        });
        if (errorCobroQr) {
          console.error('[posQrCobrarHandler] No se pudo registrar cobros_qr_pos (Realtime no se enterará, el polling sigue funcionando):', errorCobroQr.message);
        }
      } catch (errCobroQr) {
        // Best-effort real: si esto explota (como pasó por
        // PagosRepo.crearCobroQrPendiente faltante hasta esta versión) no
        // debe tirar abajo el cobro — el polling de pos-qr-verificar sigue
        // siendo la vía de verdad.
        console.error('[posQrCobrarHandler] Excepción registrando cobros_qr_pos (no aborta el cobro):', errCobroQr.message);
      }
    }

    return res.status(200).json({
      ok:         true,
      qr_image:   integracion.qr_image,
      referencia: referenciaStr,
      // Necesario para pos-qr-verificar — la Orders API no tiene buscador
      // por external_reference, hay que consultar por id.
      order_id:   orden?.id || null,
    });
  } catch (error) {
    console.error('Error en posQrCobrarHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// GET /api/pagos?_svc=pos-qr-verificar&order_id=...&referencia=... — polling
// desde caja. order_id es el que devolvió pos-qr-cobrar; referencia se
// acepta también (compatibilidad/logging) pero ya no alcanza sola para
// consultar el estado: la Orders API no expone búsqueda por
// external_reference y la doc de MP es explícita en que la API de Payments
// no debe usarse en integraciones con la Orders API.
async function posQrVerificarHandler(req, res) {
  try {
    const perfil = await autenticarInterno(req, res);
    if (!perfil) return;

    const { referencia, order_id } = req.query;
    if (!order_id) {
      return res.status(400).json({ error: 'Falta order_id (devuelto por pos-qr-cobrar)' });
    }

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionMPParaQr(perfil.empresa_id);
    if (errorIntegracion || !integracion) {
      return res.status(400).json({ error: 'Mercado Pago no configurado para esta empresa' });
    }

    const accessTokenMP = await obtenerAccessTokenMPValido(integracion);
    let resultado;
    try {
      resultado = await _consultarOrdenQr(accessTokenMP, order_id);
    } catch (err) {
      if (err.status === 404) {
        console.warn('[posQrVerificarHandler] Orden no encontrada:', order_id, 'referencia:', referencia);
        return res.status(200).json({ pagado: false, estado: 'pendiente' });
      }
      console.error('[posQrVerificarHandler] Error consultando orden:', err.message);
      return res.status(502).json({ error: 'No se pudo consultar el estado del pago' });
    }

    return res.status(200).json(resultado);
  } catch (error) {
    console.error('Error en posQrVerificarHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// ── Terminal de pago MERCADO PAGO POINT (backend-mediado) ──────────────────
//
// MIGRACIÓN mp_point → backend-mediado. Hasta ahora frontend/admin/js/
// pos-terminal.js (cobrarMpPoint) le pegaba DIRECTO a
// api.mercadopago.com/point/integration-api con el access_token del
// vendedor mandado en texto plano desde Admin → Hardware y guardado sin
// cifrar en empresas.config.pos_hardware.terminal.mp_access_token — ese
// endpoint lo puede leer cualquier rol de venta (getConfigHardwareHandler
// no restringe el GET a admin), así que el token de la cuenta de MP quedaba
// expuesto en la pestaña de red del navegador de cualquier cajero.
//
// Point usa el MISMO access_token que ya usamos para QR/Checkout Pro — no
// hace falta una cuenta ni un secreto nuevo. Reusamos la fila existente de
// integraciones_pago (proveedor='mercado_pago', la misma que consulta
// obtenerIntegracionMPParaQr) y solo pedimos el device_id, que no es
// sensible — es un identificador de hardware, no una credencial — así que
// puede seguir viajando desde el frontend como hace terminal_id en Prisma.
//
// POST /api/pagos?_svc=mp-point-cobrar — crea el payment-intent en la
// terminal Point. body: { monto, device_id, descripcion? }.
async function mpPointCobrarHandler(req, res) {
  try {
    const perfil = await autenticarInterno(req, res);
    if (!perfil) return;

    const { monto, device_id, descripcion } = req.body || {};
    const montoNum = Number(monto);
    if (!montoNum || montoNum <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!device_id) return res.status(400).json({ error: 'Falta el device_id de la terminal Point de esta caja' });

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionMPParaQr(perfil.empresa_id);
    if (errorIntegracion || !integracion) {
      return res.status(400).json({ error: 'Primero conectá tu cuenta de Mercado Pago en Configuración → Pagos.' });
    }

    const accessTokenMP  = await obtenerAccessTokenMPValido(integracion);
    const externalRef    = randomUUID();
    const montoCentavos  = Math.round(montoNum * 100);

    let intent;
    try {
      intent = await mpBreaker.exec(() =>
        withRetry(() => fetchMP(
          `https://api.mercadopago.com/point/integration-api/devices/${encodeURIComponent(device_id)}/payment-intents`,
          {
            method:  'POST',
            headers: {
              'Content-Type':      'application/json',
              'Authorization':     `Bearer ${accessTokenMP}`,
              'X-Idempotency-Key': externalRef,
            },
            body: JSON.stringify({
              amount:            montoCentavos,
              description:       (descripcion || 'Venta mostrador').slice(0, 150),
              print_on_terminal: true,
              additional_info:   { external_reference: externalRef },
            }),
          }
        ))
      );
    } catch (err) {
      if (err.name === 'CircuitBreakerOpenError') {
        return errorSeguro(res, err, 503, 'No se pudo completar la operación.', { retryAfter: err.retryAfterSeconds });
      }
      console.error('[mpPointCobrarHandler] Error creando payment-intent:', err.responseBody ?? err.message);
      return res.status(502).json({ error: 'No se pudo enviar el cobro a la terminal Point. Reintentá.' });
    }

    if (!intent?.id) {
      console.warn('[mpPointCobrarHandler] Respuesta de MP Point sin id:', intent);
      return res.status(502).json({ error: 'La terminal no devolvió un id de operación válido.' });
    }

    return res.status(200).json({ ok: true, intent_id: intent.id, referencia: externalRef });
  } catch (error) {
    console.error('Error en mpPointCobrarHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// GET /api/pagos?_svc=mp-point-verificar&intent_id=... — polling desde caja.
async function mpPointVerificarHandler(req, res) {
  try {
    const perfil = await autenticarInterno(req, res);
    if (!perfil) return;

    const { intent_id } = req.query;
    if (!intent_id) return res.status(400).json({ error: 'Falta intent_id (devuelto por mp-point-cobrar)' });

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionMPParaQr(perfil.empresa_id);
    if (errorIntegracion || !integracion) {
      return res.status(400).json({ error: 'Mercado Pago no configurado para esta empresa' });
    }
    const accessTokenMP = await obtenerAccessTokenMPValido(integracion);

    let estado;
    try {
      estado = await withRetry(() => fetchMP(
        `https://api.mercadopago.com/point/integration-api/payment-intents/${encodeURIComponent(intent_id)}`,
        { headers: { Authorization: `Bearer ${accessTokenMP}` } }
      ));
    } catch (err) {
      if (err.status === 404) return res.status(200).json({ pagado: false, estado: 'pendiente' });
      console.error('[mpPointVerificarHandler] Error consultando intent:', err.message);
      return res.status(502).json({ error: 'No se pudo consultar el estado del pago' });
    }

    if (['CANCELED', 'ABANDONED', 'ERROR'].includes(estado.state)) {
      return res.status(200).json({ pagado: false, rechazado: true, estado: estado.state.toLowerCase() });
    }
    if (estado.state !== 'FINISHED' && estado.state !== 'PROCESSED') {
      return res.status(200).json({ pagado: false, estado: 'pendiente' });
    }

    const pago = estado.payment;
    if (!pago || pago.status !== 'approved') {
      return res.status(200).json({ pagado: false, rechazado: true, estado: pago?.status_detail || estado.state });
    }

    return res.status(200).json({
      pagado:      true,
      estado:      'aprobado',
      payment_id:  pago.id,
      metodo_pago: `${pago.payment_type_id} – ${pago.installments || 1} cuota(s)`,
    });
  } catch (error) {
    console.error('Error en mpPointVerificarHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// POST /api/pagos?_svc=mp-point-cancelar — cancela el intent al vencer el
// timeout o si el cajero cancela. Best-effort, igual criterio que prisma-cancelar.
async function mpPointCancelarHandler(req, res) {
  try {
    const perfil = await autenticarInterno(req, res);
    if (!perfil) return;

    const { intent_id, device_id } = req.body || {};
    if (!intent_id || !device_id) return res.status(200).json({ ok: true });

    const { data: integracion } = await PagosRepo.obtenerIntegracionMPParaQr(perfil.empresa_id);
    if (!integracion) return res.status(200).json({ ok: true });

    const accessTokenMP = await obtenerAccessTokenMPValido(integracion);
    await fetchMP(
      `https://api.mercadopago.com/point/integration-api/devices/${encodeURIComponent(device_id)}/payment-intents/${encodeURIComponent(intent_id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessTokenMP}` } }
    ).catch((err) => {
      console.warn('[mpPointCancelarHandler] No se pudo cancelar en MP Point (no crítico):', err.message);
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error en mpPointCancelarHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// ── Terminal de pago Prisma (Paystore terminals API) ───────────────────────
//
// Reemplaza al driver "Lapos" que tenía el POS: ese driver le hablaba a un
// WebSocket local (ws://lapos-ip:8080) que ningún agente/servicio real
// implementaba del otro lado — nunca fue una integración funcional. Prisma
// sí expone una API cloud real para cargar cobros sobre una terminal física
// ya vinculada a la cuenta del comercio (Paystore), así que el POS ya no
// necesita hablarle a nada en la red local de la caja.
//
// Flujo:
//  1. prisma-config (una vez por empresa, rol dueno/admin): el admin pega
//     el CUIT/CUIL del comercio + un Bearer token de Prisma. Se valida
//     contra la API antes de guardar y se cifra igual que el access_token
//     de MP (lib/crypto-secrets.js). Ver migración 481 — cuit_cuil es la
//     única columna nueva, access_token reusa la que ya tenía la tabla.
//  2. prisma-cobrar (cada venta, roles de caja): manda monto + referencia
//     propia + terminal_id de ESTA caja (cada caja física tiene su propio
//     terminal_id, a diferencia del QR de MP que es fijo por empresa) a la
//     terminal para que el cliente pase la tarjeta.
//  3. prisma-verificar (polling desde pos-terminal.js cada 3s mientras se
//     espera que el cliente complete el pago en la terminal).
//  4. prisma-cancelar: si el cajero cancela o se agota el timeout, avisa a
//     Prisma para que la terminal deje de esperar la tarjeta.
//
// Confirmado contra el portal de desarrolladores (portal.developers.
// prismamediosdepago.com, catálogo "Paystore terminals - Terminal
// Payments v1"): el campo de estado es `payment_data.payment_status`
// (no `status` a secas, como se había asumido antes de ver la doc real).
// El único valor confirmado por la doc es el que devuelve POST /payments
// al crear el pago: "PAYMENT_REQUEST" (pendiente, recién enviado a la
// terminal). La doc no lista el enum completo de estados finales — acá se
// tratan como aprobados/rechazados los valores más probables, y cualquier
// otro (incluido PAYMENT_REQUEST mientras se espera al cliente) queda como
// pendiente, logueado con console.warn para ajustar esta lista contra el
// primer cobro real en sandbox.
const ESTADOS_PRISMA_APROBADO  = new Set(['APPROVED', 'PAYMENT_APPROVED', 'CONFIRMED']);
const ESTADOS_PRISMA_RECHAZADO = new Set(['REJECTED', 'PAYMENT_REJECTED', 'DECLINED', 'CANCELLED', 'EXPIRED']);
const ESTADOS_PRISMA_PENDIENTE = new Set(['PAYMENT_REQUEST']);

// PUT /api/pagos?_svc=prisma-config
// body: { cuit_cuil: string, bearer_token: string }
async function guardarConfigPrisma(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return;

    if (await esEmpresaDemo(perfil.empresa_id)) {
      return res.status(403).json({
        error: 'La configuración de Prisma está deshabilitada en la cuenta demo pública.',
      });
    }

    const { cuit_cuil, bearer_token } = req.body || {};
    const cuitLimpio  = typeof cuit_cuil === 'string' ? cuit_cuil.trim().replace(/[^\d]/g, '') : '';
    const tokenLimpio = typeof bearer_token === 'string' ? bearer_token.trim() : '';

    if (!/^\d{11}$/.test(cuitLimpio)) {
      return res.status(400).json({ error: 'El CUIT/CUIL debe tener 11 dígitos.' });
    }
    if (!tokenLimpio) {
      return res.status(400).json({ error: 'Falta el token de la cuenta Prisma.' });
    }

    // Validar el token contra la API real antes de guardarlo — mismo
    // criterio que guardarConfigMP con /users/me. No hay un endpoint
    // liviano que confirme "token válido PARA ESE cuit_cuil" (no existe
    // /terminals en el catálogo real); /health/liveness sí confirma que el
    // Bearer es válido en general, que es lo mínimo verificable acá.
    try {
      await withRetry(() => fetchPrisma('/health/liveness', {
        headers: { 'Authorization': `Bearer ${tokenLimpio}` },
      }));
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        return res.status(400).json({ error: 'Prisma rechazó el token: es inválido o expiró.' });
      }
      console.error('[guardarConfigPrisma] Error validando token contra Prisma:', err.message);
      return res.status(502).json({ error: 'No se pudo validar el token con Prisma. Intentá de nuevo en un momento.' });
    }

    const cuitFormateado = _formatCuit(cuitLimpio);

    const { error: upsertError } = await PagosRepo.upsertIntegracionMP({
      empresa_id:   perfil.empresa_id,
      proveedor:    PROVEEDOR_PRISMA,
      access_token: cifrar(tokenLimpio),
      cuit_cuil:    cuitFormateado,
      activa:       true,
      updated_at:   new Date().toISOString(),
    });

    if (upsertError) {
      console.error('[guardarConfigPrisma] Error guardando integración:', upsertError.message);
      return res.status(500).json({ error: 'No se pudo guardar la configuración' });
    }

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'integraciones_pago', 'UPDATE', perfil.empresa_id, null,
      { proveedor: PROVEEDOR_PRISMA, activa: true, cuit_cuil: cuitFormateado }
    );

    return res.status(200).json({ ok: true, mensaje: 'Cuenta de Prisma conectada correctamente.', cuit_cuil: cuitFormateado });
  } catch (error) {
    console.error('Error en guardarConfigPrisma:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// GET /api/pagos?_svc=prisma-config — nunca devuelve el token.
async function obtenerConfigPrisma(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return;

    const { data: integracion, error } = await PagosRepo.obtenerConfigIntegracionPrisma(perfil.empresa_id);
    if (error) {
      console.error('[obtenerConfigPrisma] Error:', error.message);
      return res.status(500).json({ error: 'No se pudo consultar la configuración' });
    }
    if (!integracion) return res.status(200).json({ conectado: false });

    return res.status(200).json({
      conectado:  integracion.activa,
      cuit_cuil:  integracion.cuit_cuil,
      created_at: integracion.created_at,
      updated_at: integracion.updated_at,
    });
  } catch (error) {
    console.error('Error en obtenerConfigPrisma:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// DELETE /api/pagos?_svc=prisma-config
async function desactivarConfigPrisma(req, res) {
  try {
    const perfil = await autenticarAdmin(req, res);
    if (!perfil) return;

    const { error } = await PagosRepo.desactivarIntegracionMP(perfil.empresa_id, PROVEEDOR_PRISMA);
    if (error) {
      console.error('[desactivarConfigPrisma] Error:', error.message);
      return res.status(500).json({ error: 'No se pudo desactivar la configuración' });
    }

    await AuditRepo.registrarAuditoriaSilenciosa(
      perfil.empresa_id, perfil.id, 'integraciones_pago', 'UPDATE', perfil.empresa_id,
      { proveedor: PROVEEDOR_PRISMA, activa: true }, { proveedor: PROVEEDOR_PRISMA, activa: false }
    );

    return res.status(200).json({ ok: true, mensaje: 'Cuenta de Prisma desconectada.' });
  } catch (error) {
    console.error('Error en desactivarConfigPrisma:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// POST /api/pagos?_svc=prisma-cobrar
// body: { monto, referencia, terminal_id, descripcion? }
async function prismaCobrarHandler(req, res) {
  try {
    const perfil = await autenticarInterno(req, res);
    if (!perfil) return;

    const { monto, referencia, terminal_id, descripcion } = req.body || {};
    const montoNum = Number(monto);
    if (!montoNum || montoNum <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!referencia)   return res.status(400).json({ error: 'Falta la referencia de la venta' });
    if (!terminal_id)  return res.status(400).json({ error: 'Falta el ID de terminal de esta caja' });

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionPrismaActiva(perfil.empresa_id);
    if (errorIntegracion || !integracion) {
      return res.status(400).json({ error: 'La terminal Prisma no está configurada. Conectá la cuenta en Admin → Hardware.' });
    }

    const tokenPrisma = descifrar(integracion.access_token);

    // NOTA sandbox: la doc del portal advierte que "todas las operaciones
    // en el ambiente de Sandbox se realizan con datos ficticios que son
    // especificados para cada caso de uso y no pueden modificarse, en caso
    // de modificarse los datos se obtendrá un error" — varios de estos
    // campos (print_method, print_copies, print_preview, terminal_operation_
    // method) están fijados igual que el ejemplo del portal a propósito,
    // para maximizar la chance de que el primer test contra sandbox ande.
    // payment_amount va en CENTAVOS como string (confirmado: el ejemplo del
    // portal muestra "1500" para "Pedido de $15,00").
    const montoCentavos = String(Math.round(montoNum * 100));

    let orden;
    try {
      // AUDITORÍA 583 — a diferencia de mp-point-cobrar y pos-qr-cobrar (que
      // mandan X-Idempotency-Key a Mercado Pago, confirmado en su doc como
      // el mecanismo para que un reintento no cree un segundo cobro), este
      // POST /payments de Prisma NO lleva ningún header de idempotencia.
      // `ecr_transaction_id` va en el body como dato de conciliación, pero
      // no hay confirmación en el portal de desarrolladores de que Prisma
      // lo use para deduplicar reintentos server-side (a diferencia del
      // catálogo "Cloud Terminal API" de otros proveedores, que sí lo
      // documentan explícitamente).
      //
      // Este POST es el que efectivamente empuja el cobro a la terminal
      // física — si Prisma ya lo procesó pero la respuesta se pierde por un
      // timeout/5xx/corte de red (justo los casos que withRetry reintenta
      // por defecto), reintentar automáticamente podía volver a mandar el
      // cobro a la terminal una segunda vez: doble prompt en la terminal y
      // riesgo real de cobrarle dos veces la tarjeta al cliente.
      //
      // Fix: sacar el retry automático de este POST puntual (se mantiene el
      // circuit breaker, que solo corta llamadas, no las repite). Si falla,
      // se lo reporta al cajero para reintentar a mano — mismo criterio que
      // "pagar de más" en efectivo: preferible una venta que hay que
      // reintentar manualmente antes que un cobro duplicado en la tarjeta
      // del cliente. prisma-verificar (GET, solo lectura) y prisma-cancelar
      // sí siguen reintentando: son operaciones seguras de repetir.
      // Pendiente: confirmar con soporte de Prisma si ecr_transaction_id
      // dedupe server-side; si lo confirman, se puede volver a envolver en
      // withRetry.
      orden = await prismaBreaker.exec(() => fetchPrisma(
        `/payments?cuit_cuil=${encodeURIComponent(integracion.cuit_cuil)}`,
        {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${tokenPrisma}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payment_request_data: {
              subnet_acquirer_id:      _prismaSubnetAcquirerId(),
              payment_amount:          montoCentavos,
              terminal_menu_text:      descripcion || 'Venta mostrador',
              ecr_provider:            'Distrib',
              ecr_name:                'Distrib POS',
              ecr_version:             '1.0',
              change_amount:           '0',
              ecr_transaction_id:      String(referencia),
              installments_number:     1,
              bank_account_type:       null,
              payment_plan_id:         null,
              payment_type:            null,
              print_method:            'MOBITEF_NON_FISCAL',
              print_copies:            'BOTH',
              print_preview:           'NONE',
              terminals_list:          [{ terminal_id: String(terminal_id) }],
              card_brand_product:      null,
              terminal_operation_method: 'CARD',
              qr_benefit_code:         false,
              trx_receipt_notes:       null,
              card_holder_id:          null,
              merchant_group_code:     null,
              is_tip:                  false,
              currency_code:           '032', // ISO 4217 numérico — ARS
            },
          }),
        }
      ));
    } catch (err) {
      if (err.name === 'CircuitBreakerOpenError') {
        return errorSeguro(res, err, 503, 'No se pudo completar la operación.', { retryAfter: err.retryAfterSeconds });
      }
      console.error('[prismaCobrarHandler] Error iniciando cobro:', err.responseBody ?? err.message);
      return res.status(502).json({ error: 'No se pudo iniciar el cobro en la terminal. Reintentá.' });
    }

    // Confirmado contra la doc: el id de pago vive en payment_data.payment_id.
    const paymentId = orden?.payment_data?.payment_id;
    if (!paymentId) {
      console.warn('[prismaCobrarHandler] Respuesta de Prisma sin payment_data.payment_id:', orden);
      return res.status(502).json({ error: 'La terminal no devolvió un id de pago válido.' });
    }

    return res.status(200).json({ ok: true, payment_id: paymentId, referencia: String(referencia) });
  } catch (error) {
    console.error('Error en prismaCobrarHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// GET /api/pagos?_svc=prisma-verificar&payment_id=... — polling desde caja.
async function prismaVerificarHandler(req, res) {
  try {
    const perfil = await autenticarInterno(req, res);
    if (!perfil) return;

    const { payment_id } = req.query;
    if (!payment_id) return res.status(400).json({ error: 'Falta payment_id' });

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionPrismaActiva(perfil.empresa_id);
    if (errorIntegracion || !integracion) {
      return res.status(400).json({ error: 'La terminal Prisma no está configurada para esta empresa' });
    }

    const tokenPrisma = descifrar(integracion.access_token);
    let estadoResp;
    try {
      estadoResp = await withRetry(() => fetchPrisma(
        `/payments/${encodeURIComponent(payment_id)}?cuit_cuil=${encodeURIComponent(integracion.cuit_cuil)}&subnet_acquirer_id=${encodeURIComponent(_prismaSubnetAcquirerId())}`,
        { headers: { 'Authorization': `Bearer ${tokenPrisma}` } }
      ));
    } catch (err) {
      console.error('[prismaVerificarHandler] Error consultando pago:', err.message);
      return res.status(502).json({ error: 'No se pudo consultar el estado del pago' });
    }

    // Confirmado contra la doc: el estado vive en payment_data.payment_status.
    const estadoCrudo = String(estadoResp?.payment_data?.payment_status ?? '').toUpperCase();
    const pagado    = ESTADOS_PRISMA_APROBADO.has(estadoCrudo);
    const rechazado = ESTADOS_PRISMA_RECHAZADO.has(estadoCrudo);

    if (estadoCrudo && !pagado && !rechazado && !ESTADOS_PRISMA_PENDIENTE.has(estadoCrudo)) {
      console.warn('[prismaVerificarHandler] Estado de Prisma no mapeado, se trata como pendiente:', estadoCrudo);
    }

    return res.status(200).json({ pagado, rechazado, estado: estadoCrudo || 'pendiente', payment_id });
  } catch (error) {
    console.error('Error en prismaVerificarHandler:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// POST /api/pagos?_svc=prisma-cancelar
// body: { payment_id }
// El frontend lo llama en modo "fire and forget" (.catch(()=>{})) al cerrar
// el diálogo por timeout o cancelación manual — acá se responde ok:false en
// vez de un 5xx duro ante fallas de Prisma, para no ensuciar logs con algo
// que el cajero ya no puede accionar desde la UI.
async function prismaCancelarHandler(req, res) {
  try {
    const perfil = await autenticarInterno(req, res);
    if (!perfil) return;

    const { payment_id } = req.body || {};
    if (!payment_id) return res.status(400).json({ error: 'Falta payment_id' });

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionPrismaActiva(perfil.empresa_id);
    if (errorIntegracion || !integracion) {
      return res.status(200).json({ ok: false });
    }

    const tokenPrisma = descifrar(integracion.access_token);
    try {
      // Confirmado: PUT /payments/{payment_id}/cancellations (undoPayment),
      // "Cancels a payment request that has not yet been confirmed" — mismos
      // query params que getPayment (cuit_cuil + subnet_acquirer_id). El
      // schema del body no está documentado en el portal; se manda sin body,
      // ya que payment_id ya va en el path.
      await fetchPrisma(
        `/payments/${encodeURIComponent(payment_id)}/cancellations?cuit_cuil=${encodeURIComponent(integracion.cuit_cuil)}&subnet_acquirer_id=${encodeURIComponent(_prismaSubnetAcquirerId())}`,
        { method: 'PUT', headers: { 'Authorization': `Bearer ${tokenPrisma}` } }
      );
    } catch (err) {
      console.warn('[prismaCancelarHandler] No se pudo cancelar en Prisma (no crítico):', err.message);
      return res.status(200).json({ ok: false });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error en prismaCancelarHandler:', error);
    return res.status(200).json({ ok: false });
  }
}

async function verificarPago(req, res) {
  try {
    const { payment_id } = req.query;

    if (!payment_id) {
      return res.status(400).json({ error: 'payment_id requerido' });
    }

    // Autenticar al usuario antes de revelar info del pago
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
    if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

    const perfilUsuario = await PagosRepo.obtenerPerfilUsuarioPago(user.id);

    if (!perfilUsuario) return res.status(401).json({ error: 'Usuario no encontrado' });

    // 1. Buscar la transacción en nuestra BD para obtener el access_token de la empresa
    const { data: tx, error: txError } = await PagosRepo.obtenerTransaccionParaVerificar(payment_id);

    if (txError) {
      console.error('[verificarPago] Error buscando transacción:', txError);
      return res.status(500).json({ error: 'Error interno' });
    }

    // 1.b Verificar que la transacción pertenece al usuario autenticado
    //     (mismo patrón de ownership que crearPreferencia): o es el cliente
    //     dueño del pedido, o es un rol interno de la misma empresa.
    if (tx) {
      const ROLES_INTERNOS = ['dueno', 'admin', 'vendedor', 'contador'];
      const esPropietario = perfilUsuario.cliente_id && perfilUsuario.cliente_id === tx.cliente_id;
      const esInterno      = ROLES_INTERNOS.includes(perfilUsuario.rol) && perfilUsuario.empresa_id === tx.empresa_id;

      if (!esPropietario && !esInterno) {
        return res.status(403).json({ error: 'No autorizado para consultar este pago' });
      }
    }

    // Si ya está completado/fallido en nuestra BD, devolver sin consultar MP
    if (tx && tx.estado !== 'pendiente') {
      return res.status(200).json({
        status: tx.estado === 'completado' ? 'approved' : tx.estado,
        pedido_id: tx.pedido_id,
        monto: tx.monto,
        fuente: 'cache'
      });
    }

    // 2. Obtener credenciales de la empresa para consultar MP
    const empresa_id = tx?.empresa_id;
    if (!empresa_id) {
      // Si no tenemos la transacción, devolver pending genérico
      return res.status(200).json({ status: 'pending' });
    }

    const integracion = await PagosRepo.obtenerIntegracionMPAccessToken(empresa_id);

    if (!integracion) {
      return res.status(200).json({ status: tx?.estado ?? 'pending' });
    }

    // 3. Consultar el pago directamente en la API de MercadoPago
    let payment;
    try {
      const accessTokenMP = await obtenerAccessTokenMPValido(integracion);
      payment = await mpBreaker.exec(() =>
        withRetry(() => fetchMP(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
          headers: { 'Authorization': `Bearer ${accessTokenMP}` },
        }))
      );
    } catch (err) {
      if (err.name === 'CircuitBreakerOpenError') {
        // MP no disponible — devolver lo que tenemos en BD
        return res.status(200).json({
          status: tx?.estado ?? 'pending',
          fuente: 'cache',
          degraded: true
        });
      }
      console.error('[verificarPago] Error consultando MP:', err.message);
      return res.status(502).json({ error: 'No se pudo verificar el pago con MercadoPago' });
    }

    // 4. Sincronizar el resultado en nuestra BD si cambió
    const nuevoEstado = payment.status === 'approved' ? 'completado'
                      : payment.status === 'rejected' ? 'fallido'
                      : 'pendiente';

    if (tx && tx.estado !== nuevoEstado) {
      // FIX BUG-01: mismo CAS que manejarWebhook — si el webhook ya puso
      // esta transacción en 'completado' entre que la leímos arriba y este
      // UPDATE, no la pisamos ni volvemos a registrar el cobro.
      const { data: filasActualizadas } = await PagosRepo.actualizarTransaccionPorId(tx.id, {
        estado:      nuevoEstado,
        metodo_pago: payment.payment_method_id,
        respuesta_json: payment,
        updated_at: new Date()
      }, { soloSiNoCompletada: true });

      if (!filasActualizadas || filasActualizadas.length === 0) {
        console.log(`[verificarPago] Transacción ${tx.id} ya fue completada por el webhook en paralelo. Devolviendo estado actual.`);
        return res.status(200).json({ status: 'approved', pedido_id: tx.pedido_id, monto: tx.monto, fuente: 'cache' });
      }

      // Auditoría: usuario_id = null — quien reporta el cambio de estado es
      // Mercado Pago (vía la consulta a su API), no una acción deliberada
      // del usuario que está en la pantalla haciendo polling. Mismo criterio
      // que un disparo de sistema.
      // Punto 8 (auditoría 2026): cambio de estado de un pago real vía
      // Mercado Pago — variante durable.
      await AuditRepo.registrarAuditoriaFinancieraDurable(
        tx.empresa_id, null, 'transacciones_pago', 'UPDATE', tx.id,
        { estado: tx.estado }, { estado: nuevoEstado, metodo_pago: payment.payment_method_id }
      );

      // Confirmar pedido si fue aprobado
      // FIX (auditoría etapa 5 — Hallazgo 1): este path (polling desde el
      // cliente) marcaba el pedido como confirmado pero, a diferencia del
      // webhook, nunca registraba el cobro en cta_cte ni reevaluaba el
      // bloqueo del cliente. Si el navegador consultaba esto antes de que
      // llegara el webhook, el pedido quedaba "pagado" sin que la cuenta
      // corriente se enterara nunca. Se aplica el mismo registro que ya
      // usa manejarWebhook.
      if (nuevoEstado === 'completado' && tx.pedido_id) {
        const { data: pedidoPagado } = await PagosRepo.confirmarPedidoPagado(tx.pedido_id);

        if (pedidoPagado?.cliente_id) {
          await AuditRepo.registrarAuditoriaSilenciosa(
            pedidoPagado.empresa_id, null, 'pedidos', 'UPDATE', tx.pedido_id, null, { pagado_via: 'mercado_pago' }
          );

          // FIX BUG-01: mismo offline_local_id que usaría manejarWebhook
          // para este payment_id — si el webhook y este polling corren en
          // paralelo para el mismo pago, el segundo que llegue a
          // registrar_cobro_completo encuentra el offline_local_id ya
          // usado (índice único idx_cobros_offline_local_id) y devuelve el
          // cobro existente en vez de duplicarlo.
          const { data: cobro, error: errorCobro } = await PagosRepo.registrarCobroCompletoRpc({
            p_empresa_id: pedidoPagado.empresa_id,
            p_cliente_id: pedidoPagado.cliente_id,
            p_monto: payment.transaction_amount,
            p_medio: 'mercado_pago',
            p_referencia: String(payment_id),
            p_offline_local_id: `mp:${payment_id}`,
          });

          if (errorCobro || !cobro?.ok) {
            const mensajeError = errorCobro?.message || cobro?.error || 'registrar_cobro_completo no confirmó el cobro';
            console.error(
              '[verificarPago] Pago aprobado pero falló el registro en cta_cte (RECUPERACIÓN MANUAL):',
              mensajeError,
              { pedidoId: tx.pedido_id, clienteId: pedidoPagado.cliente_id, monto: payment.transaction_amount }
            );
            // SYNC-07: mismo fallback durable que manejarWebhook — este
            // camino (polling desde el cliente) puede llegar a fallar el
            // registro del cobro exactamente igual que el webhook, y antes
            // no tenía ninguna cola detrás, solo este mismo log.
            const { error: colaError } = await encolarConciliacionFinanciera({
              empresa_id: pedidoPagado.empresa_id,
              tipo: 'cobro_mp_reconciliacion',
              referencia_id: tx.pedido_id,
              payload: {
                pedido_id: tx.pedido_id,
                cliente_id: pedidoPagado.cliente_id,
                monto: payment.transaction_amount,
                payment_id: String(payment_id),
                offline_local_id: `mp:${payment_id}`,
              },
              error_msg: mensajeError,
            });
            if (colaError) {
              console.error('[verificarPago] No se pudo encolar la reconciliación del cobro (queda solo el log de arriba):', colaError.message);
            }
          } else {
            // Punto 8 (auditoría 2026): cobro real vía Mercado Pago —
            // variante durable.
            await AuditRepo.registrarAuditoriaFinancieraDurable(
              pedidoPagado.empresa_id, null, 'cta_cte', 'INSERT', cobro?.cobro_id ?? tx.pedido_id, null,
              { cliente_id: pedidoPagado.cliente_id, monto: payment.transaction_amount, medio: 'mercado_pago', referencia: String(payment_id) }
            );
          }
          // BILLING-002: el desbloqueo ya lo hace registrar_cobro_completo (RPC),
          // que lee clientes.saldo_deuda (mantenido por el trigger sync_saldo_deuda_cliente).
          // Antes había acá un recálculo manual en JS (desbloquearSiSaldado) que solo
          // contaba tipo='debito' como deuda, ignorando 'factura'/'cargo'/'nota_debito' —
          // podía desbloquear clientes que seguían debiendo. Se eliminó por redundante e incorrecto.
        }
      }
    }

    res.status(200).json({
      status:          payment.status,
      status_detail:   payment.status_detail,
      payment_method:  payment.payment_method_id,
      pedido_id:       tx?.pedido_id,
      monto:           payment.transaction_amount,
      fuente:          'mercadopago'
    });

  } catch (error) {
    console.error('Error en verificarPago:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// ── Verificación de firma HMAC-SHA256 (DT-04) ─────────────────────────────
//
// Mercado Pago incluye el header `x-signature` en cada notificación de webhook.
// Formato: "ts=<timestamp>,v1=<hmac_hex>"
// Se calcula HMAC-SHA256 sobre "id:<data.id>;request-id:<x-request-id>;ts:<timestamp>"
// usando WEBHOOK_SECRET_MP (configurado en el dashboard de MP).
//
// SEC-013 (fix sesión 5): antes, si WEBHOOK_SECRET_MP no estaba definido, se
// omitía la verificación y se aceptaba cualquier request sin firma
// ("return true" en vez de rechazar) — patrón fail-open. Se corrige al mismo
// patrón fail-closed que ya usa el webhook de WhatsApp (firmaValidaDeMeta en
// notif.js): sin secreto configurado no hay nada contra qué validar, así que
// se trata como firma inválida en vez de dejar pasar todo.
export function verificarFirmaMP(req) {
  const secret = process.env.WEBHOOK_SECRET_MP;
  if (!secret) {
    console.error('[MP-WEBHOOK] WEBHOOK_SECRET_MP no configurado — rechazando por seguridad');
    return false;
  }

  const xSignature = req.headers['x-signature'] || '';
  const xRequestId = req.headers['x-request-id'] || '';
  const dataId     = req.body?.data?.id || '';

  // Extraer ts y v1 del header x-signature
  const parts = Object.fromEntries(
    xSignature.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const ts = parts['ts'];
  const v1 = parts['v1'];

  if (!ts || !v1) {
    console.warn('[MP-WEBHOOK] Header x-signature malformado:', xSignature);
    return false;
  }

  // Construir el mensaje según la documentación de MP
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts}`;

  const hmac = createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  try {
    // timingSafeEqual previene timing attacks
    return timingSafeEqual(Buffer.from(hmac), Buffer.from(v1));
  } catch {
    return false;
  }
}

// ── Webhook de Mercado Pago ────────────────────────────────────────────────
//
// Motor de Integraciones (577_webhooks_recibidos.sql, cont.): la lógica de
// negocio vive en procesarEventoMP(body), separada de la verificación de
// firma y del wiring HTTP. Esto es lo que permite que
// handleWebhooksReprocesarCron (lib/handlers/notif.js) reprocese eventos de
// MP que quedaron en 'error' sin tener que fabricar una firma HMAC falsa —
// la firma ya se validó una vez, en la recepción original; reprocesar es
// volver a correr la MISMA lógica de negocio sobre el MISMO payload
// guardado. procesarEventoMP no debe volver a llamarse desde ningún lugar
// que no haya pasado ya por verificarFirmaMP (manejarWebhook) o por un
// evento ya registrado en webhooks_recibidos con firma_valida=true (el
// cron de reintento).
async function procesarEventoMP(body) {
  const { type, data } = body;

  // MIGRACIÓN v782 — topic `order` (Orders API, cobro QR del POS).
  // Reemplaza a los topics `payments`/`merchant_orders` del modelo viejo
  // para este flujo (hay que suscribir `order` — "Order (Mercado Pago)"—
  // en Your integrations → Webhooks para esta app, y dar de baja los
  // dos anteriores si solo se usaban para QR). data.id es el order_id
  // ("ORD..."), no un payment_id numérico.
  //
  // MIGRACIÓN 498: hasta acá este branch solo logueaba — la sincronización
  // real dependía 100% de que el navegador de la caja mantuviera vivo el
  // polling de pos-qr-verificar (frágil si la pestaña pierde foco: el
  // browser espacia esos timers y el QR "se queda colgado" aunque el
  // pago ya esté acreditado). Ahora, apenas MP confirma la orden, se
  // actualiza cobros_qr_pos — el POS lo escucha por Realtime
  // (frontend/admin/js/pos-terminal.js) y cierra al toque, sin esperar
  // el próximo tick del polling. El cobro QR sigue sin fila propia en
  // `pedidos`/`transacciones_pago` (ese es otro gap, ver
  // CHANGELOGS_INTEGRACION/CHANGELOG_v760_qr_mercadopago_pos.md) — esto solo resuelve la
  // sincronización de la UI, la venta la sigue registrando el frontend
  // (POST /api/pos) una vez que se entera de que se pagó.
  if (type === 'order') {
    const orderId = data?.id;
    console.log('[MP-WEBHOOK] Notificación de orden QR recibida:', orderId, 'action:', body?.action);
    if (!orderId) {
      return { status: 200, body: { received: true, order_id: null } };
    }
    const mpUserId = body?.user_id != null ? String(body.user_id) : null;
    if (!mpUserId) {
      console.warn('[MP-WEBHOOK] Notificación de orden sin user_id — no se puede resolver la empresa para actualizar cobros_qr_pos:', orderId);
      return { status: 200, body: { received: true, order_id: orderId } };
    }
    try {
      const { data: integracion } = await PagosRepo.obtenerIntegracionMPPorMpUserId(mpUserId);
      if (integracion) {
        const accessTokenMP = await obtenerAccessTokenMPValido(integracion);
        const resultado = await _consultarOrdenQr(accessTokenMP, orderId);
        const { error: errorUpdate } = await PagosRepo.actualizarCobroQrPorOrderId(orderId, {
          estado:      resultado.estado,
          payment_id:  resultado.payment_id,
          metodo_pago: resultado.metodo_pago,
        });
        if (errorUpdate) {
          console.error('[MP-WEBHOOK] Error actualizando cobros_qr_pos:', orderId, errorUpdate.message);
        }
      } else {
        console.warn('[MP-WEBHOOK] No se encontró integración para mp_user_id (orden QR):', mpUserId, orderId);
      }
    } catch (err) {
      // Best-effort: si falla, el polling de pos-qr-verificar sigue
      // siendo la vía de verdad — no hay nada más que hacer acá salvo
      // loguear para diagnosticar.
      console.error('[MP-WEBHOOK] Error procesando notificación de orden QR:', orderId, err.message);
    }
    return { status: 200, body: { received: true, order_id: orderId } };
  }

  if (type === 'payment') {
    const payment_id = data.id;

    // FIX MERCADOPAGO-AUDIT-01 (hallazgo crítico, etapa 3): la resolución
    // de empresa y la actualización de la transacción usaban
    // `transacciones_pago.referencia_externa = payment_id`. Esa columna
    // se completa en crearPreferencia con `preferenceData.id` — el ID de
    // la PREFERENCIA (formato "collector-uuid"), un recurso totalmente
    // distinto del payment_id numérico que manda el webhook. Nunca
    // matcheaban: todo pago online (Checkout Pro) caía siempre en el
    // branch "empresa no resuelta" sin hacer nada — el pedido nunca se
    // confirmaba ni se acreditaba en cta_cte, pagara quien pagara.
    // (transacciones_pago tenía 0 filas en producción — nadie llegó a
    // probar el flujo contra una cuenta real todavía, ver v760.)
    //
    // Fix: resolver la empresa por el `user_id` (cuenta de MP que
    // recibió el cobro) que el propio webhook trae en el body — no
    // depende de nada que hayamos guardado nosotros sobre el
    // payment_id — y matchear/actualizar la fila de
    // transacciones_pago por `pedido_id` (columna propia, siempre
    // confiable) en vez de por referencia_externa. Se aprovecha para
    // corregir `referencia_externa` al payment_id real de una vez.
    const mpUserId = body?.user_id != null ? String(body.user_id) : null;
    if (!mpUserId) {
      console.error('[MP-WEBHOOK] Notificación sin user_id — no se puede resolver la empresa. payment_id:', payment_id);
      return { status: 200, body: { received: true, error: 'user_id ausente en la notificación' } };
    }

    const { data: integracion, error: errorIntegracion } = await PagosRepo.obtenerIntegracionMPPorMpUserId(mpUserId);

    if (errorIntegracion || !integracion) {
      // Puede pasar con cuentas que conectaron Checkout Pro ANTES de este
      // fix (mp_user_id nunca se guardó) — hace falta que reconecten el
      // token una vez (guardarConfigMP ya lo persiste ahora) para que
      // el webhook las pueda resolver.
      console.error('[MP-WEBHOOK] No se encontró integración activa para mp_user_id:', mpUserId, 'payment_id:', payment_id);
      return { status: 200, body: { received: true, error: 'empresa no resuelta' } };
    }

    let payment;
    try {
      const accessTokenMP = await obtenerAccessTokenMPValido(integracion);
      payment = await mpBreaker.exec(() =>
        withRetry(() => fetchMP(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
          headers: { 'Authorization': `Bearer ${accessTokenMP}` },
        }))
      );
    } catch (err) {
      if (err.name === 'CircuitBreakerOpenError') {
        // MP no disponible: devolver 200 para que MP no reintente infinitamente,
        // pero loguear para re-procesar manualmente.
        console.error('[MP-WEBHOOK] Breaker abierto — pago no verificado:', payment_id, err.message);
        return { status: 200, body: { received: true, degraded: true } };
      }
      console.error('[MP-WEBHOOK] Error consultando pago:', err.message);
      return { status: 502, body: { error: 'No se pudo verificar el pago' } };
    }

    const pedido_id = payment.external_reference;
    if (!pedido_id) {
      // Pago sin external_reference=pedido (p.ej. QR del POS, que arma
      // su propia orden sin pasar por crearPreferencia) — no tiene fila
      // en transacciones_pago. Sigue pendiente decidir su reconciliación
      // (ver CHANGELOGS_INTEGRACION/CHANGELOG_v760_qr_mercadopago_pos.md).
      return { status: 200, body: { received: true, sin_pedido_asociado: true } };
    }

    const { data: tx, error: txError } = await PagosRepo.obtenerTransaccionPorPedido(pedido_id, integracion.empresa_id);

    if (txError) {
      console.error('[MP-WEBHOOK] Error buscando transacción por pedido:', txError, { pedido_id, payment_id });
      return { status: 500, body: { error: 'Error interno al verificar transacción' } };
    }

    // Idempotencia: si esta transacción ya fue procesada y completada.
    if (tx && tx.estado === 'completado') {
      console.log(`[MP-WEBHOOK] Pedido ${pedido_id} ya procesado y completado. Ignorando duplicado (payment_id ${payment_id}).`);
      return { status: 200, body: { received: true, message: 'Payment already processed' } };
    }

    if (!tx) {
      // FIX SEC-10: además de "no hay transacción para este pedido", este
      // caso ahora también cubre "el pedido existe pero es de otra
      // empresa distinta a la integración que recibió el cobro" — porque
      // obtenerTransaccionPorPedido ya filtra por empresa_id. Antes eso
      // habría devuelto la transacción igual y el webhook la habría
      // confirmado como paga sin haber cobrado en la cuenta de MP
      // correcta. Se loguea igual para diagnóstico; la respuesta 200
      // evita que MP reintente indefinidamente algo que nunca va a
      // resolver del lado nuestro.
      console.error('[MP-WEBHOOK] No hay transacción para el pedido en la empresa de esta integración (o no existe):', pedido_id, 'payment_id:', payment_id, 'empresa_integracion:', integracion.empresa_id);
      return { status: 200, body: { received: true, error: 'transacción no encontrada para el pedido en esta empresa' } };
    }

    // FIX BUG-01: UPDATE condicional (CAS) — si otro webhook/polling
    // concurrente para el mismo payment ya puso la transacción en
    // 'completado' un instante antes, esta llamada no actualiza ninguna
    // fila (en vez de pisarla) y quedamos advertidos por `filasActualizadas`.
    const { data: filasActualizadas, error: errorUpdate } = await PagosRepo.actualizarTransaccionPorId(tx.id, {
      estado: payment.status === 'approved' ? 'completado' : 'fallido',
      metodo_pago: payment.payment_method_id,
      referencia_externa: String(payment_id),
      respuesta_json: payment,
      updated_at: new Date()
    }, { soloSiNoCompletada: true });

    if (!errorUpdate && (!filasActualizadas || filasActualizadas.length === 0)) {
      console.log(`[MP-WEBHOOK] Transacción ${tx.id} (pedido ${pedido_id}) ya fue completada por otro webhook/polling concurrente. Ignorando duplicado (payment_id ${payment_id}).`);
      return { status: 200, body: { received: true, message: 'Payment already processed (race)' } };
    }

    if (!errorUpdate) {
      // Punto 8 (auditoría 2026): cambio de estado de un pago real vía
      // webhook de Mercado Pago — variante durable.
      await AuditRepo.registrarAuditoriaFinancieraDurable(
        integracion.empresa_id, null, 'transacciones_pago', 'UPDATE', String(payment_id), null,
        { estado: payment.status === 'approved' ? 'completado' : 'fallido', metodo_pago: payment.payment_method_id }
      );
    }

    if (!errorUpdate && payment.status === 'approved') {
      // Marcar pedido como confirmado tras pago exitoso
      const { data: pedidoPagado, error: errorPedido } = await PagosRepo.confirmarPedidoPagado(pedido_id);

      // FIX (auditoría pedido→factura→cta_cte→cobro): antes el pago
      // online nunca se acreditaba en cta_cte, así que un cliente que
      // pagaba por Mercado Pago quedaba con la deuda de esa factura
      // para siempre. Ahora se registra el cobro igual que en el
      // cobro manual (mismo RPC que usa admin/cobranzas), y recién
      // ahí se reevalúa el bloqueo por saldo.
      if (!errorPedido && pedidoPagado?.cliente_id) {
        await AuditRepo.registrarAuditoriaSilenciosa(
          pedidoPagado.empresa_id, null, 'pedidos', 'UPDATE', pedido_id, null, { pagado_via: 'mercado_pago' }
        );

        // FIX BUG-01: `p_offline_local_id` propio del payment_id de MP.
        // registrar_cobro_completo ya dedupea por este campo contra un
        // índice único (idx_cobros_offline_local_id) — es la segunda
        // capa de idempotencia, a nivel de base, independiente del CAS
        // de arriba: aunque dos llamadas lograran pasar el CAS (por
        // ejemplo, dos payment_id distintos de MP para el mismo pedido
        // por algún reintento raro de MP), el cobro en cta_cte no se
        // duplica porque el INSERT en `cobros` con el mismo
        // offline_local_id colisiona con el índice único y el RPC
        // devuelve el cobro ya existente en vez de crear uno nuevo.
        const { data: cobro, error: errorCobro } = await PagosRepo.registrarCobroCompletoRpc({
          p_empresa_id: pedidoPagado.empresa_id,
          p_cliente_id: pedidoPagado.cliente_id,
          p_monto: payment.transaction_amount,
          p_medio: 'mercado_pago',
          p_referencia: String(payment_id),
          p_offline_local_id: `mp:${payment_id}`,
        });

        if (errorCobro || !cobro?.ok) {
          const mensajeError = errorCobro?.message || cobro?.error || 'registrar_cobro_completo no confirmó el cobro';
          console.error(
            '[MP-WEBHOOK] Pago aprobado pero falló el registro en cta_cte (RECUPERACIÓN MANUAL):',
            mensajeError,
            { pedidoId: pedido_id, clienteId: pedidoPagado.cliente_id, monto: payment.transaction_amount }
          );
          // SYNC-07 (Auditoría Integral 2026): antes esto quedaba solo en
          // el log de arriba, sin ninguna cola durable — dependía de que
          // alguien viera el log y reconciliara a mano. Se encola en
          // cola_financiera (mismo mecanismo que ya usa lib/facturas.js
          // para asientos pendientes) con el mismo offline_local_id que
          // ya trae el idempotency key del cobro, así que el reproceso
          // (ver lib/handlers/cierre.js, tipo 'cobro_mp_reconciliacion')
          // nunca puede duplicar el cobro aunque este mismo webhook haya
          // llegado a insertar parcialmente algo antes de fallar.
          const { error: colaError } = await encolarConciliacionFinanciera({
            empresa_id: pedidoPagado.empresa_id,
            tipo: 'cobro_mp_reconciliacion',
            referencia_id: pedido_id,
            payload: {
              pedido_id,
              cliente_id: pedidoPagado.cliente_id,
              monto: payment.transaction_amount,
              payment_id: String(payment_id),
              offline_local_id: `mp:${payment_id}`,
            },
            error_msg: mensajeError,
          });
          if (colaError) {
            console.error('[MP-WEBHOOK] No se pudo encolar la reconciliación del cobro (queda solo el log de arriba):', colaError.message);
          }
        } else {
          // Punto 8 (auditoría 2026): cobro real vía webhook de Mercado
          // Pago — variante durable.
          await AuditRepo.registrarAuditoriaFinancieraDurable(
            pedidoPagado.empresa_id, null, 'cta_cte', 'INSERT', cobro?.cobro_id ?? pedido_id, null,
            { cliente_id: pedidoPagado.cliente_id, monto: payment.transaction_amount, medio: 'mercado_pago', referencia: String(payment_id) }
          );
        }
        // BILLING-002: idem verificarPago — el desbloqueo ya lo hace el RPC.
      }
    }
  }

  return { status: 200, body: { received: true } };
}

async function manejarWebhook(req, res) {
  // Motor de Integraciones (577_webhooks_recibidos.sql): id del log genérico
  // de este evento, usado en el catch de abajo para marcar error/reintento.
  // Vive fuera del try para que el catch lo pueda ver aunque el log falle.
  let _webhookLogId = null;
  try {
    // DT-04: Verificar firma HMAC antes de procesar nada
    if (!verificarFirmaMP(req)) {
      console.warn('[MP-WEBHOOK] Firma inválida — request descartada');
      return res.status(401).json({ error: 'Firma inválida' });
    }

    const { type, data } = req.body;

    // Log genérico + dedupe entre integraciones. No reemplaza la
    // idempotencia de negocio de abajo (CAS sobre transacciones_pago) — la
    // complementa con observabilidad y una cola de reintento común.
    {
      const eventoExternoId = data?.id != null ? String(data.id) : `sin-id:${Date.now()}`;
      const { id: logId, yaProcesado } = await registrarWebhookEntrante({
        integracion: 'mercadopago',
        eventoExternoId,
        tipo: type || null,
        payload: req.body,
        headers: { 'x-signature': req.headers['x-signature'], 'x-request-id': req.headers['x-request-id'] },
      });
      if (yaProcesado) {
        console.log('[MP-WEBHOOK] Evento duplicado (reintento del proveedor), ya registrado:', eventoExternoId);
        return res.status(200).json({ received: true, duplicado: true });
      }
      _webhookLogId = logId;
    }

    const resultado = await procesarEventoMP(req.body);
    return res.status(resultado.status).json(resultado.body);

  } catch (error) {
    console.error('Error en webhook:', error);
    if (_webhookLogId) await marcarWebhookError(_webhookLogId, error.message);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// Exportar función de webhook para uso directo si fuera necesario
export { manejarWebhook as webhook, procesarEventoMP };

