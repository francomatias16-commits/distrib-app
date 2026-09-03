// frontend/shared/offline-core.js
// OfflineCore — capa de datos local genérica (Plan offline, Etapa 1)
//
// Reemplaza el patrón manual de IndexedDB (abrirDB/idbGet/idbPut escrito a
// mano, repetido en pos-offline.js, chofer-offline.js, cliente-offline.js y
// stock-offline.js v1) por dos primitivas reutilizables sobre Dexie:
//
//   OfflineCore.crearOutbox({...})  — cola FIFO genérica de escrituras
//                                      pendientes (crear pedido, ajustar
//                                      stock, confirmar entrega, lo que sea)
//   OfflineCore.crearCache({...})   — caché de solo-lectura con TTL para
//                                      catálogos que un Service Worker no
//                                      puede validar por sí solo (ej. precios
//                                      de POS)
//
// Una base de datos Dexie por "portal" (nombre lógico que pasa el módulo:
// 'admin_stock', 'admin_pos', 'chofer', 'cliente'), con dos tablas fijas:
//   outbox — acciones pendientes de sincronizar (cualquier tipo)
//   cache  — entradas de caché de cualquier entidad, separadas por `store`
//
// Cada módulo (stock-offline.js, pos-offline.js, etc.) sigue exponiendo su
// propia API pública (window.StockOffline, window.PosOffline, ...) — esto
// es una capa interna, no reemplaza esos módulos ni cambia sus contratos
// hacia el resto del frontend.
//
// BACKGROUND SYNC (best-effort):
// Si el navegador soporta SyncManager, cada outbox registra su `syncTag`
// contra el Service Worker activo al encolar una acción. Si el SO despierta
// el SW más tarde con conectividad (aunque la pestaña esté cerrada), el SW
// NO tiene la sesión del usuario — así que en vez de sincronizar él mismo,
// le avisa a cualquier pestaña abierta (postMessage
// `{type:'BACKGROUND_SYNC', tag}`, ver el listener 'sync' agregado en
// sw-admin.js / sw-chofer.js / sw-cliente.js) para que sea la página, que sí
// tiene la sesión, la que dispare el sync real. Si no hay ninguna pestaña
// abierta no pasa nada — se sincroniza igual la próxima vez que el usuario
// abra la app (fallback normal por evento 'online' + init()). iOS Safari no
// soporta Background Sync: ese fallback es el único camino ahí, y es el
// mismo comportamiento que ya existía antes de esta capa.
//
// Requiere, ANTES de este archivo:
//   1. Dexie (CDN)

'use strict';

var OfflineCore = (function () {

  if (typeof Dexie === 'undefined') {
    console.error('[OfflineCore] Dexie no está cargado — falta el <script> del CDN antes de offline-core.js.');
    return { crearOutbox: () => null, crearCache: () => null };
  }

  const MAX_INTENTOS_DEFAULT = 5;

  // ─── Una Dexie DB por portal, reutilizada entre crearOutbox/crearCache ───
  const _dbs = new Map();

  // dbVersion: normalmente 1. Subirlo solo hace falta cuando el portal ya
  // tenía una DB IndexedDB previa (pre-OfflineCore) en una versión más alta
  // — IndexedDB no permite abrir con una versión menor a la ya existente en
  // el navegador del usuario. Si dos llamadas (crearOutbox + crearCache) del
  // mismo portal piden versiones distintas, gana la primera que abrió la DB.
  function _getDb(portal, dbVersion) {
    if (_dbs.has(portal)) return _dbs.get(portal);
    const db = new Dexie(`${portal}_offline_db`);
    db.version(dbVersion || 1).stores({
      outbox: '++local_id, estado, created_at, tipo, offline_local_id',
      cache:  '[store+id], store, cached_at',
    });
    _dbs.set(portal, db);
    return db;
  }

  // ─── Animación de badge (una sola vez para toda la página) ───────────────
  function _asegurarEstilosBadge() {
    if (document.getElementById('offline-core-styles')) return;
    const style = document.createElement('style');
    style.id = 'offline-core-styles';
    style.textContent = `
      @keyframes offline-core-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  // ─── Badge de estado de conexión (genérico, configurable por outbox) ─────
  function _badgeId(portal) {
    return `${portal}-offline-badge`;
  }

  function _crearBadgeEl(portal, cfg) {
    if (!cfg || !cfg.selector) return null;
    _asegurarEstilosBadge();
    const id = _badgeId(portal);
    let badge = document.getElementById(id);
    if (badge) return badge;

    badge = document.createElement('div');
    badge.id = id;
    badge.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      cursor: default;
      transition: background 0.3s, color 0.3s;
      user-select: none;
      white-space: nowrap;
    `;
    badge.title = cfg.titulo || 'Estado de conexión';

    const contenedor = document.querySelector(cfg.selector);
    if (contenedor) {
      if (cfg.insertarAlFinal) contenedor.appendChild(badge);
      else contenedor.insertBefore(badge, contenedor.firstChild);
    }
    return badge;
  }

  async function _actualizarBadge(portal, cfg, estado, contarPendientes, contarConflictos, contarCuarentena) {
    if (!cfg) return;
    const badge = _crearBadgeEl(portal, cfg);
    if (!badge) return;

    const pendientes  = await contarPendientes().catch(() => 0);
    const conflictos  = contarConflictos ? await contarConflictos().catch(() => 0) : 0;
    const cuarentena  = contarCuarentena ? await contarCuarentena().catch(() => 0) : 0;
    const singular = cfg.singular || 'acción';
    const plural   = cfg.plural   || 'acciones';

    // Etapa 4 — un conflicto sin resolver tiene prioridad visual sobre
    // cualquier otro estado (online/offline/syncing): necesita una decisión
    // del usuario, no se va a resolver solo con que vuelva la conexión.
    if (conflictos > 0) {
      badge.style.background = 'var(--color-danger-bg,#F5DDD8)';
      badge.style.color      = 'var(--color-danger,#7A2820)';
      badge.style.border     = '1px solid var(--color-danger-mid,#D1594A)';
      badge.innerHTML = `⚠ ${conflictos} conflicto${conflictos === 1 ? '' : 's'} por resolver`;
      badge.style.display = 'inline-flex';
      badge.style.cursor = cfg.onClickConflictos ? 'pointer' : 'default';
      badge.onclick = cfg.onClickConflictos || null;
      return;
    }

    // SYNC-04 — un registro en cuarentena tampoco se resuelve solo (no se
    // auto-sincroniza, ver encolarLegacySinTenant): segunda prioridad visual,
    // debajo de conflictos activos pero por encima de online/offline/syncing.
    // Naranja (warning) en vez de rojo (danger) porque no bloquea nada del
    // flujo normal de venta — es revisión pendiente, no un rechazo del server.
    if (cuarentena > 0) {
      badge.style.background = 'var(--color-warning-bg,#FBE8C9)';
      badge.style.color      = 'var(--color-warning,#8A5F13)';
      badge.style.border     = '1px solid var(--color-warning-mid,#E0A53E)';
      badge.innerHTML = `◑ ${cuarentena} registro${cuarentena === 1 ? '' : 's'} antiguo${cuarentena === 1 ? '' : 's'} sin revisar`;
      badge.style.display = 'inline-flex';
      badge.style.cursor = cfg.onClickCuarentena ? 'pointer' : 'default';
      badge.onclick = cfg.onClickCuarentena || null;
      return;
    }
    badge.onclick = null;

    if (estado.syncEnCurso) {
      badge.style.background = 'var(--color-warning-bg,#FBE8C9)';
      badge.style.color      = 'var(--color-warning,#8A5F13)';
      badge.style.border     = '1px solid var(--color-warning-mid,#E0A53E)';
      badge.innerHTML = `<span style="animation:offline-core-spin 1s linear infinite;display:inline-block">⟳</span> Sincronizando…`;
      badge.style.display = 'inline-flex';
    } else if (!estado.online) {
      badge.style.background = 'var(--color-danger-bg,#F5DDD8)';
      badge.style.color      = 'var(--color-danger,#7A2820)';
      badge.style.border     = '1px solid var(--color-danger-mid,#D1594A)';
      badge.innerHTML = pendientes > 0
        ? `● Sin internet — ${pendientes} ${pendientes === 1 ? singular : plural} en cola`
        : '● Sin internet';
      badge.style.display = 'inline-flex';
    } else if (pendientes > 0) {
      badge.style.background = 'var(--color-warning-bg,#FBE8C9)';
      badge.style.color      = 'var(--color-warning,#8A5F13)';
      badge.style.border     = '1px solid var(--color-warning-mid,#E0A53E)';
      badge.innerHTML = `◑ ${pendientes} ${pendientes === 1 ? singular : plural}…`;
      badge.style.display = 'inline-flex';
    } else if (cfg.ocultarSiInactivo) {
      badge.style.display = 'none';
    } else {
      badge.style.background = 'var(--color-success-bg,#E2F0E5)';
      badge.style.color      = 'var(--color-success,#487050)';
      badge.style.border     = '1px solid var(--color-success-mid,#75A37D)';
      badge.innerHTML        = '● En línea';
      badge.style.display    = 'inline-flex';
    }
  }

  // ─── Modal genérico de resolución de conflictos (Etapa 4) ────────────────
  //
  // Un solo componente reutilizado por cualquier outbox — cada módulo solo
  // personaliza el texto vía badge.formatoConflicto(reg) -> {titulo, detalle}
  // y, si "reintentar" necesita pisar algún campo del payload original (ej.
  // el stock actual del servidor), vía badge.armarPayloadReintento(reg) ->
  // objeto parcial que se mergea sobre el payload encolado.
  function _asegurarEstilosModalConflictos() {
    if (document.getElementById('offline-core-conflictos-styles')) return;
    const style = document.createElement('style');
    style.id = 'offline-core-conflictos-styles';
    style.textContent = `
      .offline-core-conflictos-overlay {
        position: fixed; inset: 0; background: rgba(22,24,29,0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; padding: 16px;
      }
      .offline-core-conflictos-modal {
        background: var(--color-surface, #FFFFFF); border-radius: 12px;
        padding: 20px; max-width: 480px; width: 100%; max-height: 82vh;
        overflow-y: auto; box-shadow: 0 10px 40px rgba(22,24,29,0.3);
        font-family: inherit;
      }
      .offline-core-conflictos-modal h3 { margin: 0 0 4px; font-size: 16px; }
      .offline-core-conflictos-modal > p.offline-core-conflictos-subt {
        margin: 0 0 14px; font-size: 13px; color: var(--color-text-muted,#5B6660);
      }
      .offline-core-conflicto-item {
        border: 1px solid var(--color-border, #DDE1DC); border-radius: 8px;
        padding: 12px; margin-bottom: 10px;
      }
      .offline-core-conflicto-item p { margin: 4px 0; font-size: 13px; }
      .offline-core-conflicto-item .titulo { font-weight: 600; font-size: 14px; }
      .offline-core-conflicto-acciones { display: flex; gap: 8px; margin-top: 10px; }
      .offline-core-conflicto-acciones button {
        flex: 1; padding: 7px 10px; border-radius: 6px; font-size: 13px;
        cursor: pointer; border: 1px solid transparent;
      }
      .offline-core-btn-reintentar {
        background: var(--color-success-bg,#E2F0E5); color: var(--color-success,#487050);
        border-color: var(--color-success-mid,#75A37D);
      }
      .offline-core-btn-descartar {
        background: var(--color-danger-bg,#F5DDD8); color: var(--color-danger,#7A2820);
        border-color: var(--color-danger-mid,#D1594A);
      }
      .offline-core-conflictos-cerrar {
        margin-top: 8px; width: 100%; padding: 8px; border-radius: 6px;
        border: 1px solid var(--color-border,#DDE1DC); background: transparent;
        cursor: pointer; font-size: 13px;
      }
    `;
    document.head.appendChild(style);
  }

  function _formatoConflictoDefault(reg) {
    const d = reg.conflicto_datos || {};
    const mensajes = {
      conflicto_stock_cambio: `El stock cambió en el servidor mientras esto esperaba sin conexión (esperado ${d.stock_sistema_esperado ?? '?'}, actual ${d.stock_sistema_actual ?? '?'}).`,
    };
    return {
      titulo:  mensajes[reg.conflicto_tipo] ? 'El stock cambió mientras estabas sin conexión' : (d.error || d.mensaje || 'El dato cambió en el servidor'),
      detalle: mensajes[reg.conflicto_tipo] || d.error || d.mensaje || 'Revisá los datos antes de reintentar.',
    };
  }

  async function _abrirModalConflictos(portal, cfg, api) {
    _asegurarEstilosModalConflictos();
    const overlayId = `${portal}-offline-conflictos-overlay`;
    document.getElementById(overlayId)?.remove();

    let restantes = await api.getConflictos();

    const overlay = document.createElement('div');
    overlay.className = 'offline-core-conflictos-overlay';
    overlay.id = overlayId;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'offline-core-conflictos-modal';
    overlay.appendChild(modal);

    function render() {
      modal.innerHTML = '';

      const h = document.createElement('h3');
      h.textContent = restantes.length
        ? `${restantes.length} conflicto${restantes.length === 1 ? '' : 's'} por resolver`
        : 'Sin conflictos pendientes';
      modal.appendChild(h);

      const sub = document.createElement('p');
      sub.className = 'offline-core-conflictos-subt';
      sub.textContent = restantes.length
        ? 'Estos datos cambiaron en el servidor mientras esperaban sin conexión. Elegí qué hacer con cada uno.'
        : '';
      if (restantes.length) modal.appendChild(sub);

      restantes.forEach((reg) => {
        const info = (typeof cfg.formatoConflicto === 'function')
          ? (cfg.formatoConflicto(reg) || _formatoConflictoDefault(reg))
          : _formatoConflictoDefault(reg);

        const item = document.createElement('div');
        item.className = 'offline-core-conflicto-item';

        const pTitulo = document.createElement('p');
        pTitulo.className = 'titulo';
        pTitulo.textContent = info.titulo || 'Conflicto';
        item.appendChild(pTitulo);

        const pDetalle = document.createElement('p');
        pDetalle.textContent = info.detalle || '';
        item.appendChild(pDetalle);

        const acciones = document.createElement('div');
        acciones.className = 'offline-core-conflicto-acciones';

        const btnReintentar = document.createElement('button');
        btnReintentar.className = 'offline-core-btn-reintentar';
        btnReintentar.textContent = 'Reintentar con datos actuales';
        btnReintentar.onclick = async () => {
          btnReintentar.disabled = true;
          const extra = (typeof cfg.armarPayloadReintento === 'function')
            ? { payload: cfg.armarPayloadReintento(reg) }
            : undefined;
          await api.resolverConflicto(reg.local_id, 'reintentar', extra);
          restantes = restantes.filter((r) => r.local_id !== reg.local_id);
          render();
        };

        const btnDescartar = document.createElement('button');
        btnDescartar.className = 'offline-core-btn-descartar';
        btnDescartar.textContent = 'Descartar';
        btnDescartar.onclick = async () => {
          if (!confirm('¿Descartar esta acción pendiente? No se va a enviar al servidor.')) return;
          btnDescartar.disabled = true;
          await api.resolverConflicto(reg.local_id, 'descartar');
          restantes = restantes.filter((r) => r.local_id !== reg.local_id);
          render();
        };

        acciones.appendChild(btnReintentar);
        acciones.appendChild(btnDescartar);
        item.appendChild(acciones);
        modal.appendChild(item);
      });

      const cerrar = document.createElement('button');
      cerrar.className = 'offline-core-conflictos-cerrar';
      cerrar.textContent = restantes.length ? 'Resolver más tarde' : 'Cerrar';
      cerrar.onclick = () => overlay.remove();
      modal.appendChild(cerrar);
    }

    render();
    document.body.appendChild(overlay);
  }

  // ─── Modal genérico de revisión de cuarentena legacy (SYNC-04) ───────────
  //
  // Mismo componente visual que el modal de conflictos (misma hoja de
  // estilos, offline-core-conflictos-*) — acá cada item es un registro
  // legacy sin empresa_id verificable (ver encolarLegacySinTenant). Solo
  // dos decisiones posibles: confirmarlo como propio de ESTA sesión
  // (empresaIdActual) o descartarlo sin sincronizar.
  //
  // cfg.formatoCuarentena(reg) -> {titulo, detalle}  (opcional, mismo
  //   criterio que cfg.formatoConflicto en el modal de conflictos)
  async function _abrirModalCuarentena(portal, cfg, api, empresaIdActual) {
    _asegurarEstilosModalConflictos();
    const overlayId = `${portal}-offline-cuarentena-overlay`;
    document.getElementById(overlayId)?.remove();

    let restantes = await api.getCuarentena();

    const overlay = document.createElement('div');
    overlay.className = 'offline-core-conflictos-overlay';
    overlay.id = overlayId;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'offline-core-conflictos-modal';
    overlay.appendChild(modal);

    function render() {
      modal.innerHTML = '';

      const h = document.createElement('h3');
      h.textContent = restantes.length
        ? `${restantes.length} registro${restantes.length === 1 ? '' : 's'} antiguo${restantes.length === 1 ? '' : 's'} sin revisar`
        : 'Sin pendientes de revisión';
      modal.appendChild(h);

      const sub = document.createElement('p');
      sub.className = 'offline-core-conflictos-subt';
      sub.textContent = restantes.length
        ? 'Quedaron encolados en este dispositivo antes del aislamiento por empresa y no se pueden atribuir automáticamente. Confirmalos solo si son de tu empresa — si no, descartalos.'
        : '';
      if (restantes.length) modal.appendChild(sub);

      restantes.forEach((reg) => {
        const info = (typeof cfg.formatoCuarentena === 'function')
          ? (cfg.formatoCuarentena(reg) || _formatoCuarentenaDefault(reg))
          : _formatoCuarentenaDefault(reg);

        const item = document.createElement('div');
        item.className = 'offline-core-conflicto-item';

        const pTitulo = document.createElement('p');
        pTitulo.className = 'titulo';
        pTitulo.textContent = info.titulo || 'Registro sin revisar';
        item.appendChild(pTitulo);

        const pDetalle = document.createElement('p');
        pDetalle.textContent = info.detalle || '';
        item.appendChild(pDetalle);

        const acciones = document.createElement('div');
        acciones.className = 'offline-core-conflicto-acciones';

        const btnConfirmar = document.createElement('button');
        btnConfirmar.className = 'offline-core-btn-reintentar';
        btnConfirmar.textContent = 'Confirmar como mía y sincronizar';
        btnConfirmar.onclick = async () => {
          if (!empresaIdActual) { alert('No se pudo determinar tu empresa — recargá la página e intentá de nuevo.'); return; }
          if (!confirm('¿Confirmás que este registro es de tu empresa? Se va a sincronizar con el servidor.')) return;
          btnConfirmar.disabled = true;
          await api.confirmarCuarentena(reg.local_id, empresaIdActual);
          restantes = restantes.filter((r) => r.local_id !== reg.local_id);
          render();
        };

        const btnDescartar = document.createElement('button');
        btnDescartar.className = 'offline-core-btn-descartar';
        btnDescartar.textContent = 'No es mío — descartar';
        btnDescartar.onclick = async () => {
          if (!confirm('¿Descartar este registro? No se va a enviar al servidor ni se puede deshacer.')) return;
          btnDescartar.disabled = true;
          await api.descartarCuarentena(reg.local_id);
          restantes = restantes.filter((r) => r.local_id !== reg.local_id);
          render();
        };

        acciones.appendChild(btnConfirmar);
        acciones.appendChild(btnDescartar);
        item.appendChild(acciones);
        modal.appendChild(item);
      });

      const cerrar = document.createElement('button');
      cerrar.className = 'offline-core-conflictos-cerrar';
      cerrar.textContent = restantes.length ? 'Revisar más tarde' : 'Cerrar';
      cerrar.onclick = () => overlay.remove();
      modal.appendChild(cerrar);
    }

    render();
    document.body.appendChild(overlay);
  }

  function _formatoCuarentenaDefault(reg) {
    const fecha = reg.created_at ? new Date(reg.created_at).toLocaleString('es-AR') : 'fecha desconocida';
    return {
      titulo:  `${reg.tipo || 'Acción'} — ${fecha}`,
      detalle: reg.origen_legacy ? `Origen: ${reg.origen_legacy}` : '',
    };
  }

  // ─── Background Sync (best-effort) ────────────────────────────────────────
  async function _registrarBackgroundSync(syncTag) {
    if (!syncTag) return;
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register(syncTag);
    } catch (err) {
      // Best-effort — no soportado (ej. iOS Safari) o falló el registro.
      // El fallback por evento 'online' + init() sigue cubriendo el caso.
    }
  }

  // ─── Outbox genérico ───────────────────────────────────────────────────────
  //
  // opts:
  //   portal          — string, nombre de la DB Dexie (ej. 'admin_stock')
  //   validarTipo(tipo) -> bool           (opcional, default: siempre válido)
  //   prepararRegistro(tipo, payload) -> objeto con campos extra para el
  //                     registro, o que lanza si el payload es inválido
  //                     (ej. cliente-offline exige idempotency_key)
  //   procesarAccion(accion, contexto) -> Promise<data>   (REQUERIDO)
  //                     Si falla: lanzar Error normal = se reintenta;
  //                     lanzar Error con `.permanente = true` = no se
  //                     reintenta más (queda en error_permanente).
  //   getContexto()   -> contexto que necesita procesarAccion (cliente
  //                     Supabase, token, lo que sea). Si devuelve valor
  //                     falsy, sincronizarPendientes() no hace nada todavía
  //                     (ej. sesión aún no lista).
  //   getEmpresaId()  — AISLAMIENTO MULTI-TENANT (Plan offline, Etapa 4).
  //                     Opcional, pero fuertemente recomendado. Un mismo
  //                     dispositivo/navegador puede ser usado por usuarios
  //                     de dos empresas distintas (ej. un comercio cliente
  //                     de dos distribuidoras que corren este software).
  //                     Sin esto, la cola local (outbox) es una sola por
  //                     portal en el dispositivo — cualquier usuario que
  //                     abra sesión ahí ve y sincroniza TODO lo pendiente,
  //                     sea de la empresa que sea.
  //                     Puede devolver un valor (sync) o una Promise. Si no
  //                     se pasa, el comportamiento es el de antes (sin
  //                     scoping) — así los módulos que todavía no lo
  //                     cablearon (ver changelog) no se rompen.
  //                     Los registros ya encolados ANTES de que un módulo
  //                     empiece a pasar getEmpresaId quedan sin empresa_id
  //                     (null) — se siguen mostrando/sincronizando igual,
  //                     para no perder pendientes viejos; el filtro solo
  //                     excluye registros de OTRA empresa_id explícita.
  //   maxIntentos     — default 5
  //   dbVersion       — default 1 (ver nota en _getDb — solo hace falta
  //                     subirlo si el portal ya tenía una IndexedDB previa
  //                     en una versión más alta antes de OfflineCore)
  //   badge: { selector, titulo, singular, plural, ocultarSiInactivo, insertarAlFinal }
  //   mensajes: { sincronizado(n), pendienteError(n) }
  //   onSincronizado()  — hook post-sync exitoso (ej. refrescar una tabla)
  //   syncTag         — tag de Background Sync (opcional)
  function crearOutbox(opts) {
    if (!opts || !opts.portal || typeof opts.procesarAccion !== 'function') {
      throw new Error('[OfflineCore] crearOutbox requiere al menos { portal, procesarAccion }');
    }

    const db = _getDb(opts.portal, opts.dbVersion);
    const maxIntentos = opts.maxIntentos || MAX_INTENTOS_DEFAULT;

    const _estado = { online: navigator.onLine, syncEnCurso: false };

    function _actualizar() {
      return _actualizarBadge(opts.portal, opts.badge, _estado, getContadorPendientes, getContadorConflictos, getContadorCuarentena);
    }

    async function _empresaActual() {
      if (typeof opts.getEmpresaId !== 'function') return undefined;
      return Promise.resolve(opts.getEmpresaId());
    }

    async function encolarAccion(tipo, payload, offlineLocalId) {
      if (typeof opts.validarTipo === 'function' && !opts.validarTipo(tipo)) {
        throw new Error(`[OfflineCore:${opts.portal}] Tipo de acción offline desconocido: ${tipo}`);
      }
      let extra = {};
      if (typeof opts.prepararRegistro === 'function') {
        extra = (await opts.prepararRegistro(tipo, payload)) || {};
      }
      const empresa_id = (await _empresaActual()) ?? null;
      const registro = {
        tipo,
        payload,
        empresa_id, // Etapa 4, aislamiento multi-tenant — ver nota de getEmpresaId más arriba
        // FIX (auditoría etapa 2, v584→): si quien llama ya intentó la RPC
        // online primero (patrón cta-cte.js/stock.js: online → si falla,
        // encolar) y ese intento directo viajó con su propio
        // p_offline_local_id, hay que reusar EXACTAMENTE ese mismo id acá —
        // no generar uno nuevo. Si no se reusa, un timeout que en realidad
        // ya se aplicó del lado del servidor (la respuesta se perdió, no la
        // request) termina reintentándose con un id distinto: el índice
        // único de dedup del RPC no lo reconoce como el mismo intento y el
        // cobro/movimiento de stock se duplica de verdad. Con id reusado,
        // el propio RPC lo deduplica y devuelve el resultado ya existente.
        offline_local_id: offlineLocalId || crypto.randomUUID(),
        estado:     'pendiente', // pendiente | sincronizado | error_permanente
        intentos:   0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_msg:  null,
        resultado:  null,
        ...extra,
      };
      const local_id = await db.outbox.add(registro);
      await _actualizar();
      _registrarBackgroundSync(opts.syncTag);
      // Intento inmediato por si la red volvió justo antes de encolar —
      // evita esperar al próximo evento 'online'.
      if (_estado.online) sincronizarPendientes();
      return local_id;
    }

    async function getPendientes() {
      const todos = await db.outbox.where('estado').equals('pendiente').sortBy('local_id');
      if (typeof opts.getEmpresaId !== 'function') return todos;
      const empresaId = await _empresaActual();
      // Registros sin empresa_id (encolados antes de cablear getEmpresaId,
      // o por un módulo que todavía no lo pasa) se siguen mostrando — el
      // filtro solo excluye pendientes que son explícitamente de OTRA
      // empresa_id (dispositivo compartido entre usuarios de dos empresas).
      return todos.filter((r) => !r.empresa_id || r.empresa_id === empresaId);
    }

    async function getContadorPendientes() {
      return (await getPendientes()).length;
    }

    // ─── Conflictos (Etapa 4) ─────────────────────────────────────────────
    // Un conflicto NO es un error transitorio: el servidor respondió, pero
    // el dato cambió mientras la acción esperaba offline (ej. el stock
    // contado ya no coincide, o el pedido ya no tiene stock suficiente).
    // Reintentar a ciegas no lo resuelve — necesita que el usuario decida.
    // Por eso vive en su propio estado ('conflicto'), separado de
    // 'error_permanente', y no cuenta para maxIntentos.
    async function getConflictos() {
      const todos = await db.outbox.where('estado').equals('conflicto').sortBy('local_id');
      if (typeof opts.getEmpresaId !== 'function') return todos;
      const empresaId = await _empresaActual();
      return todos.filter((r) => !r.empresa_id || r.empresa_id === empresaId);
    }

    // ─── Cuarentena de registros legacy sin tenant verificable (SYNC-04) ──
    // Un registro legacy (encolado antes de que existiera el aislamiento
    // multi-tenant, o migrado desde una cola pre-OfflineCore como la v1 del
    // POS) no tiene forma de saber a qué empresa pertenece. Si se lo
    // encola directo con encolarAccion(), _empresaActual() le pone el
    // empresa_id de la SESIÓN ACTUAL — en un dispositivo compartido entre
    // usuarios de dos empresas, una venta/movimiento vieja de la Empresa A
    // podía terminar sincronizada y ejecutada bajo la Empresa B si B es
    // quien abre la app y dispara la migración. encolarLegacySinTenant()
    // guarda el registro en estado 'cuarentena_v1': NO entra en
    // getPendientes()/sincronizarPendientes() (no se auto-sincroniza con
    // nadie) hasta que alguien lo revise explícitamente con
    // confirmarCuarentena(local_id, empresaIdConfirmado).
    async function encolarLegacySinTenant(tipo, payload, origen) {
      const registro = {
        tipo,
        payload,
        empresa_id: null, // deliberadamente sin tenant — ver nota arriba
        offline_local_id: crypto.randomUUID(),
        estado:     'cuarentena_v1',
        origen_legacy: origen || null,
        intentos:   0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_msg:  null,
        resultado:  null,
      };
      return db.outbox.add(registro);
    }

    async function getCuarentena() {
      return db.outbox.where('estado').equals('cuarentena_v1').sortBy('local_id');
    }

    async function getContadorCuarentena() {
      return (await getCuarentena()).length;
    }

    // Revisión explícita: recién acá el registro pasa a 'pendiente' y
    // queda sujeto al mismo ciclo de sincronización normal, con el
    // empresa_id que quien revisa confirme (no necesariamente el de la
    // sesión que disparó la migración).
    async function confirmarCuarentena(local_id, empresaIdConfirmado) {
      const reg = await db.outbox.get(local_id);
      if (!reg || reg.estado !== 'cuarentena_v1') return false;
      await db.outbox.update(local_id, {
        estado:     'pendiente',
        empresa_id: empresaIdConfirmado ?? null,
        updated_at: new Date().toISOString(),
      });
      await _actualizar();
      if (_estado.online) sincronizarPendientes();
      return true;
    }

    async function descartarCuarentena(local_id) {
      const reg = await db.outbox.get(local_id);
      if (!reg || reg.estado !== 'cuarentena_v1') return false;
      await db.outbox.update(local_id, { estado: 'descartado', updated_at: new Date().toISOString() });
      return true;
    }

    async function getContadorConflictos() {
      return (await getConflictos()).length;
    }

    async function _marcarConflicto(local_id, tipo, datos) {
      await db.outbox.update(local_id, {
        estado:          'conflicto',
        conflicto_tipo:  tipo || 'conflicto',
        conflicto_datos: datos ?? null,
        updated_at:      new Date().toISOString(),
      });
      await _actualizar();
    }

    // decision:
    //   'descartar'  — abandona la acción (estado 'descartado', sale de la
    //                   cola y de getConflictos(); queda en la DB local
    //                   como registro de auditoría, no se sincroniza más).
    //   'reintentar' — vuelve a 'pendiente' con el payload actualizado
    //                   (extra.payload se mergea sobre el original — ej.
    //                   pisar p_stock_sistema_esperado con el valor actual
    //                   del servidor) y dispara un sync inmediato si hay
    //                   conexión.
    async function resolverConflicto(local_id, decision, extra) {
      const reg = await db.outbox.get(local_id);
      if (!reg) return false;

      if (decision === 'descartar') {
        await db.outbox.update(local_id, {
          estado:     'descartado',
          updated_at: new Date().toISOString(),
        });
      } else if (decision === 'reintentar') {
        const nuevoPayload = extra?.payload ? { ...reg.payload, ...extra.payload } : reg.payload;
        await db.outbox.update(local_id, {
          estado:          'pendiente',
          payload:         nuevoPayload,
          intentos:        0,
          error_msg:       null,
          conflicto_tipo:  null,
          conflicto_datos: null,
          updated_at:      new Date().toISOString(),
        });
      } else {
        throw new Error(`[OfflineCore] decisión de conflicto desconocida: ${decision}`);
      }

      await _actualizar();
      if (decision === 'reintentar' && _estado.online) sincronizarPendientes();
      return true;
    }

    // Etapa 5 (OFFLINE-03) — progreso parcial dentro de una acción en curso.
    // Algunas acciones hacen más de una llamada de red antes de completarse
    // (ej. chofer: subir firma/foto a Storage y RECIÉN DESPUÉS hacer el
    // PATCH de entrega, que es el que el servidor deduplica por
    // offline_local_id). Si la conexión se corta entre esos dos pasos, un
    // reintento ingenuo desde cero repite la subida de los mismos archivos:
    // no rompe nada (el PATCH sigue siendo idempotente), pero con mala
    // señal — el escenario típico de estas acciones — esto acumula archivos
    // huérfanos en el bucket en cada intento fallido a mitad de camino.
    // guardarProgresoParcial() deja que procesarAccion persista lo que ya
    // logró (ej. las URLs ya subidas) directo en el registro de la cola,
    // ANTES de intentar el resto — así el próximo intento puede leerlo de
    // `accion.progreso` y no repetir el trabajo ya hecho. Se mergea (no
    // reemplaza) para que llamadas sucesivas de la misma acción puedan ir
    // sumando progreso sin pisarse.
    async function guardarProgresoParcial(local_id, progresoParcial) {
      const reg = await db.outbox.get(local_id);
      if (!reg) return;
      await db.outbox.update(local_id, {
        progreso:   { ...(reg.progreso || {}), ...(progresoParcial || {}) },
        updated_at: new Date().toISOString(),
      });
    }

    async function _marcarSincronizado(local_id, resultado) {
      await db.outbox.update(local_id, {
        estado:     'sincronizado',
        resultado:  resultado ?? null,
        updated_at: new Date().toISOString(),
      });
      await _actualizar();
    }

    async function _marcarError(local_id, msg, permanente) {
      const reg = await db.outbox.get(local_id);
      if (!reg) return;
      await db.outbox.update(local_id, {
        estado:     permanente ? 'error_permanente' : 'pendiente',
        intentos:   (reg.intentos || 0) + 1,
        error_msg:  msg,
        updated_at: new Date().toISOString(),
      });
    }

    async function sincronizarPendientes() {
      if (_estado.syncEnCurso || !_estado.online) return;

      const contexto = await Promise.resolve(
        typeof opts.getContexto === 'function' ? opts.getContexto() : null
      );
      if (!contexto) return; // sesión/cliente todavía no disponible

      _estado.syncEnCurso = true;
      await _actualizar();

      const pendientes = await getPendientes();
      if (!pendientes.length) {
        _estado.syncEnCurso = false;
        await _actualizar();
        return;
      }

      console.log(`[OfflineCore:${opts.portal}] Sincronizando ${pendientes.length} acción(es) pendiente(s)…`);

      let sincronizados = 0;
      let errores       = 0;
      let conflictos    = 0;

      // FIFO y secuencial (no en paralelo): varios módulos dependen de que
      // una acción anterior ya se haya aplicado del lado del servidor antes
      // de procesar la siguiente (ej. chofer: no tiene sentido registrar una
      // devolución antes de que la entrega que la origina haya sincronizado).
      for (const accion of pendientes) {
        if (accion.intentos >= maxIntentos) {
          await _marcarError(accion.local_id, 'Máximo de reintentos alcanzado', true);
          errores++;
          continue;
        }
        try {
          const data = await opts.procesarAccion(accion, contexto);
          await _marcarSincronizado(accion.local_id, data);
          sincronizados++;
        } catch (err) {
          // Etapa 4 — conflicto real (el dato cambió en el servidor
          // mientras la acción esperaba offline): no es un error de red ni
          // de negocio reintentable a ciegas, así que NO pasa por
          // _marcarError/intentos. procesarAccion lo señala lanzando un
          // Error con `.conflicto = true`.
          if (err && err.conflicto) {
            await _marcarConflicto(accion.local_id, err.tipoConflicto, err.datosConflicto);
            conflictos++;
            if (typeof opts.onConflicto === 'function') {
              try {
                opts.onConflicto({
                  local_id: accion.local_id,
                  tipo:     err.tipoConflicto || 'conflicto',
                  datos:    err.datosConflicto || null,
                  payload:  accion.payload,
                });
              } catch (e) { /* no bloquear el sync por un hook roto */ }
            }
            continue;
          }
          const permanente = Boolean(err && err.permanente);
          await _marcarError(accion.local_id, (err && err.message) || 'Error al sincronizar', permanente);
          errores++;
        }
      }

      _estado.syncEnCurso = false;
      await _actualizar();

      if (sincronizados > 0) {
        const msg = opts.mensajes?.sincronizado
          ? opts.mensajes.sincronizado(sincronizados)
          : `${sincronizados} acción(es) offline sincronizada(s).`;
        if (window.mostrarToast) window.mostrarToast(msg, 'success');
      }
      if (errores > 0 && sincronizados === 0) {
        const msg = opts.mensajes?.pendienteError
          ? opts.mensajes.pendienteError(errores)
          : `${errores} acción(es) no pudieron sincronizarse todavía. Se reintentará automáticamente.`;
        if (window.mostrarToast) window.mostrarToast(msg, 'warning');
      }
      if (conflictos > 0) {
        const msg = opts.mensajes?.conflicto
          ? opts.mensajes.conflicto(conflictos)
          : `${conflictos} acción(es) offline necesitan tu decisión — el dato cambió en el servidor mientras esperaban sin conexión.`;
        if (window.mostrarToast) window.mostrarToast(msg, 'warning', 8000);
      }
      if (sincronizados > 0 && typeof opts.onSincronizado === 'function') {
        try { opts.onSincronizado(sincronizados); } catch (e) { /* no bloquear el sync por un hook roto */ }
      }

      console.log(`[OfflineCore:${opts.portal}] Sync completa — OK: ${sincronizados}, errores: ${errores}, conflictos: ${conflictos}`);
    }

    window.addEventListener('online', async () => {
      _estado.online = true;
      await _actualizar();
      await sincronizarPendientes();
    });

    window.addEventListener('offline', async () => {
      _estado.online = false;
      await _actualizar();
    });

    // Relevo de Background Sync: el SW nos avisa que el SO le dio una
    // ventana de conectividad — disparamos el sync real acá, que es donde
    // vive la sesión.
    if (opts.syncTag && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'BACKGROUND_SYNC' && e.data.tag === opts.syncTag) {
          sincronizarPendientes();
        }
      });
    }

    async function init() {
      await _actualizar();
      if (_estado.online) {
        const p = await getContadorPendientes();
        if (p > 0) {
          console.log(`[OfflineCore:${opts.portal}] ${p} acción(es) pendientes al iniciar — sincronizando…`);
          sincronizarPendientes();
        }
      }
    }

    // Si el módulo configuró un badge y no pisó onClickConflictos a mano,
    // el click default abre el modal genérico de resolución (ver más abajo).
    // Se resuelve aquí (no en _crearBadgeEl) porque necesita las funciones
    // de conflicto ya declaradas en este closure.
    if (opts.badge && !opts.badge.onClickConflictos) {
      opts.badge.onClickConflictos = () => _abrirModalConflictos(opts.portal, opts.badge, {
        getConflictos,
        resolverConflicto,
      });
    }

    // SYNC-04 — mismo criterio que arriba: si el módulo no pisó
    // onClickCuarentena a mano, el click default abre el modal genérico de
    // cuarentena. empresaIdActual se resuelve en el momento del click (no acá
    // arriba, arrancando la app), porque authCtx puede no estar listo todavía
    // en el momento en que se llama crearOutbox().
    if (opts.badge && !opts.badge.onClickCuarentena) {
      opts.badge.onClickCuarentena = () => _abrirModalCuarentena(opts.portal, opts.badge, {
        getCuarentena,
        confirmarCuarentena,
        descartarCuarentena,
      }, opts.getEmpresaId ? opts.getEmpresaId() : undefined);
    }

    return {
      init,
      encolarAccion,
      sincronizarPendientes,
      getPendientes,
      getContadorPendientes,
      // Etapa 4 — UI de conflicto: estaban definidas más arriba pero no se
      // exponían todavía, así que ningún módulo (ni el modal genérico de
      // abajo) podía llegar a ellas desde afuera de este closure.
      getConflictos,
      getContadorConflictos,
      resolverConflicto,
      // SYNC-04 — cuarentena de registros legacy sin tenant verificable.
      encolarLegacySinTenant,
      getCuarentena,
      getContadorCuarentena,
      confirmarCuarentena,
      descartarCuarentena,
      estaOnline: () => _estado.online,
      // Etapa 5 (OFFLINE-03) — ver definición arriba.
      guardarProgresoParcial,
    };
  }

  // ─── Caché de solo-lectura con TTL ────────────────────────────────────────
  //
  // opts:
  //   portal    — string, misma DB Dexie que un outbox del mismo módulo si
  //               corresponde (ej. 'admin_pos')
  //   store     — nombre lógico de la entidad cacheada (ej. 'productos')
  //   ttlMs     — vigencia del caché (default 2hs)
  //   keyPath   — campo que identifica cada item (default 'id')
  //   getEmpresaId() — mismo propósito y mismo default (sin scoping si no
  //               se pasa) que en crearOutbox — ver nota ahí. Items
  //               cacheados antes de cablearlo (empresa_id null) se siguen
  //               devolviendo igual; solo se excluyen items de OTRA
  //               empresa_id explícita.
  function crearCache(opts) {
    if (!opts || !opts.portal || !opts.store) {
      throw new Error('[OfflineCore] crearCache requiere { portal, store }');
    }
    const db      = _getDb(opts.portal, opts.dbVersion);
    const store   = opts.store;
    const ttlMs   = opts.ttlMs || (2 * 60 * 60 * 1000);
    const keyPath = opts.keyPath || 'id';

    async function _empresaActual() {
      if (typeof opts.getEmpresaId !== 'function') return undefined;
      return Promise.resolve(opts.getEmpresaId());
    }

    async function cachear(items) {
      if (!Array.isArray(items) || !items.length) return;
      const ahora = Date.now();
      const empresa_id = (await _empresaActual()) ?? null;
      await db.cache.bulkPut(items.map((it) => ({
        ...it,
        store,
        id: it[keyPath],
        cached_at: ahora,
        empresa_id,
      })));
    }

    async function _todosScoped() {
      const todos = await db.cache.where('store').equals(store).toArray();
      if (typeof opts.getEmpresaId !== 'function') return todos;
      const empresaId = await _empresaActual();
      return todos.filter((it) => !it.empresa_id || it.empresa_id === empresaId);
    }

    async function todosVigentes() {
      const ahora = Date.now();
      const todos = await _todosScoped();
      return todos.filter((it) => (ahora - (it.cached_at || 0)) < ttlMs);
    }

    async function frescura() {
      const todos = await _todosScoped();
      if (!todos.length) return null;
      const maxTs = Math.max(...todos.map((it) => it.cached_at || 0));
      return maxTs ? new Date(maxTs) : null;
    }

    async function limpiar() {
      if (typeof opts.getEmpresaId !== 'function') {
        await db.cache.where('store').equals(store).delete();
        return;
      }
      // Con scoping activo, no borra caché de OTRA empresa que pueda
      // convivir en el mismo dispositivo — solo lo propio (+ lo legacy sin
      // empresa_id, que de todos modos ya no se puede atribuir a nadie).
      const propios = await _todosScoped();
      await db.cache.bulkDelete(propios.map((it) => [store, it.id]));
    }

    return { cachear, todosVigentes, frescura, limpiar };
  }

  return { crearOutbox, crearCache };
})();
