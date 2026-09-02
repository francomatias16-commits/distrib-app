// frontend/admin/js/migracion/revision-filas.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Paso 3: revisión de filas + descarga de filas con error.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ─── Paso 3: revisión ─────────────────────────────────────────────────────────
async function cargarFilasRevision() {
  const data = await migApi(`/api/migracion?sesion_id=${estado.sesionId}&limit=500`);
  estado.filasRevision = data.filas || [];
  estado.paginaFilas = 1;

  document.getElementById('resumen-validas').textContent = estado.resumen.filas_validas;
  document.getElementById('resumen-errores').textContent = estado.resumen.filas_con_error;
  document.getElementById('resumen-total').textContent = estado.resumen.total_filas;

  const aviso = document.getElementById('confirmar-aviso');
  const btnConfirmar = document.getElementById('btn-confirmar');
  const btnDescargarErrores = document.getElementById('btn-descargar-errores');
  if (btnDescargarErrores) btnDescargarErrores.style.display = estado.resumen.filas_con_error > 0 ? '' : 'none';
  if (estado.resumen.filas_validas === 0) {
    aviso.textContent = 'No hay filas válidas para importar.';
    btnConfirmar.disabled = true;
  } else if (estado.resumen.filas_con_error > 0) {
    aviso.textContent = `Se van a importar ${estado.resumen.filas_validas} filas. Las ${estado.resumen.filas_con_error} con error se omiten.`;
    btnConfirmar.disabled = false;
  } else {
    aviso.textContent = `Se van a importar las ${estado.resumen.filas_validas} filas.`;
    btnConfirmar.disabled = false;
  }

  renderResumenMapeo(estado.resumen.resumen_mapeo);
  renderTablaFilas();

  // Punto 11 del audit: precheck no bloqueante (razones sociales parecidas,
  // vendedores no resueltos, precios por debajo de costo, etc.). Si falla
  // por lo que sea, no interrumpe el flujo — el precheck es informativo,
  // nunca fue requisito para poder confirmar.
  await mostrarPrecheck();
}

async function mostrarPrecheck() {
  const cont = document.getElementById('precheck-advertencias');
  if (!cont) return;
  cont.innerHTML = '';
  try {
    const data = await migApi('/api/migracion?accion=precheck', {
      method: 'POST',
      body: JSON.stringify({ sesion_id: estado.sesionId }),
    });
    const advertencias = data.advertencias || [];
    if (!advertencias.length) return;
    const lista = advertencias.slice(0, 20)
      .map(a => `${a.fila_numero ? `Fila ${a.fila_numero}: ` : ''}${escapeHtml(a.mensaje ?? '')}`)
      .join('<br>');
    const extra = advertencias.length > 20 ? `<br>… y ${advertencias.length - 20} más.` : '';
    cont.innerHTML = `<div class="mig-advertencias"><strong>${advertencias.length} advertencia(s) antes de confirmar:</strong><br>${lista}${extra}</div>`;
  } catch {
    // Silencioso: el precheck es una ayuda, no un requisito para confirmar.
  }
}

// Item 2 del plan P0: resumen ejecutivo del mapeo (cuántas se crean/actualizan
// + los errores más frecuentes), para no depender de scrollear la tabla fila
// por fila en archivos grandes. cta_cte además trae el monto total agregado,
// que es la señal más rápida para detectar "subí el archivo mal".
function renderResumenMapeo(resumen) {
  const cont = document.getElementById('resumen-mapeo-detalle');
  if (!cont) return;
  if (!resumen) { cont.innerHTML = ''; cont.style.display = 'none'; return; }

  const crear = resumen.por_accion?.crear || 0;
  const actualizar = resumen.por_accion?.actualizar || 0;

  const partesAccion = [];
  if (crear) partesAccion.push(`<strong>${crear}</strong> nueva${crear === 1 ? '' : 's'}`);
  if (actualizar) partesAccion.push(`<strong>${actualizar}</strong> actualiza${actualizar === 1 ? 'ción' : 'ciones'}`);

  const bloqueMonto = typeof resumen.monto_total_valido === 'number'
    ? `<p class="mig-destinos-nota">Monto total de las filas válidas: <strong>${resumen.monto_total_valido.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' })}</strong></p>`
    : '';

  const bloqueErrores = resumen.top_errores?.length ? `
    <p class="mig-destinos-titulo" style="margin-top:12px;">Errores más frecuentes</p>
    <ul style="margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--color-text-secondary);">
      ${resumen.top_errores.map(e => `<li>${escapeHtml(e.mensaje)} <span style="opacity:.7;">(${e.cantidad} fila${e.cantidad === 1 ? '' : 's'})</span></li>`).join('')}
    </ul>` : '';

  cont.style.display = '';
  cont.innerHTML = `
    ${partesAccion.length ? `<p class="mig-destinos-nota">${partesAccion.join(' y ')}.</p>` : ''}
    ${bloqueMonto}
    ${bloqueErrores}
  `;
}

function filtrarFilas(filtro, btn) {
  estado.filtroActual = filtro;
  estado.paginaFilas = 1;
  document.querySelectorAll('.mig-filtro-filas .e-pill').forEach(b => b.classList.remove('activa'));
  btn.classList.add('activa');
  renderTablaFilas();
}

// Filas por página de la tabla de revisión (client-side: ya tenemos hasta
// 500 filas cargadas en memoria por cargarFilasRevision, así que paginar acá
// es solo una cuestión de no renderizar las 500 en el DOM de una — con
// archivos grandes eso hacía que la pantalla quedara con un scroll
// interminable y se sintiera pesada para tipear/scrollear).
const FILAS_POR_PAGINA = 50;

function renderTablaFilas() {
  const campos = estado.camposDisponibles;
  const thead = document.getElementById('filas-thead');
  thead.innerHTML = `<tr><th>#</th><th>Acción</th>${campos.map(c => `<th>${ETIQUETAS_CAMPO[c] || c}</th>`).join('')}<th>Errores</th></tr>`;

  let filas = estado.filasRevision;
  if (estado.filtroActual === 'error') filas = filas.filter(f => !f.es_valida);

  const tbody = document.getElementById('filas-tbody');
  if (!filas.length) {
    tbody.innerHTML = `<tr><td colspan="${campos.length + 3}" class="mig-vacio-celda">No hay filas para mostrar.</td></tr>`;
    document.getElementById('filas-paginacion').style.display = 'none';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(filas.length / FILAS_POR_PAGINA));
  if (!estado.paginaFilas || estado.paginaFilas > totalPaginas) estado.paginaFilas = 1;
  const inicio = (estado.paginaFilas - 1) * FILAS_POR_PAGINA;
  const filasPagina = filas.slice(inicio, inicio + FILAS_POR_PAGINA);

  tbody.innerHTML = filasPagina.map(f => `
    <tr class="${f.es_valida ? '' : 'fila-error'}">
      <td>${f.es_valida ? f.fila_numero : `<span class="mig-fila-num-error" title="Esta fila no se va a importar">⚠ ${f.fila_numero}</span>`}</td>
      <td>
        <select onchange="cambiarAccionFila('${f.id}', this.value)" ${!f.es_valida ? 'disabled' : ''}>
          <option value="crear" ${f.accion === 'crear' ? 'selected' : ''}>Crear</option>
          <option value="actualizar" ${f.accion === 'actualizar' ? 'selected' : ''} ${!f.entidad_existente_id ? 'disabled' : ''}>Actualizar existente</option>
          <option value="omitir" ${f.accion === 'omitir' ? 'selected' : ''}>Omitir</option>
        </select>
      </td>
      ${campos.map(c => `<td>${escapeHtml(f.datos_mapeados?.[c] ?? '')}</td>`).join('')}
      <td class="mig-celda-errores">${(f.errores || []).map(e => escapeHtml(e)).join('; ')}</td>
    </tr>
  `).join('');

  renderPaginacionFilas(filas.length, totalPaginas);
}

function renderPaginacionFilas(totalFilas, totalPaginas) {
  const cont = document.getElementById('filas-paginacion');
  if (!cont) return;
  if (totalPaginas <= 1) { cont.style.display = 'none'; return; }

  const pagina = estado.paginaFilas;
  const inicio = (pagina - 1) * FILAS_POR_PAGINA + 1;
  const fin = Math.min(pagina * FILAS_POR_PAGINA, totalFilas);

  // Ventana acotada de números de página (máx. 7) para no listar cientos de
  // botones con archivos grandes — igual criterio que cualquier paginador
  // clásico: siempre primera, última, la actual, y un par a cada lado.
  const numeros = [];
  const rango = 1;
  for (let p = 1; p <= totalPaginas; p++) {
    if (p === 1 || p === totalPaginas || (p >= pagina - rango && p <= pagina + rango)) numeros.push(p);
    else if (numeros[numeros.length - 1] !== '…') numeros.push('…');
  }

  cont.style.display = 'flex';
  cont.innerHTML = `
    <span class="mig-paginacion-info">${inicio.toLocaleString('es-AR')}–${fin.toLocaleString('es-AR')} de ${totalFilas.toLocaleString('es-AR')}</span>
    <div class="mig-paginacion-botones">
      <button type="button" class="btn btn--secondary btn--sm" ${pagina === 1 ? 'disabled' : ''} onclick="cambiarPaginaFilas(${pagina - 1})">Anterior</button>
      ${numeros.map(p => p === '…'
        ? `<span class="mig-paginacion-elipsis">…</span>`
        : `<button type="button" class="mig-paginacion-num ${p === pagina ? 'activa' : ''}" onclick="cambiarPaginaFilas(${p})">${p}</button>`
      ).join('')}
      <button type="button" class="btn btn--secondary btn--sm" ${pagina === totalPaginas ? 'disabled' : ''} onclick="cambiarPaginaFilas(${pagina + 1})">Siguiente</button>
    </div>`;
}

function cambiarPaginaFilas(pagina) {
  estado.paginaFilas = pagina;
  renderTablaFilas();
  document.querySelector('.mig-tabla-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Descargar filas con error (Excel) ───────────────────────────────────────
// La tabla de revisión solo muestra un preview acotado (limit=500), así que
// para armar el archivo de descarga hay que traer TODAS las filas con error
// de la sesión, paginando con offset (ver obtenerSesion en el backend,
// solo_errores=true). Objetivo: que la persona corrija estas filas afuera (en
// el mismo Excel del que salieron) y suba de nuevo solo esas, en vez de tener
// que revisarlas una por una en la tabla o resubir el archivo entero.
async function obtenerTodasLasFilasConError() {
  const LIMITE_PAGINA = 2000;
  let offset = 0;
  let todas = [];
  while (true) {
    const data = await migApi(`/api/migracion?sesion_id=${estado.sesionId}&limit=${LIMITE_PAGINA}&offset=${offset}&solo_errores=true`);
    const pagina = data.filas || [];
    todas = todas.concat(pagina);
    if (pagina.length < LIMITE_PAGINA) break;
    offset += LIMITE_PAGINA;
  }
  return todas;
}

async function descargarErrores() {
  const btn = document.getElementById('btn-descargar-errores');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparando archivo...';

  try {
    if (!window.XLSX) throw new Error('SheetJS no disponible');
    const filas = await obtenerTodasLasFilasConError();
    if (!filas.length) {
      window.toast?.('No hay filas con error para descargar', 'info');
      return;
    }

    // Mismas columnas que la tabla de revisión (campos mapeados), más el
    // número de fila original y el detalle del error — así la persona puede
    // ubicar la fila en su archivo original y ver exactamente qué corregir.
    const campos = estado.camposDisponibles;
    const encabezados = ['Fila', ...campos.map(c => ETIQUETAS_CAMPO[c] || c), 'Errores'];
    const filasHoja = filas.map(f => [
      f.fila_numero,
      ...campos.map(c => f.datos_mapeados?.[c] ?? ''),
      (f.errores || []).join('; '),
    ]);

    const hoja = window.XLSX.utils.aoa_to_sheet([encabezados, ...filasSeguras(filasHoja)]);
    const libro = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(libro, hoja, 'Errores');

    const nombreArchivo = `errores_${estado.entidad}_${estado.sesionId.slice(0, 8)}.xlsx`;
    window.XLSX.writeFile(libro, nombreArchivo);
  } catch (err) {
    console.error('[migracion] generar archivo de errores:', err);
    window.toast?.('No se pudo generar el archivo de errores', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

async function cambiarAccionFila(filaId, nuevaAccion) {
  try {
    await migApi('/api/migracion?accion=fila', {
      method: 'PATCH',
      body: JSON.stringify({ fila_id: filaId, accion: nuevaAccion }),
    });
    const fila = estado.filasRevision.find(f => f.id === filaId);
    if (fila) fila.accion = nuevaAccion;
  } catch (err) {
    console.error('[migracion] actualizar fila:', err);
    window.toast?.('No se pudo actualizar la fila', 'error');
    renderTablaFilas();
  }
}

