// Fase 3 del PLAN_RESPONSIVE_MOBILE_COMPLETO.md — barrera de regresión para
// el patrón de bug que motivó toda esta ronda: un componente compartido
// (`.filtros-bar`, `.modal`, `.btn-exportar`/`.btn-importar`, etc.) termina
// con su forma BASE duplicada en varios `frontend/admin/css/*.css` en vez de
// vivir una sola vez en `componentes-admin.css` — y las copias divergen con
// el tiempo (el caso real: `compras.css` nunca tuvo la regla, cayó al
// `.modal` genérico y quedó siempre visible).
//
// No usa navegador: es un grep/AST liviano sobre los archivos CSS de
// frontend/admin/css/. Corre en <1s, apto para pre-commit o CI.
//
// Estrategia: lista blanca. Los archivos de página listados abajo ya están
// auditados y su declaración del selector es un DELTA legítimo (2-3
// propiedades específicas de esa página: `right`/`width`/`gap` para
// `.modal`, variantes de color para `.chip`, etc.), no una redeclaración de
// la forma base. Si aparece el selector en un archivo NUEVO que no está en
// la whitelist, el script falla — eso es exactamente la señal de que se está
// por repetir el mismo patrón de duplicación/drift.
//
// Uso: npm run check:shared-selectors
// Exit code 1 si encuentra un archivo no-whitelisteado con el selector.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_DIR = join(ROOT, 'frontend', 'admin', 'css');
const BASE_FILE = 'componentes-admin.css'; // vive en frontend/shared/, nunca en admin/css/

// selector -> archivos de frontend/admin/css/ donde ya se sabe que hay una
// declaración existente. Este es un SNAPSHOT real del estado del repo
// tomado el 2026-08-25 (generado programáticamente, no a mano), incluida la
// familia `*-gentelella.css` — un segundo set de hojas de estilo por página
// que la ronda de consolidación anterior no había relevado porque varias
// páginas (`clientes.html`, `stock.html`, etc.) cargan AMBOS archivos en
// cascada (`clientes.css` + `clientes-gentelella.css`), no solo el legacy.
// No todos estos son necesariamente deltas "limpios" de 2-3 propiedades —
// congelar el estado actual como línea base es lo verificable sin auditar
// a mano cada uno de los ~70 archivos; el valor del script es impedir que
// se sume un archivo NUEVO no revisado, no certificar que los existentes
// son perfectos. Si se legitima un override nuevo, sumarlo acá a
// propósito.
const WHITELIST = {
  '.filtros-bar': [
    'cc-proveedores-gentelella.css', 'clientes-gentelella.css', 'clientes.css',
    'compras-gentelella.css', 'compras.css', 'facturacion.css', 'finanzas.css',
    'pedidos-gentelella.css', 'pedidos.css', 'proveedores-gentelella.css',
    'stock-gentelella.css', 'stock.css', 'tema-claro-shipp.css',
    'usuarios-gentelella.css', 'vencimientos-gentelella.css',
  ],
  '.modal': [
    'anomalias-gentelella.css', 'auditoria-gentelella.css',
    'automatizacion-gentelella.css', 'automatizacion.css', 'cajas-gentelella.css',
    'cheques-gentelella.css', 'clientes-gentelella.css', 'clientes.css',
    'cobranzas-gentelella.css', 'compras.css', 'devoluciones-gentelella.css',
    'facturacion-gentelella.css', 'facturacion.css', 'finanzas.css',
    'gastos-generales-gentelella.css', 'notif-log-gentelella.css',
    'pedidos-gentelella.css', 'pedidos.css', 'productos-gentelella.css',
    'productos.css', 'reglas-precio-gentelella.css', 'rutas-gentelella.css',
    'rutas-professional.css', 'rutas.css', 'stock-gentelella.css', 'stock.css',
    'tema-claro-shipp.css', 'whatsapp-conversaciones-gentelella.css',
  ],
  '.tabla-wrap': [
    'auditoria-gentelella.css', 'cc-proveedores-gentelella.css',
    'cheques-gentelella.css', 'clientes-gentelella.css', 'clientes.css',
    'cobranzas-gentelella.css', 'comparador-precios-gentelella.css',
    'compras-gentelella.css', 'compras.css', 'conciliacion-bancaria-gentelella.css',
    'devoluciones-gentelella.css', 'export-contable-gentelella.css',
    'facturacion.css', 'finanzas.css', 'gastos-generales-gentelella.css',
    'notas-gentelella.css', 'notif-log-gentelella.css', 'pedidos-gentelella.css',
    'pedidos.css', 'proveedores-gentelella.css', 'puntos-gentelella.css',
    'reglas-precio-gentelella.css', 'rentabilidad-producto-vendedor-gentelella.css',
    'rentabilidad-zona-gentelella.css', 'riesgo-cheques-gentelella.css',
    'rutas-compact.css', 'rutas-gentelella.css', 'stock-gentelella.css',
    'stock.css', 'tema-claro-shipp.css', 'usuarios-gentelella.css',
    'vencimientos-gentelella.css', 'whatsapp-conversaciones-gentelella.css',
  ],
  '.chip': [
    'finanzas.css', 'pedidos-gentelella.css', 'pedidos.css', 'reportes.css',
    'rutas.css',
  ],
  '.badge-estado': [
    'clientes-gentelella.css', 'clientes.css', 'conciliacion-bancaria-gentelella.css',
    'facturacion-gentelella.css', 'observabilidad-gentelella.css',
    'stock-gentelella.css', 'whatsapp-conversaciones-gentelella.css',
  ],
  '.btn-exportar': [
    'compras.css', 'productos-gentelella.css', 'rutas-gentelella.css',
    'tema-claro-shipp.css',
  ],
  '.btn-importar': ['compras.css', 'tema-claro-shipp.css'],
};

// Detecta una declaración de selector a nivel de regla CSS (no dentro de un
// comentario ni como parte de un selector más largo tipo `.modal-foo`).
// Acepta el selector solo, en lista separada por comas, o precedido por
// combinadores (`body.dash-x .modal`, `.modal.open`, etc. NO cuentan como
// redeclaración de la forma base — solo el selector "pelado" al inicio de
// una regla, que es la forma en que se duplicaba la forma base).
function buscarDeclaracionBase(contenidoSinComentarios, selector) {
  const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Selector al inicio de línea (o tras `}`/`;`), solo o en lista de
  // selectores, sin combinador ni sufijo de clase pegado.
  const re = new RegExp(`(^|[}\\s;])${escapado}\\s*[,{]`, 'm');
  return re.test(contenidoSinComentarios);
}

function quitarComentarios(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function main() {
  const archivos = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));
  const violaciones = [];

  for (const archivo of archivos) {
    const ruta = join(CSS_DIR, archivo);
    const contenido = quitarComentarios(readFileSync(ruta, 'utf8'));

    for (const [selector, permitidos] of Object.entries(WHITELIST)) {
      if (!buscarDeclaracionBase(contenido, selector)) continue;
      if (permitidos.includes(archivo)) continue;
      violaciones.push({ archivo, selector });
    }
  }

  if (violaciones.length === 0) {
    console.log('OK — ningún archivo nuevo redeclara un selector compartido fuera de la lista blanca.');
    process.exitCode = 0;
    return;
  }

  console.error(`Encontradas ${violaciones.length} redeclaración(es) no revisada(s) de selectores compartidos:\n`);
  for (const v of violaciones) {
    console.error(`  frontend/admin/css/${v.archivo} declara "${v.selector}" y no está en la lista blanca`);
  }
  console.error(
    `\nSi es un delta legítimo (2-3 propiedades específicas de esta página), agregá el` +
    `\narchivo a WHITELIST en scripts/check-shared-selectors.js a propósito.` +
    `\nSi es la forma base completa duplicada, move‑la a frontend/shared/${BASE_FILE}` +
    `\ny dejá acá solo el delta (mismo patrón que .modal / .filtros-bar).`
  );
  process.exitCode = 1;
}

main();
