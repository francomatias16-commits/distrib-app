// frontend/admin/js/catalogo-meta.js
// Página "Catálogo de WhatsApp" (Configuración → Catálogo de WhatsApp).
//
// Mismo patrón que whatsapp-onboarding.js, pero para el permiso de
// catálogo (catalog_management), que Meta NO deja pedir con el diálogo de
// login clásico — necesita una Configuración de "Facebook Login for
// Business" aparte (META_CATALOG_LOGIN_CONFIG_ID en env-config.js), con
// el flujo implícito (accessToken directo, sin code) para evitar el error
// de redirect_uri que ya se resolvió así en el prototipo de referencia
// (ver README_INTEGRACION_META.md).

document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady.catch(() => {});
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }

  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent = new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  const elUsuario = document.getElementById('topbar-usuario');
  if (elUsuario) elUsuario.textContent = window.authCtx.perfil?.nombre || window.authCtx.perfil?.email || '';

  inicializarFacebookSDK();
  await cargarEstado();

  document.getElementById('btn-conectar-catalogo')?.addEventListener('click', onClickConectar);
  document.getElementById('btn-desconectar-catalogo')?.addEventListener('click', desconectarCatalogo);
  document.getElementById('btn-carga-inicial')?.addEventListener('click', () => correrSync('carga-inicial'));
  document.getElementById('btn-importar-meta')?.addEventListener('click', () => correrSync('importar'));
});

function _token() {
  return window.authCtx?.session?.access_token || '';
}

function inicializarFacebookSDK() {
  const appId = window.ENV?.WA_APP_ID;
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

async function cargarEstado() {
  const caja = document.getElementById('estado-actual');
  try {
    const resp = await fetch('/api/catalogo-meta/estado', {
      headers: { Authorization: `Bearer ${_token()}` },
    });
    const data = await resp.json();
    aplicarEstado(data);
  } catch {
    caja.innerHTML = cajaHtml('no-conectado', 'No se pudo verificar el estado de conexión.');
  }
}

function cajaHtml(clase, texto) {
  const icono = clase === 'conectado' ? ICONO_CHECK : ICONO_ALERTA;
  return `<div class="estado-box ${clase}"><span class="estado-icono">${icono}</span><span>${texto}</span></div>`;
}

const ICONO_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const ICONO_ALERTA = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

function aplicarEstado(data) {
  const caja = document.getElementById('estado-actual');
  const bloqueConectado = document.getElementById('bloque-conectado');
  const bloqueDesconectado = document.getElementById('bloque-desconectado');

  if (data?.conectado) {
    const fecha = data.connected_at ? new Date(data.connected_at).toLocaleDateString('es-AR') : '';
    caja.innerHTML = cajaHtml('conectado', `Catálogo conectado${fecha ? ' desde el ' + fecha : ''}.`);
    bloqueConectado.style.display = '';
    bloqueDesconectado.style.display = 'none';

    document.getElementById('info-sync-push').textContent = data.ultima_sync_push_at
      ? `Último envío al catálogo: ${new Date(data.ultima_sync_push_at).toLocaleString('es-AR')}`
      : 'Todavía no se subió ningún producto del panel al catálogo.';
    document.getElementById('info-sync-pull').textContent = data.ultima_sync_pull_at
      ? `Última importación desde WhatsApp: ${new Date(data.ultima_sync_pull_at).toLocaleString('es-AR')}`
      : 'Todavía no se importó nada desde el catálogo de WhatsApp.';
  } else {
    caja.innerHTML = cajaHtml('no-conectado', 'Todavía no conectaste el catálogo de WhatsApp de tu empresa.');
    bloqueConectado.style.display = 'none';
    bloqueDesconectado.style.display = '';
  }
}

function onClickConectar() {
  const btn = document.getElementById('btn-conectar-catalogo');
  const configId = window.ENV?.META_CATALOG_LOGIN_CONFIG_ID;

  if (!window.FB) {
    window.toast?.('El SDK de Facebook todavía está cargando, esperá un segundo y volvé a tocar el botón.', 'warn');
    return;
  }
  if (!configId) {
    window.toast?.('Falta configurar META_CATALOG_LOGIN_CONFIG_ID en env-config.js. Avisale al equipo técnico.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span>Conectando...';

  // Flujo implícito (sin response_type/override): el popup devuelve el
  // accessToken directo en authResponse, sin "code" que cambiar
  // server-to-server — evita el error de redirect_uri desalineado que dio
  // el intercambio por code en el prototipo de referencia.
  FB.login((response) => {
    if (response.authResponse && response.authResponse.accessToken) {
      enviarTokenAlBackend(response.authResponse.accessToken);
    } else {
      window.toast?.('Cancelaste o no se completó la autorización del catálogo.', 'warn');
      restaurarBotonConectar();
    }
  }, { config_id: configId });
}

function restaurarBotonConectar() {
  const btn = document.getElementById('btn-conectar-catalogo');
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = 'Conectar catálogo de WhatsApp';
}

async function enviarTokenAlBackend(catalog_token) {
  try {
    const resp = await fetch('/api/catalogo-meta/conectar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
      body: JSON.stringify({ catalog_token }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al conectar');

    window.toast?.('Catálogo conectado correctamente.', 'success');
    await cargarEstado();
  } catch (err) {
    window.toast?.(err.message || 'No se pudo conectar el catálogo.', 'error');
    restaurarBotonConectar();
  }
}

async function desconectarCatalogo() {
  if (!confirm('¿Desconectar el catálogo de WhatsApp? La sincronización automática se va a detener.')) return;

  try {
    const resp = await fetch('/api/catalogo-meta/desconectar', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${_token()}` },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al desconectar');

    window.toast?.('Catálogo desconectado.', 'success');
    await cargarEstado();
  } catch (err) {
    window.toast?.(err.message || 'No se pudo desconectar.', 'error');
  }
}

async function correrSync(svc) {
  const btnId = svc === 'carga-inicial' ? 'btn-carga-inicial' : 'btn-importar-meta';
  const btn = document.getElementById(btnId);
  const labelOriginal = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span>Procesando...';

  const url = svc === 'carga-inicial' ? '/api/catalogo-meta/carga-inicial' : '/api/catalogo-meta/importar';

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${_token()}` },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al sincronizar');

    mostrarResultado(svc, data);
    await cargarEstado();
  } catch (err) {
    window.toast?.(err.message || 'No se pudo completar la sincronización.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = labelOriginal;
  }
}

function mostrarResultado(svc, data) {
  const el = document.getElementById('resultado-sync');
  if (!el) return;

  if (svc === 'carga-inicial') {
    el.textContent = `Enviados ${data.enviados} de ${data.total_productos} productos al catálogo` +
      (data.vinculados?.length ? ` (${data.vinculados.length} ya existían en WhatsApp y se vincularon por nombre)` : '') +
      (data.omitidos?.length ? ` (${data.omitidos.length} omitidos por falta de foto o retailer_id)` : '') +
      (data.avisos?.length ? ` — ${data.avisos.length} nombre(s) ambiguo(s) sin vincular, revisar manualmente` : '') + '.';
  } else {
    el.textContent = `${data.total_en_whatsapp} productos en WhatsApp — ` +
      `${data.importados} nuevos, ${data.actualizados} actualizados` +
      (data.vinculados ? `, ${data.vinculados} vinculados por nombre a productos ya existentes en el panel` : '') +
      (data.con_avisos ? `, ${data.con_avisos} con avisos` : '') +
      (data.con_errores ? `, ${data.con_errores} con errores` : '') + '.';
  }
  el.style.display = '';
  window.toast?.('Sincronización completada.', 'success');
}
