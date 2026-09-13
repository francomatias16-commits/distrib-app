// frontend/shared/estado-empresa.js
//
// Bug de UX reportado: cuando una empresa queda suspendida (falta de pago,
// `saas_suspendida=true`) o dada de baja (`activa=false`), el panel admin
// ya sabe detectarlo y mostrar un mensaje claro (ver frontend/admin/js/auth.js
// + frontend/admin/suspendida.html). Pero los portales cliente y chofer NO
// tenían ningún chequeo: las policies RLS (basadas en get_empresa_id(), que
// exige empresa activa y no suspendida) simplemente devuelven 0 filas para
// cualquier tabla de negocio de esa empresa, así que el usuario solo veía
// pedidos/catálogo/remitos vacíos sin ninguna explicación — quedaba
// "adivinando" por qué no había datos.
//
// Este chequeo usa GET /api/auth/me (lib/handlers/auth.js → handleMe), que
// resuelve la empresa con el cliente de servicio (bypassea RLS) — por eso
// funciona incluso cuando las policies normales esconderían la fila de
// `empresas` por completo.
//
// Uso: agregar <script src="/frontend/shared/estado-empresa.js"></script>
// en cualquier página de /cliente o /chofer que ya cargue supabase-js y
// window.ENV (env-config.js). Se auto-ejecuta, no requiere llamarlo a mano.
// No reemplaza ni interfiere con el cliente `sb` propio de cada página —
// crea uno propio, de solo lectura de sesión, apuntando al mismo
// storageKey para leer la sesión ya persistida.

(function () {
  var STORAGE_KEYS = {
    cliente: 'sb-cliente-auth',
    chofer: 'sb-chofer-auth',
  };

  function detectarPortal() {
    var p = window.location.pathname;
    if (p.indexOf('/cliente') === 0) return 'cliente';
    if (p.indexOf('/chofer') === 0) return 'chofer';
    return null;
  }

  function mostrarBanner(empresa, portal) {
    if (document.getElementById('bannerEmpresaSuspendida')) return;

    var motivo = empresa.activa === false
      ? 'dada de baja'
      : 'con la cuenta temporalmente suspendida por falta de pago';
    var contacto = portal === 'cliente'
      ? 'Contactá directamente a tu distribuidora para más información.'
      : 'Contactá a la administración de la distribuidora para más información.';

    var overlay = document.createElement('div');
    overlay.id = 'bannerEmpresaSuspendida';
    overlay.setAttribute('role', 'alert');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:rgba(17,24,39,.94)', 'color:#fff',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px', 'text-align:center',
      'font-family:inherit', 'backdrop-filter:blur(2px)'
    ].join(';');
    overlay.innerHTML =
      '<div style="max-width:420px;">' +
        '<div style="font-size:40px;margin-bottom:12px;">&#9208;</div>' +
        '<div style="font-size:18px;font-weight:600;margin-bottom:8px;">' +
          'La distribuidora está ' + motivo +
        '</div>' +
        '<div style="font-size:14px;opacity:.85;line-height:1.5;">' +
          'Por eso no se están mostrando datos en esta sección. ' + contacto +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  async function verificar() {
    var portal = detectarPortal();
    var storageKey = STORAGE_KEYS[portal];
    if (!storageKey || !window.supabase || !window.ENV) return;

    var accessToken;
    try {
      var sbTmp = window.supabase.createClient(
        window.ENV.SUPABASE_URL,
        window.ENV.SUPABASE_ANON_KEY,
        { auth: { storageKey: storageKey } }
      );
      var sesion = await sbTmp.auth.getSession();
      accessToken = sesion && sesion.data && sesion.data.session
        ? sesion.data.session.access_token
        : null;
    } catch (e) {
      return; // sin sesión legible, no hay nada que verificar acá
    }
    if (!accessToken) return;

    try {
      var res = await fetch('/api/auth/me', {
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      if (!res.ok) return;
      var body = await res.json();
      var empresa = body && body.empresa;
      if (empresa && (empresa.activa === false || empresa.saas_suspendida === true)) {
        mostrarBanner(empresa, portal);
      }
    } catch (e) {
      console.warn('[estado-empresa] no se pudo verificar el estado de la empresa:', e && e.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', verificar);
  } else {
    verificar();
  }
})();
