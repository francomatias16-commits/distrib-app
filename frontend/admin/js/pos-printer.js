// frontend/admin/js/pos-printer.js
// Driver universal de impresora térmica para el POS
//
// MODOS SOPORTADOS:
//   'browser'   — window.print() sobre el CSS @media print ya existente (default, sin config)
//   'webusb'    — ESC/POS directo por WebUSB (Epson, Bematech, Xprinter, POS-80, Star, etc.)
//   'network'   — ESC/POS via HTTP a un proxy local en la misma LAN (IP:puerto configurable)
//   'bluetooth' — ESC/POS via Web Bluetooth (impresoras portátiles BT)
//
// API pública (window.PosPrinter):
//   init(config)              — llama al iniciar el POS con la config guardada
//   imprimirTicket(venta)     — imprime el ticket de venta
//   imprimirReporteZ(reporte) — imprime el cierre Z
//   configurar()              — abre el wizard de configuración (llamado desde Admin → Hardware)
//   getConfig()               — devuelve la config actual
//   testImpresion()           — imprime página de prueba

'use strict';

(function () {

  // ── Constantes ESC/POS ───────────────────────────────────────────────────
  const ESC = 0x1B;
  const GS  = 0x1D;

  const CMD = {
    INIT:           [ESC, 0x40],
    ALIGN_LEFT:     [ESC, 0x61, 0x00],
    ALIGN_CENTER:   [ESC, 0x61, 0x01],
    ALIGN_RIGHT:    [ESC, 0x61, 0x02],
    BOLD_ON:        [ESC, 0x45, 0x01],
    BOLD_OFF:       [ESC, 0x45, 0x00],
    FONT_NORMAL:    [ESC, 0x21, 0x00],
    FONT_DOUBLE_H:  [ESC, 0x21, 0x10],
    FONT_DOUBLE_WH: [ESC, 0x21, 0x30],
    LF:             [0x0A],
    CUT_FULL:       [GS,  0x56, 0x00],
    CUT_PARTIAL:    [GS,  0x56, 0x01],
    BEEP:           [ESC, 0x42, 0x03, 0x01], // 3 beeps, duración 1
  };

  // Ancho de papel en caracteres (58mm≈32, 80mm≈48)
  const ANCHO = 48;

  // ── Estado interno ────────────────────────────────────────────────────────
  let _config = {
    modo:         'browser', // browser | webusb | network | bluetooth
    red_ip:       '',        // IP del proxy de red (ej: 192.168.1.50)
    red_puerto:   9100,
    bt_deviceId:  null,
    bt_nombre:    '',
    papel_mm:     80,        // 58 | 80
    corte:        true,      // cortar papel al finalizar
    beep:         false,     // beep al terminar impresión
  };

  let _usbDevice   = null;  // WebUSB device conectado
  let _btDevice    = null;  // Bluetooth device conectado
  let _btChar      = null;  // Characterística BT para escribir

  // ── Utilidades de formato texto ───────────────────────────────────────────

  const fmt$ = v => '$ ' + Number(v || 0).toLocaleString('es-AR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });

  function linea(texto = '', alineacion = 'izq') {
    const ancho = _config.papel_mm <= 58 ? 32 : 48;
    if (alineacion === 'cen') {
      const pad = Math.max(0, Math.floor((ancho - texto.length) / 2));
      return ' '.repeat(pad) + texto;
    }
    if (alineacion === 'der') return texto.padStart(ancho);
    return texto;
  }

  function columnas(izq, der) {
    const ancho = _config.papel_mm <= 58 ? 32 : 48;
    const espacio = ancho - izq.length - der.length;
    if (espacio <= 0) return izq.substring(0, ancho - der.length - 1) + ' ' + der;
    return izq + ' '.repeat(espacio) + der;
  }

  function separador(char = '-') {
    return char.repeat(_config.papel_mm <= 58 ? 32 : 48);
  }

  // ── Encoder texto → Uint8Array (Latin-1 para ESC/POS) ────────────────────
  function encode(texto) {
    // Reemplazar caracteres no-ASCII con equivalentes
    const normalizado = texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')   // quitar diacríticos
      .replace(/[^\x00-\xFF]/g, '?');    // reemplazar lo que quede
    const arr = new Uint8Array(normalizado.length);
    for (let i = 0; i < normalizado.length; i++) arr[i] = normalizado.charCodeAt(i);
    return arr;
  }

  function bytes(...partes) {
    const arrays = partes.map(p => {
      if (typeof p === 'string') return encode(p);
      if (Array.isArray(p))     return new Uint8Array(p);
      return p;
    });
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out   = new Uint8Array(total);
    let offset  = 0;
    for (const a of arrays) { out.set(a, offset); offset += a.length; }
    return out;
  }

  // ── Builders de contenido ─────────────────────────────────────────────────

  function buildTicket(venta, empresa) {
    const partes = [];

    // Cabecera empresa
    partes.push(CMD.INIT, CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.FONT_DOUBLE_WH);
    partes.push(empresa.nombre + '\n');
    partes.push(CMD.FONT_NORMAL, CMD.BOLD_OFF);
    if (empresa.domicilio) partes.push(empresa.domicilio + '\n');
    if (empresa.cuit)      partes.push('CUIT: ' + empresa.cuit + '\n');
    if (empresa.telefono)  partes.push('Tel: ' + empresa.telefono + '\n');
    partes.push(CMD.ALIGN_LEFT);
    partes.push(separador() + '\n');

    // Número y fecha
    const fecha = new Date().toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    partes.push(columnas('Ticket N°: ' + (venta.numero || ''), fecha) + '\n');
    if (venta.cliente?.razon_social && venta.cliente.razon_social !== 'Consumidor final') {
      partes.push('Cliente: ' + venta.cliente.razon_social + '\n');
    }
    partes.push(separador() + '\n');

    // Ítems
    for (const item of (venta.items || [])) {
      const subtotal = item.precio * item.cantidad * (1 - (item.descuento_pct || 0) / 100);
      const desc     = item.nombre.length > 24 ? item.nombre.substring(0, 23) + '…' : item.nombre;
      const cant     = item.vendido_por_peso ? Number(item.cantidad).toFixed(3) + ' kg' : item.cantidad + ' x';
      partes.push(cant + ' ' + desc + '\n');
      const precioStr = fmt$(item.precio) + (item.descuento_pct ? ' -' + item.descuento_pct + '%' : '');
      partes.push(columnas('  ' + precioStr, fmt$(subtotal)) + '\n');
      if (item.promocion_descripcion) partes.push('  [' + item.promocion_descripcion + ']\n');
    }

    partes.push(separador() + '\n');

    // Totales
    let subtotal = 0, ivaTotal = 0;
    for (const item of (venta.items || [])) {
      const precio  = item.precio * item.cantidad * (1 - (item.descuento_pct || 0) / 100);
      const iva_pct = item.iva || 0;
      ivaTotal += precio - precio / (1 + iva_pct / 100);
      subtotal += precio / (1 + iva_pct / 100);
    }
    partes.push(columnas('Subtotal (sin IVA)', fmt$(subtotal)) + '\n');
    partes.push(columnas('IVA', fmt$(ivaTotal)) + '\n');
    if ((venta.descuentoGlobal || 0) > 0) {
      const descMonto = (subtotal + ivaTotal) * venta.descuentoGlobal / 100;
      partes.push(columnas('Descuento ' + venta.descuentoGlobal + '%', '-' + fmt$(descMonto)) + '\n');
    }
    partes.push(CMD.BOLD_ON);
    partes.push(columnas('TOTAL', fmt$(venta.total)) + '\n');
    partes.push(CMD.BOLD_OFF);

    // Pagos
    partes.push(separador('-') + '\n');
    const labelMedio = m => ({ efectivo:'Efectivo', tarjeta:'Tarjeta', transferencia:'Transferencia',
      qr:'QR', mp_point:'MP Point', getnet:'Getnet', lapos:'Lapos', naranja:'Naranja X' }[m] || m);
    for (const p of (venta.pagos || [])) {
      partes.push(columnas(labelMedio(p.medio), fmt$(p.monto)) + '\n');
    }
    // Vuelto
    const pagadoEf = (venta.pagos || []).filter(p => p.medio === 'efectivo').reduce((s, p) => s + p.monto, 0);
    const vuelto   = Math.max(0, pagadoEf - venta.total);
    if (vuelto > 0) {
      partes.push(CMD.BOLD_ON);
      partes.push(columnas('VUELTO', fmt$(vuelto)) + '\n');
      partes.push(CMD.BOLD_OFF);
    }

    partes.push(separador() + '\n');
    partes.push(CMD.ALIGN_CENTER);
    partes.push('Gracias por su compra\n');
    partes.push('\n\n\n');

    if (_config.beep)  partes.push(CMD.BEEP);
    if (_config.corte) partes.push(CMD.CUT_PARTIAL);

    return bytes(...partes);
  }

  function buildReporteZ(rep, empresa) {
    const partes = [];

    partes.push(CMD.INIT, CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.FONT_DOUBLE_H);
    partes.push('REPORTE Z - CIERRE\n');
    partes.push(CMD.FONT_NORMAL, empresa.nombre + '\n', CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    partes.push(new Date().toLocaleString('es-AR') + '\n');
    partes.push(separador('=') + '\n');

    partes.push(columnas('Monto apertura', fmt$(rep.monto_inicial)) + '\n');
    partes.push(CMD.BOLD_ON);
    partes.push(columnas('Total vendido', fmt$(rep.total_ventas)) + '\n');
    partes.push(CMD.BOLD_OFF);

    if (rep.por_medio && Object.keys(rep.por_medio).length) {
      partes.push(separador('-') + '\n');
      partes.push('Por medio de pago:\n');
      for (const [m, v] of Object.entries(rep.por_medio)) {
        const label = ({ efectivo:'Efectivo', tarjeta:'Tarjeta', transferencia:'Transferencia',
          qr:'QR', mp_point:'MP Point', getnet:'Getnet' }[m] || m);
        partes.push(columnas('  ' + label, fmt$(v)) + '\n');
      }
    }

    if (rep.movimientos?.length) {
      partes.push(separador('-') + '\n');
      partes.push('Movimientos de caja:\n');
      for (const m of rep.movimientos) {
        const tipo = ({ sangria:'Sangria', refuerzo:'Refuerzo', retiro_final:'Retiro final' }[m.tipo] || m.tipo);
        partes.push(columnas('  ' + tipo + (m.concepto ? ' - ' + m.concepto : ''), fmt$(m.monto)) + '\n');
      }
    }

    partes.push(separador('=') + '\n');
    partes.push(CMD.BOLD_ON);
    partes.push(columnas('EFECTIVO EN CAJA', fmt$(rep.efectivo_esperado)) + '\n');
    partes.push(CMD.BOLD_OFF);
    partes.push('\n\n\n');

    if (_config.corte) partes.push(CMD.CUT_FULL);

    return bytes(...partes);
  }

  // ── Drivers de envío ─────────────────────────────────────────────────────

  async function enviarWebUSB(data) {
    if (!_usbDevice) throw new Error('Impresora USB no conectada. Ir a Admin → Hardware para configurar.');
    if (!_usbDevice.opened) await _usbDevice.open();

    // Encontrar la interfaz bulk-out
    const config    = _usbDevice.configurations[0];
    const iface     = config.interfaces.find(i =>
      i.alternates.some(a => a.endpoints.some(e => e.direction === 'out' && e.type === 'bulk'))
    );
    if (!iface) throw new Error('No se encontró interfaz de salida en la impresora USB.');

    const alt      = iface.alternates.find(a => a.endpoints.some(e => e.direction === 'out'));
    const endpoint = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');

    await _usbDevice.claimInterface(iface.interfaceNumber);
    await _usbDevice.selectAlternateInterface(iface.interfaceNumber, alt.alternateSetting);

    // Enviar en chunks de 64 bytes
    const CHUNK = 64;
    for (let i = 0; i < data.length; i += CHUNK) {
      await _usbDevice.transferOut(endpoint.endpointNumber, data.slice(i, i + CHUNK));
    }
  }

  async function enviarNetwork(data) {
    if (!_config.red_ip) throw new Error('IP de impresora no configurada. Ir a Admin → Hardware.');
    // El proxy local convierte POST HTTP → raw TCP port 9100
    // Requiere el proxy Node.js (pos-printer-proxy.js) corriendo en la misma PC
    const url = `http://${_config.red_ip}:${_config.red_puerto || 9100}/print`;
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body:    data,
    });
    if (!resp.ok) throw new Error('Error al imprimir por red: ' + resp.statusText);
  }

  async function enviarBluetooth(data) {
    if (!_btChar) throw new Error('Impresora Bluetooth no conectada. Ir a Admin → Hardware.');
    const CHUNK = 512;
    for (let i = 0; i < data.length; i += CHUNK) {
      await _btChar.writeValue(data.slice(i, i + CHUNK));
      await new Promise(r => setTimeout(r, 50)); // pequeña pausa entre chunks
    }
  }

  async function enviarBrowser() {
    window.print();
  }

  async function _enviar(data) {
    switch (_config.modo) {
      case 'webusb':    return enviarWebUSB(data);
      case 'network':   return enviarNetwork(data);
      case 'bluetooth': return enviarBluetooth(data);
      default:          return enviarBrowser();
    }
  }

  // ── Conexión de dispositivos ──────────────────────────────────────────────

  async function conectarWebUSB() {
    if (!navigator.usb) throw new Error('WebUSB no soportado en este navegador. Usá Chrome o Edge.');

    // Filtros comunes de impresoras térmicas (Epson, Bematech, Xprinter, Star)
    const FILTROS = [
      { vendorId: 0x04B8 }, // Epson
      { vendorId: 0x0DD4 }, // Bematech
      { vendorId: 0x0483 }, // Generic / Xprinter
      { vendorId: 0x1FC9 }, // Star Micronics
      { vendorId: 0x6868 }, // POS-X
      { vendorId: 0x0525 }, // Generic POS
    ];

    try {
      _usbDevice = await navigator.usb.requestDevice({ filters: FILTROS });
    } catch {
      // Si no matchea filtros, mostrar todas
      _usbDevice = await navigator.usb.requestDevice({ filters: [] });
    }
    return _usbDevice.productName || 'Impresora USB';
  }

  async function conectarBluetooth() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth no soportado. Usá Chrome en Android/desktop.');

    // UUID de servicio ESC/POS BT común (Xprinter, Rongta, etc.)
    const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
    const CHAR_UUID    = '00002af1-0000-1000-8000-00805f9b34fb';

    _btDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID, '0000ff00-0000-1000-8000-00805f9b34fb'],
    });
    const server  = await _btDevice.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch {
      service = await server.getPrimaryService('0000ff00-0000-1000-8000-00805f9b34fb');
    }
    try {
      _btChar = await service.getCharacteristic(CHAR_UUID);
    } catch {
      _btChar = await service.getCharacteristic('0000ff01-0000-1000-8000-00805f9b34fb');
    }
    _config.bt_nombre   = _btDevice.name || 'Impresora BT';
    _config.bt_deviceId = _btDevice.id;
    return _btDevice.name || 'Impresora Bluetooth';
  }

  // ── API pública ───────────────────────────────────────────────────────────

  async function init(config) {
    if (config) Object.assign(_config, config);
  }

  async function imprimirTicket(venta, empresa) {
    if (_config.modo === 'browser') return enviarBrowser();
    const data = buildTicket(venta, empresa || {});
    return _enviar(data);
  }

  async function imprimirReporteZ(rep, empresa) {
    if (_config.modo === 'browser') {
      document.body.classList.add('imprimiendo-z');
      window.print();
      setTimeout(() => document.body.classList.remove('imprimiendo-z'), 1000);
      return;
    }
    const data = buildReporteZ(rep, empresa || {});
    return _enviar(data);
  }

  async function testImpresion(empresa) {
    if (_config.modo === 'browser') { window.print(); return; }
    const partes = [
      CMD.INIT, CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.FONT_DOUBLE_H,
      'PRUEBA DE IMPRESION\n',
      CMD.FONT_NORMAL, CMD.BOLD_OFF,
      empresa?.nombre ? empresa.nombre + '\n' : '',
      new Date().toLocaleString('es-AR') + '\n',
      separador() + '\n',
      CMD.ALIGN_LEFT,
      columnas('Modo', _config.modo) + '\n',
      columnas('Papel', _config.papel_mm + 'mm') + '\n',
      separador() + '\n',
      CMD.ALIGN_CENTER,
      'Si ves esto, la impresora\nfunciona correctamente.\n',
      '\n\n\n',
    ];
    if (_config.corte) partes.push(CMD.CUT_PARTIAL);
    return _enviar(bytes(...partes));
  }

  function getConfig() { return { ..._config }; }

  // ── Wizard de configuración (UI) ─────────────────────────────────────────
  // Se llama desde la tab Hardware del modal Admin.
  // No genera HTML propio — el HTML está en pos.html.

  async function conectarDispositivo() {
    const modo = _config.modo;
    if (modo === 'webusb') {
      const nombre = await conectarWebUSB();
      window.toast('Impresora conectada: ' + nombre, 'exito');
      return nombre;
    }
    if (modo === 'bluetooth') {
      const nombre = await conectarBluetooth();
      window.toast('Impresora conectada: ' + nombre, 'exito');
      return nombre;
    }
    if (modo === 'network') {
      window.toast('Impresora en red lista. Usá "Prueba de impresión" para verificar.', 'default');
      return 'Red ' + _config.red_ip;
    }
    return 'browser';
  }

  // Exponer al POS
  window.PosPrinter = {
    init,
    imprimirTicket,
    imprimirReporteZ,
    testImpresion,
    getConfig,
    conectarDispositivo,
    setConfig: (c) => Object.assign(_config, c),
  };

})();
