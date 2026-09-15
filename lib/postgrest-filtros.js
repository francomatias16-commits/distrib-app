// lib/postgrest-filtros.js
// Escapeo de texto del usuario antes de interpolarlo en un filtro `.or()`
// de PostgREST.
//
// Por qué existe: la sintaxis de `.or()` separa condiciones con COMA y
// agrupa con PARÉNTESIS. Si el texto que tipea el usuario (o el nombre de
// un producto/cliente) contiene `,` `(` `)` o `*`, esos caracteres se
// interpretan como sintaxis y no como texto a buscar: la condición se
// parte al medio y la búsqueda devuelve resultados incompletos, otros, o
// directamente falla — aunque el usuario haya escrito el nombre EXACTO.
//
// Esto ya se había detectado y neutralizado dos veces por separado
// (lib/handlers/busqueda.js, auditoría Etapa 2 v232; y
// lib/handlers/proveedores.js), pero como cada una tenía su propia copia
// local de la función, los demás puntos de búsqueda quedaron sin cubrir.
// El caso más caro era el buscador del POS (buscarProductosPos): sobre el
// catálogo real de la empresa piloto, 104 de 1458 productos activos (7%)
// tienen coma o paréntesis en el nombre — por ejemplo
// "SECADOR GOMA SIMPLE HACENDOSA 40 CM (SIN CABO)". El cajero escribía el
// nombre tal cual, incluido el paréntesis, y la búsqueda no encontraba
// nada. Ahora hay una sola función y todos los buscadores la usan.
//
// Nota: NO escapa `%` ni `_` (los comodines de ILIKE). Es a propósito —
// el `%` lo pone el propio caller para armar el patrón, y un `_` suelto
// en un nombre de producto haciendo de comodín de un carácter es
// inofensivo para una búsqueda (matchea de más, no de menos).

/** Caracteres con significado sintáctico dentro de un filtro `.or()`. */
const RESERVADOS_POSTGREST = /[,()*]/g;

/**
 * Escapa los caracteres reservados de la sintaxis de filtros de PostgREST
 * para que el texto se trate como literal.
 *
 * @param {string} valor texto crudo tipeado/escaneado por el usuario
 * @returns {string} el mismo texto, seguro para interpolar en `.or()`
 */
export function escaparFiltroPostgrest(valor) {
  if (valor == null) return '';
  return String(valor).replace(RESERVADOS_POSTGREST, (c) => '\\' + c);
}

/**
 * Atajo para el caso habitual: escapar y envolver en `%...%` para un
 * ILIKE "contiene".
 *
 * @param {string} valor texto crudo
 * @returns {string} patrón listo para `.ilike` / `.or(...ilike...)`
 */
export function likeContiene(valor) {
  return `%${escaparFiltroPostgrest(valor)}%`;
}
