// api/pagos/index.js  (consolidado desde mercado-pago.js)
// Integración con Mercado Pago para pagos online
//
// DT-04: Rate limiting en todos los métodos.
//        El webhook además verifica firma HMAC-SHA256 (x-signature) para
//        garantizar que la notificación proviene realmente de Mercado Pago.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { rateLimit } from '../rate-limit.js';
import fetch from 'node-fetch';
import { createHmac, timingSafeEqual } from 'crypto';
import { CircuitBreaker, CircuitBreakerOpenError } from '../circuit-breaker.js';
import { withRetry } from '../retry.js';
import { cifrar, descifrar } from '../crypto-secrets.js';
import { esEmpresaDemo } from '../demo-mode.js';
import { errorSeguro } from '../error-response.js';
import * as PagosRepo from '../repos/pagos.js';
import * as AuditRepo from '../repos/audit.js';
// FIX (Etapa 6 offline — test que lo detectó): esta función vive en
// repos/pedidos.js (trae `generado_automatico`, ver su cabecera ahí), no
// en repos/pagos.js. Estaba escrita como `PagosRepo.obtenerPedidoParaPagoPublico`
// más abajo, que nunca existió en ese namespace — cualquier llamada real
// a crearPreferenciaPublicaHandler tiraba TypeError ("is not a function")
// en vez del 404 documentado. El guard de MP (Etapa 5, punto 2) nunca
// llegó a ejecutarse en producción por este bug.
import { obtenerPedidoParaPagoPublico } from '../repos/pedidos.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

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
  return response.json();
}
// crear preferencia: 30 req/min (usuario autenticado, costo de negocio moderado)
const limiterPreferencia = rateLimit({ max: 30, windowMs: 60_000 });
// webhook: 120 req/min (alta frecuencia esperada desde MP, pero limitada para evitar abusos)
const limiterWebhook = rateLimit({ max: 120, windowMs: 60_000 });
// verificar pago GET: 60 req/min
const limiterVerificar = rateLimit({ max: 60, windowMs: 60_000 });
// configurar integración MP (alta/edición manual de credenciales): 10 req/min
const limiterConfig = rateLimit({ max: 10, windowMs: 60_000 });

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

  // Etapa 5 offline — link de pago público (checkout.html, sin login).
  // Ver nota grande en crearPreferenciaPublicaHandler más abajo.
  if (req.query._svc === 'publico') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (await limiterPreferenciaPublica(req, res)) return;
    return await crearPreferenciaPublicaHandler(req, res);
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

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
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
  const accessTokenMP = descifrar(integracion.access_token);
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

const PROVEEDOR_MP = 'mercado_pago';

// Helper: autentica al usuario por Supabase Auth y exige rol dueno/admin
// de la empresa. Mismo patrón que lib/handlers/empresa.js.
async function autenticarAdmin(req, res) {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
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

    const { error: upsertError } = await PagosRepo.upsertIntegracionMP({
      empresa_id:   perfil.empresa_id,
      proveedor:    PROVEEDOR_MP,
      access_token: accessTokenCifrado,
      public_key:   publicKeyLimpia,
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
      conectado:  integracion.activa,
      public_key: integracion.public_key,
      created_at: integracion.created_at,
      updated_at: integracion.updated_at,
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

async function verificarPago(req, res) {
  try {
    const { payment_id } = req.query;

    if (!payment_id) {
      return res.status(400).json({ error: 'payment_id requerido' });
    }

    // Autenticar al usuario antes de revelar info del pago
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
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
      payment = await mpBreaker.exec(() =>
        withRetry(() => fetchMP(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
          headers: { 'Authorization': `Bearer ${descifrar(integracion.access_token)}` },
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
      await PagosRepo.actualizarTransaccionPorId(tx.id, {
        estado:      nuevoEstado,
        metodo_pago: payment.payment_method_id,
        respuesta_json: payment,
        updated_at: new Date()
      });

      // Auditoría: usuario_id = null — quien reporta el cambio de estado es
      // Mercado Pago (vía la consulta a su API), no una acción deliberada
      // del usuario que está en la pantalla haciendo polling. Mismo criterio
      // que un disparo de sistema.
      await AuditRepo.registrarAuditoriaSilenciosa(
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

          const { data: cobro, error: errorCobro } = await PagosRepo.registrarCobroCompletoRpc({
            p_empresa_id: pedidoPagado.empresa_id,
            p_cliente_id: pedidoPagado.cliente_id,
            p_monto: payment.transaction_amount,
            p_medio: 'mercado_pago',
            p_referencia: String(payment_id),
          });

          if (errorCobro || !cobro?.ok) {
            console.error(
              '[verificarPago] Pago aprobado pero falló el registro en cta_cte (RECUPERACIÓN MANUAL):',
              errorCobro?.message || cobro?.error,
              { pedidoId: tx.pedido_id, clienteId: pedidoPagado.cliente_id, monto: payment.transaction_amount }
            );
          } else {
            await AuditRepo.registrarAuditoriaSilenciosa(
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
async function manejarWebhook(req, res) {
  try {
    // DT-04: Verificar firma HMAC antes de procesar nada
    if (!verificarFirmaMP(req)) {
      console.warn('[MP-WEBHOOK] Firma inválida — request descartada');
      return res.status(401).json({ error: 'Firma inválida' });
    }

    const { type, data } = req.body;

    if (type === 'payment') {
      const payment_id = data.id;

      // Idempotencia: Verificar si esta transacción ya fue procesada y completada
      const { data: existingTx, error: existingTxError } = await PagosRepo.obtenerTransaccionEstadoPorReferencia(payment_id);

      if (existingTxError) {
        console.error('[MP-WEBHOOK] Error consultando transacción existente:', existingTxError);
        return res.status(500).json({ error: 'Error interno al verificar transacción' });
      }

      if (existingTx && existingTx.estado === 'completado') {
        console.log(`[MP-WEBHOOK] Transacción ${payment_id} ya procesada y completada. Ignorando duplicado.`);
        return res.status(200).json({ received: true, message: 'Payment already processed' });
      }

      // FIX multi-tenant: la integración de MP es por empresa, no global.
      // Buscar la transacción registrada en crearPreferencia (tiene empresa_id)
      // para usar las credenciales de la empresa correcta. Sin esto, con 2+
      // empresas activas, .single() sobre todas las integraciones rompe o
      // devuelve credenciales de otra empresa.
      const { data: txParaEmpresa, error: txEmpresaError } = await PagosRepo.obtenerTransaccionEmpresaPorReferencia(payment_id);

      if (txEmpresaError || !txParaEmpresa?.empresa_id) {
        console.error('[MP-WEBHOOK] No se pudo resolver empresa_id para payment_id:', payment_id, txEmpresaError);
        return res.status(200).json({ received: true, error: 'empresa no resuelta' });
      }

      // Obtener detalles del pago desde Mercado Pago, con las credenciales de la empresa dueña del pedido
      const { data: integracion } = await PagosRepo.obtenerIntegracionMPActiva(txParaEmpresa.empresa_id);

      if (!integracion) {
        return res.status(400).json({ error: 'Integración no encontrada' });
      }

      let payment;
      try {
        payment = await mpBreaker.exec(() =>
          withRetry(() => fetchMP(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
            headers: { 'Authorization': `Bearer ${descifrar(integracion.access_token)}` },
          }))
        );
      } catch (err) {
        if (err.name === 'CircuitBreakerOpenError') {
          // MP no disponible: devolver 200 para que MP no reintente infinitamente,
          // pero loguear para re-procesar manualmente.
          console.error('[MP-WEBHOOK] Breaker abierto — pago no verificado:', payment_id, err.message);
          return res.status(200).json({ received: true, degraded: true });
        }
        console.error('[MP-WEBHOOK] Error consultando pago:', err.message);
        return res.status(502).json({ error: 'No se pudo verificar el pago' });
      }

      // Actualizar transacción en BD
      const { error: errorUpdate } = await PagosRepo.actualizarTransaccionPorReferencia(payment_id, {
        estado: payment.status === 'approved' ? 'completado' : 'fallido',
        metodo_pago: payment.payment_method_id,
        respuesta_json: payment,
        updated_at: new Date()
      });

      if (!errorUpdate) {
        await AuditRepo.registrarAuditoriaSilenciosa(
          txParaEmpresa.empresa_id, null, 'transacciones_pago', 'UPDATE', String(payment_id), null,
          { estado: payment.status === 'approved' ? 'completado' : 'fallido', metodo_pago: payment.payment_method_id }
        );
      }

      if (!errorUpdate && payment.status === 'approved') {
        // Marcar pedido como confirmado tras pago exitoso
        // FIX: pedidos.pagado no existe — solo actualizar estado
        const external_ref = payment.external_reference;
        const { data: pedidoPagado, error: errorPedido } = await PagosRepo.confirmarPedidoPagado(external_ref);

        // FIX (auditoría pedido→factura→cta_cte→cobro): antes el pago
        // online nunca se acreditaba en cta_cte, así que un cliente que
        // pagaba por Mercado Pago quedaba con la deuda de esa factura
        // para siempre. Ahora se registra el cobro igual que en el
        // cobro manual (mismo RPC que usa admin/cobranzas), y recién
        // ahí se reevalúa el bloqueo por saldo.
        if (!errorPedido && pedidoPagado?.cliente_id) {
          await AuditRepo.registrarAuditoriaSilenciosa(
            pedidoPagado.empresa_id, null, 'pedidos', 'UPDATE', external_ref, null, { pagado_via: 'mercado_pago' }
          );

          const { data: cobro, error: errorCobro } = await PagosRepo.registrarCobroCompletoRpc({
            p_empresa_id: pedidoPagado.empresa_id,
            p_cliente_id: pedidoPagado.cliente_id,
            p_monto: payment.transaction_amount,
            p_medio: 'mercado_pago',
            p_referencia: String(payment_id),
          });

          if (errorCobro || !cobro?.ok) {
            console.error(
              '[MP-WEBHOOK] Pago aprobado pero falló el registro en cta_cte (RECUPERACIÓN MANUAL):',
              errorCobro?.message || cobro?.error,
              { pedidoId: external_ref, clienteId: pedidoPagado.cliente_id, monto: payment.transaction_amount }
            );
          } else {
            await AuditRepo.registrarAuditoriaSilenciosa(
              pedidoPagado.empresa_id, null, 'cta_cte', 'INSERT', cobro?.cobro_id ?? external_ref, null,
              { cliente_id: pedidoPagado.cliente_id, monto: payment.transaction_amount, medio: 'mercado_pago', referencia: String(payment_id) }
            );
          }
          // BILLING-002: idem verificarPago — el desbloqueo ya lo hace el RPC.
        }
      }
    }

    res.status(200).json({ received: true });

  } catch (error) {
    console.error('Error en webhook:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// Exportar función de webhook para uso directo si fuera necesario
export { manejarWebhook as webhook };

