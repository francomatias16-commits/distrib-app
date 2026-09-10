// frontend/admin/js/whatsapp-catalog.js
// Migración 610 — tarjeta "Sincronizar catálogo con WhatsApp" en
// whatsapp-onboarding.html. Independiente del flujo de Embedded Signup de
// mensajería (whatsapp-onboarding.js, arriba en la misma página): usa el
// mismo SDK de Facebook ya cargado por esa página, pero con otro alcance
// de permisos (catalog_management + business_management, sin
// config_id/featureType de Embedded Signup) — es un login de catálogo
// (Commerce Manager), no de WhatsApp Business.

const ICONO_CHECK_CAT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const ICONO_ALERTA_CAT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady.catch(() => {});
  if (!window.authCtx) return; // whatsapp-onboarding.js ya redirige a login si hace falta

  const perfil = window.authCtx.perfil;
  if (!['dueno', 'admin'].includes(perfil.rol)) {
    const card = document.getElementById('catalogo-card');
    if (card) {
      card.innerHTML = '<p style="font-size:13px; color:var(--color-text-light);">Solo el dueño o un administrador puede gestionar el catálogo de WhatsApp.</p>';
    }
    return;
  }

  document.getElementById('btn-conectar-catalogo')?.addEventListener('click', onClickConectarCatalogo);
  document.getElementById('btn-sincronizar-catalogo')?.addEventListener('click', onClickSincronizarCatalogo);
  document.getElementById('btn-desconectar-catalogo')?.addEventListener('click', onClickDesconectarCatalogo);

  cargarEstadoCatalogo();
});

function _token() {
  return window.authCtx?.session?.access_token || '';
}

async function cargarEstadoCatalogo() {
  const box = document.getElementById('catalogo-estado-actual');
  try {
    const resp = await fetch('/api/whatsapp-catalog?_svc=estado', {
      headers: { Authorization: `Bearer ${_token()}` },
    });
    const data = await resp.json();
    if (!resp.ok) {
      box.innerHTML = `<div class="estado-box no-conectado"><span class="estado-icono">${ICONO_ALERTA_CAT}</span><span>${data.error || 'No se pudo verificar el estado del catálogo.'}</span></div>`;
      return;
    }
    pintarEstadoCatalogo(data);
  } catch (err) {
    box.innerHTML = `<div class="estado-box no-conectado"><span class="estado-icono">${ICONO_ALERTA_CAT}</span><span>Error de conexión al verificar el catálogo.</span></div>`;
  }
}

function pintarEstadoCatalogo(data) {
  const box = document.getElementById('catalogo-estado-actual');
  const btnConectar = document.getElementById('btn-conectar-catalogo');
  const btnSincronizar = document.getElementById('btn-sincronizar-catalogo');
  const btnDesconectar = document.getElementById('btn-desconectar-catalogo');
  const formConectar = document.getElementById('catalogo-form-conectar');

  if (data.conectado) {
    const ultimaSync = data.catalog_ultima_sync_en
      ? new Date(data.catalog_ultima_sync_en).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
      : 'todavía no se sincronizó';
    box.innerHTML = `
      <div class="estado-box conectado">
        <span class="estado-icono">${ICONO_CHECK_CAT}</span>
        <span>Catálogo conectado (ID ${data.catalog_id}). Última sincronización: ${ultimaSync}.</span>
      </div>`;
    formConectar.style.display = 'none';
    btnConectar.style.display = 'none';
    btnSincronizar.style.display = 'inline-flex';
    btnDesconectar.style.display = 'inline-flex';
    pintarResumenCatalogo(data.resumen);
  } else {
    box.innerHTML = `
      <div class="estado-box no-conectado">
        <span class="estado-icono">${ICONO_ALERTA_CAT}</span>
        <span>Todavía no conectaste el catálogo de WhatsApp.</span>
      </div>`;
    formConectar.style.display = 'block';
    btnConectar.style.display = 'inline-flex';
    btnSincronizar.style.display = 'none';
    btnDesconectar.style.display = 'none';
    document.getElementById('catalogo-resumen').style.display = 'none';
  }
}

function pintarResumenCatalogo(resumen) {
  const el = document.getElementById('catalogo-resumen');
  if (!resumen || !resumen.total) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `
    <strong>${resumen.total}</strong> productos sincronizados —
    ${resumen.ok || 0} al día,
    ${resumen.importados || 0} importados desde WhatsApp,
    ${resumen.conflicto || 0} con conflicto de precio a revisar,
    ${resumen.error || 0} con errores.
    ${resumen.conflicto ? '<br/><span style="color:#b45309;">Hay precios que no coinciden — revisalos en el listado de Productos antes de que se note en el catálogo público.</span>' : ''}
  `;
}

// ── Conectar ────────────────────────────────────────────────────────────
function onClickConectarCatalogo() {
  const formConectar = document.getElementById('catalogo-form-conectar');
  if (formConectar.style.display === 'none') {
    // Primer click: solo mostramos el campo del catalog_id, todavía no
    // disparamos el login de Facebook.
    formConectar.style.display = 'block';
    document.getElementById('btn-conectar-catalogo').textContent = 'Continuar';
    return;
  }

  const catalogId = document.getElementById('input-catalog-id').value.trim();
  if (!catalogId) {
    window.toast?.('Pegá el ID de tu catálogo de Meta antes de continuar.', 'warn');
    return;
  }

  if (!window.FB) {
    window.toast?.('El SDK de Facebook todavía está cargando, esperá un segundo y volvé a tocar el botón.', 'warn');
    return;
  }

  const btn = document.getElementById('btn-conectar-catalogo');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span>Conectando...';

  FB.login((response) => {
    if (response.authResponse && response.authResponse.code) {
      enviarConexionCatalogoAlBackend(response.authResponse.code, catalogId);
    } else {
      window.toast?.('No se completó el inicio de sesión con Facebook.', 'warn');
      restaurarBotonConectar();
    }
  }, {
    scope: 'catalog_management,business_management',
    response_type: 'code',
    override_default_response_type: true,
  });
}

async function enviarConexionCatalogoAlBackend(code, catalogId) {
  try {
    const resp = await fetch('/api/whatsapp-catalog?_svc=conectar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
      body: JSON.stringify({ code, catalog_id: catalogId }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      window.toast?.(data.error || 'No se pudo conectar el catálogo.', 'error');
      restaurarBotonConectar();
      return;
    }
    window.toast?.(`¡Catálogo conectado${data.nombre_catalogo ? ` (${data.nombre_catalogo})` : ''}! Ya podés sincronizar.`, 'success');
    restaurarBotonConectar();
    cargarEstadoCatalogo();
  } catch (err) {
    window.toast?.('Error de conexión con el servidor.', 'error');
    restaurarBotonConectar();
  }
}

function restaurarBotonConectar() {
  const btn = document.getElementById('btn-conectar-catalogo');
  btn.disabled = false;
  btn.textContent = 'Conectar catálogo de WhatsApp';
}

// ── Sincronizar ─────────────────────────────────────────────────────────
async function onClickSincronizarCatalogo() {
  const btn = document.getElementById('btn-sincronizar-catalogo');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span>Sincronizando...';

  try {
    const resp = await fetch('/api/whatsapp-catalog?_svc=sincronizar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${_token()}` },
    });
    const data = await resp.json();
    if (!resp.ok) {
      window.toast?.(data.error || 'No se pudo sincronizar el catálogo.', 'error');
    } else {
      window.toast?.(
        `Listo: ${data.creados_en_meta || 0} altas en WhatsApp, ${data.actualizados_en_meta || 0} actualizados, ${data.importados || 0} importados, ${data.conflictos || 0} conflictos de precio.`,
        data.conflictos ? 'warn' : 'success'
      );
      cargarEstadoCatalogo();
    }
  } catch (err) {
    window.toast?.('Error de conexión al sincronizar.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sincronizar ahora';
  }
}

// ── Desconectar ─────────────────────────────────────────────────────────
async function onClickDesconectarCatalogo() {
  const ok = window.confirm('Vas a desconectar el catálogo de WhatsApp. Distrib deja de sincronizar productos hasta que lo reconectes. ¿Confirmás?');
  if (!ok) return;

  const btn = document.getElementById('btn-desconectar-catalogo');
  btn.disabled = true;

  try {
    const resp = await fetch('/api/whatsapp-catalog?_svc=desconectar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${_token()}` },
    });
    const data = await resp.json();
    if (!resp.ok) {
      window.toast?.(data.error || 'No se pudo desconectar el catálogo.', 'error');
    } else {
      window.toast?.('Catálogo desconectado.', 'success');
      cargarEstadoCatalogo();
    }
  } catch (err) {
    window.toast?.('Error de conexión al desconectar.', 'error');
  } finally {
    btn.disabled = false;
  }
}
