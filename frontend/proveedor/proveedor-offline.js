// frontend/proveedor/proveedor-offline.js
// Módulo offline del portal proveedor — Plan offline, Etapa 3 (cierre del
// hueco marcado en PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md, sección 0,
// punto 4).
//
// Cubre las dos únicas escrituras que tiene el portal (portal.js):
//   - confirmar_entrega  → POST ?accion=confirmar-entrega (UPDATE, idempotente
//                          al reintentar — no necesita offline_local_id server-side)
//   - subir_factura      → POST ?accion=subir-factura (INSERT — dedup por
//                          offline_local_id, migración 448)
//
// AISLAMIENTO MULTI-TENANT (Etapa 4): a diferencia de admin/chofer/cliente,
// este portal es público y sin sesión — el backend NUNCA le devuelve al
// cliente el proveedor_id ni el empresa_id (ver verPortal en
// lib/handlers/portal_proveedor.js, a propósito, para no filtrar ids
// internos). No hay valor de empresa_id disponible para scopear el outbox.
// En su lugar se usa el propio token de la URL como clave de scoping: es
// justamente lo que identifica de forma única a este proveedor+empresa en
// este dispositivo — de hecho es un aislamiento MÁS fino que empresa_id
// (separa incluso distintos proveedores de la misma empresa que compartan
// dispositivo), cubriendo el mismo caso que motiva getEmpresaId en
// offline-core.js.
//
// SIN LOGIN, SIN "APP CERRADA CON SESIÓN VIVA": el token vive en la URL de
// cada visita — no hay problema de reabrir sin sesión como en admin/chofer,
// pero si el navegador descarta el service worker o la pestaña se cierra a
// mitad de una acción encolada, Background Sync (cuando el navegador lo
// soporta) igual puede despertar el SW; como cualquier pestaña que reciba
// el postMessage necesita re-derivar el mismo token para sincronizar, y acá
// no hay una sesión "de fondo" — el fallback real es el reintento al volver
// a abrir el link (evento 'online' + init()), igual que hoy.
//
// Requiere, en este orden, ANTES de este archivo:
//   1. Dexie (CDN)
//   2. /shared/offline-core.js
//
// NO modifica el contrato de portal.js más allá de lo mínimo — expone
// window.ProveedorOffline con la misma forma que ChoferOffline/StockOffline.

'use strict';

(function () {
  if (typeof OfflineCore === 'undefined') {
    console.error('[ProveedorOffline] OfflineCore no está cargado — falta /shared/offline-core.js antes de este script.');
    return;
  }

  const TIPOS_VALIDOS = ['confirmar_entrega', 'subir_factura'];

  let _tokenGlobal = null;

  function setToken(token) {
    _tokenGlobal = token || null;
  }

  // Etapa 4 — rechazo del servidor evaluado contra el estado real (OC ya
  // recibida/cancelada, OC ya no encontrada, etc.): no es un error
  // transitorio de red, reintentar a ciegas con el mismo payload nunca va
  // a funcionar. Mismo criterio que chofer-offline.js/stock-offline.js.
  function _errorConflicto(mensaje) {
    const err = new Error(mensaje);
    err.conflicto = true;
    err.tipoConflicto = 'rechazado_servidor';
    err.datosConflicto = { error: mensaje || null };
    return err;
  }

  async function procesarAccion(accion, token) {
    const { tipo, payload, offline_local_id } = accion;

    if (tipo === 'confirmar_entrega') {
      const r = await fetch(`/api/proveedores?_svc=portal&accion=confirmar-entrega&t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orden_id: payload.orden_id,
          fecha_esperada: payload.fecha_esperada,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw _errorConflicto(data.error || 'No se pudo confirmar la fecha');
      return data;
    }

    if (tipo === 'subir_factura') {
      const r = await fetch(`/api/proveedores?_svc=portal&accion=subir-factura&t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orden_id: payload.orden_id,
          numero_factura: payload.numero_factura,
          fecha_factura: payload.fecha_factura,
          total: payload.total,
          archivo_base64: payload.archivo_base64 || null,
          offline_local_id,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw _errorConflicto(data.error || 'No se pudo subir la factura');
      return data;
    }

    throw new Error(`Tipo de acción offline desconocido: ${tipo}`);
  }

  const outbox = OfflineCore.crearOutbox({
    portal: 'proveedor',
    validarTipo: (tipo) => TIPOS_VALIDOS.includes(tipo),
    procesarAccion,
    getContexto: () => _tokenGlobal,
    // Ver nota de aislamiento arriba: acá el "empresa_id" es el token.
    getEmpresaId: () => _tokenGlobal,

    onConflicto: () => {
      if (typeof window.cargarDatos === 'function') {
        window.cargarDatos().catch(() => {});
      }
    },

    badge: {
      selector: '.portal-header-inner',
      titulo:   'Estado de conexión',
      singular: 'pendiente',
      plural:   'pendientes',
      ocultarSiInactivo: true,
      insertarAlFinal: true,

      formatoConflicto: (reg) => {
        const d = reg.conflicto_datos || {};
        const err = d.error || '';
        const NOMBRE_TIPO = {
          confirmar_entrega: 'Confirmación de fecha',
          subir_factura:     'Carga de factura',
        };
        const nombreTipo = NOMBRE_TIPO[reg.tipo] || 'Acción';

        let titulo = `${nombreTipo}: el servidor la rechazó`;
        if (/no se puede confirmar fecha/i.test(err)) {
          titulo = `${nombreTipo}: la orden ya no admite cambios de fecha`;
        } else if (/orden de compra no encontrada/i.test(err)) {
          titulo = `${nombreTipo}: la orden ya no está disponible`;
        }

        return {
          titulo,
          detalle: (err || 'No se pudo aplicar la acción.') +
                    ' Puede que la orden haya cambiado de estado mientras esperaba sin conexión — revisá el estado actual antes de reintentar. "Descartar" no borra nada del servidor, solo saca esta acción de la cola local.',
        };
      },
    },

    mensajes: {
      sincronizado: (n) => n === 1
        ? '1 acción offline sincronizada con el servidor.'
        : `${n} acciones offline sincronizadas.`,
      pendienteError: (n) => `${n} acción(es) no pudieron sincronizarse todavía. Se reintentará automáticamente.`,
    },

    // Refresca la pantalla si el proveedor sigue con el portal abierto.
    onSincronizado: () => {
      if (typeof window.cargarDatos === 'function') {
        window.cargarDatos().catch(() => {});
      }
    },

    syncTag: 'sync-proveedor-outbox',
  });

  window.addEventListener('offline', () => {
    if (window.mostrarToast) {
      window.mostrarToast('Sin internet. Lo que confirmes o cargues ahora se guarda en este dispositivo y se envía solo al reconectar.', 'warning', 5000);
    }
  });

  // Defensa en profundidad: OfflineCore.crearOutbox() NO tira excepción si
  // Dexie no está cargado — devuelve `null` a propósito (ver offline-core.js,
  // rama `typeof Dexie === 'undefined'`), para que un módulo pueda decidir
  // su propio fallback. Sin este guard, `outbox.encolarAccion` de más abajo
  // tira un TypeError síncrono DENTRO de este IIFE y window.ProveedorOffline
  // nunca llega a asignarse — el portal queda sin ningún rastro de por qué
  // (mismo síntoma que "el script no cargó", pero mucho más difícil de
  // diagnosticar porque el resto de la página sigue funcionando normal).
  if (!outbox) {
    console.error('[ProveedorOffline] OfflineCore.crearOutbox() devolvió null — Dexie no estaba disponible. Sin soporte offline en esta carga.');
    return;
  }

  async function init({ token } = {}) {
    setToken(token);
    await outbox.init();
    console.log('[ProveedorOffline] Inicializado OK');
  }

  window.ProveedorOffline = {
    init,
    setToken,
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
