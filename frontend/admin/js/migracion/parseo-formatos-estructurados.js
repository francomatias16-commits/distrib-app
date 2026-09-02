// frontend/admin/js/migracion/parseo-formatos-estructurados.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Parsers de JSON, XML, DBF (Tango/DOS) e imagen (OCR).
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ─── Soporte .json (export directo de otra app/API) ───────────────────────────
// Dos formas reales de que llegue esto: un array de objetos ([{...},{...}]),
// que es lo normal en un export de API/otro sistema; o ese array metido
// adentro de una key contenedora (p.ej. {"productos":[...]}, {"data":[...]},
// {"rows":[...]}) — muy común cuando el JSON viene de un endpoint tipo
// "GET /productos" que devuelve metadata + resultados. Se busca el primer
// array de objetos que aparezca (en la raíz o un nivel adentro) en vez de
// asumir una sola forma posible.
function encontrarArrayDeObjetos(valor, profundidad = 0) {
  if (Array.isArray(valor) && valor.length && valor.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
    return valor;
  }
  if (profundidad < 2 && valor && typeof valor === 'object') {
    for (const v of Object.values(valor)) {
      const encontrado = encontrarArrayDeObjetos(v, profundidad + 1);
      if (encontrado) return encontrado;
    }
  }
  return null;
}

async function parsearJSONCrudo(file) {
  const texto = await leerTextoConFallbackEncoding(file);
  let json;
  try {
    json = JSON.parse(texto);
  } catch (e) {
    throw new Error('El archivo .json no es válido: ' + e.message);
  }

  const filas = encontrarArrayDeObjetos(json);
  if (!filas) {
    throw new Error('No se encontró una lista de registros en el JSON (se esperaba un array de objetos, en la raíz o dentro de una key como "data"/"productos"/"rows").');
  }

  // Encabezados = unión de claves en el orden en que van apareciendo (no
  // todos los objetos tienen por qué traer exactamente las mismas keys —
  // p.ej. algunos productos con descuento y otros sin esa key).
  const columnas = [];
  const vistas = new Set();
  for (const obj of filas) {
    for (const k of Object.keys(obj)) {
      if (!vistas.has(k)) { vistas.add(k); columnas.push(k); }
    }
  }

  const matriz = [columnas];
  for (const obj of filas) {
    matriz.push(columnas.map(c => {
      const v = obj[c];
      if (v === null || v === undefined) return '';
      // Valores anidados (objeto/array dentro de un campo): se guardan como
      // JSON compacto en la celda en vez de perderlos — la persona ve el
      // valor real en la vista previa y decide si lo necesita.
      return typeof v === 'object' ? JSON.stringify(v) : v;
    }));
  }
  return matriz;
}

// ─── Soporte .xml (export de ERPs/sistemas viejos) ────────────────────────────
// No hay un único "formato XML de tabla" — la heurística busca, entre los
// elementos del documento, cuál tag se repite como hijo directo del mismo
// padre 2+ veces (eso es casi siempre "un registro por elemento", sea
// <item>, <producto>, <row>, <fila>, lo que sea que use el sistema de
// origen). Cada registro puede traer los datos como elementos hijos
// (<nombre>x</nombre>) o como atributos (<item nombre="x"/>) — se soportan
// ambos, y si un registro tiene las dos formas, los elementos hijos ganan.
function encontrarElementosFila(doc) {
  const porPadreYTag = new Map();
  const recorrer = nodo => {
    for (const hijo of nodo.children) {
      const clave = (hijo.parentElement === nodo ? nodo : null) ? `${nodo.tagName}>${hijo.tagName}` : hijo.tagName;
      if (!porPadreYTag.has(clave)) porPadreYTag.set(clave, []);
      porPadreYTag.get(clave).push(hijo);
      recorrer(hijo);
    }
  };
  recorrer(doc.documentElement);

  // El candidato ganador es el grupo con más elementos repetidos (asumiendo
  // que la tabla real tiene más filas que cualquier otra estructura
  // incidental del XML, como metadata o un único bloque de cabecera).
  let mejor = null;
  for (const grupo of porPadreYTag.values()) {
    if (grupo.length >= 2 && (!mejor || grupo.length > mejor.length)) mejor = grupo;
  }
  return mejor || [];
}

async function parsearXMLCrudo(file) {
  const texto = await leerTextoConFallbackEncoding(file);
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El archivo .xml no es válido (no se pudo parsear).');

  const elementosFila = encontrarElementosFila(doc);
  if (!elementosFila.length) throw new Error('No se encontraron registros repetidos en el XML (se esperaba una lista de elementos iguales, p.ej. <item>...</item> repetido).');

  const columnas = [];
  const vistas = new Set();
  const datosPorFila = elementosFila.map(el => {
    const datos = {};
    for (const attr of el.attributes) { datos[attr.name] = attr.value; }
    for (const hijo of el.children) { datos[hijo.tagName] = hijo.textContent; }
    if (!el.children.length && !el.attributes.length) datos['valor'] = el.textContent;
    for (const k of Object.keys(datos)) { if (!vistas.has(k)) { vistas.add(k); columnas.push(k); } }
    return datos;
  });

  return [columnas, ...datosPorFila.map(d => columnas.map(c => d[c] ?? ''))];
}

// ─── Soporte .dbf (dBase III/IV — formato nativo de Tango y sistemas DOS) ─────
// Formato binario simple y bien documentado, no hace falta librería externa.
// Estructura: header de 32 bytes (cantidad de registros, tamaño de header,
// tamaño de registro), seguido de un descriptor de 32 bytes por columna
// (nombre, tipo, largo), terminado en 0x0D, y después los registros: 1 byte
// de flag de borrado + los campos en ancho fijo según el descriptor.
// Codificación: estos archivos son casi siempre de sistemas viejos con
// code page Windows-1252/DOS-850 — nunca UTF-8 — así que se decodifica con
// el mismo criterio que ya usa leerTextoConFallbackEncoding para .txt/.csv.
async function parsearDBFCrudo(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const cantidadRegistros = view.getUint32(4, true);
  const tamañoHeader = view.getUint16(8, true);
  const tamañoRegistro = view.getUint16(10, true);

  const campos = [];
  let offset = 32;
  while (bytes[offset] !== 0x0D && offset < tamañoHeader) {
    const nombreBytes = bytes.slice(offset, offset + 11);
    const finNombre = nombreBytes.indexOf(0);
    const nombre = new TextDecoder('windows-1252').decode(nombreBytes.slice(0, finNombre === -1 ? 11 : finNombre));
    const largo = bytes[offset + 16];
    campos.push({ nombre, largo });
    offset += 32;
  }
  if (!campos.length) throw new Error('El archivo .dbf no tiene columnas reconocibles (¿está corrupto o no es dBase III/IV?).');

  const decoder = new TextDecoder('windows-1252');
  const matriz = [campos.map(c => c.nombre)];
  let posRegistro = tamañoHeader;
  for (let r = 0; r < cantidadRegistros; r++) {
    const flagBorrado = bytes[posRegistro];
    let posCampo = posRegistro + 1;
    const fila = [];
    for (const campo of campos) {
      const valor = decoder.decode(bytes.slice(posCampo, posCampo + campo.largo)).trim();
      fila.push(valor);
      posCampo += campo.largo;
    }
    // Registros marcados como borrados (flag 0x2A, asterisco) en dBase no se
    // eliminan físicamente del archivo — se excluyen acá para no resucitar
    // datos que la persona ya había borrado en el sistema de origen.
    if (flagBorrado !== 0x2A) matriz.push(fila);
    posRegistro += tamañoRegistro;
  }
  return matriz;
}

// ─── Soporte .png/.jpg/.jpeg (foto o captura de una lista/factura) ────────────
// Mismo problema que un PDF escaneado, mismo mecanismo: OCR directo sobre la
// imagen, con el mismo aviso de precisión reducida. No hay "capa de texto"
// que probar primero porque una imagen nunca la tiene.
async function parsearImagenCrudo(file, estadoDiv) {
  const Tesseract = await cargarTesseract();
  const aviso = document.getElementById('aviso-pdf-ocr');
  if (aviso) {
    aviso.style.display = '';
    aviso.textContent =
      '⚠ Estás subiendo una imagen: se usa reconocimiento óptico (OCR), que es más lento y bastante menos preciso que un archivo con texto real — revisá cada fila con especial cuidado antes de confirmar, sobre todo números.';
  }
  if (estadoDiv) estadoDiv.textContent = 'Reconociendo texto (OCR)... puede tardar.';

  const { data } = await Tesseract.recognize(file, 'spa+eng');
  const lineas = (data.text || '').split(/\r?\n/).filter(l => l.trim() !== '');
  return lineas.map(l => l.split(/ {2,}/).map(c => c.trim()).filter(c => c !== ''));
}

