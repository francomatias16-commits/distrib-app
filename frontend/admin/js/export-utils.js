/**
 * Utilidades de Exportación para Reportes
 * Soporta CSV y Excel con formato profesional
 */

class ExportUtils {
    /**
     * Exportar tabla HTML a CSV
     * @param {string} tableSelector - Selector CSS de la tabla
     * @param {string} filename - Nombre del archivo
     */
    static exportTableToCSV(tableSelector, filename) {
        const table = document.querySelector(tableSelector);
        if (!table) {
            console.error('Tabla no encontrada:', tableSelector);
            return;
        }

        let csv = [];
        const rows = table.querySelectorAll('tr');

        rows.forEach(row => {
            const cols = row.querySelectorAll('td, th');
            const csvRow = [];
            cols.forEach(col => {
                let text = col.textContent.trim();
                // Escapar comillas y envolver en comillas si contiene coma
                text = text.replace(/"/g, '""');
                if (text.includes(',') || text.includes('\n')) {
                    text = `"${text}"`;
                }
                csvRow.push(text);
            });
            csv.push(csvRow.join(','));
        });

        this.downloadCSV(csv.join('\n'), filename);
    }

    /**
     * Exportar datos a CSV con encabezado personalizado
     * @param {Array} data - Array de objetos
     * @param {Array} headers - Array de nombres de columnas
     * @param {string} filename - Nombre del archivo
     */
    static exportDataToCSV(data, headers, filename) {
        let csv = [];

        // Agregar encabezados
        csv.push(headers.map(h => `"${h}"`).join(','));

        // Agregar datos
        data.forEach(row => {
            const values = Object.values(row).map(v => {
                if (v === null || v === undefined) return '';
                let text = String(v).trim();
                text = text.replace(/"/g, '""');
                if (text.includes(',') || text.includes('\n')) {
                    text = `"${text}"`;
                }
                return text;
            });
            csv.push(values.join(','));
        });

        this.downloadCSV(csv.join('\n'), filename);
    }

    /**
     * Descargar contenido CSV
     * @param {string} content - Contenido del CSV
     * @param {string} filename - Nombre del archivo
     */
    static downloadCSV(content, filename) {
        const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);

        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    /**
     * Exportar a Excel (usando SheetJS si está disponible)
     * @param {Array} data - Array de objetos
     * @param {string} sheetName - Nombre de la hoja
     * @param {string} filename - Nombre del archivo
     */
    static exportToExcel(data, sheetName = 'Datos', filename = 'reporte.xlsx') {
        // Verificar si SheetJS está disponible
        if (typeof XLSX === 'undefined') {
            console.warn('SheetJS no está disponible. Usando CSV como alternativa.');
            const headers = Object.keys(data[0] || {});
            this.exportDataToCSV(data, headers, filename.replace('.xlsx', '.csv'));
            return;
        }

        // Crear workbook
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName);

        // Aplicar estilos básicos
        this.applyExcelStyles(ws, data);

        // Descargar
        XLSX.writeFile(wb, filename);
    }

    /**
     * Aplicar estilos a hoja de Excel
     * @param {Object} worksheet - Hoja de trabajo
     * @param {Array} data - Datos
     */
    static applyExcelStyles(worksheet, data) {
        if (!data || data.length === 0) return;

        // Ajustar ancho de columnas
        const colWidths = [];
        const headers = Object.keys(data[0]);

        headers.forEach((header, idx) => {
            let maxLen = header.length;
            data.forEach(row => {
                const cellValue = String(row[header] || '');
                if (cellValue.length > maxLen) {
                    maxLen = cellValue.length;
                }
            });
            colWidths.push({ wch: Math.min(maxLen + 2, 50) });
        });

        worksheet['!cols'] = colWidths;
    }

    /**
     * Generar reporte combinado (múltiples tablas)
     * @param {Array} sections - Array de objetos {title, data, headers}
     * @param {string} filename - Nombre del archivo
     */
    static exportMultipleSections(sections, filename) {
        let csv = [];

        sections.forEach((section, idx) => {
            if (idx > 0) csv.push(''); // Línea en blanco entre secciones
            csv.push(section.title.toUpperCase());
            csv.push(''); // Línea en blanco

            // Encabezados
            csv.push(section.headers.map(h => `"${h}"`).join(','));

            // Datos
            section.data.forEach(row => {
                const values = Object.values(row).map(v => {
                    if (v === null || v === undefined) return '';
                    let text = String(v).trim();
                    text = text.replace(/"/g, '""');
                    if (text.includes(',') || text.includes('\n')) {
                        text = `"${text}"`;
                    }
                    return text;
                });
                csv.push(values.join(','));
            });
        });

        this.downloadCSV(csv.join('\n'), filename);
    }

    /**
     * Generar reporte con KPIs
     * @param {Object} kpis - Objeto con KPIs
     * @param {string} title - Título del reporte
     * @param {string} filename - Nombre del archivo
     */
    static exportReportWithKPIs(kpis, title, filename) {
        let csv = [];

        csv.push(title.toUpperCase());
        csv.push(`Generado: ${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString('es-AR')}`);
        csv.push('');

        csv.push('INDICADORES CLAVE DE DESEMPEÑO (KPIs)');
        csv.push('');

        Object.entries(kpis).forEach(([key, value]) => {
            csv.push(`"${key}","${value}"`);
        });

        this.downloadCSV(csv.join('\n'), filename);
    }

    /**
     * Copiar tabla a portapapeles
     * @param {string} tableSelector - Selector CSS de la tabla
     */
    static copyTableToClipboard(tableSelector) {
        const table = document.querySelector(tableSelector);
        if (!table) {
            console.error('Tabla no encontrada:', tableSelector);
            return false;
        }

        const range = document.createRange();
        range.selectNodeContents(table);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        try {
            document.execCommand('copy');
            console.log('Tabla copiada al portapapeles');
            return true;
        } catch (err) {
            console.error('Error al copiar:', err);
            return false;
        }
    }

    /**
     * Imprimir tabla
     * @param {string} tableSelector - Selector CSS de la tabla
     * @param {string} title - Título para la impresión
     */
    static printTable(tableSelector, title = 'Reporte') {
        const table = document.querySelector(tableSelector);
        if (!table) {
            console.error('Tabla no encontrada:', tableSelector);
            return;
        }

        const printWindow = window.open('', '', 'height=600,width=800');
        printWindow.document.write('<html><head><title>' + title + '</title>');
        printWindow.document.write('<style>');
        printWindow.document.write('body { font-family: Arial, sans-serif; }');
        printWindow.document.write('table { border-collapse: collapse; width: 100%; }');
        printWindow.document.write('th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }');
        printWindow.document.write('th { background-color: #4CAF50; color: white; }');
        printWindow.document.write('h1 { text-align: center; }');
        printWindow.document.write('</style></head><body>');
        printWindow.document.write('<h1>' + title + '</h1>');
        printWindow.document.write(table.outerHTML);
        printWindow.document.write('</body></html>');
        printWindow.document.close();
        printWindow.print();
    }

    /**
     * Formatear número como moneda
     * @param {number} value - Valor a formatear
     * @param {string} locale - Locale (ej: 'es-AR')
     * @param {string} currency - Código de moneda (ej: 'ARS')
     * @returns {string} Valor formateado
     */
    static formatCurrency(value, locale = 'es-AR', currency = 'ARS') {
        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: currency
        }).format(value);
    }

    /**
     * Formatear número con separadores
     * @param {number} value - Valor a formatear
     * @param {number} decimals - Cantidad de decimales
     * @returns {string} Valor formateado
     */
    static formatNumber(value, decimals = 2) {
        return parseFloat(value).toLocaleString('es-AR', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    /**
     * Formatear fecha
     * @param {Date|string} date - Fecha a formatear
     * @param {string} locale - Locale
     * @returns {string} Fecha formateada
     */
    static formatDate(date, locale = 'es-AR') {
        const d = new Date(date);
        return d.toLocaleDateString(locale);
    }

    /**
     * Crear resumen ejecutivo
     * @param {Object} summary - Objeto con datos del resumen
     * @param {string} filename - Nombre del archivo
     */
    static exportExecutiveSummary(summary, filename) {
        let csv = [];

        csv.push('RESUMEN EJECUTIVO');
        csv.push(`Período: ${summary.periodo || 'N/A'}`);
        csv.push(`Generado: ${new Date().toLocaleDateString('es-AR')}`);
        csv.push('');

        csv.push('MÉTRICAS PRINCIPALES');
        csv.push('');

        if (summary.metrics) {
            Object.entries(summary.metrics).forEach(([key, value]) => {
                csv.push(`"${key}","${value}"`);
            });
        }

        csv.push('');
        csv.push('ANÁLISIS');
        csv.push('');

        if (summary.analysis) {
            summary.analysis.forEach(line => {
                csv.push(`"${line}"`);
            });
        }

        csv.push('');
        csv.push('RECOMENDACIONES');
        csv.push('');

        if (summary.recommendations) {
            summary.recommendations.forEach(rec => {
                csv.push(`"${rec}"`);
            });
        }

        this.downloadCSV(csv.join('\n'), filename);
    }
}

// Exportar para uso global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExportUtils;
}
