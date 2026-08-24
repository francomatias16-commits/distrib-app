// frontend/chofer/chofer-offline.js — v3
// Módulo offline para la app del chofer — Plan offline, Etapa 3, ítem 3
//
// v2 (Etapa 1): reescrito sobre OfflineCore (frontend/shared/offline-core.js,
// Dexie) en vez de IndexedDB manual. La API pública (window.ChoferOffline) NO
// cambió — remito.js sigue llamando exactamente lo mismo que antes, cero
// cambios necesarios ahí.
//
// v3 (Etapa 4 — UI de conflicto): hasta acá, un rechazo del servidor en
// cualquiera de los tres tipos (entregar/no_entregar/devolucion) lanzaba un
// Error genérico que caía en _marcarError como reintentable — mismo bug ya
// corregido en stock-offline.js/cobros-offline.js/pos-offline.js. El caso
// central acá es "El pedido no está despachado" (400), que aparece tanto en
// entregar como en no_entregar: significa que el estado del pedido cambió
// del lado del servidor (otro dispositivo del mismo chofer, un admin, u
// otra confirmación que sí llegó a procesarse) mientras esta acción
// esperaba sin conexión — reintentar con el mismo payload nunca va a
// funcionar. Lo mismo aplica al cobro asociado a una entrega (mismo
// registrar_cobro_completo que usa cobros-offline.js — factura ya saldada,
// cliente ya no existe, etc.) y a "Pedido no encontrado" (chofer
// reasignado a otra ruta). Ninguno de estos se resuelve reintentando a
// ciegas: el chofer tiene que ver el motivo y decidir. Se cablea igual en
// los tres tipos, incluida devolución (sin un caso de "estado cambió" tan
// marcado como los otros dos, pero con el mismo principio: un rechazo del
// servidor evaluado contra datos reales no es un error transitorio de red).
// Los fallos de SUBIDA de foto/firma (_subirImagen/_subirFotoDevolucion)
// quedan afuera de este tratamiento a propósito — son de red, no de
// negocio, y sí tiene sentido que sigan reintentándose solos.
//
// IDEMPOTENCIA:
//   offline_local_id lo genera OfflineCore al encolar (crypto.randomUUID()),
//   ANTES de cualquier intento de red. Los tres endpoints (entregar,
//   no-entregar, devolución) y el RPC de cobro asociado
//   (registrar_cobro_completo, migración 442) lo usan como fast-path de
//   deduplicación — ver migraciones 441/442. Esto es lo que hace seguro
//   reintentar sin duplicar entregas, cobros ni devoluciones.
//
// QUÉ SE ENCOLA:
//   Las fotos/firma se guardan como data URL (base64) dentro de la propia
//   acción — todavía no se subieron a storage cuando no hay red. El envío
//   real (subir imagen(es) y después pegarle al endpoint principal) se hace
//   completo recién durante la sincronización, en el mismo orden que
//   seguiría el flujo online — ver procesarAccion() más abajo.
//
// Requiere, en este orden, ANTES de este archivo:
//   1. Dexie (CDN)
//   2. /frontend/shared/offline-core.js
//
// NO modifica ningún archivo existente — se integra desde remito.html como
// <script> antes del script principal y expone window.ChoferOffline.

'use strict';

(function () {
  if (typeof OfflineCore === 'undefined') {
    console.error('[ChoferOffline] OfflineCore no está cargado — falta /frontend/shared/offline-core.js antes de este script.');
    return;
  }

  const TIPOS_VALIDOS = ['entregar', 'no_entregar', 'devolucion'];

  let _getToken = async () => null;

  // Plan offline, Etapa 4: aislamiento multi-tenant — ver nota en
  // offline-core.js. A diferencia de pos/cobros/stock (que leen
  // window.authCtx.perfil.empresa_id desde el arranque), acá el chofer no
  // tiene el empresa_id disponible en el cliente al iniciar: recién se
  // conoce cuando llega el detalle del remito desde el servidor (ver
  // obtenerRemitoDetalle en pedidos.js y el wireo en remito.html). Por eso
  // queda como variable mutable seteada después vía setEmpresaId(), en vez
  // de leerse directo de authCtx.
  let _empresaId = null;
  let _usuarioId = null;

  function notificarScopeServiceWorker() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return;
    controller.postMessage({
      type: 'CHOFER_SESSION_SCOPE',
      empresa_id: _empresaId,
      usuario_id: _usuarioId,
    });
  }

  // ─── Envío por tipo (misma secuencia que seguiría el flujo online) ───────

  async function _subirImagen(dataUrl, tipo, token) {
    if (!dataUrl) return null;
    const r = await fetch('/api/chofer/entrega-foto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ imagen_base64: dataUrl, tipo }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Error al subir la ${tipo}`);
    return data.url;
  }

  async function _subirFotoDevolucion(dataUrl, token) {
    if (!dataUrl) return null;
    const r = await fetch('/api/chofer/devolucion-foto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ foto_base64: dataUrl }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Error al subir la foto');
    return data.foto_url;
  }

  // Etapa 4 — arma el Error de conflicto que espera OfflineCore (ver nota de
  // v3 arriba). Un solo helper para los tres tipos, mismo patrón que
  // cobros-offline.js/stock-offline.js: cualquier rechazo del servidor acá
  // es una decisión de negocio evaluada contra el estado real, no un error
  // transitorio — de eso ya se encargó throwear un Error simple más arriba
  // en los pasos de subida de imagen.
  function _errorConflicto(mensaje) {
    const err = new Error(mensaje);
    err.conflicto = true;
    err.tipoConflicto = 'rechazado_servidor';
    err.datosConflicto = { error: mensaje || null };
    return err;
  }

  async function procesarAccion(accion, token) {
    const { tipo, payload, offline_local_id } = accion;

    if (tipo === 'entregar') {
      const firma_url = await _subirImagen(payload.firma_data_url, 'firma', token);
      const foto_url  = await _subirImagen(payload.foto_data_url,  'foto',  token);
      const r = await fetch(`/api/chofer/remitos/${payload.pedido_id}/entregar`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          id: payload.pedido_id,
          firma_url,
          foto_url,
          receptor: payload.receptor || null,
          notas_entrega: payload.notas_entrega || null,
          cobro: payload.cobro || null,
          offline_local_id,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw _errorConflicto(data.error || 'Error al confirmar entrega');
      return data;
    }

    if (tipo === 'no_entregar') {
      const foto_url = await _subirImagen(payload.foto_data_url, 'foto', token);
      const r = await fetch(`/api/chofer/remitos/${payload.pedido_id}/no-entregar`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          id: payload.pedido_id,
          motivo: payload.motivo,
          notas: payload.notas || null,
          foto_url,
          offline_local_id,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw _errorConflicto(data.error || 'Error al registrar la no entrega');
      return data;
    }

    if (tipo === 'devolucion') {
      const foto_url = await _subirFotoDevolucion(payload.foto_data_url, token);
      const r = await fetch('/api/chofer/devolucion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          pedido_id: payload.pedido_id,
          motivo: payload.motivo,
          notas: payload.notas || null,
          foto_url,
          items: payload.items,
          offline_local_id,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw _errorConflicto(data.error || 'Error al registrar la devolución');
      return data;
    }

    throw new Error(`Tipo de acción offline desconocido: ${tipo}`);
  }

  const outbox = OfflineCore.crearOutbox({
    portal: 'chofer',
    validarTipo: (tipo) => TIPOS_VALIDOS.includes(tipo),
    procesarAccion,
    getContexto: () => _getToken(),
    getEmpresaId: () => _empresaId,

    // Etapa 4 — si una acción encolada termina en conflicto, refrescamos el
    // remito que el chofer tiene abierto para que no siga mostrando un
    // pedido "listo para confirmar" que el servidor ya rechazó.
    onConflicto: () => {
      if (typeof window.cargarRemito === 'function') {
        window.cargarRemito().catch(() => {});
      }
    },

    badge: {
      selector: '.topbar',
      titulo:   'Estado de conexión',
      singular: 'pendiente',
      plural:   'pendientes',
      ocultarSiInactivo: true,
      insertarAlFinal: true,

      // Texto del modal de resolución de conflictos (offline-core.js).
      formatoConflicto: (reg) => {
        const d = reg.conflicto_datos || {};
        const err = d.error || '';
        const NOMBRE_TIPO = {
          entregar:    'Confirmación de entrega',
          no_entregar: 'No entrega',
          devolucion:  'Devolución',
        };
        const nombreTipo = NOMBRE_TIPO[reg.tipo] || 'Acción';

        let titulo = `${nombreTipo}: el servidor la rechazó`;
        if (/no est[aá] despachado/i.test(err)) {
          titulo = `${nombreTipo}: el pedido ya no está despachado`;
        } else if (/pedido no encontrado/i.test(err)) {
          titulo = `${nombreTipo}: el pedido ya no está disponible`;
        } else if (/saldada|anulada|cliente no encontrado/i.test(err)) {
          titulo = `${nombreTipo}: el cobro asociado fue rechazado`;
        }

        return {
          titulo,
          detalle: (err || 'No se pudo aplicar la acción.') +
                    ' Puede que otro dispositivo o un admin ya haya actualizado este pedido mientras esperaba sin conexión — revisá el estado actual antes de reintentar. "Descartar" no borra nada del servidor, solo saca esta acción de la cola local del celular.',
        };
      },
    },

    mensajes: {
      sincronizado: (n) => n === 1
        ? '1 acción offline sincronizada con el servidor.'
        : `${n} acciones offline sincronizadas.`,
      pendienteError: (n) => `${n} acción(es) no pudieron sincronizarse todavía. Se reintentará automáticamente.`,
    },

    syncTag: 'sync-chofer-outbox',
  });

  window.addEventListener('offline', () => {
    if (window.mostrarToast) {
      window.mostrarToast('Sin internet. Lo que confirmes ahora se guarda en el celular y se envía solo al reconectar.', 'warning', 5000);
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  async function init({ getToken } = {}) {
    if (typeof getToken === 'function') _getToken = getToken;
    await outbox.init();
    console.log('[ChoferOffline] Inicializado OK');
  }

  // setEmpresaId(): lo llama remito.html apenas llega el detalle del
  // remito desde el servidor (obtenerRemitoDetalle trae empresa_id). Todo
  // lo encolado ANTES de este punto en la misma sesión queda sin
  // empresa_id (null) — se sigue mostrando/sincronizando igual, ver nota
  // de getEmpresaId en offline-core.js.
  function setEmpresaId(empresaId, usuarioId = _usuarioId) {
    _empresaId = empresaId ?? null;
    _usuarioId = usuarioId ?? _usuarioId ?? null;
    notificarScopeServiceWorker();
  }

  function setUsuarioId(usuarioId) {
    _usuarioId = usuarioId ?? null;
    notificarScopeServiceWorker();
  }

  function limpiarScopeSesion() {
    _empresaId = null;
    _usuarioId = null;
    const controller = navigator.serviceWorker?.controller;
    controller?.postMessage({ type: 'CHOFER_SESSION_LOGOUT' });
  }

  // ─── API pública ──────────────────────────────────────────────────────────
  // v3 (Etapa 4): se suman getConflictos/getContadorConflictos/
  // resolverConflicto — lo demás sigue igual que v1/v2, remito.html no
  // necesita ningún cambio. El modal en sí ya lo maneja offline-core.js.
  window.ChoferOffline = {
    init,
    setEmpresaId,
    setUsuarioId,
    limpiarScopeSesion,
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
