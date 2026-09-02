// frontend/admin/js/clientes/index.js
// Punto de entrada del módulo clientes — único <script type="module"> que
// carga clientes.html. Importa todos los archivos de dominio (lo que
// además dispara sus efectos de carga, como el auto-registro de
// window.crearZonaRapida en carga-listado.js), y centraliza acá el
// bloque de wiring `window.xxx = xxx` que en el clientes.js original
// vivía repartido entre un puñado de asignaciones puntuales (colocadas
// justo después de su función, ver comentario FIX v477 en nucleo.js) y
// un bloque grande al final del archivo — mismo criterio, un solo lugar.
//
// Import circular entre algunos pares de archivos (ej. nucleo.js ↔
// geocodificacion.js, carga-listado.js ↔ filtros-render.js) es esperado y
// seguro acá: ES modules soportan ciclos siempre que el binding importado
// solo se use dentro de un cuerpo de función (ejecutado en runtime), nunca
// en el nivel superior del módulo al momento de evaluarlo — que es
// exactamente el caso en los 14 archivos de este split. Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

import * as Nucleo from './nucleo.js';
import * as Geocodificacion from './geocodificacion.js';
import * as CargaListado from './carga-listado.js';
import * as FiltrosRender from './filtros-render.js';
import * as ModalCliente from './modal-cliente.js';
import * as CtaCteHistorial from './cta-cte-historial.js';
import * as GuardarCliente from './guardar-cliente.js';
import * as PreciosEspeciales from './precios-especiales.js';
import * as Direcciones from './direcciones.js';
import * as ListasPrecio from './listas-precio.js';
import * as ExportarExcel from './exportar-excel.js';
import * as ScoreCliente from './score-cliente.js';
import * as PortalCliente from './portal-cliente.js';
// _helpers.js no expone nada a window (solo se usa entre módulos), pero se
// importa igual para mantener el mismo criterio de "todo módulo se carga
// desde acá" y que quede claro en el grafo de dependencias.
import './_helpers.js';

// ── Wiring de funciones usadas desde onclick="..." en el HTML ──────────────
window.verCatalogoCliente = Nucleo.verCatalogoCliente;
window.init = Nucleo.init;

window.geocodificarClienteActual = Geocodificacion.geocodificarClienteActual;
window.geocodificarPendientesLote = Geocodificacion.geocodificarPendientesLote;

window.cambiarPagina = CargaListado.cambiarPagina;

window.aplicarFiltros = FiltrosRender.aplicarFiltros;
window.selFiltroEstado = FiltrosRender.selFiltroEstado;
window.limpiarFiltros = FiltrosRender.limpiarFiltros;

window.abrirModalNuevo = ModalCliente.abrirModalNuevo;
window.abrirModalEditar = ModalCliente.abrirModalEditar;
window.cerrarModal = ModalCliente.cerrarModal;
window.selTab = ModalCliente.selTab;
window.enviarEstadoCuenta = ModalCliente.enviarEstadoCuenta;

window.cargarBloqueos = CtaCteHistorial.cargarBloqueos;

window.guardarCliente = GuardarCliente.guardarCliente;

window.cambiarVista = PreciosEspeciales.cambiarVista;
window.abrirModalPrecio = PreciosEspeciales.abrirModalPrecio;
window.cerrarModalPrecio = PreciosEspeciales.cerrarModalPrecio;
window.guardarPrecioCliente = PreciosEspeciales.guardarPrecioCliente;
window.eliminarPrecioCliente = PreciosEspeciales.eliminarPrecioCliente;
window.filtrarPrecios = PreciosEspeciales.filtrarPrecios;

window.abrirModalDireccion = Direcciones.abrirModalDireccion;
window.cerrarModalDireccion = Direcciones.cerrarModalDireccion;
window.guardarDireccion = Direcciones.guardarDireccion;
window.eliminarDireccion = Direcciones.eliminarDireccion;
window.filtrarDirecciones = Direcciones.filtrarDirecciones;

window.cargarListasPreciosTab = ListasPrecio.cargarListasPreciosTab;
window.abrirModalListaPrecio = ListasPrecio.abrirModalListaPrecio;
window.cerrarModalListaPrecio = ListasPrecio.cerrarModalListaPrecio;
window.guardarListaPrecio = ListasPrecio.guardarListaPrecio;
window.activarListaPrecio = ListasPrecio.activarListaPrecio;
window.desactivarListaPrecio = ListasPrecio.desactivarListaPrecio;

window.exportarExcel = ExportarExcel.exportarExcel;

window.verScoreCliente = ScoreCliente.verScoreCliente;
window.cargarAlertasScore = ScoreCliente.cargarAlertasScore;
window.resolverAlertaScore = ScoreCliente.resolverAlertaScore;
window.confirmarBaja = ScoreCliente.confirmarBaja;
window.confirmarDesbloqueo = ScoreCliente.confirmarDesbloqueo;

window.gestionarAccesoPortal = PortalCliente.gestionarAccesoPortal;
window.confirmarCrearAcceso = PortalCliente.confirmarCrearAcceso;
window.copiarMensajeWA = PortalCliente.copiarMensajeWA;
window.cerrarModalPortal = PortalCliente.cerrarModalPortal;
window.abrirModalAccesosPortal = PortalCliente.abrirModalAccesosPortal;
window.cerrarModalAccesosPortal = PortalCliente.cerrarModalAccesosPortal;
window.renderListaAccesosPortal = PortalCliente.renderListaAccesosPortal;
window.gestionarAccesoPortalDesdeModal = PortalCliente.gestionarAccesoPortalDesdeModal;

// ── Bootstrap (idéntico al del clientes.js original) ────────────────────────
window.authReady.then(() => Nucleo.init()).catch((err) => {
  console.error('[auth] authReady falló:', err?.message);
  if (!window.authCtx || !window.authCtx.perfil) {
    window.location.href = '/admin/login';
  }
});
