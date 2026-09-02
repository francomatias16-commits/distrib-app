// frontend/admin/js/migracion/confirmacion-lote.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Paso 4: confirmar — ejecución del lote y resultado.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ─── Paso 4: confirmar ────────────────────────────────────────────────────────
// El backend procesa un lote acotado de filas por llamada (ver migración 152)
// y devuelve hay_mas=true mientras queden filas pendientes. Acá lo llamamos en
// loop hasta que termine, mostrando progreso. Si el proceso se interrumpe
// (recarga de página, error de red) y el usuario vuelve a confirmar, las filas
// ya procesadas se saltean solas — no hay riesgo de duplicados.
//
// ejecutarLoteConfirmacion() es compartido entre la primera confirmación y
// el reintento (migración 156/157): ambos llaman accion=confirmar en loop,
// la única diferencia es qué filas quedaron pendientes (procesado_en NULL)
// en el momento de empezar.
async function ejecutarLoteConfirmacion(onProgreso) {
  let r = {}, advertencias = [], hayMas = true, vueltas = 0;

  try {
    while (hayMas) {
      vueltas++;
      const data = await migApi('/api/migracion?accion=confirmar', {
        method: 'POST',
        body: JSON.stringify({ sesion_id: estado.sesionId }),
      });
      r = data.resultado || {};
      hayMas = !!data.hay_mas;
      if (!hayMas && Array.isArray(data.advertencias)) advertencias = data.advertencias;
      onProgreso?.(r, hayMas);

      // Salvaguarda: si por algún motivo no avanza nunca, no hacer loop infinito.
      if (vueltas > 500) throw new Error('La importación no terminó luego de muchos lotes; revisá la sesión.');
    }
  } catch (err) {
    // FIX (auditoría UX etapa 18, Hallazgo 2): si el corte pasa a mitad de
    // loop, r ya tiene el progreso del último lote que sí se guardó server-
    // side (migración 152, bulk idempotente) — antes se perdía al relanzar
    // la excepción y el catch de confirmarSesion() no tenía forma de saber
    // que ya se había importado una parte real.
    err.progresoParcial = r;
    throw err;
  }

  return { r, advertencias };
}

function mostrarResultado(r, advertencias) {
  estado.ultimoErrores = r.errores || 0;
  estado.ultimoResultado = r;
  estado.ultimasAdvertencias = advertencias || [];

  const detalle = document.getElementById('resultado-detalle');
  detalle.textContent =
    `Se crearon ${r.creados ?? 0} y se actualizaron ${r.actualizados ?? 0} registros.` +
    (r.errores ? ` (${r.errores} con error durante la importación)` : '');

  const advCont = document.getElementById('resultado-advertencias');
  if (advertencias.length) {
    const lista = advertencias.slice(0, 20)
      .map(a => `Fila ${a.fila_numero}: ${escapeHtml(a.mensaje)}`)
      .join('<br>');
    const extra = advertencias.length > 20 ? `<br>… y ${advertencias.length - 20} más.` : '';
    advCont.innerHTML = `<div class="mig-advertencias"><strong>${advertencias.length} advertencia(s):</strong><br>${lista}${extra}</div>`;
  } else {
    advCont.innerHTML = '';
  }

  // Corrección punto 1 (sincronización de migraciones): tras confirmar,
  // mostramos qué columnas del archivo original no tuvieron ningún campo de
  // destino en el sistema. Antes esto quedaba "guardado" en
  // migracion_staging_rows.datos_originales pero invisible para quien hizo
  // la migración — ahora queda plasmado en la propia pantalla de resultado.
  const columnasSinMapear = calcularColumnasSinMapear(estado.columnasDetectadas, estado.mapeoConfirmado);
  // REQ-MIG-EXTRAS: si hay columnas sin mapear, buscar muestras de valores
  // en las staging rows para mostrárselas al usuario junto con el nombre.
  if (columnasSinMapear.length && estado.sesionId) {
    _cargarMuestrasExtras(estado.sesionId, columnasSinMapear)
      .then(muestras => renderColumnasSinMapear(
        'resultado-columnas-sin-mapear', columnasSinMapear,
        `sin_mapear_${estado.entidad}_${estado.sesionId || 'sesion'}`, muestras))
      .catch(() => renderColumnasSinMapear(
        'resultado-columnas-sin-mapear', columnasSinMapear,
        `sin_mapear_${estado.entidad}_${estado.sesionId || 'sesion'}`));
  } else {
    renderColumnasSinMapear('resultado-columnas-sin-mapear', columnasSinMapear,
      `sin_mapear_${estado.entidad}_${estado.sesionId || 'sesion'}`);
  }

  actualizarBotonReintentar();
}

// REQ-MIG-EXTRAS: obtiene hasta 3 valores de muestra por columna sin mapear
// leyendo las staging rows de la sesión. Usa el endpoint existente de staging
// (GET /api/migracion?sesion_id=X&limit=N) que devuelve datos_originales.
async function _cargarMuestrasExtras(sesionId, columnasSinMapear) {
  if (!sesionId || !columnasSinMapear.length) return {};
  try {
    const data = await migApi(`/api/migracion?sesion_id=${encodeURIComponent(sesionId)}&limit=10`);
    const filas = data.filas || data.rows || [];
    // datos_originales es un objeto plano con todas las columnas del CSV
    const muestras = {};
    for (const col of columnasSinMapear) {
      muestras[col] = [];
    }
    for (const fila of filas) {
      const orig = fila.datos_originales || {};
      for (const col of columnasSinMapear) {
        if (muestras[col].length < 3 && orig[col] !== undefined && orig[col] !== '') {
          muestras[col].push(orig[col]);
        }
      }
    }
    return muestras;
  } catch {
    return {};
  }
}

