// lib/export-contable/formato-contabilium.js
//
// ESTADO: NO IMPLEMENTADO — y además, ADVERTENCIA DE DISEÑO:
//
// A diferencia de Tango/Bejerman (que son escritorio y consumen un
// archivo), Contabilium es un sistema en la nube con API REST propia.
// Lo natural para Contabilium NO es generar un archivo para que alguien
// suba a mano — es que este backend llame directo a su API (con un
// API key configurado por empresa, guardado server-side como
// facturacion_config.cert_pem/key_pem hoy — necesitaría su propia fila
// en export_contable_config o una tabla de credenciales separada, NUNCA
// en el JSONB de plan_cuentas que sí es legible desde el frontend).
//
// Esto significa que "generar()" con la misma firma que los formatos de
// archivo no es el diseño correcto para Contabilium: en vez de devolver
// {contenido, nombreArchivo, mimeType} debería:
//   1. Tomar los `comprobantes` normalizados.
//   2. Mapear cada uno a la forma que pide la API de Contabilium
//      (facturas de venta / gastos según su documentación — a confirmar
//      versión de API y autenticación exactas).
//   3. Hacer los POST correspondientes (con reintentos — mismo patrón que
//      lib/circuit-breaker.js usado en otras integraciones del proyecto).
//   4. Devolver un resumen (cuántos se subieron OK, cuáles fallaron) en
//      vez de un archivo — el handler actual (export-contable.js) asume
//      "siempre hay un archivo para descargar", así que este caso va a
//      necesitar su propia rama en generarHandler() antes de habilitarse.
//
// Por eso queda directamente sin implementar hasta decidir esa rama en
// el handler, en vez de forzar un archivo que no tiene sentido para este
// proveedor.

export async function generar() {
  const err = new Error(
    'Contabilium se integra por API, no por archivo: requiere una rama '
    + 'aparte en el handler antes de implementarse (ver comentario en este '
    + 'archivo). Todavía no implementado.'
  );
  err.code = 'FORMATO_NO_IMPLEMENTADO';
  throw err;
}
