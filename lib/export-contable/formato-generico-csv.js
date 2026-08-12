// lib/export-contable/formato-generico-csv.js
//
// Formato de emergencia / fallback: CSV plano, una fila por comprobante,
// legible por cualquier sistema contable vía "importar planilla" manual.
// No arma asientos (débito/haber) — es un listado, para que el contador
// lo procese a mano si todavía no se configuró Tango/Bejerman/Contabilium.
//
// Es el único formateador completo de esta entrega: sirve para validar
// el pipeline entero (config → vista SQL → generación → log) sin depender
// de conseguir el layout exacto de un proveedor externo.

function formatearMonto(n, separadorDecimal) {
  const monto = Number(n || 0).toFixed(2);
  return separadorDecimal === ',' ? monto.replace('.', ',') : monto;
}

function formatearFecha(fecha, formato) {
  const d = new Date(fecha);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return formato === 'YYYY-MM-DD' ? `${yyyy}-${mm}-${dd}` : `${dd}/${mm}/${yyyy}`;
}

function escaparCSV(valor) {
  const s = String(valor ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function generar({ tipo, comprobantes, desde, hasta, config }) {
  const separadorDecimal = config?.separador_decimal || ',';
  const formatoFecha = config?.formato_fecha || 'DD/MM/YYYY';

  let headers, filas;

  if (tipo === 'cobranzas') {
    headers = ['Fecha', 'Cliente', 'CUIT', 'Medio', 'Referencia', 'Monto'];
    filas = comprobantes.map(c => [
      formatearFecha(c.fecha, formatoFecha),
      c.clientes?.razon_social || '',
      c.clientes?.cuit || '',
      c.medio || '',
      c.referencia || '',
      formatearMonto(c.monto, separadorDecimal),
    ]);
  } else {
    // ventas / compras — misma forma normalizada de las vistas SQL
    headers = ['Fecha', 'Tipo', 'Comprobante', 'Tercero', 'CUIT', 'Cond. IVA', 'Neto', 'IVA', 'Total'];
    filas = comprobantes.map(c => [
      formatearFecha(c.fecha, formatoFecha),
      c.origen,
      `${c.letra || ''} ${c.numero || ''}`.trim(),
      c.razon_social || '',
      c.cuit || '',
      c.condicion_iva || '',
      formatearMonto(c.neto, separadorDecimal),
      formatearMonto(c.iva, separadorDecimal),
      formatearMonto((c.total || 0) * (c.signo ?? 1), separadorDecimal),
    ]);
  }

  const lineas = [headers.join(';'), ...filas.map(fila => fila.map(escaparCSV).join(';'))];
  const contenido = lineas.join('\r\n');

  return {
    contenido,
    nombreArchivo: `export_${tipo}_${desde}_${hasta}.csv`,
    mimeType: 'text/csv; charset=utf-8',
  };
}
