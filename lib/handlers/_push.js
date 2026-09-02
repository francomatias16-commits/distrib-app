// api/notif/_push.js
// Módulo de helpers de Notificaciones Push (Firebase Cloud Messaging).
//
// El prefijo "_" excluye este archivo del conteo de Serverless Functions
// de Vercel — ya no expone un handler propio.
//
// El registro/desregistro de dispositivos (antes acá, vía /api/notif/push)
// ahora vive en api/notif/index.js como sub-ruta 'push'.
//
// Exporta: enviarPush, notificarOfertaRelampago, notificarDeudaVencida,
//          notificarPedidoEntregado, notificarPuntosGanados

// FIX (bump firebase-admin 12→14, Fase 6 plan de acción): el import por
// namespace (`import admin from 'firebase-admin'`, con `admin.credential.cert`
// y `admin.messaging()`) dejó de funcionar en v13+ — el paquete raíz ya no
// expone `credential` ni `messaging` en absoluto (confirmado con un test
// real contra v14.2.0: `admin.credential` es `undefined`, `admin.messaging`
// no es una función). Hay que usar la API modular con imports nombrados
// desde los subpaths `firebase-admin/app` y `firebase-admin/messaging`.
//
// FIX (2026-08-25, auditoría CPU Hobby): estos dos imports eran ESTÁTICOS
// (`import ... from`), así que Node los resolvía y ejecutaba en CADA cold
// start de cualquier handler que importe este archivo (notif.js, stock.js,
// pedidos/index.js, pedidos/notificaciones.js, whatsapp-pedido-tools.js,
// reglas-automatizacion.js) — aunque esa invocación puntual no mandara
// ningún push. firebase-admin/app y firebase-admin/messaging arrastran
// google-auth-library/gaxios (paquetes pesados de inicializar), y con el
// tráfico bajo de este proyecto casi todas las invocaciones son cold start,
// así que ese costo se pagaba una y otra vez sin necesidad. Ahora se
// importan de forma perezosa, dentro de asegurarFirebase()/enviarPush(),
// igual que el criterio que ya usa api/index.js con los handlers (LOADERS).
// Node cachea el import() dinámico igual que el estático, así que dentro
// de un mismo lambda "warm" el costo se sigue pagando una sola vez.
let _firebaseAppMod = null;
let _firebaseMessagingMod = null;
async function cargarFirebaseAdmin() {
  if (!_firebaseAppMod) _firebaseAppMod = await import('firebase-admin/app');
  if (!_firebaseMessagingMod) _firebaseMessagingMod = await import('firebase-admin/messaging');
  return { ..._firebaseAppMod, ..._firebaseMessagingMod };
}
import { rateLimitPorClave } from '../rate-limit.js';
import { NotifRepo } from '../repos/index.js';

// Migrado a capa de repos (lib/repos/notif.js): antes cada consulta acá
// abría su propio cliente Supabase (`crearClienteSupabaseLazy`, mismo
// backend que `db`). Ahora usa el singleton `db` vía NotifRepo, como el
// resto de los repos (ver también la migración de notifAuto en
// _auto-push.js, mismo criterio).

// Inicializar Firebase Admin
//
// FIX (2026-07-14, incidente "dashboard no conecta con los datos"): esto
// antes se ejecutaba directo a nivel de módulo. Si FIREBASE_SERVICE_ACCOUNT_KEY
// faltaba o venía mal formado, JSON.parse(undefined) tiraba un SyntaxError
// en el IMPORT de este archivo. Como api/index.js importa todos los
// handlers de una sola vez en una única Serverless Function, ese error
// tumbaba el arranque de TODA la lambda — no solo el envío de push, sino
// /api/admin/kpis y cualquier otra ruta que no tuviera nada que ver con
// Firebase. Ahora el init se hace de forma perezosa y con try/catch: si
// falta la credencial, solo enviarPush() (y quien lo llame) falla, con un
// error claro — el resto del panel sigue funcionando.
let firebaseApp = null;
let firebaseInitError = null;

async function asegurarFirebase() {
  if (firebaseApp) return firebaseApp;
  if (firebaseInitError) throw firebaseInitError;
  try {
    const { initializeApp, cert, getApps } = await cargarFirebaseAdmin();
    // getApps() evita un segundo initializeApp() si, por algún motivo, el
    // módulo se llegara a evaluar más de una vez en el mismo proceso
    // (mismo resguardo defensivo que ya existía con el flag booleano).
    firebaseApp = getApps()[0] || initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY))
    });
    return firebaseApp;
  } catch (err) {
    firebaseInitError = new Error(`[_push] FIREBASE_SERVICE_ACCOUNT_KEY faltante o inválido: ${err.message}`);
    throw firebaseInitError;
  }
}

// Mismo motivo que el límite de notifAuto en _auto-push.js: enviarPush lo
// llaman pedidos.js/notif.js desde varios puntos (a veces en loop, ej.
// notificarOfertaRelampago recorre TODOS los usuarios de la empresa), y no
// hay ningún endpoint HTTP de por medio que lo frene con el rateLimit
// normal. Tope por usuario, no por empresa: acá lo que hay que evitar es
// mandarle un alud de notificaciones a UNA persona por un bug de reintento.
const limiteEnviosPush = rateLimitPorClave({ max: 30, windowMs: 60_000 });

// ── Guardar en notif_log (fire-and-forget, no bloquea) ────────────────────
// FIX (auditoría alertas críticas 2026-07-12): antes solo se llamaba a esto
// cuando enviadas > 0. Un intento sin destinatarios, sin dispositivos o con
// token inválido no dejaba ningún rastro en notif_log — indistinguible de
// "no había nada que avisar". Ahora se loguea siempre que haya logMeta,
// marcando entregada=false y el motivo cuando corresponda.
async function _logPush({ empresa_id, cliente_id, pedido_id, tipo, usuario_id, message_id, titulo, cuerpo, datos, dispositivos_alcanzados, entregada, motivo }) {
  await NotifRepo.registrarLog({
    empresa_id: empresa_id || null,
    cliente_id: cliente_id || null,
    pedido_id:  pedido_id  || null,
    tipo:       tipo || datos?.tipo || 'push',
    canal:      'push',
    message_id: message_id || null,
    entregada:  entregada !== undefined ? entregada : dispositivos_alcanzados > 0,
    motivo:     motivo || null,
    payload: {
      titulo,
      cuerpo,
      datos,
      usuario_id,
      dispositivos_alcanzados,
    },
  });
}

// ── Enviar Notificación Push ───────────────────────────────────────────────
// logMeta (opcional): { empresa_id, cliente_id, pedido_id, tipo }
// Cuando se provee, se guarda UN registro en notif_log por llamada (no por dispositivo).
export async function enviarPush(usuarioId, titulo, cuerpo, datos = {}, logMeta = null) {
  const firebaseApp = await asegurarFirebase();
  const { getMessaging } = await cargarFirebaseAdmin();
  try {
    if (await limiteEnviosPush(`enviarPush:${usuarioId}`)) {
      console.warn(`[PUSH] rate limit interno superado para usuario ${usuarioId}`);
      return { enviadas: 0, razon: 'rate_limit_interno' };
    }

    // 1. Obtener dispositivos registrados del usuario
    const { data: dispositivos, error: errorDispositivos } = await NotifRepo.obtenerTokensPushDeUsuario(usuarioId);

    if (errorDispositivos || !dispositivos || dispositivos.length === 0) {
      console.log('[PUSH] Sin dispositivos para:', usuarioId);
      if (logMeta) {
        let empresaId = logMeta.empresa_id || null;
        if (!empresaId) {
          empresaId = await NotifRepo.obtenerEmpresaIdDeUsuario(usuarioId);
        }
        _logPush({
          empresa_id: empresaId,
          cliente_id: logMeta.cliente_id || null,
          pedido_id:  logMeta.pedido_id  || null,
          tipo:       logMeta.tipo || datos?.tipo || 'push',
          usuario_id: usuarioId,
          titulo, cuerpo, datos,
          dispositivos_alcanzados: 0,
          entregada: false,
          motivo: errorDispositivos ? 'error_consultando_dispositivos' : 'sin_dispositivos',
        }).catch(e => console.error('[PUSH] Error en notif_log:', e.message));
      }
      return { enviadas: 0, razon: errorDispositivos ? 'error_consultando_dispositivos' : 'sin_dispositivos' };
    }

    // 2. Preparar mensaje
    const message = {
      notification: {
        title: titulo,
        body:  cuerpo,
      },
      data: datos,
      webpush: {
        fcmOptions: {
          link: datos.link || '/',
        },
      },
    };

    // 3. Enviar a cada dispositivo en paralelo (antes era secuencial: un
    // usuario con 3-4 dispositivos registrados sumaba 3-4 round-trips a FCM
    // uno detrás del otro dentro de esta misma invocación — mismo patrón de
    // acumulación de latencia que se corrigió en pushInternoHandler, y con
    // varios usuarios en juego terminaba comiéndose el timeout de 10s del
    // fetch de Supabase para las llamadas de este mismo request). Se
    // captura el primer message_id de FCM en orden de resolución.
    const messaging = getMessaging(firebaseApp);
    const resultadosDispositivos = await Promise.allSettled(
      dispositivos.map((dispositivo) =>
        messaging.send({ ...message, token: dispositivo.token_push })
      )
    );

    let enviadas    = 0;
    let primerMsgId = null;
    for (const r of resultadosDispositivos) {
      if (r.status === 'fulfilled') {
        if (!primerMsgId) primerMsgId = r.value;
        enviadas++;
      } else {
        console.error('[PUSH] Error enviando a dispositivo:', r.reason?.message || r.reason);
      }
    }

    // 4. Registrar en notif_log si viene logMeta (siempre, haya llegado o no —
    // FIX auditoría 2026-07-12: antes solo se logueaba si enviadas > 0, y un
    // fallo total (ej. todos los tokens vencidos) quedaba sin rastro)
    if (logMeta) {
      // Resolver empresa_id si no viene en logMeta
      let empresaId = logMeta.empresa_id || null;
      if (!empresaId) {
        empresaId = await NotifRepo.obtenerEmpresaIdDeUsuario(usuarioId);
      }

      _logPush({
        empresa_id:              empresaId,
        cliente_id:              logMeta.cliente_id || null,
        pedido_id:               logMeta.pedido_id  || null,
        tipo:                    logMeta.tipo || datos?.tipo || 'push',
        usuario_id:              usuarioId,
        message_id:              primerMsgId,
        titulo,
        cuerpo,
        datos,
        dispositivos_alcanzados: enviadas,
        entregada:               enviadas > 0,
        motivo:                  enviadas > 0 ? null : 'todos_los_tokens_fallaron',
      }).catch(e => console.error('[PUSH] Error en notif_log:', e.message));
    }

    return { enviadas };

  } catch (error) {
    console.error('[PUSH] Error en enviarPush:', error);
    throw error;
  }
}

// ── Enviar Notificación de Oferta Relámpago ────────────────────────────────
export async function notificarOfertaRelampago(empresaId, productoId, descuento, duracionMinutos) {
  try {
    // 1. Obtener los clientes de la empresa con usuario de portal activo.
    // FIX (auditoría notificaciones): antes traía TODOS los usuarios de la
    // empresa sin filtrar rol — le llegaba "¡Oferta Relámpago!" también a
    // dueno/admin/vendedor/depositero/chofer, no solo a los clientes.
    const { data: usuarios, error: errorUsuarios } = await NotifRepo.listarClientesActivosDeEmpresa(empresaId);

    if (errorUsuarios || !usuarios) return;

    // 2. Enviar notificación a cada usuario
    for (const usuario of usuarios) {
      await enviarPush(
        usuario.id,
        '¡Oferta Relámpago!',
        `${descuento}% de descuento en productos seleccionados`,
        {
          tipo:             'oferta_relampago',
          producto_id:      productoId,
          descuento:        String(descuento),
          duracion_minutos: String(duracionMinutos),
          link:             '/cliente/catalogo.html',
        },
        { empresa_id: empresaId, tipo: 'oferta_relampago' },
      );
    }

  } catch (error) {
    console.error('[PUSH] Error en notificarOfertaRelampago:', error);
  }
}

// ── Enviar Notificación de Deuda Vencida ───────────────────────────────────
export async function notificarDeudaVencida(clienteId, montoDeuda) {
  try {
    // Obtener usuario y empresa del cliente
    const usuario = await NotifRepo.obtenerUsuarioPorClienteId(clienteId);

    if (!usuario) return;

    await enviarPush(
      usuario.id,
      '⚠ Deuda Vencida',
      `Tenés una deuda de $${montoDeuda.toLocaleString()} vencida`,
      {
        tipo:       'deuda_vencida',
        cliente_id: clienteId,
        monto:      String(montoDeuda),
        link:       '/cliente/cuenta.html',
      },
      { empresa_id: usuario.empresa_id, cliente_id: clienteId, tipo: 'deuda_vencida' },
    );

  } catch (error) {
    console.error('[PUSH] Error en notificarDeudaVencida:', error);
  }
}

// ── Enviar Notificación de Pedido Entregado ────────────────────────────────
export async function notificarPedidoEntregado(pedidoId, clienteId) {
  try {
    const usuario = await NotifRepo.obtenerUsuarioPorClienteId(clienteId);

    if (!usuario) return;

    await enviarPush(
      usuario.id,
      'Pedido Entregado',
      `Tu pedido #${pedidoId.substring(0, 8)} ha sido entregado`,
      {
        tipo:      'pedido_entregado',
        pedido_id: pedidoId,
        link:      '/cliente/pedidos.html',
      },
      { empresa_id: usuario.empresa_id, cliente_id: clienteId, pedido_id: pedidoId, tipo: 'pedido_entregado' },
    );

  } catch (error) {
    console.error('[PUSH] Error en notificarPedidoEntregado:', error);
  }
}

// ── Enviar Notificación de Puntos Ganados ──────────────────────────────────
export async function notificarPuntosGanados(clienteId, puntos, razon) {
  try {
    const usuario = await NotifRepo.obtenerUsuarioPorClienteId(clienteId);

    if (!usuario) return;

    await enviarPush(
      usuario.id,
      'Puntos Ganados',
      `¡Ganaste ${Math.floor(puntos)} puntos! ${razon}`,
      {
        tipo:   'puntos_ganados',
        puntos: String(Math.floor(puntos)),
        link:   '/cliente/cuenta.html',
      },
      { empresa_id: usuario.empresa_id, cliente_id: clienteId, tipo: 'puntos_ganados' },
    );

  } catch (error) {
    console.error('[PUSH] Error en notificarPuntosGanados:', error);
  }
}

// ── 8.1: Notificar al cliente que su pedido está en camino (con deep link al mapa) ──
export async function notificarPedidoEnCamino(pedidoId, clienteId) {
  try {
    const usuario = await NotifRepo.obtenerUsuarioPorClienteId(clienteId);

    if (!usuario) return;

    const numLabel = pedidoId.substring(0, 8).toUpperCase();

    await enviarPush(
      usuario.id,
      'Tu pedido está en camino',
      `El pedido #${numLabel} salió y está en camino. Tocá para ver la ubicación en vivo.`,
      {
        tipo:      'pedido_en_camino',
        pedido_id: pedidoId,
        // Deep link: abre pedidos.html, expande la card y abre el mapa automáticamente
        link:      `/cliente/pedidos.html?id=${pedidoId}&mapa=1`,
      },
      {
        empresa_id: usuario.empresa_id,
        cliente_id: clienteId,
        pedido_id:  pedidoId,
        tipo:       'pedido_en_camino',
      },
    );

  } catch (error) {
    console.error('[PUSH] Error en notificarPedidoEnCamino:', error);
  }
}
