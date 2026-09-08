// lib/eventos-errores.js
// FIX (dependencia circular eventos-dispatcher.js <-> eventos-listeners/*):
// ErrorEventoNoRecuperable vivía definida dentro de eventos-dispatcher.js,
// y varios listeners (pedido_creado.js, cliente_en_mora.js) la importaban
// de vuelta desde ahí. eventos-dispatcher.js importa esos mismos listeners
// para armar REGISTRO_LISTENERS, así que quedaba un ciclo: dispatcher ->
// listener -> dispatcher. En ESM eso es tolerado, pero es frágil según cuál
// de los dos módulos se cargue primero — si algo importa un listener como
// punto de entrada (como hace un test unitario del listener en aislado),
// el dispatcher todavía no terminó de ejecutarse y sus exports (incluida
// esta clase, y peor, los propios arrays de listeners que dispatcher
// necesita del listener) llegan `undefined`.
// Se saca la clase a este archivo sin ninguna dependencia propia — ahora
// el dispatcher y los listeners importan de acá, sin ciclo entre ellos.
export class ErrorEventoNoRecuperable extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorEventoNoRecuperable';
  }
}
