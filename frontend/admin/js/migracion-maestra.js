// frontend/admin/js/migracion-maestra.js
// "Migración maestra": un solo archivo (Excel multi-hoja o .zip con varios
// CSV/Excel) en vez de subir entidad por entidad. Detecta automáticamente
// qué hoja/archivo corresponde a qué una de las 18 entidades del wizard
// (comparando encabezados contra CAMPOS[entidad] del backend), sugiere el
// mapeo de columnas, y — tras confirmación humana de ambas cosas — ejecuta
// las sesiones en el orden de dependencias de ORDEN_GUIADO (mismo array que
// ya usa el checklist guiado, ver migracion.js).
//
// Reusa 100% del pipeline server-side ya existente (accion=crear/mapear/
// confirmar): esto NO reimplementa ninguna lógica de negocio por entidad
// (resolución de CUIT, agrupación de pedidos por numero_pedido, parseo de
// montos AR/US, etc.) — solo automatiza la parte repetitiva de "elegir
// entidad" + "mapear columnas" que hoy se hace a mano una vez por archivo.
//
// Limitaciones conocidas (primera versión):
// - La detección es heurística (matching de encabezados normalizados contra
//   las etiquetas de campo + un diccionario de sinónimos). Nunca se ejecuta
//   nada sin que la persona confirme la entidad Y el mapeo de columnas en
//   pantalla — si la detección se equivoca, se corrige ahí antes de subir.
// - Si el archivo tiene más de un depósito o lista de precios, esta pantalla
//   no ofrece elegir el destino por defecto (a diferencia del wizard manual)
//   — cae al principal/default de la empresa. Para ese caso puntual conviene
//   usar el wizard por entidad.
// - Si dos hojas/archivos detectan la MISMA entidad, se combinan sus filas
//   en una sola sesión (se avisa en la tarjeta de esa entidad).

'use strict';

// ─── Normalización y diccionario de sinónimos ────────────────────────────
function normalizarTexto(s) {
  return (s ?? '').toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Variantes reales de nombres de columna que la gente usa en sus propios
// Excels, más allá de la etiqueta "oficial" (ETIQUETAS_CAMPO, ya definida
// en migracion.js). No pretende ser exhaustivo — es una capa heurística que
// la persona siempre revisa y puede corregir antes de importar.
const SINONIMOS_CAMPO = {
  razon_social: ['razon social', 'cliente', 'nombre cliente', 'empresa', 'nombre', 'nombre fantasia'],
  cuit: ['cuit', 'cuil', 'documento', 'nro documento', 'nro cuit', 'cuit cuil'],
  cliente_cuit: ['cuit cliente', 'cuit', 'cliente cuit', 'documento cliente'],
  proveedor_cuit: ['cuit proveedor', 'cuit'],
  proveedor_razon_social: ['proveedor', 'razon social proveedor', 'nombre proveedor'],
  nombre: ['producto', 'descripcion', 'articulo', 'descripcion producto', 'detalle'],
  codigo: ['cod', 'sku', 'codigo articulo', 'codigo producto', 'cod articulo'],
  producto_codigo: ['codigo producto', 'sku', 'cod producto', 'codigo articulo'],
  precio: ['precio venta', 'pvp', 'precio unitario', 'precio lista'],
  precio_unitario: ['precio', 'precio venta', 'pvp'],
  stock: ['cantidad', 'existencia', 'cantidad stock', 'stock actual'],
  telefono: ['tel', 'celular', 'whatsapp', 'telefono contacto'],
  email: ['mail', 'correo', 'correo electronico', 'e mail'],
  domicilio: ['direccion', 'domicilio fiscal', 'domicilio comercial'],
  localidad: ['ciudad', 'localidad'],
  monto: ['importe', 'total', 'monto total'],
  fecha: ['fecha movimiento', 'fecha comprobante'],
  numero_pedido: ['nro pedido', 'pedido', 'numero de pedido'],
  numero_orden: ['nro orden', 'orden compra', 'numero de orden'],
  numero_venta: ['nro venta', 'venta', 'numero de venta', 'ticket'],
  cantidad: ['qty', 'cant', 'unidades'],
  limite_credito: ['limite de credito', 'credito'],
  saldo_inicial: ['saldo inicial', 'saldo'],
  numero_original: ['numero comprobante', 'nro comprobante', 'numero factura'],
  numero_comprobante: ['nro comprobante', 'numero'],
  fecha_vto: ['fecha vencimiento', 'vencimiento'],
  banco: ['entidad bancaria', 'banco emisor'],
};

// ─── Estado ────────────────────────────────────────────────────────────
let estadoMaestra = {
  archivoNombre: null,
  hojas: [],          // [{ nombre, filas: [...] }] crudo, sin procesar
  entidadesDef: null,  // { entidad: { campos_disponibles, campos_requeridos } }
  deteccion: [],       // [{ hojaIdx, entidad, score, mapeo: {campo:columna}, omitida }]
  resultados: [],      // [{ entidad, titulo, creados, actualizados, errores, ok }]
};

// ─── Índice de matching: campo → lista de frases normalizadas ──────────
function construirIndiceCampo(campo) {
  const frases = new Set();
  frases.add(normalizarTexto(campo.replace(/_/g, ' ')));
  const etiqueta = (ETIQUETAS_CAMPO || {})[campo];
  if (etiqueta) frases.add(normalizarTexto(etiqueta.replace(/[¿?()]/g, '')));
  (SINONIMOS_CAMPO[campo] || []).forEach(s => frases.add(normalizarTexto(s)));
  return [...frases].filter(Boolean);
}

// Escapa un string para usarlo dentro de un RegExp.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ¿La frase "needle" aparece como palabra/frase completa dentro de "haystack"
// (delimitada por inicio/fin de string o espacios)? Usado en ambas direcciones
// para no matchear por substring libre (ej: "precio" NO debe matchear dentro
// de "precios", que aparece en etiquetas largas tipo "¿Es la lista de precios
// por defecto?").
function fraseEnTexto(needle, haystack) {
  if (!needle || !haystack) return false;
  const re = new RegExp(`(^|\\s)${escapeRegExp(needle)}(\\s|$)`);
  return re.test(haystack);
}

// Para una columna del archivo (ya normalizada) y un campo candidato,
// ¿matchea? Exacto primero; si no, frase completa (con límite de palabra) en
// cualquier dirección — nunca substring libre dentro de otra palabra.
function columnaMatcheaCampo(columnaNorm, frasesCampo) {
  if (frasesCampo.includes(columnaNorm)) return true;
  if (columnaNorm.length < 3) return false;
  return frasesCampo.some(f => f.length >= 3 && (fraseEnTexto(f, columnaNorm) || fraseEnTexto(columnaNorm, f)));
}

// Bonus/penalización por el nombre de la hoja/archivo: si coincide con el
// título "oficial" de la entidad candidata (ORDEN_GUIADO, ya usado por el
// checklist guiado en migracion.js) suma un poco; si en cambio coincide
// claramente con el título de OTRA entidad, resta un poco. Nunca decide por
// sí solo — es una señal más, chica a propósito.
function tituloEntidad(entidad) {
  const item = (typeof ORDEN_GUIADO !== 'undefined' ? ORDEN_GUIADO : []).find(e => e.entidad === entidad);
  return item ? normalizarTexto(item.titulo) : '';
}
function ajustePorNombreHoja(entidad, nombreHoja) {
  if (!nombreHoja) return 0;
  const nombreNorm = normalizarTexto(nombreHoja);
  if (!nombreNorm) return 0;
  const tituloPropio = tituloEntidad(entidad);
  if (tituloPropio && (fraseEnTexto(tituloPropio, nombreNorm) || fraseEnTexto(nombreNorm, tituloPropio))) return 0.06;
  const lista = typeof ORDEN_GUIADO !== 'undefined' ? ORDEN_GUIADO : [];
  const matcheaOtra = lista.some(e => {
    if (e.entidad === entidad) return false;
    const t = normalizarTexto(e.titulo);
    return t && (fraseEnTexto(t, nombreNorm) || fraseEnTexto(nombreNorm, t));
  });
  return matcheaOtra ? -0.04 : 0;
}

// ─── Puntuación de una hoja contra una entidad candidata ────────────────
// entidad y nombreHoja son opcionales (si no se pasan, no se aplica la señal
// de nombre de hoja — pero siempre conviene pasarlos cuando se tienen).
function puntuarHojaContraEntidad(columnas, def, entidad, nombreHoja) {
  const columnasNorm = columnas.map(c => ({ original: c, norm: normalizarTexto(c) }));
  const mapeo = {};
  let disponiblesCubiertos = 0;
  let requeridosCubiertos = 0;

  for (const campo of def.campos_disponibles) {
    const frases = construirIndiceCampo(campo);
    const match = columnasNorm.find(c => columnaMatcheaCampo(c.norm, frases));
    if (match) {
      mapeo[campo] = match.original;
      disponiblesCubiertos++;
      if (def.campos_requeridos.includes(campo)) requeridosCubiertos++;
    }
  }

  const scoreRequeridos = def.campos_requeridos.length
    ? requeridosCubiertos / def.campos_requeridos.length
    : 1;
  const scoreDisponibles = disponiblesCubiertos / def.campos_disponibles.length;
  // Los requeridos pesan mucho más: una entidad candidata que no cubre TODOS
  // sus campos requeridos casi nunca es la correcta (o el archivo le falta
  // algo esencial, en cuyo caso mejor que la persona lo vea y decida).
  let score = scoreRequeridos * 0.7 + scoreDisponibles * 0.3;

  // Guardia para entidades de esquema chico (2-4 campos disponibles en
  // total, ej: categorias, depositos, listas_precios, zonas): con tan pocos
  // campos, cubrir solo 1 (típicamente "nombre") ya da un piso de score alto
  // por la sola proporción, aunque la hoja no tenga nada que ver. Si el
  // esquema es chico y la superposición real es de un solo campo, se capea
  // el score para que no alcance el umbral de auto-asignación (0.5) ni el
  // de "alta confianza" (0.85) por accidente.
  if (def.campos_disponibles.length <= 4 && disponiblesCubiertos < 2) {
    score = Math.min(score, 0.45);
  }

  if (entidad) {
    score = Math.max(0, Math.min(1, score + ajustePorNombreHoja(entidad, nombreHoja)));
  }

  return { score, mapeo, requeridosCubiertos, totalRequeridos: def.campos_requeridos.length };
}

// Mejor entidad candidata para una hoja, entre todas las definidas.
function detectarEntidadDeHoja(columnas, entidadesDef, nombreHoja) {
  let mejor = null;
  for (const [entidad, def] of Object.entries(entidadesDef)) {
    const r = puntuarHojaContraEntidad(columnas, def, entidad, nombreHoja);
    if (!mejor || r.score > mejor.score) mejor = { entidad, ...r };
  }
  return mejor;
}

function etiquetaConfianza(score) {
  if (score >= 0.85) return { clase: 'alta', texto: 'Alta confianza' };
  if (score >= 0.5) return { clase: 'media', texto: 'Revisar' };
  return { clase: 'baja', texto: 'Baja confianza' };
}

// ─── Parseo del archivo único (Excel multi-hoja, .zip, o CSV suelto) ────
// Migración 384 (parte 2): antes esto llamaba directo a header:true igual
// que el wizard manual, con el mismo bug — y acá el impacto es peor,
// porque detectarEntidadDeHoja() (más abajo) decide a qué entidad
// corresponde cada hoja MIRANDO los nombres de columna. Si la hoja no
// tenía encabezados de verdad, la detección de entidad se rompía en
// cascada (comparaba nombres de campo contra lo que en realidad eran
// valores de la primera fila de datos). Ahora se devuelve la matriz cruda
// por hoja/archivo; la decisión de si tiene encabezado se toma después,
// hoja por hoja, en onArchivoMaestroElegido/renderDeteccionMaestra —
// recién ahí se corren detectarFilaEncabezado()/filasDesdeMatriz(), ya
// definidas en migracion.js (se carga antes en migracion.html).
async function parsearArchivoMaestro(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'csv') {
    if (!window.Papa) throw new Error('PapaParse no disponible');
    const texto = await file.text();
    const matriz = window.Papa.parse(texto, { header: false, skipEmptyLines: true }).data;
    return matriz.length ? [{ nombre: file.name.replace(/\.csv$/i, ''), matriz }] : [];
  }

  if (ext === 'zip') {
    if (!window.JSZip) throw new Error('JSZip no disponible');
    const zip = await window.JSZip.loadAsync(file);
    const hojas = [];
    for (const [ruta, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const nombreArchivo = ruta.split('/').pop();
      const extEntry = nombreArchivo.split('.').pop().toLowerCase();
      if (extEntry === 'csv') {
        const texto = await entry.async('string');
        const matriz = window.Papa.parse(texto, { header: false, skipEmptyLines: true }).data;
        if (matriz.length) hojas.push({ nombre: nombreArchivo.replace(/\.csv$/i, ''), matriz });
      } else if (['xlsx', 'xls', 'xlsb', 'ods'].includes(extEntry)) {
        const buffer = await entry.async('arraybuffer');
        const wb = window.XLSX.read(buffer, { type: 'array' });
        for (const nombreHoja of wb.SheetNames) {
          const matriz = window.XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], { header: 1, defval: '', raw: false, blankrows: false });
          if (matriz.length) hojas.push({ nombre: `${nombreArchivo.replace(/\.[^.]+$/, '')} / ${nombreHoja}`, matriz });
        }
      }
    }
    return hojas;
  }

  // Excel / ODS multi-hoja: cada hoja con datos es candidata a una entidad.
  if (!window.XLSX) throw new Error('SheetJS no disponible');
  const buffer = await file.arrayBuffer();
  const wb = window.XLSX.read(buffer, { type: 'array' });
  const hojas = [];
  for (const nombreHoja of wb.SheetNames) {
    const matriz = window.XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], { header: 1, defval: '', raw: false, blankrows: false });
    if (matriz.length) hojas.push({ nombre: nombreHoja, matriz });
  }
  return hojas;
}

// A partir de la matriz cruda de una hoja + si se decidió que tiene
// encabezado, arma { columnas, filas } — mismo formato que antes devolvía
// sheet_to_json/Papa.parse con header:true, pero ahora la decisión ya fue
// tomada (por la heurística o corregida a mano). Reusa filasDesdeMatriz()
// de migracion.js, que ya sabe generar "Columna N" y dedupear nombres
// repetidos/vacíos.
function columnasYFilasDesdeMatriz(matriz, tieneEncabezado) {
  const nCols = Math.max(...matriz.slice(0, 20).map(f => f.length), 0);
  const encabezados = tieneEncabezado
    ? matriz[0]
    : Array.from({ length: nCols }, (_, i) => `Columna ${i + 1}`);
  const filas = filasDesdeMatriz(matriz, tieneEncabezado, encabezados);
  const columnas = Object.keys(filas[0] || {});
  return { columnas, filas };
}

// ─── Paso 1: elegir archivo ──────────────────────────────────────────────
async function onArchivoMaestroElegido(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;

  const estadoDiv = document.getElementById('estado-carga-maestra');
  estadoDiv.textContent = 'Leyendo archivo...';

  try {
    const hojasCrudas = await parsearArchivoMaestro(file);
    if (!hojasCrudas.length) throw new Error('No se encontraron hojas/archivos con datos.');

    estadoDiv.textContent = 'Detectando qué es cada hoja...';
    const data = await migApi('/api/migracion?accion=campos');

    // Migración 384 (parte 2): la detección de encabezado corre PRIMERO,
    // hoja por hoja — detectarEntidadDeHoja necesita nombres de columna
    // reales para tener chance de acertar, así que no puede correr sobre
    // la matriz cruda.
    const hojas = hojasCrudas.map(h => ({ nombre: h.nombre, matriz: h.matriz, filas: [] }));
    const deteccion = hojasCrudas.map((hoja, idx) => {
      const { probable } = detectarFilaEncabezado(hoja.matriz);
      const { columnas, filas } = columnasYFilasDesdeMatriz(hoja.matriz, probable);
      hojas[idx].filas = filas;
      const det = detectarEntidadDeHoja(columnas, data.entidades, hoja.nombre);
      return {
        hojaIdx: idx,
        columnas,
        tieneEncabezado: probable,
        entidad: det.score >= 0.5 ? det.entidad : null, // baja confianza: arranca sin asignar, la persona elige
        entidadSugerida: det.entidad,
        score: det.score,
        mapeo: det.mapeo,
        omitida: det.score < 0.5,
      };
    });

    estadoMaestra = {
      archivoNombre: file.name,
      hojas,
      entidadesDef: data.entidades,
      deteccion,
      resultados: [],
    };

    estadoDiv.textContent = '';
    renderDeteccionMaestra();
    mostrarPaso('paso-maestra-deteccion');
  } catch (err) {
    estadoDiv.textContent = '';
    window.toast?.(err.message || 'No se pudo leer el archivo', 'error');
  }
}

// ─── Paso 2: confirmar detección + mapeo ─────────────────────────────────
function renderDeteccionMaestra() {
  const cont = document.getElementById('maestra-deteccion-lista');
  const opcionesEntidad = ['<option value="">— Omitir esta hoja —</option>']
    .concat(ORDEN_GUIADO.map(e => `<option value="${e.entidad}">${escapeHtml(e.titulo)}</option>`))
    .join('');

  cont.innerHTML = estadoMaestra.deteccion.map((d, i) => {
    const hoja = estadoMaestra.hojas[d.hojaIdx];
    const conf = etiquetaConfianza(d.score);
    const def = d.entidad ? estadoMaestra.entidadesDef[d.entidad] : null;

    const filasCombinadas = estadoMaestra.deteccion.filter(x => x.entidad === d.entidad && d.entidad).length;
    const avisoCombinada = d.entidad && filasCombinadas > 1
      ? `<div class="mig-maestra-filas-count"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Otra(s) hoja(s) también se asignaron a esta entidad — se van a combinar en una sola importación.</div>`
      : '';

    // Migración 384 (parte 2): checkbox por hoja para corregir la detección
    // de encabezado. Va con una muestra corta de cómo se está interpretando
    // hoy la primera fila de datos (según el estado actual del checkbox),
    // para que la persona no tenga que adivinar — si dice "Columna 1: Coca
    // Cola 500ml" en vez de "nombre: Coca Cola 500ml", es señal de que el
    // checkbox está mal.
    const primeraFila = hoja.filas[0] || {};
    const muestraTexto = Object.entries(primeraFila).slice(0, 4)
      .map(([k, v]) => `${k}: ${(v ?? '').toString() || '—'}`).join(' · ');
    const bloqueEncabezado = `
      <label class="mig-maestra-check-encabezado">
        <input type="checkbox" ${d.tieneEncabezado ? 'checked' : ''} onchange="onCambioEncabezadoMaestro(${i}, this.checked)">
        Esta hoja tiene fila de encabezados
      </label>
      ${muestraTexto ? `<div class="mig-maestra-encabezado-muestra">Primera fila de datos: ${escapeHtml(muestraTexto)}</div>` : ''}`;

    const gridMapeo = def ? `
      <div class="mig-maestra-mapeo-grid">
        ${def.campos_disponibles.map(campo => {
          const etiqueta = (ETIQUETAS_CAMPO || {})[campo] || campo;
          const esRequerido = def.campos_requeridos.includes(campo);
          const valorActual = d.mapeo[campo] || '';
          const opciones = ['<option value="">— sin mapear —</option>']
            .concat(d.columnas.map(c => `<option value="${escapeHtml(c)}" ${c === valorActual ? 'selected' : ''}>${escapeHtml(c)}</option>`))
            .join('');
          return `
            <div class="mig-maestra-mapeo-item">
              <label>${escapeHtml(etiqueta)}${esRequerido ? ' <span class="req">*</span>' : ''}</label>
              <select data-idx="${i}" data-campo="${campo}" onchange="onCambioMapeoMaestro(this)" class="${esRequerido && !valorActual ? 'falta-requerido' : ''}">
                ${opciones}
              </select>
            </div>`;
        }).join('')}
      </div>` : '';

    return `
      <div class="mig-maestra-card ${d.omitida ? 'omitida' : ''}" data-idx="${i}">
        <div class="mig-maestra-card-header">
          <div class="mig-maestra-card-titulo">
            <strong>${escapeHtml(hoja.nombre)}</strong>
            <select onchange="onCambioEntidadMaestra(${i}, this.value)">
              ${opcionesEntidad.replace(`value="${d.entidad}"`, `value="${d.entidad}" selected`)}
            </select>
            ${d.entidad ? `<span class="mig-confianza-pill mig-confianza-${conf.clase}">${conf.texto}</span>` : ''}
          </div>
          <span class="mig-maestra-filas-count">${hoja.filas.length.toLocaleString('es-AR')} filas</span>
        </div>
        ${avisoCombinada}
        ${bloqueEncabezado}
        ${gridMapeo}
      </div>`;
  }).join('');
}

function onCambioEntidadMaestra(idx, nuevaEntidad) {
  const d = estadoMaestra.deteccion[idx];
  const hoja = estadoMaestra.hojas[d.hojaIdx];
  d.entidad = nuevaEntidad || null;
  d.omitida = !nuevaEntidad;
  if (nuevaEntidad) {
    const def = estadoMaestra.entidadesDef[nuevaEntidad];
    const r = puntuarHojaContraEntidad(d.columnas, def, nuevaEntidad, hoja.nombre);
    d.mapeo = r.mapeo;
    d.score = r.score;
  }
  renderDeteccionMaestra();
}

// Migración 384 (parte 2): la persona corrige acá si la heurística se
// equivocó sobre si la hoja tiene fila de encabezados. Como cambia el
// significado de TODAS las columnas de esa hoja, se recalculan columnas +
// filas desde la matriz cruda y se vuelve a correr la detección de entidad
// desde cero — cualquier mapeo manual que ya hubiera en esta hoja quedaría
// referenciando columnas que ya no existen (o que ahora significan otra
// cosa), así que no tiene sentido conservarlo.
function onCambioEncabezadoMaestro(idx, tieneEncabezado) {
  const d = estadoMaestra.deteccion[idx];
  const hoja = estadoMaestra.hojas[d.hojaIdx];
  const { columnas, filas } = columnasYFilasDesdeMatriz(hoja.matriz, tieneEncabezado);
  hoja.filas = filas;
  d.tieneEncabezado = tieneEncabezado;
  d.columnas = columnas;
  const det = detectarEntidadDeHoja(columnas, estadoMaestra.entidadesDef, hoja.nombre);
  d.entidad = det.score >= 0.5 ? det.entidad : null;
  d.entidadSugerida = det.entidad;
  d.score = det.score;
  d.mapeo = det.mapeo;
  d.omitida = det.score < 0.5;
  renderDeteccionMaestra();
}

function onCambioMapeoMaestro(select) {
  const idx = Number(select.dataset.idx);
  const campo = select.dataset.campo;
  estadoMaestra.deteccion[idx].mapeo[campo] = select.value || undefined;
  select.classList.toggle('falta-requerido',
    estadoMaestra.entidadesDef[estadoMaestra.deteccion[idx].entidad].campos_requeridos.includes(campo) && !select.value);
}

// ─── Paso 3: ejecución secuencial (respeta ORDEN_GUIADO) ────────────────
async function subirHojaEnChunks(entidad, nombreArchivo, filas, onProgress) {
  let sesionId = null;
  let offset = 0;
  while (offset < filas.length) {
    const chunk = filas.slice(offset, offset + CHUNK_SUBIDA);
    const body = sesionId
      ? { sesion_id: sesionId, filas: chunk, offset }
      : { entidad, nombre_archivo: nombreArchivo, filas: chunk, total_filas: filas.length, forzar: true };
    const data = await migApi('/api/migracion?accion=crear', { method: 'POST', body: JSON.stringify(body) });
    sesionId = data.sesion_id;
    offset += chunk.length;
    onProgress?.(Math.min(offset, filas.length), filas.length);
    if (!data.hay_mas) return sesionId;
  }
  return sesionId;
}

// FIX: reporta progreso real (no solo hay_mas) para que la pantalla de
// "Importando..." pueda mostrar una barra en vez de dejar a la persona
// mirando un texto fijo sin saber si avanza. `totalFilas` es un estimado
// (la cantidad de filas subidas) porque acá no todas necesariamente van a
// validar OK; sirve para el % visual, no para el resumen final (ese sigue
// saliendo de filas_validas/filas_con_error del último lote, sin cambios).
async function mapearHastaTerminar(sesionId, mapeo, totalFilas, onProgress) {
  let hayMas = true, vueltas = 0, ultima = {}, procesadas = 0;
  while (hayMas) {
    vueltas++;
    ultima = await migApi('/api/migracion?accion=mapear', {
      method: 'POST',
      body: JSON.stringify({ sesion_id: sesionId, mapeo_columnas: mapeo }),
    });
    hayMas = !!ultima.hay_mas;
    procesadas = hayMas
      ? Math.min(procesadas + (ultima.filas_mapeadas_lote || 0), totalFilas)
      : totalFilas;
    onProgress?.(procesadas, totalFilas);
    if (vueltas > 500) throw new Error('El mapeo no terminó luego de muchos lotes.');
  }
  return ultima;
}

// FIX: mismo criterio — acá el backend YA calcula el progreso acumulado real
// en cada llamada (obtenerProgresoConfirmacion agrega sobre TODA la sesión,
// no solo el lote actual), simplemente antes no se lo pasábamos a la UI.
async function confirmarHastaTerminar(sesionId, totalAImportar, onProgress) {
  let hayMas = true, vueltas = 0, resultado = {};
  while (hayMas) {
    vueltas++;
    const data = await migApi('/api/migracion?accion=confirmar', {
      method: 'POST',
      body: JSON.stringify({ sesion_id: sesionId }),
    });
    resultado = data.resultado || {};
    hayMas = !!data.hay_mas;
    const procesadas = (resultado.creados || 0) + (resultado.actualizados || 0) + (resultado.errores || 0);
    onProgress?.(Math.min(procesadas, totalAImportar), totalAImportar);
    if (vueltas > 500) throw new Error('La importación no terminó luego de muchos lotes.');
  }
  return resultado;
}

// `pct` (0-100, o null) dibuja/actualiza una barra de progreso real dentro
// de la línea; sin `pct` se comporta como antes (solo texto), para no tocar
// los estados terminales (ok/error) que no necesitan barra.
function agregarLineaProgreso(id, titulo, texto, clase, pct) {
  const cont = document.getElementById('maestra-progreso-lista');
  const existente = document.getElementById(id);
  const conBarra = Number.isFinite(pct);
  const pctClamp = conBarra ? Math.max(0, Math.min(100, pct)) : 0;
  const html = `
    <div class="mig-maestra-progreso-item" id="${id}">
      <div class="mig-maestra-progreso-item-fila">
        <span><strong>${escapeHtml(titulo)}</strong></span>
        <span class="detalle ${clase || ''}">${escapeHtml(texto)}${conBarra ? ` · ${Math.round(pctClamp)}%` : ''}</span>
      </div>
      ${conBarra ? `
      <div class="mig-maestra-progreso-barra" role="progressbar" aria-valuenow="${Math.round(pctClamp)}" aria-valuemin="0" aria-valuemax="100">
        <div class="mig-maestra-progreso-barra-fill" style="width:${pctClamp}%"></div>
      </div>` : ''}
    </div>`;
  if (existente) existente.outerHTML = html;
  else cont.insertAdjacentHTML('beforeend', html);
}

async function ejecutarMigracionMaestra() {
  // Agrupa las hojas confirmadas por entidad (si dos hojas apuntan a la
  // misma entidad, se combinan sus filas — ya avisado en la tarjeta).
  const porEntidad = {};
  for (const d of estadoMaestra.deteccion) {
    if (!d.entidad || d.omitida) continue;
    const def = estadoMaestra.entidadesDef[d.entidad];
    const faltantes = def.campos_requeridos.filter(c => !d.mapeo[c]);
    if (faltantes.length) {
      window.toast?.(`"${estadoMaestra.hojas[d.hojaIdx].nombre}": falta mapear ${faltantes.map(c => (ETIQUETAS_CAMPO || {})[c] || c).join(', ')}`, 'error');
      return;
    }
    if (!porEntidad[d.entidad]) porEntidad[d.entidad] = { filas: [], mapeo: d.mapeo, nombres: [] };
    porEntidad[d.entidad].filas.push(...estadoMaestra.hojas[d.hojaIdx].filas);
    porEntidad[d.entidad].nombres.push(estadoMaestra.hojas[d.hojaIdx].nombre);
  }

  const entidadesAEjecutar = ORDEN_GUIADO.filter(e => porEntidad[e.entidad]);
  if (!entidadesAEjecutar.length) {
    window.toast?.('No hay ninguna hoja asignada a una entidad todavía', 'error');
    return;
  }

  document.getElementById('maestra-progreso-lista').innerHTML = '';
  mostrarPaso('paso-maestra-progreso');
  estadoMaestra.resultados = [];

  for (const item of entidadesAEjecutar) {
    const { filas, mapeo, nombres } = porEntidad[item.entidad];
    const idLinea = `maestra-prog-${item.entidad}`;
    const totalArchivo = filas.length;
    agregarLineaProgreso(idLinea, item.titulo, `Subiendo ${totalArchivo.toLocaleString('es-AR')} filas…`, null, 0);
    try {
      const sesionId = await subirHojaEnChunks(item.entidad, nombres.join(' + '), filas, (proc, total) => {
        agregarLineaProgreso(idLinea, item.titulo, `Subiendo ${proc.toLocaleString('es-AR')} de ${total.toLocaleString('es-AR')} filas…`, null, (proc / total) * 100);
      });
      agregarLineaProgreso(idLinea, item.titulo, 'Mapeando y validando…', null, 0);
      const mapeado = await mapearHastaTerminar(sesionId, mapeo, totalArchivo, (proc, total) => {
        agregarLineaProgreso(idLinea, item.titulo, `Mapeando y validando ${proc.toLocaleString('es-AR')} de ${total.toLocaleString('es-AR')} filas…`, null, (proc / total) * 100);
      });
      if ((mapeado.filas_validas || 0) === 0) {
        agregarLineaProgreso(idLinea, item.titulo, 'Sin filas válidas para importar', 'error');
        estadoMaestra.resultados.push({ entidad: item.entidad, titulo: item.titulo, creados: 0, actualizados: 0, errores: mapeado.filas_con_error || 0, ok: false });
        continue;
      }
      const totalAImportar = mapeado.filas_validas;
      agregarLineaProgreso(idLinea, item.titulo, `Importando ${totalAImportar.toLocaleString('es-AR')} filas válidas…`, null, 0);
      const resultado = await confirmarHastaTerminar(sesionId, totalAImportar, (proc, total) => {
        agregarLineaProgreso(idLinea, item.titulo, `Importando ${proc.toLocaleString('es-AR')} de ${total.toLocaleString('es-AR')} filas válidas…`, null, (proc / total) * 100);
      });
      const texto = `${resultado.creados || 0} creados, ${resultado.actualizados || 0} actualizados` + (resultado.errores ? `, ${resultado.errores} con error` : '');
      agregarLineaProgreso(idLinea, item.titulo, texto, resultado.errores ? 'error' : 'ok');
      estadoMaestra.resultados.push({
        entidad: item.entidad, titulo: item.titulo,
        creados: resultado.creados || 0, actualizados: resultado.actualizados || 0,
        errores: (resultado.errores || 0) + (mapeado.filas_con_error || 0), ok: true,
      });
    } catch (err) {
      agregarLineaProgreso(idLinea, item.titulo, err.message || 'Error inesperado', 'error');
      estadoMaestra.resultados.push({ entidad: item.entidad, titulo: item.titulo, creados: 0, actualizados: 0, errores: 0, ok: false, mensaje: err.message });
    }
  }

  renderResultadoMaestro();
  mostrarPaso('paso-maestra-resultado');
}

function renderResultadoMaestro() {
  const totales = estadoMaestra.resultados.reduce((acc, r) => ({
    creados: acc.creados + r.creados, actualizados: acc.actualizados + r.actualizados, errores: acc.errores + r.errores,
  }), { creados: 0, actualizados: 0, errores: 0 });

  const filas = estadoMaestra.resultados.map(r => `
    <tr>
      <td>${escapeHtml(r.titulo)}</td>
      <td>${r.ok ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'}${r.mensaje ? ` <span class="detalle">${escapeHtml(r.mensaje)}</span>` : ''}</td>
      <td>${r.creados.toLocaleString('es-AR')}</td>
      <td>${r.actualizados.toLocaleString('es-AR')}</td>
      <td>${r.errores.toLocaleString('es-AR')}</td>
    </tr>`).join('');

  document.getElementById('maestra-resultado-tabla').innerHTML = `
    <p>En total: <strong>${totales.creados.toLocaleString('es-AR')} creados</strong>, <strong>${totales.actualizados.toLocaleString('es-AR')} actualizados</strong>${totales.errores ? `, <strong>${totales.errores.toLocaleString('es-AR')} con error</strong>` : ''}.</p>
    <table class="mig-maestra-resultado-tabla">
      <thead><tr><th>Entidad</th><th>Estado</th><th>Creados</th><th>Actualizados</th><th>Con error</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>`;
}
