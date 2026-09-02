

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
    // Etapa 4 (hallazgo Crítico — reportado: "entro bien, veo el dashboard
    // y al segundo vuelve al login con error=red" en un caso donde los
    // logs del servidor mostraban 200 OK en TODAS las consultas): el bug
    // no era del backend, era la reacción de este código ante cualquier
    // ambigüedad. Antes, cualquier error que no fuera exactamente
    // PGRST116 (0 filas) — un blip de un segundo, una respuesta que
    // tardó de más por la congestión de cargar 20+ recursos del dashboard
    // en simultáneo, lo que sea — hacía signOut() inmediato y mandaba al
    // login. Eso destruye una sesión que en realidad seguía siendo
    // válida, por una falla que ni siquiera había llegado a confirmarse
    // como real. Ahora: más reintentos con backoff creciente (en vez de
    // uno solo a los 900ms), y el signOut+redirect a login solo se
    // dispara cuando PGRST116 confirma que el usuario no existe o está
    // inactivo. Cualquier otro error, agotados los reintentos, deja la
    // sesión intacta y muestra un estado de error recuperable en vez de
    // deslogear a alguien que sigue con una sesión perfectamente válida.
    async function cargarPerfilConReintento(intentosRestantes = 4, intentoNro = 0) {
      // FIX: conTimeoutRed() RECHAZA la promesa cuando corta por timeout
      // (ver ui-utils.js — Promise.race contra un timer que hace reject).
      // No devuelve { data, error } en ese caso como sí hace el cliente de
      // Supabase ante un error de la API. Sin este try/catch, un timeout
      // real (sin conexión, o señal intermitente que cuelga los 10s) tira
      // una excepción sin atrapar acá adentro, que sube sin capturar por
      // toda la IIFE async: window.authCtx nunca se setea, authReady nunca
      // se dispara, y nav.js/el resto de la página quedan a medio pintar.
      // Es el mismo bug reportado ("dashboard anda offline, el resto del
      // menú se rompe"): el dashboard sobrevive porque suele servirse
      // desde el caché de sessionStorage (TTL 5 min) sin pasar por acá; en
      // cuanto ese caché vence y toca una página que sí re-consulta, explota.
      let data, error;
      try {
        ({ data, error } = await window.conTimeoutRed(sb
          .from('usuarios')
          .select('id, nombre, email, rol, empresa_id, solo_lectura')
          .eq('id', session.user.id)
          .eq('activo', true)
          .single(), 10000));
      } catch (e) {
        error = { code: 'TIMEOUT_RED', message: e?.message || 'timeout' };
      }

      if (!error) return { perfilDB: data, error: null };

      if (error.code === 'PGRST116') {
        // 0 filas: o no existe el usuario, o activo=false. No es transitorio.
        return { perfilDB: null, error };
      }

      if (intentosRestantes > 1) {
        window.mostrarToast?.('No pudimos verificar tu sesión, reintentando…', 'warning');
        // Backoff creciente (0.9s, 2s, 4s) en vez de un único reintento a
        // los 900ms — le da tiempo real a un blip transitorio de red o a
        // que baje la congestión inicial del dashboard antes de rendirse.
        const espera = [900, 2000, 4000][intentoNro] ?? 4000;
        await new Promise((r) => setTimeout(r, espera));
        return cargarPerfilConReintento(intentosRestantes - 1, intentoNro + 1);
      }

      return { perfilDB: null, error };
    }

    const { perfilDB, error } = await cargarPerfilConReintento();

    if (error?.code === 'PGRST116') {
      // Único caso confirmado y no transitorio: no existe o está inactivo.
      console.error('[auth] Usuario inactivo o inexistente:', { code: error.code });
      await sb.auth.signOut();
      window.location.href = '/admin/login?error=usuario_inactivo';
      return;
    }

    if (error || !perfilDB) {
      // Log completo (código + status), no solo el mensaje, para diagnóstico real.
      console.error('[auth] No se pudo verificar el perfil tras reintentar (sesión NO cerrada):', {
        code: error?.code, message: error?.message, status: error?.status,
      });
      // No deslogueamos: la sesión sigue siendo válida, lo que falló fue
      // esta consulta puntual. Deslogear acá era el bug — obligaba a
      // volver a loguearse para toparse con el mismo problema de nuevo.
      // Mostramos un estado recuperable y dejamos que el usuario reintente
      // (F5) sin perder la sesión.
      document.body.innerHTML = `
        <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:16px; padding:24px; text-align:center; font-family:inherit;">
          <p style="max-width:420px; color:#7c2d12;">No pudimos verificar tu perfil por un problema puntual de conexión, pero tu sesión sigue activa. Probá recargar la página.</p>
          <button onclick="window.location.reload()" style="padding:10px 24px; border-radius:8px; border:1px solid #1e40af; background:#1e40af; color:#fff; cursor:pointer;">Reintentar</button>
        </div>`;
      return;
    }

    perfil = perfilDB;

    // Cargar empresa en query separada (evita RLS circular en join)
    // FIX: mismo problema que en cargarPerfilConReintento — conTimeoutRed()
    // rechaza la promesa en un timeout real, no devuelve { data, error }.
    // Sin try/catch acá, esa excepción tampoco la agarraba nadie y crasheaba
    // la IIFE completa un nivel más arriba (ya con perfil de usuario
    // cargado, pero sin llegar nunca a pintar authCtx). Un fallo acá cae en
    // la misma rama que ya existía para "empresaData vacío": objeto mínimo,
    // sin marcar empresaResuelta, para que la próxima carga reintente.
    let empresaData;
    try {
      ({ data: empresaData } = await window.conTimeoutRed(sb
        .from('empresas')
        .select('id, nombre, logo_url, cuit, activa, saas_suspendida, saas_plan, saas_trial_fin, saas_precio_mes, config')
        .eq('id', perfil.empresa_id)
        .single(), 10000));
    } catch (e) {
      console.warn('[auth] Timeout/red cargando empresa (no fatal, se usa fallback mínimo):', e?.message);
      empresaData = null;
    }

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
      perfil.empresas = { id: perfil.empresa_id, nombre: '', logo_url: null, cuit: null, config: null };
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

  // FIX (reportado: "en la demo no carga y al rato vuelve al login"): sb
  // refresca el access_token solo en segundo plano (autoRefreshToken, on por
  // default), pero window.authCtx.session quedaba fijo con el token del
  // momento del login. Las queries directas (sb.from(...), la mayoría del
  // panel) usan el cliente vivo y por eso nunca se rompían; api-client.js
  // (window.api, usado por el panel de KPIs) en cambio leía ese token
  // congelado a mano — apenas vencía, el backend devolvía 401 y eso
  // redirigía a /admin/login aunque la sesión real siguiera activa. Se
  // mantiene authCtx.session al día en cada refresh/sign-in para que ambos
  // caminos (directo y vía api-client) usen siempre el token vigente.
  sb.auth.onAuthStateChange((_event, nuevaSession) => {
    if (window.authCtx && nuevaSession) {
      window.authCtx.session = nuevaSession;
      window.authCtx.user = nuevaSession.user;
    }
  });

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

  // ── 456→v988: se sacó por completo el banner de "demostración en vivo".
  // Con el drawer mobile abierto, el banner (sticky, z-index:10000) quedaba
  // pintado por encima del propio drawer (z-index:691) y tapaba el botón
  // para volver al dashboard — la variable --demo-banner-h que corría el FAB
  // hamburguesa no alcanzaba a los ítems de navegación *dentro* del drawer.
  // En vez de seguir sumando parches de z-index/offset para un aviso
  // puramente informativo, se elimina directamente: el bloqueo real de
  // escritura en modo solo_lectura sigue viviendo en el backend (dispatcher,
  // ver lib/solo-lectura.js) y no depende de este aviso visual.
  if (perfil.solo_lectura) {
    document.body.classList.add('modo-demo-solo-lectura');
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
      const { data, error } = await window.conTimeoutRed(sb.rpc('siguiente_numero_comprobante', {
        p_empresa_id: perfil.empresa_id,
        p_tipo: tipo
      }), 10000);
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
    // FIX (bug reportado: "entro pero no logra conectar" — el dashboard se
    // recargaba solo a los pocos segundos de loguear): 'controllerchange' es
    // un evento GLOBAL de la página, no específico de sw-admin.js. Cuando
    // dashboard.html/notif-log.html también cargan push-init.js (legacy),
    // ese script registra un SW aparte (sw-push.js) con scope '/' que hace
    // clients.claim() en su 'activate' — y ESO disparaba este mismo
    // listener, recargando la página por un SW que no tiene nada que ver
    // con sw-admin.js ni con la sesión. Ahora se filtra: solo recarga si el
    // nuevo controller es efectivamente sw-admin.js.
    let _swReloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const nuevoController = navigator.serviceWorker.controller;
      if (!nuevoController || !nuevoController.scriptURL.includes('/sw-admin.js')) return;
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
