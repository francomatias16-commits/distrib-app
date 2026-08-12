// frontend/admin/js/cobros-offline.js — v3
// Módulo offline para cobros sueltos (no atados a una entrega del chofer)
// — Plan offline, Etapa 3, ítem 4.
//
// ALCANCE: cobros registrados desde cta-cte.js / cobranzas.html
// (`guardarCobro()`) — tanto el genérico ("Saldos por cliente") como el
// vinculado a una factura puntual ("Facturas pendientes"). El cobro que ya
// viaja atado a una entrega del chofer (remito.html) NO pasa por acá —
// sigue su propio camino en chofer-offline.js (encolado junto con la
// confirmación de entrega, migración 444, sufijo -cobro).
//
// REGLA DE CONFLICTO (Etapa 0 — "el caso que el propio plan marca como más
// delicado"): dos cobros offline del mismo cliente NUNCA se pisan entre sí
// — cada uno es un insert independiente en `cobros` con su propio
// offline_local_id (fast-path de deduplicación, migración 444, backstop con
// índice único ante una carrera real). Lo que SÍ puede pasar es que, en
// conjunto, terminen superando la deuda real del cliente — eso no se puede
// detectar mientras están offline (cada dispositivo ve solo su propia
// cola). No es un bloqueo: es una alerta post-sync. Por eso, después de
// sincronizar cada cobro, se vuelve a consultar `calcular_deuda_cliente()`
// y si el cliente quedó con saldo a favor se avisa para que un admin lo
// revise — ver procesarAccion() más abajo.
//
// v3 (Etapa 4 — UI de conflicto): hasta acá, un rechazo de negocio de
// registrar_cobro_completo (ok:false — factura ya saldada, factura anulada,
// cliente no encontrado, monto inválido, etc., ver migración 444) caía como
// error genérico y quedaba reintentando en loop sin que el usuario se
// enterara del motivo real — mismo bug ya corregido en pos-offline.js/
// stock-offline.js/chofer-offline.js. Acá no hay un `tipo` explícito en la
// respuesta (a diferencia de registrar_conteo_stock): todo ok:false es el
// caso genérico "rechazado_servidor", con el mensaje de la RPC tal cual
// para el detalle del modal. Un error real de sb.rpc (red, timeout) sigue
// el camino normal de reintento — no es conflicto.
//
// IDEMPOTENCIA: offline_local_id lo genera OfflineCore al encolar
// (crypto.randomUUID()) y viaja como p_offline_local_id — mismo mecanismo
// que ya usan stock-offline.js y chofer-offline.js.
//
// Requiere, en este orden, ANTES de este archivo:
//   1. Dexie (CDN)
//   2. /frontend/shared/offline-core.js
//
// NO modifica ningún archivo existente — se integra desde cobranzas.html
// como <script> antes de cta-cte.js y expone window.CobrosOffline.

'use strict';

(function () {
  if (typeof OfflineCore === 'undefined') {
    console.error('[CobrosOffline] OfflineCore no está cargado — falta /frontend/shared/offline-core.js antes de este script.');
    return;
  }

  const TIPO_COBRO = 'registrar_cobro_completo';

  let _getSb = () => window.authCtx?.sb || null;

  const outbox = OfflineCore.crearOutbox({
    portal: 'admin_cobros',
    validarTipo: (tipo) => tipo === TIPO_COBRO,
    // Plan offline, Etapa 4: aislamiento multi-tenant — ver nota en
    // offline-core.js y en pos-offline.js/stock-offline.js.
    getEmpresaId: () => window.authCtx?.perfil?.empresa_id,

    procesarAccion: async (accion, sb) => {
      const { payload, offline_local_id } = accion;

      const { data, error } = await sb.rpc(TIPO_COBRO, {
        ...payload,
        p_offline_local_id: offline_local_id,
      });

      if (error) throw error;

      if (!data?.ok) {
        // v3 (Etapa 4) — ver nota arriba: ok:false es un rechazo de negocio
        // real evaluado por la RPC contra el estado actual (factura ya
        // saldada/anulada, cliente inexistente, monto inválido), no un
        // error transitorio de red. Pasa por la UI de conflicto genérica de
        // OfflineCore para que el usuario vea el motivo y decida.
        const err = new Error(data?.error || 'El servidor rechazó el cobro');
        err.conflicto = true;
        err.tipoConflicto = 'rechazado_servidor';
        err.datosConflicto = { error: data?.error || null };
        throw err;
      }

      // Alerta post-sync de saldo a favor (ver nota de arriba) — best-effort:
      // si esta consulta falla no se pierde el cobro ya sincronizado, solo
      // no se muestra el aviso.
      try {
        const { data: deuda } = await sb.rpc('calcular_deuda_cliente', {
          p_cliente_id: payload.p_cliente_id,
        });
        if (typeof deuda === 'number' && deuda < 0 && window.mostrarToast) {
          window.mostrarToast(
            `Cobro offline sincronizado (${data.nro}) — el cliente quedó con saldo a favor de $${Math.abs(deuda).toFixed(2)}. Revisar cta-cte.`,
            'warning',
            8000
          );
        }
      } catch (e) { /* best-effort */ }

      return data;
    },

    getContexto: () => _getSb(),

    // Etapa 4 — si un cobro encolado termina en conflicto, refrescamos
    // cta-cte / KPIs igual que en onSincronizado, para que no queden
    // desactualizados mientras el usuario decide qué hacer.
    onConflicto: () => {
      if (typeof window.cargarCtaCte === 'function') {
        window.cargarCtaCte().catch(() => {});
      }
    },

    badge: {
      selector: '.topbar-right',
      titulo:   'Estado de conexión de Cobranzas',
      singular: 'cobro',
      plural:   'cobros',

      // Texto del modal de resolución de conflictos (offline-core.js).
      formatoConflicto: (reg) => {
        const d = reg.conflicto_datos || {};
        return {
          titulo:  'Cobro rechazado por el servidor',
          detalle: (d.error || 'El servidor no pudo registrar este cobro.') +
                    ' Revisá el estado actual de la factura/cliente antes de reintentar — puede haber cambiado mientras el cobro esperaba sin conexión. "Descartar" no borra nada del servidor, solo saca este cobro de la cola local.',
        };
      },
    },

    mensajes: {
      sincronizado: (n) => n === 1
        ? '1 cobro offline sincronizado con el servidor.'
        : `${n} cobros offline sincronizados.`,
      pendienteError: (n) => `${n} cobro(s) no pudieron sincronizarse todavía. Se reintentará automáticamente.`,
    },

    // Refrescar la vista de cta-cte / KPIs de cobranzas si el usuario sigue
    // en la página, igual que hace stock-offline.js con la tabla de Stock.
    onSincronizado: () => {
      if (typeof window.cargarCtaCte === 'function') {
        window.cargarCtaCte().catch(() => {});
      }
      if (typeof window.invalidarCobranzaPriorizada === 'function') {
        window.invalidarCobranzaPriorizada();
      }
      if (typeof window.refrescarKPIsCobranzas === 'function') {
        window.refrescarKPIsCobranzas();
      }
    },

    syncTag: 'sync-cobros-outbox',
  });

  window.addEventListener('offline', () => {
    if (window.mostrarToast) {
      window.mostrarToast('Sin internet. Los cobros que registres ahora se guardan en el dispositivo y se envían solos al reconectar.', 'warning', 5000);
    }
  });

  async function init({ getSb } = {}) {
    if (typeof getSb === 'function') _getSb = getSb;
    await outbox.init();
  }

  // ─── API pública ──────────────────────────────────────────────────────
  // v3 (Etapa 4): se suman getConflictos/getContadorConflictos/
  // resolverConflicto — lo demás sigue igual que v2, cta-cte.js no necesita
  // ningún cambio. El modal en sí ya lo maneja offline-core.js vía el badge.
  window.CobrosOffline = {
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
