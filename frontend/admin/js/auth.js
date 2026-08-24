

// frontend/admin/js/auth.js
// Autenticación del panel admin. Acceso por defecto: dueño/admin.
// Una página puede ampliar los roles permitidos solo para sí misma con
// window.PAGINA_ROLES_PERMITIDOS (ver Etapa 5 del POS, más abajo).
// Cargado en TODAS las páginas admin — expone window.authCtx = { user, perfil, sb }
//
// Etapa 3 (v73, auditoría v70 — sección 3.1a / plan de acción ítem 3):
// cachea perfil+empresa en sessionStorage para no repetir los round-trips a
// `usuarios` y `empresas` en cada una de las 27 páginas del admin (antes:
// hasta 2 round-trips por carga, incluyendo un "fallback" que repetía
// textualmente la misma query fallida). TTL corto (5 min) a propósito:
// no queremos servir un rol/perfil revocado durante toda la sesión del tab
// solo por tener el dato en caché. sessionStorage ya se limpia sola al
// cerrar la pestaña; el TTL es una capa extra de seguridad, no el único
// mecanismo de expiración.

(async function () {
  if (!window.supabaseClient) {
    window.supabaseClient = window.supabase.createClient(
      window.ENV?.SUPABASE_URL || '',
      window.ENV?.SUPABASE_ANON_KEY || '',
      { auth: { storageKey: 'sb-admin-auth' } }
    );
  }
  const sb = window.supabaseClient;

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = '/admin/login?next=' + encodeURIComponent(window.location.pathname);
    return;
  }

  // ── Etapa 3: caché de perfil/empresa en sessionStorage ───────────────────
  const AUTH_CACHE_KEY = 'dv_authctx_cache_v1';
  const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

  function leerCacheAuth(uid) {
    try {
      const raw = sessionStorage.getItem(AUTH_CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || c.uid !== uid || !c.perfil) return null;
      if (Date.now() - c.ts > AUTH_CACHE_TTL_MS) return null;
      return c.perfil;
    } catch (e) {
      return null; // sessionStorage corrupto/inaccesible (modo privado) — no es fatal
    }
  }

  function guardarCacheAuth(uid, perfil) {
    try {
      sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ uid, perfil, ts: Date.now() }));
    } catch (e) {
      console.warn('[auth] No se pudo cachear el perfil (no crítico):', e?.message);
    }
  }

  window.__limpiarCacheAuth = function () {
    try { sessionStorage.removeItem(AUTH_CACHE_KEY); } catch (e) {}
  };

  let perfil = leerCacheAuth(session.user.id);
  let empresaResuelta = !!perfil; // si vino de caché, ya tenía empresa resuelta y válida

  if (perfil) {
    console.debug('[auth] perfil/empresa servidos desde caché de sesión (sin round-trip)');
  } else {
    // Auditoría Etapa 2 (v232, hallazgo Alto): se exige activo=true acá
    // porque ni las policies de RLS ni get_empresa_id()/get_rol_usuario()
    // filtraban por este campo — un usuario desactivado seguía operando
    // el panel completo hasta que expiraba su JWT. Este .eq() es la
    // primera de tres capas del fix (ver migración de RLS/funciones).
    //
    // Etapa 3 (hallazgo Alta): antes esto trataba cualquier error igual
    // (red caída === usuario inactivo) y redirigía sin explicación. Ahora
    // distinguimos por error.code: PGRST116 (PostgREST, 0 filas con
    // .single()) es un caso real de "usuario no encontrado/inactivo" y no
    // tiene sentido reintentar; cualquier otro error (timeout, red, 5xx)
    // se considera transitorio y se reintenta una vez con feedback visible.
    async function cargarPerfilConReintento(intentosRestantes = 2) {
      const { data, error } = await sb
        .from('usuarios')
        .select('id, nombre, email, rol, empresa_id, solo_lectura')
        .eq('id', session.user.id)
        .eq('activo', true)
        .single();

      if (!error) return { perfilDB: data, error: null };

      if (error.code === 'PGRST116') {
        // 0 filas: o no existe el usuario, o activo=false. No es transitorio.
        return { perfilDB: null, error };
      }

      if (intentosRestantes > 1) {
        window.mostrarToast?.('No pudimos verificar tu sesión, reintentando…', 'warning');
        await new Promise((r) => setTimeout(r, 900));
        return cargarPerfilConReintento(intentosRestantes - 1);
      }

      return { perfilDB: null, error };
    }

    const { perfilDB, error } = await cargarPerfilConReintento();

    if (error || !perfilDB) {
      // Log completo (código + status), no solo el mensaje, para diagnóstico real.
      console.error('[auth] Error cargando perfil:', {
        code: error?.code, message: error?.message, status: error?.status,
      });
      await sb.auth.signOut();
      const motivo = error?.code === 'PGRST116' ? 'usuario_inactivo' : 'red';
      window.location.href = '/admin/login?error=' + motivo;
      return;
    }

    perfil = perfilDB;

    // Cargar empresa en query separada (evita RLS circular en join)
    const { data: empresaData } = await sb
      .from('empresas')
      .select('id, nombre, logo_url, cuit, activa, saas_suspendida, saas_plan, saas_trial_fin, saas_precio_mes')
      .eq('id', perfil.empresa_id)
      .single();

    // v85: verificar que la empresa esté activa (no suspendida/dada de baja)
    if (empresaData && empresaData.activa === false) {
      window.__limpiarCacheAuth();
      await sb.auth.signOut();
      window.location.href = '/admin/login?error=empresa_inactiva';
      return;
    }

    // v148: verificar suspensión SaaS — no hacer logout, ir a página de pago
    if (empresaData && empresaData.saas_suspendida === true) {
      window.__limpiarCacheAuth();
      // No deslogueamos — suspendida.html necesita la sesión para cargar datos
      window.location.href = '/admin/suspendida';
      return;
    }

    if (empresaData) {
      perfil.empresas = empresaData;
      empresaResuelta = true;
    } else {
      // Antes (pre-etapa3) esto reintentaba la MISMA query con el mismo filtro
      // (auditoría v70, 3.1a) — si fallaba por timing de RLS, fallaba igual la
      // segunda vez. Usamos un objeto mínimo y NO marcamos empresaResuelta,
      // así esta carga no se cachea y la próxima página reintenta de verdad.
      perfil.empresas = { id: perfil.empresa_id, nombre: '', logo_url: null, cuit: null };
    }

    // Solo cacheamos resultados "buenos" — si la empresa no se resolvió,
    // preferimos que la próxima carga vuelva a intentar contra la DB.
    if (empresaResuelta) {
      guardarCacheAuth(session.user.id, perfil);
    }
  }

  // Acceso por defecto: dueño/admin en todas las páginas. Una página puede
  // ampliar esto declarando window.PAGINA_ROLES_PERMITIDOS en un <script>
  // inline ANTES de cargar este archivo (ver pos.html, Etapa 5: habilita
  // al rol vendedor a operar el punto de venta sin tocar el resto del panel).
  const ROLES_ADMIN = window.PAGINA_ROLES_PERMITIDOS || ['dueno', 'admin'];
  if (!ROLES_ADMIN.includes(perfil.rol)) {
    window.__limpiarCacheAuth();
    window.location.href = '/admin/login';
    return;
  }

  window.authCtx = { user: session.user, session, perfil, sb };

  // Notificar a auth-ready.js (Etapa 2) y a nav.js (compatibilidad legado)
  window.dispatchEvent(new CustomEvent('authReady'));
  window.dispatchEvent(new CustomEvent('authListo', { detail: { rol: perfil.rol } }));

  // ── Datos de empresa en sidebar + topbar ───────────────────────────────
  const empresa = perfil.empresas;
  if (empresa) {
    const empresaEl = document.getElementById('sidebar-empresa');
    if (empresaEl) empresaEl.textContent = empresa.nombre || '';

    // v744 pintaba este mismo logo en dos lugares: #sidebar-logo (adentro
    // del cajón "Menú principal") y #topbar-logo (junto al botón del
    // menú, visible sin abrir nada). v907 — Pedido directo: se saca de la
    // barra superior por quedar redundante con el logo que ya se ve en el
    // chip de usuario (#topbar-avatar-ini, ver topbar-widgets.js). Queda
    // solo el pintado del sidebar.
    const pintarLogoEn = (elId) => {
      const el = document.getElementById(elId);
      if (!el) return;
      if (empresa.logo_url) {
        el.innerHTML = '';
        const img = document.createElement('img');
        img.src   = empresa.logo_url;
        img.alt   = empresa.nombre || 'Logo';
        img.onerror = () => {
          el.innerHTML  = '';
          el.textContent = empresa.nombre?.charAt(0)?.toUpperCase() || 'D';
        };
        el.appendChild(img);
        el.hidden = false;
      } else {
        el.textContent = empresa.nombre?.charAt(0)?.toUpperCase() || 'D';
        el.hidden = false;
      }
    };

    pintarLogoEn('sidebar-logo');
  }

  // Nombre de usuario en el topbar
  const userEl = document.getElementById('topbar-usuario');
  if (userEl) {
    userEl.textContent = perfil.nombre || perfil.email;
    // [Limpieza zócalo] Badge de rol ("ADMIN") retirado a pedido — el
    // chip de usuario ahora muestra solo avatar + nombre, sin el rol.
  }

  // Sin roles internos: no hay restricciones visuales ni de menú que aplicar.
  // (dueño/admin ven el panel completo)

  // ── 456: banner de modo demostración (usuario solo_lectura) ─────────────
  // El bloqueo real de escritura vive en el backend (dispatcher, ver
  // lib/solo-lectura.js) — esto es solo la señal visual para que quien
  // entra por "Ver demo en vivo" sepa que puede navegar todo el sistema
  // pero los guardados no se van a aplicar.
  if (perfil.solo_lectura) {
    document.body.classList.add('modo-demo-solo-lectura');
    const banner = document.createElement('div');
    banner.id = 'banner-demo-solo-lectura';
    banner.textContent = 'Estás viendo una demostración en vivo — podés navegar todo el sistema, pero los cambios no se guardan.';
    banner.style.cssText = [
      'position:sticky', 'top:0', 'left:0', 'right:0', 'z-index:10000',
      'background:#6A9873', 'color:#fff', 'font:600 13px/1.4 var(--sans, system-ui)',
      'text-align:center', 'padding:8px 16px',
      // 456-fix: flex:none + width:100% son un respaldo explícito por si
      // este banner terminara insertado (por error o por HTML futuro que
      // cambie la jerarquía) como flex-item de un contenedor en fila —
      // evita que vuelva a estirarse verticalmente como pasó cuando se
      // insertaba en `body` (display:flex, fila).
      'flex:none', 'width:100%',
    ].join(';');
    // 456-fix (bug real, no extensión): `body` es `display:flex` SIN
    // flex-direction, es decir fila (sidebar + .layout uno al lado del
    // otro). Insertar el banner con document.body.prepend() lo convertía
    // en un tercer flex-item de esa fila y, al no tener ancho propio,
    // `align-items:stretch` (default) lo estiraba a 100% de la altura →
    // la franja naranja de pantalla completa que tapaba todo el admin.
    // `.layout` en cambio es flex-direction:column, así que insertarlo
    // ahí lo vuelve una barra normal arriba del contenido, y el
    // `position:sticky` funciona como corresponde dentro de esa columna.
    const layoutEl = document.querySelector('.layout');
    if (layoutEl) {
      layoutEl.prepend(banner);
    } else {
      // Fallback por si alguna página no tiene `.layout` (no debería pasar
      // en el admin, pero mejor no romper el login si faltara el selector).
      document.body.prepend(banner);
    }
  }

  // ── Helpers globales ───────────────────────────────────────────────────

  window.cerrarSesion = async function () {
    window.__limpiarCacheAuth();
    // FIX BUG-03: logout limpiaba sessionStorage y hacía signOut, pero
    // nunca tocaba Cache Storage del SW (networkFirst/staleWhileRevalidate
    // cachean páginas /admin/* y respuestas de API bajo un cache global por
    // origin, sin namespacing por empresa/usuario). En un dispositivo
    // compartido, el próximo login podía servir en modo offline una
    // respuesta cacheada de la sesión anterior. Se le pide al SW que vacíe
    // ese cache antes de redirigir, con timeout corto para no bloquear el
    // logout si el SW no responde (p.ej. sin SW registrado).
    // Nota: no se borran las bases IndexedDB del outbox offline (POS,
    // cobros, stock) — podrían tener mutaciones del usuario aún sin
    // sincronizar, y ya filtran por empresa_id al leer (Etapa 4 del plan
    // offline); la limpieza completa de esas colas queda fuera de este fix
    // (ver SYNC-04, que cubre el caso de registros legacy sin empresa_id).
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      try {
        await Promise.race([
          new Promise((resolve) => {
            const chan = new MessageChannel();
            chan.port1.onmessage = () => resolve();
            navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_ON_LOGOUT' }, [chan.port2]);
          }),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch (e) {
        console.warn('[auth] No se pudo limpiar el cache del SW al cerrar sesión (no crítico):', e?.message);
      }
    }
    await sb.auth.signOut();
    window.location.href = '/admin/login';
  };

  /**
   * Verifica si el usuario tiene uno de los roles indicados.
   * Uso: if (!window.tieneRol('admin','dueno')) return;
   */
  window.tieneRol = function (...roles) {
    return roles.includes(window.authCtx?.perfil?.rol);
  };

  /**
   * Genera el siguiente número de comprobante para el tipo dado.
   * Llama a la función RPC de la BD (que garantiza atomicidad).
   * @param {string} tipo  'nota_credito' | 'nota_debito' | 'cobro' | etc.
   * @returns {Promise<string>} número formateado
   */
  window.siguienteNumero = async function (tipo) {
    // v85: usa RPC atómica con SELECT...FOR UPDATE (migración 078).
    // Elimina la condición de carrera donde dos usuarios concurrentes
    // podían obtener el mismo número de comprobante.
    try {
      const { data, error } = await sb.rpc('siguiente_numero_comprobante', {
        p_empresa_id: perfil.empresa_id,
        p_tipo: tipo
      });
      if (error) throw error;
      return data; // ya viene formateado con 8 dígitos desde la función SQL
    } catch (e) {
      console.error('[siguienteNumero] RPC falló:', e?.message);
      // Fallback temporal: timestamp. NUNCA debe llegar aquí en producción.
      // Si aparece en logs, verificar que migración 078 fue aplicada.
      return 'ERR-' + Date.now().toString().slice(-6);
    }
  };


  // ── Service Worker (sw-admin.js) ──────────────────────────────────────────
  // Registra el SW una vez que el auth está listo. El SW maneja cache offline,
  // push notifications y estrategias de red. Scope acotado a /admin: antes era
  // '/' (todo el sitio) y competía con sw-push.js, que también toma scope '/'
  // y se carga en esta misma página (dashboard.html) vía push-init.js.
  if ('serviceWorker' in navigator) {
    // Evita loops de recarga: solo recargamos una vez por cambio de SW.
    let _swReloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_swReloading) return;
      _swReloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('/frontend/admin/sw-admin.js', { scope: '/admin/' })
      .then(reg => {
        // Si hay un SW esperando (nueva versión), activarlo de inmediato
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (sw) sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              sw.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(err => console.warn('[auth] SW registration failed:', err));
  }

  // ── Botón "Instalar app" (PWA) ────────────────────────────────────────────
  // Antes solo aparecía en mobile/tablet vía beforeinstallprompt (Android
  // Chrome/Edge). Ahora se muestra en cualquier tamaño de pantalla, y además
  // se agrega un botón para iOS/Safari (que nunca dispara beforeinstallprompt)
  // con instrucciones manuales — mismo criterio que ya usa el modal de
  // "Descargar app" que tenía la landing pública anterior (frontend/index.html,
  // reemplazada en v917 por frontend/landing/index.html — la landing nueva no
  // trae ese modal propio; ver CHANGELOG_v917_integracion_landing_fluxo_simple.md).
  let _deferredInstallPrompt = null;

  function _esIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    _mostrarBotonInstalarAdmin();
  });

  window.addEventListener('appinstalled', () => {
    _deferredInstallPrompt = null;
    const btn = document.getElementById('btn-instalar-admin');
    if (btn) btn.remove();
  });

  // iOS no dispara beforeinstallprompt nunca: si detectamos iOS y la app no
  // está ya instalada (display-mode standalone), mostramos el botón directo
  // con instrucciones, sin esperar un evento que no va a llegar.
  if (_esIOS() && !window.matchMedia('(display-mode: standalone)').matches) {
    _mostrarBotonInstalarAdmin(true);
  }

  function _mostrarBotonInstalarAdmin(esIOSManual) {
    if (document.getElementById('btn-instalar-admin')) return;
    // Antes solo se mostraba en mobile/tablet (<992px) — en desktop el
    // usuario dependía de encontrar el ícono de instalar en la barra de
    // direcciones o en el menú ⋮ del navegador, lo cual generaba confusión
    // (Kello y varios clientes no lo encontraban). Ahora se muestra en
    // cualquier tamaño de pantalla mientras el navegador soporte instalar.

    const btn = document.createElement('button');
    btn.id = 'btn-instalar-admin';
    btn.type = 'button';
    btn.textContent = 'Instalar app';
    btn.setAttribute('aria-label', 'Instalar Fluxo Admin en este dispositivo');
    btn.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)',
      'z-index:9999', 'padding:10px 18px', 'border:none', 'border-radius:999px',
      'background:var(--color-box-primary,#6A9873)', 'color:#fff', 'font-family:inherit', 'font-size:0.9rem',
      'font-weight:600', 'box-shadow:0 4px 12px rgba(22,24,29,0.25)', 'cursor:pointer',
    ].join(';');

    if (esIOSManual) {
      btn.addEventListener('click', () => {
        _mostrarInstruccionesIOS();
      });
    } else {
      btn.addEventListener('click', async () => {
        if (!_deferredInstallPrompt) return;
        btn.disabled = true;
        _deferredInstallPrompt.prompt();
        await _deferredInstallPrompt.userChoice;
        _deferredInstallPrompt = null;
        btn.remove();
      });
    }

    document.body.appendChild(btn);
  }

  function _mostrarInstruccionesIOS() {
    if (document.getElementById('modal-instalar-ios')) return;
    const overlay = document.createElement('div');
    overlay.id = 'modal-instalar-ios';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(10,17,25,.72);display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:#fff;color:#111a17;max-width:340px;width:100%;border-radius:14px;padding:24px;position:relative;font-family:inherit">
        <button type="button" aria-label="Cerrar" style="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;line-height:1">✕</button>
        <h3 style="margin:0 0 10px;font-size:17px">Instalar la app</h3>
        <p style="margin:0;font-size:14px;line-height:1.55;color:#5b6660">
          Tocá el botón Compartir (□↑) abajo en Safari y elegí "Agregar a pantalla de inicio".
        </p>
      </div>`;
    overlay.querySelector('button').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // verificarSesion y waitForAuth eliminados en Etapa 2 — usar window.authReady
})();
