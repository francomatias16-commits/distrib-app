// frontend/admin/js/migracion/parseo-archivo-base.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Paso 1 (subir+parsear): hash de archivo, carga perezosa de PDF/OCR, parsers CSV/TXT/PDF.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ─── Paso 1: subir + parsear archivo ─────────────────────────────────────────
// Punto 8 del audit: hash SHA-256 del contenido crudo del archivo (antes de
// parsear), para que el backend pueda dedupear por contenido real y no solo
// por nombre+cantidad de filas (dos archivos con el mismo nombre pero
// distinto contenido, o el mismo contenido con otro nombre, se detectan
// igual). Se calcula client-side con Web Crypto, no hace falta subir nada
// extra para esto.
async function calcularHashArchivo(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function onArchivoElegido(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;

  const estadoDiv = document.getElementById('estado-carga');
  const avisoPdf = document.getElementById('aviso-pdf-ocr');
  if (avisoPdf) avisoPdf.style.display = 'none';

  // FIX (auditoría UX etapa 18, Hallazgo 3): el parseo de Excel/CSV es
  // síncrono y bloquea el hilo principal -- con archivos grandes (varios
  // cientos de miles de filas) el navegador puede quedar "congelado"
  // varios segundos sin ningún indicio de que sigue vivo. No resuelve el
  // freeze en sí (movería el parseo a un Web Worker, pendiente aparte),
  // pero al menos avisa antes de arrancar para que no se perciba como
  // que la pantalla se colgó.
  const MB = file.size / (1024 * 1024);
  estadoDiv.textContent = MB > 15
    ? `Leyendo archivo (${MB.toFixed(1)} MB)... puede tardar varios segundos, no cierres esta pestaña.`
    : 'Leyendo archivo...';
  // Deja pintar el mensaje antes de arrancar el parseo síncrono.
  await new Promise(resolve => setTimeout(resolve, 0));

  try {
    const ext = file.name.split('.').pop().toLowerCase();
    // Migración 384: antes acá se llamaba directo a un parser que ya asumía
    // "fila 0 = encabezados" (sheet_to_json/Papa.parse con header:true), sin
    // ninguna validación. Si el archivo no traía fila de encabezados (o la
    // tenía en otra posición), la primera fila de datos reales se perdía
    // silenciosamente como si fueran nombres de columna. Ahora se parsea
    // como matriz cruda primero, se corre una heurística, y SIEMPRE se
    // muestra una vista previa para que la persona confirme (o corrija)
    // antes de seguir al mapeo.
    let matriz;
    if (ext === 'csv') matriz = await parsearCSVCrudo(file);
    else if (ext === 'txt') matriz = await parsearTXTCrudo(file);
    else if (ext === 'pdf') matriz = await parsearPDFCrudo(file, estadoDiv);
    else if (ext === 'json') matriz = await parsearJSONCrudo(file);
    else if (ext === 'xml') matriz = await parsearXMLCrudo(file);
    else if (ext === 'dbf') matriz = await parsearDBFCrudo(file);
    else if (['png', 'jpg', 'jpeg'].includes(ext)) matriz = await parsearImagenCrudo(file, estadoDiv);
    // .xlsm (Excel con macros) usa el mismo contenedor OOXML que .xlsx —
    // SheetJS ya lo lee sin código adicional, cae acá igual que xls/xlsb/ods.
    else matriz = await parsearExcelCrudo(file);

    if (!matriz.length) throw new Error('El archivo no tiene filas de datos.');

    document.getElementById('estado-carga').textContent = '';
    const { tieneEncabezado, encabezados } = await mostrarPreviewEncabezado(matriz);
    document.getElementById('estado-carga').textContent = 'Leyendo archivo...';

    const filas = filasDesdeMatriz(matriz, tieneEncabezado, encabezados);
    if (!filas.length) throw new Error('El archivo no tiene filas de datos.');

    let hashContenido = null;
    try {
      hashContenido = await calcularHashArchivo(file);
    } catch {
      // Si Web Crypto no está disponible (contexto no seguro, navegador
      // viejo), seguimos sin hash: el backend cae al chequeo por
      // nombre+total_filas como antes.
    }

    let data;
    try {
      data = await subirArchivoEnChunks(estado.entidad, file.name, filas, false, estadoDiv, hashContenido);
    } catch (err) {
      // Item 1 del plan P0: si el backend detecta que este mismo archivo ya
      // se subió antes (mismo nombre + cantidad de filas, sesión no
      // descartada), avisa con 409 en vez de bloquear directo — dejamos que
      // la persona decida si igual quiere subirlo de nuevo (forzar: true).
      // Esto solo puede pasar en el primer request de la subida (donde se
      // crea la sesión), así que reintentamos el loop entero desde offset 0.
      if (err.status === 409 && err.data?.duplicado) {
        const detalle = (err.data.sesiones_previas || [])
          .map(s => `• ${new Date(s.created_at).toLocaleDateString('es-AR')} — estado: ${etiquetaEstado(s.estado)}`)
          .join('\n');
        // Si alguna de las sesiones previas quedó en 'error', puede tener
        // datos reales ya confirmados de lotes anteriores al que falló. Hoy
        // no hay forma de retomar esa sesión puntual desde la UI entre
        // recargas de página (el botón "Reintentar" del checklist solo abre
        // el asistente de subida desde cero) — así que la única opción real
        // es avisar del riesgo y dejar que la persona decida, no prometer un
        // "reintentar" que en los hechos no reanuda nada.
        const hayConError = (err.data.sesiones_previas || []).some(s => s.estado === 'error');
        const sugerencia = hayConError
          ? '\n\nAl menos una de esas sesiones quedó en estado "Error" a mitad de camino, lo que significa que puede tener datos ya creados (por ejemplo, algunos movimientos de cuenta corriente ya cargados). Si subís este archivo de nuevo y lo confirmás completo, esos datos podrían quedar duplicados. Si no estás segurx de qué se llegó a crear, revisá primero con el equipo antes de continuar.'
          : '';
        const confirmar = await window.confirmar(
          `${err.data.error}<br><br>${detalle}${sugerencia.replace(/\n\n/g, '<br><br>')}<br><br>¿Confirmás que igual querés subirlo como una migración nueva?`,
          { labelOk: 'Subir igual', labelCancel: 'Cancelar', tipo: 'danger' }
        );
        if (!confirmar) {
          estadoDiv.textContent = '';
          ev.target.value = '';
          return;
        }
        data = await subirArchivoEnChunks(estado.entidad, file.name, filas, true, estadoDiv, hashContenido);
      } else {
        throw err;
      }
    }

    estado.sesionId = data.sesion_id;
    estado.totalFilasArchivo = filas.length;
    estado.columnasDetectadas = data.columnas_detectadas;
    estado.camposDisponibles = data.campos_disponibles;
    estado.camposRequeridos = data.campos_requeridos;
    estado.depositos = data.depositos || [];
    estado.listasPrecios = data.listas_precios || [];

    estadoDiv.textContent = '';
    renderMapeo();
    renderDestinos();
    renderAyudaCtaCte();
    await renderPlantillasMapeo();
    mostrarPaso('paso-mapear');
  } catch (err) {
    estadoDiv.textContent = '';
    console.error('[migracion] leer archivo:', err);
    window.toast?.('No se pudo leer el archivo', 'error');
  }
}

// ─── Migración: carga perezosa de librerías pesadas (PDF/OCR) ────────────────
// pdf.js (~1MB) y Tesseract.js (~2-3MB + modelo de idioma) solo se necesitan
// si la persona efectivamente elige un .pdf — la gran mayoría sube CSV/Excel,
// así que iny ectarlas siempre en el <head> sería peso muerto para el caso
// común. Se cargan on-demand y se cachean en window para no reinyectar el
// <script> si se sube un segundo PDF en la misma sesión de navegación.
function cargarScriptUnaVez(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`No se pudo cargar ${src} (revisá la conexión)`));
    document.head.appendChild(s);
  });
}

async function cargarPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await cargarScriptUnaVez('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  return window.pdfjsLib;
}

async function cargarTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await cargarScriptUnaVez('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  return window.Tesseract;
}


let _resolverHojaElegida = null;

// Migración 384: devuelve la hoja como matriz cruda (array de arrays), SIN
// asumir que la fila 0 es encabezado — eso se decide después, con
// mostrarPreviewEncabezado(). blankrows:false descarta filas 100% vacías
// (separadores visuales que a veces deja Excel), igual que skipEmptyLines
// hacía antes en el flujo con header:true.
async function parsearExcelCrudo(file) {
  if (!window.XLSX) throw new Error('SheetJS no disponible');
  const data = await file.arrayBuffer();
  const wb = window.XLSX.read(data, { type: 'array' });

  if (wb.SheetNames.length <= 1) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
  }

  // Varias hojas: mostramos el picker y esperamos a que la persona elija
  // antes de seguir (confirmarHojaElegida resuelve esta promesa).
  const select = document.getElementById('select-hoja');
  select.innerHTML = wb.SheetNames.map(nombre => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join('');
  document.getElementById('selector-hoja').style.display = '';
  document.getElementById('estado-carga').textContent = '';

  const nombreElegido = await new Promise(resolve => { _resolverHojaElegida = resolve; });

  document.getElementById('selector-hoja').style.display = 'none';
  const ws = wb.Sheets[nombreElegido];
  return window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
}

function confirmarHojaElegida() {
  const select = document.getElementById('select-hoja');
  if (_resolverHojaElegida) {
    document.getElementById('estado-carga').textContent = 'Leyendo archivo...';
    _resolverHojaElegida(select.value);
    _resolverHojaElegida = null;
  }
}

// Migración 384: mismo criterio que parsearExcelCrudo — matriz cruda, sin
// asumir encabezado. Papa.parse con header:false ya devuelve array de
// arrays directo.
async function parsearCSVCrudo(file) {
  if (!window.Papa) throw new Error('PapaParse no disponible');
  const texto = await leerTextoConFallbackEncoding(file);
  const result = window.Papa.parse(texto, { header: false, skipEmptyLines: true });
  return result.data;
}

// ─── Soporte .txt (texto plano, delimitado o de columnas fijas) ──────────────
// Los sistemas viejos (facturación DOS, exports de Tango) suelen tirar un
// .txt sin extensión CSV real: a veces delimitado (tab/; más común que coma,
// porque coma choca con decimales AR) y a veces "de columnas fijas" — texto
// alineado por posición de caracter, sin ningún separador, típico de
// reportes de impresora de sistemas de los 90s/2000s.
async function parsearTXTCrudo(file) {
  const texto = await leerTextoConFallbackEncoding(file);
  const lineas = texto.split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
  if (!lineas.length) return [];

  // 1) Delimitador consistente: se prueba en orden de probabilidad real en
  // estos archivos (tab y ; antes que coma, que puede ser parte de un
  // número "1.234,56" y daría falso positivo de "columna").
  const muestraDelim = lineas.slice(0, 20);
  for (const delim of ['\t', ';', '|', ',']) {
    const conteos = muestraDelim.map(l => l.split(delim).length);
    if (conteos[0] > 1 && conteos.every(c => c === conteos[0])) {
      return lineas.map(l => l.split(delim).map(c => c.trim()));
    }
  }

  // 2) Sin delimitador: columnas fijas por posición de caracter. Una
  // posición es "borde de columna" si es espacio en blanco en TODAS las
  // líneas de la muestra (una franja vertical de espacio que atraviesa el
  // archivo entero) — la técnica estándar para parsear texto alineado con
  // espacios en vez de un separador explícito.
  const muestra = lineas.slice(0, Math.min(50, lineas.length));
  const anchoMax = Math.max(...muestra.map(l => l.length));
  const espacioEnTodas = Array.from({ length: anchoMax }, (_, c) =>
    muestra.every(l => l[c] === undefined || l[c] === ' '));

  const cortes = [];
  let dentroDeEspacio = false;
  for (let c = 0; c < anchoMax; c++) {
    if (espacioEnTodas[c] && !dentroDeEspacio) { cortes.push(c); dentroDeEspacio = true; }
    if (!espacioEnTodas[c]) dentroDeEspacio = false;
  }

  if (cortes.length < 2) {
    // No se detectó ninguna estructura de columnas reconocible: mejor
    // devolver cada línea entera como una sola columna (para que la persona
    // la vea en la vista previa y decida) que perder el archivo.
    return lineas.map(l => [l]);
  }

  const bordes = [0, ...cortes, anchoMax];
  return lineas.map(l =>
    bordes.slice(0, -1).map((inicio, i) => l.slice(inicio, bordes[i + 1]).trim()));
}

// ─── Soporte .pdf (tabla con texto real, o escaneado vía OCR) ────────────────
// A diferencia de CSV/Excel, un PDF no tiene celdas — es texto posicionado
// en una página. Dos casos completamente distintos:
//  a) Tabla real (exportada de un sistema, texto seleccionable): se extrae
//     la capa de texto de pdf.js y se reconstruye la grilla agrupando por
//     posición Y (fila) y detectando saltos grandes de X (columna).
//  b) Escaneado/foto (sin texto real, son píxeles): la extracción de texto
//     da prácticamente vacío. Se renderiza cada página a un canvas y se
//     corre OCR (Tesseract.js). Esto es sensiblemente más lento y bastante
//     menos preciso (un "8" leído como "3" en un precio no tira error, se
//     carga mal en silencio) — por eso SIEMPRE se avisa antes de mostrar la
//     vista previa, para que la revisión fila por fila sea más cuidadosa.
const OCR_MIN_CHARS_POR_PAGINA = 20; // debajo de esto, se asume que la página no tiene texto real
const OCR_MAX_PAGINAS = 15; // tope duro: OCR es pesado, evita que el navegador quede colgado con un PDF de 100 páginas

function agruparItemsEnFilas(items) {
  if (!items.length) return [];

  // Redondea Y para tolerar el jitter de sub-píxel entre caracteres de una
  // misma línea visual, y ordena filas de arriba a abajo, ítems de
  // izquierda a derecha dentro de cada fila.
  //
  // OJO (probado contra un PDF real): pdf.js NO garantiza que los ítems de
  // getTextContent() vengan en orden de lectura izquierda-a-derecha dentro
  // de una misma línea — en varios generadores de reportes, el texto de la
  // columna "nombre" sale ANTES que el de "código" en el stream aunque esté
  // más a la derecha en la página. Por eso acá SÍ hace falta reordenar por
  // X: es la única forma confiable de reconstruir el orden visual real.
  const porY = new Map();
  for (const it of items) {
    const y = Math.round(it.y / 3) * 3;
    if (!porY.has(y)) porY.set(y, []);
    porY.get(y).push(it);
  }
  const filas = [...porY.entries()].sort((a, b) => b[0] - a[0]).map(([, its]) => its.sort((a, b) => a.x - b.x));

  // Detecta columnas por gaps de X: si el espacio entre el fin de un ítem y
  // el inicio del siguiente supera ~2.5x el ancho de caracter típico de la
  // página, se asume borde de columna en vez de un simple espacio dentro
  // del mismo campo de texto.
  const anchosChar = items.map(it => it.width / Math.max(it.str.length, 1)).filter(w => w > 0);
  const anchoCharTipico = anchosChar.length
    ? anchosChar.slice().sort((a, b) => a - b)[Math.floor(anchosChar.length / 2)]
    : 5;
  const umbralGap = anchoCharTipico * 2.5;

  return filas.map(its => {
    const celdas = [];
    let actual = its[0]?.str ?? '';
    for (let i = 1; i < its.length; i++) {
      const gap = its[i].x - (its[i - 1].x + its[i - 1].width);
      if (gap > umbralGap) {
        celdas.push(actual.trim());
        actual = its[i].str;
      } else {
        actual += its[i].str;
      }
    }
    if (its.length) celdas.push(actual.trim());
    return celdas;
  });
}

// PDFs de varias páginas casi siempre repiten membrete y/o pie de página
// (nombre de empresa, dirección, teléfono, fecha, "página X de Y") en cada
// página — eso queda mezclado como filas más entre los datos reales. Se
// descartan las filas cuyo texto aparece, idéntico, en la mitad o más de
// las páginas del documento: una fila de datos real es prácticamente
// imposible que se repita así (cada producto aparece una vez), mientras que
// texto de membrete/pie sí se repite exactamente igual página tras página.
// Genérico a propósito — no depende de reconocer ninguna palabra puntual.
function quitarFilasRepetidasEntrePaginas(filasPorPagina) {
  if (filasPorPagina.length < 3) return filasPorPagina.flat(); // muy pocas páginas para que el patrón sea confiable

  const paginasPorTexto = new Map();
  filasPorPagina.forEach(filas => {
    const vistasEnEstaPagina = new Set();
    for (const f of filas) {
      const texto = f.join(' | ').trim().toLowerCase();
      if (!texto || vistasEnEstaPagina.has(texto)) continue;
      vistasEnEstaPagina.add(texto);
      paginasPorTexto.set(texto, (paginasPorTexto.get(texto) || 0) + 1);
    }
  });
  const umbralPaginas = Math.ceil(filasPorPagina.length * 0.5);
  const esBoilerplate = f => {
    const texto = f.join(' | ').trim().toLowerCase();
    return texto && (paginasPorTexto.get(texto) || 0) >= umbralPaginas;
  };

  // De paso, una fila que quedó con una sola celda después de separar
  // columnas (sin comas de gap detectadas) casi nunca es un producto real
  // — suele ser un número de página suelto u otro resto de maquetación
  // que no calzó con el patrón de membrete repetido de arriba.
  return filasPorPagina.flat().filter(f => !esBoilerplate(f) && f.length > 1);
}

async function extraerMatrizPorTextoPdf(pdf) {
  const filasPorPagina = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pagina = await pdf.getPage(p);
    const contenido = await pagina.getTextContent();
    const items = contenido.items
      .filter(it => it.str && it.str.trim() !== '')
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width }));
    filasPorPagina.push(agruparItemsEnFilas(items));
  }
  const filas = quitarFilasRepetidasEntrePaginas(filasPorPagina);
  return { filas, totalCaracteres: filas.reduce((acc, f) => acc + f.join('').length, 0) };
}

async function extraerMatrizPorOcrPdf(pdf, estadoDiv) {
  const Tesseract = await cargarTesseract();
  const nPaginas = Math.min(pdf.numPages, OCR_MAX_PAGINAS);
  const filas = [];

  for (let p = 1; p <= nPaginas; p++) {
    if (estadoDiv) estadoDiv.textContent = `Reconociendo texto (OCR) — página ${p} de ${nPaginas}, puede tardar...`;
    const pagina = await pdf.getPage(p);
    const viewport = pagina.getViewport({ scale: 2 }); // 2x para mejorar precisión del OCR
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pagina.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const { data } = await Tesseract.recognize(canvas, 'spa+eng');
    const lineasPagina = (data.text || '').split(/\r?\n/).filter(l => l.trim() !== '');
    // Mismo criterio que parsearTXTCrudo: sin separador real en el output de
    // OCR, se parte por corridas de 2+ espacios (así suelen quedar alineadas
    // las columnas después del reconocimiento).
    for (const l of lineasPagina) {
      filas.push(l.split(/ {2,}/).map(c => c.trim()).filter(c => c !== ''));
    }
  }
  return filas;
}

async function parsearPDFCrudo(file, estadoDiv) {
  const pdfjsLib = await cargarPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const aviso = document.getElementById('aviso-pdf-ocr');

  const { filas: filasTexto, totalCaracteres } = await extraerMatrizPorTextoPdf(pdf);
  const promedioPorPagina = totalCaracteres / Math.max(pdf.numPages, 1);

  if (promedioPorPagina >= OCR_MIN_CHARS_POR_PAGINA) {
    if (aviso) aviso.style.display = 'none';
    return filasTexto;
  }

  // Texto casi vacío: es un PDF escaneado/imagen. Se avisa ANTES de mostrar
  // la vista previa (no después) para que la persona sepa, mientras revisa
  // fila por fila, que estos datos vienen de reconocimiento óptico y no de
  // texto real del archivo.
  if (aviso) {
    aviso.style.display = '';
    aviso.textContent =
      '⚠ Este PDF no tiene texto seleccionable (parece escaneado o una foto). Se está usando reconocimiento óptico (OCR), que es más lento y bastante menos preciso que un archivo con texto real — revisá cada fila con especial cuidado antes de confirmar, sobre todo números.';
  }
  if (pdf.numPages > OCR_MAX_PAGINAS && aviso) {
    aviso.textContent += ` Además, el archivo tiene ${pdf.numPages} páginas y solo se procesan las primeras ${OCR_MAX_PAGINAS} por OCR (subí el resto por separado si hace falta).`;
  }
  return await extraerMatrizPorOcrPdf(pdf, estadoDiv);
}

