// tests/helpers/cargar-script-frontend.js
//
// Helper genérico para testear los scripts de frontend/admin/js y
// frontend/cliente/*.html (bloques <script> sin bundler, pensados para
// cargarse tal cual en el navegador) sin necesitar un DOM real (jsdom no
// está entre las dependencias del repo — ver AUDITORIA_BUGS_v954.md #8/#9).
//
// Igual que en tests/frontend/ui-utils-sanitize.test.js: se ejecuta el
// código fuente real (sin tocarlo) en un `vm.Context` con un `window`
// auto-referencial (`window.window === window`), así que `window.sanitize
// = fn` definido por ui-utils.js queda accesible también como identificador
// bare `sanitize` dentro de los demás archivos que lo usan sin el prefijo
// `window.`. Las declaraciones `function` de nivel superior del script
// quedan como propiedades del objeto de contexto (llamables desde el
// test); las `let`/`const` de nivel superior NO (viven en el lexical
// environment del contexto), pero los closures de las funciones sí las ven
// mientras se sigan ejecutando scripts en el MISMO contexto — por eso
// `cargarScripts` permite pasar varios archivos (ej. ui-utils.js +
// clientes.js) para que compartan contexto.

import fs from 'node:fs';
import vm from 'node:vm';
import { vi } from 'vitest';

/**
 * Crea un elemento DOM falso mínimo: suficiente para capturar innerHTML/
 * textContent, leer/escribir style y className, simular classList y
 * apilar hijos vía appendChild — no parsea HTML de verdad.
 */
export function crearElementoFake(overrides = {}) {
  const clases = new Set();
  // `innerHTML` necesita comportarse distinto según quién escriba:
  //   - una asignación EXTERNA (`el.innerHTML = '...'`, típicamente para
  //     limpiar con '' antes de un loop de renderizado) debe tirar los
  //     hijos viejos, como hace el DOM real.
  //   - la agregación INTERNA que hace appendChild() de abajo (para que
  //     innerHTML del padre refleje el HTML de los hijos) NO debe disparar
  //     esa limpieza, o cada hijo nuevo borraría a los anteriores.
  // Por eso `_html`/`children` viven en closures y appendChild() escribe
  // `_html` directo, sin pasar por el setter público.
  let _html = '';
  const _children = [];

  /** Búsqueda mínima por selector de clase (`.algo`) recorriendo hijos
   * recursivamente — alcanza para el patrón real del código (ej.
   * `_toastEl.querySelector('.toast-msg')` en ui-utils.js), no es un
   * motor de selectores CSS real. */
  function buscar(nodo, selector) {
    if (!selector || !selector.startsWith('.')) return null;
    const clase = selector.slice(1);
    for (const hijo of nodo.children || []) {
      if (hijo?.classList?.contains?.(clase) || (hijo?.className || '').split(/\s+/).includes(clase)) {
        return hijo;
      }
      const enNieto = buscar(hijo, selector);
      if (enNieto) return enNieto;
    }
    return null;
  }

  const el = {
    style: {},
    textContent: '',
    value: '',
    className: '',
    dataset: {},
    hidden: false,
    disabled: false,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    get innerHTML() { return _html; },
    set innerHTML(val) {
      _html = val;
      _children.length = 0; // asignar innerHTML tira los hijos viejos, como en el DOM real
    },
    get children() { return _children; },
    classList: {
      add: (...cs) => cs.forEach(c => clases.add(c)),
      remove: (...cs) => cs.forEach(c => clases.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !clases.has(c) : force;
        if (on) clases.add(c); else clases.delete(c);
        return on;
      },
      contains: c => clases.has(c),
    },
    appendChild(hijo) {
      _children.push(hijo);
      // Aproximación de innerHTML real: el código de producción arma
      // filas/celdas con appendChild (no siempre con innerHTML +=), así
      // que sin esto cualquier assert sobre innerHTML del contenedor
      // padre queda en '' aunque el hijo sí tenga contenido. Escribe
      // `_html` directo (no `this.innerHTML +=`) para no disparar el
      // setter de arriba, que taría los hijos recién agregados.
      if (hijo && typeof hijo.innerHTML === 'string') {
        _html += hijo.innerHTML;
      }
      return hijo;
    },
    addEventListener: vi.fn(),
    querySelector: vi.fn(selector => buscar(el, selector)),
    querySelectorAll: vi.fn(() => []),
    ...overrides,
  };
  return el;
}

/**
 * Crea un `document` falso. `elementos` es un mapa id -> elemento fake
 * (o `null` para simular "no existe en esta página"); cualquier id no
 * listado se auto-crea de forma perezosa (y se cachea, así que llamadas
 * repetidas a getElementById devuelven el mismo objeto).
 */
export function crearDocumentoFake(elementos = {}, opciones = {}) {
  const cache = { ...elementos };
  return {
    getElementById: vi.fn(id => {
      if (!(id in cache)) cache[id] = crearElementoFake();
      return cache[id];
    }),
    createElement: vi.fn(() => crearElementoFake()),
    querySelector: vi.fn(opciones.querySelector || (() => null)),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    head: { appendChild: vi.fn() },
    // ui-utils.js (crearElementoToast) hace document.body.appendChild(el)
    // para montar el toast — sin este stub revienta con "Cannot read
    // properties of undefined (reading 'appendChild')" en cualquier
    // script que dispare un toast (ej. remito.js en su catch de error).
    body: { appendChild: vi.fn() },
    _cache: cache,
  };
}

/**
 * Ejecuta uno o más archivos fuente (rutas absolutas, en orden) en un
 * mismo `vm.Context`. Devuelve el propio sandbox: las `function`
 * declaradas a nivel superior de cualquiera de los archivos quedan
 * disponibles como `sandbox.nombreFuncion`.
 *
 * @param {string[]} rutas
 * @param {object} [opciones]
 * @param {object} [opciones.documento] - resultado de crearDocumentoFake()
 * @param {object} [opciones.extra] - propiedades extra a mezclar en window/sandbox
 *   (ej. `sb`, `L` de Leaflet, `empresaId`) ANTES de correr los scripts.
 * @param {(codigo: string, ruta: string) => string} [opciones.transformar] -
 *   transformación de texto por archivo (ej. para stripear un `import` de
 *   ES module de un bloque <script type="module"> extraído de un .html).
 */
export function cargarScripts(rutas, opciones = {}) {
  const documento = opciones.documento || crearDocumentoFake();
  const extra = opciones.extra || {};

  const sandbox = {
    document: documento,
    console,
    fetch: vi.fn(async () => { throw new Error('fetch no mockeado — pasá opciones.extra.fetch'); }),
    location: { search: '', href: '' },
    URLSearchParams,
    navigator: { onLine: true, clipboard: { writeText: vi.fn(() => Promise.resolve()) } },
    setTimeout,
    clearTimeout,
    // Muchos scripts admin hacen `window.authReady.then(() => init())` a
    // nivel de módulo (auth-ready.js real, no cargado en estos tests).
    // Una promesa que nunca resuelve deja ese top-level `.then().catch()`
    // pendiente sin disparar init() (que arrastraría fetch/Supabase reales).
    authReady: new Promise(() => {}),
    ...extra,
  };
  sandbox.window = sandbox;

  const contexto = vm.createContext(sandbox);

  for (const ruta of rutas) {
    let codigo = fs.readFileSync(ruta, 'utf8');
    if (opciones.transformar) codigo = opciones.transformar(codigo, ruta);
    vm.runInContext(codigo, contexto, { filename: ruta });
  }

  return { sandbox, contexto, documento };
}

/**
 * Muta una variable `let`/`const` de nivel superior de los archivos ya
 * cargados con `cargarScripts` en un `contexto` dado.
 *
 * OJO: esas variables NO son propiedades del objeto `sandbox` (viven en
 * el lexical environment del contexto — ver nota al inicio de este
 * archivo), así que `sandbox.miVariable = x` NO las toca aunque
 * `sandbox.miFuncion` sí funcione para las `function` de nivel superior.
 * Esta función cuelga `valor` momentáneamente de `sandbox` y lo asigna
 * con una sentencia bare dentro del mismo contexto — así no hace falta
 * pasar por JSON.stringify y los mocks (vi.fn(), objetos con funciones)
 * llegan intactos.
 *
 * @param {vm.Context} contexto - el `contexto` devuelto por cargarScripts
 * @param {object} sandbox - el `sandbox` devuelto por cargarScripts (mismo par)
 * @param {string} nombreVariable - identificador de la variable a mutar (ej. '_sb', 'cobranzaPriorizada')
 * @param {*} valor
 */
export function asignarVariableDeModulo(contexto, sandbox, nombreVariable, valor) {
  const clave = '__valorTemporalTest__';
  sandbox[clave] = valor;
  try {
    vm.runInContext(`${nombreVariable} = window.${clave};`, contexto);
  } finally {
    delete sandbox[clave];
  }
}

/**
 * Extrae el contenido de un bloque `<script>` (o `<script type="module">`)
 * de un archivo .html real, ubicándolo por un string que debe aparecer
 * dentro de ese bloque (para desambiguar cuando hay varios <script> en el
 * archivo). No parsea HTML de verdad — corta por el primer `<script...>`
 * que contenga `marcador` y su `</script>` de cierre.
 */
export function extraerScriptDeHtml(rutaHtml, marcador) {
  const html = fs.readFileSync(rutaHtml, 'utf8');
  const bloques = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const bloque = bloques.find(m => m[1].includes(marcador));
  if (!bloque) {
    throw new Error(`[extraerScriptDeHtml] No se encontró ningún <script> en ${rutaHtml} que contenga: ${marcador}`);
  }
  return bloque[1];
}
