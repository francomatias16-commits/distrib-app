// frontend/admin/js/pos-terminal.js
// Driver universal de terminal de pago (posnet) para el POS
//
// DRIVERS SOPORTADOS:
//   'manual'    — el cajero indica el resultado manualmente (fallback universal)
//   'mp_point'  — Mercado Pago Point Smart / Point Plus (API Intent / Deep Link)
//   'mp_qr'     — Mercado Pago QR (cobro presencial, backend-mediado, ver
//                 lib/handlers/pagos.js _svc=pos-qr-*; setup en Admin → Pagos)
//   'getnet'    — Getnet Santander (Intent Android)
//   'prisma'    — Prisma Paystore terminals (API cloud, ver
//                 lib/handlers/pagos.js _svc=prisma-*; cuenta se conecta en
//                 Admin → Hardware → Terminal de pago)
//   'naranja'   — Naranja X (Intent Android / QR dinámico)
//
// FLUJO GENERAL:
//   1. cobrarConTerminal(monto, medio) — inicia el pago en la terminal
//   2. La terminal responde (callback, polling, intent-return)
//   3. resolve({ aprobado, codigo, referencia }) → confirmar venta
//      reject(error) → mostrar error al cajero
//
// API pública (window.PosTerminal):
//   init(config)
//   cobrarConTerminal(monto, medio) → Promise<{ aprobado, codigo, referencia }>
//   getConfig()
//   getDriverActivo()
//   getTerminalesSoportadas()   → lista de drivers disponibles

'use strict';

(function () {

  // ── Estado interno ────────────────────────────────────────────────────────
  let _config = {
    driver:             'manual',  // manual | mp_point | mp_qr | getnet | prisma | naranja
    mp_device_id:       '',        // MP Point: device_id de la terminal (el access_token vive en el backend, ver cobrarMpPoint)
    prisma_terminal_id: '',        // Prisma: ID de la terminal física de esta caja (la cuenta/token vive en el backend)
    naranja_token:      '',        // Naranja X: token de integración
    getnet_pos_id:      '',        // Getnet: POS ID
    timeout_ms:         120000,    // 2 min timeout por defecto
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function generarIdempotencyKey() {
    return 'pos-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ── Driver: MANUAL ────────────────────────────────────────────────────────
  // El cajero pasa la tarjeta en la terminal física y confirma el resultado.

  async function cobrarManual(monto, medio) {
    return new Promise((resolve, reject) => {
      _mostrarDialogoManual(monto, medio, resolve, reject);
    });
  }

  function _mostrarDialogoManual(monto, medio, resolve, reject) {
    const fmt = v => '$ ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2 });
    const overlay = document.createElement('div');
    overlay.id = 'pos-terminal-manual-overlay';
    overlay.innerHTML = `
      <div class="pos-terminal-dialog">
        <div class="pos-terminal-dialog-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg></div>
        <h3>Cobrar en terminal</h3>
        <p class="pos-terminal-dialog-monto">${fmt(monto)}</p>
        <p class="pos-terminal-dialog-sub">
          Pasá la ${medio === 'tarjeta' ? 'tarjeta' : 'tarjeta/QR'} por la terminal física
          y confirmá el resultado acá.
        </p>
        <div class="pos-terminal-dialog-ref">
          <label>Código de autorización <span style="font-weight:400">(opcional)</span></label>
          <input id="ptm-codigo" type="text" class="input-base" placeholder="Ej: 123456" />
        </div>
        <div class="pos-terminal-dialog-btns">
          <button class="btn btn--danger"    id="ptm-btn-rechazar"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Rechazado / Cancelar</button>
          <button class="btn btn--primary"   id="ptm-btn-aprobar"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Aprobado</button>
        </div>
      </div>`;
    overlay.className = 'pos-terminal-overlay';
    document.body.appendChild(overlay);

    overlay.querySelector('#ptm-btn-aprobar').onclick = () => {
      const codigo = overlay.querySelector('#ptm-codigo').value.trim();
      overlay.remove();
      resolve({ aprobado: true, codigo: codigo || 'MANUAL', referencia: generarIdempotencyKey() });
    };
    overlay.querySelector('#ptm-btn-rechazar').onclick = () => {
      overlay.remove();
      reject(new Error('Pago rechazado o cancelado por el cajero.'));
    };
  }

  // ── Driver: MERCADO PAGO POINT (backend-mediado) ────────────────────────
  // MIGRACIÓN: antes este driver le pegaba DIRECTO a
  // api.mercadopago.com/point/integration-api con mp_access_token mandado
  // en texto plano desde Admin → Hardware — el token de la cuenta de MP
  // quedaba visible en la pestaña de red de CUALQUIER cajero (config-hardware
  // no restringe la lectura a admin). Ahora, mismo criterio que mp_qr y
  // prisma: el POS solo manda monto + device_id (no es sensible, es un id
  // de hardware) al backend (lib/handlers/pagos.js, _svc=mp-point-*), que
  // tiene el access_token cifrado — nunca viaja al frontend.

  async function cobrarMpPoint(monto) {
    if (!_config.mp_device_id) {
      throw new Error('MP Point no configurado: falta el device_id de esta caja. Ir a Admin → Hardware.');
    }
    const token = await _getSupabaseToken();
    if (!token) throw new Error('Sesión inválida. Volvé a iniciar sesión.');

    const rCobrar = await fetch(`${_apiBase()}/api/pagos?_svc=mp-point-cobrar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ monto, device_id: _config.mp_device_id, descripcion: 'Venta mostrador' }),
    });
    const dCobrar = await rCobrar.json().catch(() => ({}));
    if (!rCobrar.ok || !dCobrar.ok) {
      throw new Error(dCobrar.error || 'No se pudo enviar el cobro a la terminal Point.');
    }
    const intentId   = dCobrar.intent_id;
    const referencia = dCobrar.referencia;

    const cancelarEnMP = () => fetch(`${_apiBase()}/api/pagos?_svc=mp-point-cancelar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ intent_id: intentId, device_id: _config.mp_device_id }),
    }).catch(() => {});

    return new Promise((resolve, reject) => {
      _mostrarDialogoMpPoint(monto, async (cerrar) => {
        const deadline = Date.now() + (_config.timeout_ms || 120000);
        try {
          while (Date.now() < deadline) {
            await sleep(3000);
            const rVer = await fetch(
              `${_apiBase()}/api/pagos?_svc=mp-point-verificar&intent_id=${encodeURIComponent(intentId)}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            const dVer = await rVer.json().catch(() => ({}));
            if (dVer.pagado) {
              cerrar();
              resolve({ aprobado: true, codigo: String(dVer.payment_id), referencia, detalle: dVer.metodo_pago });
              return;
            }
            if (dVer.rechazado) {
              cerrar();
              reject(new Error('Pago no aprobado: ' + (dVer.estado || '')));
              return;
            }
          }
          cerrar();
          cancelarEnMP();
          reject(new Error('Tiempo de espera agotado. El cliente no respondió en la terminal.'));
        } catch (err) {
          cerrar();
          cancelarEnMP();
          reject(err);
        }
      }, () => {
        cancelarEnMP();
        reject(new Error('Cobro cancelado por el cajero.'));
      });
    });
  }

  function _mostrarDialogoMpPoint(monto, onListo, onCancelar) {
    const fmt = v => '$ ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2 });
    const overlay = document.createElement('div');
    overlay.id = 'pos-terminal-mppoint-overlay';
    overlay.className = 'pos-terminal-overlay';
    overlay.innerHTML = `
      <div class="pos-terminal-dialog">
        <h3>Cobrando en Point</h3>
        <p class="pos-terminal-dialog-monto">${fmt(monto)}</p>
        <p class="pos-terminal-dialog-sub">Pasá o insertá la tarjeta en la terminal Point.</p>
        <div class="pos-terminal-dialog-btns">
          <button class="btn btn--danger" id="ptmp-btn-cancelar">Cancelar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    overlay.querySelector('#ptmp-btn-cancelar').onclick = () => { cerrar(); onCancelar(); };
    onListo(cerrar);
  }

  // ── Driver: GETNET ────────────────────────────────────────────────────────
  // Getnet usa una app companion en Android con Intent URI o SDK nativo.
  // En desktop/web, la única integración disponible es el diálogo manual + API REST.

  async function cobrarGetnet(monto) {
    if (!_config.getnet_pos_id) {
      // Sin POS ID configurado → fallback manual
      return cobrarManual(monto, 'tarjeta');
    }
    // Intent URI para Android (si el POS corre en tablet Android)
    const intentUri = `getnet://payment?amount=${Math.round(monto * 100)}&posId=${_config.getnet_pos_id}&ref=${generarIdempotencyKey()}`;
    window.location.href = intentUri;
    // El resultado llega por vuelta del Intent; acá mostramos diálogo de confirmación
    return cobrarManual(monto, 'tarjeta');
  }

  // ── Driver: PRISMA (Paystore terminals — API cloud) ─────────────────────
  // Reemplaza al driver "Lapos" anterior, que nunca fue una integración real
  // (se conectaba a un WebSocket local inventado, ws://lapos-ip:8080, que
  // ningún agente real expone). La cuenta (CUIT/CUIL + token) vive cifrada
  // en el backend — igual criterio que mp_qr, nunca viaja al frontend — y
  // el POS solo manda el monto + terminal_id de esta caja, y pollea el
  // resultado. Ver lib/handlers/pagos.js, _svc=prisma-cobrar/prisma-verificar.

  async function cobrarPrisma(monto) {
    if (!_config.prisma_terminal_id) {
      throw new Error('Prisma no configurado: falta el ID de terminal de esta caja. Ir a Admin → Hardware.');
    }
    const referencia = generarIdempotencyKey();
    const token = await _getSupabaseToken();
    if (!token) throw new Error('Sesión inválida. Volvé a iniciar sesión.');

    const rCobrar = await fetch(`${_apiBase()}/api/pagos?_svc=prisma-cobrar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        monto,
        referencia,
        terminal_id: _config.prisma_terminal_id,
        descripcion: 'Venta mostrador',
      }),
    });
    const dCobrar = await rCobrar.json().catch(() => ({}));
    if (!rCobrar.ok || !dCobrar.ok) {
      throw new Error(dCobrar.error || 'No se pudo iniciar el cobro en la terminal Prisma.');
    }
    const paymentId = dCobrar.payment_id;

    return new Promise((resolve, reject) => {
      _mostrarDialogoPrisma(monto, async (cerrar) => {
        const deadline = Date.now() + (_config.timeout_ms || 120000);
        try {
          while (Date.now() < deadline) {
            await sleep(3000);
            const rVer = await fetch(
              `${_apiBase()}/api/pagos?_svc=prisma-verificar&payment_id=${encodeURIComponent(paymentId)}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            const dVer = await rVer.json().catch(() => ({}));
            if (dVer.pagado) {
              cerrar();
              resolve({ aprobado: true, codigo: paymentId, referencia, detalle: dVer.estado });
              return;
            }
            if (dVer.rechazado) {
              cerrar();
              reject(new Error('Pago rechazado en la terminal: ' + (dVer.estado || '')));
              return;
            }
          }
          cerrar();
          fetch(`${_apiBase()}/api/pagos?_svc=prisma-cancelar`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ payment_id: paymentId }),
          }).catch(() => {});
          reject(new Error('Tiempo de espera agotado. La terminal no respondió.'));
        } catch (err) {
          cerrar();
          reject(err);
        }
      }, () => {
        fetch(`${_apiBase()}/api/pagos?_svc=prisma-cancelar`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ payment_id: paymentId }),
        }).catch(() => {});
        reject(new Error('Cobro cancelado por el cajero.'));
      });
    });
  }

  function _mostrarDialogoPrisma(monto, onListo, onCancelar) {
    const fmt = v => '$ ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2 });
    const overlay = document.createElement('div');
    overlay.id = 'pos-terminal-prisma-overlay';
    overlay.className = 'pos-terminal-overlay';
    overlay.innerHTML = `
      <div class="pos-terminal-dialog">
        <h3>Cobrando en terminal</h3>
        <p class="pos-terminal-dialog-monto">${fmt(monto)}</p>
        <p class="pos-terminal-dialog-sub">Pasá o insertá la tarjeta en la terminal.</p>
        <div class="pos-terminal-dialog-btns">
          <button class="btn btn--danger" id="ptp-btn-cancelar">Cancelar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    overlay.querySelector('#ptp-btn-cancelar').onclick = () => { cerrar(); onCancelar(); };
    onListo(cerrar);
  }

  // ── Driver: NARANJA X ────────────────────────────────────────────────────
  // Naranja X provee QR dinámico + webhook. En el POS mostramos el QR y polleamos.

  async function cobrarNaranja(monto) {
    if (!_config.naranja_token) {
      return cobrarManual(monto, 'naranja');
    }
    // Por ahora fallback manual — la integración completa de Naranja requiere
    // servidor intermediario para no exponer el token en el frontend.
    return cobrarManual(monto, 'naranja');
  }

  // ── Driver: MERCADO PAGO QR (cobro presencial) ──────────────────────────
  // A diferencia de mp_point, acá el access_token NUNCA viaja al frontend:
  // el POS solo pide al backend (lib/handlers/pagos.js, _svc=pos-qr-*) que
  // cargue el monto sobre el QR fijo ya configurado en Admin → Pagos, y
  // pollea el resultado. Requiere que el admin haya hecho el setup una vez
  // (mercadopago-config.html → "Cobro con QR en caja").

  async function _getSupabaseToken() {
    try {
      const { data: { session } } = await window.authCtx.sb.auth.getSession();
      return session?.access_token || '';
    } catch { return ''; }
  }

  function _apiBase() { return window.ENV?.API_URL || ''; }

  async function cobrarQrMercadoPago(monto) {
    const referencia = generarIdempotencyKey();
    const token = await _getSupabaseToken();
    if (!token) throw new Error('Sesión inválida. Volvé a iniciar sesión.');

    const rCobrar = await fetch(`${_apiBase()}/api/pagos/pos-qr-cobrar`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ monto, referencia, descripcion: 'Venta mostrador' }),
    });
    const dCobrar = await rCobrar.json().catch(() => ({}));
    if (!rCobrar.ok || !dCobrar.ok) {
      const sufijoRef = dCobrar.correlation_id ? ` (ref: ${dCobrar.correlation_id})` : '';
      throw new Error((dCobrar.error || 'No se pudo generar el cobro QR.') + sufijoRef);
    }
    // MIGRACIÓN v782 (Orders API): pos-qr-cobrar ya no devuelve un recurso
    // buscable por `referencia` — hay que reenviar el order_id que devolvió
    // para poder consultar el estado en pos-qr-verificar.
    const orderId = dCobrar.order_id;

    // MIGRACIÓN 498: además del polling (que sigue como red de contención
    // si Realtime no está disponible), nos suscribimos a cobros_qr_pos —
    // el webhook de MP (manejarWebhook, topic 'order') actualiza esa fila
    // apenas se confirma el pago, y acá lo escuchamos al toque en vez de
    // esperar el próximo tick de 3s (que el browser puede espaciar si la
    // pestaña pierde foco).
    const nombreCanalRealtime = orderId ? `cobro-qr-pos-${orderId}` : null;
    let resuelto = false;

    return new Promise((resolve, reject) => {
      const finalizar = (cerrar, fn, arg) => {
        if (resuelto) return;
        resuelto = true;
        if (nombreCanalRealtime) window.DistribRealtime?.desuscribir(nombreCanalRealtime);
        cerrar();
        fn(arg);
      };

      _mostrarDialogoQr(monto, dCobrar.qr_image, async (cerrar) => {
        if (nombreCanalRealtime && window.authCtx?.sb) {
          window.DistribRealtime?.suscribir({
            sb:         window.authCtx.sb,
            nombreCanal: nombreCanalRealtime,
            tabla:      'cobros_qr_pos',
            evento:     'UPDATE',
            filtro:     `order_id=eq.${orderId}`,
            onCambio:   (payload) => {
              const fila = payload?.new;
              if (fila?.estado === 'aprobado') {
                finalizar(cerrar, resolve, { aprobado: true, codigo: String(fila.payment_id), referencia, detalle: fila.metodo_pago });
              }
            },
          });
        }

        const deadline = Date.now() + (_config.timeout_ms || 120000);
        try {
          while (Date.now() < deadline && !resuelto) {
            await sleep(3000);
            if (resuelto) return;
            const rVer = await fetch(
              `${_apiBase()}/api/pagos/pos-qr-verificar?order_id=${encodeURIComponent(orderId || '')}&referencia=${encodeURIComponent(referencia)}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            const dVer = await rVer.json().catch(() => ({}));
            if (dVer.pagado) {
              finalizar(cerrar, resolve, { aprobado: true, codigo: String(dVer.payment_id), referencia, detalle: dVer.metodo_pago });
              return;
            }
          }
          finalizar(cerrar, reject, new Error('Tiempo de espera agotado. El cliente no pagó el QR.'));
        } catch (err) {
          finalizar(cerrar, reject, err);
        }
      }, () => {
        if (resuelto) return;
        resuelto = true;
        if (nombreCanalRealtime) window.DistribRealtime?.desuscribir(nombreCanalRealtime);
        reject(new Error('Cobro con QR cancelado por el cajero.'));
      });
    });
  }

  function _mostrarDialogoQr(monto, qrImage, onListo, onCancelar) {
    const fmt = v => '$ ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2 });
    const overlay = document.createElement('div');
    overlay.id = 'pos-terminal-qr-overlay';
    overlay.className = 'pos-terminal-overlay';
    overlay.innerHTML = `
      <div class="pos-terminal-dialog">
        <h3>Cobrar con QR</h3>
        <p class="pos-terminal-dialog-monto">${fmt(monto)}</p>
        <p class="pos-terminal-dialog-sub">El cliente escanea este QR con la app de Mercado Pago.</p>
        ${qrImage ? `<img src="${qrImage}" alt="QR de cobro" style="max-width:200px;margin:10px auto;display:block">` : '<p class="pos-terminal-dialog-sub">QR no disponible — verificá el setup en Admin → Pagos.</p>'}
        <div class="pos-terminal-dialog-btns">
          <button class="btn btn--danger" id="ptq-btn-cancelar">Cancelar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    overlay.querySelector('#ptq-btn-cancelar').onclick = () => { cerrar(); onCancelar(); };
    onListo(cerrar);
  }

  // ── Router principal ──────────────────────────────────────────────────────

  async function cobrarConTerminal(monto, medio = 'tarjeta') {
    switch (_config.driver) {
      case 'mp_point': return cobrarMpPoint(monto, medio);
      case 'mp_qr':    return cobrarQrMercadoPago(monto);
      case 'getnet':   return cobrarGetnet(monto);
      case 'prisma':   return cobrarPrisma(monto);
      case 'naranja':  return cobrarNaranja(monto);
      default:         return cobrarManual(monto, medio);
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────

  function init(config) {
    if (config) Object.assign(_config, config);
  }

  function getConfig() { return { ..._config }; }

  function getDriverActivo() { return _config.driver; }

  function getTerminalesSoportadas() {
    return [
      { id: 'manual',   nombre: 'Manual (cualquier terminal)',   descripcion: 'El cajero confirma el resultado manualmente. Compatible con cualquier terminal física.' },
      { id: 'mp_point', nombre: 'Mercado Pago Point Smart/Plus', descripcion: 'Integración automática via API. Requiere access_token y device_id de MP.' },
      { id: 'mp_qr',    nombre: 'Mercado Pago QR (cobro presencial)', descripcion: 'Muestra el QR fijo configurado en Admin → Pagos y espera el pago. No requiere terminal física — se configura una sola vez.' },
      { id: 'getnet',   nombre: 'Getnet (Santander)',            descripcion: 'Integración via Intent Android. Requiere POS ID de Getnet.' },
      { id: 'prisma',   nombre: 'Prisma (terminal, cobro con tarjeta)', descripcion: 'Integración cloud con la API de Prisma Paystore terminals. La cuenta se conecta una sola vez en Admin → Hardware; requiere el ID de terminal de esta caja.' },
      { id: 'naranja',  nombre: 'Naranja X',                     descripcion: 'Integración via QR dinámico. Requiere token de Naranja X.' },
    ];
  }

  window.PosTerminal = {
    init,
    cobrarConTerminal,
    getConfig,
    getDriverActivo,
    getTerminalesSoportadas,
    setConfig: (c) => Object.assign(_config, c),
  };

})();
