// frontend/admin/js/productos/exportar-lista.js
// Exportación de la lista de productos/precios — CSV, Excel (.xlsx real) y PDF.
//
// Reemplaza al exportarProductos() que vivía en guardar-eliminar-producto.js
// (movido acá, ese archivo ya tenía cuatro responsabilidades distintas).
//
// Dos cosas cambian respecto de esa versión:
//
//   1. EXPORTA EL FILTRO COMPLETO, NO LA PÁGINA VISIBLE.
//      El export anterior hacía `const lista = productosPage`, que es la
//      página actual de 50 filas que devolvió fn_productos_lista con
//      LIMIT/OFFSET. Alguien que abría Productos y tocaba "Exportar CSV"
//      esperando su catálogo entero se llevaba 50 productos y no tenía
//      forma de darse cuenta — el archivo bajaba igual, sin aviso. Ahora
//      se vuelve a pedir el RPC con los MISMOS filtros activos (búsqueda,
//      categoría, estado, mes/año, foto, etiqueta) y el mismo orden, pero
//      con p_limit alto y p_offset 0, y se exporta todo eso.
//
//   2. Excel y PDF de verdad, no solo CSV. Las librerías (SheetJS y
//      jsPDF + autotable) se cargan por CDN recién al primer uso — mismo
//      patrón que ya usa dashboard-ejecutivo.js, así que no suman peso a
//      la carga inicial de la pantalla.
//
// Se carga como <script> clásico (no ES module) en productos.html, después
// de carga-datos.js (usa sb, PAGE_SIZE y las variables de filtro del scope
// global compartido). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// Tope duro del export. No es el tamaño del catálogo de nadie hoy (la
// empresa más grande del piloto ronda los 1500 productos), pero sin tope
// un filtro vacío sobre una base grande puede tumbar la pestaña armando el
// archivo en memoria. Si se alcanza, se avisa explícitamente en vez de
// recortar en silencio — que es justo el bug que este cambio corrige.
const EXPORT_MAX_FILAS = 5000;

/* ── Carga perezosa de librerías (CDN, al primer uso) ─────────────────── */

let _expXlsxCargado = null;
function _expCargarXLSX() {
  if (_expXlsxCargado) return _expXlsxCargado;
  _expXlsxCargado = new Promise((resolve, reject) => {
    if (window.XLSX) return resolve(window.XLSX);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload  = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('No se pudo cargar la librería de Excel'));
    document.head.appendChild(s);
  });
  return _expXlsxCargado;
}

let _expJspdfCargado = null;
function _expCargarJsPDF() {
  if (_expJspdfCargado) return _expJspdfCargado;
  _expJspdfCargado = new Promise((resolve, reject) => {
    if (window.jspdf?.jsPDF) return resolve(window.jspdf);
    const s1 = document.createElement('script');
    s1.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js';
      s2.onload  = () => resolve(window.jspdf);
      s2.onerror = () => reject(new Error('No se pudo cargar el plugin de tablas de PDF'));
      document.head.appendChild(s2);
    };
    s1.onerror = () => reject(new Error('No se pudo cargar la librería de PDF'));
    document.head.appendChild(s1);
  });
  return _expJspdfCargado;
}

/* ── Datos ────────────────────────────────────────────────────────────── */

/**
 * Trae TODAS las filas que matchean los filtros activos (no solo la página
 * en pantalla). Devuelve { filas, truncado } — `truncado` en true significa
 * que se llegó al tope y hay productos que quedaron afuera.
 */
async function traerProductosParaExport() {
  if (!sb) {
    // Modo demo (sin sesión): no hay RPC contra qué pedir, se exporta lo
    // que la pantalla está mostrando.
    return { filas: productosPage, truncado: false };
  }

  const { data, error } = await window.conTimeoutRed(sb.rpc('fn_productos_lista', {
    p_busqueda:     busquedaTag.trim() || null,
    p_categoria_id: filtroCatId || null,
    p_estado:       filtroEstado || null,
    p_orden:        ordenCol,
    p_asc:          ordenAsc,
    p_limit:        EXPORT_MAX_FILAS,
    p_offset:       0,
    p_mes:          mesActivo === null ? null : mesActivo + 1,
    p_anio:         mesActivo === null ? null : yearActivo,
    p_foto_fuente:  filtroFoto || null,
    p_etiqueta_id:  filtroEtiquetaId || null,
  }), 30000); // 30s: son hasta 5000 filas, no las 50 de la grilla
  if (error) throw error;

  const filas = (data || []).map(normalizarRpc);
  const total = data?.[0]?.total_count ?? filas.length;
  return { filas, truncado: total > filas.length };
}

/** Descripción corta de los filtros activos, para el encabezado del PDF. */
function _descripcionFiltros() {
  const partes = [];
  if (busquedaTag.trim()) partes.push(`búsqueda: "${busquedaTag.trim()}"`);
  if (filtroCatId) {
    const cat = categoriasAll.find(c => c.id === filtroCatId);
    if (cat) partes.push(`categoría: ${cat.nombre}`);
  }
  if (filtroEstado) partes.push(`estado: ${filtroEstado.replace('_', ' ')}`);
  if (mesActivo !== null) partes.push(`alta: ${mesActivo + 1}/${yearActivo}`);
  if (filtroFoto) partes.push(`foto: ${filtroFoto.replace('_', ' ')}`);
  return partes.length ? partes.join(' · ') : 'catálogo completo';
}

function _nombreArchivo(ext) {
  return `productos_${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function _descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function _avisarSiTruncado(truncado) {
  if (!truncado) return;
  toast(
    `El catálogo supera las ${EXPORT_MAX_FILAS.toLocaleString('es-AR')} filas: se exportaron las primeras. Filtrá por categoría para exportarlo por partes.`,
    'warning'
  );
}

/* ── Formatos ─────────────────────────────────────────────────────────── */

const COLUMNAS_EXPORT = [
  'Código', 'Nombre', 'Categoría', 'Estado', 'Última actualización',
  'Precio', 'Costo', 'Stock', 'Stock mínimo', 'Margen %',
];

function _filaExport(p) {
  return [
    p.codigo || '', p.nombre, p.cat, p.estado, formatFecha(p.fechaAct),
    p.precio, p.costo, p.stock, p.stockMinimo ?? 0, p.margen,
  ];
}

async function exportarProductosCSV() {
  const { filas, truncado } = await traerProductosParaExport();
  if (!filas.length) { toast('No hay productos para exportar.', 'warning'); return; }

  const csv = [COLUMNAS_EXPORT, ...filas.map(_filaExport)]
    .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');

  // El BOM inicial es para que Excel en español abra el archivo en UTF-8 y
  // no rompa los acentos ni la ñ.
  _descargarBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }), _nombreArchivo('csv'));
  _avisarSiTruncado(truncado);
  toast(`${filas.length} productos exportados a CSV.`, 'success');
}

async function exportarProductosExcel() {
  const XLSX = await _expCargarXLSX();
  const { filas, truncado } = await traerProductosParaExport();
  if (!filas.length) { toast('No hay productos para exportar.', 'warning'); return; }

  // aoa_to_sheet (y no json_to_sheet) para fijar el orden de las columnas
  // y que los números queden como número en la celda, no como texto —
  // que es la diferencia real entre esto y renombrar un CSV a .xlsx.
  const hoja = XLSX.utils.aoa_to_sheet([COLUMNAS_EXPORT, ...filas.map(_filaExport)]);
  hoja['!cols'] = [
    { wch: 16 }, { wch: 42 }, { wch: 18 }, { wch: 11 }, { wch: 18 },
    { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 13 }, { wch: 10 },
  ];
  hoja['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { c: 0, r: 0 }, e: { c: COLUMNAS_EXPORT.length - 1, r: filas.length },
  }) };

  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, 'Productos');
  XLSX.writeFile(libro, _nombreArchivo('xlsx'));

  _avisarSiTruncado(truncado);
  toast(`${filas.length} productos exportados a Excel.`, 'success');
}

async function exportarProductosPDF() {
  const { jsPDF } = await _expCargarJsPDF();
  const { filas, truncado } = await traerProductosParaExport();
  if (!filas.length) { toast('No hay productos para exportar.', 'warning'); return; }

  // Apaisado: con 10 columnas, en vertical el nombre del producto queda
  // partido en tres renglones y la lista se vuelve ilegible.
  const doc = new jsPDF({ orientation: 'landscape' });
  const empresaNombre = empresaData?.nombre || 'Lista de precios';

  doc.setFontSize(16);
  doc.text('Lista de precios', 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`${empresaNombre} — ${new Date().toLocaleString('es-AR')}`, 14, 22);
  doc.text(`${filas.length} producto(s) — ${_descripcionFiltros()}`, 14, 27);
  doc.setTextColor(0);

  doc.autoTable({
    startY: 32,
    head: [COLUMNAS_EXPORT],
    body: filas.map(p => [
      p.codigo || '—', p.nombre, p.cat, p.estado, formatFecha(p.fechaAct),
      formatPeso(p.precio), formatPeso(p.costo), p.stock, p.stockMinimo ?? 0, `${p.margen}%`,
    ]),
    theme: 'striped',
    styles: { fontSize: 8, cellPadding: 1.8 },
    headStyles: { fillColor: [15, 61, 44] },
    columnStyles: { 1: { cellWidth: 70 } },
    // Pie con numeración: una lista de precios de 1500 productos son ~40
    // páginas y se imprime para repartir, así que el número importa.
    didDrawPage: (data) => {
      const pag = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(`Página ${pag}`, data.settings.margin.left, doc.internal.pageSize.getHeight() - 8);
      doc.setTextColor(0);
    },
  });

  doc.save(_nombreArchivo('pdf'));
  _avisarSiTruncado(truncado);
  toast(`${filas.length} productos exportados a PDF.`, 'success');
}

/* ── Entrada única desde el menú "Más funciones" ──────────────────────── */

window.exportarProductos = async function (formato = 'csv') {
  try {
    if (formato === 'xlsx') return await exportarProductosExcel();
    if (formato === 'pdf')  return await exportarProductosPDF();
    return await exportarProductosCSV();
  } catch (err) {
    console.error('[productos] Error al exportar:', err);
    toast(err?.message || 'No se pudo generar la exportación. Probá de nuevo en un momento.', 'error');
  }
};
