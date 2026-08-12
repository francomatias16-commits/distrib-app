// lib/export-contable/index.js
// Dispatcher de formateadores — cada proveedor contable expone
// generar({ tipo, comprobantes, desde, hasta, config, empresa_id, supabase })
// y devuelve { contenido, nombreArchivo, mimeType }.
//
// Mantener la firma idéntica entre formateadores es lo que permite que
// export-contable.js no sepa nada de los layouts específicos.

import * as generico from './formato-generico-csv.js';
import * as tango from './formato-tango.js';
import * as bejerman from './formato-bejerman.js';
import * as contabilium from './formato-contabilium.js';
import { listarCobrosParaExport } from '../repos/export-contable.js';

const FORMATEADORES = {
  generico_csv: generico,
  tango,
  bejerman,
  contabilium,
};

export async function generarExport(params) {
  const { proveedor, tipo } = params;
  const formateador = FORMATEADORES[proveedor];

  if (!formateador) {
    const err = new Error(`Proveedor contable desconocido: "${proveedor}"`);
    err.code = 'FORMATO_NO_IMPLEMENTADO';
    throw err;
  }

  // 'cobranzas' todavía no tiene vista SQL propia — se resuelve acá mismo
  // leyendo `cobros` directo, para no tener que tocar la migración 245
  // el día que se implemente. TODO: mover a v_comprobantes_contables_cobranza
  // si el volumen lo justifica.
  if (tipo === 'cobranzas' && params.comprobantes.length === 0) {
    const { data, error } = await listarCobrosParaExport(params.empresa_id, params.desde, params.hasta);

    if (error) throw error;
    params.comprobantes = data || [];
  }

  return formateador.generar(params);
}
