

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
        .select('id, nombre, email, rol, empresa_id')
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

  // ── Datos de empresa en sidebar ────────────────────────────────────────
  const empresa = perfil.empresas;
  if (empresa) {
    const logoEl    = document.getElementById('sidebar-logo');
    const empresaEl = document.getElementById('sidebar-empresa');
    if (empresaEl) empresaEl.textContent = empresa.nombre || '';
    if (logoEl) {
      if (empresa.logo_url) {
        logoEl.innerHTML = '';
        const img = document.createElement('img');
        img.src   = empresa.logo_url;
        img.alt   = empresa.nombre || 'Logo';
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:6px;';
        img.onerror = () => {
          logoEl.innerHTML  = '';
          logoEl.textContent = empresa.nombre?.charAt(0)?.toUpperCase() || 'D';
        };
        logoEl.appendChild(img);
      } else {
        logoEl.textContent = empresa.nombre?.charAt(0)?.toUpperCase() || 'D';
      }
    }
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

  // ── Helpers globales ───────────────────────────────────────────────────

  window.cerrarSesion = async function () {
    window.__limpiarCacheAuth();
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
  // push notifications y estrategias de red. El scope '/' abarca todo el admin.
  if ('serviceWorker' in navigator) {
    // Evita loops de recarga: solo recargamos una vez por cambio de SW.
    let _swReloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_swReloading) return;
      _swReloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('/frontend/admin/sw-admin.js', { scope: '/' })
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
  // Solo aparece en mobile cuando el browser dispara beforeinstallprompt
  // (Android Chrome/Edge; iOS Safari no lo soporta — ahí se instala manual
  // vía "Compartir → Agregar a inicio").
  let _deferredInstallPrompt = null;

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

  function _mostrarBotonInstalarAdmin() {
    if (document.getElementById('btn-instalar-admin')) return;
    if (window.matchMedia('(min-width: 992px)').matches) return; // solo mobile/tablet

    const btn = document.createElement('button');
    btn.id = 'btn-instalar-admin';
    btn.type = 'button';
    btn.textContent = '⬇ Instalar app';
    btn.setAttribute('aria-label', 'Instalar Fluxo Admin en este dispositivo');
    btn.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)',
      'z-index:9999', 'padding:10px 18px', 'border:none', 'border-radius:999px',
      'background:var(--color-box-primary,#B87A00)', 'color:#fff', 'font-family:inherit', 'font-size:0.9rem',
      'font-weight:600', 'box-shadow:0 4px 12px rgba(0,0,0,0.25)', 'cursor:pointer',
    ].join(';');

    btn.addEventListener('click', async () => {
      if (!_deferredInstallPrompt) return;
      btn.disabled = true;
      _deferredInstallPrompt.prompt();
      await _deferredInstallPrompt.userChoice;
      _deferredInstallPrompt = null;
      btn.remove();
    });

    document.body.appendChild(btn);
  }

  // verificarSesion y waitForAuth eliminados en Etapa 2 — usar window.authReady
})();
