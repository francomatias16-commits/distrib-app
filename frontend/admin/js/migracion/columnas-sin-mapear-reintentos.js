// frontend/admin/js/migracion/columnas-sin-mapear-reintentos.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Columnas sin destino, confirmar sesión, reintentar fallidas, deshacer sesión.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ─── Corrección punto 1: columnas del archivo sin destino en el sistema ──────
// El mapeo (paso 2) solo pide llenar los campos que el sistema entiende — una
// columna del archivo que nadie eligió como origen de ningún campo queda
// "suelta". Los datos en sí no se pierden (siguen en
// migracion_staging_rows.datos_originales), pero hasta ahora no había ninguna
// pantalla que lo mostrara. `columnasDetectadas` son todas las columnas que
// trajo el archivo; `mapeoColumnas` es field→columna elegida en el mapeo. Lo
// que no aparece como VALOR de ese mapeo es lo que quedó sin usar.
function calcularColumnasSinMapear(columnasDetectadas, mapeoColumnas) {
  if (!Array.isArray(columnasDetectadas) || !columnasDetectadas.length) return [];
  const usadas = new Set(Object.values(mapeoColumnas || {}));
  return columnasDetectadas.filter(col => !usadas.has(col));
}

// REQ-MIG-EXTRAS: renderColumnasSinMapear mejorado — muestra columnas sin
// destino con su muestra de datos (si `muestras` está disponible). La función
// acepta un tercer argumento opcional `muestras` que es un objeto
// { columna: [val1, val2, val3] } con hasta 3 valores de ejemplo por columna.
// Cuando `muestras` está presente las columnas se muestran en tabla; si no,
// vuelve al comportamiento original de lista plana (retrocompatible).
function renderColumnasSinMapear(contenedorId, columnas, nombreArchivoBase, muestras) {
  const cont = document.getElementById(contenedorId);
  if (!cont) return;

  if (!columnas.length) {
    cont.innerHTML = '<p class="mig-sin-mapear-ok">Todas las columnas del archivo se usaron en algún campo del sistema. No quedan datos extra sin destino.</p>';
    return;
  }

  const tieneMuestras = muestras && typeof muestras === 'object' && Object.keys(muestras).length > 0;

  let contenido;
  if (tieneMuestras) {
    // Con muestras: tabla con columna + ejemplos de valores
    const filas = columnas.map(c => {
      const vals = (muestras[c] || []).filter(v => v !== '' && v != null).slice(0, 3);
      const ejemplos = vals.length
        ? vals.map(v => `<code>${escapeHtml(String(v))}</code>`).join(', ')
        : '<em style="color:var(--color-text-muted)">sin datos</em>';
      return `<tr>
        <td style="padding:6px 10px;font-weight:600;">${escapeHtml(c)}</td>
        <td style="padding:6px 10px;">${ejemplos}</td>
      </tr>`;
    }).join('');

    contenido = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:10px 0;">
        <thead>
          <tr style="border-bottom:2px solid var(--color-border);">
            <th style="text-align:left;padding:6px 10px;font-size:12px;font-weight:700;color:var(--color-text-muted);">Columna del archivo</th>
            <th style="text-align:left;padding:6px 10px;font-size:12px;font-weight:700;color:var(--color-text-muted);">Ejemplos de valores</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    `;
  } else {
    // Sin muestras: lista plana (comportamiento original)
    const lista = columnas.map(c => `<li>${escapeHtml(c)}</li>`).join('');
    contenido = `<ul>${lista}</ul>`;
  }

  const colN = columnas.length;
  // FIX XSS: NO usar inline onclick con datos dinámicos. El botón se crea con
  // createElement + addEventListener para evitar inyección si los nombres de
  // columna contienen comillas u otros caracteres especiales.
  const wrapper = document.createElement('div');
  wrapper.className = 'mig-sin-mapear';

  const titulo = document.createElement('strong');
  titulo.textContent = `${colN} columna${colN === 1 ? '' : 's'} del archivo no se usó${colN === 1 ? '' : 'aron'} en ningún campo del sistema (datos extra sin destino):`;
  wrapper.appendChild(titulo);

  // Insertar el contenido de columnas (HTML pre-escapado por escapeHtml arriba)
  const contenidoEl = document.createElement('div');
  contenidoEl.innerHTML = contenido;
  wrapper.appendChild(contenidoEl);

  const nota = document.createElement('p');
  nota.className = 'mig-sin-mapear-nota';
  nota.textContent = 'Esos datos quedan guardados en el sistema vinculados al registro migrado y son visibles en la ficha de cada registro (badge "Importado por migración"). No son operativos — no modifican cálculos ni aparecen en reportes. Podés exportarlos para revisarlos a mano si los necesitás.';
  wrapper.appendChild(nota);

  const btnExportar = document.createElement('button');
  btnExportar.type = 'button';
  btnExportar.className = 'btn btn--ghost btn--sm';
  btnExportar.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Exportar columnas sin usar (CSV)';
  // Captura de cierre: `columnas` y `nombreArchivoBase` en scope, sin interpolación de HTML.
  const _colsSnapshot = columnas.slice();
  const _baseSnapshot = nombreArchivoBase || 'sin_mapear';
  btnExportar.addEventListener('click', () => {
    descargarColumnasSinMapearCSV(_colsSnapshot, _baseSnapshot);
  });
  wrapper.appendChild(btnExportar);

  cont.innerHTML = '';
  cont.appendChild(wrapper);
}

function descargarColumnasSinMapearCSV(columnas, nombreBase) {
  const contenido = 'Columna del archivo original sin campo de destino\n' +
    columnas.map(c => `"${String(c).replace(/"/g, '""')}"`).join('\n');
  const blob = new Blob(['\uFEFF' + contenido], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nombreBase}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Versión para el historial: la sesión ya no está en `estado` (puede ser
// cualquier fila del historial, no la que está abierta en el wizard), así que
// se trae de nuevo del server. `migracion_sesiones` guarda columnas_detectadas
// y mapeo_columnas ya persistidos desde el paso de mapeo (ver
// prepararPasadaDeMapeo en el backend), así que no hace falta re-mapear nada.
async function verColumnasSinMapearHistorial(sesionId, btn) {
  const panelId = `sin-mapear-hist-${sesionId}`;
  const existente = document.getElementById(panelId);
  if (existente) {
    existente.remove();
    btn.textContent = 'Ver columnas sin usar';
    return;
  }

  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = 'Cargando...';

  try {
    const data = await migApi(`/api/migracion?sesion_id=${sesionId}&limit=1`);
    const sesion = data.sesion || {};
    const columnasSinMapear = calcularColumnasSinMapear(sesion.columnas_detectadas, sesion.mapeo_columnas);

    const fila = btn.closest('.mig-sesion-row');
    const panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'mig-sin-mapear-panel';
    fila.insertAdjacentElement('afterend', panel);
    renderColumnasSinMapear(panelId, columnasSinMapear, `sin_mapear_${sesion.entidad || 'sesion'}_${sesionId}`);

    btn.textContent = 'Ocultar columnas sin usar';
  } catch (err) {
    console.error('[migracion] cargar detalle de columnas:', err);
    window.toast?.('No se pudo cargar el detalle de columnas', 'error');
    btn.textContent = textoOriginal;
  } finally {
    btn.disabled = false;
  }
}

// Punto 6: si quedaron filas con error tras confirmar, mostramos un botón
// para reintentar solo esas — sin tener que armar un archivo nuevo a mano.
function actualizarBotonReintentar() {
  const btn = document.getElementById('btn-reintentar');
  if (!btn) return;
  if (estado.ultimoErrores > 0) {
    btn.style.display = '';
    btn.disabled = false;
    btn.textContent = `Reintentar ${estado.ultimoErrores} fila${estado.ultimoErrores === 1 ? '' : 's'} con error`;
  } else {
    btn.style.display = 'none';
  }
}

async function confirmarSesion() {
  const btn = document.getElementById('btn-confirmar');
  const progreso = document.getElementById('confirmar-progreso');
  const progresoTexto = document.getElementById('confirmar-progreso-texto');
  const progresoBarra = document.getElementById('confirmar-progreso-barra-fill');
  const totalAImportar = estado.resumen?.filas_validas || 0;
  btn.disabled = true;
  progreso.style.display = 'block';
  if (progresoBarra) progresoBarra.style.width = '0%';

  try {
    const { r, advertencias } = await ejecutarLoteConfirmacion((r, hayMas) => {
      if (progresoTexto) {
        progresoTexto.textContent = `Importando… ${r.creados ?? 0} creados, ${r.actualizados ?? 0} actualizados` +
          (r.errores ? `, ${r.errores} con error` : '') + (hayMas ? ' (continúa)' : '');
      }
      if (progresoBarra) {
        // resultado.creados/actualizados/errores es acumulado real sobre
        // toda la sesión (no solo el lote), así que este % es exacto.
        const procesadas = (r.creados || 0) + (r.actualizados || 0) + (r.errores || 0);
        const pct = totalAImportar ? Math.max(0, Math.min(100, (procesadas / totalAImportar) * 100)) : (hayMas ? 0 : 100);
        progresoBarra.style.width = `${pct}%`;
      }
    });

    mostrarResultado(r, advertencias);
    mostrarPaso('paso-resultado');
  } catch (err) {
    console.error('[migracion] confirmar importación:', err);
    // FIX (auditoría UX etapa 18, Hallazgo 2): si ya se guardó algo antes
    // del corte, avisar que la importación es resumible en vez de sugerir
    // que no pasó nada.
    const parcial = err.progresoParcial;
    const msg = parcial && (parcial.creados || parcial.actualizados)
      ? `Se cortó la conexión, pero ya se guardaron ${parcial.creados ?? 0} creados y ${parcial.actualizados ?? 0} actualizados. Volvé a apretar "Confirmar" para continuar desde ahí.`
      : 'No se pudo confirmar la importación. Volvé a intentar.';
    window.toast?.(msg, 'warning');
    btn.disabled = false;
  } finally {
    progreso.style.display = 'none';
  }
}

// Reabre la sesión (vía accion=reintentar, que limpia error_ejecucion solo
// en las filas que fallaron) y vuelve a correr el mismo loop de confirmación.
// Si el error era por un dato malo en la fila, va a volver a fallar igual —
// para eso primero hay que corregir la fila desde "Revisar".
async function reintentarFallidas() {
  const btn = document.getElementById('btn-reintentar');
  const progreso = document.getElementById('reintentar-progreso');
  btn.disabled = true;
  if (progreso) {
    progreso.style.display = 'block';
    progreso.textContent = 'Reintentando filas con error...';
  }

  try {
    await migApi('/api/migracion?accion=reintentar', {
      method: 'POST',
      body: JSON.stringify({ sesion_id: estado.sesionId }),
    });

    const { r, advertencias } = await ejecutarLoteConfirmacion((r, hayMas) => {
      if (progreso) {
        progreso.textContent = `Reintentando… ${r.creados ?? 0} creados, ${r.actualizados ?? 0} actualizados` +
          (r.errores ? `, ${r.errores} con error` : '') + (hayMas ? ' (continúa)' : '');
      }
    });

    mostrarResultado(r, advertencias);
  } catch (err) {
    console.error('[migracion] reintentar importación:', err);
    const parcial = err.progresoParcial;
    const msg = parcial && (parcial.creados || parcial.actualizados)
      ? `Se cortó la conexión, pero ya se guardaron ${parcial.creados ?? 0} creados y ${parcial.actualizados ?? 0} actualizados. Volvé a apretar "Reintentar" para continuar desde ahí.`
      : 'No se pudo reintentar la importación. Volvé a intentar.';
    window.toast?.(msg, 'warning');
    btn.disabled = false;
  } finally {
    if (progreso) progreso.style.display = 'none';
  }
}

// ─── Deshacer una sesión "completado" desde el historial (migración 161) ──────
// Mismo patrón de loop por lotes que ejecutarLoteConfirmacion, pero invocado
// directamente desde la fila del historial (no depende del `estado` global del
// wizard, porque la sesión a deshacer puede no ser la que está abierta).
// Alcance real (avisado explícitamente al usuario antes de confirmar): solo
// elimina lo que la importación CREÓ. Las filas que actualizaron un registro
// existente no se revierten — eso lo hace la función SQL, acá solo se informa.
async function deshacerSesionHistorial(sesionId, btn) {
  const ok = await window.confirmar(
    'Esto va a <strong>eliminar los registros que esta importación creó</strong>.<br><br>' +
    'Las filas que actualizaron un registro ya existente <strong>no se revierten' +
    ' automáticamente</strong> (quedan como estaban después de la importación) — si alguna ' +
    'te importa, revisala a mano antes de seguir.<br><br>Esta acción no se puede deshacer.',
    { labelOk: 'Sí, deshacer', tipo: 'danger' }
  );
  if (!ok) return;

  btn.disabled = true;
  const textoOriginal = btn.textContent;

  try {
    let r = {}, hayMas = true, vueltas = 0, aviso = null;

    while (hayMas) {
      vueltas++;
      const data = await migApi('/api/migracion?accion=deshacer', {
        method: 'POST',
        body: JSON.stringify({ sesion_id: sesionId }),
      });
      r = data.resultado || {};
      hayMas = !!data.hay_mas;
      if (data.aviso) aviso = data.aviso;
      btn.textContent = `Deshaciendo… ${r.eliminados ?? 0} eliminados` + (hayMas ? ' (continúa)' : '');

      // Salvaguarda: igual que en confirmar, no hacer loop infinito si algo
      // queda trabado sin avanzar nunca.
      if (vueltas > 500) throw new Error('No terminó luego de muchos lotes; revisá la sesión.');
    }

    const partes = [`${r.eliminados ?? 0} registro(s) eliminado(s)`];
    if (r.no_revertibles) partes.push(`${r.no_revertibles} actualización(es) sin revertir`);
    if (r.omitidos) partes.push(`${r.omitidos} omitido(s) (tenían datos relacionados)`);

    window.toast?.(
      `Migración deshecha: ${partes.join(', ')}.`,
      (r.omitidos || r.no_revertibles) ? 'warning' : 'success'
    );
    if (aviso) window.toast?.(aviso, 'warning');
  } catch (err) {
    console.error('[migracion] deshacer migración:', err);
    window.toast?.('No se pudo deshacer la migración', 'error');
    btn.disabled = false;
    btn.textContent = textoOriginal;
    return;
  }

  cargarSesionesRecientes(paginaHistorialSesiones);
}

