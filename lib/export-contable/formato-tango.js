// lib/export-contable/formato-tango.js
//
// ESTADO: NO IMPLEMENTADO todavía — este archivo documenta la investigación
// hecha y deja la firma lista, pero lanza FORMATO_NO_IMPLEMENTADO a propósito
// hasta confirmar el layout exacto contra un caso real.
//
// ── Por qué no se implementa "a ciegas" ──────────────────────────────────
// Tango Gestión/Contabilidad importa asientos vía un archivo de texto de
// ancho fijo (o Excel con su propia plantilla, según versión/módulo:
// "Interfaces > Importación de asientos"). El layout concreto (posiciones
// de columna, si van 2 líneas por asiento o 1 con debe/haber en columnas
// separadas, qué hace con IVA discriminado) CAMBIA entre versiones de
// Tango y según cómo esté parametrizado el "tipo de comprobante" en el
// Tango de cada cliente. Generar esto sin un archivo de ejemplo real
// (exportado por el contador desde su propio Tango, o la plantilla que
// use) tiene alto riesgo de producir un archivo que Tango "importa" pero
// con las cuentas cruzadas — mucho peor que no exportar nada.
//
// ── Qué se necesita antes de completar esto ──────────────────────────────
//  1. Un archivo de ejemplo real de "Importación de asientos" ya aceptado
//     por el Tango del contador (o de la versión que usen), para calcar
//     el layout exacto columna por columna.
//  2. Confirmar con el contador el criterio de asiento: ¿un asiento por
//     comprobante (Deudores por Venta vs IVA Débito Fiscal + Ventas) o
//     un asiento resumen por día/período?
//  3. Confirmar el mapeo de campos:
//     Fecha | Nro. Comprobante | Cuenta (usar plan_cuentas.*) | Concepto |
//     Importe Debe | Importe Haber | Centro de Costo (si aplica)
//
// ── Lo que SÍ está resuelto y no cambia cuando esto se implemente ────────
// `comprobantes` ya llega normalizado (misma forma para venta y compra,
// ver 245_etapa6_export_contable.sql → v_comprobantes_contables_*), y
// `config.plan_cuentas` ya tiene los códigos de cuenta de la empresa.
// Completar este archivo es 100% armar el string/Excel de salida, no
// tocar nada de la base ni del handler.

export async function generar({ tipo, comprobantes, desde, hasta, config }) {
  const err = new Error(
    'El formato Tango todavía no está implementado: falta confirmar el layout '
    + 'exacto de "Importación de asientos" contra un archivo de ejemplo real. '
    + 'Mientras tanto, usá el export CSV genérico (proveedor=generico_csv) '
    + 'para pasarle el detalle al contador a mano.'
  );
  err.code = 'FORMATO_NO_IMPLEMENTADO';
  throw err;
}
