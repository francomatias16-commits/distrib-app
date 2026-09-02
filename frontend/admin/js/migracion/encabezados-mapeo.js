// frontend/admin/js/migracion/encabezados-mapeo.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Detección de fila de encabezado + Paso 2: mapeo de columnas.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ─── Migración 384: detección de fila de encabezados ─────────────────────────
// El bug real que motivó esto: sheet_to_json/Papa.parse con header:true
// asumían ciegamente que la fila 0 tenía nombres de columna. Si el archivo
// no traía encabezados (exportado directo de un sistema viejo, por
// ejemplo), esa primera fila de DATOS se perdía silenciosamente, tratada
// como si fueran nombres de columna — y de paso el mapeo se rompía porque
// ninguna columna matcheaba nada conocido.
//
// La heurística no decide sola y en silencio: solo arma un valor por
// defecto razonable para el checkbox de la vista previa, que la persona
// siempre puede corregir a mano antes de seguir.
function detectarFilaEncabezado(matriz) {
  const header = matriz[0] || [];
  const muestra = matriz.slice(1, 21); // hasta 20 filas de datos como muestra
  if (!header.length || !muestra.length) return { probable: true, confianza: 'baja' };

  // 0) Un encabezado real tiene la MISMA cantidad de columnas que las filas
  // que encabeza. Si la fila 0 tiene bastantes menos celdas que lo típico
  // en la muestra, no es un encabezado — probablemente es ruido (p.ej. un
  // fragmento de membrete/pie de página que quedó aislado como primera
  // fila al extraer texto de un PDF). Esto pesa más que las señales de
  // abajo porque es una condición estructural, no una corazonada de texto.
  const largos = muestra.map(f => f.length);
  const conteoLargos = new Map();
  for (const l of largos) conteoLargos.set(l, (conteoLargos.get(l) || 0) + 1);
  const largoModal = [...conteoLargos.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? header.length;
  if (largoModal > 1 && header.length < largoModal) {
    return { probable: false, confianza: 'alta' };
  }

  let señales = 0, puntos = 0;

  // 1) ¿Los valores de la fila 0 matchean nombres/etiquetas de campos conocidos?
  const vocabulario = new Set([
    ...Object.keys(ETIQUETAS_CAMPO).map(normalizarTexto),
    ...Object.values(ETIQUETAS_CAMPO).map(normalizarTexto),
  ]);
  señales++;
  if (header.some(h => vocabulario.has(normalizarTexto(h)))) puntos++;

  // 2) Los encabezados reales casi nunca son puramente numéricos.
  const pareceNumero = v => v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(String(v).replace(',', '.')));
  señales++;
  if (!header.every(pareceNumero)) puntos++;

  // 3) Los encabezados reales no se repiten entre sí.
  const normalizados = header.map(h => (h ?? '').toString().trim().toLowerCase());
  señales++;
  if (new Set(normalizados).size === normalizados.length) puntos++;

  // 4) Si una columna es 100% numérica en la muestra de datos pero la fila 0
  // en esa misma columna TAMBIÉN parece número, la fila 0 probablemente es
  // otra fila de datos, no un encabezado.
  let columnasNumericas = 0, headerNumericoAhi = 0;
  for (let c = 0; c < header.length; c++) {
    const valores = muestra.map(f => f[c]).filter(v => v !== undefined && v !== '');
    if (!valores.length) continue;
    if (valores.every(pareceNumero)) {
      columnasNumericas++;
      if (pareceNumero(header[c])) headerNumericoAhi++;
    }
  }
  señales++;
  if (columnasNumericas === 0 || headerNumericoAhi === 0) puntos++;

  const ratio = puntos / señales;
  return {
    probable: ratio >= 0.5,
    confianza: ratio >= 0.75 ? 'alta' : (ratio >= 0.5 ? 'media' : 'baja'),
  };
}

let _resolverPreviewEncabezado = null;

// Muestra las primeras filas de la matriz cruda y deja que la persona
// confirme (o corrija) si la fila 1 es encabezado o ya son datos, antes de
// armar los objetos que se suben al backend. Devuelve
// { tieneEncabezado, encabezados } — encabezados es la lista de nombres de
// columna a usar (los reales si hay encabezado, o "Columna 1, 2, ..." si no).
function mostrarPreviewEncabezado(matriz) {
  const { probable } = detectarFilaEncabezado(matriz);
  const cont = document.getElementById('preview-encabezado');
  const check = document.getElementById('check-tiene-encabezado');
  const tabla = document.getElementById('preview-encabezado-tabla');

  const nCols = Math.max(...matriz.slice(0, 6).map(f => f.length));
  const filasPreview = matriz.slice(0, 5);

  const renderTabla = tieneEncabezado => {
    const encabezadosPreview = tieneEncabezado
      ? matriz[0]
      : Array.from({ length: nCols }, (_, i) => `Columna ${i + 1}`);
    const filasDatosPreview = tieneEncabezado ? filasPreview.slice(1) : filasPreview;
    tabla.innerHTML = `
      <thead><tr>${encabezadosPreview.map(h => `<th>${escapeHtml((h ?? '').toString() || '—')}</th>`).join('')}</tr></thead>
      <tbody>${filasDatosPreview.map(f =>
        `<tr>${Array.from({ length: nCols }, (_, i) => `<td>${escapeHtml((f[i] ?? '').toString())}</td>`).join('')}</tr>`
      ).join('')}</tbody>`;
  };

  check.checked = probable;
  renderTabla(check.checked);
  check.onchange = () => renderTabla(check.checked);

  cont.style.display = '';
  document.getElementById('estado-carga').textContent = '';

  return new Promise(resolve => {
    _resolverPreviewEncabezado = () => {
      cont.style.display = 'none';
      const tieneEncabezado = check.checked;
      const encabezados = tieneEncabezado
        ? matriz[0]
        : Array.from({ length: nCols }, (_, i) => `Columna ${i + 1}`);
      resolve({ tieneEncabezado, encabezados });
    };
  });
}

function confirmarPreviewEncabezado() {
  if (_resolverPreviewEncabezado) {
    _resolverPreviewEncabezado();
    _resolverPreviewEncabezado = null;
  }
}

// Convierte la matriz cruda en el array de objetos {columna: valor} que
// espera subirArchivoEnChunks — mismo formato que antes devolvían
// sheet_to_json/Papa.parse con header:true, pero ahora la decisión de qué
// fila es encabezado ya fue confirmada por la persona.
function filasDesdeMatriz(matriz, tieneEncabezado, encabezados) {
  // Dedup de nombres de columna repetidos o vacíos (p.ej. dos columnas
  // "Nombre" en el archivo) — si no, la segunda pisaría a la primera al
  // armar el objeto.
  const nombresUsados = new Map();
  const claves = encabezados.map((h, i) => {
    let base = (h ?? '').toString().trim() || `Columna ${i + 1}`;
    const veces = nombresUsados.get(base) || 0;
    nombresUsados.set(base, veces + 1);
    return veces === 0 ? base : `${base} (${veces + 1})`;
  });

  const filasDatos = tieneEncabezado ? matriz.slice(1) : matriz;
  return filasDatos.map(fila => {
    const obj = {};
    claves.forEach((clave, i) => { obj[clave] = fila[i] ?? ''; });
    return obj;
  });
}

// Migración 165 (gap de QA pre-venta): file.text() SIEMPRE decodifica como
// UTF-8, sin importar el encoding real del archivo. Un CSV viejo exportado
// en Windows-1252/Latin1 (típico de sistemas de facturación argentinos
// pre-2015) se leía con los acentos rotos ("Almac�n" en vez de "Almacén")
// sin ningún aviso — quedaba así guardado en la base. Ahora: se decodifica
// como UTF-8 sin "fatal" (no tira excepción, reemplaza bytes inválidos por
// el carácter U+FFFD) y si aparece ese carácter de reemplazo, es señal de
// que no era UTF-8 real — se reintenta como Windows-1252, que cubre tanto
// Latin1 como los caracteres especiales (comillas tipográficas, etc.) que
// exporta Excel viejo en Windows.
async function leerTextoConFallbackEncoding(file) {
  const buffer = await file.arrayBuffer();
  const comoUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (comoUtf8.includes('\uFFFD')) {
    return new TextDecoder('windows-1252').decode(buffer);
  }
  return comoUtf8;
}

// ─── Paso 2: mapeo de columnas ────────────────────────────────────────────────
function renderMapeo() {
  const grid = document.getElementById('mapeo-grid');
  const autogenerables = CAMPOS_AUTOGENERABLES[estado.entidad] || new Set();
  grid.innerHTML = estado.camposDisponibles.map(campo => {
    const req = estado.camposRequeridos.includes(campo);
    const opciones = estado.columnasDetectadas.map(col =>
      `<option value="${escapeHtml(col)}">${escapeHtml(col)}</option>`
    ).join('');
    // Migración 384: si el campo es autogenerable (hoy solo "código" en
    // productos), se ofrece como una opción más del propio <select> — así
    // confirmarMapeo() lo levanta igual que cualquier otro mapeo, sin
    // necesitar un checkbox aparte ni tocar la lógica de "faltantes".
    const opcionAutogenerar = autogenerables.has(campo)
      ? `<option value="${SENTINEL_AUTOGENERAR}">Generar automáticamente</option>`
      : '';
    let pista = '';
    if (autogenerables.has(campo)) {
      pista = '<span class="mig-pista">si tu archivo no trae esta columna, elegí "Generar automáticamente" para crear un código único por fila</span>';
    } else if (CAMPOS_AUTOCREABLES.has(campo)) {
      pista = '<span class="mig-pista">se crea automáticamente si no existe</span>';
    } else if (CAMPOS_SOLO_MATCH.has(campo)) {
      pista = '<span class="mig-pista">solo se asigna si ya existe un usuario vendedor con ese nombre/email</span>';
    } else if (campo === 'monto') {
      pista = '<span class="mig-pista">usalo solo o junto con "Tipo" — no lo combines con Debe/Haber</span>';
    } else if (campo === 'debe' || campo === 'haber') {
      pista = '<span class="mig-pista">formato alternativo a "Monto" — usá uno de los dos, no ambos</span>';
    } else if (campo === 'tipo' && estado.entidad === 'cta_cte') {
      pista = '<span class="mig-pista">opcional: si no lo mapeás, se infiere del signo del monto</span>';
    } else if (campo === 'tipo' && estado.entidad === 'comprobantes_historicos') {
      pista = '<span class="mig-pista">obligatorio: factura, nota de crédito o nota de débito</span>';
    }
    return `
      <div class="mig-mapeo-row">
        <label for="map-${campo}">${ETIQUETAS_CAMPO[campo] || campo}${req ? ' *' : ''}</label>
        <select id="map-${campo}" data-campo="${campo}">
          <option value="">— No mapear —</option>
          ${opcionAutogenerar}
          ${opciones}
        </select>
        ${pista}
      </div>`;
  }).join('');

  // Auto-match por nombre similar (sin acentos/case)
  document.querySelectorAll('#mapeo-grid select').forEach(sel => {
    const campo = sel.dataset.campo;
    const match = estado.columnasDetectadas.find(c => normalizarTexto(c) === normalizarTexto(campo) || normalizarTexto(c).includes(normalizarTexto(campo)));
    if (match) sel.value = match;
  });
}

function normalizarTexto(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\s]/g, '');
}

// Migración 161: cta_cte acepta 3 formatos de monto/tipo distintos (ver
// resolverMovimientoCtaCte en el backend). El mapeo de columnas en sí ya es
// genérico, pero conviene explicar las 3 combinaciones posibles ANTES de que
// la persona arme el mapeo, para que no intente mapear "monto" Y "debe"/"haber"
// a la vez sin necesidad, o se quede sin saber qué pasa si no tiene "tipo".
function renderAyudaCtaCte() {
  const cont = document.getElementById('mapeo-ayuda-ctacte');
  if (estado.entidad !== 'cta_cte') { cont.style.display = 'none'; return; }

  cont.style.display = '';
  cont.innerHTML = `
    <p class="mig-destinos-titulo">Tu archivo puede traer el monto de 3 formas distintas — mapeá solo la que tengas:</p>
    <ul style="margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--color-text-secondary);">
      <li><strong>Monto con signo</strong>: una sola columna numérica (positivo = cargo/factura, negativo = pago).</li>
      <li><strong>Monto + Tipo</strong>: columna de monto (siempre positivo) más una columna de texto libre
          (factura, pago, cobro, nota de crédito, etc.).</li>
      <li><strong>Debe / Haber</strong>: el típico libro mayor de dos columnas separadas que exportan la mayoría
          de los sistemas viejos — no hace falta columna de tipo, se infiere sola.</li>
    </ul>
    <p class="mig-destinos-nota">No mapees "Monto" junto con "Debe"/"Haber" — son formatos alternativos, no se combinan.
      El cliente tiene que existir ya en el sistema (migralo primero si todavía no lo hiciste).</p>
  `;
}

// Migración 156: si la empresa tiene más de un depósito y/o más de una
// lista de precios, dejamos elegir destino en vez de asumir siempre el
// principal/default. Si solo hay una opción de cada uno, no molestamos
// con el selector — se usa esa sola opción igual que antes.
function renderDestinos() {
  const cont = document.getElementById('mapeo-destinos');
  // Migración 172: lotes también elige depósito destino (mismo criterio que
  // productos), pero no tiene lista de precios — no aplica a esta entidad.
  const aplicaEntidad = estado.entidad === 'productos' || estado.entidad === 'lotes';
  const aplicaLista = estado.entidad === 'productos';
  if (!aplicaEntidad || (estado.depositos.length <= 1 && (!aplicaLista || estado.listasPrecios.length <= 1))) {
    cont.innerHTML = '';
    cont.style.display = 'none';
    return;
  }

  const bloqueDeposito = estado.depositos.length > 1 ? `
    <div class="mig-mapeo-row">
      <label for="destino-deposito">Depósito destino</label>
      <select id="destino-deposito">
        ${estado.depositos.map(d => `<option value="${d.id}" ${d.es_principal ? 'selected' : ''}>${escapeHtml(d.nombre)}${d.es_principal ? ' (principal)' : ''}</option>`).join('')}
      </select>
    </div>` : '';

  const bloqueLista = (aplicaLista && estado.listasPrecios.length > 1) ? `
    <div class="mig-mapeo-row">
      <label for="destino-lista">Lista de precios destino</label>
      <select id="destino-lista">
        ${estado.listasPrecios.map(l => `<option value="${l.id}" ${l.es_default ? 'selected' : ''}>${escapeHtml(l.nombre)}${l.es_default ? ' (default)' : ''}</option>`).join('')}
      </select>
    </div>` : '';

  const titulo = estado.entidad === 'lotes' ? '¿En qué depósito cargamos los lotes?' : '¿Dónde cargamos el stock y los precios?';
  const nota = estado.entidad === 'lotes'
    ? 'Esto es el depósito por defecto. Si tu archivo tiene una columna de depósito por lote, mapeala como "Depósito (por fila)" más abajo — esa fila va a ese destino puntual en vez del elegido acá.'
    : 'Esto es el destino por defecto. Si tu archivo tiene una columna de depósito y/o lista de precios por producto, mapealas como "Depósito (por fila)" / "Lista de precios (por fila)" más abajo — esa fila va a ese destino puntual en vez del elegido acá.';

  cont.style.display = '';
  cont.innerHTML = `<h3 class="mig-destinos-titulo">${titulo}</h3>${bloqueDeposito}${bloqueLista}
    <p class="mig-destinos-nota">${nota}</p>`;
}

