// frontend/admin/js/migracion/utils-superadmin-init.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Utils, panel superadmin (todos los tenants) e inicialización.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ─── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

// Vulnerabilidad de "auditoría de mil escenarios": los Excel que generamos
// (informe de migración, errores para corregir) reescriben valores que
// vienen del archivo ORIGINAL que subió la persona — nombre, notas, tipo,
// mensajes de error que citan esos valores, etc. Si una celda del archivo
// original arranca con =, +, -, @, TAB o CR, Excel/Sheets la interpreta como
// fórmula al abrir el .xlsx que nosotros generamos (CSV/XLSX Formula
// Injection, CWE-1236) — puede ejecutar =HYPERLINK(...), tirar de una URL
// externa, o encadenar con DDE. No es hipotético: el dato ya pasó por nuestro
// sistema como texto plano (nombre de cliente, notas, etc.), así que un
// archivo de origen hostil o simplemente mal tipeado (alguien escribe
// "-5% desc" en notas) alcanza para que el .xlsx de salida quede armado.
// Mitigación estándar (OWASP): si el valor empieza con uno de esos
// caracteres, se antepone un apóstrofo — Excel lo muestra tal cual, como
// texto, en vez de evaluarlo.
const PREFIJOS_FORMULA_PELIGROSOS = new Set(['=', '+', '-', '@', '\t', '\r']);
function celdaSegura(valor) {
  if (valor === null || valor === undefined) return valor;
  const s = String(valor);
  if (s.length && PREFIJOS_FORMULA_PELIGROSOS.has(s[0])) return `'${s}`;
  return valor;
}
// Aplica celdaSegura a cada valor de una matriz de filas (array de arrays),
// dejando encabezados/números intactos donde corresponda — se usa antes de
// aoa_to_sheet en cualquier exportación que incluya datos del archivo
// original o mensajes que los citen.
function filasSeguras(matriz) {
  return matriz.map(fila => fila.map(celdaSegura));
}

// ─── Superadmin: sesiones de todos los tenants ────────────────────────────────
const ESTADO_LBL_MIG = {
  error: 'Error', confirmando: 'Confirmando', mapeado: 'Mapeado', validado: 'Validado',
  subido: 'Subido', completado: 'Completado', cancelado: 'Cancelado',
  deshaciendo: 'Deshaciendo', deshecho: 'Deshecho',
};

async function cargarSuperadminMig() {
  const tbody = document.getElementById('tbody-superadmin-mig');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-text-light,#7A857E);">Cargando…</td></tr>';

  try {
    const sb = window.authCtx?.sb;
    const { data, error } = await window.conTimeoutRed(sb.rpc('migracion_superadmin_resumen'), 10000);
    if (error) throw error;

    const filas = data || [];
    if (!filas.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-text-light,#7A857E);">Todavía no importaste ningún archivo. Subí una planilla arriba para empezar.</td></tr>';
      return;
    }

    tbody.innerHTML = filas.map(f => {
      const esError = f.estado === 'error';
      const estadoStyle = esError ? 'color:var(--color-danger,#7A2820);font-weight:700;' : '';
      const fecha = f.created_at
        ? new Date(f.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '—';
      return `
        <tr style="border-bottom:1px solid var(--color-border-soft,#E7E9E4);">
          <td style="padding:8px 10px;">${escapeHtml(f.empresa_nombre || '—')}</td>
          <td style="padding:8px 10px;">${escapeHtml(f.entidad || '—')}</td>
          <td style="padding:8px 10px;${estadoStyle}">${escapeHtml(ESTADO_LBL_MIG[f.estado] || f.estado || '—')}</td>
          <td style="padding:8px 10px;text-align:left;">${f.total_filas ?? 0}</td>
          <td style="padding:8px 10px;text-align:left;color:var(--color-success,#487050);">${f.filas_validas ?? 0}</td>
          <td style="padding:8px 10px;text-align:left;${f.filas_con_error ? 'color:var(--color-danger,#7A2820);font-weight:700;' : ''}">${f.filas_con_error ?? 0}</td>
          <td style="padding:8px 10px;font-size:11px;color:var(--color-text-muted,#5B6660);">${fecha}</td>
        </tr>`;
    }).join('');
  } catch (e) {
    console.error('[migracion] render tabla:', e);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-danger,#7A2820);">No se pudo cargar la información.</td></tr>`;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  await window.authReady;
  document.getElementById('topbar-usuario').textContent = window.authCtx?.perfil?.nombre || '';
  await cargarSesionesRecientes();

  // Deep-link desde la alerta "Migración con filas pendientes de resolver"
  // de la campanita (handleAlertas, admin.js sección 3): antes el link
  // mandaba a la página genérica sin filtrar; ahora busca la fila puntual
  // en el historial recién cargado, la enfoca y la resalta un momento.
  const sesionIdParam = new URLSearchParams(location.search).get('sesion_id');
  if (sesionIdParam) {
    const fila = document.querySelector(`.mig-sesion-row[data-sesion-id="${sesionIdParam}"]`);
    if (fila) {
      fila.scrollIntoView({ behavior: 'smooth', block: 'center' });
      fila.style.outline = '2px solid var(--color-warning, #8A5F13)';
      fila.style.outlineOffset = '2px';
      fila.style.transition = 'outline-color 1.2s ease 1.5s';
      setTimeout(() => { fila.style.outlineColor = 'transparent'; }, 1600);
    }
  }

  // Si el usuario es superadmin, mostrar el panel de todos los tenants
  try {
    const sb = window.authCtx?.sb;
    const { data: esOwner } = await window.conTimeoutRed(sb.rpc('is_saas_owner'), 10000);
    if (esOwner === true) {
      const panel = document.getElementById('panel-superadmin-mig');
      if (panel) {
        panel.style.display = '';
        cargarSuperadminMig();
      }
    }
  } catch {
    // No es superadmin o la función no existe — ignorar silenciosamente
  }
})();
