// lib/handlers/pedidos.js
//
// Punto de entrada público del módulo pedidos — MISMA API que antes del
// split (25/08/2026). El contenido real (dispatcher HTTP + sub-módulos por
// dominio: crear/confirmar pedido, pedido sugerido, notificaciones,
// presupuestos, remito, chofer, devoluciones) vive en lib/handlers/pedidos/.
// Se mantiene este archivo con el mismo path para que los importadores
// existentes (lib/asistente-tools/index.js, lib/eventos-listeners/
// pedido_creado.js, api/index.js) no necesiten tocarse. Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md para el detalle del split.

export {
  default,
  ROLES_ADMIN,
  confirmarPedidoSugeridoHandler,
  crearPedidoParaCliente,
  notificarEstado,
  notificarPedidoConfirmado,
  acreditarPuntos,
  acreditarAhorroCompetencia,
  ROLES_ADMIN_PRES,
  crearPresupuestoParaCliente,
  crearDevolucionCore,
} from './pedidos/index.js';
