// frontend/admin/js/pos-offline.js — v4
// Módulo offline para el POS — Feature #3 Grupo B
//
// v2 (Etapa 1): reescrito sobre OfflineCore (frontend/shared/offline-core.js,
// Dexie) en vez de IndexedDB manual. La API pública (window.PosOffline) NO
// cambió — pos.js sigue llamando exactamente lo mismo que antes, cero
// cambios necesarios ahí.
//
// Dos piezas de OfflineCore en uso acá:
//   1. Un outbox (dos tipos: 'venta' y 'facturar', misma cola FIFO) para la
//      cola de ventas y facturaciones pendientes.
//   2. Un cache con TTL (2hs) para el catálogo de productos — sigue siendo
//      "solo lectura", no pasa por el outbox.
//
// v4 (Etapa 5 — AFIP tolerante a offline): se suma el tipo 'facturar' a la
// misma cola. Antes, si el cajero apretaba "Facturar" (o confirmaba el modal
// post-cobro) sin señal, pos.js mostraba un error genérico y no quedaba
// ningún registro de que había que reintentar — dependía de que alguien se
// acordara de volver a entrar a la venta más tarde. Ahora se encola igual
// que una venta: POST /api/pos/facturar diferido, mismo outbox, mismo FIFO
// (importa el orden: si la venta en sí también estaba encolada, se procesa
// primero — ver bucle secuencial en offline-core.js). El backend ya es
// idempotente por venta_pos_id (ver lib/facturas.js / emitirFactura) así que
// reintentar no duplica el comprobante; no hace falta offline_local_id acá
// como sí lo necesita 'venta' para su propio dedup.
//
// v3 (Etapa 4 — UI de conflicto + FIX de un bug real): la política de v2
// ("409 ⇒ duplicado ⇒ éxito silencioso") quedó rota y encima peligrosa.
// Tenía sentido cuando /api/pos devolvía 409 únicamente para el duplicado
// por offline_local_id — pero desde que registrar_venta_pos_offline_dedup
// (migración 181) resuelve ese caso devolviendo 200/201 normal con
// rpcResult.ya_existia:true (ver lib/handlers/pos.js), el 409 quedó libre
// para lo que realmente es HOY: un rechazo de negocio real
// (stock_insuficiente, turno_cerrado — ver el mapeo tipo→status en
// lib/handlers/pos.js). v2 tomaba cualquiera de esos rechazos como
// "duplicado, ya está sincronizado" — es decir, enmascaraba ventas
// RECHAZADAS como sincronizadas: el vendedor creía que había entrado y en
// realidad nunca se descontó stock ni se cobró nada. Ahora cualquier 4xx
// (stock_insuficiente, turno_cerrado, pagos_no_coinciden, limite_credito,
// cliente_requerido) pasa por la UI de conflicto genérica de OfflineCore
// — igual que ya hacen stock-offline.js/cliente-offline.js/
// cobros-offline.js — para que el vendedor vea el motivo real y decida
// (reintentar tras revisar, o descartar la venta). Un 5xx real (error
// interno transitorio) sigue reintentándose solo, sin marcar conflicto.
//
// Requiere, en este orden, ANTES de este archivo:
//   1. Dexie (CDN)
//   2. /frontend/shared/offline-core.js
//
// NO modifica ningún archivo existente — se integra desde pos.html como
// <script> antes de pos.js y expone window.PosOffline.

'use strict';

(function () {
  if (typeof OfflineCore === 'undefined') {
    console.error('[PosOffline] OfflineCore no está cargado — falta /frontend/shared/offline-core.js antes de este script.');
    return;
  }

  const TIPO_VENTA     = 'venta';
  const TIPO_FACTURAR  = 'facturar';

  // v1 usaba IndexedDB manual sobre 'pos_offline_db' en version 2 (stores
  // productos_cache / ventas_pendientes / sync_log). OfflineCore reusa el
  // mismo nombre de DB para no perder ventas ya encoladas por usuarios con
  // la app abierta desde antes de este cambio — pero con schema nuevo, así
  // que hace falta subir la versión (3) para que IndexedDB permita el
  // upgrade en vez de rechazarlo por ser "menor a la ya instalada".
  const DB_VERSION_POS = 3;

  const cacheProductos = OfflineCore.crearCache({
    portal:    'pos',
    store:     'productos',
    ttlMs:     2 * 60 * 60 * 1000, // 2hs — mismo valor que v1
    keyPath:   'id',
    dbVersion: DB_VERSION_POS,
    // Plan offline, Etapa 4: aislamiento multi-tenant — ver nota en
    // offline-core.js y en cobros-offline.js/stock-offline.js.
    getEmpresaId: () => window.authCtx?.perfil?.empresa_id,
  });

  // Etapa 5 — procesa el diferido de 'facturar' (POST /api/pos/facturar).
  // Separado de 'venta' porque el endpoint y el vocabulario de errores son
  // distintos (acá no hay offline_local_id: la idempotencia la da
  // venta_pos_id del lado del servidor, ver nota de v4 más arriba).
  async function _procesarFacturar(accion, token) {
    const resp = await fetch('/api/pos/facturar', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${token}`,
      },
      body: JSON.stringify(accion.payload),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // 429 (limiterFacturar) es transitorio por diseño — no es una decisión
      // de negocio sobre ESTA venta, así que no corresponde tratarlo como
      // conflicto que le pida algo al usuario: se reintenta solo, como
      // cualquier otro error transitorio.
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        // /api/pos/facturar no manda `data.tipo` (a diferencia de /api/pos) —
        // discriminamos el título del modal por status/mensaje. 404/400 son
        // estados de la venta que cambiaron mientras esperaba offline
        // (la anuló otro usuario, etc.); 422 es un error real de emisión
        // AFIP que ya quedó registrado en la factura como pendiente/error
        // (ver emitirFactura en lib/facturas.js) — reintentar desde acá es
        // exactamente lo mismo que apretar "Reintentar" a mano.
        const tipo = resp.status === 404 ? 'venta_no_encontrada'
          : resp.status === 400 ? 'venta_anulada'
          : 'error_afip';
        const err = new Error(data.error || `HTTP ${resp.status}`);
        err.conflicto = true;
        err.tipoConflicto = tipo;
        err.datosConflicto = { error: data.error || null };
        throw err;
      }
      throw new Error(data.error || `HTTP ${resp.status}`);
    }

    return data;
  }

  const outbox = OfflineCore.crearOutbox({
    portal: 'pos',
    dbVersion: DB_VERSION_POS,
    validarTipo: (tipo) => tipo === TIPO_VENTA || tipo === TIPO_FACTURAR,
    getEmpresaId: () => window.authCtx?.perfil?.empresa_id,

    // IDEMPOTENCIA: offline_local_id (generado por OfflineCore al encolar)
    // viaja como offline_local_id en el body — /api/pos lo usa para
    // deduplicar (mismo mecanismo que ya validaba v1). El duplicado en sí
    // ya no pasa por acá como error: el servidor lo resuelve devolviendo
    // 200/201 normal con ya_existia:true (ver nota de v3 más arriba).
    //
    // Etapa 5 — 'facturar' no pasa por /api/pos, así que se deriva acá
    // mismo a _procesarFacturar antes de tocar nada de lo de venta.
    procesarAccion: async (accion, token) => {
      if (accion.tipo === TIPO_FACTURAR) return _procesarFacturar(accion, token);

      const resp = await fetch('/api/pos', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...accion.payload,
          offline_local_id: accion.offline_local_id,
        }),
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        if (resp.status >= 400 && resp.status < 500) {
          // v3 (Etapa 4) — ver nota arriba: todo 4xx acá es una decisión de
          // negocio real que ya evaluó el servidor contra el turno/caja/
          // stock actuales, no un error transitorio de red. `data.tipo`
          // (stock_insuficiente | turno_cerrado | pagos_no_coinciden |
          // limite_credito | cliente_requerido) llega directo de
          // lib/handlers/pos.js — se usa tal cual para el título del modal.
          const err = new Error(data.error || `HTTP ${resp.status}`);
          err.conflicto = true;
          err.tipoConflicto = data.tipo || 'rechazado_servidor';
          err.datosConflicto = { error: data.error || null, tipo: data.tipo || null };
          throw err;
        }
        // 5xx u otro caso sin body reconocible — error transitorio real,
        // sigue el camino normal de reintento (no conflicto, no permanente).
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      return data;
    },

    getContexto: () => window.authCtx?.session?.access_token || null,

    // Etapa 4 — si una venta encolada termina en conflicto, refrescamos el
    // listado de ventas del panel admin (si el vendedor lo tiene abierto)
    // para que no quede desactualizado mientras decide qué hacer.
    onConflicto: () => {
      if (typeof window.cargarVentas === 'function') {
        window.cargarVentas().catch(() => {});
      }
    },

    badge: {
      selector: '.topbar-right',
      titulo:   'Estado de conexión del POS',
      singular: 'venta',
      plural:   'ventas',

      // Texto del modal de resolución de conflictos (offline-core.js).
      // Etapa 5 — la cola mezcla 'venta' y 'facturar', así que el título
      // depende de ambos: reg.tipo (qué acción era) + reg.conflicto_tipo
      // (por qué la rechazó el servidor).
      formatoConflicto: (reg) => {
        const d = reg.conflicto_datos || {};

        if (reg.tipo === TIPO_FACTURAR) {
          const TITULOS_FACTURAR = {
            venta_no_encontrada: 'No se pudo facturar: la venta ya no existe',
            venta_anulada:       'No se pudo facturar: la venta fue anulada mientras tanto',
            error_afip:          'No se pudo emitir el comprobante ante AFIP/ARCA',
          };
          return {
            titulo:  TITULOS_FACTURAR[reg.conflicto_tipo] || 'No se pudo facturar esta venta',
            detalle: (d.error || 'El servidor no pudo emitir la factura.') +
                      ' La venta en sí ya está registrada — esto solo afecta al comprobante fiscal. Revisá el estado antes de reintentar. "Descartar" no borra nada del servidor, solo saca este pendiente de la cola local; podés volver a facturar la venta a mano desde el listado de ventas.',
          };
        }

        const TITULOS = {
          stock_insuficiente: 'Venta rechazada: no hay stock suficiente',
          turno_cerrado:      'Venta rechazada: el turno de caja ya está cerrado',
          pagos_no_coinciden: 'Venta rechazada: los pagos no coinciden con el total',
          limite_credito:     'Venta rechazada: supera el límite de crédito del cliente',
          cliente_requerido:  'Venta rechazada: falta elegir un cliente para cuenta corriente',
        };
        return {
          titulo:  TITULOS[reg.conflicto_tipo] || 'Venta rechazada por el servidor',
          detalle: (d.error || 'El servidor no pudo registrar esta venta.') +
                    ' Revisá el estado actual (stock, turno, cliente) antes de reintentar — puede haber cambiado mientras la venta esperaba sin conexión. "Descartar" no borra nada del servidor, solo saca esta venta de la cola local.',
        };
      },

      // SYNC-04 — texto del modal de cuarentena (offline-core.js) para las
      // ventas migradas desde pos_offline_db v1 (ver _migrarVentasPendientesV1).
      // reg.payload acá es el mismo `body` que arma ejecutarVenta() en pos.js:
      // no trae un total ya calculado, así que se suma pagos[].monto.
      formatoCuarentena: (reg) => {
        const body  = reg.payload || {};
        const fecha = reg.created_at ? new Date(reg.created_at).toLocaleString('es-AR') : 'fecha desconocida';
        const monto = Array.isArray(body.pagos)
          ? body.pagos.reduce((acc, p) => acc + (Number(p.monto) || 0), 0)
          : null;
        const nItems = Array.isArray(body.items) ? body.items.length : 0;

        return {
          titulo:  `Venta antigua — ${fecha}`,
          detalle: (monto != null ? `$ ${monto.toLocaleString('es-AR')} · ` : '') +
                    `${nItems} ítem${nItems === 1 ? '' : 's'}. Encolada en este dispositivo antes del aislamiento por empresa (cola v1) — confirmala solo si esta venta es de tu empresa.`,
        };
      },
    },

    // Etapa 5 — n es el total sincronizado en esta pasada SIN distinguir
    // tipo (offline-core.js solo cuenta, ver sincronizarPendientes): la cola
    // puede traer ventas y facturaciones mezcladas, así que el mensaje usa
    // "pendiente(s)" genérico en vez de forzar un singular/plural por tipo
    // que a veces sería incorrecto.
    mensajes: {
      sincronizado: (n) => n === 1
        ? '1 pendiente offline (venta o factura) sincronizado con el servidor.'
        : `${n} pendientes offline (ventas y/o facturas) sincronizados.`,
      pendienteError: (n) => `${n} pendiente(s) no pudieron sincronizarse. Se reintentará automáticamente.`,
    },

    syncTag: 'sync-pos-outbox',

  });

  window.addEventListener('offline', () => {
    if (window.mostrarToast) {
      window.mostrarToast('Sin internet. Las ventas se guardan localmente y se sincronizan al reconectar.', 'warning', 5000);
    }
  });

  // ─── Caché de catálogo (sin cambios de comportamiento respecto a v1) ─────

  async function buscarProductosLocal(q) {
    const vigentes = await cacheProductos.todosVigentes();
    const activos  = vigentes.filter((p) => p.activo !== false);
    if (!activos.length) return [];

    if (!q || q.length < 2) return activos.slice(0, 20);

    const termino = q.toLowerCase().trim();
    return activos
      .filter((p) =>
        (p.nombre || '').toLowerCase().includes(termino) ||
        (p.codigo || '').toLowerCase().includes(termino) ||
        (p.codigo_barras || '').includes(termino)
      )
      .slice(0, 30);
  }

  // ─── Migración one-shot desde v1 (IndexedDB manual, version 2) ───────────
  // Se ejecuta ANTES de que OfflineCore abra 'pos_offline_db' en la versión
  // nueva — así lee la cola vieja con su propia conexión (versión 2, sin
  // upgrade) y la cierra antes de que Dexie la reabra en versión 3.
  async function _migrarVentasPendientesV1() {
    try {
      if (indexedDB.databases) {
        const existentes = await indexedDB.databases();
        if (!existentes.some((d) => d.name === 'pos_offline_db' && d.version >= 2)) return;
      }

      const dbVieja = await new Promise((resolve, reject) => {
        const req = indexedDB.open('pos_offline_db', 2);
        req.onupgradeneeded = () => { /* no tocar el schema legacy acá */ };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = () => reject(req.error);
      });

      if (!dbVieja.objectStoreNames.contains('ventas_pendientes')) {
        dbVieja.close();
        return;
      }

      const todas = await new Promise((resolve, reject) => {
        const r = dbVieja.transaction('ventas_pendientes', 'readonly')
          .objectStore('ventas_pendientes').getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror   = () => reject(r.error);
      });

      const pendientes = todas.filter((v) => v.estado === 'pendiente');
      for (const v of pendientes) {
        // FIX SYNC-04: antes esto llamaba a outbox.encolarAccion(), que le
        // pone el empresa_id de la SESIÓN ACTUAL al registro migrado. Estas
        // ventas son de la cola v1 (pre-multi-tenant), sin ningún dato de a
        // qué empresa pertenecen realmente — en un dispositivo compartido
        // entre usuarios de dos empresas, una venta vieja de la Empresa A
        // podía terminar sincronizada y ejecutada bajo la Empresa B si es
        // B quien dispara esta migración al abrir el POS. Ahora quedan en
        // cuarentena (no se auto-sincronizan con nadie) hasta revisión
        // explícita — ver PosOffline.getCuarentenaLegacy()/
        // confirmarCuarentenaLegacy()/descartarCuarentenaLegacy().
        await outbox.encolarLegacySinTenant(TIPO_VENTA, v.body, 'pos_offline_db_v1');
      }

      if (pendientes.length) {
        // Vaciar la cola vieja para no volver a migrarla la próxima vez.
        await new Promise((resolve, reject) => {
          const r = dbVieja.transaction('ventas_pendientes', 'readwrite')
            .objectStore('ventas_pendientes').clear();
          r.onsuccess = resolve;
          r.onerror   = () => reject(r.error);
        });
        console.warn(`[PosOffline] ${pendientes.length} venta(s) pendiente(s) migradas desde pos_offline_db v1 quedaron en CUARENTENA — no tienen empresa_id verificable y no se sincronizan solas. Revisar con PosOffline.getCuarentenaLegacy() y confirmar la empresa correcta antes de liberarlas.`);
        if (typeof window.toast === 'function') {
          window.toast(`Hay ${pendientes.length} venta(s) offline antiguas pendientes de revisión manual (dispositivo compartido) — ver soporte`, 'warn');
        }
      }

      dbVieja.close();
    } catch (err) {
      // Best-effort — no bloquea el arranque del POS si la migración falla
      // (ej. navegador sin la DB vieja, o ya migrada antes).
      console.warn('[PosOffline] Migración de ventas pendientes v1 no aplicada:', err?.message || err);
    }
  }

  // Defensa en profundidad: OfflineCore.crearOutbox() NO tira excepción si
  // Dexie no está cargado — devuelve `null` a propósito (ver offline-core.js,
  // rama `typeof Dexie === 'undefined'`), para que un módulo pueda decidir
  // su propio fallback. Sin este guard, cualquier uso de outbox.* de más
  // abajo tira un TypeError síncrono DENTRO de este IIFE y window.PosOffline
  // nunca llega a asignarse — el POS queda sin ningún rastro de por qué
  // (mismo síntoma que "el script no cargó", pero mucho más difícil de
  // diagnosticar porque el resto de la página sigue funcionando normal).
  // Mismo fix que ya tenía proveedor-offline.js (OFFLINE-02).
  if (!outbox) {
    console.error('[PosOffline] OfflineCore.crearOutbox() devolvió null — Dexie no estaba disponible. Sin soporte offline en esta carga.');
    return;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    await _migrarVentasPendientesV1();
    await outbox.init();
    console.log('[PosOffline] Inicializado OK');
  }

  // ─── API pública ──────────────────────────────────────────────────────────
  // v3 (Etapa 4): se suman getConflictos/getContadorConflictos/
  // resolverConflicto — lo demás sigue igual que v1/v2, pos.js no necesita
  // ningún cambio. El modal en sí ya lo maneja offline-core.js vía el badge.
  window.PosOffline = {
    init,
    cachearProductos:      cacheProductos.cachear,
    buscarProductosLocal,
    cacheFrescura:         cacheProductos.frescura,
    encolarVenta:          (body) => outbox.encolarAccion(TIPO_VENTA, body),
    // Etapa 5 — encola una emisión de factura diferida. pos.js llama esto
    // con solo el venta_pos_id (mismo shape que espera /api/pos/facturar).
    encolarFacturar:       (venta_pos_id) => outbox.encolarAccion(TIPO_FACTURAR, { venta_pos_id }),
    sincronizarPendientes: outbox.sincronizarPendientes,
    getPendientes:         outbox.getPendientes,
    getContadorPendientes: outbox.getContadorPendientes,
    getConflictos:         outbox.getConflictos,
    getContadorConflictos: outbox.getContadorConflictos,
    resolverConflicto:     outbox.resolverConflicto,
    // SYNC-04 — revisión manual de ventas legacy v1 en cuarentena (ver
    // _migrarVentasPendientesV1 más arriba): no se sincronizan solas.
    getCuarentenaLegacy:        outbox.getCuarentena,
    getContadorCuarentenaLegacy: outbox.getContadorCuarentena,
    confirmarCuarentenaLegacy:   outbox.confirmarCuarentena,
    descartarCuarentenaLegacy:   outbox.descartarCuarentena,
    estaOnline:            outbox.estaOnline,
  };
})();
