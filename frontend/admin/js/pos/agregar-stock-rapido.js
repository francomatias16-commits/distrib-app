// frontend/admin/js/pos/agregar-stock-rapido.js
// Punto 1 del audit (mitad "agregar stock sin perder el comprobante"):
// modal para cargar un ingreso de stock del producto en el depósito de la
// caja actual, sin salir del POS ni perder el `carrito` en memoria.
// Se abre desde carrito.js cuando `agregarAlCarrito()` encuentra un
// producto con stock_disponible <= 0 y sin permite_negativo. Backend:
// POST /api/pos/agregar-stock-rapido (ver lib/handlers/pos.js).
//
// dueno/admin ajustan directo. vendedor necesita PIN de supervisor — el
// campo se muestra de entrada según el rol logueado (mejor UX), pero la
// única fuente de verdad es el backend: si igual llega sin PIN o con uno
// incorrecto, el 403 { requiere_pin: true } vuelve a mostrar el campo con
// el error, tal como ya hace pedirPinSupervisor() en ticket-facturacion.js.

let _srProductoPendiente = null;

window.abrirModalStockRapido = function (producto) {
  _srProductoPendiente = producto;

  document.getElementById('sr-producto-nombre').textContent = producto.nombre || 'Este producto';
  document.getElementById('sr-cantidad').value = 1;
  document.getElementById('sr-notas').value = '';
  document.getElementById('sr-pin').value = '';
  document.getElementById('sr-error').style.display = 'none';

  const grupoPin = document.getElementById('sr-pin-grupo');
  // Mismo set de roles que ROLES_AJUSTAN_STOCK_DIRECTO en el backend,
  // recortado a los roles que de hecho llegan a pos.html
  // (window.PAGINA_ROLES_PERMITIDOS = ['dueno','admin','vendedor']).
  const necesitaPin = !window.tieneRol?.('dueno', 'admin');
  grupoPin.style.display = necesitaPin ? '' : 'none';

  document.getElementById('modal-stock-rapido-overlay').style.display = '';
  setTimeout(() => document.getElementById('sr-cantidad')?.focus(), 60);
};

window.cerrarModalStockRapido = function () {
  document.getElementById('modal-stock-rapido-overlay').style.display = 'none';
  _srProductoPendiente = null;
};

window.confirmarStockRapido = async function () {
  const errEl = document.getElementById('sr-error');
  errEl.style.display = 'none';

  if (!_srProductoPendiente || !cajaActual?.id) {
    errEl.textContent = 'No se pudo identificar la caja actual. Cerrá este modal y probá de nuevo.';
    errEl.style.display = '';
    return;
  }

  const cantidad = Number(document.getElementById('sr-cantidad').value);
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    errEl.textContent = 'Ingresá una cantidad entera mayor a cero.';
    errEl.style.display = '';
    return;
  }

  const notas = document.getElementById('sr-notas').value.trim();
  const grupoPin = document.getElementById('sr-pin-grupo');
  const pin = document.getElementById('sr-pin').value.trim();

  try {
    const resp = await apiPost('/api/pos/agregar-stock-rapido', {
      caja_id: cajaActual.id,
      producto_id: _srProductoPendiente.id,
      cantidad,
      notas: notas || undefined,
      pin_supervisor: pin || undefined,
    });

    // El producto pendiente pasa a tener stock: se agrega solo al carrito
    // para no obligar al cajero a volver a buscarlo.
    const producto = _srProductoPendiente;
    producto.stock_disponible = resp.cantidad_nueva;
    cerrarModalStockRapido();
    window.toast(`Stock cargado — "${producto.nombre}" agregado a la venta`, 'exito');
    agregarAlCarrito(producto);
  } catch (e) {
    if (e.requiere_pin) {
      grupoPin.style.display = '';
      setTimeout(() => document.getElementById('sr-pin')?.focus(), 30);
    }
    errEl.textContent = e.message || 'No se pudo agregar el stock.';
    errEl.style.display = '';
  }
};

// Enter en cualquier campo del modal confirma (mismo patrón que el resto
// de los modales rápidos del POS: cliente-rapido, PIN).
['sr-cantidad', 'sr-notas', 'sr-pin'].forEach((id) => {
  document.getElementById(id)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); window.confirmarStockRapido(); }
  });
});
