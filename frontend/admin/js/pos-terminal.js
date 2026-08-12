// frontend/admin/js/pos-terminal.js
// Driver universal de terminal de pago (posnet) para el POS
//
// DRIVERS SOPORTADOS:
//   'manual'    — el cajero indica el resultado manualmente (fallback universal)
//   'mp_point'  — Mercado Pago Point Smart / Point Plus (API Intent / Deep Link)
//   'getnet'    — Getnet Santander (Intent Android)
//   'lapos'     — Lapos / Prisma (WS local en LAN)
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
    driver:         'manual',  // manual | mp_point | getnet | lapos | naranja
    mp_access_token: '',       // MP Point: access_token del vendedor
    mp_device_id:    '',       // MP Point: device_id de la terminal
    lapos_ip:        '',       // Lapos: IP de la PC con el agente Lapos
    lapos_puerto:    8080,
    naranja_token:   '',       // Naranja X: token de integración
    getnet_pos_id:   '',       // Getnet: POS ID
    timeout_ms:      120000,   // 2 min timeout por defecto
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

  // ── Driver: MERCADO PAGO POINT ────────────────────────────────────────────
  // Usa la API de Intents de MP Point para enviar el cobro a la terminal Smart/Plus.
  // Docs: https://www.mercadopago.com.ar/developers/es/docs/mp-point/integration-api

  async function cobrarMpPoint(monto, medio) {
    if (!_config.mp_access_token || !_config.mp_device_id) {
      throw new Error('MP Point no configurado. Ir a Admin → Hardware.');
    }

    const externalRef = generarIdempotencyKey();
    const montoEnCentavos = Math.round(monto * 100);

    // 1. Crear intent de pago
    const resp = await fetch(
      `https://api.mercadopago.com/point/integration-api/devices/${_config.mp_device_id}/payment-intents`,
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${_config.mp_access_token}`,
          'X-Idempotency-Key': externalRef,
        },
        body: JSON.stringify({
          amount:               montoEnCentavos,
          description:          'Venta POS',
          payment_method_id:    medio === 'naranja' ? 'naranja' : undefined,
          print_on_terminal:    true,
          additional_info: {
            external_reference: externalRef,
          },
        }),
      }
    );

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error('MP Point: ' + (err.message || err.error || resp.statusText));
    }

    const intent = await resp.json();
    const intentId = intent.id;

    // 2. Polling del estado (cada 3s, hasta timeout)
    const deadline = Date.now() + (_config.timeout_ms || 120000);
    while (Date.now() < deadline) {
      await sleep(3000);
      const poll = await fetch(
        `https://api.mercadopago.com/point/integration-api/payment-intents/${intentId}`,
        { headers: { 'Authorization': `Bearer ${_config.mp_access_token}` } }
      );
      const estado = await poll.json();

      if (estado.state === 'FINISHED' || estado.state === 'PROCESSED') {
        const pago = estado.payment;
        if (!pago || pago.status !== 'approved') {
          throw new Error('Pago no aprobado: ' + (pago?.status_detail || estado.state));
        }
        return {
          aprobado:   true,
          codigo:     String(pago.id),
          referencia: externalRef,
          detalle:    `${pago.payment_type_id} – ${pago.installments || 1} cuota(s)`,
        };
      }

      if (['CANCELED', 'ABANDONED', 'ERROR'].includes(estado.state)) {
        throw new Error('Terminal: pago ' + estado.state.toLowerCase());
      }
      // OPEN o PROCESSING → seguir esperando
    }

    // Cancelar el intent si se venció el timeout
    await fetch(
      `https://api.mercadopago.com/point/integration-api/devices/${_config.mp_device_id}/payment-intents/${intentId}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${_config.mp_access_token}` } }
    ).catch(() => {});

    throw new Error('Tiempo de espera agotado. El cliente no respondió en la terminal.');
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

  // ── Driver: LAPOS / PRISMA ───────────────────────────────────────────────
  // Lapos provee un agente local (Windows/Linux) que expone un WebSocket en LAN.
  // El POS se conecta a ws://lapos-ip:8080 y envía un mensaje de cobro.

  async function cobrarLapos(monto, medio) {
    if (!_config.lapos_ip) {
      return cobrarManual(monto, medio);
    }
    return new Promise((resolve, reject) => {
      const ws  = new WebSocket(`ws://${_config.lapos_ip}:${_config.lapos_puerto || 8080}`);
      const ref = generarIdempotencyKey();
      let timer;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          accion:    'cobro',
          monto:     monto,
          cuotas:    1,
          referencia: ref,
        }));
        timer = setTimeout(() => {
          ws.close();
          reject(new Error('Lapos: tiempo de espera agotado.'));
        }, _config.timeout_ms || 120000);
      };

      ws.onmessage = (e) => {
        clearTimeout(timer);
        ws.close();
        try {
          const r = JSON.parse(e.data);
          if (r.aprobado || r.estado === 'aprobado' || r.resultado === '00') {
            resolve({ aprobado: true, codigo: r.codigo || r.autorizacion || 'LAPOS', referencia: ref });
          } else {
            reject(new Error('Lapos: ' + (r.mensaje || r.error || 'Pago rechazado')));
          }
        } catch {
          reject(new Error('Lapos: respuesta inválida'));
        }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`No se pudo conectar al agente Lapos en ${_config.lapos_ip}:${_config.lapos_puerto}`));
      };
    });
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

  // ── Router principal ──────────────────────────────────────────────────────

  async function cobrarConTerminal(monto, medio = 'tarjeta') {
    switch (_config.driver) {
      case 'mp_point': return cobrarMpPoint(monto, medio);
      case 'getnet':   return cobrarGetnet(monto);
      case 'lapos':    return cobrarLapos(monto, medio);
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
      { id: 'getnet',   nombre: 'Getnet (Santander)',            descripcion: 'Integración via Intent Android. Requiere POS ID de Getnet.' },
      { id: 'lapos',    nombre: 'Lapos / Prisma (Visa-MC)',      descripcion: 'Requiere el agente Lapos corriendo en la misma red (IP configurable).' },
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
