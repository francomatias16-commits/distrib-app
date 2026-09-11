// lib/eventos-errores.js
// Tipos de error del bus de eventos, separados de eventos-dispatcher.js
// a propósito.
//
// FIX-CIRC-01 (2026-09-08): ErrorEventoNoRecuperable vivía en
// eventos-dispatcher.js, y los listeners (cliente_en_mora.js,
// pedido_creado.js) lo importaban desde ahí — pero eventos-dispatcher.js
// también importa REGISTRO_LISTENERS desde esos mismos listeners para
// armar el registro. Ese ciclo funciona mientras algo importe primero
// eventos-dispatcher.js (el caso normal en producción: siempre se llega
// a los listeners a través del despachador). Pero si algo importa un
// listener directamente primero — como hace
// tests/handlers/cliente-en-mora-listener.test.js al aislar el listener
// para no depender del módulo pesado de notif.js — el ciclo se resuelve
// en el orden contrario: eventos-dispatcher.js termina leyendo
// `listenersClienteEnMora` (o `listenersPedidoCreado`) ANTES de que el
// módulo del listener haya terminado de ejecutarse y de asignar ese
// export, así que en ese punto vale `undefined`. Como
// TIPOS_EVENTO_SIN_LISTENER se calcula de forma síncrona al importar el
// módulo (no de forma diferida), ese `undefined` queda "congelado" en
// REGISTRO_LISTENERS y el `.filter(([, listeners]) => listeners.length
// === 0)` revienta con "Cannot read properties of undefined (reading
// 'length')" apenas se importa el listener de forma aislada — el fallo
// no tiene nada que ver con la lógica del listener en sí.
//
// La lección (ya anotada para la próxima auditoría de dependencias, ver
// CHANGELOG_v1067): un ciclo entre un módulo con efectos de import-time
// (acá, construir REGISTRO_LISTENERS/TIPOS_EVENTO_SIN_LISTENER) y sus
// propias dependencias es frágil ante el orden de imports, aunque nunca
// se note en producción porque ahí el orden siempre es el mismo.
// Solución: sacar lo que no tiene por qué generar el ciclo (esta clase,
// que no depende de nada) a su propio módulo sin imports, y que tanto
// eventos-dispatcher.js como los listeners lo importen desde acá.
export class ErrorEventoNoRecuperable extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorEventoNoRecuperable';
  }
}
