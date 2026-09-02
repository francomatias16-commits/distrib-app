// frontend/admin/js/clientes/exportar-excel.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo } from './_estado.js';

// ── REQ-08: Exportar clientes a Excel ────────────────────────────────────
export async function exportarExcel() {
  const btn = document.getElementById('btn-exportar-excel-clientes');
  const btnHtmlOriginal = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Generando…'; }
  window.toast?.('Preparando exportación…');
  try {

    // Traer TODOS los clientes con filtros activos (sin paginación)
    const busq      = document.getElementById('input-busqueda').value.trim();
    const zonaFiltro = document.getElementById('filtro-zona').value;

    let query = estadoModulo.sb.from('clientes')
      .select('razon_social, nombre_fantasia, cuit, email, telefono, direccion, zona_id, zonas(nombre), saldo_deuda, limite_credito, condicion_iva, activo')
      .eq('empresa_id', estadoModulo.empresaData.id)
      .order('razon_social');

    if (zonaFiltro) query = query.eq('zona_id', zonaFiltro);
    if (estadoModulo.filtroEstado === 'activo')    query = query.eq('activo', true);
    if (estadoModulo.filtroEstado === 'inactivo')  query = query.eq('activo', false);
    if (estadoModulo.filtroEstado === 'deuda')     query = query.gt('saldo_deuda', 0);
    if (estadoModulo.filtroEstado === 'riesgo')    query = query.in('score_categoria', ['riesgo', 'bloqueado']);
    if (estadoModulo.filtroEstado === 'premium')   query = query.eq('score_categoria', 'premium');
    if (estadoModulo.filtroEstado === 'bueno')     query = query.eq('score_categoria', 'bueno');
    if (estadoModulo.filtroEstado === 'bloqueado') query = query.eq('score_categoria', 'bloqueado');
    if (busq) query = query.or(`razon_social.ilike.%${busq}%,nombre_fantasia.ilike.%${busq}%,cuit.ilike.%${busq}%`);

    const { data, error } = await window.conTimeoutRed(query, 10000);
    if (error) throw error;

    const fecha = new Date().toISOString().slice(0, 10);

    if (typeof XLSX !== 'undefined') {
      const rows = [['Razón Social','Nombre Fantasia','CUIT','Email','Teléfono','Dirección','Zona','Saldo Deuda','Límite Crédito','Condición IVA','Estado']];
      (data || []).forEach(c => {
        rows.push([
          c.razon_social || '',
          c.nombre_fantasia || '',
          c.cuit || '',
          c.email || '',
          c.telefono || '',
          c.direccion || '',
          c.zonas?.nombre || '',
          Number(c.saldo_deuda || 0),
          Number(c.limite_credito || 0),
          c.condicion_iva || '',
          c.activo ? 'Activo' : 'Inactivo',
        ]);
      });
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(rows);
      // Ancho de columnas
      ws['!cols'] = [30,25,16,28,16,35,18,16,16,20,10].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
      XLSX.writeFile(wb, `clientes-${fecha}.xlsx`);
      window.toast(`${(data||[]).length} clientes exportados`);
    } else {
      // Fallback CSV
      let csv = 'Razón Social,Nombre Fantasia,CUIT,Email,Teléfono,Dirección,Zona,Saldo Deuda,Límite Crédito,Condición IVA,Estado\n';
      (data || []).forEach(c => {
        csv += [c.razon_social,c.nombre_fantasia,c.cuit,c.email,c.telefono,c.direccion,c.zonas?.nombre,c.saldo_deuda||0,c.limite_credito||0,c.condicion_iva,c.activo?'Activo':'Inactivo']
          .map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',') + '\n';
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `clientes-${fecha}.csv`;
      a.click();
      window.toast(`${(data||[]).length} clientes exportados (CSV)`);
    }
  } catch (err) {
    console.error('Error exportando clientes:', err);
    window.toast('Error al exportar', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btnHtmlOriginal; }
  }
}
