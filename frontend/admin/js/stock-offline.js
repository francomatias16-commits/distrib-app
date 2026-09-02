// frontend/admin/js/stock-offline.js — v3
// Módulo offline para ajustes de stock / conteos / transferencias —
// Plan offline, Etapa 3, ítems 2 y 5.
//
// v2 (Etapa 1): reescrito sobre OfflineCore (frontend/shared/offline-core.js,
// Dexie) en vez de IndexedDB manual. La API pública (window.StockOffline) NO
// cambió — stock.js sigue llamando exactamente lo mismo que antes, cero
// cambios necesarios ahí.
//
// v3 (Etapa 3, ítem 5): se suma transferir_stock. Al igual que
// ajustar_stock/registrar_conteo_stock, ahora es idempotente por
// p_offline_local_id (migración 446) — con la diferencia de que esa función
// inserta DOS filas en movimientos_stock (origen + destino), así que la
// dedup en el servidor se hace por la fila de origen (offline_local_id tal
// cual) y la de destino se graba con sufijo '-destino'. Del lado del
// outbox no cambia nada: se sigue mandando un único offline_local_id, igual
// que con los otros dos tipos.
//
// ALCANCE (a propósito, no es todo "guardarAjuste" en stock.js):
//   Ingreso/egreso manual (ajustar_stock), ajuste/conteo físico
//   (registrar_conteo_stock) y transferencia entre depósitos
//   (transferir_stock) quedan encolables acá. Producción con insumos
//   (producir_con_insumos) todavía NO está cubierta — queda "solo red".
//
// Requiere, en este orden, ANTES de este archivo:
//   1. Dexie (CDN)
//   2. /frontend/shared/offline-core.js
//
// NO modifica ningún archivo existente — se integra desde stock.html como
// <script> antes de stock.js y expone window.StockOffline.

'use strict';

(function () {
  if (typeof OfflineCore === 'undefined') {
    console.error('[StockOffline] OfflineCore no está cargado — falta /frontend/shared/offline-core.js antes de este script.');
    return;
  }

  // tipo -> nombre de la función RPC que se llama al sincronizar
  const RPC_POR_TIPO = {
    ajustar_stock:          'ajustar_stock',
    registrar_conteo_stock: 'registrar_conteo_stock',
    transferir_stock:       'transferir_stock',
  };

  let _getSb = () => window.authCtx?.sb || null;

  const outbox = OfflineCore.crearOutbox({
    portal: 'admin_stock',
    validarTipo: (tipo) => Boolean(RPC_POR_TIPO[tipo]),
    // Plan offline, Etapa 4: aislamiento multi-tenant — ver nota en
    // offline-core.js y en pos-offline.js/cobros-offline.js.
    getEmpresaId: () => window.authCtx?.perfil?.empresa_id,

    // IDEMPOTENCIA: cada acción encolada lleva un offline_local_id
    // (crypto.randomUUID(), generado por OfflineCore al encolar). Los dos
    // RPC de acá lo aceptan como p_offline_local_id — fast-path de
    // deduplicación, migración 443. Esto es lo que hace seguro reintentar
    // sin duplicar el movimiento ni el conteo.
    procesarAccion: async (accion, sb) => {
      const { tipo, payload, offline_local_id } = accion;
      const nombreRpc = RPC_POR_TIPO[tipo];

      const { data, error } = await window.conTimeoutRed(sb.rpc(nombreRpc, {
        ...payload,
        p_offline_local_id: offline_local_id,
      }), 10000);

      if (error) throw error;

      if (!data?.ok) {
        // Etapa 4 — UI de conflicto. Todo rechazo de estas tres RPC
        // (ok:false) llega ACÁ después de haber esperado sin conexión, así
        // que reintentar a ciegas no tiene sentido: o el dato de referencia
        // quedó viejo (registrar_conteo_stock, que sí devuelve un `tipo`
        // explícito porque compara contra p_stock_sistema_esperado), o es
        // un rechazo de negocio (stock insuficiente, depósito ya no existe,
        // etc.) que solo se resuelve si el usuario decide algo — antes esto
        // caía en _marcarError como reintentable y quedaba reintentando en
        // loop para siempre sin que el usuario se enterara del motivo real.
        const err = new Error(data?.error || 'El servidor rechazó el movimiento');
        err.conflicto = true;
        err.tipoConflicto = data.tipo === 'conflicto_stock_cambio' ? 'conflicto_stock_cambio' : 'rechazado_servidor';
        err.datosConflicto = {
          error: data.error || null,
          stock_sistema_esperado: data.stock_sistema_esperado ?? null,
          stock_sistema_actual:   data.stock_sistema_actual   ?? null,
          stock_disponible:       data.stock_disponible       ?? null,
        };
        throw err;
      }

      return data;
    },

    getContexto: () => _getSb(),

    // Etapa 4 — cuando procesarAccion marca conflicto, refrescamos la
    // tabla igual que en onSincronizado: el badge cambia a "conflictos por
    // resolver" y conviene que lo que se ve en pantalla no quede
    // desactualizado mientras el usuario decide.
    onConflicto: () => {
      if (typeof window.cargarStock === 'function') {
        window.cargarStock().catch(() => {});
      }
    },

    badge: {
      selector: '.topbar-right',
      titulo:   'Estado de conexión de Stock',
      singular: 'movimiento',
      plural:   'movimientos',

      // Texto del modal de resolución de conflictos (offline-core.js).
      formatoConflicto: (reg) => {
        const d = reg.conflicto_datos || {};
        const nombreTipo = {
          ajustar_stock:          'Ingreso/egreso manual',
          registrar_conteo_stock: 'Conteo físico',
          transferir_stock:       'Transferencia entre depósitos',
        }[reg.tipo] || 'Movimiento de stock';

        if (reg.conflicto_tipo === 'conflicto_stock_cambio') {
          return {
            titulo:  `${nombreTipo}: el stock cambió mientras estabas sin conexión`,
            detalle: `El sistema esperaba ${d.stock_sistema_esperado} y ahora tiene ${d.stock_sistema_actual}. ` +
                     `"Reintentar" vuelve a enviar el conteo tomando el stock actual como referencia — revisá si sigue siendo correcto antes.`,
          };
        }
        return {
          titulo:  `${nombreTipo}: el servidor lo rechazó`,
          detalle: (d.error || 'No se pudo aplicar.') +
                    ' — puede que otra persona haya movido este stock mientras estabas sin conexión.',
        };
      },

      // Al reintentar un conflicto_stock_cambio, pisamos el "esperado" con
      // el valor actual del servidor que ya nos llegó en conflicto_datos —
      // si no, la RPC va a rechazar el reintento otra vez con el mismo
      // conflicto (el payload original sigue teniendo el esperado viejo).
      armarPayloadReintento: (reg) => {
        if (reg.conflicto_tipo === 'conflicto_stock_cambio' && reg.conflicto_datos?.stock_sistema_actual != null) {
          return { p_stock_sistema_esperado: reg.conflicto_datos.stock_sistema_actual };
        }
        return {};
      },
    },

    mensajes: {
      sincronizado: (n) => n === 1
        ? '1 movimiento de stock offline sincronizado con el servidor.'
        : `${n} movimientos de stock offline sincronizados.`,
      pendienteError: (n) => `${n} movimiento(s) de stock no pudieron sincronizarse todavía. Se reintentará automáticamente.`,
    },

    // Refrescar la tabla si el usuario sigue en Stock, para que los
    // movimientos recién sincronizados aparezcan sin recargar a mano.
    onSincronizado: () => {
      if (typeof window.cargarStock === 'function') {
        window.cargarStock().catch(() => {});
      }
    },

    // Background Sync best-effort (ver nota en offline-core.js) — si el SW
    // recibe el evento 'sync' con este tag, avisa a esta pestaña y acá se
    // dispara el sync real (necesita la sesión de sb, solo vive en la página).
    syncTag: 'sync-stock-outbox',
  });

  window.addEventListener('offline', () => {
    if (window.mostrarToast) {
      window.mostrarToast('Sin internet. Los movimientos de stock que registres ahora se guardan en el dispositivo y se envían solos al reconectar.', 'warning', 5000);
    }
  });

  // Defensa en profundidad: OfflineCore.crearOutbox() NO tira excepción si
  // Dexie no está cargado — devuelve `null` a propósito (ver offline-core.js,
  // rama `typeof Dexie === 'undefined'`), para que un módulo pueda decidir
  // su propio fallback. Sin este guard, cualquier uso de outbox.* de más
  // abajo tira un TypeError síncrono DENTRO de este IIFE y
  // window.StockOffline nunca llega a asignarse — la página queda sin
  // ningún rastro de por qué (mismo síntoma que "el script no cargó", pero
  // mucho más difícil de diagnosticar porque el resto de la página sigue
  // funcionando normal). Mismo fix que ya tenía proveedor-offline.js
  // (OFFLINE-02).
  if (!outbox) {
    console.error('[StockOffline] OfflineCore.crearOutbox() devolvió null — Dexie no estaba disponible. Sin soporte offline en esta carga.');
    return;
  }

  async function init({ getSb } = {}) {
    if (typeof getSb === 'function') _getSb = getSb;
    await outbox.init();
  }

  // ─── API pública ────────────────────────────────────────────────────────
  // v3 (Etapa 4): se suman getConflictos/getContadorConflictos/
  // resolverConflicto — lo demás sigue igual que v1, ningún llamador
  // existente se rompe. El modal en sí (abrirlo al hacer click en el badge)
  // ya lo maneja offline-core.js; esto es para quien quiera armar su propia
  // UI o consultar el contador desde otro lado de stock.js.
  window.StockOffline = {
    init,
    encolarAccion:         outbox.encolarAccion,
    sincronizarPendientes: outbox.sincronizarPendientes,
    getPendientes:         outbox.getPendientes,
    getContadorPendientes: outbox.getContadorPendientes,
    getConflictos:         outbox.getConflictos,
    getContadorConflictos: outbox.getContadorConflictos,
    resolverConflicto:     outbox.resolverConflicto,
    estaOnline:            outbox.estaOnline,
  };
})();
