// frontend/admin/js/pos/carrito-en-espera.js
// Punto 2 del audit de pendientes de POS — "comprobante en espera": una
// venta armada (carrito + cliente + descuento global) se puede dejar de
// lado para atender a otro cliente, sin perder nada, y retomarla después.
// Usa el array `carritosEnEspera` declarado junto al resto del estado del
// POS en nucleo.js.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba pos.js original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.
//
// Por qué las píldoras NO muestran montos: la pantalla del POS suele estar
// de cara al mostrador, a la vista del cliente que se está atendiendo en
// ese momento. Mostrar ahí el total de la venta de OTRO cliente que quedó
// en espera es una fuga de información innecesaria — el cajero ya sabe de
// quién es cada una por la etiqueta, no hace falta el importe para elegir
// cuál retomar.

let _tickEsperaTimer = null;

// Arma una etiqueta legible para identificar la espera en su píldora, sin
// que el cajero tenga que recordar un ID.
function _etiquetaEspera() {
  if (clienteSel?.razon_social) return clienteSel.razon_social;
  const cant = carrito.length;
  return `Venta sin nombre (${cant} ${cant === 1 ? 'ítem' : 'ítems'})`;
}

// Snapshot de la venta actual tal cual está en el mostrador ahora mismo.
function _snapshotVentaActual() {
  return {
    id: 'espera_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    etiqueta: _etiquetaEspera(),
    carrito: carrito,
    descuentoGlobal: descuentoGlobal,
    clienteSel: clienteSel,
    creado_en: Date.now(),
  };
}

// Deja la venta actual en espera y limpia el mostrador para atender a otro
// cliente sin perder lo ya armado. No pide confirmación (a diferencia de
// "Nueva venta"): acá no se pierde nada, solo se guarda para después.
// quitarCliente() (cliente-cobro.js) ya deja clienteSel en null, actualiza
// el header "Datos del cliente" y llama a actualizarInfoComprobante() —
// se reutiliza en vez de reimplementar ese mismo reseteo acá.
window.ponerEnEspera = function () {
  if (!carrito.length) return;

  carritosEnEspera.push(_snapshotVentaActual());

  carrito = [];
  descuentoGlobal = 0;
  window.quitarCliente();
  renderCarrito();
  renderCarritosEspera();
  window.toast('Venta guardada en espera', 'default');
  inputProducto?.focus();
};

// Vuelve a poner en el mostrador una venta que estaba en espera. Si ya hay
// una venta en curso, primero confirma que se la guarde en espera para no
// perderla — nunca la descarta en silencio.
window.retomarEspera = async function (id) {
  const idx = carritosEnEspera.findIndex(e => e.id === id);
  if (idx === -1) return;

  if (carrito.length) {
    const ok = await window.confirmar(
      'Hay una venta en curso en el mostrador. Se va a guardar en espera para retomar la que elegiste. ¿Continuar?',
      { labelOk: 'Sí, retomar' }
    );
    if (!ok) return;
    carritosEnEspera.push(_snapshotVentaActual());
  }

  const espera = carritosEnEspera[idx];
  carritosEnEspera.splice(idx, 1);

  carrito = espera.carrito;
  descuentoGlobal = espera.descuentoGlobal;
  // seleccionarCliente()/quitarCliente() (cliente-cobro.js) son las mismas
  // que usa el flujo normal de elegir cliente: dejan clienteSel, el header
  // "Datos del cliente" y actualizarInfoComprobante() consistentes entre sí,
  // en vez de que este archivo reimplemente ese mismo reseteo por su cuenta.
  if (espera.clienteSel) seleccionarCliente(espera.clienteSel);
  else window.quitarCliente();

  renderCarrito();
  renderCarritosEspera();
  window.toast(`Venta "${espera.etiqueta}" retomada`, 'default');
};

// Descarta definitivamente una venta en espera (ej. el cliente se fue y no
// vuelve). Pide confirmación porque no se puede deshacer.
window.descartarEspera = async function (id) {
  const espera = carritosEnEspera.find(e => e.id === id);
  if (!espera) return;
  const ok = await window.confirmar(
    `¿Descartar la venta en espera "${escapeHtml(espera.etiqueta)}"? Se pierde todo lo cargado ahí.`,
    { tipo: 'danger', labelOk: 'Sí, descartar' }
  );
  if (!ok) return;
  carritosEnEspera = carritosEnEspera.filter(e => e.id !== id);
  renderCarritosEspera();
  window.toast('Venta en espera descartada', 'default');
};

// Texto relativo simple para la píldora, sin depender de una librería de
// fechas para un par de minutos de resolución.
function _haceCuanto(timestampMs) {
  const minutos = Math.floor((Date.now() - timestampMs) / 60000);
  if (minutos < 1) return 'recién';
  if (minutos === 1) return 'hace 1 min';
  return `hace ${minutos} min`;
}

function renderCarritosEspera() {
  const cont = document.getElementById('pos-carritos-espera');
  if (!cont) return;

  if (!carritosEnEspera.length) {
    cont.style.display = 'none';
    cont.innerHTML = '';
    clearInterval(_tickEsperaTimer);
    _tickEsperaTimer = null;
    return;
  }

  cont.style.display = '';
  cont.innerHTML = carritosEnEspera.map(e => `
    <button type="button" class="pos-pildora-espera" data-id="${e.id}" title="Retomar esta venta">
      <span class="pos-pildora-espera-icono" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></span>
      <span class="pos-pildora-espera-tit">${escapeHtml(e.etiqueta)}</span>
      <span class="pos-pildora-espera-tiempo">${_haceCuanto(e.creado_en)}</span>
      <span class="pos-pildora-espera-quitar" data-action="descartar" title="Descartar venta en espera"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
    </button>
  `).join('');

  cont.querySelectorAll('.pos-pildora-espera').forEach(el => {
    el.addEventListener('click', (ev) => {
      const id = el.dataset.id;
      if (ev.target.closest('[data-action="descartar"]')) {
        ev.stopPropagation();
        window.descartarEspera(id);
        return;
      }
      window.retomarEspera(id);
    });
  });

  // Refresca solo el texto "hace X min" cada 30s, sin re-renderizar toda la
  // fila (así no se pierde nada si el cajero está por clickear justo cuando
  // corre el intervalo).
  if (!_tickEsperaTimer) {
    _tickEsperaTimer = setInterval(() => {
      cont.querySelectorAll('.pos-pildora-espera').forEach(el => {
        const e = carritosEnEspera.find(x => x.id === el.dataset.id);
        const tEl = el.querySelector('.pos-pildora-espera-tiempo');
        if (e && tEl) tEl.textContent = _haceCuanto(e.creado_en);
      });
    }, 30000);
  }
}
