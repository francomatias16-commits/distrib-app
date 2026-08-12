// lib/export-contable/formato-bejerman.js
//
// ESTADO: NO IMPLEMENTADO — mismo motivo que formato-tango.js: Bejerman
// también importa asientos por archivo (plano o Excel según módulo), con
// layout que depende de la versión/parametrización de cada instalación.
// No hay uso público documentado lo bastante estable como para calcarlo
// sin un archivo de ejemplo real del contador que use Bejerman.
//
// Antes de completar esto:
//  1. Conseguir un archivo de ejemplo de importación de asientos ya
//     aceptado por el Bejerman real que use el cliente.
//  2. Confirmar si Bejerman en este caso se usa solo para IVA (Compras/
//     Ventas) o también para asientos contables completos — cambia qué
//     campos hacen falta.
//
// Misma nota que en Tango: `comprobantes` y `config.plan_cuentas` ya
// llegan listos: acá solo falta el armado del archivo de salida.

export async function generar({ tipo, comprobantes, desde, hasta, config }) {
  const err = new Error(
    'El formato Bejerman todavía no está implementado: falta confirmar el layout '
    + 'contra un archivo de ejemplo real. Mientras tanto, usá el export CSV '
    + 'genérico (proveedor=generico_csv).'
  );
  err.code = 'FORMATO_NO_IMPLEMENTADO';
  throw err;
}
