// frontend/admin/js/whatsapp-onboarding.js
// Etapa 7 del plan de WhatsApp bidireccional — botón "Usar mi WhatsApp
// Business existente" (Coexistencia).
//
// FIX (2026-08-04): existía también la opción "Crear un WhatsApp Business
// nuevo" (WABA nuevo desde cero). Se sacó por completo — Meta solo deja
// crear un WABA nuevo con un número que no tenga NINGUNA cuenta de
// WhatsApp activa en ese momento, algo que en la práctica nunca aplica a
// un número personal ya en uso (ver "This phone number is already
// registered..." de Meta) y generaba confusión: la mayoría de los dueños
// probaban esa opción primero con su número de siempre y quedaban
// trabados. Coexistencia es el único camino soportado ahora.
//
// Flujo (ver PLAN_whatsapp_bidireccional_seguimiento.md, Etapa 7.1):
//   1. Se carga el JS SDK de Facebook y se abre el flujo de Embedded Signup
//      (FB.login con el config_id de WA_EMBEDDED_CONFIG_ID y
//      featureType='whatsapp_business_app_onboarding', que le pide a Meta
//      el modo Coexistencia: conectar el número que ya se usa en la app de
//      WhatsApp Business del celular, sin crear nada nuevo).
//   2. Meta devuelve un `code` de un solo uso vía postMessage (evento
//      'WA_EMBEDDED_SIGNUP', sub-evento 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')
//      y, por separado, FB.login devuelve el mismo `code` en su callback —
//      se usan los dos: el postMessage trae el waba_id, el callback de
//      FB.login confirma el code. OJO: en Coexistencia el postMessage solo
//      trae `waba_id` — el phone_number_id lo resuelve el backend
//      server-to-server (ver whatsappEmbeddedSignupHandler).
//   3. Se manda { code, waba_id } al backend (/api/notif/whatsapp-embedded-signup),
//      que hace el intercambio server-to-server y suscribe los webhooks —
//      el número ya viene registrado por Meta en este modo, no hace falta
//      un paso extra de registro.
//
// No se guarda ningún dato sensible acá (App Secret, tokens) — todo eso
// vive solo en el backend.

let _wabaId = null;

// Iconos inline (14px / stroke-width 2, mismo criterio que el resto del
// barrido de emojis del panel admin: nada de emoji/Unicode suelto).
const ICONO_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const ICONO_ALERTA = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady.catch(() => {});
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }

  const perfil = window.authCtx.perfil;
  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  if (!['dueno', 'admin'].includes(perfil.rol)) {
    document.querySelector('.onboarding-card').innerHTML =
      '<p style="font-size:13px; color:var(--color-text-light);">Solo el dueño o un administrador puede conectar el WhatsApp de la empresa.</p>';
    return;
  }

  cargarEstadoActual();
  inicializarFacebookSDK();

  document.getElementById('btn-conectar-wa').addEventListener('click', lanzarEmbeddedSignup);

  // Meta manda un postMessage con waba_id cuando el usuario completa (o
  // cancela) el flujo dentro del popup.
  window.addEventListener('message', (event) => {
    if (!event.origin.endsWith('facebook.com')) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type !== 'WA_EMBEDDED_SIGNUP') {
        // Log temporal: confirma que SÍ llegan mensajes de facebook.com,
        // aunque no sean del Embedded Signup (ayuda a distinguir "no llega
        // nada" de "llega pero con otro type").
        console.log('[whatsapp-onboarding] postMessage de facebook.com con otro type:', data.type, data);
        return;
      }
      // Log temporal de diagnóstico: si esto vuelve a fallar, abrí la consola
      // (F12) antes de tocar "Conectar mi WhatsApp" y fijate qué evento/data
      // llega acá exactamente. OJO: usar console.log (no console.debug), que
      // Chrome DevTools oculta por default bajo "Default levels".
      console.log('[whatsapp-onboarding] WA_EMBEDDED_SIGNUP', data.event, data.data);
      if (data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
        // Coexistencia: Meta solo manda waba_id acá — el phone_number_id
        // lo resuelve el backend server-to-server (ver comentario de
        // cabecera y whatsappEmbeddedSignupHandler).
        _wabaId = data.data?.waba_id || null;
      } else if (data.event === 'CANCEL') {
        window.toast?.('Cancelaste la conexión con WhatsApp antes de terminar.', 'warn');
        restaurarBoton();
      }
    } catch (err) {
      // Log temporal: si Meta manda el dato en un formato que no es JSON
      // string (por ejemplo ya como objeto), antes esto se tragaba en
      // silencio. Ahora queda visible para diagnóstico.
      console.log('[whatsapp-onboarding] postMessage de facebook.com no parseable como JSON:', event.data, err);
    }
  });
});

async function cargarEstadoActual() {
  const box = document.getElementById('estado-actual');

  // El estado de conexión se lee directo por Supabase (RLS ya scopea por
  // empresa) — no hace falta pasar por el backend solo para leer.
  const sb = window.authCtx.sb;
  const empresaId = window.authCtx.perfil.empresa_id;
  const { data, error } = await sb
    .from('v_empresa_whatsapp_estado')
    .select('verified_name, phone_number_id, necesita_reconexion, es_coexistencia, desconectado_en, actualizado_en')
    .eq('empresa_id', empresaId)
    .maybeSingle();

  if (error || !data) {
    box.innerHTML = `
      <div class="estado-box no-conectado">
        <span class="estado-icono">${ICONO_ALERTA}</span>
        <span>Todavía no conectaste un número de WhatsApp propio. Mientras tanto, el bot sigue usando el número de prueba configurado por el equipo técnico.</span>
      </div>`;
    return;
  }

  // v295: si el token dejó de funcionar (Meta devolvió error 190 en el
  // último envío), se marca desde el backend en necesita_reconexion —
  // mostramos un estado distinto al de "conectado" para que no pase
  // desapercibido en el panel. Migración 436: en Coexistencia, la misma
  // bandera también se prende cuando el dueño desconectó el número desde
  // la propia app de WhatsApp Business (`desconectado_en` presente) — el
  // mensaje es distinto porque ahí no hay nada "roto", fue una decisión
  // del dueño.
  if (data.necesita_reconexion) {
    const motivo = data.desconectado_en
      ? 'desconectaste este número de distrib desde la app de WhatsApp Business'
      : 'dejó de funcionar y necesita reconectarse';
    box.innerHTML = `
      <div class="estado-box no-conectado">
        <span class="estado-icono">${ICONO_ALERTA}</span>
        <span>El WhatsApp${data.verified_name ? ` de <strong>${escaparHtml(data.verified_name)}</strong>` : ''} ${motivo}. Tocá el botón de abajo para volver a conectarlo.</span>
      </div>`;
    document.getElementById('btn-conectar-wa').textContent = 'Reconectar mi WhatsApp';
    return;
  }

  box.innerHTML = `
    <div class="estado-box conectado">
      <span class="estado-icono">${ICONO_CHECK}</span>
      <span>WhatsApp conectado${data.verified_name ? `: <strong>${escaparHtml(data.verified_name)}</strong>` : ''}. Tus clientes ya pueden escribirle directamente a este número.</span>
    </div>`;
  document.getElementById('btn-conectar-wa').textContent = 'Reconectar / cambiar número';
}

function inicializarFacebookSDK() {
  const appId = window.ENV?.WA_APP_ID;
  if (!appId || appId === 'COMPLETAR_CON_TU_APP_ID') {
    console.warn('[whatsapp-onboarding] WA_APP_ID no configurado en env-config.js — el botón no va a funcionar todavía.');
  }

  window.fbAsyncInit = function () {
    FB.init({ appId, cookie: true, xfbml: true, version: 'v22.0' });
  };
  (function (d, s, id) {
    if (d.getElementById(id)) return;
    const js = d.createElement(s);
    js.id = id;
    js.src = 'https://connect.facebook.net/es_LA/sdk.js';
    js.defer = true;
    d.getElementsByTagName('head')[0].appendChild(js);
  })(document, 'script', 'facebook-jssdk');
}

// Texto por defecto del botón, para poder restaurarlo tal cual estaba
// antes de tocarlo.
const LABEL_BOTON_DEFAULT = 'Usar mi WhatsApp Business existente';

function lanzarEmbeddedSignup() {
  const btn = document.getElementById('btn-conectar-wa');
  const configId = window.ENV?.WA_EMBEDDED_CONFIG_ID;

  if (!window.FB) {
    window.toast?.('El SDK de Facebook todavía está cargando, esperá un segundo y volvé a tocar el botón.', 'warn');
    return;
  }
  if (!configId || configId === 'COMPLETAR_CON_TU_CONFIGURATION_ID') {
    window.toast?.('Falta configurar WA_EMBEDDED_CONFIG_ID en el servidor. Avisale al equipo técnico.', 'error');
    return;
  }

  _wabaId = null;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span>Conectando...';

  FB.login((response) => {
    if (response.authResponse && response.authResponse.code) {
      enviarAlBackend(response.authResponse.code);
    } else {
      window.toast?.('No se completó el inicio de sesión con Facebook.', 'warn');
      restaurarBoton();
    }
  }, {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    // Coexistencia: featureType='whatsapp_business_app_onboarding' hace que
    // Meta ofrezca conectar el número existente en vez de crear un WABA
    // nuevo (ver "Onboard WhatsApp Business app users").
    extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
  });
}

async function enviarAlBackend(code) {
  // El postMessage de WA_EMBEDDED_SIGNUP puede llegar unos milisegundos (a
  // veces más de medio segundo) después que el callback de FB.login — en vez
  // de esperar un tiempo fijo, reintentamos en cortos intervalos hasta 2.5s.
  // Solo hace falta esperar el waba_id (el phone_number_id lo resuelve el
  // backend, ver comentario de cabecera).
  const intentosMax = 12; // 12 * 200ms = 2.4s
  for (let i = 0; i < intentosMax && !_wabaId; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!_wabaId) {
    window.toast?.('No se pudo obtener el número conectado. Probá de nuevo.', 'error');
    console.warn('[whatsapp-onboarding] No llegó waba_id por postMessage.');
    restaurarBoton();
    return;
  }

  try {
    const resp = await fetch('/api/notif/whatsapp-embedded-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
      body: JSON.stringify({ code, waba_id: _wabaId, feature_type: 'coexistencia' }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      window.toast?.(data.error || 'No se pudo conectar el WhatsApp.', 'error');
      restaurarBoton();
      return;
    }
    window.toast?.('¡WhatsApp conectado! Seguí usando la app de siempre — en unos minutos vas a ver también tu historial de chats acá.', 'success');
    restaurarBoton();
    await cargarEstadoActual();
  } catch (err) {
    window.toast?.('Error de conexión con el servidor. Probá de nuevo.', 'error');
    restaurarBoton();
  }
}

function restaurarBoton() {
  const btn = document.getElementById('btn-conectar-wa');
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = LABEL_BOTON_DEFAULT;
}

function _token() {
  return window.authCtx?.session?.access_token || '';
}

function escaparHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
