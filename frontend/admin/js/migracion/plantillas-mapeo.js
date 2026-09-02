// frontend/admin/js/migracion/plantillas-mapeo.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Plantillas de mapeo guardadas + confirmar mapeo.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ─── Punto 9 del plan de migraciones: plantillas de mapeo guardadas ─────────
// Permite guardar el mapeo de columnas ya armado a mano como plantilla
// reutilizable (útil para exportaciones periódicas del sistema viejo que
// siempre traen las mismas columnas) y volver a aplicarlo con un clic la
// próxima vez, en vez de rehacer el mapeo completo cada vez.
async function renderPlantillasMapeo() {
  const cont = document.getElementById('mapeo-plantillas');
  if (!cont) return;
  try {
    const data = await migApi(`/api/migracion?accion=plantillas&entidad=${estado.entidad}`);
    estado.plantillasMapeo = data.plantillas || [];
  } catch (err) {
    estado.plantillasMapeo = [];
  }
  pintarPlantillasMapeo();
}

function pintarPlantillasMapeo() {
  const cont = document.getElementById('mapeo-plantillas');
  if (!cont) return;

  const hayPlantillas = estado.plantillasMapeo.length > 0;
  const opciones = estado.plantillasMapeo
    .map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`)
    .join('');

  cont.style.display = '';
  cont.innerHTML = `
    <h3 class="mig-destinos-titulo">Plantillas de mapeo guardadas</h3>
    <div class="mig-mapeo-row">
      <select id="select-plantilla-mapeo" ${hayPlantillas ? '' : 'disabled'} style="flex: 1;">
        <option value="">${hayPlantillas ? '— Elegí una plantilla —' : 'No tenés plantillas guardadas para esta entidad'}</option>
        ${opciones}
      </select>
      <button type="button" class="btn btn--secondary btn--sm" onclick="aplicarPlantillaMapeo()" ${hayPlantillas ? '' : 'disabled'}>Usar</button>
      <button type="button" id="btn-borrar-plantilla" class="btn btn--secondary btn--sm" onclick="borrarPlantillaMapeoSeleccionada()" ${hayPlantillas ? '' : 'disabled'}>Borrar</button>
    </div>
    <p class="mig-destinos-nota">
      <button type="button" id="btn-guardar-plantilla" class="btn btn--secondary btn--sm" onclick="guardarPlantillaMapeoActual()">Guardar el mapeo de abajo como plantilla nueva</button>
    </p>
  `;
}

// Aplica el mapeo guardado a los <select> ya renderizados por renderMapeo().
// Si una columna guardada ya no existe en este archivo (encabezados
// distintos), esa entrada de la plantilla se ignora en silencio — el resto
// del mapeo se aplica igual y la persona completa a mano lo que falte.
function aplicarPlantillaMapeo() {
  const sel = document.getElementById('select-plantilla-mapeo');
  const plantilla = estado.plantillasMapeo.find(p => p.id === sel.value);
  if (!plantilla) return;

  for (const [campo, columna] of Object.entries(plantilla.mapeo_columnas || {})) {
    const selCampo = document.getElementById(`map-${campo}`);
    if (selCampo && estado.columnasDetectadas.includes(columna)) selCampo.value = columna;
  }
  const selDep = document.getElementById('destino-deposito');
  if (selDep && plantilla.deposito_id) selDep.value = plantilla.deposito_id;
  const selLista = document.getElementById('destino-lista');
  if (selLista && plantilla.lista_precio_id) selLista.value = plantilla.lista_precio_id;

  window.toast?.(`Plantilla "${plantilla.nombre}" aplicada`, 'success');
}

async function guardarPlantillaMapeoActual() {
  const nombre = window.prompt('Nombre para esta plantilla de mapeo:');
  if (!nombre || !nombre.trim()) return;

  const mapeo = {};
  document.querySelectorAll('#mapeo-grid select').forEach(sel => {
    if (sel.value) mapeo[sel.dataset.campo] = sel.value;
  });
  if (!Object.keys(mapeo).length) {
    window.toast?.('Mapeá al menos una columna antes de guardar', 'error');
    return;
  }

  const selDep = document.getElementById('destino-deposito');
  const selLista = document.getElementById('destino-lista');

  const btn = document.getElementById('btn-guardar-plantilla');
  const textoOriginal = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  try {
    await migApi('/api/migracion?accion=guardar_plantilla', {
      method: 'POST',
      body: JSON.stringify({
        entidad: estado.entidad,
        nombre: nombre.trim(),
        mapeo_columnas: mapeo,
        deposito_id: selDep ? selDep.value : null,
        lista_precio_id: selLista ? selLista.value : null,
      }),
    });
    window.toast?.('Plantilla guardada', 'success');
    await renderPlantillasMapeo();
  } catch (err) {
    console.error('[migracion] guardar plantilla:', err);
    window.toast?.('No se pudo guardar la plantilla', 'error');
  } finally {
    // Si el guardado salió bien, renderPlantillasMapeo() ya reemplazó este
    // botón por uno nuevo (habilitado) al reescribir el innerHTML del
    // contenedor. Si falló, el botón original sigue en pie y hay que
    // reactivarlo acá.
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}

async function borrarPlantillaMapeoSeleccionada() {
  const sel = document.getElementById('select-plantilla-mapeo');
  const plantilla = estado.plantillasMapeo.find(p => p.id === sel?.value);
  if (!plantilla) return;
  const okBorrar = await window.confirmar(
    `¿Borrar la plantilla "${plantilla.nombre}"? Esta acción no se puede deshacer.`,
    { labelOk: 'Borrar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!okBorrar) return;

  const btn = document.getElementById('btn-borrar-plantilla');
  const textoOriginal = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Borrando...'; }

  try {
    await migApi(`/api/migracion?accion=plantilla&plantilla_id=${plantilla.id}`, { method: 'DELETE' });
    window.toast?.('Plantilla borrada', 'success');
    await renderPlantillasMapeo();
  } catch (err) {
    console.error('[migracion] borrar plantilla:', err);
    window.toast?.('No se pudo borrar la plantilla', 'error');
  } finally {
    // Mismo caso que en guardarPlantillaMapeoActual: si borró bien, el
    // render ya reemplazó el botón; si falló, lo reactivamos acá.
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}

async function confirmarMapeo() {
  const mapeo = {};
  document.querySelectorAll('#mapeo-grid select').forEach(sel => {
    if (sel.value) mapeo[sel.dataset.campo] = sel.value;
  });

  const faltantes = estado.camposRequeridos.filter(c => !mapeo[c]);
  if (faltantes.length) {
    window.toast?.(`Falta mapear: ${faltantes.map(c => ETIQUETAS_CAMPO[c] || c).join(', ')}`, 'error');
    return;
  }

  // Corrección punto 1: guardamos el mapeo que se va a confirmar para poder
  // calcular, en la pantalla de Resultado, qué columnas del archivo original
  // quedaron sin ningún campo de destino (no se pierden del todo — siguen en
  // migracion_staging_rows.datos_originales — pero antes no había ninguna
  // pantalla que avisara cuáles eran).
  estado.mapeoConfirmado = mapeo;

  const body = { sesion_id: estado.sesionId, mapeo_columnas: mapeo };
  const selDeposito = document.getElementById('destino-deposito');
  const selLista = document.getElementById('destino-lista');
  if (selDeposito) body.deposito_id = selDeposito.value;
  if (selLista) body.lista_precio_id = selLista.value;

  // Migración 167: el backend procesa un lote acotado por request (filas
  // mapeado_en IS NULL) y devuelve hay_mas=true mientras falten. Mismo
  // patrón de loop que ya usa ejecutarLoteConfirmacion — el body se manda
  // igual en cada vuelta (mapeo_columnas/destinos), el backend solo los usa
  // para arrancar la pasada (ver prepararPasadaDeMapeo) y los ignora en las
  // vueltas siguientes.
  const btn = document.getElementById('btn-mapear');
  const progreso = document.getElementById('mapeo-progreso');
  const progresoTexto = document.getElementById('mapeo-progreso-texto');
  const progresoBarra = document.getElementById('mapeo-progreso-barra-fill');
  const totalArchivo = estado.totalFilasArchivo || 0;
  btn.disabled = true;
  if (progreso) progreso.style.display = 'block';
  if (progresoBarra) progresoBarra.style.width = '0%';

  try {
    let data = {}, hayMas = true, vueltas = 0, procesadas = 0;
    while (hayMas) {
      vueltas++;
      data = await migApi('/api/migracion?accion=mapear', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      hayMas = !!data.hay_mas;
      // FIX: el backend no devuelve un contador acumulado en esta etapa
      // (solo filas_mapeadas_lote, del lote actual), así que sumamos lote a
      // lote contra el total ya conocido de la subida para estimar el %.
      procesadas = hayMas
        ? Math.min(procesadas + (data.filas_mapeadas_lote || 0), totalArchivo)
        : totalArchivo;
      if (progresoTexto) {
        progresoTexto.textContent = hayMas
          ? `Mapeando… ${procesadas.toLocaleString('es-AR')} de ${totalArchivo.toLocaleString('es-AR')} filas`
          : 'Mapeo terminado, armando la vista previa...';
      }
      if (progresoBarra) {
        const pct = totalArchivo ? Math.max(0, Math.min(100, (procesadas / totalArchivo) * 100)) : 0;
        progresoBarra.style.width = `${pct}%`;
      }
      // Salvaguarda: igual que en confirmar, no hacer loop infinito si algo
      // queda trabado sin avanzar nunca.
      if (vueltas > 500) throw new Error('El mapeo no terminó luego de muchos lotes; revisá la sesión.');
    }

    estado.resumen = data;
    await cargarFilasRevision();
    mostrarPaso('paso-revisar');
  } catch (err) {
    console.error('[migracion] validar mapeo:', err);
    window.toast?.('No se pudo validar el mapeo', 'error');
  } finally {
    btn.disabled = false;
    if (progreso) progreso.style.display = 'none';
  }
}

