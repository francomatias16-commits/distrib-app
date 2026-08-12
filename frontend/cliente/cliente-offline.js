// frontend/cliente/cliente-offline.js — v2
// Módulo offline para el portal cliente — Plan offline, Etapa 3, ítem 1
//
// v2 (Etapa 1): reescrito sobre OfflineCore (frontend/shared/offline-core.js,
// Dexie) en vez de IndexedDB manual. La API pública (window.ClienteOffline)
// NO cambió — carrito.html sigue llamando exactamente lo mismo que antes,
// cero cambios necesarios ahí.
//
// IDEMPOTENCIA:
//   Reusa el mismo mecanismo de `idempotency_key` que ya existía en
//   carrito.html ("Hallazgo 3, Etapa 1, Pedidos") — la key se genera UNA
//   vez por intento de compra (sessionStorage, en carrito.html) y viaja en
//   cada reintento, incluido el replay del outbox. `crear_pedido_cliente()`
//   (migración 443) la usa como fast-path de deduplicación: un pedido nunca
//   se duplica aunque el outbox lo reintente varias veces. Por eso
//   encolarPedido exige idempotency_key en el payload — NO usa el
//   offline_local_id genérico que arma OfflineCore para esto.
//
// Requiere, en este orden, ANTES de este archivo:
//   1. Dexie (CDN)
//   2. /frontend/shared/offline-core.js
//
// NO modifica ningún archivo existente — se integra desde carrito.html
// como <script> antes del script principal y expone window.ClienteOffline.

'use strict';

(function () {
  if (typeof OfflineCore === 'undefined') {
    console.error('[ClienteOffline] OfflineCore no está cargado — falta /frontend/shared/offline-core.js antes de este script.');
    return;
  }

  const TIPO_PEDIDO = 'pedido';

  let _getToken = async () => null;

  // Plan offline, Etapa 4: aislamiento multi-tenant — ver nota en
  // offline-core.js. A diferencia de chofer-offline.js, acá el empresa_id
  // ya se conoce ANTES de llamar a init() (carrito.html lo trae en el
  // mismo select que resuelve cliente_id) — se recibe directo por init(),
  // no hace falta un setEmpresaId() posterior.
  let _empresaId = null;

  const outbox = OfflineCore.crearOutbox({
    portal: 'cliente',
    validarTipo: (tipo) => tipo === TIPO_PEDIDO,
    getEmpresaId: () => _empresaId,

    // payload: { items, notas_cliente, canal, idempotency_key } — mismo
    // shape que ya arma carrito.html para POST /api/pedidos?accion=confirmar.
    prepararRegistro: (tipo, payload) => {
      if (!payload?.idempotency_key) {
        throw new Error('encolarPedido requiere idempotency_key');
      }
      return {};
    },

    procesarAccion: async (accion, token) => {
      const r = await fetch('/api/pedidos?accion=confirmar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(accion.payload),
      });
      const data = await r.json().catch(() => ({}));
      // idempotency_key hace seguro reintentar aunque este intento también
      // falle por red — el pedido nunca se duplica.
      if (!r.ok) {
        // Etapa 4 — UI de conflicto. El único 409 real que devuelve
        // /api/pedidos?accion=confirmar es tipo:'stock_insuficiente'
        // (crear_pedido_cliente, migración 115): alguien más vendió el
        // producto mientras el pedido esperaba offline con ese carrito.
        // No tiene sentido reintentar a ciegas con la misma cantidad — el
        // usuario tiene que revisar el carrito. Cualquier otro status
        // (500, red caída, etc.) sigue siendo un error transitorio y
        // reintenta normal como antes.
        if (r.status === 409 && data.tipo === 'stock_insuficiente') {
          const err = new Error(data.error || 'El stock cambió mientras el pedido esperaba sin conexión');
          err.conflicto = true;
          err.tipoConflicto = 'stock_insuficiente';
          err.datosConflicto = { error: data.error || null };
          throw err;
        }
        throw new Error(data.error || data.mensaje || `HTTP ${r.status}`);
      }
      return data;
    },

    getContexto: () => _getToken(),

    // Etapa 4 — si el pedido queda en conflicto, el carrito local (que ya
    // se había vaciado al encolar) no debe seguir mostrándose como
    // "enviado" sin más: si carrito.html expone un refresco, lo llamamos
    // igual que en onSincronizado para que la pantalla no quede
    // desactualizada mientras el cliente decide.
    onConflicto: () => {
      if (typeof window.cargarCarrito === 'function') {
        window.cargarCarrito().catch(() => {});
      }
    },

    badge: {
      selector: '.topbar-row, .topbar',
      titulo:   'Estado de conexión',
      singular: 'pedido',
      plural:   'pedidos',
      ocultarSiInactivo: true,
      insertarAlFinal: true,

      // Texto del modal de resolución de conflictos (offline-core.js).
      formatoConflicto: (reg) => {
        const d = reg.conflicto_datos || {};
        return {
          titulo:  'Pedido: el stock cambió mientras estabas sin conexión',
          detalle: (d.error || 'Uno o más productos ya no tienen stock suficiente.') +
                    ' Revisá las cantidades antes de reintentar, o descartá el pedido.',
        };
      },
    },

    // Sin mensajes.sincronizado acá a propósito — el texto de éxito de
    // cliente es distinto al genérico ("tu pedido ya se envió") y necesita
    // fallback a alert() si mostrarToast no está disponible en esta
    // página; se resuelve en onSincronizado en vez del hook de mensajes.
    onSincronizado: (n) => {
      const msg = n === 1
        ? 'Tu pedido pendiente ya se envió — quedó confirmado.'
        : `${n} pedidos pendientes ya se enviaron — quedaron confirmados.`;
      if (window.mostrarToast) window.mostrarToast(msg, 'success');
      else alert(msg);
    },

    syncTag: 'sync-cliente-outbox',
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  async function init({ getToken, empresaId } = {}) {
    if (typeof getToken === 'function') _getToken = getToken;
    _empresaId = empresaId ?? null;
    await outbox.init();
    console.log('[ClienteOffline] Inicializado OK');
  }

  // ─── API pública ──────────────────────────────────────────────────────────
  // v3 (Etapa 4): se suman getConflictos/getContadorConflictos/
  // resolverConflicto — lo demás sigue igual que v1/v2, ningún llamador
  // existente (carrito.html) se rompe. El modal en sí ya lo maneja
  // offline-core.js vía el badge; esto es por si carrito.html quiere
  // consultar el contador o armar su propia UI en algún otro lugar.
  window.ClienteOffline = {
    init,
    encolarPedido:          (payload) => outbox.encolarAccion(TIPO_PEDIDO, payload),
    sincronizarPendientes:  outbox.sincronizarPendientes,
    getPendientes:          outbox.getPendientes,
    getContadorPendientes:  outbox.getContadorPendientes,
    getConflictos:          outbox.getConflictos,
    getContadorConflictos:  outbox.getContadorConflictos,
    resolverConflicto:      outbox.resolverConflicto,
    estaOnline:             outbox.estaOnline,
  };
})();
